use crate::db::{Db, EventRecord, NoteRecord, TaskRecord};
use crate::error::{io_err, to_napi_err};
use crate::notes;
use crate::util::*;
use napi::bindgen_prelude::*;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use napi_derive::napi;

/// Metadata describing the open vault.
#[napi(object)]
#[derive(Clone)]
pub struct VaultInfo {
    pub path: String,
    pub name: String,
    pub attachments_dir: String,
    pub drawings_dir: String,
    pub note_count: f64,
    pub task_count: f64,
    pub event_count: f64,
    pub schema_version: f64,
}

/// One row of the flattened file tree.
#[napi(object)]
#[derive(Clone)]
pub struct TreeEntry {
    pub path: String,
    pub name: String,
    /// `folder` or `file`
    pub kind: String,
    pub depth: f64,
    pub size: f64,
    pub modified: f64,
    pub extension: String,
}

/// Result of writing a file.
#[napi(object)]
#[derive(Clone)]
pub struct FileStamp {
    pub path: String,
    pub size: f64,
    pub modified: f64,
    pub hash: String,
}

/// An imported attachment.
#[napi(object)]
#[derive(Clone)]
pub struct AttachmentInfo {
    /// Vault-relative path.
    pub path: String,
    /// Markdown-ready relative reference from the given note.
    pub markdown_ref: String,
    pub size: f64,
    pub reused: bool,
}

/// A search result across note metadata and bodies.
#[napi(object)]
#[derive(Clone)]
pub struct SearchResult {
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub score: f64,
    pub kind: String,
}

/// A file or folder sitting in the vault trash.
#[napi(object)]
#[derive(Clone)]
pub struct TrashEntry {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub deleted_at: f64,
    pub size: f64,
}

/// An unsaved buffer recovered from a previous session.
#[napi(object)]
#[derive(Clone)]
pub struct RecoveryEntry {
    pub path: String,
    pub content: String,
    pub updated_at: f64,
}

/// Counters shown in the status bar.
#[napi(object)]
#[derive(Clone)]
pub struct VaultStats {
    pub notes: f64,
    pub attachments: f64,
    pub drawings: f64,
    pub tasks: f64,
    pub events: f64,
    pub vault_bytes: f64,
}

/// A vault: a folder on disk plus its SQLite index.
#[napi]
pub struct Vault {
    root: PathBuf,
    db: Db,
}

fn now_ms_i64() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Move the metadata folder of an older build to its current name.
///
/// Vaults created before the rename keep their `.vellum` folder; renaming it
/// in place means existing vaults open with their notes, index and trash
/// intact and no longer need the old name.
fn migrate_legacy_app_dir(root: &std::path::Path) -> Result<()> {
    let legacy = root.join(LEGACY_APP_DIR);
    if !legacy.exists() {
        return Ok(());
    }
    let current = root.join(APP_DIR);
    if current.exists() {
        // Both exist: keep the current one and move the old folder aside so
        // nothing is silently destroyed.
        let stash = root.join(format!("{LEGACY_APP_DIR}.bak"));
        if stash.exists() {
            std::fs::remove_dir_all(&stash).map_err(|e| io_err("clearing old app dir", e))?;
        }
        std::fs::rename(&legacy, &stash).map_err(|e| io_err("moving old app dir aside", e))?;
        return Ok(());
    }
    std::fs::rename(&legacy, &current).map_err(|e| io_err("renaming app dir", e))?;
    Ok(())
}

#[napi]
impl Vault {
    /// Open (or create) a vault rooted at `root`.
    #[napi(constructor)]
    pub fn new(root: String) -> Result<Self> {
        let root_path = PathBuf::from(&root);
        if !root_path.exists() {
            std::fs::create_dir_all(&root_path).map_err(|e| io_err("creating vault folder", e))?;
        }
        if !root_path.is_dir() {
            return Err(to_napi_err("ENOTDIR", "vault path is not a folder"));
        }
        let root_path = root_path
            .canonicalize()
            .map_err(|e| io_err("resolving vault path", e))?;

        migrate_legacy_app_dir(&root_path)?;
        std::fs::create_dir_all(root_path.join(APP_DIR)).map_err(|e| io_err("creating app dir", e))?;
        let db = Db::open(&root_path.join(DB_FILE))?;
        let vault = Vault { root: root_path, db };
        Ok(vault)
    }

    #[napi]
    pub fn root_path(&self) -> String {
        self.root.to_string_lossy().to_string()
    }

