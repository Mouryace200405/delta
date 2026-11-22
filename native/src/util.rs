use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use std::path::{Component, Path, PathBuf};
use xxhash_rust::xxh3::xxh3_64;

/// Characters that must be percent-encoded inside a Markdown URL so the
/// reference survives round-tripping through a parser. `/` is kept literal so
/// relative paths stay readable.
const MD_URL_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'\\')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}')
    .add(b'\'');

/// Internal folder holding app-managed data that lives inside the vault.
pub const APP_DIR: &str = ".delta";
/// Folder name used by earlier builds; migrated on open.
pub const LEGACY_APP_DIR: &str = ".vellum";
/// Trash area for deleted entries — recoverable, hidden from the tree.
pub const TRASH_DIR: &str = ".delta/trash";
/// Default attachments folder.
pub const ATTACHMENTS_DIR: &str = "attachments";
/// Default drawings folder.
pub const DRAWINGS_DIR: &str = "drawings";
/// SQLite database that travels with the vault.
pub const DB_FILE: &str = ".delta/app.db";

/// True for the app's own folder inside a vault, current or legacy.
pub fn is_app_dir(name: &str) -> bool {
    name == APP_DIR || name == LEGACY_APP_DIR
}

/// Stable, fast content fingerprint used for external-change detection.
pub fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:016x}", xxh3_64(bytes))
}

/// The file name without directory or extension.
pub fn file_stem(path: &str) -> String {
    let base = path.rsplit('/').next().unwrap_or(path);
    match base.rfind('.') {
        Some(idx) if idx > 0 => base[..idx].to_string(),
        _ => base.to_string(),
    }
}

/// Normalise a path to forward slashes with no leading `./`.
pub fn normalize_rel(rel: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    let normalized = rel.replace('\\', "/");
    for segment in normalized.split('/') {
        match segment {
            "" | "." => continue,
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

/// Reject traversal attempts and absolute paths inside a vault.
pub fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.trim().is_empty() {
        return Err("path is empty".into());
    }
    // Inspect the raw segments before normalising: `..` must be rejected, not
    // silently collapsed, otherwise a traversal would land back inside the
    // vault at an unrelated location.
    let raw = rel.replace('\\', "/");
    if raw.starts_with('/') {
        return Err(format!("invalid path: {}", rel));
    }
    for segment in raw.split('/') {
        if segment == ".." {
            return Err(format!("path escapes the vault: {}", rel));
        }
        if segment.contains(':') {
            return Err(format!("invalid path: {}", rel));
        }
    }
    let cleaned = normalize_rel(&raw);
    if cleaned.is_empty() {
        return Err("path is empty".into());
    }
    let mut out = root.to_path_buf();
    for segment in cleaned.split('/') {
        out.push(segment);
    }
    // Belt and braces: the resolved path must still live under the root.
    let canon_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let canon_out = match out.canonicalize() {
        Ok(p) => p,
        Err(_) => out.clone(),
    };
    if !canon_out.starts_with(&canon_root) {
        return Err(format!("path escapes the vault: {}", rel));
    }
    Ok(out)
}

/// Make a filename safe on every supported platform while keeping it readable.
pub fn sanitize_file_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => out.push('-'),
            c if (c as u32) < 0x20 => out.push(' '),
            c => out.push(c),
        }
    }
    let trimmed = out.trim().trim_end_matches('.').to_string();
    if trimmed.is_empty() {
        "Untitled".to_string()
    } else {
        trimmed.chars().take(180).collect()
    }
}

/// Percent-encode a relative path for use inside `![](...)`.
pub fn encode_md_path(rel: &str) -> String {
    utf8_percent_encode(rel, MD_URL_SET).to_string()
}

/// Detect an image format from its magic bytes; returns the file extension.
pub fn sniff_image_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 8 && &bytes[0..8] == b"\x89PNG\r\n\x1a\n" {
        return Some("png");
    }
    if bytes.len() >= 3 && &bytes[0..3] == b"\xff\xd8\xff" {
        return Some("jpg");
    }
    if bytes.len() >= 6 && (&bytes[0..6] == b"GIF87a" || &bytes[0..6] == b"GIF89a") {
        return Some("gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("webp");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        return Some("wav");
    }
    if bytes.len() >= 4 && &bytes[0..4] == b"%PDF" {
        return Some("pdf");
    }
    if bytes.len() >= 4 && &bytes[0..4] == b"PK\x03\x04" {
        return Some("zip");
    }
    None
}

