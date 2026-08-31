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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
    }

    #[test]
    fn counts_pages_in_a_real_pdf() {
        assert_eq!(count_pages(&fixture("three-pages.pdf")).unwrap(), 3);
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
        assert!(count_pages(&fixture("does-not-exist.pdf")).is_err());
    }
}
