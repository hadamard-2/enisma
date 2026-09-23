# M5 — Export

> **Status:** implemented. **Date:** 2026-09-23. Covers milestone M5 (export) from [docs/implementation-plan.md](../../implementation-plan.md), and settles the five open questions in its §6. It builds on the per-page takes and freshness record from [the M4 design](./2026-09-20-m4-tts-design.md). Internal name **HearBook**; user-facing name **Enisma**.
>
> **Deviations from this design, found during implementation:**
> - When pages need synthesis and the language's model is missing, the dialog does not offer the download in-dialog as originally written; it shows a message pointing to the audio panel's download offer instead (see Frontend → Dialog below).
> - Time left in the progress view is shown as `h:mm:ss`, not "about N min left".
> - The post-stitch freshness re-check (Architecture, phase 3) does more than re-synthesize stale pages: if a page has reverted to a failed text by that point, the run now fails instead of stitching.
> - `delete_project` holds the conversion-slot lock across both its "is this project exporting" guard and the delete itself, rather than releasing it between the two.

## What changed since the implementation plan

The plan's §6 left five questions open. They turned out to depend on each other, and they were settled in this order:

- **Takes live in the page's own slot (Q2).** Export writes each page's take exactly where Convert does, so resuming comes free from the existing freshness check. That in turn settles where the loop lives (Q1): Rust drives it, because Rust owns the rows export writes.
- **Editing stays open during an export, and export chases the edits (Q3).** Before stitching, and again after, every page in range is checked for freshness and anything stale is synthesized again. The MP3 always matches the text as it stood when stitching started.
- **The encoder is `lameenc` in the sidecar (Q4).** 64 kbps CBR, mono, at the takes' native rate.
- **Empty pages are skipped and listed in the summary (Q5).**

The plan's locked decision stands: the output is **one MP3** for the chosen range, with no chapters.

## Goals

- Export a chosen page range of a book to one MP3 file, fully offline, in any of the four languages.
- Reuse every take that is already fresh for the chosen voice and rate. Synthesize only the rest.
- A multi-hour export can be cancelled, can survive the app quitting or crashing, and can be resumed. At most the page in progress is lost.
- The user can keep reading and correcting the book while it exports, and the result still reflects their corrections.
- A run left overnight never produces an MP3 with pages silently missing.

## Non-goals

- Chapters, M4B, or one file per page. One MP3, as the plan locks in.
- Takes in several voices kept side by side. A page has one take, as in M4.
- A bitrate choice in the UI.
- The MMS length-capped split for pages with no sentence marks. It is tracked as a separate task. M5 exports whatever the engines do today.
- Retrying automatically after a sidecar restart.
- Cleaning up a `.mp3.part` left behind by a crash or power loss.
- The licence question for distribution (see Risks). It belongs to M6.

## Verified environment facts

Checked on 2026-09-23 against crates.io, PyPI, GitHub and the repo. Re-check if versions move.

- **Takes are 16-bit mono PCM WAV** (`sidecar/tts.py`, `write_wav`). That is about 2.9 MB a minute at Kokoro's 24 kHz and about 1.9 MB a minute at MMS's 16 kHz, so roughly 350 MB of takes for the English sample book and 540 MB for Amharic.
- **`lameenc` 1.8.4** is LGPL-3.0. Its wheels are about 250 KB and cover CPython 3.10–3.15 on Linux x86_64 and aarch64, macOS universal2 and arm64, and Windows amd64 and arm64. The sidecar requires Python ≥ 3.12, so every target is covered.
- **`mp3lame-encoder` 0.2.5 / `mp3lame-sys` 0.1.11**, the Rust alternative, is LGPL-3.0 and builds a vendored LAME 3.100 from C source (autotools on Unix, `cc` on Windows), linking it statically. It was rejected; see Decisions.
- **The pure-Rust encoders** (`shine-rs`, `rusty_mp3`, `oxideav-mp3`) were rejected. shine is a fixed-point encoder built for hardware without floating point. The other two are weeks old with no track record.
- **espeak-ng is GPL-3.0** (its GitHub repository), and the frozen sidecar already bundles it through `espeakng-loader`.
- **The repository has no LICENSE file.**
- **MPEG-2 Layer III supports 16 and 24 kHz natively**, so the takes need no resampling.
- **`tauri-plugin-dialog` 2.7.3 is installed.** The capability file grants only `dialog:allow-open`, so a Save picker needs `dialog:allow-save` added.
- **The sidecar is restarted when it crashes, but its jobs live only in its memory** (`src-tauri/src/sidecar.rs`, `sidecar/jobs.py`). A crash loses the job that was running.
- **Nothing intercepts a window close today.**

## Decisions

