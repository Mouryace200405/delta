import { contextBridge, ipcRenderer } from 'electron'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

/**
 * Locate the compiled Rust addon.
 *
 * In development the addon lives in `<repo>/native`; in a packaged build it is
 * copied into `resources/native`.
 */
function resolveCorePath(): string {
  const candidates: string[] = []

  // Packaged: resources/native/index.js
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'native', 'index.js'))
  }
  // Development: <repo>/native/index.js (preload is at <repo>/dist/preload)
  let dir = __dirname
  for (let i = 0; i < 6; i++) {
    candidates.push(join(dir, 'native', 'index.js'))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  candidates.push(join(process.cwd(), 'native', 'index.js'))

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    `Delta core not found. Looked in:\n${candidates.map((c) => `  - ${c}`).join('\n')}\n` +
      'Run `npm run build:native` to compile the Rust core.',
  )
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require(resolveCorePath())

/**
 * The N-API layer treats a missing property as "no value" but rejects an
 * explicit `null`. Stripping nullish keys lets the renderer use ordinary
 * JavaScript null semantics.
 */
function stripNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripNulls) as unknown as T
  if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === null || item === undefined) continue
      out[key] = stripNulls(item)
    }
    return out as T
  }
  return value
}

let vault: any = null
let watcher: any = null
/**
 * The GitHub token, held only in memory for the lifetime of the window. The
 * encrypted copy lives in the operating system's key store, in the main
 * process.
 */
let syncToken = ''

/** Fetch the stored token once, the first time a sync is attempted. */
async function ensureSyncToken(): Promise<string> {
  if (!syncToken) {
    try {
      syncToken = (await ipcRenderer.invoke('delta:get-sync-token')) as string
    } catch {
      syncToken = ''
    }
  }
  return syncToken
}

