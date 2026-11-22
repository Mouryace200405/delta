//! Delta core — the Rust engine behind the desktop app.
//!
//! Responsibilities:
//! * vault filesystem access (notes, attachments, drawings) with atomic writes
//! * a local SQLite store for tasks, events, settings and the search index
//! * filesystem watching so external edits are detected, never overwritten
//! * iCalendar import/export and zip backups
//! * local speech synthesis through Piper
//! * GitHub synchronisation of the vault, with Git LFS for large files

pub mod backup;
pub mod db;
pub mod error;
pub mod ics;
pub mod notes;
pub mod sync;
pub mod tts;
pub mod util;
pub mod vault;
pub mod watcher;

pub use backup::{create_backup, list_backups, restore_backup, BackupInfo};
pub use db::{EventRecord, GraphData, GraphEdge, GraphNode, LinkRecord, NoteRecord, TaskRecord};
pub use sync::{SyncResult, SyncStatus};
pub use tts::{TtsStatus, TtsVoice};
pub use vault::{AttachmentInfo, RecoveryEntry, SearchResult, TrashEntry, TreeEntry, Vault, VaultInfo, VaultStats};
pub use watcher::{FileWatcher, WatchEvent};

use napi_derive::napi;

/// Export events as an iCalendar document.
#[napi]
pub fn export_calendar(events: Vec<EventRecord>, calendar_name: String) -> String {
    ics::export_ics(&events, &calendar_name)
}

/// Import an iCalendar document into event records.
#[napi]
pub fn import_calendar(text: String) -> Vec<EventRecord> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    ics::parsed_to_records(ics::parse_ics(&text), now)
}

/// Sanitise a note name into a safe `.md` file name.
#[napi]
pub fn sanitize_note_name(name: String) -> String {
    vault::sanitize_note_name(name)
}

/// Percent-encode a path for use inside a Markdown reference.
#[napi]
pub fn encode_markdown_path(path: String) -> String {
    util::encode_md_path(&path)
}

/// Human-readable byte size, used by the status bar.
#[napi]
pub fn human_size(bytes: f64) -> String {
    util::human_size(bytes as u64)
}

/// Version of the native core, surfaced in the About dialog.
#[napi]
pub fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