    #[napi]
    pub fn info(&self) -> Result<VaultInfo> {
        let notes_count = self.db.all_notes()?.len();
        let tasks_count = self.db.all_tasks()?.len();
        let events_count = self.db.all_events()?.len();
        Ok(VaultInfo {
            path: self.root.to_string_lossy().to_string(),
            name: self
                .root
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "Vault".into()),
            attachments_dir: ATTACHMENTS_DIR.to_string(),
            drawings_dir: DRAWINGS_DIR.to_string(),
            note_count: notes_count as f64,
            task_count: tasks_count as f64,
            event_count: events_count as f64,
            schema_version: self.db.schema_version() as f64,
        })
    }

    // ------------------------------------------------------------------- tree

    /// Flattened file tree, folders first, hidden/app folders excluded.
    #[napi]
    pub fn tree(&self) -> Result<Vec<TreeEntry>> {
        let mut out = Vec::new();
        self.walk_dir(&self.root, 0, &mut out)?;
        Ok(out)
    }

    fn walk_dir(&self, dir: &Path, depth: usize, out: &mut Vec<TreeEntry>) -> Result<()> {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(e) => {
                if e.kind() == std::io::ErrorKind::NotFound {
                    return Ok(());
                }
                return Err(io_err("reading folder", e).into());
            }
        };
        let mut folders: Vec<(String, PathBuf)> = Vec::new();
        let mut files: Vec<(String, PathBuf)> = Vec::new();

        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue; // hidden and app-managed folders stay out of the tree
            }
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                folders.push((name, path));
            } else if file_type.is_file() {
                files.push((name, path));
            }
        }
        folders.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
        files.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));

        for (name, path) in folders {
            let rel = strip_root(&self.root, &path);
            out.push(TreeEntry {
                path: rel.clone(),
                name: name.clone(),
                kind: "folder".into(),
                depth: depth as f64,
                size: 0.0,
                modified: meta_modified(&path) as f64,
                extension: String::new(),
            });
            self.walk_dir(&path, depth + 1, out)?;
        }
        for (name, path) in files {
            let rel = strip_root(&self.root, &path);
            let (size, modified) = meta_size_modified(&path);
            out.push(TreeEntry {
                path: rel,
                name,
                kind: "file".into(),
                depth: depth as f64,
                size: size as f64,
                modified: modified as f64,
                extension: ext_of(&strip_root(&self.root, &path)),
            });
        }
        Ok(())
    }

    // -------------------------------------------------------------- file I/O

    #[napi]
    pub fn read_file(&self, rel: String) -> Result<String> {
        let path = safe_join(&self.root, &rel).map_err(|e| to_napi_err("EPATH", e))?;
        std::fs::read_to_string(&path).map_err(|e| io_err(&format!("reading {}", rel), e).into())
    }

    #[napi]
    pub fn read_bytes(&self, rel: String) -> Result<Buffer> {
        let path = safe_join(&self.root, &rel).map_err(|e| to_napi_err("EPATH", e))?;
        let bytes = std::fs::read(&path)
            .map_err(|e| io_err(&format!("reading {}", rel), e))?;
        Ok(Buffer::from(bytes))
    }

    #[napi]
    pub fn file_exists(&self, rel: String) -> Result<bool> {
        let path = safe_join(&self.root, &rel).map_err(|e| to_napi_err("EPATH", e))?;
        Ok(path.exists())
    }

    /// Write a file atomically and refresh its index entry.
    #[napi]
    pub fn write_file(&self, rel: String, content: String) -> Result<FileStamp> {
        let path = safe_join(&self.root, &rel).map_err(|e| to_napi_err("EPATH", e))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| io_err("creating folder", e))?;
        }
        atomic_write(&path, content.as_bytes()).map_err(|e| io_err(&format!("writing {}", rel), e))?;
        self.index_path(&path, &rel)?;
        Ok(self.stamp_for(&path, &rel))
    }

    /// Create a file, refusing to clobber an existing one.
    #[napi]
    pub fn create_file(&self, rel: String, content: Option<String>) -> Result<FileStamp> {
        let path = safe_join(&self.root, &rel).map_err(|e| to_napi_err("EPATH", e))?;
        if path.exists() {
            return Err(to_napi_err("EEXIST", format!("{} already exists", rel)));
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| io_err("creating folder", e))?;
        }
        atomic_write(&path, content.as_deref().unwrap_or("").as_bytes())
            .map_err(|e| io_err(&format!("creating {}", rel), e))?;
        self.index_path(&path, &rel)?;
        Ok(self.stamp_for(&path, &rel))
    }

    #[napi]
    pub fn create_folder(&self, rel: String) -> Result<bool> {
        let path = safe_join(&self.root, &rel).map_err(|e| to_napi_err("EPATH", e))?;
        if path.exists() {
            return Err(to_napi_err("EEXIST", format!("{} already exists", rel)));
        }
        std::fs::create_dir_all(&path).map_err(|e| io_err(&format!("creating {}", rel), e))?;
        Ok(true)
    }

    /// Rename a file or folder, rewriting references that pointed at it.
    #[napi]
    pub fn rename(&self, rel: String, new_rel: String) -> Result<String> {
        let from = safe_join(&self.root, &rel).map_err(|e| to_napi_err("EPATH", e))?;
        let to = safe_join(&self.root, &new_rel).map_err(|e| to_napi_err("EPATH", e))?;
        if !from.exists() {
            return Err(to_napi_err("ENOENT", format!("{} does not exist", rel)));
        }
        if to.exists() {
            return Err(to_napi_err("EEXIST", format!("{} already exists", new_rel)));
        }
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| io_err("creating folder", e))?;
        }
        std::fs::rename(&from, &to).map_err(|e| io_err(&format!("renaming {} to {}", rel, new_rel), e))?;
        self.after_relocate(&rel, &new_rel)?;
        Ok(new_rel)
    }

    /// Move a file or folder into another folder of the same vault.
    #[napi]
    pub fn move_entry(&self, rel: String, dest_dir: String) -> Result<String> {
        let from = safe_join(&self.root, &rel).map_err(|e| to_napi_err("EPATH", e))?;
        if !from.exists() {
            return Err(to_napi_err("ENOENT", format!("{} does not exist", rel)));
        }
        let dest = safe_join(&self.root, &dest_dir).map_err(|e| to_napi_err("EPATH", e))?;
        if dest.exists() && !dest.is_dir() {
            return Err(to_napi_err("ENOTDIR", format!("{} is not a folder", dest_dir)));
        }
        if dest.starts_with(&from) {
            return Err(to_napi_err("EINVAL", "cannot move a folder into itself"));
        }
        // Create the destination folder when it does not exist yet, so a
        // drag-and-drop into a new location always succeeds.
        if !dest.exists() {
            std::fs::create_dir_all(&dest).map_err(|e| io_err("creating folder", e))?;
        }
        let name = from
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let new_rel = if dest_dir.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", dest_dir.trim_end_matches('/'), name)
        };
        let to = safe_join(&self.root, &new_rel).map_err(|e| to_napi_err("EPATH", e))?;
        if to.exists() {
            return Err(to_napi_err("EEXIST", format!("{} already exists", new_rel)));
        }
        std::fs::rename(&from, &to).map_err(|e| io_err(&format!("moving {} to {}", rel, dest_dir), e))?;
        self.after_relocate(&rel, &new_rel)?;
        Ok(new_rel)
    }

    /// Move an entry to the recoverable vault trash.
    #[napi]
    pub fn delete(&self, rel: String) -> Result<bool> {
        let from = safe_join(&self.root, &rel).map_err(|e| to_napi_err("EPATH", e))?;
        if !from.exists() {
            return Err(to_napi_err("ENOENT", format!("{} does not exist", rel)));
        }
        let name = from
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "entry".into());
        let trash_root = self.root.join(TRASH_DIR);
        std::fs::create_dir_all(&trash_root).map_err(|e| io_err("creating trash", e))?;
        let stamp = now_ms_i64();
        let dest = trash_root.join(format!("{}_{}", stamp, name));
        std::fs::rename(&from, &dest).map_err(|e| io_err(&format!("deleting {}", rel), e))?;

        // Drop the index entries for anything that disappeared.
        let moved_rel = strip_root(&self.root, &dest);
        let affected = if from.is_dir() {
            self.db.notes_for_path(&rel)?
        } else {
            vec![rel.clone()]
        };
        for note_path in affected {
            self.db.purge_path(&note_path)?;
        }
        let _ = moved_rel;
        Ok(true)
    }

    #[napi]
    pub fn list_trash(&self) -> Result<Vec<TrashEntry>> {
        let trash_root = self.root.join(TRASH_DIR);
        let mut out = Vec::new();
        let entries = match std::fs::read_dir(&trash_root) {
            Ok(e) => e,
            Err(_) => return Ok(out),
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            let (size, modified) = meta_size_modified(&path);
            let is_dir = path.is_dir();
            // The timestamp prefix encodes the deletion time.
            let ts = name
                .split('_')
                .next()
                .and_then(|s| s.parse::<i64>().ok())
                .unwrap_or(modified as i64);
            let clean_name = name.split_once('_').map(|(_, n)| n.to_string()).unwrap_or(name);
            out.push(TrashEntry {
                path: clean_name.clone(),
                name: clean_name,
                kind: if is_dir { "folder".into() } else { "file".into() },
                deleted_at: ts as f64,
                size: size as f64,
            });
        }
        out.sort_by(|a, b| b.deleted_at.partial_cmp(&a.deleted_at).unwrap_or(std::cmp::Ordering::Equal));
        Ok(out)
    }

    /// Restore a trashed entry back to the vault root.
    #[napi]
    pub fn restore_from_trash(&self, name: String) -> Result<String> {
        let trash_root = self.root.join(TRASH_DIR);
        let entries = std::fs::read_dir(&trash_root).map_err(|e| io_err("reading trash", e))?;
        let mut found: Option<PathBuf> = None;
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if file_name.ends_with(&format!("_{}", name)) {
                found = Some(entry.path());
                break;
            }
        }
        let found = found.ok_or_else(|| to_napi_err("ENOENT", format!("{} is not in the trash", name)))?;
        let dest = self.root.join(&name);
        if dest.exists() {
            return Err(to_napi_err("EEXIST", format!("{} already exists", name)));
        }
        std::fs::rename(&found, &dest).map_err(|e| io_err("restoring from trash", e))?;
        self.index_path(&dest, &name)?;
        Ok(name)
    }

    #[napi]
    pub fn purge_trash(&self) -> Result<f64> {
        let trash_root = self.root.join(TRASH_DIR);
        let count = std::fs::read_dir(&trash_root)
            .map(|entries| entries.flatten().count())
            .unwrap_or(0);
        if trash_root.exists() {
            std::fs::remove_dir_all(&trash_root).map_err(|e| io_err("emptying trash", e))?;
        }
        Ok(count as f64)
    }

    // ------------------------------------------------------------ attachments

    /// Copy image bytes into the vault attachments folder, de-duplicating by hash.
    #[napi]
    pub fn import_attachment(&self, name: String, bytes: Buffer, from_note: Option<String>) -> Result<AttachmentInfo> {
        let data = bytes.to_vec();
        let ext = sniff_image_extension(&data).map(|e| e.to_string());
        let mut file_name = sanitize_file_name(&name);
        if let Some(ext) = &ext {
            let current = ext_of(&file_name);
            if current.is_empty() {
                file_name = format!("{}.{}", file_name, ext);
            } else if current != *ext {
                file_name = format!("{}.{}", file_name, ext);
            }
        }
        let attachments_root = self.root.join(ATTACHMENTS_DIR);
        std::fs::create_dir_all(&attachments_root).map_err(|e| io_err("creating attachments folder", e))?;

        let hash = hash_bytes(&data);
        // Reuse an identical file that already lives in the vault.
        if let Some(existing) = self.find_attachment_by_hash(&attachments_root, &hash, &file_name) {
            let rel = strip_root(&self.root, &existing);
            return Ok(self.attachment_info(&rel, &data, true, from_note));
        }

        let mut candidate = attachments_root.join(&file_name);
        let mut counter = 1;
        while candidate.exists() {
            let stem = file_stem(&file_name);
            let ext = ext_of(&file_name);
            let next = if ext.is_empty() {
                format!("{}-{}", stem, counter)
            } else {
                format!("{}-{}{}.{}", stem, counter, "", ext)
            };
            candidate = attachments_root.join(next);
            counter += 1;
            if counter > 9999 {
                break;
            }
        }
        atomic_write(&candidate, &data).map_err(|e| io_err("writing attachment", e))?;
        let rel = strip_root(&self.root, &candidate);
        Ok(self.attachment_info(&rel, &data, false, from_note))
    }

    /// Import an image from an absolute path on disk.
    #[napi]
    pub fn import_attachment_from_path(&self, abs_path: String, from_note: Option<String>) -> Result<AttachmentInfo> {
        let src = PathBuf::from(&abs_path);
        let data = std::fs::read(&src)
            .map_err(|e| io_err(&format!("reading {}", abs_path), e))?;
        let name = src
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "image".into());
        self.import_attachment(name, Buffer::from(data), from_note)
    }

    fn find_attachment_by_hash(&self, root: &Path, hash: &str, file_name: &str) -> Option<PathBuf> {
        let entries = std::fs::read_dir(root).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let same_name = path.file_name().map(|s| s.to_string_lossy() == file_name).unwrap_or(false);
            if !same_name {
                continue;
            }
            if let Ok(data) = std::fs::read(&path) {
                if hash_bytes(&data) == hash {
                    return Some(path);
                }
            }
        }
        None
    }

    fn attachment_info(
        &self,
        rel: &str,
        data: &[u8],
        reused: bool,
        from_note: Option<String>,
    ) -> AttachmentInfo {
        let note_dir = from_note
            .map(|p| split_parent(&p).0)
            .unwrap_or_default();
        let markdown_ref = if note_dir.is_empty() {
            encode_md_path(rel)
        } else {
            encode_md_path(&relative_between(&note_dir, rel))
        };
        AttachmentInfo {
            path: rel.to_string(),
            markdown_ref,
            size: data.len() as f64,
            reused,
        }
    }

    #[napi]
    pub fn list_attachments(&self) -> Result<Vec<TreeEntry>> {
        let root = self.root.join(ATTACHMENTS_DIR);
        let mut out = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                let (size, modified) = meta_size_modified(&path);
                let rel = strip_root(&self.root, &path);
                out.push(TreeEntry {
                    path: rel,
                    name: entry.file_name().to_string_lossy().to_string(),
                    kind: "file".into(),
                    depth: 0.0,
                    size: size as f64,
                    modified: modified as f64,
                    extension: ext_of(&strip_root(&self.root, &path)),
                });
            }
        }
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(out)
    }

    // -------------------------------------------------------------- drawings

    /// Drawing files live beside notes as `.excalidraw` scenes.
    #[napi]
    pub fn drawing_path(&self, rel: String) -> Result<String> {
        let rel = if rel.ends_with(".excalidraw") {
            rel
        } else {
            format!("{}.excalidraw", rel)
        };
        let path = safe_join(&self.root, &rel).map_err(|e| to_napi_err("EPATH", e))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| io_err("creating folder", e))?;
        }
        Ok(rel)
    }

    // -------------------------------------------------------------- indexing

    /// Re-index a single file on disk (used after external changes).
    #[napi]
    pub fn index_note(&self, rel: String) -> Result<Option<NoteRecord>> {
        let path = safe_join(&self.root, &rel).map_err(|e| to_napi_err("EPATH", e))?;
        if !path.is_file() {
            self.db.purge_path(&rel)?;
            return Ok(None);
        }
        Ok(Some(self.index_path(&path, &rel)?))
    }

    fn index_path(&self, path: &Path, rel: &str) -> Result<NoteRecord> {
        let metadata = std::fs::metadata(path)?;
        let content = std::fs::read_to_string(path).unwrap_or_default();
        let hash = hash_bytes(content.as_bytes());
        let title = notes::extract_title(rel, &content);
        let tags = notes::extract_tags(&content);
        let excerpt = notes::extract_excerpt(&content, 160);

        let existing = self.db.get_note_by_path(rel)?;
        let created_at = existing
            .as_ref()
            .map(|n| n.created_at)
            .unwrap_or_else(|| now_ms_i64() as f64);

        let record = NoteRecord {
            id: existing.map(|n| n.id).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            path: rel.to_string(),
            title,
            created_at,
            updated_at: now_ms_i64() as f64,
            mtime: metadata_modified_ms(&metadata),
            size: metadata.len() as f64,
            hash,
            tags: tags.clone(),
            is_daily: is_daily_note(rel),
            excerpt,
        };
        self.db.upsert_note(&record)?;

        // Body index for search.
        self.db.index_note_body(rel, &record.title, &content, &tags)?;

        // Link graph.
        let found = notes::extract_links(&content);
        let mut links: Vec<(String, String, String)> = Vec::new();
        for link in found {
            let target_path = self.resolve_link_path(&link.target, rel);
            links.push((target_path, link.target.clone(), link.kind));
        }
        self.db.replace_links(&record.id, &links)?;
        Ok(record)
    }

    /// Every note currently in the index. Reading the index is far cheaper
    /// than opening every file, which matters for large vaults.
    #[napi]
    pub fn list_notes(&self) -> Result<Vec<NoteRecord>> {
        Ok(self.db.all_notes()?)
    }

    /// Rebuild the whole index — used on open and after a bulk import.
    #[napi]
    pub fn reindex_all(&self) -> Result<f64> {
        let mut count = 0f64;
        let mut stack = vec![self.root.clone()];
        while let Some(dir) = stack.pop() {
            let entries = match std::fs::read_dir(&dir) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                if path.is_dir() {
                    stack.push(path);
                } else if path.is_file() && is_markdown(&name) {
                    let rel = strip_root(&self.root, &path);
                    if self.index_path(&path, &rel).is_ok() {
                        count += 1.0;
                    }
                }
            }
        }
        Ok(count)
    }

    /// Compare the on-disk state with the index and report drift.
    #[napi]
    pub fn detect_changes(&self) -> Result<Vec<String>> {
        let mut changed: Vec<String> = Vec::new();
        let indexed = self.db.all_notes()?;
        let mut seen: HashSet<String> = HashSet::new();

        let mut stack = vec![self.root.clone()];
        while let Some(dir) = stack.pop() {
            let entries = match std::fs::read_dir(&dir) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                if path.is_dir() {
                    stack.push(path);
                } else if path.is_file() && is_markdown(&name) {
                    let rel = strip_root(&self.root, &path);
                    seen.insert(rel.clone());
                    let content = std::fs::read_to_string(&path).unwrap_or_default();
                    let hash = hash_bytes(content.as_bytes());
                    let known = indexed.iter().find(|n| n.path == rel);
                    match known {
                        Some(note) if note.hash == hash => {}
                        _ => changed.push(rel),
                    }
                }
            }
        }
        // Files that vanished from disk.
        for note in indexed {
            if !seen.contains(&note.path) {
                changed.push(note.path.clone());
            }
        }
        changed.sort();
        changed.dedup();
        Ok(changed)
    }

    /// Resolve a link target (by name or path) to a vault-relative path.
    #[napi]
    pub fn resolve_link(&self, target: String, from_path: String) -> Result<Option<String>> {
        Ok(Some(self.resolve_link_path(&target, &from_path)))
    }

    fn resolve_link_path(&self, target: &str, from_path: &str) -> String {
        let target = target.trim();
        if target.is_empty() {
            return String::new();
        }
        // Direct path (possibly relative to the linking note).
        if target.contains('/') || target.ends_with(".md") {
            let candidate = if target.starts_with('/') {
                target.trim_start_matches('/').to_string()
            } else {
                let from_dir = split_parent(from_path).0;
                let joined = if from_dir.is_empty() {
                    target.to_string()
                } else {
                    format!("{}/{}", from_dir, target)
                };
                lexical_normalize(Path::new(&joined)).to_string_lossy().to_string()
            };
            if safe_join(&self.root, &candidate).is_ok() {
                let abs = safe_join(&self.root, &candidate).unwrap();
                if abs.exists() {
                    return candidate;
                }
            }
        }
        // Match by file name across the vault.
        let wanted = target.to_lowercase();
        let mut candidates: Vec<String> = Vec::new();
        let mut stack = vec![self.root.clone()];
        while let Some(dir) = stack.pop() {
            let entries = match std::fs::read_dir(&dir) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                if path.is_dir() {
                    stack.push(path);
                } else if path.is_file() {
                    let stem = file_stem(&name).to_lowercase();
                    if stem == wanted || name.to_lowercase() == wanted {
                        candidates.push(strip_root(&self.root, &path));
                    }
                }
            }
        }
        candidates.sort();
        candidates.into_iter().next().unwrap_or_default()
    }

    #[napi]
    pub fn backlinks(&self, rel: String) -> Result<Vec<crate::db::LinkRecord>> {
        let mut out = self.db.backlinks(&rel)?;
        // Include links that resolve to this note by name, not only by path.
        let stem = file_stem(&rel).to_lowercase();
        for note in self.db.all_notes()? {
            if note.path == rel {
                continue;
            }
            let outgoing = self.db.outgoing_links(&note.id)?;
            for link in outgoing {
                if link.target_path.is_empty() && link.target_name.to_lowercase() == stem {
                    out.push(crate::db::LinkRecord {
                        source_id: note.id.clone(),
                        source_path: note.path.clone(),
                        target_path: rel.clone(),
                        target_name: link.target_name.clone(),
                        kind: link.kind.clone(),
                    });
                }
            }
        }
        out.sort_by(|a, b| a.source_path.cmp(&b.source_path));
        out.dedup_by(|a, b| a.source_path == b.source_path && a.kind == b.kind);
        Ok(out)
    }

    // -------------------------------------------------------------- knowledge graph

    /// The knowledge graph of the vault: every indexed note is a node, every
    /// link between notes is an edge.
    #[napi]
    pub fn knowledge_graph(&self) -> Result<crate::db::GraphData> {
        Ok(self.db.knowledge_graph()?)
    }

    // -------------------------------------------------------------- searching

    #[napi]
    pub fn search_notes(&self, query: String, limit: Option<f64>) -> Result<Vec<SearchResult>> {
        let limit = limit.unwrap_or(50.0).max(1.0) as usize;
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        let mut results: Vec<SearchResult> = Vec::new();
        let lowered = trimmed.to_lowercase();

        // Title / tag matches.
        for note in self.db.all_notes()? {
            let title_hit = note.title.to_lowercase().contains(&lowered);
            let tag_hit = note.tags.iter().any(|t| t.to_lowercase().contains(&lowered));
            if title_hit || tag_hit {
                results.push(SearchResult {
                    path: note.path.clone(),
                    title: note.title.clone(),
                    snippet: if tag_hit && !title_hit {
                        format!("tag: {}", note.tags.join(", "))
                    } else {
                        note.excerpt.clone()
                    },
                    score: if title_hit { 2.0 } else { 1.5 },
                    kind: "note".into(),
                });
            }
        }

        // Body matches via FTS.
        if let Ok(hits) = self.db.search_fts(trimmed, limit) {
            for hit in hits {
                if let Some(note) = self.db.get_note_by_path(&hit.path)? {
                    results.push(SearchResult {
                        path: hit.path,
                        title: note.title,
                        snippet: hit.snippet.replace('\u{1}', "").replace('\u{2}', " "),
                        score: 1.0 + hit.score.min(1.0),
                        kind: "note".into(),
                    });
                }
            }
        }

        // Task matches.
        for task in self.db.all_tasks()? {
            if task.title.to_lowercase().contains(&lowered) {
                results.push(SearchResult {
                    path: String::new(),
                    title: task.title.clone(),
                    snippet: format!("task · {}", task.status),
                    score: 1.2,
                    kind: "task".into(),
                });
            }
        }
        // Event matches.
        for event in self.db.all_events()? {
            if event.title.to_lowercase().contains(&lowered) {
                results.push(SearchResult {
                    path: String::new(),
                    title: event.title.clone(),
                    snippet: "event".into(),
                    score: 1.2,
                    kind: "event".into(),
                });
            }
        }

        results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        results.truncate(limit);
        Ok(results)
    }

    /// Notes carrying a given tag.
    #[napi]
    pub fn notes_by_tag(&self, tag: String) -> Result<Vec<NoteRecord>> {
        let wanted = tag.trim_start_matches('#').to_lowercase();
        Ok(self
            .db
            .all_notes()?
            .into_iter()
            .filter(|n| n.tags.iter().any(|t| t.to_lowercase() == wanted))
            .collect())
    }

    #[napi]
    pub fn all_tags(&self) -> Result<Vec<String>> {
        let mut counts: HashMap<String, f64> = HashMap::new();
        for note in self.db.all_notes()? {
            for tag in note.tags {
                *counts.entry(tag).or_insert(0.0) += 1.0;
            }
        }
        let mut out: Vec<(String, f64)> = counts.into_iter().collect();
        out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
        Ok(out.into_iter().map(|(t, _)| t).collect())
    }

    // ---------------------------------------------------------------- daily

    /// Path of the daily note for a date, creating it when asked.
    #[napi]
    pub fn daily_note(&self, date: String, create: Option<bool>) -> Result<String> {
        let rel = format!("Daily/{}.md", date.trim());
        let path = safe_join(&self.root, &rel).map_err(|e| to_napi_err("EPATH", e))?;
        if !path.exists() && create.unwrap_or(false) {
            let title = format!("# {}\n", date.trim());
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| io_err("creating folder", e))?;
            }
            atomic_write(&path, title.as_bytes()).map_err(|e| io_err("creating daily note", e))?;
            self.index_path(&path, &rel)?;
        }
        Ok(rel)
    }

    // -------------------------------------------------------------- recovery

    #[napi]
    pub fn save_recovery(&self, rel: String, content: String) -> Result<bool> {
        let hash = self
            .db
            .get_note_by_path(&rel)?
            .map(|n| n.hash)
            .unwrap_or_default();
        self.db.save_recovery(&rel, &content, Some(&hash))?;
        Ok(true)
    }

    #[napi]
    pub fn load_recovery(&self) -> Result<Vec<RecoveryEntry>> {
        let mut out = Vec::new();
        for (path, content) in self.db.recovery_entries()? {
            out.push(RecoveryEntry {
                path,
                content,
                updated_at: now_ms_i64() as f64,
            });
        }
        Ok(out)
    }

    #[napi]
    pub fn clear_recovery(&self, rel: String) -> Result<bool> {
        self.db.clear_recovery(&rel)?;
        Ok(true)
    }

    #[napi]
    pub fn clear_all_recovery(&self) -> Result<bool> {
        self.db.clear_all_recovery()?;
        Ok(true)
    }

    // ----------------------------------------------------------------- tasks

    #[napi]
    pub fn list_tasks(&self) -> Result<Vec<TaskRecord>> {
        Ok(self.db.all_tasks()?)
    }

    #[napi]
    pub fn get_task(&self, id: String) -> Result<Option<TaskRecord>> {
        Ok(self.db.get_task(&id)?)
    }

    #[napi]
    pub fn save_task(&self, task: TaskRecord) -> Result<TaskRecord> {
        let mut task = task;
        if task.id.is_empty() {
            task.id = uuid::Uuid::new_v4().to_string();
        }
        if task.created_at <= 0.0 {
            task.created_at = now_ms_i64() as f64;
        }
        task.updated_at = now_ms_i64() as f64;
        if task.status == "done" && task.completed_at.is_none() {
            task.completed_at = Some(now_ms_i64() as f64);
        }
        if task.status != "done" {
            task.completed_at = None;
        }
        self.db.upsert_task(&task)?;
        Ok(task)
    }

    #[napi]
    pub fn delete_task(&self, id: String) -> Result<bool> {
        self.db.delete_task(&id)?;
        Ok(true)
    }

    // ---------------------------------------------------------------- events

    #[napi]
    pub fn list_events(&self) -> Result<Vec<EventRecord>> {
        Ok(self.db.all_events()?)
    }

    #[napi]
    pub fn get_event(&self, id: String) -> Result<Option<EventRecord>> {
        Ok(self.db.get_event(&id)?)
    }

    #[napi]
    pub fn save_event(&self, event: EventRecord) -> Result<EventRecord> {
        let mut event = event;
        if event.id.is_empty() {
            event.id = uuid::Uuid::new_v4().to_string();
        }
        if event.created_at <= 0.0 {
            event.created_at = now_ms_i64() as f64;
        }
        event.updated_at = now_ms_i64() as f64;
        self.db.upsert_event(&event)?;
        Ok(event)
    }

    #[napi]
    pub fn delete_event(&self, id: String) -> Result<bool> {
        self.db.delete_event(&id)?;
        Ok(true)
    }

    // --------------------------------------------------------------- settings

    #[napi]
    pub fn get_setting(&self, key: String) -> Result<Option<String>> {
        Ok(self.db.get_setting(&key)?)
    }

    #[napi]
    pub fn set_setting(&self, key: String, value: String) -> Result<bool> {
        self.db.set_setting(&key, &value)?;
        Ok(true)
    }

    #[napi]
    pub fn all_settings(&self) -> Result<HashMap<String, String>> {
        Ok(self.db.all_settings()?.into_iter().collect())
    }

    // ------------------------------------------------------------------ stats

    #[napi]
    pub fn stats(&self) -> Result<VaultStats> {
        let notes = self.db.all_notes()?.len();
        let tasks = self.db.all_tasks()?.len();
        let events = self.db.all_events()?.len();
        let attachments = self.list_attachments()?.len();
        let drawings = self.count_drawings()?;
        let bytes = self.dir_size(&self.root, 0);
        Ok(VaultStats {
            notes: notes as f64,
            attachments: attachments as f64,
            drawings: drawings as f64,
            tasks: tasks as f64,
            events: events as f64,
            vault_bytes: bytes as f64,
        })
    }

    #[napi]
    pub fn touch_recent(&self, rel: String) -> Result<bool> {
        self.db.touch_recent(&rel)?;
        Ok(true)
    }

    #[napi]
    pub fn recent_paths(&self, limit: Option<f64>) -> Result<Vec<String>> {
        Ok(self.db.recent_paths(limit.unwrap_or(20.0) as usize)?)
    }

    // ------------------------------------------------------------- internals

    fn count_drawings(&self) -> Result<usize> {
        let mut count = 0usize;
        let mut stack = vec![self.root.clone()];
        while let Some(dir) = stack.pop() {
            let entries = match std::fs::read_dir(&dir) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                if path.is_dir() {
                    stack.push(path);
                } else if name.ends_with(".excalidraw") {
                    count += 1;
                }
            }
        }
        Ok(count)
    }

    fn dir_size(&self, dir: &Path, depth: usize) -> u64 {
        if depth > 12 {
            return 0;
        }
        let mut total = 0u64;
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    total += self.dir_size(&path, depth + 1);
                } else if let Ok(meta) = path.metadata() {
                    total += meta.len();
                }
            }
        }
        total
    }

    fn stamp_for(&self, path: &Path, rel: &str) -> FileStamp {
        let (size, modified) = meta_size_modified(path);
        let hash = std::fs::read(path)
            .map(|d| hash_bytes(&d))
            .unwrap_or_default();
        FileStamp {
            path: rel.to_string(),
            size: size as f64,
            modified: modified as f64,
            hash,
        }
    }

    /// After a rename or move, refresh indexes and repair references.
    fn after_relocate(&self, old_rel: &str, new_rel: &str) -> Result<()> {
        let old_abs = safe_join(&self.root, old_rel).map_err(|e| to_napi_err("EPATH", e))?;

        // Collect the moved notes before the index knows about the new path.
        let moved: Vec<String> = if old_abs.is_dir() {
            self.db.notes_for_path(old_rel)?
        } else if is_markdown(old_rel) {
            vec![old_rel.to_string()]
        } else {
            Vec::new()
        };

        // Re-index moved markdown files under their new paths.
        for old_path in moved {
            let suffix = old_path
                .strip_prefix(old_rel)
                .map(|s| s.trim_start_matches('/').to_string())
                .unwrap_or_default();
            let new_path = if suffix.is_empty() {
                new_rel.to_string()
            } else {
                format!("{}/{}", new_rel, suffix)
            };
            let abs = safe_join(&self.root, &new_path).map_err(|e| to_napi_err("EPATH", e))?;
            if abs.is_file() {
                self.db.purge_path(&old_path)?;
                self.index_path(&abs, &new_path)?;
            }
        }

        self.rewrite_references(old_rel, new_rel)?;
        Ok(())
    }

    /// Rewrite links across the vault that referenced the moved/renamed entry.
    fn rewrite_references(&self, old_rel: &str, new_rel: &str) -> Result<()> {
        let old_stem = file_stem(old_rel);
        let new_stem = file_stem(new_rel);
        let notes = self.db.all_notes()?;
        for note in notes {
            let abs = match safe_join(&self.root, &note.path) {
                Ok(p) => p,
                Err(_) => continue,
            };
            let content = match std::fs::read_to_string(&abs) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let updated = self.rewrite_note_content(&content, &note.path, old_rel, new_rel, &old_stem, &new_stem);
            if updated != content {
                atomic_write(&abs, updated.as_bytes())
                    .map_err(|e| io_err("updating references", e))?;
                self.index_path(&abs, &note.path)?;
            }
        }
        Ok(())
    }

    /// Rewrite links inside a single note body.
    pub fn rewrite_note_content(
        &self,
        content: &str,
        note_path: &str,
        old_rel: &str,
        new_rel: &str,
        old_stem: &str,
        new_stem: &str,
    ) -> String {
        let note_dir = split_parent(note_path).0;
        let mut out = content.to_string();

        // 1. Markdown links whose target resolved to the moved entry.
        let old_stem_l = old_stem.to_lowercase();
        let new_stem_l = new_stem.to_lowercase();
        let re_md = crate::notes::markdown_link_regex();
        out = re_md
            .replace_all(&out, |caps: &regex::Captures| {
                let whole = caps.get(0).map(|m| m.as_str()).unwrap_or("");
                let label = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                let href = caps.get(2).map(|m| m.as_str()).unwrap_or("");
                if href.starts_with("http") || href.starts_with("data:") || href.starts_with('#') {
                    return whole.to_string();
                }
                let decoded = notes::percent_decode(href);
                let target_name = file_stem(&decoded).to_lowercase();
                // Match either the exact previous path or the previous file name.
                let matches_exact = decoded.trim_start_matches('/') == old_rel.trim_start_matches('/');
                if target_name != old_stem_l && !matches_exact {
                    return whole.to_string();
                }
                // Rebuild the reference relative to the linking note.
                let new_target_rel = if decoded.contains('/') {
                    relative_between(&note_dir, new_rel)
                } else {
                    file_stem(new_rel)
                };
                format!("[{}]({})", label, encode_md_path(&new_target_rel))
            })
            .into_owned();

        // 2. Wikilinks pointing at the old name.
        if !old_stem_l.is_empty() && old_stem_l != new_stem_l {
            let re_wiki = crate::notes::wikilink_regex();
            out = re_wiki
                .replace_all(&out, |caps: &regex::Captures| {
                    let whole = caps.get(0).map(|m| m.as_str()).unwrap_or("");
                    let inner = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                    let bang = whole.starts_with('!');
                    let target = inner.split('|').next().unwrap_or(inner).trim();
                    let alias = inner.split_once('|').map(|(_, a)| a.to_string());
                    let heading = inner.split_once('#').map(|(_, h)| h.to_string());
                    if target.to_lowercase() != old_stem_l {
                        return whole.to_string();
                    }
                    let mut rebuilt = String::new();
                    if bang {
                        rebuilt.push('!');
                    }
                    rebuilt.push_str("[[");
                    rebuilt.push_str(&new_stem);
                    if let Some(h) = heading {
                        rebuilt.push('#');
                        rebuilt.push_str(&h);
                    }
                    if let Some(a) = alias {
                        rebuilt.push('|');
                        rebuilt.push_str(&a);
                    }
                    rebuilt.push_str("]]");
                    rebuilt
                })
                .into_owned();
        }
        out
    }

    /// Repair relative links inside a note that itself was moved.
    #[napi]
    pub fn rebase_note_links(&self, rel: String) -> Result<bool> {
        let path = safe_join(&self.root, &rel).map_err(|e| to_napi_err("EPATH", e))?;
        let content = std::fs::read_to_string(&path).map_err(|e| io_err("reading note", e))?;
        let dir = split_parent(&rel).0;
        let re_md = crate::notes::markdown_link_regex();
        let updated = re_md
            .replace_all(&content, |caps: &regex::Captures| {
                let whole = caps.get(0).map(|m| m.as_str()).unwrap_or("");
                let label = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                let href = caps.get(2).map(|m| m.as_str()).unwrap_or("");
                if href.starts_with("http") || href.starts_with("data:") || href.starts_with('#') {
                    return whole.to_string();
                }
                let decoded = notes::percent_decode(href);
                if decoded.starts_with('/') {
                    return whole.to_string();
                }
                // Resolve against the vault root, then re-base onto the new folder.
                let resolved = lexical_normalize(Path::new(&decoded)).to_string_lossy().to_string();
                let rebased = if resolved.starts_with(&format!("{}/", dir)) {
                    decoded.clone()
                } else {
                    relative_between(&dir, &resolved)
                };
                format!("[{}]({})", label, encode_md_path(&rebased))
            })
            .into_owned();
        if updated != content {
            atomic_write(&path, updated.as_bytes()).map_err(|e| io_err("updating note", e))?;
            self.index_path(&path, &rel)?;
        }
        Ok(true)
    }

    /// Verify that a path is inside the vault — used before destructive ops.
    #[napi]
    pub fn is_inside_vault(&self, abs_path: String) -> Result<bool> {
        Ok(is_inside(&self.root, Path::new(&abs_path)))
    }

    /// Resolve a vault-relative path to an absolute one (for the browser).
    #[napi]
    pub fn absolute_path(&self, rel: String) -> Result<String> {
        let path = safe_join(&self.root, &rel).map_err(|e| to_napi_err("EPATH", e))?;
        Ok(path.to_string_lossy().to_string())
    }
}

