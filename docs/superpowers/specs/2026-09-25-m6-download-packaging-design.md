# M6 — Download completion + packaging

> **Status:** implemented. **Date:** 2026-09-25. Covers milestone M6 from [docs/implementation-plan.md](../../implementation-plan.md), and settles the items its §7 lists as "Still open for M6". It builds on the download handler from [the M4 design](./2026-09-20-m4-tts-design.md) and the conversion slot shared with export from [the M5 design](./2026-09-23-m5-export-design.md). Internal name **HearBook**; user-facing name **Enisma**.

## Deviations from this design, found during implementation

- **The "to verify" item about the export voice after deleting English was resolved during planning, not during implementation.** `reconcileVoice` already keeps the project's stored voice when `listVoices` comes back empty, so no code change was needed — the risk this section flagged did not materialize.
- **Provider method names differ from this design's sketch.** `ModelsProvider` exposes `installModel`, `installFromFolder`, `cancelInstall`, `removeLanguage` and `refresh`, not the install/cancel/remove/refresh names this document originally used.
- **`ModelPanel` gained a `busy` prop** that disables it while another language is mid-install, to prevent overlapping installs from the same panel.
- **The Settings row's enable/disable logic was factored into pure helpers**, `canImportFromFolder` and `installLocked`, rather than being inlined in the component.
- **The sidecar README's `/health` description now says "currently registered"** rather than the earlier wording, to be precise that registration can fail per-language without failing the whole health check.

## What changed since the implementation plan

§7 of the plan listed what M6 still owned. Two of its facts had moved by the time this design was written:

- **The binary in `src-tauri/binaries/` is no longer stale.** §7 describes a 21 MB binary dated 16 June. On 2026-09-25 the main checkout held a 161 MB `hearbook-sidecar-x86_64-unknown-linux-gnu` built on 2026-09-23 at 06:04, after the stitching commits, and it carries `lameenc`. The underlying gap is unchanged: `beforeBuildCommand` is only `bun run build`, so a release still bundles whatever happens to be there.
- **The `num2words2` git pin is still needed.** PyPI's latest release was still 1.0.20, so every machine that builds the sidecar still needs a Rust toolchain and compiles it from source.

And one item was settled as a decision rather than designed: **removing a language** is in, as part of a minimal language-management section in Settings (download, install from folder, delete).

## Goals

- Release builds for three targets, produced by GitHub Actions on a version tag, with each target's frozen sidecar smoke-tested on its own OS.
- `tauri build` can no longer silently bundle a sidecar that does not match the source.
- Test suites run on every push.
- Model URLs are pinned to a commit, not a moving branch.
- A download that loses its connection mid-way recovers on its own, within a short budget.
- Settings lets the user download, install from a folder, cancel, and delete each language's voice model.
- Startup cost is measured on each target and recorded.

## Non-goals

- **Code signing and notarization.** Every build ships unsigned. Windows users see SmartScreen once; macOS users allow the app under Privacy & Security. Both are documented in the README.
- **Intel Macs and Linux arm64.** Not built.
- **An auto-updater.**
- **Resuming a download on launch.** A stopped download still resumes only when the user asks again.
- **A "retrying in N s" message** during a retry wait. The progress bar pauses silently.
- **Switching the sidecar from onefile to onedir.** That is decided later, from the startup numbers M6 records.
- **Removing the `num2words2` pin.** Still waiting on a PyPI release `>= 1.0.21`.

## Verified environment facts

Checked on 2026-09-25, against the sources named.