/// Write bytes atomically: temp file in the same directory, fsync, then rename.
///
/// A crash mid-write therefore leaves either the old content or the new
/// content on disk — never a truncated file.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "tmp".into());
    let tmp_path = dir.join(format!(".{}.{}.tmp", file_name, uuid::Uuid::new_v4().simple()));
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp_path)?;
        f.write_all(bytes)?;
        f.flush()?;
        f.sync_all()?;
    }
    match std::fs::rename(&tmp_path, path) {
        Ok(()) => {}
        Err(e) => {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(e);
        }
    }
    // Fsync the directory so the rename itself is durable.
    if let Ok(dir_handle) = std::fs::File::open(dir) {
        let _ = dir_handle.sync_all();
    }
    Ok(())
}

/// True when `child` is inside `parent` (used to reject escapes).
pub fn is_inside(parent: &Path, child: &Path) -> bool {
    let p = parent.canonicalize().unwrap_or_else(|_| parent.to_path_buf());
    let c = child.canonicalize().unwrap_or_else(|_| child.to_path_buf());
    c.starts_with(&p)
}

/// Strip the vault root from an absolute path, yielding a vault-relative path.
pub fn strip_root(root: &Path, abs: &Path) -> String {
    match abs.strip_prefix(root) {
        Ok(r) => normalize_rel(&r.to_string_lossy()),
        Err(_) => normalize_rel(&abs.to_string_lossy()),
    }
}

/// Compute a relative path from `from_dir` to `to`, both vault-relative.
pub fn relative_between(from_dir: &str, to: &str) -> String {
    let from_parts: Vec<&str> = from_dir
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .collect();
    let to_parts: Vec<&str> = to.split('/').filter(|s| !s.is_empty() && *s != ".").collect();

    let mut common = 0usize;
    while common < from_parts.len() && common < to_parts.len() && from_parts[common] == to_parts[common] {
        common += 1;
    }
    let mut out = String::new();
    for _ in common..from_parts.len() {
        out.push_str("../");
    }
    for (i, part) in to_parts.iter().enumerate().skip(common) {
        if i > common {
            out.push('/');
        }
        out.push_str(part);
    }
    if out.is_empty() {
        out.push('.');
    }
    out
}

/// Split a vault-relative path into (parent dir, file name).
pub fn split_parent(rel: &str) -> (String, String) {
    let cleaned = normalize_rel(rel);
    match cleaned.rfind('/') {
        Some(idx) => (cleaned[..idx].to_string(), cleaned[idx + 1..].to_string()),
        None => (String::new(), cleaned),
    }
}

/// Detect the extension of a path, lowercased.
pub fn ext_of(rel: &str) -> String {
    Path::new(rel)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

/// Human-readable byte size.
pub fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0usize;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{} {}", bytes, UNITS[0])
    } else {
        format!("{:.1} {}", value, UNITS[unit])
    }
}

/// Path components that must never be traversed.
pub fn is_reserved_component(name: &str) -> bool {
    name == "." || name == ".." || is_app_dir(name)
}

/// Normalise a path with `..` segments resolved lexically.
pub fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            c => out.push(c.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_paths() {
        assert_eq!(normalize_rel("./a//b/../c.md"), "a/c.md");
        assert_eq!(normalize_rel("a\\b.md"), "a/b.md");
    }

    #[test]
    fn rejects_traversal() {
        let root = std::env::temp_dir();
        assert!(safe_join(&root, "../etc/passwd").is_err());
        assert!(safe_join(&root, "notes/../../escape").is_err());
        assert!(safe_join(&root, "notes/ok.md").is_ok());
    }

    #[test]
    fn sniffs_images() {
        assert_eq!(sniff_image_extension(b"\x89PNG\r\n\x1a\n...."), Some("png"));
        assert_eq!(sniff_image_extension(b"\xff\xd8\xff\xe0"), Some("jpg"));
        assert_eq!(sniff_image_extension(b"GIF89a...."), Some("gif"));
        assert_eq!(sniff_image_extension(b"RIFF....WEBPVP8 "), Some("webp"));
        assert_eq!(sniff_image_extension(b"not an image"), None);
    }

    #[test]
    fn computes_relative_paths() {
        assert_eq!(relative_between("a/b", "a/b/c.md"), "c.md");
        assert_eq!(relative_between("a/b", "a/c.md"), "../c.md");
        assert_eq!(relative_between("", "x/y.md"), "x/y.md");
        assert_eq!(relative_between("a", "a"), ".");
    }

    #[test]
    fn atomic_write_replaces_content() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("note.md");
        atomic_write(&target, b"first").unwrap();
        atomic_write(&target, b"second").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "second");
        // No temp files left behind.
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn encodes_markdown_paths() {
        assert_eq!(encode_md_path("attachments/my image.png"), "attachments/my%20image.png");
        assert_eq!(encode_md_path("attachments/a.png"), "attachments/a.png");
    }
}
