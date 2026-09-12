# M3 docling spike — findings

> **Status:** investigation record. **Date:** 2026-09-12. History, not a design and not a contract — it exists so the M3 extraction decision can be re-examined without redoing the work. Covers the evaluation of docling for milestone M3 in [docs/implementation-plan.md](../../implementation-plan.md), which this investigation moved away from; see Outcome. Internal name **HearBook**; user-facing name **Enisma**.
>
> Everything below was measured against **docling 2.126.0** on one Linux x86_64 machine (Python 3.12; an RTX A500 is present but unused — all quoted timings are CPU-only). Numbers from other versions or machines are not interchangeable with these.

## Verdict

Extraction is viable and the M0 harness survives contact with it. The pipeline runs offline, the frozen binary works, and text quality on real textbook pages is good. The cost is size: the sidecar goes from **21 MB to ~1.4 GB**, and that is the floor, not a tuning target. Three of the implementation plan's stated premises are wrong for this version and one M3 scope decision now needs revisiting.

## What was proven end to end

A PyInstaller-frozen **onedir** binary containing docling + CPU torch boots, prints the existing `{"port":…,"token_ok":true,"ready":true}` handshake, serves the token-guarded HTTP surface (401 without a bearer token), and runs a real docling extraction from a local model directory with `HF_HUB_OFFLINE=1` set. Page 22 of the Grade 9 Biology textbook came back as 2114 characters of correctly-ordered prose from inside the frozen binary.

The M0 contract needs no redesign: env-var config, stdout handshake, ephemeral port, bearer token, and the stdin-EOF anti-orphan watch all work unchanged with a 1.4 GB payload behind them.

## Extraction quality

Text-layer extraction is clean and noticeably better than raw `pdftotext`, which ran headings into body text. docling separated headings, preserved list numbering, and produced correct reading order.

All four languages round-trip from a text layer:

| Language | Source | Result |
| --- | --- | --- |
| English | real textbook, pages 20–27 | 519–2948 chars/page, correct structure |
| Amharic | synthetic Ge'ez text layer | intact, including `።` `፣` `፤` `፦` `፩` |
| Tigrigna | synthetic Ge'ez text layer | intact |
| Afaan Oromo | synthetic Latin text layer | intact |

The Amharic/Tigrigna/Oromo fixture is **synthetic** — generated with reportlab and an embedded Noto font. It proves docling round-trips Ethiopic codepoints out of an embedded-font text layer, which is the only mechanism the Ge'ez path has in v0. It does **not** prove anything about the font encodings a real Ethiopian textbook carries. No real Amharic/Tigrigna/Oromo textbook PDF exists on this machine; getting one is a prerequisite for trusting the Ge'ez path.

OCR quality on a scanned page was a genuine surprise: a 200 DPI rasterization of page 22 with its text layer stripped came back at 2156 characters, essentially matching the 1993 characters the text layer gave, with correct paragraph structure. OCR is not the degraded path the plan implies.

## Speed — this is a UX problem, not a perf footnote

Measured CPU-only, no GPU:

- **Text layer: 3.27 s/page.** The 171-page Biology textbook is **~9.3 minutes**.
- **OCR: 24.4 s** for a single page, including model load.

A ten-minute blocking operation on the happy path means extraction needs real progress reporting, cancellation, and a resumption story after an app quit. That is a design question M3 cannot avoid, and it is larger than the "stream per-page text into the editor" line in the plan suggests.

## Three plan premises that are wrong for docling 2.126.0

**1. EasyOCR is not docling's default engine — RapidOCR is.** `easyocr` is not importable in a default install. The default `ocr_options` is `OcrAutoOptions`, and `OcrEngine` offers `['auto', 'easyocr', 'tesseract_cli', 'tesseract', 'ocrmac', 'rapidocr']`. The plan has the two inverted: it treats EasyOCR as the free default and RapidOCR as the fallback to swap in if EasyOCR disappoints. In practice RapidOCR is the ONNX-based one you get for free, and EasyOCR is the opt-in extra that brings its own weight. Since RapidOCR handled a real textbook page well, the "swap it if it underperforms" contingency may never need to fire.

