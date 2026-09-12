# M3 — Text Extraction

> **Status:** design approved, pending implementation plan. **Date:** 2026-09-12. Covers milestone M3 (extraction) from [docs/implementation-plan.md](../../implementation-plan.md), with that milestone's engine choice replaced — see [the docling spike](./2026-09-12-m3-extraction-docling-spike.md) for the investigation that caused the change. Internal name **HearBook**; user-facing name **Enisma**.

## What changed since the implementation plan

The plan specifies docling for extraction, with EasyOCR as a fallback for Latin-script projects and no OCR for Ge'ez. Evaluating docling 2.126.0 produced a working offline pipeline of acceptable quality, but it takes the sidecar from 21 MB to roughly 1.4 GB and runs at 3.27 s/page — about ten minutes for a 171-page textbook. Torch is not avoidable in that version; the spike documents why.

v0 therefore assumes a text layer for **all four languages**, extending the Ge'ez text-layer-only policy to English and Oromo, and takes its text from **pdf.js**, which the app already bundles and already uses to render a selectable text layer in the editor. Extraction adds no new dependency, does not involve the Python sidecar, and runs in under a second for a whole book.

This is a narrowing of M3, not a reinterpretation of it: extraction still fills `pages.source_text` and still feeds the editor's existing text panel. What is gone is OCR, and with it the sidecar work, the model download dependency, and the progress/resume machinery a ten-minute operation would have required.

## Goals

- Every imported project opens with real extracted text in the editor, for all four languages.
- Text is assembled into readable prose — paragraphs reflowed, page furniture removed — not dumped as positioned fragments.
- A PDF with no text layer is reported honestly, at import and per page, rather than producing silently blank pages.
- Extraction is deterministic and repeatable from the stored PDF, so a project missing text can repair itself.

## Non-goals

- **OCR, in any language.** A page with no text layer stays empty in v0. This is the plan's Ge'ez decision applied to the whole app, and it is the single largest thing this milestone gives up.
- **Column and sidebar detection.** pdf.js's content-stream order already keeps side-by-side blocks contiguous on the sample textbook, so blocks are preserved in stream order but not analysed. A page whose stream order is genuinely wrong is corrected by hand in the editor.
- **Table structure, figure handling, and heading hierarchy.** Captions and table text arrive as ordinary lines.
- Sidecar involvement of any kind. The sidecar remains at its M0 harness state until M4, where kokoro-onnx and sherpa-onnx make Python genuinely mandatory.
- Re-extraction as a user-facing action. Repair is automatic and invisible; an explicit "re-extract" button is a follow-up, not part of this milestone.

## Verified environment facts

Measured on this machine, against the versions actually installed. Numbers from other versions are not interchangeable with these.

| Fact | Value | How it was established |
| --- | --- | --- |
| pdf.js version | `pdfjs-dist` 6.3.289 | `node_modules/pdfjs-dist/package.json` |
| Extraction speed | **5.4 ms/page**, 0.92 s for all 171 pages | `getTextContent()` over the Grade 9 Biology textbook in Node |
| Slowest single page | 49 ms | same run |
| `TextItem` shape | `str`, `dir`, `transform`, `width`, `height`, `fontName`, `hasEOL` | `pdfjs-dist/types/src/display/api.d.ts:312` |
| Item position | `transform[4]` = x, `transform[5]` = y; **there are no x/y fields** | same type definition |
| Non-text entries | `TextMarkedContent` is interleaved in `items` and has no `str` | same type definition |
| Tauri version | 2.11.0 | `src-tauri/Cargo.lock` |
| Raw IPC bytes | `tauri::ipc::Response::new(Vec<u8>)` → `InvokeResponseBody::Raw`, bypassing JSON | `tauri-2.11.0/src/ipc/mod.rs:99-113` |
| Schema readiness | `source_text`, `edited_text`, `used_ocr` all exist at `user_version = 1` | `src-tauri/src/db.rs` |
| Test environment | vitest, `environment: "node"`, `include: ["src/**/*.test.ts"]` — no DOM | `vite.config.ts:115` |
| Text-layer coverage, sample book | 168 of 171 pages solid; pages 2 and 3 blank, page 1 is the cover | per-page `pdftotext` character counts |
| Pages flagged as having side-by-side content | 85 of 171 (crude gutter heuristic; overcounts) | `pdftotext -layout` gutter detection |

## Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Extraction engine | **pdf.js `getTextContent()`** | Already bundled, already used for the selectable text layer, no new dependency, no sidecar, 350× faster than the alternative. |
| When extraction runs | **At import, whole book, before the project row exists** | Sub-second cost makes deferral pointless. Extracting first is what lets the scanned-PDF warning offer a real cancel, and what lets the project be created atomically with its text. |
| Rust ↔ webview bridge | **Rust returns raw PDF bytes; the webview returns assembled text** | The only shape satisfying both atomic create and warn-before-create. Raw-byte IPC avoids JSON-encoding the file; the text coming back is ~330 KB for 171 pages. Rejected: copying first and extracting second (warning arrives after commit), and granting the picked file into the asset scope (widens webview file access for no real gain). |
| Assembly depth | **Lines, paragraph reflow, header/footer removal. No column analysis.** | Header removal is the highest value per line of code — it removes text that would otherwise be spoken on every page — and cross-page repetition is a more reliable signal than per-page layout inference. Columns are deferred because pdf.js already keeps blocks contiguous. |
| Line grouping | **y-proximity clustering, with `hasEOL` as a secondary signal** | `hasEOL` alone is insufficient: on sample page 40 the running header and the following heading arrived as one `hasEOL` run, fusing furniture to real content where no line-level rule could separate them. |
| Line order within a block | **Sorted by descending y** | Stream order is not always reading order — a box label was emitted after the bullets belonging under it. Sorting globally by y would undo the block separation pdf.js gets right, so the sort is scoped to a block. |
| Page count authority | **Rust and `lopdf`, as at M1** | The process that owns the file owns the facts about it. pdf.js's `numPages` becomes a cross-check: a mismatch is an error, not a silent reconciliation. |
| "Not extracted" vs "nothing there" | **`source_text` NULL vs `''`** | The column is already nullable. The distinction is what makes both the per-page empty state and the self-repair pass expressible without a new column. |
| Page-panel states | **Stays binary (done / not-done)** | The panel answers one question — what is left to review — and an empty page is still unreviewed. A third state would widen its model, its filter union, and its legend for a case the editor already explains. |
| `used_ocr` | **Written `0` for every row; remains inert** | Text-layer extraction is by definition not OCR. The column stays reserved for whenever OCR arrives, exactly as M1 intended. |

## Architecture

Extraction lives entirely in the webview. Rust supplies bytes and owns persistence; it does no text work.

```
picked path ──▶ Rust: read_pdf_bytes ──raw bytes──▶ webview: pdf.js getTextContent
                                                          │
                                                   extract-assemble (pure)
                                                          │
                                   per-page text + emptiness summary
                                                          │
           Rust: import_project_cmd ◀──────────────────────┘
             copy PDF + insert project + pages + source_text, one transaction
```

Two front-end units, split so the logic is testable without a DOM or a PDF:

- **`src/lib/extract.ts`** — the pdf.js driver. Opens a document from bytes, pulls `getTextContent()` per page, filters `TextMarkedContent`, maps each `TextItem` to the local shape below, and calls the pure layer. This is the only file that imports pdf.js.
- **`src/lib/extract-assemble.ts`** — pure functions over `{ str, x, y, height, hasEOL }`, with no pdf.js import and no I/O. All assembly logic lives here.

The local item shape exists so the pure layer does not depend on pdf.js types. It carries what assembly needs and nothing else.

## Extraction and assembly

The pipeline runs per page, then once across the document for furniture removal.

1. **Filter and map.** Drop entries without a `str` (`TextMarkedContent`), and entries whose `str` is empty. Map to the local shape, reading x from `transform[4]` and y from `transform[5]`.
2. **De-duplicate.** Collapse items with identical `str` at effectively identical x and y. Overlapping draws are real: the sample book's footer page number came through doubled, as `"3333"` rather than `"33"`.
3. **Group into lines.** Cluster consecutive items whose y agrees within a tolerance derived from item height. Within a line, order items by x and join. `hasEOL` refines the boundary but does not define it.
4. **Segment into blocks.** Break the line stream wherever a line's left edge departs from the current block's by more than a column-gap threshold. This keeps a sidebar, a main column, and a header as separate blocks without attempting to interpret them.
5. **Order within blocks.** Sort each block's lines by descending y. Blocks themselves stay in stream order.
6. **Reflow paragraphs.** Join a line to the previous one unless the previous ends in sentence-final punctuation, or the current begins a list item. The "is this line long enough to be a wrapped continuation" test is **relative to the block's own typical line width**, not an absolute character count — an absolute threshold left the narrow sidebar unreflowed while working correctly on the main column.
7. **Remove running furniture.** Across all pages, key each candidate line by its normalized text and approximate vertical band, normalizing digit runs so per-page numbers collapse together. Drop keys recurring on more than a threshold share of pages. This runs document-wide because repetition across a book is the signal; a single page cannot supply it.