| Decision | Choice |
| --- | --- |
| Output | One MP3 for the chosen range. |
| Where takes live | The page's own slot (`audio/page-<n>.wav` and its `audio_*` columns), shared with Convert. An export in another voice replaces the preview takes, and the dialog warns first. |
| Who drives the loop | Rust. One `/jobs/tts` per page through the same code path Convert uses. |
| Editing during export | Allowed. Stale pages are synthesized again before stitching and after it, until everything is fresh. |
| Convert during export | Refused. The export holds the single conversion slot for the whole run. Playback of existing takes still works. |
| Concurrent exports | One at a time, app-wide. |
| Resuming | Export again. There is no export record. The dialog counts what is left and is prefilled with the last export's settings and save path. |
| Save location | Chosen at the start, so an unattended run can finish on its own. |
| A page fails | Keep synthesizing the other pages, then stop before stitching and list the failed pages. |
| Empty pages | Skipped, and listed in the summary. |
| Between pages | A fixed pause, starting at 600 ms, to be tuned by ear. None before the first page or after the last. |
| Encoder | `lameenc` in the sidecar, not LAME in the Rust core. |
| Format | MP3, 64 kbps CBR, mono, at the takes' sample rate. |
| Tags | An ID3v2.3 title frame (TIT2) in UTF-16 carrying the project title. v2.3 rather than v2.4 because it has wider player support, and because titles are often Ge'ez and v2.3's only encoding for them is UTF-16. |
| Progress | A progress view that can be hidden, plus a title-bar pill on every screen, plus a summary at the end. |
| Closing the window mid-run | Asks for confirmation first. |
| Sidecar lost mid-run | Fatal to the run. There is no retry. |

**Why the sidecar for encoding.** Both options are LAME under LGPL. In the sidecar, `lameenc` ships wheels for every target with no C build, it fits the existing job machinery for progress and cancel, and the LGPL code sits beside the GPL espeak-ng already bundled there, so it creates no new kind of obligation. In the Rust core, the vendored LAME would add an autotools or `cc` build to every platform's build (M6's Windows and macOS builds are still untried), and it would be the first copyleft code linked statically into the Tauri binary itself.

**Why CBR.** Seeking and duration in a multi-hour file are reliable in every player without depending on a Xing/Info header, which the design therefore never needs.

## Architecture

An export is a Rust background task in three phases. The webview starts it and watches it, and the loop does not depend on which screen is showing.

1. **Synthesize.** `classify` sorts every page in range as *empty*, *fresh* (reused) or *needs synthesis*. Pages needing synthesis go one at a time through `synthesize_page`, the body of today's `convert_page_cmd` pulled out so export and the panel share one path. Each finished page is committed to its row immediately.
2. **Sweep.** At the end of the range, `classify` runs again. Pages that went stale because they were edited behind the loop are synthesized again, repeating until a pass finds nothing new. A page that failed is retried only if its text has changed since it failed. If any pages are still failing, the run ends with a summary that lists them, and nothing is stitched.
3. **Stitch.** Rust checks that every take in range records the same sample rate. It then starts one `/jobs/stitch` with the ordered WAV paths, the gap, the bitrate, the title and `out_path = <chosen>.mp3.part`. When that job finishes, Rust runs one last freshness check. If an edit landed during stitching, it goes back to phase 1 for those pages and stitches again. Otherwise it renames the `.part` over the chosen path. The rename is atomic, so the chosen path never holds half a file, and a previous export at that path survives a failed run.

**Starting.** Clicking Export opens the Save picker. `start_export_cmd` then creates and deletes `<chosen>.mp3.part`, so a location that cannot be written fails in the first second, not after hours. The settings are saved on the project, which is what makes resuming work.

**Exclusivity.** The single conversion slot records what holds it, a page or an export. The page-cancel check `job_for` still refuses to cancel anything but the page it names.

## Sidecar HTTP surface

One new route, on the existing `JobRegistry`, polled and cancelled through the existing `GET`/`DELETE /jobs/{id}`:

```
POST /jobs/stitch
{ "wavs": ["<abs path>", ...], "gap_ms": 600, "bitrate_kbps": 64,
  "title": "<project title>", "out_path": "<abs path>.mp3.part" }
→ { "jobId": "..." }
```

The job snapshot's `progress` is the fraction of samples encoded, its `sampleRate` is the input rate, and its `durationMs` is the length of the finished file.

The route knows nothing about pages, projects or freshness. Rust decides the gap, the bitrate and the title and passes them in.

**`sidecar/stitch.py`** is a plain function, `stitch(wavs, out_path, gap_ms, bitrate_kbps, title, on_progress) -> duration_ms`, with no FastAPI in it. `server.py` wraps it in a `Work`, as `_tts_work` wraps synthesis.

