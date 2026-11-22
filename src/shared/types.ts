/** Types mirroring the Rust core's N-API surface. */

export interface VaultInfo {
  path: string
  name: string
  attachmentsDir: string
  drawingsDir: string
  noteCount: number
  taskCount: number
  eventCount: number
  schemaVersion: number
}

export interface TreeEntry {
  path: string
  name: string
  kind: 'folder' | 'file'
  depth: number
  size: number
  modified: number
  extension: string
}

export interface FileStamp {
  path: string
  size: number
  modified: number
  hash: string
}

export interface AttachmentInfo {
  path: string
  markdownRef: string
  size: number
  reused: boolean
}

export interface NoteRecord {
  id: string
  path: string
  title: string
  createdAt: number
  updatedAt: number
  mtime: number
  size: number
  hash: string
  tags: string[]
  isDaily: boolean
  excerpt: string
}

export interface TaskRecord {
  id: string
  title: string
  description: string
  status: TaskStatus
  priority: TaskPriority
  dueDate?: string
  startTime?: string
  endTime?: string
  durationMinutes?: number
  timezone: string
  noteId?: string
  eventId?: string
  recurrence?: string
  completedAt?: number
  createdAt: number
  updatedAt: number
}

export interface EventRecord {
  id: string
  title: string
  description: string
  startUtc: number
  endUtc: number
  allDay: boolean
  timezone: string
  rrule?: string
  exdates: string[]
  color?: string
  location?: string
  noteId?: string
  taskId?: string
  createdAt: number
  updatedAt: number
}

export interface LinkRecord {
  sourceId: string
  sourcePath: string
  targetPath: string
  targetName: string
  kind: string
}

/** One node of the knowledge graph: a note, or a link with no note yet. */
export interface GraphNode {
  id: string
  path: string
  title: string
  links: number
  backlinks: number
  missing: boolean
}

/** A directed link between two graph nodes. */
export interface GraphEdge {
  source: string
  target: string
  kind: string
}

/** The whole knowledge graph of a vault. */
export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface SearchResult {
  path: string
  title: string
  snippet: string
  score: number
  kind: 'note' | 'task' | 'event'
}

export interface TrashEntry {
  path: string
  name: string
  kind: string
  deletedAt: number
  size: number
}

export interface RecoveryEntry {
  path: string
  content: string
  updatedAt: number
}

export interface VaultStats {
  notes: number
  attachments: number
  drawings: number
  tasks: number
  events: number
  vaultBytes: number
}

export interface BackupInfo {
  path: string
  name: string
  size: number
  createdAt: number
}

export interface WatchEvent {
  kind: 'create' | 'change' | 'remove'
  paths: string[]
}

export type TaskStatus = 'todo' | 'doing' | 'done' | 'cancelled'
export type TaskPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent'
export type ThemeName = 'nord-dark' | 'nord-light' | 'ayu-dark' | 'ayu-mirage'
export type ContentFont = 'iosevka' | 'noto'
export type ViewName = 'notes' | 'tasks' | 'calendar' | 'drawings' | 'search' | 'settings' | 'trash'

/**
 * How a note is shown.
 *
 * `reading` shows the finished note, `editing` shows the Markdown, and
 * `split` shows both side by side.
 */
export type NoteViewMode = 'reading' | 'editing' | 'source' | 'split'
export type CalendarMode = 'month' | 'week' | 'day'

/** The API exposed to the renderer by the preload bridge. */
/** A Piper voice model installed on this machine. */
export interface TtsVoice {
  name: string
  path: string
  language: string | null
  size: number
}

/** What the local speech setup looks like right now. */
export interface TtsStatus {
  available: boolean
  piperPath: string | null
  modelDir: string | null
  voices: TtsVoice[]
  error: string | null
}

/** The state of the GitHub sync setup for a vault. */
export interface SyncStatus {
  configured: boolean
  repo: string | null
  branch: string
  gitAvailable: boolean
  lfsAvailable: boolean
  lfsEnabled: boolean
  isRepo: boolean
  pendingChanges: boolean
  conflictFiles: string[]
  lastCommit: string | null
  lastSync: number | null
  lastError: string | null
}

/** The outcome of one sync operation. */
export interface SyncResult {
  ok: boolean
  action: string
  message: string
  commits: number
  filesChanged: number
  conflict: boolean
  lastSync: number
}