const api = {
  /** Vault path supplied on the command line, if any. */
  initialVaultPath(): string | null {
    const arg = process.argv.find((value) => value.startsWith('--vault='))
    return arg ? arg.slice('--vault='.length) : null
  },

  // ----------------------------------------------------------------- vault
  openVault(path: string) {
    vault = new core.Vault(path)
    vault.reindexAll()
    return vault.info()
  },
  closeVault() {
    if (watcher) {
      try {
        watcher.close()
      } catch {
        /* already closed */
      }
      watcher = null
    }
    vault = null
  },
  vaultInfo() {
    return vault ? vault.info() : null
  },
  openVaultDialog() {
    return ipcRenderer.invoke('delta:open-vault-dialog') as Promise<string | null>
  },
  pickFolder(title: string) {
    return ipcRenderer.invoke('delta:pick-folder', title) as Promise<string | null>
  },
  pickFiles(extensions: string[]) {
    return ipcRenderer.invoke('delta:pick-files', extensions) as Promise<string[]>
  },
  saveFileDialog(defaultName: string, extensions: string[]) {
    return ipcRenderer.invoke('delta:save-file', defaultName, extensions) as Promise<string | null>
  },

  // ------------------------------------------------------------ filesystem
  tree() {
    return vault ? vault.tree() : []
  },
  readFile(path: string) {
    return vault.readFile(path)
  },
  readBytes(path: string) {
    return new Uint8Array(vault.readBytes(path))
  },
  fileExists(path: string) {
    return vault.fileExists(path)
  },
  writeFile(path: string, content: string) {
    return vault.writeFile(path, content)
  },
  createFile(path: string, content?: string) {
    return vault.createFile(path, content ?? '')
  },
  createFolder(path: string) {
    return vault.createFolder(path)
  },
  renameEntry(path: string, newPath: string) {
    return vault.rename(path, newPath)
  },
  moveEntry(path: string, destDir: string) {
    return vault.moveEntry(path, destDir)
  },
  deleteEntry(path: string) {
    return vault.delete(path)
  },
  listTrash() {
    return vault.listTrash()
  },
  restoreFromTrash(name: string) {
    return vault.restoreFromTrash(name)
  },
  purgeTrash() {
    return vault.purgeTrash()
  },
  listAttachments() {
    return vault.listAttachments()
  },
  drawingPath(path: string) {
    return vault.drawingPath(path)
  },
  absolutePath(path: string) {
    return vault.absolutePath(path)
  },
  isInsideVault(absPath: string) {
    return vault.isInsideVault(absPath)
  },

  // ----------------------------------------------------------------- notes
  indexNote(path: string) {
    return vault.indexNote(path)
  },
  listNotes() {
    return vault.listNotes()
  },
  reindexAll() {
    return vault.reindexAll()
  },
  backlinks(path: string) {
    return vault.backlinks(path)
  },
  knowledgeGraph() {
    return vault.knowledgeGraph()
  },
  resolveLink(target: string, fromPath: string) {
    return vault.resolveLink(target, fromPath)
  },
  searchNotes(query: string, limit?: number) {
    return vault.searchNotes(query, limit ?? 50)
  },
  notesByTag(tag: string) {
    return vault.notesByTag(tag)
  },
  allTags() {
    return vault.allTags()
  },
  dailyNote(date: string, create: boolean) {
    return vault.dailyNote(date, create)
  },
  detectChanges() {
    return vault.detectChanges()
  },

  // ----------------------------------------------------------- attachments
  importAttachment(name: string, bytes: Uint8Array, fromNote?: string) {
    return vault.importAttachment(name, Buffer.from(bytes), fromNote)
  },
  importAttachmentFromPath(absPath: string, fromNote?: string) {
    return vault.importAttachmentFromPath(absPath, fromNote)
  },

  // -------------------------------------------------------- tasks, events
  listTasks() {
    return vault.listTasks()
  },
  saveTask(task: Record<string, unknown>) {
    return vault.saveTask({
      created_at: 0,
      updated_at: 0,
      ...stripNulls(task),
    })
  },
  deleteTask(id: string) {
    return vault.deleteTask(id)
  },
  listEvents() {
    return vault.listEvents()
  },
  saveEvent(event: Record<string, unknown>) {
    return vault.saveEvent({
      created_at: 0,
      updated_at: 0,
      exdates: [],
      ...stripNulls(event),
    })
  },
  deleteEvent(id: string) {
    return vault.deleteEvent(id)
  },

  // -------------------------------------------------------------- calendar
  exportCalendar(events: unknown[], name: string) {
    return core.exportCalendar(events, name)
  },
  importCalendar(text: string) {
    return core.importCalendar(text)
  },

  // -------------------------------------------------------------- settings
  getSetting(key: string) {
    return vault.getSetting(key)
  },
  setSetting(key: string, value: string) {
    return vault.setSetting(key, value)
  },
  allSettings() {
    return vault.allSettings()
  },

  // -------------------------------------------------------------- recovery
  saveRecovery(path: string, content: string) {
    return vault.saveRecovery(path, content)
  },
  loadRecovery() {
    return vault.loadRecovery()
  },
  clearRecovery(path: string) {
    return vault.clearRecovery(path)
  },
  clearAllRecovery() {
    return vault.clearAllRecovery()
  },
  touchRecent(path: string) {
    return vault.touchRecent(path)
  },
  recentPaths(limit?: number) {
    return vault.recentPaths(limit ?? 20)
  },

  // ---------------------------------------------------------- stats/backup
  stats() {
    return vault.stats()
  },
  createBackup(destDir: string) {
    return core.createBackup(vault.rootPath(), destDir)
  },
  listBackups(dir: string) {
    return core.listBackups(dir)
  },
  restoreBackup(archive: string, destRoot: string) {
    return core.restoreBackup(archive, destRoot)
  },

  // ------------------------------------------------------------------ voice
  ttsStatus(voiceDir?: string) {
    return core.ttsStatus(voiceDir ?? null)
  },
  listTtsVoices(voiceDir?: string) {
    return core.listTtsVoices(voiceDir ?? null)
  },
  speak(
    text: string,
    modelPath: string,
    piperPath?: string,
    lengthScale?: number,
    plain?: boolean,
  ) {
    return core.speak(text, modelPath, piperPath ?? null, lengthScale ?? null, plain ?? null)
  },
  stopSpeaking() {
    return core.stopSpeaking()
  },
  clearSpeechCache() {
    return core.clearSpeechCache()
  },
  /**
   * The URL the renderer can play a generated WAV from.
   *
   * A `blob:` URL would be the obvious choice, but Chromium refuses to load
   * media from one: the page lives on `file://`, whose origin is opaque, and
   * the media loader rejects anything it cannot match to that origin. A plain
   * file URL works, and the path is encoded the way a URL needs it.
   */
  audioFileUrl(absPath: string) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { pathToFileURL } = require('node:url')
    return pathToFileURL(absPath).href
  },

  // ------------------------------------------------------------------- sync
  syncStatus(repo?: string, branch?: string) {
    return core.syncStatus(vault.rootPath(), repo ?? null, branch ?? null)
  },
  syncSetup(repo: string, branch?: string, useLfs?: boolean) {
    return core.syncSetup(vault.rootPath(), repo, branch ?? null, useLfs ?? null)
  },
  async syncPush(repo?: string, branch?: string, message?: string) {
    return core.syncPush(
      vault.rootPath(),
      repo ?? null,
      branch ?? null,
      await ensureSyncToken(),
      message ?? null,
    )
  },
  async syncPull(repo?: string, branch?: string) {
    return core.syncPull(
      vault.rootPath(),
      repo ?? null,
      branch ?? null,
      await ensureSyncToken(),
    )
  },
  async syncNow(repo?: string, branch?: string, message?: string) {
    return core.syncNow(
      vault.rootPath(),
      repo ?? null,
      branch ?? null,
      await ensureSyncToken(),
      message ?? null,
    )
  },
  async setSyncToken(token: string) {
    syncToken = (await ipcRenderer.invoke('delta:set-sync-token', token)) as string
  },
  async getSyncToken() {
    return (await ipcRenderer.invoke('delta:get-sync-token')) as string
  },
  createGitHubRepo(name: string, isPrivate: boolean) {
    return ipcRenderer.invoke('delta:create-github-repo', name, isPrivate) as Promise<{
      ok: boolean
      repo: string
      message: string
    }>
  },

  // ------------------------------------------------------------------ misc
  sanitizeNoteName(name: string) {
    return core.sanitizeNoteName(name)
  },
  encodeMarkdownPath(path: string) {
    return core.encodeMarkdownPath(path)
  },
  humanSize(bytes: number) {
    return core.humanSize(bytes)
  },
  coreVersion() {
    return core.coreVersion()
  },

  // ------------------------------------------------------- watcher bridge
  /** Start watching the vault and forward change batches to the renderer. */
  startWatching(root: string) {
    if (watcher) {
      try {
        watcher.close()
      } catch {
        /* already closed */
      }
    }
    // A Node-API threadsafe function calls back with (error, value); the
    // error arrives first and is null when the call succeeded.
    watcher = new core.FileWatcher(
      root,
      (error: unknown, event: { kind: string; paths: string[] } | null) => {
        if (error || !event) return
        ipcRenderer.send('delta:watch-event', event)
      },
    )
  },
  stopWatching() {
    if (watcher) {
      try {
        watcher.close()
      } catch {
        /* already closed */
      }
      watcher = null
    }
  },
  onWatch(handler: (event: { kind: string; paths: string[] }) => void) {
    const listener = (_e: unknown, event: { kind: string; paths: string[] }) => handler(event)
    ipcRenderer.on('delta:watch-event', listener)
    return () => ipcRenderer.removeListener('delta:watch-event', listener)
  },
  onMenuCommand(handler: (command: string) => void) {
    const listener = (_e: unknown, command: string) => handler(command)
    ipcRenderer.on('delta:menu-command', listener)
    return () => ipcRenderer.removeListener('delta:menu-command', listener)
  },
}

// Wrap every entry point so a failing call is reported with its name.
const wrapped: Record<string, unknown> = {}
for (const [name, value] of Object.entries(api)) {
  if (typeof value !== 'function') {
    wrapped[name] = value
    continue
  }
  wrapped[name] = (...args: unknown[]) => {
    try {
      return (value as (...a: unknown[]) => unknown)(...args)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[delta-core] ${name} failed: ${message}`)
      console.error(
        `[delta-core] ${name} args: ${JSON.stringify(args, (_key, value) =>
          value instanceof Uint8Array ? `<${value.length} bytes>` : value,
        )}`,
      )
      throw error
    }
  }
}

contextBridge.exposeInMainWorld('delta', wrapped)