1. **Check first.** Before encoding a byte, every file must exist and be 16-bit mono PCM at the same sample rate. A mismatch fails at once with what was observed, naming both files: `page-12.wav: 24000 Hz, but page-1.wav is 16000 Hz`.
2. **Tag.** An ID3v2.3 header with one TIT2 frame, in UTF-16 with a BOM, is written first.
3. **Stream.** Each WAV is read in chunks of about one second and fed to one `lameenc` encoder (64 kbps, the input rate, one channel). The gap is written as zero samples between files. `flush()` runs at the end. Memory stays at one chunk however long the book is.
4. **Progress** is samples encoded out of the total, which is known from the headers up front.
5. **Cancel** is checked every chunk and returns early. The sidecar never deletes `out_path`. Rust owns cleanup.

**To verify before writing code:** `lameenc`'s method names and settings, against the installed 1.8.4. Also: how long LAME takes to encode the 4.7-hour Amharic range (to be timed on the sample book), and whether the frozen PyInstaller binary collects `lameenc` without an explicit entry in the spec.

## Data layer

Migration **v4** adds five nullable columns to `projects`:

```sql
export_voice TEXT, export_rate REAL,
export_first_page INTEGER, export_last_page INTEGER,
export_path TEXT
```

NULL means the project has never been exported. They are written when an export starts and exposed on `ProjectDetail`. There is no export table. The state that matters is in the page rows.

`delete_project` is refused while that project is being exported. Renaming stays allowed.

## Command surface

New module `src-tauri/src/export.rs`, with pure logic kept apart from the Tauri glue:

- `classify(conn, project, voice, rate, first, last) -> Vec<PageState>`, where `PageState` is `Empty | Fresh | Needs { reason: Missing | OtherSettings | Edited }`.
- `next_work(states, failed) -> Vec<page_no>`, where `failed` holds each failed page's number and text hash.

| Command | Does |
| --- | --- |
| `export_plan_cmd(project, voice, rate, first, last)` | Counts for the dialog: ready, to synthesize, how many of those replace a take in another voice or rate, and the empty pages. |
| `start_export_cmd(project, voice, rate, first, last, out_path)` | Validates the range, claims the slot, checks the location can be written, saves the settings, spawns the task, and returns right away. |
| `cancel_export_cmd()` | Sets the cancel flag and sends `DELETE` for the job that is running. Removes the `.part`. |
| `export_status_cmd()` | The current `ExportStatus`, so the pill and view come back correctly after a screen change or reload. |
| `dismiss_export_cmd()` | Clears a finished run's summary. |

**State:** `ActiveExport(Mutex<Option<ExportStatus>>)`. The status is either `Running { project, phase, done, total, current page, page progress }` or `Finished(outcome)`. A finished outcome stays until it is dismissed or the next export starts.

**Events:**

- `export://progress`, at the existing 250 ms poll rate, carries the phase (`synthesizing` / `sweeping` / `stitching`), done/total, the current page and its progress.
- `export://page-done { projectId, pageNo }`.
- `export://finished` carries `done { path, durationMs, empty }`, `failed { pages: [{pageNo, message}], empty }`, `cancelled { kept }` or `error { message }`.

**Failure classes.** A `/jobs/tts` that ends in `error` is a page failure: it is recorded and the run continues. The sidecar being unreachable, or a job returning 404 after a restart, is fatal to the run.

## Frontend

