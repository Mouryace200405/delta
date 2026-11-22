# Delta

A lightweight, local-first knowledge base for the desktop. Markdown notes, a task
manager, a calendar and real Excalidraw drawings live in one workspace, on your
own disk, with no account and no server.

```
┌──────────────┬──────────────────────────────────────────────┐
│  sidebar     │  note editor + live preview                 │
│  files/tags  │  ─────────────────────────────────────────── │
│  notes       │  tasks · calendar · drawings · search        │
│  tasks       │                                              │
│  calendar    │                                              │
└──────────────┴──────────────────────────────────────────────┘
```

## What it does

- **Notes** — plain `.md` files on disk, edited in CodeMirror 6, with
  `[[wikilinks]]`, tag syntax, backlinks and a file tree with drag-and-drop.
  A note opens in **reading** view, the way it looks when it is finished;
  **editing** shows the Markdown and **split** shows both side by side.
- **Tabs** — notes stay open across the top, can be dragged into a new order,
  and the whole workspace comes back when the app is opened again.
- **Knowledge graph** — every note is a dot and every link a line, drawn at the
  bottom of the left sidebar. The panel folds away with a chevron; hovering a
  note lights up the notes it is connected to, clicking one opens it and
  dragging one moves it out of the way. Links that point at a note nobody has
  written yet are drawn as empty rings, so the gaps are visible too.
- **Tasks** — a real task manager with status, priority, due dates and time
  ranges; filters for today, upcoming, overdue, completed, by priority and by
  status.
- **Calendar** — month, week and day views, drag-and-drop rescheduling,
  recurring events (`RRULE`), all-day events and iCalendar import/export.
- **Drawings** — the actual Excalidraw editor, lazily loaded. Scenes are stored
  as `.excalidraw` JSON in the vault, so they stay editable outside Delta.
- **Read aloud** — Piper speaks the note you are looking at, locally. It
  reads the note as it is displayed, so headings, lists and links are read as
  prose — never as hashes, dashes and dots.
- **Sync** — the vault can be linked to a GitHub repository and kept in step
  between machines, with large files routed through Git LFS.
- **Attachments** — paste or drop images straight into a note; files are
  de-duplicated by content hash.
- **Safety** — atomic writes, a recovery journal, a recoverable trash, backups
  as zip archives, and change detection for files edited outside the app.

Everything is stored locally: notes in the vault, structured data in a SQLite
database under `<vault>/.delta/app.db`.

## Design

**Rust is the core.** The `native/` crate is a Node-API addon that owns all
file and database work. The React layer never touches the filesystem directly.

| Rust module        | Responsibility                                                     |
| ------------------ | ------------------------------------------------------------------ |
| `util.rs`          | Atomic writes, path-traversal rejection, hashing, MIME sniffing     |
| `error.rs`         | One error type bridged into Node-API errors                         |
| `notes.rs`         | Title/tag/wikilink extraction, excerpts, checkbox counting          |
| `db.rs`            | SQLite schema, migrations, FTS5 search index                       |
| `vault.rs`         | Tree walk, CRUD, trash, attachments, drawings, link rewriting       |
| `watcher.rs`       | `notify`-based recursive watcher with debounced batches             |
| `ics.rs`           | A hand-written RFC 5545 parser and exporter                         |
| `backup.rs`        | Zip creation, listing and restore                                   |
| `tts.rs`           | Piper discovery, Markdown-to-speech cleanup, synthesis, playback    |
| `sync.rs`          | Git repository setup, LFS rules, commit, pull, merge, push          |

**Electron, not Tauri.** Tauri needs `webkit2gtk` development packages, which
require root to install. Electron ships its own Chromium, so the app builds
and runs on a plain user account. Node-API is ABI-stable, so one compiled
addon serves both Node (for tests) and Electron.

**TypeScript everywhere else.**

```
src/main/       Electron main process — window, menus, dialogs, offline guard
src/preload/    Context-isolated bridge that loads the Rust addon
src/renderer/   React UI — themes, CodeMirror, markdown-it, views
native/         The Rust core, compiled to a Node-API addon
scripts/        Smoke tests, sync tests, demo seeding, icon generation
```

### The icon

The mark is a triangle inside a triangle and nothing else: no tile, no
background, no lettering. It is generated from the original artwork by
`npm run icon`, which writes the 512 px icon, every size a Linux desktop asks
for and a scalable SVG.

On Linux the app registers itself in `~/.local/share` on first run — a
desktop entry and the icon in the hicolor folders. That is what lets a
Wayland desktop know which window belongs to Delta, and it is why the panel
and the title bar show the mark instead of a generic symbol.

### Theme and fonts

Four themes ship with the app: **Nord Dark**, **Nord Light**, **Ayu Dark** and
**Ayu Mirage**. The interface is set in **Noto Sans**, and everything you write
— notes, code, task descriptions — is set in **Iosevka**. The writing font can
be switched to Noto in Settings.

The drawing canvas follows the app theme: the theme's surface colour is used
for the canvas, and a background you pick yourself is left alone. Excalidraw's
own dark-mode `invert()` filter is switched off so a scene always shows exactly
the colours it was saved with.

### Performance

The eagerly loaded renderer payload is about 1.1 MB. Excalidraw (≈3 MB with its
diagrams) is split into lazy chunks and only fetched the first time a drawing
is opened. Fonts for Excalidraw are bundled locally and an offline guard
cancels every outbound request, so the app works with no network at all.

The knowledge graph costs nothing while it is folded away. When it is open the
layout is worked out once per change and then painted onto a canvas — there is
no animation loop running in the background, so an idle vault costs nothing.

