import type {
  AttachmentInfo,
  BackupInfo,
  GraphData,
  SyncResult,
  SyncStatus,
  TtsStatus,
  TtsVoice,
  EventRecord,
  NoteRecord,
  RecoveryEntry,
  SearchResult,
  TaskRecord,
  TrashEntry,
  TreeEntry,
  VaultInfo,
  VaultStats,
  WatchEvent,
} from '@shared/types'

/** Thin, typed access to the Rust core exposed by the preload bridge. */
export const api = {
  // --- vault ---------------------------------------------------------------
  initialVaultPath(): string | null {
    return window.delta.initialVaultPath()
  },
  openVault(path: string): VaultInfo {
    return window.delta.openVault(path)
  },
  closeVault(): void {
    window.delta.closeVault()
  },
  vaultInfo(): VaultInfo | null {
    return window.delta.vaultInfo()
  },
  openVaultDialog(): Promise<string | null> {
    return window.delta.openVaultDialog()
  },
  pickFolder(title: string): Promise<string | null> {
    return window.delta.pickFolder(title)
  },
  pickFiles(extensions: string[]): Promise<string[]> {
    return window.delta.pickFiles(extensions)
  },
  saveFileDialog(defaultName: string, extensions: string[]): Promise<string | null> {
    return window.delta.saveFileDialog(defaultName, extensions)
  },

  // --- filesystem ----------------------------------------------------------
  tree(): TreeEntry[] {
    return window.delta.tree()
  },
  readFile(path: string): string {
    return window.delta.readFile(path)
  },
  readBytes(path: string): Uint8Array {
    return window.delta.readBytes(path)
  },
  fileExists(path: string): boolean {
    return window.delta.fileExists(path)
  },
  writeFile(path: string, content: string) {
    return window.delta.writeFile(path, content)
  },
  createFile(path: string, content = ''): { path: string; size: number; modified: number; hash: string } {
    return window.delta.createFile(path, content)
  },
  createFolder(path: string): boolean {
    return window.delta.createFolder(path)
  },
  renameEntry(path: string, newPath: string): string {
    return window.delta.renameEntry(path, newPath)
  },
  moveEntry(path: string, destDir: string): string {
    return window.delta.moveEntry(path, destDir)
  },
  deleteEntry(path: string): boolean {
    return window.delta.deleteEntry(path)
  },
  listTrash(): TrashEntry[] {
    return window.delta.listTrash()
  },
  restoreFromTrash(name: string): string {
    return window.delta.restoreFromTrash(name)
  },
  purgeTrash(): number {
    return window.delta.purgeTrash()
  },
  listAttachments(): TreeEntry[] {
    return window.delta.listAttachments()
  },
  drawingPath(path: string): string {
    return window.delta.drawingPath(path)
  },
  absolutePath(path: string): string {
    return window.delta.absolutePath(path)
  },
  isInsideVault(absPath: string): boolean {
    return window.delta.isInsideVault(absPath)
  },

  // --- notes ---------------------------------------------------------------
  indexNote(path: string): NoteRecord | null {
    return window.delta.indexNote(path)
  },
  listNotes(): NoteRecord[] {
    return window.delta.listNotes()
  },
  reindexAll(): number {
    return window.delta.reindexAll()
  },
  backlinks(path: string) {
    return window.delta.backlinks(path)
  },
  knowledgeGraph(): GraphData {
    return window.delta.knowledgeGraph()
  },
  resolveLink(target: string, fromPath: string): string | null {
    return window.delta.resolveLink(target, fromPath)
  },
  searchNotes(query: string, limit = 50): SearchResult[] {
    return window.delta.searchNotes(query, limit)
  },
  notesByTag(tag: string): NoteRecord[] {
    return window.delta.notesByTag(tag)
  },
  allTags(): string[] {
    return window.delta.allTags()
  },
  dailyNote(date: string, create: boolean): string {
    return window.delta.dailyNote(date, create)
  },
  detectChanges(): string[] {
    return window.delta.detectChanges()
  },

  // --- attachments ---------------------------------------------------------
  importAttachment(name: string, bytes: Uint8Array, fromNote?: string): AttachmentInfo {
    return window.delta.importAttachment(name, bytes, fromNote)
  },
  importAttachmentFromPath(absPath: string, fromNote?: string): AttachmentInfo {
    return window.delta.importAttachmentFromPath(absPath, fromNote)
  },

  // --- tasks & events ------------------------------------------------------
  listTasks(): TaskRecord[] {
    return window.delta.listTasks()
  },
  saveTask(task: Partial<TaskRecord> & { title: string }): TaskRecord {
    return window.delta.saveTask(task as unknown as Record<string, unknown>)
  },
  deleteTask(id: string): boolean {
    return window.delta.deleteTask(id)
  },
  listEvents(): EventRecord[] {
    return window.delta.listEvents()
  },
  saveEvent(event: Partial<EventRecord> & { title: string }): EventRecord {
    return window.delta.saveEvent(event as unknown as Record<string, unknown>)
  },
  deleteEvent(id: string): boolean {
    return window.delta.deleteEvent(id)
  },

  // --- calendar ------------------------------------------------------------
  exportCalendar(events: EventRecord[], name: string): string {
    return window.delta.exportCalendar(events, name)
  },
  importCalendar(text: string): EventRecord[] {
    return window.delta.importCalendar(text)
  },

  // --- settings ------------------------------------------------------------
  getSetting(key: string): string | null {
    return window.delta.getSetting(key)
  },
  setSetting(key: string, value: string): boolean {
    return window.delta.setSetting(key, value)
  },
  allSettings(): Record<string, string> {
    return window.delta.allSettings()
  },

  // --- recovery ------------------------------------------------------------
  saveRecovery(path: string, content: string): boolean {
    return window.delta.saveRecovery(path, content)
  },
  loadRecovery(): RecoveryEntry[] {
    return window.delta.loadRecovery()
  },
  clearRecovery(path: string): boolean {
    return window.delta.clearRecovery(path)
  },
  clearAllRecovery(): boolean {
    return window.delta.clearAllRecovery()
  },
  touchRecent(path: string): boolean {
    return window.delta.touchRecent(path)
  },
  recentPaths(limit = 20): string[] {
    return window.delta.recentPaths(limit)
  },

  // --- stats & backup ------------------------------------------------------
  stats(): VaultStats {
    return window.delta.stats()
  },
  createBackup(destDir: string): BackupInfo {
    return window.delta.createBackup(destDir)
  },
  listBackups(dir: string): BackupInfo[] {
    return window.delta.listBackups(dir)
  },
  restoreBackup(archive: string, destRoot: string): string {
    return window.delta.restoreBackup(archive, destRoot)
  },

  // --- voice ---------------------------------------------------------------
  ttsStatus(voiceDir?: string): TtsStatus {
    return window.delta.ttsStatus(voiceDir)
  },
  listTtsVoices(voiceDir?: string): TtsVoice[] {
    return window.delta.listTtsVoices(voiceDir)
  },
  speak(
    text: string,
    modelPath: string,
    piperPath?: string,
    lengthScale?: number,
    plain?: boolean,
  ): Promise<string> {
    return window.delta.speak(text, modelPath, piperPath, lengthScale, plain)
  },
  stopSpeaking(): boolean {
    return window.delta.stopSpeaking()
  },
  clearSpeechCache(): number {
    return window.delta.clearSpeechCache()
  },

  // --- sync ----------------------------------------------------------------
  syncStatus(repo?: string, branch?: string): SyncStatus {
    return window.delta.syncStatus(repo, branch)
  },
  syncSetup(repo: string, branch?: string, useLfs?: boolean): Promise<SyncResult> {
    return window.delta.syncSetup(repo, branch, useLfs)
  },
  syncPush(repo?: string, branch?: string, message?: string): Promise<SyncResult> {
    return window.delta.syncPush(repo, branch, message)
  },
  syncPull(repo?: string, branch?: string): Promise<SyncResult> {
    return window.delta.syncPull(repo, branch)
  },
  syncNow(repo?: string, branch?: string, message?: string): Promise<SyncResult> {
    return window.delta.syncNow(repo, branch, message)
  },
  setSyncToken(token: string): Promise<string> {
    return window.delta.setSyncToken(token)
  },
  getSyncToken(): Promise<string> {
    return window.delta.getSyncToken()
  },
  createGitHubRepo(name: string, isPrivate: boolean) {
    return window.delta.createGitHubRepo(name, isPrivate)
  },

  // --- misc ----------------------------------------------------------------
  sanitizeNoteName(name: string): string {
    return window.delta.sanitizeNoteName(name)
  },
  encodeMarkdownPath(path: string): string {
    return window.delta.encodeMarkdownPath(path)
  },
  humanSize(bytes: number): string {
    return window.delta.humanSize(bytes)
  },
  coreVersion(): string {
    return window.delta.coreVersion()
  },

  // --- events --------------------------------------------------------------
  onWatch(handler: (event: WatchEvent) => void): () => void {
    return window.delta.onWatch(handler)
  },
  onMenuCommand(handler: (command: string) => void): () => void {
    return window.delta.onMenuCommand(handler)
  },
  startWatching(root: string): void {
    ;(window.delta as unknown as { startWatching(root: string): void }).startWatching(root)
  },
  stopWatching(): void {
    ;(window.delta as unknown as { stopWatching(): void }).stopWatching()
  },
}
