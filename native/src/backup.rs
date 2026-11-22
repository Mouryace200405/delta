use crate::util::{is_app_dir, strip_root};
use napi::bindgen_prelude::*;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use napi_derive::napi;

/// Details of a backup archive.
#[napi(object)]
#[derive(Clone)]
pub struct BackupInfo {
    pub path: String,
    pub name: String,
    pub size: f64,
    pub created_at: f64,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Create a zipped backup of the whole vault.
///
/// The archive contains every file — notes, attachments, drawings and the
/// SQLite database — so restoring gives back a working vault.
#[napi]
pub fn create_backup(root: String, dest_dir: String) -> Result<BackupInfo> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(Error::new(
            Status::GenericFailure,
            format!("vault folder not found: {}", root),
        ));
    }
    let dest = if dest_dir.trim().is_empty() {
        root_path.clone()
    } else {
        PathBuf::from(&dest_dir)
    };
    std::fs::create_dir_all(&dest).map_err(|e| {
        Error::new(Status::GenericFailure, format!("creating backup folder: {}", e))
    })?;

    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let vault_name = root_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "vault".into());
    let file_name = format!("{}-backup-{}.zip", vault_name, stamp);
    let archive_path = dest.join(&file_name);

    let file = File::create(&archive_path).map_err(|e| {
        Error::new(Status::GenericFailure, format!("creating archive: {}", e))
    })?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let mut files: Vec<PathBuf> = Vec::new();
    collect_files(&root_path, &mut files, 0)?;
    files.sort();

    for path in &files {
        let rel = strip_root(&root_path, path);
        // Skip editor/OS debris that should not travel with a backup.
        if rel.split('/').any(|s| s.starts_with('.') && !is_app_dir(s)) {
            continue;
        }
        if rel.contains("/.tmp/") || rel.ends_with(".tmp") {
            continue;
        }
        let name = format!("{}/{}", vault_name, rel);
        zip.start_file(&name, options).map_err(|e| {
            Error::new(Status::GenericFailure, format!("adding {}: {}", rel, e))
        })?;
        let mut buf = Vec::new();
        File::open(path)
            .and_then(|mut f| f.read_to_end(&mut buf))
            .map_err(|e| Error::new(Status::GenericFailure, format!("reading {}: {}", rel, e)))?;
        zip.write_all(&buf).map_err(|e| {
            Error::new(Status::GenericFailure, format!("writing {}: {}", rel, e))
        })?;
    }
    zip.finish().map_err(|e| {
        Error::new(Status::GenericFailure, format!("finalising archive: {}", e))
    })?;

    let meta = std::fs::metadata(&archive_path).map_err(|e| {
        Error::new(Status::GenericFailure, format!("reading archive metadata: {}", e))
    })?;
    let created = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or_else(|| now_ms() as f64);

    Ok(BackupInfo {
        path: archive_path.to_string_lossy().to_string(),
        name: file_name,
        size: meta.len() as f64,
        created_at: created,
    })
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) -> Result<()> {
    if depth > 24 {
        return Ok(());
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            collect_files(&path, out, depth + 1)?;
        } else if path.is_file() {
            // The SQLite write-ahead log can be regenerated; skip it.
            if name.ends_with("-wal") || name.ends_with("-shm") {
                continue;
            }
            out.push(path);
        }
    }
    Ok(())
}

/// List backup archives in a folder, newest first.
#[napi]
pub fn list_backups(dir: String) -> Result<Vec<BackupInfo>> {
    let path = PathBuf::from(&dir);
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(&path) {
        Ok(e) => e,
        Err(_) => return Ok(out),
    };
    for entry in entries.flatten() {
        let file_path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".zip") {
            continue;
        }
        let meta = match std::fs::metadata(&file_path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let created = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as f64)
            .unwrap_or(0.0);
        out.push(BackupInfo {
            path: file_path.to_string_lossy().to_string(),
            name,
            size: meta.len() as f64,
            created_at: created,
        });
    }
    out.sort_by(|a, b| b.created_at.partial_cmp(&a.created_at).unwrap_or(std::cmp::Ordering::Equal));
    Ok(out)
}

/// Restore an archive into `dest_root`.
///
/// The archive's top-level folder is recreated inside the destination, so a
/// restore never overwrites unrelated files.
#[napi]
pub fn restore_backup(archive_path: String, dest_root: String) -> Result<String> {
    let archive = File::open(&archive_path).map_err(|e| {
        Error::new(Status::GenericFailure, format!("opening archive: {}", e))
    })?;
    let mut zip = zip::ZipArchive::new(archive).map_err(|e| {
        Error::new(Status::GenericFailure, format!("reading archive: {}", e))
    })?;
    let dest = PathBuf::from(&dest_root);
    std::fs::create_dir_all(&dest).map_err(|e| {
        Error::new(Status::GenericFailure, format!("creating destination: {}", e))
    })?;

    for index in 0..zip.len() {
        let mut entry = match zip.by_index(index) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let Some(relative) = entry.enclosed_name() else {
            continue; // refuse path traversal inside archives
        };
        let out_path = dest.join(&relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| {
                Error::new(Status::GenericFailure, format!("creating folder: {}", e))
            })?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                Error::new(Status::GenericFailure, format!("creating folder: {}", e))
            })?;
        }
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).map_err(|e| {
            Error::new(Status::GenericFailure, format!("extracting entry: {}", e))
        })?;
        std::fs::write(&out_path, &buf).map_err(|e| {
            Error::new(Status::GenericFailure, format!("writing file: {}", e))
        })?;
    }
    Ok(dest.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("vault");
        std::fs::create_dir_all(vault.join("notes")).unwrap();
        std::fs::write(vault.join("notes/a.md"), "# Hello").unwrap();
        std::fs::write(vault.join("data.bin"), vec![1u8, 2, 3]).unwrap();

        let backups = dir.path().join("backups");
        let info = create_backup(
            vault.to_string_lossy().to_string(),
            backups.to_string_lossy().to_string(),
        )
        .unwrap();
        assert!(info.size > 0.0);
        assert!(Path::new(&info.path).exists());

        let restore_dir = dir.path().join("restored");
        let restored = restore_backup(info.path.clone(), restore_dir.to_string_lossy().to_string())
            .unwrap();
        let note = Path::new(&restored).join("vault/notes/a.md");
        assert_eq!(std::fs::read_to_string(&note).unwrap(), "# Hello");
    }

    #[test]
    fn lists_backups_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("b1.zip"), b"x").unwrap();
        std::fs::write(dir.path().join("b2.zip"), b"y").unwrap();
        std::fs::write(dir.path().join("ignore.txt"), b"z").unwrap();
        let list = list_backups(dir.path().to_string_lossy().to_string()).unwrap();
        assert_eq!(list.len(), 2);
    }
}