### Knowledge graph

The graph is built from the link index the Rust core already keeps: notes are
the nodes, links between them are the edges. A link that never resolved to a
file — `[[A note that does not exist yet]]` — still becomes a node, drawn as an
empty ring, because that gap is worth seeing.

The layout is a Fruchterman-Reingold force simulation, computed in plain
JavaScript away from the DOM and then scaled to fill the panel. The starting
positions come from a seeded random number generator, so the same vault always
draws the same graph instead of jumping about on every re-render.

### Read aloud

The voice reads the rendered note, not the raw Markdown: the preview is
already prose, so the speech has the same words the screen does. YAML
frontmatter is metadata and never reaches the voice.

Piper is a separate program, so it is not bundled. Delta finds it on the
`PATH`, in `~/anaconda3/bin`, `~/miniconda3/bin`, `~/.local/bin` and
`/usr/local/bin`, or you can point at it in Settings. Voice models are looked
for in `~/.local/share/piper/voices`, `~/.cache/piper` and
`~/chati/backend/piper_voices`; the folder can also be set by hand or through
the `DELTA_PIPER` and `DELTA_VOICES` environment variables.

Synthesis runs as a child process that writes a WAV to a temporary folder; the
player loads it from there. Nothing is sent anywhere.

### Sync

The vault folder *is* the git working tree. Notes, attachments and drawings are
committed and pushed, while Delta's own `.delta/` folder stays out of the
repository — it is a local index that every device rebuilds.

In Settings you can point the vault at a repository (`owner/name` or a full
URL), pick the branch and switch Git LFS on or off. A personal access token
with the `repo` scope is needed; it is stored in the operating system's key
store through Electron's `safeStorage` and is passed to git as an
`Authorization` header, so it never lands in `.git/config` on disk. Delta can
also create the repository for you.

A sync commits what changed here, merges what changed elsewhere and pushes the
result. If both sides changed the same file, the merge is left open and the
conflict markers appear in the note itself — keep the version you want, save,
and sync again. Nothing is merged behind your back and nothing is thrown away.

Git LFS patterns cover images, audio, video, `.excalidraw` scenes and the
`attachments/` and `drawings/` folders, so large files do not bloat the
repository history. LFS has to be installed on the machine
(`git lfs install`); Delta detects it and says so when it is missing.

## Requirements

- Node.js 20+ (developed on 24)
- Rust 1.80+ (developed on 1.93)
- Linux, macOS or Windows
- Optional: [Piper](https://github.com/rhasspy/piper) for read aloud, `git-lfs`
  for large files in sync

## Building

```bash
npm install
npm run build          # Rust addon + main/preload + renderer
npm start              # build and launch
```

`npm start` builds first, so the app is always runnable straight after a
change.

### Development

```bash
npm run dev:electron   # Vite dev server + Electron with hot reload
```

### Tests

```bash
npm test               # Rust unit tests, type check, smoke, speech, graph and sync tests
```

- `cargo test` — 51 unit tests over the Rust core.
- `node scripts/smoke-core.mjs` — 37 end-to-end checks that drive the real
  addon: vault CRUD, tasks, events, ICS, search, backups, external-change
  detection and path-traversal refusal.
- `node scripts/speech-test.mjs` — 17 checks that the rendered note is read
  as prose: no hashes, dashes, checkboxes or pipes, and no sentence cut in
  half by a wrapped line.
- `node scripts/graph-test.mjs` — 21 checks on the graph layout: it stays
  inside the panel, keeps linked notes together, is stable between renders and
  finds the note under the cursor.
- `node scripts/sync-test.mjs` — 31 checks that run two vaults against one
  local git repository: setup, push, pull, two-way sync, conflicts and their
  resolution, empty vaults and missing branches.
- `tsc --noEmit` — type check across main, preload and renderer.

### Packaging

```bash
npm run dist           # Linux: an unpacked directory and an AppImage
```

Artifacts land in `release/`:

- `release/linux-unpacked/` — a runnable directory (this is what the AppImage
  wraps).
- `release/Delta-<version>-x86_64.AppImage` — a single-file installer.

The Rust addon is copied to `resources/native/` next to the app, outside the
asar archive, because native modules cannot be loaded from inside one.

## Using it

Open a folder as a vault with **Ctrl+O**, or start the app with a path:

```bash
delta --vault=/path/to/vault
```

Everything inside that folder is yours: the `.md` files are ordinary Markdown,
the `.excalidraw` files are ordinary Excalidraw scenes, and the only thing
Delta adds is the `.delta/` directory with its index and settings. A vault made
by an earlier version is migrated on first open.

The knowledge graph sits at the bottom of the left sidebar. Click **Graph** to
fold it away or bring it back — the choice is remembered.

### Keyboard shortcuts

| Shortcut            | Action                                     |
| ------------------- | ------------------------------------------ |
| `Ctrl+N`            | New note                                   |
| `Ctrl+Shift+N`      | New folder                                 |
| `Ctrl+O`            | Open vault                                 |
| `Ctrl+S`            | Save note                                  |
| `Ctrl+1` … `Ctrl+5` | Notes / Tasks / Calendar / Drawings / Search |
| `Ctrl+E`            | Cycle the note view (reading, split, editing) |
| `Ctrl+Shift+L`      | Toggle theme                               |
| `Ctrl+P`            | Quick open                                 |
| `Ctrl+Shift+P`      | Command palette                            |
| `Ctrl+Shift+F`      | Find in the vault                          |
| `Ctrl+Enter`        | Open the wikilink under the cursor         |
| `Ctrl+/`            | Keyboard shortcut list                     |

## License

MIT
