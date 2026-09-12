//! PDF inspection. The only module that knows about `lopdf`.

use std::path::Path;

use lopdf::Document;

/// Count the pages in a PDF.
///
/// Doubles as import validation: this runs before anything is copied, so a
/// corrupt file or a `.pdf` that is not one fails having written nothing.
pub fn count_pages(path: &Path) -> Result<i64, String> {
    let doc = Document::load(path).map_err(|e| format!("not a readable PDF: {e}"))?;
    let n = doc.get_pages().len() as i64;
    if n == 0 {
        return Err("PDF contains no pages".into());
    }
    Ok(n)
}

/// Largest PDF handed to the webview for extraction.
///
/// The webview buffers the whole file, so this bounds its memory. Generous for
/// a scanned textbook, which runs to tens of megabytes.
pub const MAX_PDF_BYTES: u64 = 256 * 1024 * 1024;

/// Read a picked PDF whole, for extraction in the webview.
///
/// Only needed before import, while the file is still outside the app data
/// directory: once copied, the asset protocol already grants the webview
/// access and pdf.js loads it by URL instead.
pub fn read_source_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("could not read PDF: {e}"))?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if meta.len() > MAX_PDF_BYTES {
        return Err(format!(
            "PDF is larger than the {} MB limit",
            MAX_PDF_BYTES / (1024 * 1024)
        ));
    }
    std::fs::read(path).map_err(|e| format!("could not read PDF: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/three-pages.pdf")
    }

    #[test]
    fn counts_pages_in_a_real_pdf() {
        assert_eq!(count_pages(&fixture()).unwrap(), 3);
    }

    #[test]
    fn rejects_a_file_that_is_not_a_pdf() {
        let path = std::env::temp_dir().join("enisma-not-a.pdf");
        std::fs::write(&path, b"this is plainly not a PDF").unwrap();
        let err = count_pages(&path).unwrap_err();
        assert!(err.contains("PDF"), "error should mention PDF, got: {err}");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn rejects_a_missing_file() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/does-not-exist.pdf");
        assert!(count_pages(&path).is_err());
    }

    #[test]
    fn read_source_bytes_returns_the_file() {
        let bytes = super::read_source_bytes(&fixture()).unwrap();
        assert!(bytes.starts_with(b"%PDF"), "should be the raw PDF");
    }

    #[test]
    fn read_source_bytes_rejects_a_missing_file() {
        let missing = std::env::temp_dir().join("enisma-no-such-file.pdf");
        let err = super::read_source_bytes(&missing).unwrap_err();
        assert!(err.contains("could not read PDF"), "got: {err}");
    }

    #[test]
    fn read_source_bytes_rejects_a_directory() {
        let err = super::read_source_bytes(&std::env::temp_dir()).unwrap_err();
        assert!(err.contains("not a file"), "got: {err}");
    }
}