fn meta_modified(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn meta_size_modified(path: &Path) -> (u64, u64) {
    match std::fs::metadata(path) {
        Ok(m) => {
            let modified = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            (m.len(), modified)
        }
        Err(_) => (0, 0),
    }
}

fn metadata_modified_ms(metadata: &std::fs::Metadata) -> f64 {
    metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

fn is_markdown(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

/// A daily note is one whose file name parses as a date.
fn is_daily_note(rel: &str) -> bool {
    let stem = file_stem(rel);
    let parts: Vec<&str> = stem.split('-').collect();
    parts.len() == 3
        && parts[0].len() == 4
        && parts.iter().all(|p| p.chars().all(|c| c.is_ascii_digit()))
        && parts[0].parse::<u32>().map(|y| (1900..=2999).contains(&y)).unwrap_or(false)
        && parts[1].parse::<u32>().map(|m| (1..=12).contains(&m)).unwrap_or(false)
        && parts[2].parse::<u32>().map(|d| (1..=31).contains(&d)).unwrap_or(false)
}

/// Helper used by the JS layer to create an empty vault in a temp folder.
#[napi]
pub fn default_vault_name() -> String {
    "Delta Vault".to_string()
}

/// Sanitise a user-supplied note name into a file name.
#[napi]
pub fn sanitize_note_name(name: String) -> String {
    let cleaned = sanitize_file_name(&name);
    if cleaned.to_lowercase().ends_with(".md") {
        cleaned
    } else {
        format!("{}.md", cleaned)
    }
}

/// Ensure the attachments folder exists and return its relative path.
#[napi]
pub fn ensure_attachments_dir(root: String) -> Result<String> {
    let path = PathBuf::from(&root).join(ATTACHMENTS_DIR);
    std::fs::create_dir_all(&path).map_err(|e| io_err("creating attachments folder", e))?;
    Ok(ATTACHMENTS_DIR.to_string())
}

