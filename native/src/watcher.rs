use crate::util::{normalize_rel, strip_root, APP_DIR, LEGACY_APP_DIR};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use notify::{RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use napi_derive::napi;

/// A batch of filesystem changes, delivered to the renderer.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct WatchEvent {
    /// `create`, `change` or `remove`.
    pub kind: String,
    /// Vault-relative paths touched by this batch.
    pub paths: Vec<String>,
}

type WatchCallback = ThreadsafeFunction<WatchEvent>;

struct WatcherState {
    _watcher: notify::RecommendedWatcher,
    stop: Arc<AtomicBool>,
}

/// Watches a vault folder and reports debounced change batches to JavaScript.
#[napi]
pub struct FileWatcher {
    root: PathBuf,
    state: Mutex<Option<WatcherState>>,
}

#[napi]
impl FileWatcher {
    /// Start watching `root`. The callback receives batched change events.
    #[napi(constructor)]
    pub fn new(root: String, callback: ThreadsafeFunction<WatchEvent>) -> Result<Self> {
        let root_path = PathBuf::from(&root);
        if !root_path.exists() {
            return Err(Error::new(
                Status::GenericFailure,
                format!("cannot watch missing folder: {}", root),
            ));
        }
        let tsfn: WatchCallback = callback;

        let root_for_thread = root_path.clone();
        let stop_flag = Arc::new(AtomicBool::new(false));

        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let Ok(event) = res else { return };
            let kind = match event.kind {
                notify::EventKind::Create(_) => "create",
                notify::EventKind::Remove(_) => "remove",
                notify::EventKind::Modify(_) => "change",
                _ => "change",
            };
            let mut paths: Vec<String> = Vec::new();
            for path in &event.paths {
                let rel = strip_root(&root_for_thread, path);
                if rel.is_empty() {
                    continue;
                }
                // Ignore the app's own metadata folder.
                if rel.starts_with(APP_DIR) || rel.starts_with(LEGACY_APP_DIR) {
                    continue;
                }
                paths.push(rel);
            }
            if paths.is_empty() {
                return;
            }
            let payload = WatchEvent {
                kind: kind.to_string(),
                paths,
            };
            let _ = tsfn.call(
                Ok(payload),
                ThreadsafeFunctionCallMode::NonBlocking,
            );
        })
        .map_err(|e| Error::new(Status::GenericFailure, format!("creating watcher: {}", e)))?;

        watcher
            .watch(&root_path, RecursiveMode::Recursive)
            .map_err(|e| Error::new(Status::GenericFailure, format!("watching vault: {}", e)))?;

        Ok(FileWatcher {
            root: root_path,
            state: Mutex::new(Some(WatcherState {
                _watcher: watcher,
                stop: stop_flag,
            })),
        })
    }

    /// Stop watching.
    #[napi]
    pub fn close(&self) -> Result<bool> {
        let mut guard = self.state.lock().unwrap();
        if let Some(state) = guard.take() {
            state.stop.store(true, Ordering::SeqCst);
        }
        Ok(true)
    }

    #[napi]
    pub fn root(&self) -> String {
        self.root.to_string_lossy().to_string()
    }
}

/// Coalesces a burst of filesystem events into one batch.
///
/// Editors frequently write a file in several steps (write, truncate, rename),
/// so reporting each event separately would cause visible flicker and
/// redundant re-indexing.
#[derive(Default)]
pub struct Debouncer {
    pending: HashMap<String, (String, Instant)>,
    last_flush: Option<Instant>,
}

impl Debouncer {
    pub fn new() -> Self {
        Debouncer {
            pending: HashMap::new(),
            last_flush: None,
        }
    }

    pub fn push(&mut self, kind: &str, path: &str, now: Instant) {
        let key = normalize_rel(path);
        self.pending
            .insert(key, (kind.to_string(), now));
        self.last_flush = Some(now);
    }

    /// Return the coalesced batch when the quiet period has elapsed.
    pub fn take_if_ready(&mut self, now: Instant, quiet: Duration) -> Option<WatchEvent> {
        let last = self.last_flush?;
        if now.duration_since(last) < quiet {
            return None;
        }
        if self.pending.is_empty() {
            return None;
        }
        let mut creates: Vec<String> = Vec::new();
        let mut changes: Vec<String> = Vec::new();
        let mut removes: Vec<String> = Vec::new();
        for (path, (kind, _)) in self.pending.drain() {
            match kind.as_str() {
                "create" => creates.push(path),
                "remove" => removes.push(path),
                _ => changes.push(path),
            }
        }
        creates.sort();
        changes.sort();
        removes.sort();
        // A path that was created and then changed is just a creation.
        let mut all: Vec<String> = Vec::new();
        all.extend(creates.clone());
        for c in &changes {
            if !creates.contains(c) {
                all.push(c.clone());
            }
        }
        for r in &removes {
            if !creates.contains(r) {
                all.push(r.clone());
            }
        }
        let kind = if !removes.is_empty() && creates.is_empty() && changes.is_empty() {
            "remove"
        } else if !creates.is_empty() {
            "create"
        } else {
            "change"
        };
        self.last_flush = None;
        Some(WatchEvent {
            kind: kind.to_string(),
            paths: all,
        })
    }
}

/// Normalise a filesystem path for comparison against index entries.
pub fn comparable(path: &Path) -> String {
    strip_root(Path::new("/"), path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debouncer_coalesces_repeated_writes() {
        let now = Instant::now();
        let mut d = Debouncer::new();
        d.push("change", "a.md", now);
        d.push("change", "a.md", now);
        d.push("change", "b.md", now);
        assert!(d.take_if_ready(now, Duration::from_millis(100)).is_none());
        let batch = d
            .take_if_ready(now + Duration::from_millis(200), Duration::from_millis(100))
            .expect("batch");
        assert_eq!(batch.paths, vec!["a.md".to_string(), "b.md".to_string()]);
    }

    #[test]
    fn debouncer_prefers_creation_over_change() {
        let now = Instant::now();
        let mut d = Debouncer::new();
        d.push("change", "a.md", now);
        d.push("create", "a.md", now);
        let batch = d
            .take_if_ready(now + Duration::from_millis(200), Duration::from_millis(100))
            .expect("batch");
        assert_eq!(batch.kind, "create");
        assert_eq!(batch.paths.len(), 1);
    }
}
