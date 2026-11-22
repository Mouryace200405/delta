use crate::error::AnyError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use napi_derive::napi;

/// Result type used across the persistence layer.
pub type DbResult<T> = std::result::Result<T, AnyError>;

/// Current schema version. Bump and add a migration when the shape changes.
pub const SCHEMA_VERSION: i64 = 3;

const MIGRATIONS: &[&str] = &[
    // v1 — core tables
    r#"
    CREATE TABLE IF NOT EXISTS settings (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        updated_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notes (
        id          TEXT PRIMARY KEY,
        path        TEXT NOT NULL UNIQUE,
        title       TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        mtime       INTEGER NOT NULL,
        size        INTEGER NOT NULL,
        hash        TEXT NOT NULL,
        tags        TEXT NOT NULL DEFAULT '[]',
        is_daily    INTEGER NOT NULL DEFAULT 0,
        excerpt     TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_notes_title   ON notes(title);
    CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at);
    CREATE INDEX IF NOT EXISTS idx_notes_path    ON notes(path);

    CREATE TABLE IF NOT EXISTS tasks (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        description     TEXT NOT NULL DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'todo',
        priority        TEXT NOT NULL DEFAULT 'none',
        due_date        TEXT,
        start_time      TEXT,
        end_time        TEXT,
        duration_minutes INTEGER,
        timezone        TEXT NOT NULL DEFAULT 'local',
        note_id         TEXT,
        event_id        TEXT,
        recurrence      TEXT,
        completed_at    INTEGER,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_due    ON tasks(due_date);
    CREATE INDEX IF NOT EXISTS idx_tasks_note   ON tasks(note_id);

    CREATE TABLE IF NOT EXISTS events (
        id           TEXT PRIMARY KEY,
        title        TEXT NOT NULL,
        description  TEXT NOT NULL DEFAULT '',
        start_utc    INTEGER NOT NULL,
        end_utc      INTEGER NOT NULL,
        all_day      INTEGER NOT NULL DEFAULT 0,
        timezone     TEXT NOT NULL DEFAULT 'local',
        rrule        TEXT,
        exdates      TEXT NOT NULL DEFAULT '[]',
        color        TEXT,
        location     TEXT,
        note_id      TEXT,
        task_id      TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_utc);

    CREATE TABLE IF NOT EXISTS links (
        source_id   TEXT NOT NULL,
        target_path TEXT NOT NULL,
        target_name TEXT NOT NULL,
        kind        TEXT NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (source_id, target_path, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_path);

    CREATE TABLE IF NOT EXISTS recovery (
        path        TEXT PRIMARY KEY,
        content     TEXT NOT NULL,
        base_hash   TEXT,
        updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recent (
        path       TEXT PRIMARY KEY,
        opened_at  INTEGER NOT NULL
    );
    "#,
    // v2 — full-text search index for note bodies
    r#"
    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        path UNINDEXED,
        title,
        body,
        tags,
        tokenize = 'unicode61 remove_diacritics 2'
    );
    "#,
    // v3 — tag index for fast filtering
    r#"
    CREATE TABLE IF NOT EXISTS note_tags (
        note_id TEXT NOT NULL,
        tag     TEXT NOT NULL,
        PRIMARY KEY (note_id, tag)
    );
    CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag);
    "#,
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[napi(object)]
pub struct NoteRecord {
    pub id: String,
    pub path: String,
    pub title: String,
    pub created_at: f64,
    pub updated_at: f64,
    pub mtime: f64,
    pub size: f64,
    pub hash: String,
    pub tags: Vec<String>,
    pub is_daily: bool,
    pub excerpt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[napi(object)]
pub struct TaskRecord {
    pub id: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub priority: String,
    pub due_date: Option<String>,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub duration_minutes: Option<f64>,
    pub timezone: String,
    pub note_id: Option<String>,
    pub event_id: Option<String>,
    pub recurrence: Option<String>,
    pub completed_at: Option<f64>,
    pub created_at: f64,
    pub updated_at: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[napi(object)]
pub struct EventRecord {
    pub id: String,
    pub title: String,
    pub description: String,
    pub start_utc: f64,
    pub end_utc: f64,
    pub all_day: bool,
    pub timezone: String,
    pub rrule: Option<String>,
    pub exdates: Vec<String>,
    pub color: Option<String>,
    pub location: Option<String>,
    pub note_id: Option<String>,
    pub task_id: Option<String>,
    pub created_at: f64,
    pub updated_at: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[napi(object)]
pub struct LinkRecord {
    pub source_id: String,
    pub source_path: String,
    pub target_path: String,
    pub target_name: String,
    pub kind: String,
}

/// One node of the knowledge graph: a note, or a link target that has no note
/// behind it yet.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[napi(object)]
pub struct GraphNode {
    /// Stable identifier — the note's vault-relative path.
    pub id: String,
    pub path: String,
    pub title: String,
    /// Number of links leaving this node.
    pub links: f64,
    /// Number of links pointing at this node.
    pub backlinks: f64,
    /// True when the node is a link target with no note behind it.
    pub missing: bool,
}

/// A directed link between two graph nodes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[napi(object)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    /// `wikilink` or `markdown`.
    pub kind: String,
}

/// The whole knowledge graph of a vault.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[napi(object)]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Thin wrapper over the vault-local SQLite database.
pub struct Db {
    conn: Connection,
}

impl Db {
    pub fn open(path: &Path) -> DbResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AnyError(anyhow::anyhow!("creating database directory: {}", e)))?;
        }
        let conn = Connection::open(path)
            .map_err(|e| AnyError(anyhow::anyhow!("opening database at {}: {}", path.display(), e)))?;
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.pragma_update(None, "synchronous", "NORMAL").ok();
        conn.pragma_update(None, "foreign_keys", "ON").ok();
        conn.pragma_update(None, "busy_timeout", 5000).ok();
        let mut db = Db { conn };
        db.migrate()?;
        Ok(db)
    }

    /// Apply any migrations the database has not yet seen.
    pub fn migrate(&mut self) -> DbResult<()> {
        let current: i64 =
            self.conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if current >= SCHEMA_VERSION {
            return Ok(());
        }
        let tx = self.conn.transaction()?;
        for (idx, sql) in MIGRATIONS.iter().enumerate() {
            let version = idx as i64 + 1;
            if version <= current {
                continue;
            }
            tx.execute_batch(sql)
                .map_err(|e| AnyError(anyhow::anyhow!("applying migration v{}: {}", version, e)))?;
        }
        tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        tx.commit()?;
        Ok(())
    }

    pub fn schema_version(&self) -> i64 {
        self.conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap_or(0)
    }

    // ---------------------------------------------------------------- settings

    pub fn set_setting(&self, key: &str, value: &str) -> DbResult<()> {
        self.conn.execute(
            "INSERT INTO settings(key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, now_ms()],
        )?;
        Ok(())
    }

    pub fn get_setting(&self, key: &str) -> DbResult<Option<String>> {
        let v: Option<String> = self
            .conn
            .query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0))
            .optional()?;
        Ok(v)
    }

    pub fn all_settings(&self) -> DbResult<Vec<(String, String)>> {
        let mut stmt = self.conn.prepare("SELECT key, value FROM settings")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn delete_setting(&self, key: &str) -> DbResult<()> {
        self.conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
        Ok(())
    }

    // ------------------------------------------------------------------- notes

    pub fn upsert_note(&self, note: &NoteRecord) -> DbResult<()> {
        let tags_json = serde_json::to_string(&note.tags)?;
        self.conn.execute(
            "INSERT INTO notes(id, path, title, created_at, updated_at, mtime, size, hash, tags, is_daily, excerpt)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
             ON CONFLICT(path) DO UPDATE SET
               title = excluded.title,
               updated_at = excluded.updated_at,
               mtime = excluded.mtime,
               size = excluded.size,
               hash = excluded.hash,
               tags = excluded.tags,
               is_daily = excluded.is_daily,
               excerpt = excluded.excerpt",
            params![
                note.id,
                note.path,
                note.title,
                note.created_at as i64,
                note.updated_at as i64,
                note.mtime as i64,
                note.size as i64,
                note.hash,
                tags_json,
                if note.is_daily { 1 } else { 0 },
                note.excerpt,
            ],
        )?;
        self.conn.execute("DELETE FROM note_tags WHERE note_id = ?1", params![note.id])?;
        for tag in &note.tags {
            self.conn.execute(
                "INSERT OR IGNORE INTO note_tags(note_id, tag) VALUES (?1, ?2)",
                params![note.id, tag],
            )?;
        }
        Ok(())
    }

    pub fn get_note_by_path(&self, path: &str) -> DbResult<Option<NoteRecord>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, path, title, created_at, updated_at, mtime, size, hash, tags, is_daily, excerpt
             FROM notes WHERE path = ?1",
        )?;
        let mut rows = stmt.query(params![path])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row_to_note(row)?))
        } else {
            Ok(None)
        }
    }

    pub fn get_note_by_id(&self, id: &str) -> DbResult<Option<NoteRecord>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, path, title, created_at, updated_at, mtime, size, hash, tags, is_daily, excerpt
             FROM notes WHERE id = ?1",
        )?;
        let mut rows = stmt.query(params![id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row_to_note(row)?))
        } else {
            Ok(None)
        }
    }

    pub fn all_notes(&self) -> DbResult<Vec<NoteRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, title, created_at, updated_at, mtime, size, hash, tags, is_daily, excerpt
             FROM notes ORDER BY title COLLATE NOCASE",
        )?;
        let mut rows = stmt.query([])?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            out.push(row_to_note(row)?);
        }
        Ok(out)
    }

    pub fn delete_note(&self, path: &str) -> DbResult<()> {
        let id: Option<String> = self
            .conn
            .query_row("SELECT id FROM notes WHERE path = ?1", params![path], |r| r.get(0))
            .optional()?;
        self.conn.execute("DELETE FROM notes WHERE path = ?1", params![path])?;
        self.conn.execute("DELETE FROM notes_fts WHERE path = ?1", params![path])?;
        if let Some(id) = id {
            self.conn.execute("DELETE FROM note_tags WHERE note_id = ?1", params![id])?;
            self.conn.execute("DELETE FROM links WHERE source_id = ?1", params![id])?;
        }
        Ok(())
    }

    pub fn notes_for_path(&self, path: &str) -> DbResult<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare_cached("SELECT path FROM notes WHERE path LIKE ?1 ORDER BY path")?;
        let pattern = format!("{}%", escape_like(path));
        let rows = stmt.query_map(params![pattern], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    // -------------------------------------------------------------------- FTS

    pub fn index_note_body(&self, path: &str, title: &str, body: &str, tags: &[String]) -> DbResult<()> {
        self.conn.execute("DELETE FROM notes_fts WHERE path = ?1", params![path])?;
        self.conn.execute(
            "INSERT INTO notes_fts(path, title, body, tags) VALUES (?1, ?2, ?3, ?4)",
            params![path, title, body, tags.join(" ")],
        )?;
        Ok(())
    }

    pub fn remove_note_body(&self, path: &str) -> DbResult<()> {
        self.conn.execute("DELETE FROM notes_fts WHERE path = ?1", params![path])?;
        Ok(())
    }

    /// Full-text search across note titles and bodies.
    pub fn search_fts(&self, query: &str, limit: usize) -> DbResult<Vec<SearchHit>> {
        // Build a safe FTS5 prefix query: every term becomes "term"* and terms
        // are ANDed together. Quotes inside the user input are neutralised.
        let cleaned: Vec<String> = query
            .split_whitespace()
            .map(|t| t.trim_matches('"'))
            .filter(|t| !t.is_empty())
            .map(|t| format!("\"{}\"*", t.replace('"', "")))
            .collect();
        if cleaned.is_empty() {
            return Ok(Vec::new());
        }
        let fts_query = cleaned.join(" ");
        let mut stmt = self.conn.prepare_cached(
            "SELECT path, snippet(notes_fts, 2, '\u{1}', '\u{2}', '…', 18) AS snip, rank
             FROM notes_fts WHERE notes_fts MATCH ?1
             ORDER BY rank LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![fts_query, limit as i64], |r| {
            Ok(SearchHit {
                path: r.get(0)?,
                snippet: r.get(1)?,
                score: -r.get::<_, f64>(2)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn has_fts(&self) -> bool {
        self.conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='notes_fts'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false)
    }

    // ------------------------------------------------------------------ links

    pub fn replace_links(&self, source_id: &str, links: &[(String, String, String)]) -> DbResult<()> {
        self.conn
            .execute("DELETE FROM links WHERE source_id = ?1", params![source_id])?;
        let mut stmt = self.conn.prepare_cached(
            "INSERT OR REPLACE INTO links(source_id, target_path, target_name, kind, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        let now = now_ms();
        for (target_path, target_name, kind) in links {
            stmt.execute(params![source_id, target_path, target_name, kind, now])?;
        }
        Ok(())
    }

    pub fn backlinks(&self, target_path: &str) -> DbResult<Vec<LinkRecord>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT l.source_id, n.path, l.target_path, l.target_name, l.kind
             FROM links l JOIN notes n ON n.id = l.source_id
             WHERE l.target_path = ?1 ORDER BY n.title COLLATE NOCASE",
        )?;
        let rows = stmt.query_map(params![target_path], |r| {
            Ok(LinkRecord {
                source_id: r.get(0)?,
                source_path: r.get(1)?,
                target_path: r.get(2)?,
                target_name: r.get(3)?,
                kind: r.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn outgoing_links(&self, source_id: &str) -> DbResult<Vec<LinkRecord>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT source_id, source_path, target_path, target_name, kind
             FROM (SELECT l.source_id AS source_id, COALESCE(n.path,'') AS source_path,
                          l.target_path, l.target_name, l.kind
                   FROM links l LEFT JOIN notes n ON n.id = l.source_id)
             WHERE source_id = ?1",
        )?;
        let rows = stmt.query_map(params![source_id], |r| {
            Ok(LinkRecord {
                source_id: r.get(0)?,
                source_path: r.get(1)?,
                target_path: r.get(2)?,
                target_name: r.get(3)?,
                kind: r.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    // ------------------------------------------------------------------ graph

    /// Build the knowledge graph: every indexed note is a node, every link
    /// between notes is an edge.
    ///
    /// A link whose target does not exist yet still becomes a node, marked as
    /// missing, so the graph shows the gap instead of quietly dropping it.
    pub fn knowledge_graph(&self) -> DbResult<GraphData> {
        let mut nodes: Vec<GraphNode> = Vec::new();
        let mut index: HashMap<String, usize> = HashMap::new();

        let mut stmt = self
            .conn
            .prepare_cached("SELECT path, title FROM notes WHERE path LIKE '%.md'")?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (path, title) = row?;
            index.insert(path.clone(), nodes.len());
            nodes.push(GraphNode {
                id: path.clone(),
                path,
                title,
                links: 0.0,
                backlinks: 0.0,
                missing: false,
            });
        }

        let mut stmt = self.conn.prepare_cached(
            "SELECT n.path, l.target_path, l.target_name, l.kind
             FROM links l JOIN notes n ON n.id = l.source_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?;

        let mut edges: Vec<GraphEdge> = Vec::new();
        for row in rows {
            let (source, target_path, target_name, kind) = row?;
            // An empty path means the link never resolved to a file — it
            // points at a note that does not exist yet.
            let target_id = if target_path.is_empty() {
                target_name
            } else {
                target_path
            };
            if target_id.is_empty() {
                continue;
            }
            let source_index = match index.get(&source) {
                Some(i) => *i,
                None => continue,
            };
            let target_index = match index.get(&target_id) {
                Some(i) => *i,
                None => {
                    index.insert(target_id.clone(), nodes.len());
                    nodes.push(GraphNode {
                        id: target_id.clone(),
                        path: target_id.clone(),
                        title: crate::util::file_stem(&target_id),
                        links: 0.0,
                        backlinks: 0.0,
                        missing: true,
                    });
                    nodes.len() - 1
                }
            };
            nodes[source_index].links += 1.0;
            nodes[target_index].backlinks += 1.0;
            edges.push(GraphEdge {
                source,
                target: target_id,
                kind,
            });
        }

        Ok(GraphData { nodes, edges })
    }

    // ------------------------------------------------------------------ tasks

    pub fn upsert_task(&self, task: &TaskRecord) -> DbResult<()> {
        self.conn.execute(
            "INSERT INTO tasks(id, title, description, status, priority, due_date, start_time, end_time,
                               duration_minutes, timezone, note_id, event_id, recurrence, completed_at,
                               created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
             ON CONFLICT(id) DO UPDATE SET
               title=excluded.title, description=excluded.description, status=excluded.status,
               priority=excluded.priority, due_date=excluded.due_date, start_time=excluded.start_time,
               end_time=excluded.end_time, duration_minutes=excluded.duration_minutes,
               timezone=excluded.timezone, note_id=excluded.note_id, event_id=excluded.event_id,
               recurrence=excluded.recurrence, completed_at=excluded.completed_at,
               updated_at=excluded.updated_at",
            params![
                task.id,
                task.title,
                task.description,
                task.status,
                task.priority,
                task.due_date,
                task.start_time,
                task.end_time,
                task.duration_minutes.map(|d| d as i64),
                task.timezone,
                task.note_id,
                task.event_id,
                task.recurrence,
                task.completed_at.map(|c| c as i64),
                task.created_at as i64,
                task.updated_at as i64,
            ],
        )?;
        Ok(())
    }

    pub fn get_task(&self, id: &str) -> DbResult<Option<TaskRecord>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, title, description, status, priority, due_date, start_time, end_time,
                    duration_minutes, timezone, note_id, event_id, recurrence, completed_at,
                    created_at, updated_at
             FROM tasks WHERE id = ?1",
        )?;
        let mut rows = stmt.query(params![id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row_to_task(row)?))
        } else {
            Ok(None)
        }
    }

    pub fn all_tasks(&self) -> DbResult<Vec<TaskRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, description, status, priority, due_date, start_time, end_time,
                    duration_minutes, timezone, note_id, event_id, recurrence, completed_at,
                    created_at, updated_at
             FROM tasks ORDER BY
                CASE status WHEN 'done' THEN 2 WHEN 'cancelled' THEN 3 ELSE 0 END,
                CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                COALESCE(due_date, '9999-12-31') ASC, created_at DESC",
        )?;
        let mut rows = stmt.query([])?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            out.push(row_to_task(row)?);
        }
        Ok(out)
    }

    pub fn delete_task(&self, id: &str) -> DbResult<()> {
        self.conn.execute("DELETE FROM tasks WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ----------------------------------------------------------------- events

    pub fn upsert_event(&self, event: &EventRecord) -> DbResult<()> {
        let exdates_json = serde_json::to_string(&event.exdates)?;
        self.conn.execute(
            "INSERT INTO events(id, title, description, start_utc, end_utc, all_day, timezone,
                                 rrule, exdates, color, location, note_id, task_id, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
             ON CONFLICT(id) DO UPDATE SET
               title=excluded.title, description=excluded.description, start_utc=excluded.start_utc,
               end_utc=excluded.end_utc, all_day=excluded.all_day, timezone=excluded.timezone,
               rrule=excluded.rrule, exdates=excluded.exdates, color=excluded.color,
               location=excluded.location, note_id=excluded.note_id, task_id=excluded.task_id,
               updated_at=excluded.updated_at",
            params![
                event.id,
                event.title,
                event.description,
                event.start_utc as i64,
                event.end_utc as i64,
                if event.all_day { 1 } else { 0 },
                event.timezone,
                event.rrule,
                exdates_json,
                event.color,
                event.location,
                event.note_id,
                event.task_id,
                event.created_at as i64,
                event.updated_at as i64,
            ],
        )?;
        Ok(())
    }

    pub fn get_event(&self, id: &str) -> DbResult<Option<EventRecord>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, title, description, start_utc, end_utc, all_day, timezone, rrule, exdates,
                    color, location, note_id, task_id, created_at, updated_at
             FROM events WHERE id = ?1",
        )?;
        let mut rows = stmt.query(params![id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row_to_event(row)?))
        } else {
            Ok(None)
        }
    }

    pub fn all_events(&self) -> DbResult<Vec<EventRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, description, start_utc, end_utc, all_day, timezone, rrule, exdates,
                    color, location, note_id, task_id, created_at, updated_at
             FROM events ORDER BY start_utc ASC",
        )?;
        let mut rows = stmt.query([])?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            out.push(row_to_event(row)?);
        }
        Ok(out)
    }

    pub fn delete_event(&self, id: &str) -> DbResult<()> {
        self.conn.execute("DELETE FROM events WHERE id = ?1", params![id])?;
        Ok(())
    }

    // --------------------------------------------------------------- recovery

    pub fn save_recovery(&self, path: &str, content: &str, base_hash: Option<&str>) -> DbResult<()> {
        self.conn.execute(
            "INSERT INTO recovery(path, content, base_hash, updated_at) VALUES (?1,?2,?3,?4)
             ON CONFLICT(path) DO UPDATE SET content=excluded.content,
               base_hash=excluded.base_hash, updated_at=excluded.updated_at",
            params![path, content, base_hash, now_ms()],
        )?;
        Ok(())
    }

    pub fn clear_recovery(&self, path: &str) -> DbResult<()> {
        self.conn.execute("DELETE FROM recovery WHERE path = ?1", params![path])?;
        Ok(())
    }

    pub fn clear_all_recovery(&self) -> DbResult<()> {
        self.conn.execute("DELETE FROM recovery", [])?;
        Ok(())
    }

    pub fn recovery_entries(&self) -> DbResult<Vec<(String, String)>> {
        let mut stmt = self.conn.prepare("SELECT path, content FROM recovery")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    // ----------------------------------------------------------------- recent

    pub fn touch_recent(&self, path: &str) -> DbResult<()> {
        self.conn.execute(
            "INSERT INTO recent(path, opened_at) VALUES (?1, ?2)
             ON CONFLICT(path) DO UPDATE SET opened_at = excluded.opened_at",
            params![path, now_ms()],
        )?;
        // Keep only the 50 most recent entries.
        self.conn.execute(
            "DELETE FROM recent WHERE path IN (
                 SELECT path FROM recent ORDER BY opened_at DESC LIMIT -1 OFFSET 50)",
            [],
        )?;
        Ok(())
    }

    pub fn recent_paths(&self, limit: usize) -> DbResult<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT path FROM recent ORDER BY opened_at DESC LIMIT ?1")?;
        let rows = stmt.query_map(params![limit as i64], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Remove a note from every index (used when a file disappears).
    pub fn purge_path(&self, path: &str) -> DbResult<()> {
        self.delete_note(path)?;
        self.conn.execute("DELETE FROM recovery WHERE path = ?1", params![path])?;
        self.conn.execute("DELETE FROM recent WHERE path = ?1", params![path])?;
        Ok(())
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SearchHit {
    pub path: String,
    pub snippet: String,
    pub score: f64,
}

fn escape_like(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn row_to_note(row: &rusqlite::Row<'_>) -> rusqlite::Result<NoteRecord> {
    let tags_json: String = row.get(8)?;
    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
    Ok(NoteRecord {
        id: row.get(0)?,
        path: row.get(1)?,
        title: row.get(2)?,
        created_at: row.get::<_, i64>(3)? as f64,
        updated_at: row.get::<_, i64>(4)? as f64,
        mtime: row.get::<_, i64>(5)? as f64,
        size: row.get::<_, i64>(6)? as f64,
        hash: row.get(7)?,
        tags,
        is_daily: row.get::<_, i64>(9)? != 0,
        excerpt: row.get(10)?,
    })
}

fn row_to_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskRecord> {
    Ok(TaskRecord {
        id: row.get(0)?,
        title: row.get(1)?,
        description: row.get(2)?,
        status: row.get(3)?,
        priority: row.get(4)?,
        due_date: row.get(5)?,
        start_time: row.get(6)?,
        end_time: row.get(7)?,
        duration_minutes: row.get::<_, Option<i64>>(8)?.map(|v| v as f64),
        timezone: row.get(9)?,
        note_id: row.get(10)?,
        event_id: row.get(11)?,
        recurrence: row.get(12)?,
        completed_at: row.get::<_, Option<i64>>(13)?.map(|v| v as f64),
        created_at: row.get::<_, i64>(14)? as f64,
        updated_at: row.get::<_, i64>(15)? as f64,
    })
}

fn row_to_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<EventRecord> {
    let exdates_json: String = row.get(8)?;
    let exdates: Vec<String> = serde_json::from_str(&exdates_json).unwrap_or_default();
    Ok(EventRecord {
        id: row.get(0)?,
        title: row.get(1)?,
        description: row.get(2)?,
        start_utc: row.get::<_, i64>(3)? as f64,
        end_utc: row.get::<_, i64>(4)? as f64,
        all_day: row.get::<_, i64>(5)? != 0,
        timezone: row.get(6)?,
        rrule: row.get(7)?,
        exdates,
        color: row.get(9)?,
        location: row.get(10)?,
        note_id: row.get(11)?,
        task_id: row.get(12)?,
        created_at: row.get::<_, i64>(13)? as f64,
        updated_at: row.get::<_, i64>(14)? as f64,
    })
}

/// Count rows per table for the status bar.
pub fn table_counts(conn: &Connection) -> DbResult<Vec<(String, i64)>> {
    let mut out = Vec::new();
    for table in ["notes", "tasks", "events", "links"] {
        let sql = format!("SELECT count(*) FROM {}", table);
        let n: i64 = conn.query_row(&sql, [], |r| r.get(0)).unwrap_or(0);
        out.push((table.to_string(), n));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_db() -> (tempfile::TempDir, Db) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("app.db")).unwrap();
        (dir, db)
    }

    #[test]
    fn migrations_are_idempotent() {
        let (_d, mut db) = tmp_db();
        assert_eq!(db.schema_version(), SCHEMA_VERSION);
        db.migrate().unwrap();
        assert_eq!(db.schema_version(), SCHEMA_VERSION);
    }

    #[test]
    fn settings_roundtrip() {
        let (_d, db) = tmp_db();
        db.set_setting("theme", "nord-dark").unwrap();
        assert_eq!(db.get_setting("theme").unwrap().as_deref(), Some("nord-dark"));
        db.set_setting("theme", "nord-light").unwrap();
        assert_eq!(db.get_setting("theme").unwrap().as_deref(), Some("nord-light"));
        db.delete_setting("theme").unwrap();
        assert!(db.get_setting("theme").unwrap().is_none());
    }

    #[test]
    fn tasks_roundtrip_and_persist() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("app.db");
        {
            let db = Db::open(&db_path).unwrap();
            let task = TaskRecord {
                id: "t1".into(),
                title: "Write docs".into(),
                description: String::new(),
                status: "todo".into(),
                priority: "high".into(),
                due_date: Some("2026-10-26".into()),
                start_time: Some("09:00".into()),
                end_time: None,
                duration_minutes: Some(60.0),
                timezone: "local".into(),
                note_id: None,
                event_id: None,
                recurrence: None,
                completed_at: None,
                created_at: 1.0,
                updated_at: 1.0,
            };
            db.upsert_task(&task).unwrap();
        }
        let db = Db::open(&db_path).unwrap();
        let loaded = db.get_task("t1").unwrap().expect("task present");
        assert_eq!(loaded.title, "Write docs");
        assert_eq!(loaded.priority, "high");
        assert_eq!(loaded.due_date.as_deref(), Some("2026-10-26"));
    }

    #[test]
    fn fts_finds_content() {
        let (_d, db) = tmp_db();
        db.index_note_body("a.md", "Alpha", "the quick brown fox", &[]).unwrap();
        let hits = db.search_fts("brown", 10).unwrap();
        assert!(!hits.is_empty(), "expected a hit for 'brown'");
        assert_eq!(hits[0].path, "a.md");
        let none = db.search_fts("elephant", 10).unwrap();
        assert!(none.is_empty());
    }

    #[test]
    fn events_roundtrip_with_all_columns() {
        let (_d, db) = tmp_db();
        let event = EventRecord {
            id: "e1".into(),
            title: "Standup".into(),
            description: "Daily sync".into(),
            start_utc: 1_700_000_000_000.0,
            end_utc: 1_700_000_900_000.0,
            all_day: false,
            timezone: "utc".into(),
            rrule: Some("FREQ=DAILY".into()),
            exdates: vec!["1699999999000".into()],
            color: Some("#88c0d0".into()),
            location: Some("Room 1".into()),
            note_id: Some("n1".into()),
            task_id: Some("t1".into()),
            created_at: 1.0,
            updated_at: 2.0,
        };
        db.upsert_event(&event).unwrap();
        let loaded = db.get_event("e1").unwrap().expect("event present");
        assert_eq!(loaded.title, "Standup");
        assert_eq!(loaded.description, "Daily sync");
        assert_eq!(loaded.start_utc, 1_700_000_000_000.0);
        assert_eq!(loaded.end_utc, 1_700_000_900_000.0);
        assert!(!loaded.all_day);
        assert_eq!(loaded.timezone, "utc");
        assert_eq!(loaded.rrule.as_deref(), Some("FREQ=DAILY"));
        assert_eq!(loaded.exdates, vec!["1699999999000".to_string()]);
        assert_eq!(loaded.color.as_deref(), Some("#88c0d0"));
        assert_eq!(loaded.location.as_deref(), Some("Room 1"));
        assert_eq!(loaded.note_id.as_deref(), Some("n1"));
        assert_eq!(loaded.task_id.as_deref(), Some("t1"));
        assert_eq!(loaded.created_at, 1.0);
        assert_eq!(loaded.updated_at, 2.0);
    }

    #[test]
    fn events_with_null_columns_roundtrip() {
        let (_d, db) = tmp_db();
        let event = EventRecord {
            id: "e2".into(),
            title: "Bare".into(),
            description: String::new(),
            start_utc: 1.0,
            end_utc: 2.0,
            all_day: true,
            timezone: "local".into(),
            rrule: None,
            exdates: vec![],
            color: None,
            location: None,
            note_id: None,
            task_id: None,
            created_at: 0.0,
            updated_at: 0.0,
        };
        db.upsert_event(&event).unwrap();
        let loaded = db.get_event("e2").unwrap().expect("event present");
        assert!(loaded.all_day);
        assert!(loaded.color.is_none());
        assert!(loaded.location.is_none());
        assert!(loaded.note_id.is_none());
        assert!(loaded.task_id.is_none());
        assert!(loaded.rrule.is_none());
    }

    #[test]
    fn backlinks_resolve() {
        let (_d, db) = tmp_db();
        let note = NoteRecord {
            id: "n1".into(),
            path: "target.md".into(),
            title: "Target".into(),
            created_at: 0.0,
            updated_at: 0.0,
            mtime: 0.0,
            size: 0.0,
            hash: "h".into(),
            tags: vec![],
            is_daily: false,
            excerpt: String::new(),
        };
        db.upsert_note(&note).unwrap();
        db.replace_links("n1", &[("target.md".into(), "Target".into(), "wikilink".into())])
            .unwrap();
        let back = db.backlinks("target.md").unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].source_path, "target.md");
    }

    fn graph_note(id: &str, path: &str, title: &str) -> NoteRecord {
        NoteRecord {
            id: id.into(),
            path: path.into(),
            title: title.into(),
            created_at: 0.0,
            updated_at: 0.0,
            mtime: 0.0,
            size: 0.0,
            hash: "h".into(),
            tags: vec![],
            is_daily: false,
            excerpt: String::new(),
        }
    }

    #[test]
    fn graph_links_notes_to_notes() {
        let (_d, db) = tmp_db();
        db.upsert_note(&graph_note("n1", "alpha.md", "Alpha")).unwrap();
        db.upsert_note(&graph_note("n2", "beta.md", "Beta")).unwrap();
        db.replace_links("n1", &[("beta.md".into(), "Beta".into(), "wikilink".into())])
            .unwrap();
        db.replace_links("n2", &[("alpha.md".into(), "Alpha".into(), "wikilink".into())])
            .unwrap();

        let graph = db.knowledge_graph().unwrap();
        assert_eq!(graph.nodes.len(), 2);
        assert_eq!(graph.edges.len(), 2);
        let alpha = graph.nodes.iter().find(|n| n.id == "alpha.md").unwrap();
        assert_eq!(alpha.links, 1.0);
        assert_eq!(alpha.backlinks, 1.0);
        assert!(!alpha.missing);
        let edge = graph.edges.iter().find(|e| e.source == "alpha.md").unwrap();
        assert_eq!(edge.target, "beta.md");
        assert_eq!(edge.kind, "wikilink");
    }

    #[test]
    fn graph_keeps_unresolved_links_as_missing_nodes() {
        let (_d, db) = tmp_db();
        db.upsert_note(&graph_note("n1", "alpha.md", "Alpha")).unwrap();
        // An empty target path means the link never resolved to a file.
        db.replace_links("n1", &[(String::new(), "Ghost".into(), "wikilink".into())])
            .unwrap();

        let graph = db.knowledge_graph().unwrap();
        assert_eq!(graph.nodes.len(), 2);
        let ghost = graph.nodes.iter().find(|n| n.id == "Ghost").unwrap();
        assert!(ghost.missing);
        assert_eq!(ghost.title, "Ghost");
        assert_eq!(ghost.backlinks, 1.0);
        assert_eq!(graph.edges.len(), 1);
        assert_eq!(graph.edges[0].target, "Ghost");
    }

    #[test]
    fn graph_is_empty_without_notes() {
        let (_d, db) = tmp_db();
        let graph = db.knowledge_graph().unwrap();
        assert!(graph.nodes.is_empty());
        assert!(graph.edges.is_empty());
    }
}