Steps 1–6 are per page and pure. Step 7 needs every page, which is another reason extraction is a whole-book operation rather than a lazy per-page one.

## Data layer

**No migration.** Schema v1 already defines `source_text`, `edited_text`, and `used_ocr`; `PRAGMA user_version` stays at 1.

Writes this milestone introduces:

- `pages.source_text` — assembled text per page. `''` where extraction succeeded and the page genuinely holds no text; NULL only where extraction has not run.
- `pages.used_ocr` — `0` always.

`pages.edited_text` is never written by extraction. A repair pass overwrites `source_text` only, so corrections cannot be clobbered, and the editor's existing `editedText ?? sourceText` read continues to work untouched.

**Emptiness thresholds**, with the evidence behind them rather than as bare constants:

- A page counts as empty below **50 non-whitespace characters**. On the sample textbook this flags exactly pages 2 and 3, both genuinely blank, and does not flag the 199-character cover.
- A book is reported as *looking scanned* when at least **80%** of its pages are empty.

Both are tunable defaults, stated in one place in code.

## Command surface

| Command | Change | Shape |
| --- | --- | --- |
| `read_pdf_bytes` | **new** | Takes an absolute path, returns `tauri::ipc::Response` wrapping the file's bytes. Used only by the import flow, for a file that is not yet inside the app data directory. Validates that the path is a regular file and rejects anything over a size ceiling — the ceiling's value is fixed in the implementation plan — so a mis-picked file cannot exhaust webview memory. |
| `import_project_cmd` | **changed** | Gains a per-page text argument alongside the existing title, language, and source path. Writes `source_text` inside the transaction that already creates the project and its page rows. Rejects the call when the supplied array's length disagrees with the `lopdf` page count. |
| `save_page_source_text_cmd` | **new** | Takes a project id and a full per-page text array, and replaces every row's `source_text` in one transaction. The repair path's only write. Never touches `edited_text` or `done`, and applies the same page-count check as import. |
| `save_page_text_cmd` | unchanged | Still the editor's `edited_text` autosave path. |

The repair path needs no bytes command: the stored PDF already lives under the app data projects directory, which the asset protocol scope grants ([lib.rs](../../../src-tauri/src/lib.rs)), so pdf.js loads it by URL exactly as the viewer does.

## Import flow

1. The dialog picks a PDF, as today.
2. Confirm calls `read_pdf_bytes`, then extracts and assembles in the webview. The dialog is busy for this; it costs about a second for a 171-page book.
3. If the book trips the looks-scanned threshold, the dialog stays open and explains that the PDF appears to be scanned and that this version cannot read scanned text, offering *import anyway* or *cancel*. Because no row exists yet, cancel leaves nothing behind — no project, no copied file.
4. On confirm, `import_project_cmd` copies the PDF into the project directory and inserts the project, its pages, and their text in one transaction.
5. The editor opens on real text.

**Self-repair.** On editor open, if *any* page has `source_text` NULL, the **whole document** is re-extracted from the stored PDF and every row's `source_text` replaced. It is not a per-page repair: furniture removal is a document-wide step, so a page extracted alone would keep the running header that every other page had stripped, and the book would be internally inconsistent. Re-extracting everything costs about a second, is deterministic, and leaves `edited_text` untouched. This covers a project imported before this milestone, an interrupted write, and any future path that creates pages without text. It is invisible when there is nothing to repair.

## Frontend

- **`src/components/home/import-dialog.tsx`** — the scanned warning becomes a third state alongside the existing `busy` and `error`, reusing the dialog's current structure rather than adding scaffolding. Confirm becomes a two-phase action: extract, then create.
- **`src/components/editor/center-panel.tsx`** — the existing `center.emptyText` splits in two. One string covers *extracted, genuinely empty*, naming the missing text layer and the absent OCR as the reason. One transient covers *not yet extracted*, visible only during a repair pass. The textarea stays editable in the empty case: with no OCR, typing the page is the only workaround, and read-only would remove it.
- **`src/components/editor/page-panel.tsx`** — unchanged. The done/not-done model stands.
- **`src/locales/{en,am,om,ti}.json`** — new copy in all four catalogues as `{ message, context }` entries. Failures surfaced from Rust stay English, per the existing convention; the scanned warning and the empty-page copy are UI text and are translated.

## Testing

The module boundary is what makes this testable: assembly is pure, so it runs in the existing node test environment with no DOM, no PDF, and no pdf.js import.

**Assembly unit tests** — hand-built item arrays, golden-style assertions of input to expected prose, following the `cover.test.ts` precedent of pinning output rather than asserting properties of the algorithm. Each case is a defect observed during the spike, not an invented one:

- line clustering splits the fused `"…Classification of Organisms2.6.3. Kingdom Fungi"` run in two
- within-block y-sort places a box label above its own bullet list rather than after it
- reflow joins narrow-column lines that a fixed 40-character threshold wrongly left alone, while still not joining across a sentence boundary
- de-duplication turns a doubled `"3333"` page number back into `"33"`
- furniture removal drops a line recurring across a synthetic multi-page input and keeps a similar line appearing on one page only
- an empty page yields `''`, not a whitespace string

**Driver integration test** — one test against a small committed fixture, covering `TextItem` to local-shape mapping and the per-page array. The Grade 9 Biology PDF is not a candidate: 11 MB, and not ours to redistribute. A small purpose-made fixture is added for the front-end rather than reaching into `src-tauri/tests/fixtures/`.

**Rust tests**, colocated in the `#[cfg(test)] mod tests` style already used by `import.rs` and `project.rs`:

- a page-count mismatch between `lopdf` and the supplied text array is rejected
- `source_text` is written in the same transaction as the project and page rows
- NULL and `''` survive a round trip and remain distinguishable

## Acceptance criteria

Automated:

1. `bun run test` passes, including every assembly case above.
2. `cargo test` passes, including the mismatch rejection.

Manual, in the running app — the test environment has no DOM, so these are checked by hand:

3. Importing the Grade 9 Biology textbook produces a project whose pages hold real text, and the editor opens on it.
4. Import completes in about a second; no progress UI is warranted or present.
5. Page 40 arrives with its running header removed, its body prose reflowed into paragraphs, `"Objectives"` above its bullets, and the sidebar present as its own trailing block.
6. No page shows a doubled page number.
7. Editing a page still autosaves, and the saved indicator behaves as before.
8. Importing an image-only PDF raises the scanned warning before any project is created; cancelling leaves no project and no copied file in the app data directory.
9. Importing it anyway creates the project, and its pages show the empty-page state naming the missing text layer.
10. That empty page's textarea still accepts typing, and the typed text persists across a relaunch.
11. Setting a single page's `pages.source_text` to NULL by hand repopulates **every** page's `source_text` on next editor open, and the repaired page's running header is stripped like all the others.
12. Doing that on a page that also has `edited_text` leaves the edit intact and still displayed.
13. All new copy appears translated when the interface language is Amharic, Tigrigna, or Oromo.

## Risks

- **The text-layer premise rests on one real book.** The sample textbook is digitally produced, with 168 of 171 pages carrying solid text. AGENTS.md and the README both describe the target as *scanned* printed textbooks. If real target material is genuinely scanned, this milestone ships an app that cannot read it, and the scanned warning becomes the primary experience rather than an edge case. Acquiring a real Amharic or Tigrigna textbook and importing it is the cheapest way to find out, and it should happen before this design is built on.
- **The Ge'ez evidence is synthetic.** Ethiopic codepoints round-trip correctly out of an embedded-font text layer, but that was tested with a reportlab-generated fixture. Real Ethiopian textbook PDFs may carry font encodings that behave differently, and no real one was available.
- **Assembly heuristics are tuned against one book's typography.** The y tolerance, column-gap threshold, block-relative reflow width, and furniture-repetition share were all chosen against a single textbook. A different publisher's layout will need them revisited. Keeping them named and in one place is the mitigation, not a fix.
- **Furniture removal can delete real content.** A short line that genuinely repeats across many pages at the same position — a recurring instruction in a workbook, for instance — is indistinguishable from a running header by this rule. The editor makes it recoverable but only if noticed.
- **Deferring column analysis rests on stream order being sane.** It was on the page tested. A PDF whose content stream is ordered arbitrarily would interleave blocks with nothing to catch it.

## Follow-ups surfaced but not taken

Recorded so they are not lost. None are in scope here.

- An explicit user-invocable re-extract action. Repair is automatic in this design, so there is no way to ask for it deliberately after tuning the heuristics.
- `HEARBOOK_MODELS_DIR` is documented in `sidecar/README.md` as passed by the supervisor, but `build_command` in `src-tauri/src/sidecar.rs` never sets it. Still true, and still cosmetic while no models exist.
- `sidecarHealth()` in `src/lib/platform.ts` remains defined but never called. This milestone does not change that, because extraction no longer involves the sidecar at all — so the webview to Rust harness path stays unexercised until M4.
- Column and sidebar analysis, should the editor show that stream order is not enough in practice.
- Project deletion — the library card's `…` menu is still inert.