export interface DeltaApi {
  // --- vault lifecycle -------------------------------------------------
  initialVaultPath(): string | null
  openVault(path: string): VaultInfo
  closeVault(): void
  vaultInfo(): VaultInfo | null
  openVaultDialog(): Promise<string | null>
  pickFolder(title: string): Promise<string | null>
  pickFiles(extensions: string[]): Promise<string[]>
  saveFileDialog(defaultName: string, extensions: string[]): Promise<string | null>

  // --- filesystem ------------------------------------------------------
  tree(): TreeEntry[]
  readFile(path: string): string
  readBytes(path: string): Uint8Array
  fileExists(path: string): boolean
  writeFile(path: string, content: string): FileStamp
  createFile(path: string, content?: string): FileStamp
  createFolder(path: string): boolean
  renameEntry(path: string, newPath: string): string
  moveEntry(path: string, destDir: string): string
  deleteEntry(path: string): boolean
  listTrash(): TrashEntry[]
  restoreFromTrash(name: string): string
  purgeTrash(): number
  listAttachments(): TreeEntry[]
  drawingPath(path: string): string
  absolutePath(path: string): string
  isInsideVault(absPath: string): boolean

  // --- notes -----------------------------------------------------------
  indexNote(path: string): NoteRecord | null
  listNotes(): NoteRecord[]
  reindexAll(): number
  backlinks(path: string): LinkRecord[]
  resolveLink(target: string, fromPath: string): string | null
  searchNotes(query: string, limit?: number): SearchResult[]
  notesByTag(tag: string): NoteRecord[]
  allTags(): string[]
  dailyNote(date: string, create: boolean): string
  detectChanges(): string[]

  // --- knowledge graph --------------------------------------------------
  knowledgeGraph(): GraphData

  // --- attachments -----------------------------------------------------
  importAttachment(name: string, bytes: Uint8Array, fromNote?: string): AttachmentInfo
  importAttachmentFromPath(absPath: string, fromNote?: string): AttachmentInfo

  // --- tasks and events ------------------------------------------------
  listTasks(): TaskRecord[]
  saveTask(task: Record<string, unknown>): TaskRecord
  deleteTask(id: string): boolean
  listEvents(): EventRecord[]
  saveEvent(event: Record<string, unknown>): EventRecord
  deleteEvent(id: string): boolean

  // --- calendar --------------------------------------------------------
  exportCalendar(events: EventRecord[], name: string): string
  importCalendar(text: string): EventRecord[]

  // --- settings --------------------------------------------------------
  getSetting(key: string): string | null
  setSetting(key: string, value: string): boolean
  allSettings(): Record<string, string>

  // --- recovery and recents --------------------------------------------
  saveRecovery(path: string, content: string): boolean
  loadRecovery(): RecoveryEntry[]
  clearRecovery(path: string): boolean
  clearAllRecovery(): boolean
  touchRecent(path: string): boolean
  recentPaths(limit?: number): string[]

  // --- stats and backup ------------------------------------------------
  stats(): VaultStats
  createBackup(destDir: string): BackupInfo
  listBackups(dir: string): BackupInfo[]
  restoreBackup(archive: string, destRoot: string): string

  // --- voice ------------------------------------------------------------
  ttsStatus(voiceDir?: string): TtsStatus
  listTtsVoices(voiceDir?: string): TtsVoice[]
  speak(
    text: string,
    modelPath: string,
    piperPath?: string,
    lengthScale?: number,
    plain?: boolean,
  ): Promise<string>
  stopSpeaking(): boolean
  clearSpeechCache(): number
  audioFileUrl(absPath: string): string

  // --- sync -------------------------------------------------------------
  syncStatus(repo?: string, branch?: string): SyncStatus
  syncSetup(repo: string, branch?: string, useLfs?: boolean): Promise<SyncResult>
  syncPush(repo?: string, branch?: string, message?: string): Promise<SyncResult>
  syncPull(repo?: string, branch?: string): Promise<SyncResult>
  syncNow(repo?: string, branch?: string, message?: string): Promise<SyncResult>
  setSyncToken(token: string): Promise<string>
  getSyncToken(): Promise<string>
  createGitHubRepo(name: string, isPrivate: boolean): Promise<{
    ok: boolean
    repo: string
    message: string
  }>

  // --- misc ------------------------------------------------------------
  sanitizeNoteName(name: string): string
  encodeMarkdownPath(path: string): string
  humanSize(bytes: number): string
  coreVersion(): string

  // --- events from the filesystem watcher -------------------------------
  onWatch(handler: (event: WatchEvent) => void): () => void
  onMenuCommand(handler: (command: string) => void): () => void
}

declare global {
  interface Window {
    delta: DeltaApi
  }
}