- **Entry.** The title bar's **Export audiobook…** item is enabled inside a project's editor, through `app-commands`. While that project is exporting, the item opens the progress view.
- **Dialog.** Voice and rate use the panel's controls and helpers (`voice-label`, `voice-selection`). Range is *Whole book* or *Pages [from]–[to]*, limited to 1…page count. Defaults come from the last export, then the panel's voice and rate, then the whole book. A plan line comes from `export_plan_cmd` and updates whenever a setting changes: `171 pages · 140 ready · 28 to synthesize · 3 empty`. When takes would be replaced, a warning appears: *"12 pages have audio in another voice or speed. Exporting replaces it."* If pages need synthesis and the language's model is missing, Export is disabled and a message pointing to the audio panel's download offer is shown (the download itself stays in the editor's panel, where its state lives). **Export…** opens the Save picker (`.mp3`, named from the last path or `<title>.mp3`) and then starts.
- **Progress view.** The same dialog, mounted at the app root so it opens from any screen. It shows the phase line (*Reading page 37 (12 of 28)* / *Checking for edits* / *Writing MP3*), an overall bar and a bar for the current page, the elapsed time, and *about N min left* once three pages have finished. The estimate is this run's mean seconds per page times the pages left. There is **Cancel export**, with no confirmation, and **Hide**.
- **Title-bar pill.** It shows on every screen while an export runs or an unseen result waits: *Exporting · 37%*, *Export ready*, or *Export needs attention* (for a failed or stopped run). A cancelled run shows no pill, since the user just asked for it. Clicking the pill opens the view.
- **Summary.** Done: the path, the duration, **Show in folder** (through the opener plugin; the API to be verified), and the empty pages. Failed: each page with its message, where a page links to that page in the editor, plus **Export again**. Cancelled: pages kept. Error: the message, plus "finished pages are kept."
- **Live badges.** When `export://page-done` names the page the editor is showing, the panel fetches that page's audio again.
- **Quit guard.** While an export runs, the window's close request is intercepted and an in-app confirmation shown. Confirming cancels the export, then closes. Whether the title bar's close button and the OS close both go through the same close-request event in Tauri 2 is to be verified.
- **Strings.** Every new string is in the catalogue for all four UI languages, and the non-English ones are added to `docs/translations-needing-review.md`. Backend error text stays in English.

## Testing

- **Rust unit tests (`export.rs`, in-memory DB):**
  - `classify` covers every state.
  - `next_work` skips a failed page with unchanged text and retries it once its text has been edited.
  - The sweep ends when nothing is stale.
  - The rate check rejects a mixed set.
  - Convert is refused during an export with the export message, and a second export is refused.
  - The slot is released on every exit path.
  - Migration v4 applies and round-trips the settings.
  - `delete_project` is refused mid-export.
- **Sidecar pytest (`stitch.py`, synthetic tones and silence at 16 and 24 kHz):**
  - The output begins with a valid ID3v2.3 tag carrying a UTF-16 Ge'ez title, followed by MPEG audio frames at the expected rate and bitrate.
  - The duration is the pages' total plus (n−1) gaps, estimated from the CBR file size within a frame.
  - Mixed rates, stereo and 8-bit files are rejected with the offending file named.
  - A cancel stops early and leaves the file in place.
  - Progress only goes up and ends at 1.0.
  - A route test for `/jobs/stitch` sits beside the existing job-route tests.
- **Vitest (`src/lib`):** range validation and clamping, the plan-line text, the time-left estimate (none before three pages, then the mean), and choosing the dialog's defaults.
- **Frozen sidecar:** rebuild with `scripts/build-sidecar.sh` and export once through the frozen binary.

## Acceptance criteria

Criteria 1–7 require a hand run of `bun run tauri dev` and are recorded below as **pending manual run**, not as passed. Criterion 8 (the frozen sidecar exports) is verified separately below.

1. A small English range exports to an MP3 that plays in at least two players, with working seeking and the project title shown. **Result: pending manual run.**
2. Cancelling halfway and exporting again synthesizes only the remaining pages. **Result: pending manual run.**
3. Quitting mid-run asks first. After relaunching, the dialog's counts pick up where the run stopped. **Result: pending manual run.**
4. A page edited behind the loop is spoken in its edited form in the final MP3. **Result: pending manual run.**
5. An Amharic page containing `²` fails. The run finishes the other pages, lists that page, and does not stitch. After it is fixed, exporting again redoes only that page. **Result: pending manual run.**
6. Exporting in a voice other than the panel's warns first, and afterwards the panel shows the replaced pages as stale for its own voice. **Result: pending manual run.**
7. The full 4.7-hour Amharic sample range stitches successfully, and the encode time is recorded in this document. **Result: pending manual run.**
8. The frozen sidecar exports. **Result: verified 2026-09-23 — `scripts/build-sidecar.sh` rebuilt the frozen binary, and a `/jobs/stitch` call against it finished `state: done`, `durationMs: 2600`, writing a 21,631-byte MP3. `lameenc` was already collected by PyInstaller; no spec change was needed.**

## Risks

- **The MMS "no sentence marks" page.** An export meets every page, so it is likelier than preview to hit a page with no `.`, `!` or `?`. That becomes one unbounded synthesis call, taking minutes, with Cancel only working at the end. This is not fixed in M5 by decision. Cancel and the progress bar will look stuck on such a page.
- **Disk use.** A full book of takes is 350–540 MB on top of the MP3. There is no UI to reclaim it.
- **Licence.** The repository has no LICENSE file. The frozen sidecar already bundles GPL-3.0 espeak-ng, and M5 adds LGPL LAME beside it. How the app is licensed and distributed needs deciding before M6 packaging.
- **Encode speed is unmeasured.** If LAME turns out slower than expected on long ranges, the stitch phase is still covered by progress and cancel. Only the wait gets longer.

## Open questions

- The exact inter-page gap, tuned by ear during implementation from the 600 ms starting point.