**2. `pip install docling` gives you an OCR engine that cannot run.** The standard bundle installs `rapidocr` but **not `onnxruntime`**, so constructing the OCR model raises `ImportError: onnxruntime is not installed`. You pay for 5.9 GB of CUDA torch and still cannot OCR a page. The `feat-ocr-rapidocr-onnx` extra fixes it.

**3. Default install is 5.9 GB of mostly-CUDA.** `pip install docling` resolves `torch 2.14.0+cu130`: `nvidia/` 3.2 GB and `triton/` 894 MB, about 4.1 GB of GPU payload for a CPU-only offline app. Pinning the PyTorch CPU index is mandatory.

A trap worth recording: pinning via `[tool.uv.sources]` **silently does nothing** when torch is only a transitive dependency of docling. `torch` and `torchvision` must be declared as the sidecar's own direct dependencies for the index pin to bind. The first attempt looked correct, synced without error, and still installed the CUDA build.

## The torch-free path does not exist (tested, not assumed)

docling ships `docling-slim` with opt-in extras and an ONNX Runtime object-detection engine, and only `layout_heron_default` publishes an ONNX export. It looks like a way to drop torch entirely. It is not, for two independent reasons:

1. The ONNX layout engine is ONNX for *inference* but loads its preprocessor through HuggingFace `AutoImageProcessor`, which in transformers 5.x **requires torch and torchvision**.
2. RapidOCR's docling wrapper calls `decide_device()` in its constructor, which imports torch unconditionally — even though RapidOCR itself runs on onnxruntime.

A `docling-slim` env with onnxruntime, transformers, and no torch reached **1.0 GB** and then failed at both of those points. Torch is not avoidable for the local-models PDF pipeline in this version.

## Size ladder, measured

| Configuration | venv size | Works? |
| --- | --- | --- |
| `pip install docling` (default) | 5.9 GB | text layer yes, OCR **no** (`ImportError`) |
| `docling-slim` + onnxruntime, no torch | 1.0 GB | **no** — torch required by layout preprocessing and OCR device selection |
| `docling-slim[…,models-local,feat-ocr-rapidocr-onnx]` + CPU-pinned torch | **1.5 GB** | **yes** — both paths verified |
| ⤴ frozen, PyInstaller onedir | **1.4 GB** | **yes** — handshake, `/health`, real extraction |

Models are separate from the above and download selectively via `docling-tools models download -o <dir> layout tableformer rapidocr`: 731 MB as fetched, but that includes both layout variants and a tableformer we do not need. The actually-required set is roughly **164 MB** (one layout model) **+ 62 MB** (RapidOCR).

## Packaging consequence

The current spec builds a **single-file** binary with `runtime_tmpdir=None`. Onefile extracts its entire payload to a temp directory on every launch — fine at 21 MB, not fine at 1.4 GB. The spike used **onedir**, which worked. Switching changes what `scripts/build-sidecar.sh` installs and how Tauri's `externalBin` ships it, since `externalBin` resolves a single suffixed file rather than a directory.

## API surface, verified against the installed version

- `PdfPipelineOptions.artifacts_path` — exists, and offline loading works with `HF_HUB_OFFLINE=1`.
- `PdfPipelineOptions.do_ocr` — exists, defaults to `True`.
- `convert(source, page_range=(first, last))` — exists, 1-indexed inclusive.
- `export_to_text(page_no=N)` and `export_to_markdown(page_no=N)` — both exist. This is the clean per-page extraction mechanism.
- `force_full_page_ocr` lives on `ocr_options`, not on the pipeline options.

Two things that need care at implementation time:

- **docling has no per-page callback.** `convert()` blocks for the whole range, then per-page export is instant. So "stream per-page text as it is produced" is not something docling hands you: either accept one long blocking convert followed by a burst of pages, or loop `page_range=(n, n)` per page for true incremental output at some throughput cost. That fork was not measured and is a real design decision.
- **Per-page OCR provenance is fiddly.** `Page.page_no` is 0-indexed while `page_range` is 1-indexed, and with `page_range=(20, 27)` the first page of the range did not appear in `conv_res.pages` at the index arithmetic suggested. Populating `pages.used_ocr` needs this nailed down rather than assumed.

## Fixture bug worth not repeating

The Oromo page initially extracted as a single character, which looked like a docling defect. It was not: Noto Sans Ethiopic has no Latin glyphs, so reportlab rendered substitution marks. `pdftotext` returned the same single character, which is what identified the fixture as the culprit rather than the extractor.

## What M3 still has to decide (not decided here)

1. **Streaming shape** — one blocking convert then a burst, versus a per-page convert loop. Affects the SSE contract and the Rust→webview plumbing, which today has only the request/response `query_health` proxy.
2. **Extraction lifecycle** — trigger point, progress surface, cancellation, resumption after quit, and what happens to a page the user has already edited. A ~10 minute operation makes these load-bearing, and there is no progress UI anywhere in the editor today.
3. **Interim model provisioning** — M3 needs models on disk but the download UX is M6. Dev-time prefetch, or pull part of M6 forward.
4. **Onefile → onedir** and the `externalBin` change that follows.
5. **Whether 1.4 GB is acceptable** at all, or whether it reopens the extraction-engine choice. This is the one that could reshape the milestone.

## Outcome

**docling was rejected for v0.** 1.4 GB to extract text already present in the file was judged disproportionate, and v0 instead assumes a text layer for all four languages — extending the Ge'ez text-layer-only policy to English and Oromo. Text comes from **pdf.js `getTextContent()`**, already present in the app (`pdfjs.TextLayer` in `src/components/editor/pdf-viewer.tsx`), so M3 adds no new dependency and does not involve the sidecar. The sidecar is still required for M4, where kokoro-onnx and sherpa-onnx are genuinely Python-only.

What that gives up, measured on the Grade 9 Biology textbook: docling dropped running headers, kept body prose in continuous reading order, and moved a page's sidebar to the end as its own block. Plain `pdftotext` interleaved that sidebar into the middle of a body paragraph. A crude gutter heuristic flags **85 of 171 pages** as having side-by-side content (it overcounts — wide-indented bullets and figure captions trip it too). The mitigation is that the editor is a page-by-page correction UI, so misordered blocks are visible beside the rendered page and correctable; docling was buying less manual correction rather than correctness. Two cheap heuristics recover much of it: running-header removal by cross-page repetition, and paragraph reflow by joining lines that lack sentence-final punctuation.

Text-layer coverage on that textbook: 168 of 171 pages solid, the other three being cover and blanks. It is a digitally-produced PDF, not a scan — which is worth keeping in view, since AGENTS.md and the README both describe the target as *scanned* printed textbooks. If the real corpus is genuinely scanned, text-layer-only fails wholesale rather than at the margin, and OCR stops being optional. One sample cannot settle that.

## Reproducing

The spike environments have been deleted (~12 GB across `spike/`, `spike-cpu/`, `spike-cpu2/`, `spike-slim/`); the repository was never modified. Recreating the working configuration means: `docling-slim[convert-core,format-pdf,models-local,feat-ocr-rapidocr-onnx,cli]` plus `torch` and `torchvision` **declared as direct dependencies** pinned to `https://download.pytorch.org/whl/cpu`, a PyInstaller **onedir** spec using `collect_all` over docling/docling_core/docling_parse/docling_ibm_models/rapidocr/onnxruntime/transformers/torch/torchvision, and models fetched with `docling-tools models download -o <dir> layout rapidocr`. Note that uv hardlinks packages from its cache, so deleting a venv reclaims far less disk than `du` reports.