- **Hosted macOS runners.** `macos-latest` is Apple Silicon. The macOS 13 image was retired in December 2025; `macos-15-intel` is the last hosted Intel image, supported until August 2027 ([GitHub changelog](https://github.blog/changelog/2025-09-19-github-actions-macos-13-runner-image-is-closing-down/), [runner-images #13045](https://github.com/actions/runner-images/issues/13045)). Not needed here, since Intel Macs are out of scope, but it is why they are.
- **Tauri's GitHub pipeline.** The documented action is `tauri-apps/tauri-action@v1`, with `releaseDraft: true` for draft Releases. Linux build dependencies are `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf xdg-utils` ([Tauri docs](https://v2.tauri.app/distribute/pipelines/github/)).
- **Unsigned macOS.** Apple Silicon requires every app from the internet to carry at least an ad-hoc signature, set with `"signingIdentity": "-"`. Ad-hoc signing does not spare the user the Privacy & Security step ([Tauri docs](https://v2.tauri.app/distribute/sign/macos/)).
- **Windows signing, for the record of why it is out.** OV/IV certificates need an HSM or hardware token for the key, and since March 2026 last at most 460 days. Since 2024, EV no longer bypasses SmartScreen; reputation builds from download volume for any certificate. Azure Artifact Signing is open to individual developers only in the US and Canada. SignPath Foundation's free signing needs a public, open-source repo; `hadamard-2/hear-book` is private with no license ([Microsoft](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options), [Microsoft](https://learn.microsoft.com/en-us/azure/artifact-signing/faq), [SignPath](https://signpath.org/terms.html)).
- **The repo** is `hadamard-2/hear-book`, private, with no `.github/workflows/` yet.

**Inferred, to verify during implementation:** after English is deleted, `listVoices("en")` probably returns an empty list, and the export dialog's `reconcileVoice` may then change the voice (see Language management → Delete).

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Where do Windows and macOS builds come from? | **GitHub Actions** hosted runners | PyInstaller cannot cross-compile, so each OS has to build its own sidecar anyway. |
| Which targets? | **Linux x64, Windows x64, macOS arm64** | Intel Macs are being phased out by Apple and by GitHub's runners. |
| Signing? | **None.** Unsigned on Windows, ad-hoc on macOS | A paid certificate does not remove the SmartScreen warning for a new, low-download app, and no free route is open to a private repo. |
| When do release builds run? | **On a `v*` tag**, into a **draft** Release; also a manual "Run workflow" button whose files stay as run artifacts | Releases are deliberate; nothing is published without a human pressing Publish. |
| Test CI? | **Every push to `main`, Linux only** | Cheap, and gives each release a known-green base. |
| How does `tauri build` treat the sidecar? | **Refuse a stale one** (a source-hash stamp checked in `beforeBuildCommand`) | Fast when nothing changed, loud when something did. Always rebuilding makes every build slow; leaving it to CI leaves the trap in place for local builds. |
| Retry with backoff? | **Yes, only for a connection that drops after bytes have arrived** | Rides out a blip without making a machine that is offline from the start wait for nothing. |
| Resume on launch? | **No** | Nothing is fetched unless the user asks, which is the principle `model-state.ts` states. |
| Language management? | **Settings → Voices**: download, install from folder, cancel, delete | Deleting is the missing piece; install-from-folder is the offline path and belongs wherever installing does. |
| Windows installer? | **NSIS only** | Installs per user without admin rights. MSI needs WiX and admin. |
| Linux bundles? | **AppImage and `.deb`** | |

## 1. Builds and CI

### Workflows

Both live in `.github/workflows/`.

**`ci.yml`** runs on every push to `main`, on `ubuntu-22.04`. It runs `bun run test`, `cargo test` (in `src-tauri/`) and `uv run pytest` (in `sidecar/`), with caches for Bun, Cargo and uv. The uv cache matters most, because it holds the compiled `num2words2`.

**`release.yml`** runs on a `v*` tag push, or from `workflow_dispatch`.

1. A `test` job runs the same three suites once, on Linux.
2. A `build` job, needing `test`, runs once per target:

   | Runner | Target triple | Bundles |
   | --- | --- | --- |
   | `ubuntu-22.04` | `x86_64-unknown-linux-gnu` | AppImage, `.deb` |
   | `windows-latest` | `x86_64-pc-windows-msvc` | NSIS |
   | `macos-latest` | `aarch64-apple-darwin` | `.dmg` |

   `ubuntu-22.04` rather than `ubuntu-latest` so the frozen sidecar and the AppImage link against an older glibc and run on more distributions.

   Each build job installs Rust, Bun and uv; runs `scripts/build-sidecar.sh`; runs the smoke test below; then runs `tauri-apps/tauri-action@v1`. On a tag it attaches the bundles to a draft Release named after the tag; on a manual run it uploads them as run artifacts only.

`scripts/build-sidecar.sh` is Bash. The Windows runner has Git Bash, so the job runs it with `shell: bash`.

### Bundle configuration

- `bundle.targets` narrows from `"all"` to the bundles in the table above.
- `bundle.macOS.signingIdentity` is `"-"` (ad-hoc).
- `bundle.windows.nsis.installMode` is `"currentUser"`. That is already the installed CLI's schema default; it is set explicitly so the no-admin install is a visible decision rather than an inherited one.

### The stale-sidecar guard

`build-sidecar.sh` writes `src-tauri/binaries/hearbook-sidecar-<triple>.stamp` next to the binary: a SHA-256 over the sidecar's `*.py` files (excluding `tests/`), `pyproject.toml`, `uv.lock`, `hearbook_sidecar.spec` and `models.json`, taken in sorted path order so the hash is stable.

A check script recomputes the same hash for the host triple and compares it with the stamp. `beforeBuildCommand` becomes the check followed by `bun run build`. A missing or mismatched stamp fails the build with a message naming the fix: run `scripts/build-sidecar.sh`. Only the host triple is checked, because that is the only binary Tauri bundles. `beforeDevCommand` is unchanged: `tauri dev` does not use the frozen binary.

The hashing lives in one place that both scripts call, so the two cannot drift apart.

### Smoke test

Run on each build runner, against the binary `build-sidecar.sh` just produced. This is where Windows and macOS stop being untried.

1. Start the frozen binary with a token and `HEARBOOK_MODELS_DIR` pointed at a scratch directory, and wait for its ready line. Record the time taken.
2. `GET /health` answers.
3. Install Amharic through `POST /jobs/fetch` and poll it to `done`. This is a 114 MB download from the pinned URLs, and it exercises sherpa-onnx, onnxruntime's native libraries and uroman's data files on each OS.
4. `GET /health` lists `am`. Time `GET /models/status` with the model installed.
5. Synthesize one short Amharic sentence through `POST /jobs/tts` and check that the WAV is non-empty.
6. Check that espeak-ng loads and phonemizes one English word, which needs no model. Kokoro's own 326 MB model is not downloaded in CI.
7. Delete Amharic through `DELETE /models/am`, and check that `/health` no longer lists it and its directory is gone. On Windows this is the test of whether a file is still held open.
8. Shut the sidecar down.

Any failed step fails the job. The timings from steps 1 and 4 are printed to the job summary.

### Startup cost

M6 records, per OS, the time from spawning the frozen binary to its ready line, and the time `/models/status` takes with one model installed, in this spec's Results section. If the onefile unpack turns out to be slow, switching to onedir is a restructure of how the sidecar ships, and is decided separately.

## 2. Download hardening

Both changes are in `sidecar/models.py` and `sidecar/models.json`. No UI changes.

### Commit-pinned URLs

Every URL in `models.json`, and the voice `url_template`, changes from `resolve/main` to `resolve/<40-hex commit>`. For each Hugging Face repo, the commit is the one its `main` points at when the change is made. Before pinning, the repo's file tree is read from the Hugging Face API at that commit, and each LFS file's SHA-256 is compared with the manifest's. Nothing is downloaded to do this. The hashes do not change, so models already installed stay valid and nothing migrates.

A new test in `test_models.py` fails if any URL in the manifest is not pinned to a 40-hex revision.

### Retry with backoff

Inside `fetch`, per file.

**Retried** — a failure *after this `fetch` call has received at least one byte*:

- a connection reset or refused connection;
- a socket timeout (the existing `TIMEOUT_SECONDS`);
- a body that ends before its declared length;
- an HTTP 5xx.

**Not retried:**

- any failure before the first byte of this `fetch` call. A machine offline from the start fails at once with the existing error;
- any 4xx;
- 429, which keeps its existing "try again in about N minutes" message;
- a checksum failure;
- a cancel.

**Schedule.** Up to three retries, waiting 2 s, 8 s and then 30 s: about 40 s in all. The count resets whenever a retry receives bytes, so three separate blips across a 20-minute download do not end a download that is making progress. Each retry goes through the existing `Range` resume from the `.part` file.

**Cancel during a wait.** The wait polls `should_continue` every 250 ms and raises `Cancelled` if asked, so Cancel is as prompt during a wait as between chunks.

**Out of retries.** The error names the last cause and keeps the existing wording that nothing is lost and asking again resumes. It stays in English, like every backend error.

The sleep function is injectable, so tests do not wait.

## 3. Language management in Settings

### Shared model state: `ModelsProvider`

Today the install state — `installing`, `installProgress`, `installCancelling`, `installError`, and the model rows and engine health — lives in `editor.tsx`'s own state. Settings opens from Home, so that state moves into a `ModelsProvider` (`src/components/models/models-provider.tsx`), following `ExportProvider`'s pattern. Without this, a download started in a book and still running when the user goes back to Home would look idle in Settings, and one started from Settings would be invisible in the editor.

The provider holds:

- the status rows from `modelStatus()` and the engine map from `sidecarHealth()`, with the same null-means-unknown rules the editor has today;
- the one install in flight: its language, progress, whether a cancel is pending, and the last error with its language;
- `install(language, sourceDir?)`, `cancel()`, `remove(language)` and `refresh()`.

It listens to `models://progress` once. The editor's `ModelPanel` and Settings both read from it. `modelStateFor` is unchanged; only where its inputs come from moves. The editor's "status unknown means offer Convert" rule stays in the editor, because it is about the Convert button.

### Settings → Voices

A new section in `SettingsDialog`, below Language, with one row per language in manifest order: English, Amharic, Tigrigna, Oromo. Each row shows the language name, its size, and its state, in the same wording the editor's panel uses: not installed; partly downloaded, 40 of 114 MB; installed; installed but failed to load; installing, with a bar and Cancel; or the error line.

Actions per row:

- **The main button** — Download, Resume, Retry or Reinstall, labelled exactly as `ModelPanel` labels it for the same state. Not shown when the language is ready.
- **Install from folder** — opens a directory picker and installs from it.
- **Delete** — shown when the language is installed or partly downloaded, so abandoned `.part` files can be cleared too.

Only one install runs at a time (the existing acquisition slot), so every other row's install buttons are disabled while one runs. The mapping from state to actions is a pure function with its own tests.

### Delete

A confirmation dialog first: "Delete the Amharic voice (114 MB)? Audio you've already made keeps playing; making new audio in Amharic will need it again."

**Rust: `remove_model_cmd(language)`** refuses, with an English message, if:

- the acquisition slot holds an install for this language; or
- the conversion slot is held for a project whose language is this one. An export holds the same slot, so this covers exports too. The project's language is looked up by the slot's `project_id`.

The refusal rule is a pure function over the two slots' contents and the looked-up language, tested on its own. If neither applies, the command calls the sidecar.

**Sidecar: `DELETE /models/{language}`**

1. An unknown language is a 404.
2. The engine is removed from `ENGINES_BY_LANGUAGE`, so new work in that language fails with the existing "language unavailable" error.
3. `models/<language>/` is deleted, `.part` files included. A language with nothing on disk is a success.
4. If deleting fails — most likely on Windows, if a file is still open — `register_language` is called again so files and engine stay consistent, and the error is returned.

**An accepted race.** A conversion that starts in the fraction of a second between the Rust check and the sidecar removing the engine fails with the existing "language unavailable" error. Closing that gap would mean a new holder kind on the conversion slot, and a clear error is enough.

**To verify: the export dialog after English is deleted.** If `listVoices("en")` returns an empty list with no engine, `reconcileVoice` may replace the project's saved voice, which would make every existing take look stale and block an export that should only need stitching. If so, the dialog keeps the saved voice when the list comes back empty.

### Strings

New strings for the Voices section and the delete dialog are added to all four catalogues, in the `{message, context}` shape; the existing parity test covers them. Backend error text stays in English.

## Order of work

Each part lands as its own reviewable set of commits.

1. **Download hardening** — pinned URLs, retry, tests. First, so the smoke test downloads from pinned URLs.
2. **Delete, backend** — the sidecar route, `remove_model_cmd`, the refusal rule. Before CI, so the smoke test can delete.
3. **The stale-sidecar guard** — the stamp, the check, `beforeBuildCommand`. Verified locally on Linux.
4. **CI** — `ci.yml`, then `release.yml` with the matrix and smoke test. Run with the manual button until all three targets are green. Windows and macOS PyInstaller fixes surface here and cannot be sized in advance. The first tag push, and publishing its draft Release, are the maintainer's.
5. **Settings UI** — `ModelsProvider`, the Voices section, the delete dialog, strings. Verified by driving the app.
6. **Docs** — see below.

## Testing

- **pytest**
  - Pinning: every manifest URL carries a 40-hex revision.
  - Retry, using the existing `urlopen` monkeypatch pattern with an injected sleep: a drop mid-body resumes and completes; a failure before the first byte is not retried; repeated 503s give up after three retries; a blip after progress resets the count; a 404 is not retried; a cancel during a wait stops promptly and keeps the `.part`.
  - Delete route: unregisters the engine; removes files and `.part` files; unknown language is a 404; already-absent succeeds; a failed delete re-registers.
- **cargo test** — the refusal rule: install running for this language, for another language, conversion in this language, in another language, nothing running.
- **vitest** — the state-to-actions mapping for a Settings row.
- **CI smoke test** — as above, on all three OS.
- **In the app** — download, cancel, resume, install from folder, delete, from Settings; the editor reflects each without a restart, and a download started in the editor shows in Settings.

## Acceptance criteria

- A manual `release.yml` run builds and smoke-tests all three targets and produces an AppImage and `.deb`, an NSIS installer, and a `.dmg`.
- `bun run tauri build` fails with a message naming `scripts/build-sidecar.sh` when the stamp is missing or does not match, and succeeds after running it.
- `ci.yml` runs all three suites on push and is green.
- No `resolve/main` remains in `models.json`, and a test enforces it.
- A connection that drops mid-download recovers on its own within the retry budget; a machine offline from the start fails at once.
- From Settings, each language can be downloaded, installed from a folder, cancelled mid-install, and deleted. The editor and Settings agree without a restart, in both directions.
- Deleting a language refuses while that language is installing, converting or exporting.
- Startup and `/models/status` timings for each OS are recorded in Results below.

## Docs

- `docs/implementation-plan.md` §7: "Still open for M6" rewritten as built, including the stale-binary correction; M6 checked off.
- `AGENTS.md` → Current state: the "`tauri build` does not rebuild the sidecar" warning replaced by the guard; Voices in Settings described.
- `README.md`: a "First launch on Windows and macOS" section (SmartScreen's More info → Run anyway; macOS Privacy & Security), and the release process (bump the version in `tauri.conf.json`, `Cargo.toml` and `package.json`, push a `v*` tag, publish the draft Release).

## Risks

- **Windows and macOS PyInstaller fixes are unsized.** The spec's native-library collection was written on Linux. Expect `collect_dynamic_libs` results, library names and data paths to differ.
- **The espeak-ng 159-character data path on Windows.** The onefile unpacks under the user's profile. The guard turns it into a readable error rather than a silent exit, but a user with a long profile path would lose English. The smoke test's espeak step runs on a runner's path, which may not be long enough to trigger it.
- **Actions minutes.** The repo is private, so minutes come from the account's quota; Windows and macOS minutes cost more than Linux, and each OS compiles `num2words2` from source. Release builds run on tags and by hand only for this reason.
- **Rate limiting in CI.** Three runners downloading 114 MB each from Hugging Face per run could meet a 429. The smoke test fails clearly if so; re-running later is the remedy.

## Open questions

- The first tag. `tauri.conf.json` says `0.1.0`; `v0.1.0` matches. Once a Release is published under a tag, that version is fixed for anyone who installed it. Settle before the first tag push.

## Results

Startup is the time from spawning the frozen sidecar binary to its ready line; `/models/status` is measured with one language (Amharic) installed.

| OS | Startup | `/models/status` |
| --- | --- | --- |
| Linux x64 | 2.0 s | 0.20 s |
| Windows x64 | not yet measured — awaiting the first green Release run | not yet measured — awaiting the first green Release run |
| macOS arm64 | not yet measured — awaiting the first green Release run | not yet measured — awaiting the first green Release run |

The Linux numbers are from the smoke run in Task 7 (`scripts/smoke_sidecar.py` against the frozen binary, `SMOKE PASSED`). The release workflow (`.github/workflows/release.yml`) has not yet run on GitHub, so Windows and macOS timings aren't available; the maintainer can fill these in from the first green run's job output.
