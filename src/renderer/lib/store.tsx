import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react'
import type {
  CalendarMode,
  ContentFont,
  EventRecord,
  GraphData,
  NoteRecord,
  SearchResult,
  TaskRecord,
  ThemeName,
  TreeEntry,
  NoteViewMode,
  VaultInfo,
  ViewName,
  WatchEvent,
} from '@shared/types'
import { api } from './api'

export interface BufferState {
  /** Current editor content. */
  content: string
  /** Last content known to be written to disk. */
  saved: string
  dirty: boolean
  /** Set when the file changed on disk while the buffer had unsaved edits. */
  conflict: { theirs: string } | null
  /** Monotonic timestamp of the last local edit. */
  touchedAt: number
}

export interface Toast {
  id: number
  kind: 'info' | 'error' | 'success' | 'warn'
  text: string
}

export type TaskFilter =
  | 'all'
  | 'today'
  | 'upcoming'
  | 'overdue'
  | 'completed'
  | 'priority'
  | 'status'

export interface RecurrenceAction {
  type: 'move' | 'delete' | 'edit'
  event: EventRecord
  /** Start timestamp of the occurrence the user acted on. */
  occurrenceStart: number
  newStart?: number
  newEnd?: number
  newTitle?: string
}

export interface ModalState {
  kind:
    | 'new-note'
    | 'new-folder'
    | 'rename'
    | 'task'
    | 'event'
    | 'shortcuts'
    | 'about'
    | 'delete-confirm'
    | 'backup'
    | 'restore'
    | 'recurrence-scope'
  target?: string
  draft?: Partial<TaskRecord> & { title: string }
  eventDraft?: Partial<EventRecord> & { title: string }
  recurrence?: RecurrenceAction
}

export interface AppState {
  ready: boolean
  vault: VaultInfo | null
  tree: TreeEntry[]
  notes: NoteRecord[]
  tags: string[]
  tasks: TaskRecord[]
  events: EventRecord[]
  openTabs: string[]
  activePath: string | null
  buffers: Record<string, BufferState>
  view: ViewName
  viewMode: NoteViewMode
  theme: ThemeName
  contentFont: ContentFont
  calendarMode: CalendarMode
  calendarCursor: string
  taskFilter: TaskFilter
  searchQuery: string
  searchResults: SearchResult[]
  paletteOpen: boolean
  paletteMode: 'quick' | 'command'
  toasts: Toast[]
  saveState: 'idle' | 'saving' | 'saved' | 'error'
  modal: ModalState | null
  drawingPath: string | null
  activeTag: string | null
  history: string[]
  historyIndex: number
  /** The knowledge graph of the vault. */
  graph: GraphData
  /** Whether the graph panel at the bottom of the sidebar is open. */
  graphOpen: boolean
}

const initialState: AppState = {
  ready: false,
  vault: null,
  tree: [],
  notes: [],
  tags: [],
  tasks: [],
  events: [],
  openTabs: [],
  activePath: null,
  buffers: {},
  view: 'notes',
  viewMode: 'reading',
  theme: 'nord-dark',
  contentFont: 'iosevka',
  calendarMode: 'month',
  calendarCursor: new Date().toISOString().slice(0, 10),
  taskFilter: 'all',
  searchQuery: '',
  searchResults: [],
  paletteOpen: false,
  paletteMode: 'quick',
  toasts: [],
  saveState: 'idle',
  modal: null,
  drawingPath: null,
  activeTag: null,
  history: [],
  historyIndex: -1,
  graph: { nodes: [], edges: [] },
  graphOpen: false,
}

type Action =
  | { type: 'reset' }
  | { type: 'ready'; ready: boolean }
  | { type: 'vault'; vault: VaultInfo | null }
  | { type: 'tree'; tree: TreeEntry[] }
  | { type: 'notes'; notes: NoteRecord[] }
  | { type: 'tags'; tags: string[] }
  | { type: 'tasks'; tasks: TaskRecord[] }
  | { type: 'events'; events: EventRecord[] }
  | { type: 'tabs'; tabs: string[] }
  | { type: 'active'; path: string | null }
  | { type: 'buffer'; path: string; buffer: BufferState }
  | { type: 'buffer-content'; path: string; content: string }
  | { type: 'buffer-saved'; path: string; content: string }
  | { type: 'buffer-conflict'; path: string; theirs: string | null }
  | { type: 'drop-buffer'; path: string }
  | { type: 'view'; view: ViewName }
  | { type: 'view-mode'; mode: NoteViewMode }
  | { type: 'theme'; theme: ThemeName }
  | { type: 'content-font'; font: ContentFont }
  | { type: 'calendar-mode'; mode: CalendarMode }
  | { type: 'calendar-cursor'; cursor: string }
  | { type: 'task-filter'; filter: TaskFilter }
  | { type: 'search'; query: string; results: SearchResult[] }
  | { type: 'palette'; open: boolean; mode?: 'quick' | 'command' }
  | { type: 'toast-add'; toast: Toast }
  | { type: 'toast-remove'; id: number }
  | { type: 'save-state'; state: AppState['saveState'] }
  | { type: 'modal'; modal: ModalState | null }
  | { type: 'drawing'; path: string | null }
  | { type: 'active-tag'; tag: string | null }
  | { type: 'history'; history: string[]; index: number }
  | { type: 'graph'; graph: GraphData }
  | { type: 'graph-open'; open: boolean }

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'reset':
      return { ...initialState, ready: state.ready, theme: state.theme, contentFont: state.contentFont }
    case 'ready':
      return { ...state, ready: action.ready }
    case 'vault':
      return { ...state, vault: action.vault }
    case 'tree':
      return { ...state, tree: action.tree }
    case 'notes':
      return { ...state, notes: action.notes }
    case 'tags':
      return { ...state, tags: action.tags }
    case 'tasks':
      return { ...state, tasks: action.tasks }
    case 'events':
      return { ...state, events: action.events }
    case 'tabs':
      return { ...state, openTabs: action.tabs }
    case 'active':
      return { ...state, activePath: action.path }
    case 'buffer':
      return { ...state, buffers: { ...state.buffers, [action.path]: action.buffer } }
    case 'buffer-content':
      return {
        ...state,
        buffers: {
          ...state.buffers,
          [action.path]: {
            ...state.buffers[action.path],
            content: action.content,
            dirty: action.content !== state.buffers[action.path].saved,
            touchedAt: Date.now(),
          },
        },
      }
    case 'buffer-saved':
      return {
        ...state,
        buffers: {
          ...state.buffers,
          [action.path]: {
            ...state.buffers[action.path],
            saved: action.content,
            content: action.content,
            dirty: false,
            conflict: null,
          },
        },
      }
    case 'buffer-conflict': {
      const buffer = state.buffers[action.path]
      if (!buffer) return state
      return {
        ...state,
        buffers: {
          ...state.buffers,
          [action.path]: {
            ...buffer,
            conflict: action.theirs === null ? null : { theirs: action.theirs },
          },
        },
      }
    }
    case 'drop-buffer': {
      const buffers = { ...state.buffers }
      delete buffers[action.path]
      return { ...state, buffers }
    }
    case 'view':
      return { ...state, view: action.view }
    case 'view-mode':
      return { ...state, viewMode: action.mode }
    case 'theme':
      return { ...state, theme: action.theme }
    case 'content-font':
      return { ...state, contentFont: action.font }
    case 'calendar-mode':
      return { ...state, calendarMode: action.mode }
    case 'calendar-cursor':
      return { ...state, calendarCursor: action.cursor }
    case 'task-filter':
      return { ...state, taskFilter: action.filter }
    case 'search':
      return { ...state, searchQuery: action.query, searchResults: action.results }
    case 'palette':
      return { ...state, paletteOpen: action.open, paletteMode: action.mode ?? state.paletteMode }
    case 'toast-add':
      return { ...state, toasts: [...state.toasts, action.toast] }
    case 'toast-remove':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) }
    case 'save-state':
      return { ...state, saveState: action.state }
    case 'modal':
      return { ...state, modal: action.modal }
    case 'drawing':
      return { ...state, drawingPath: action.path }
    case 'active-tag':
      return { ...state, activeTag: action.tag }
    case 'history':
      return { ...state, history: action.history, historyIndex: action.index }
    case 'graph':
      return { ...state, graph: action.graph }
    case 'graph-open':
      return { ...state, graphOpen: action.open }
    default:
      return state
  }
}

export interface AppActions {
  openVault(path: string): void
  chooseVault(): Promise<void>
  refreshTree(): void
  refreshNotes(): void
  refreshTasks(): void
  refreshEvents(): void
  refreshGraph(): void
  setGraphOpen(open: boolean): void
  openNote(path: string): void
  closeTab(path: string): void
  closeOtherTabs(path: string): void
  closeTabsToRight(path: string): void
  closeAllTabs(): void
  moveTab(from: number, to: number): void
  setActiveTab(path: string): void
  setBufferContent(path: string, content: string): void
  saveNote(path: string, options?: { silent?: boolean }): Promise<void>
  saveActiveNote(): Promise<void>
  createNote(name: string, folder?: string): void
  createFolder(name: string, folder?: string): void
  renameEntry(path: string, newName: string): void
  moveEntry(path: string, destDir: string): void
  deleteEntry(path: string): void
  restoreFromTrash(name: string): void
  purgeTrash(): void
  insertImage(bytes: Uint8Array, name: string): Promise<void>
  importImageFromDisk(absPath: string): Promise<void>
  insertTextAtCursor(text: string): void
  insertLink(title: string): void
  saveTask(task: Partial<TaskRecord> & { title: string }): void
  toggleTask(task: TaskRecord): void
  deleteTask(id: string): void
  saveEvent(event: Partial<EventRecord> & { title: string }): void
  deleteEvent(id: string): void
  scheduleTaskOnCalendar(task: TaskRecord, date: string): void
  search(query: string): void
  openDailyNote(date: string): void
  setView(view: ViewName): void
  setViewMode(mode: NoteViewMode): void
  cycleViewMode(): void
  setTaskFilter(filter: TaskFilter): void
  setCalendarMode(mode: CalendarMode): void
  setCalendarCursor(cursor: string): void
  setActiveTag(tag: string | null): void
  setPalette(open: boolean, mode?: 'quick' | 'command'): void
  setModal(modal: ModalState | null): void
  toast(kind: Toast['kind'], text: string): void
  dismissToast(id: number): void
  toggleTheme(): void
  setTheme(theme: ThemeName): void
  setContentFont(font: ContentFont): void
  goBack(): void
  goForward(): void
  createBackup(): Promise<void>
  restoreBackup(archivePath: string): Promise<void>
}

const StateContext = createContext<AppState>(initialState)
const ActionsContext = createContext<AppActions | null>(null)

export function useAppState(): AppState {
  return useContext(StateContext)
}

export function useActions(): AppActions {
  const actions = useContext(ActionsContext)
  if (!actions) throw new Error('useActions must be used inside <AppProvider>')
  return actions
}

const AUTOSAVE_DELAY = 700

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const stateRef = useRef(state)
  stateRef.current = state
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const toastId = useRef(1)

  const toast = useCallback((kind: Toast['kind'], text: string) => {
    const id = toastId.current++
    dispatch({ type: 'toast-add', toast: { id, kind, text } })
    setTimeout(() => dispatch({ type: 'toast-remove', id }), kind === 'error' ? 8000 : 4000)
  }, [])

  const dismissToast = useCallback((id: number) => {
    dispatch({ type: 'toast-remove', id })
  }, [])

  const refreshTree = useCallback(() => {
    if (!stateRef.current.vault) return
    try {
      dispatch({ type: 'tree', tree: api.tree() })
    } catch (error) {
      toast('error', `Could not read the vault: ${describe(error)}`)
    }
  }, [toast])

  const refreshNotes = useCallback(() => {
    if (!stateRef.current.vault) return
    try {
      // The index is kept current as notes are written, so listing them does
      // not mean re-reading every file.
      dispatch({ type: 'notes', notes: api.listNotes() })
      dispatch({ type: 'tags', tags: api.allTags() })
      // Links may have changed, so the graph is rebuilt from the same index.
      dispatch({ type: 'graph', graph: api.knowledgeGraph() })
    } catch (error) {
      toast('error', `Could not index notes: ${describe(error)}`)
    }
  }, [toast])

  const refreshTasks = useCallback(() => {
    if (!stateRef.current.vault) return
    try {
      dispatch({ type: 'tasks', tasks: api.listTasks() })
    } catch (error) {
      toast('error', `Could not load tasks: ${describe(error)}`)
    }
  }, [toast])

  const refreshEvents = useCallback(() => {
    if (!stateRef.current.vault) return
    try {
      dispatch({ type: 'events', events: api.listEvents() })
    } catch (error) {
      toast('error', `Could not load events: ${describe(error)}`)
    }
  }, [toast])

  const refreshGraph = useCallback(() => {
    if (!stateRef.current.vault) return
    try {
      dispatch({ type: 'graph', graph: api.knowledgeGraph() })
    } catch (error) {
      // A missing graph is not worth a toast — the panel simply stays empty.
      console.warn('Could not build the knowledge graph:', describe(error))
    }
  }, [])

  const setGraphOpen = useCallback((open: boolean) => {
    dispatch({ type: 'graph-open', open })
    try {
      api.setSetting('graphOpen', open ? '1' : '0')
    } catch {
      /* settings are best-effort */
    }
  }, [])

  const openNote = useCallback(
    (path: string) => {
      const current = stateRef.current
      if (current.buffers[path]) {
        dispatch({ type: 'active', path })
        dispatch({ type: 'tabs', tabs: current.openTabs.includes(path) ? current.openTabs : [...current.openTabs, path] })
        return
      }
      try {
        const content = api.readFile(path)
        dispatch({
          type: 'buffer',
          path,
          buffer: { content, saved: content, dirty: false, conflict: null, touchedAt: Date.now() },
        })
        dispatch({ type: 'tabs', tabs: current.openTabs.includes(path) ? current.openTabs : [...current.openTabs, path] })
        dispatch({ type: 'active', path })
        api.touchRecent(path)
        const history = current.history.slice(0, current.historyIndex + 1)
        history.push(path)
        dispatch({ type: 'history', history: history.slice(-60), index: Math.min(history.length, 60) - 1 })
      } catch (error) {
        toast('error', `Could not open “${path}”: ${describe(error)}`)
      }
    },
    [toast],
  )

  /**
   * Put back the tabs that were open when the vault was last closed.
   *
   * A tab whose file has since been deleted is quietly dropped, and the
   * notes are read straight from disk so the workspace comes back as it was.
   */
  const restoreWorkspace = useCallback((vaultPath: string) => {
    const empty = { tabs: [] as string[], active: null as string | null }
    let saved: { tabs?: string[]; active?: string | null } | null = null
    try {
      const raw = api.getSetting(`workspace:${vaultPath}`)
      if (!raw) return empty
      saved = JSON.parse(raw) as { tabs?: string[]; active?: string | null }
    } catch {
      return empty
    }

    const tabs: string[] = []
    for (const notePath of saved?.tabs ?? []) {
      try {
        if (!api.fileExists(notePath)) continue
        const content = api.readFile(notePath)
        dispatch({
          type: 'buffer',
          path: notePath,
          buffer: { content, saved: content, dirty: false, conflict: null, touchedAt: Date.now() },
        })
        tabs.push(notePath)
      } catch {
        /* the file went away between the check and the read */
      }
    }
    if (tabs.length === 0) return empty

    const wanted = saved?.active ?? null
    const active = wanted && tabs.includes(wanted) ? wanted : tabs[0]
    return { tabs, active }
  }, [])

  /** Remember the open tabs so the workspace comes back next time. */
  const saveWorkspace = useCallback((tabs: string[], active: string | null) => {
    const vaultPath = stateRef.current.vault?.path
    if (!vaultPath) return
    try {
      api.setSetting(`workspace:${vaultPath}`, JSON.stringify({ tabs, active }))
    } catch {
      /* settings are best-effort */
    }
  }, [])

  const openVault = useCallback(
    (path: string) => {
      try {
        const info = api.openVault(path)
        dispatch({ type: 'vault', vault: info })
        dispatch({ type: 'tree', tree: api.tree() })
        dispatch({ type: 'tasks', tasks: api.listTasks() })
        dispatch({ type: 'events', events: api.listEvents() })
        // Read the index directly: `stateRef` still holds the previous vault
        // at this point, so the guarded refresh helpers would bail out.
        dispatch({ type: 'notes', notes: api.listNotes() })
        dispatch({ type: 'tags', tags: api.allTags() })
        dispatch({ type: 'graph', graph: api.knowledgeGraph() })
        dispatch({ type: 'tabs', tabs: [] })
        dispatch({ type: 'active', path: null })
        dispatch({ type: 'drawing', path: null })
        api.startWatching(info.path)
        toast('success', `Opened vault “${info.name}”`)

        // Put back the tabs that were open when this vault was last closed.
        const restored = restoreWorkspace(info.path)
        if (restored.tabs.length > 0) {
          dispatch({ type: 'tabs', tabs: restored.tabs })
          dispatch({ type: 'active', path: restored.active })
        } else {
          // Otherwise fall back to the most recently opened note, or the
          // first note in the vault, so the workspace is never empty.
          const recent = api.recentPaths(1)
          if (recent.length > 0 && api.fileExists(recent[0])) {
            openNote(recent[0])
          } else {
            const firstNote = api
              .tree()
              .find((entry) => entry.kind === 'file' && entry.extension === 'md')
            if (firstNote) openNote(firstNote.path)
          }
        }

        // Offer to restore anything left unsaved by a previous session.
        const recoveries = api.loadRecovery()
        for (const recovery of recoveries) {
          try {
            const onDisk = api.readFile(recovery.path)
            if (onDisk === recovery.content) {
              api.clearRecovery(recovery.path)
              continue
            }
            dispatch({
              type: 'buffer',
              path: recovery.path,
              buffer: {
                content: recovery.content,
                saved: onDisk,
                dirty: true,
                conflict: { theirs: onDisk },
                touchedAt: Date.now(),
              },
            })
          } catch {
            api.clearRecovery(recovery.path)
          }
        }
      } catch (error) {
        toast('error', `Could not open vault: ${describe(error)}`)
      }
    },
    [toast, refreshNotes, openNote],
  )

  const chooseVault = useCallback(async () => {
    const path = await api.openVaultDialog()
    if (path) openVault(path)
  }, [openVault])

  const closeTab = useCallback((path: string) => {
    const current = stateRef.current
    const tabs = current.openTabs.filter((p) => p !== path)
    dispatch({ type: 'tabs', tabs })
    if (current.activePath === path) {
      const index = current.openTabs.indexOf(path)
      const next = tabs[index] ?? tabs[index - 1] ?? tabs[0] ?? null
      dispatch({ type: 'active', path: next })
    }
  }, [])

  const setActiveTab = useCallback((path: string) => {
    dispatch({ type: 'active', path })
  }, [])

  /** Close every tab except the one that was clicked. */
  const closeOtherTabs = useCallback((path: string) => {
    dispatch({ type: 'tabs', tabs: [path] })
    dispatch({ type: 'active', path })
  }, [])

  /** Close the tabs to the right of the one that was clicked. */
  const closeTabsToRight = useCallback((path: string) => {
    const current = stateRef.current
    const index = current.openTabs.indexOf(path)
    if (index < 0) return
    const tabs = current.openTabs.slice(0, index + 1)
    dispatch({ type: 'tabs', tabs })
    if (current.activePath && !tabs.includes(current.activePath)) {
      dispatch({ type: 'active', path: tabs[tabs.length - 1] ?? null })
    }
  }, [])

  /** Close every tab. */
  const closeAllTabs = useCallback(() => {
    dispatch({ type: 'tabs', tabs: [] })
    dispatch({ type: 'active', path: null })
  }, [])

  /** Move a tab to another position in the bar. */
  const moveTab = useCallback((from: number, to: number) => {
    const current = stateRef.current
    const tabs = [...current.openTabs]
    if (from < 0 || from >= tabs.length || to < 0 || to >= tabs.length || from === to) {
      return
    }
    const [moved] = tabs.splice(from, 1)
    tabs.splice(to, 0, moved)
    dispatch({ type: 'tabs', tabs })
  }, [])

  const saveNote = useCallback(
    async (path: string, options?: { silent?: boolean }) => {
      const buffer = stateRef.current.buffers[path]
      if (!buffer) return
      try {
        dispatch({ type: 'save-state', state: 'saving' })
        api.writeFile(path, buffer.content)
        api.clearRecovery(path)
        dispatch({ type: 'buffer-saved', path, content: buffer.content })
        dispatch({ type: 'save-state', state: 'saved' })
        if (!options?.silent) toast('success', `Saved ${path}`)
        refreshNotes()
      } catch (error) {
        dispatch({ type: 'save-state', state: 'error' })
        toast('error', `Could not save “${path}”: ${describe(error)}`)
      }
    },
    [toast, refreshNotes],
  )

  const saveActiveNote = useCallback(async () => {
    const path = stateRef.current.activePath
    if (path) await saveNote(path)
  }, [saveNote])

  const setBufferContent = useCallback(
    (path: string, content: string) => {
      dispatch({ type: 'buffer-content', path, content })
      // Persist the unsaved buffer so a crash cannot lose work.
      try {
        api.saveRecovery(path, content)
      } catch {
        /* recovery is best-effort */
      }
      const existing = timers.current.get(path)
      if (existing) clearTimeout(existing)
      timers.current.set(
        path,
        setTimeout(() => {
          timers.current.delete(path)
          void saveNote(path, { silent: true })
        }, AUTOSAVE_DELAY),
      )
    },
    [saveNote],
  )

  const createNote = useCallback(
    (name: string, folder?: string) => {
      const base = api.sanitizeNoteName(name)
      const parent = folder ? folder.replace(/\/$/, '') : ''
      const path = parent ? `${parent}/${base}` : base
      try {
        if (api.fileExists(path)) {
          toast('warn', `“${path}” already exists`)
          openNote(path)
          return
        }
        api.createFile(path, `# ${name.replace(/\.md$/, '')}\n\n`)
        refreshTree()
        refreshNotes()
        openNote(path)
      } catch (error) {
        toast('error', `Could not create the note: ${describe(error)}`)
      }
    },
    [openNote, refreshNotes, refreshTree, toast],
  )

  const createFolder = useCallback(
    (name: string, folder?: string) => {
      const parent = folder ? folder.replace(/\/$/, '') : ''
      const path = parent ? `${parent}/${name}` : name
      try {
        api.createFolder(path)
        refreshTree()
      } catch (error) {
        toast('error', `Could not create the folder: ${describe(error)}`)
      }
    },
    [refreshTree, toast],
  )

  const renameEntry = useCallback(
    (path: string, newName: string) => {
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
      const target = parent ? `${parent}/${newName}` : newName
      try {
        api.renameEntry(path, target)
        dispatch({ type: 'drop-buffer', path })
        const current = stateRef.current
        dispatch({
          type: 'tabs',
          tabs: current.openTabs.map((p) => (p === path ? target : p)),
        })
        if (current.activePath === path) dispatch({ type: 'active', path: target })
        refreshTree()
        refreshNotes()
        toast('success', `Renamed to ${target}`)
      } catch (error) {
        toast('error', `Could not rename: ${describe(error)}`)
      }
    },
    [refreshNotes, refreshTree, toast],
  )

  const moveEntry = useCallback(
    (path: string, destDir: string) => {
      try {
        const target = api.moveEntry(path, destDir)
        dispatch({ type: 'drop-buffer', path })
        const current = stateRef.current
        dispatch({
          type: 'tabs',
          tabs: current.openTabs.map((p) => (p === path ? target : p)),
        })
        if (current.activePath === path) dispatch({ type: 'active', path: target })
        refreshTree()
        refreshNotes()
        toast('success', `Moved to ${target}`)
      } catch (error) {
        toast('error', `Could not move: ${describe(error)}`)
      }
    },
    [refreshNotes, refreshTree, toast],
  )

  const deleteEntry = useCallback(
    (path: string) => {
      try {
        api.deleteEntry(path)
        dispatch({ type: 'drop-buffer', path })
        const current = stateRef.current
        dispatch({ type: 'tabs', tabs: current.openTabs.filter((p) => p !== path) })
        if (current.activePath === path) dispatch({ type: 'active', path: null })
        refreshTree()
        refreshNotes()
        toast('success', `Moved “${path}” to the trash`)
      } catch (error) {
        toast('error', `Could not delete: ${describe(error)}`)
      }
    },
    [refreshNotes, refreshTree, toast],
  )

  const restoreFromTrash = useCallback(
    (name: string) => {
      try {
        api.restoreFromTrash(name)
        refreshTree()
        refreshNotes()
        toast('success', `Restored “${name}”`)
      } catch (error) {
        toast('error', `Could not restore: ${describe(error)}`)
      }
    },
    [refreshNotes, refreshTree, toast],
  )

  const purgeTrash = useCallback(() => {
    try {
      const count = api.purgeTrash()
      refreshTree()
      toast('success', `Emptied the trash (${count} item${count === 1 ? '' : 's'})`)
    } catch (error) {
      toast('error', `Could not empty the trash: ${describe(error)}`)
    }
  }, [refreshTree, toast])

  const insertImage = useCallback(
    async (bytes: Uint8Array, name: string) => {
      const path = stateRef.current.activePath
      if (!path) {
        toast('warn', 'Open a note before inserting an image')
        return
      }
      try {
        const info = api.importAttachment(name, bytes, path)
        const markdown = `![${info.path.split('/').pop()}](${info.markdownRef})`
        const buffer = stateRef.current.buffers[path]
        if (buffer) {
          setBufferContent(path, `${buffer.content}\n${markdown}\n`)
        }
        toast('success', `Attached ${info.path}`)
      } catch (error) {
        toast('error', `Could not attach the image: ${describe(error)}`)
      }
    },
    [setBufferContent, toast],
  )

  const importImageFromDisk = useCallback(
    async (absPath: string) => {
      const path = stateRef.current.activePath
      if (!path) {
        toast('warn', 'Open a note before importing an image')
        return
      }
      try {
        const info = api.importAttachmentFromPath(absPath, path)
        const markdown = `![${info.path.split('/').pop()}](${info.markdownRef})`
        const buffer = stateRef.current.buffers[path]
        if (buffer) setBufferContent(path, `${buffer.content}\n${markdown}\n`)
        toast('success', `Attached ${info.path}`)
      } catch (error) {
        toast('error', `Could not import the image: ${describe(error)}`)
      }
    },
    [setBufferContent, toast],
  )

  const insertTextAtCursor = useCallback(
    (text: string) => {
      const path = stateRef.current.activePath
      const buffer = path ? stateRef.current.buffers[path] : undefined
      if (!path || !buffer) return
      setBufferContent(path, `${buffer.content}${text}`)
    },
    [setBufferContent],
  )

  const insertLink = useCallback(
    (title: string) => {
      const path = stateRef.current.activePath
      const buffer = path ? stateRef.current.buffers[path] : undefined
      if (!path || !buffer) return
      setBufferContent(path, `${buffer.content}\n[[${title}]]\n`)
      toast('success', `Linked to “${title}”`)
    },
    [setBufferContent, toast],
  )

  const saveTask = useCallback(
    (task: Partial<TaskRecord> & { title: string }) => {
      try {
        api.saveTask(task)
        refreshTasks()
      } catch (error) {
        toast('error', `Could not save the task: ${describe(error)}`)
      }
    },
    [refreshTasks, toast],
  )

  const toggleTask = useCallback(
    (task: TaskRecord) => {
      const next = task.status === 'done' ? 'todo' : 'done'
      saveTask({ ...task, status: next })
    },
    [saveTask],
  )

  const deleteTask = useCallback(
    (id: string) => {
      try {
        api.deleteTask(id)
        refreshTasks()
      } catch (error) {
        toast('error', `Could not delete the task: ${describe(error)}`)
      }
    },
    [refreshTasks, toast],
  )

  const saveEvent = useCallback(
    (event: Partial<EventRecord> & { title: string }) => {
      try {
        api.saveEvent(event)
        refreshEvents()
      } catch (error) {
        toast('error', `Could not save the event: ${describe(error)}`)
      }
    },
    [refreshEvents, toast],
  )

  const deleteEvent = useCallback(
    (id: string) => {
      try {
        api.deleteEvent(id)
        refreshEvents()
      } catch (error) {
        toast('error', `Could not delete the event: ${describe(error)}`)
      }
    },
    [refreshEvents, toast],
  )

  const scheduleTaskOnCalendar = useCallback(
    (task: TaskRecord, date: string) => {
      const start = task.startTime ?? '09:00'
      const [h, m] = start.split(':').map(Number)
      const base = new Date(`${date}T00:00:00`)
      const from = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h || 0, m || 0)
      const duration = task.durationMinutes ?? 60
      const to = new Date(from.getTime() + duration * 60_000)
      saveEvent({
        title: task.title,
        description: task.description,
        startUtc: from.getTime(),
        endUtc: to.getTime(),
        allDay: false,
        timezone: task.timezone || 'local',
        exdates: [],
        taskId: task.id,
        noteId: task.noteId,
      })
    },
    [saveEvent],
  )

  const search = useCallback(
    (query: string) => {
      const trimmed = query.trim()
      if (!trimmed) {
        dispatch({ type: 'search', query, results: [] })
        return
      }
      try {
        dispatch({ type: 'search', query, results: api.searchNotes(trimmed, 80) })
      } catch (error) {
        toast('error', `Search failed: ${describe(error)}`)
      }
    },
    [toast],
  )

  const openDailyNote = useCallback(
    (date: string) => {
      try {
        const path = api.dailyNote(date, true)
        refreshTree()
        refreshNotes()
        openNote(path)
      } catch (error) {
        toast('error', `Could not open the daily note: ${describe(error)}`)
      }
    },
    [openNote, refreshNotes, refreshTree, toast],
  )

  const setView = useCallback((view: ViewName) => {
    dispatch({ type: 'view', view })
    if (view === 'notes') dispatch({ type: 'drawing', path: null })
  }, [])

  const setViewMode = useCallback((mode: NoteViewMode) => {
    dispatch({ type: 'view-mode', mode })
    try {
      api.setSetting('viewMode', mode)
    } catch {
      /* settings are best-effort */
    }
  }, [])

  const cycleViewMode = useCallback(() => {
    const order: NoteViewMode[] = ['reading', 'editing', 'source', 'split']
    const current = order.indexOf(stateRef.current.viewMode)
    const next = order[(current + 1) % order.length]
    dispatch({ type: 'view-mode', mode: next })
    try {
      api.setSetting('viewMode', next)
    } catch {
      /* settings are best-effort */
    }
  }, [])

  const setTaskFilter = useCallback((filter: TaskFilter) => {
    dispatch({ type: 'task-filter', filter })
  }, [])

  const setCalendarMode = useCallback((mode: CalendarMode) => {
    dispatch({ type: 'calendar-mode', mode })
  }, [])

  const setCalendarCursor = useCallback((cursor: string) => {
    dispatch({ type: 'calendar-cursor', cursor })
  }, [])

  const setActiveTag = useCallback((tag: string | null) => {
    dispatch({ type: 'active-tag', tag })
  }, [])

  const setPalette = useCallback((open: boolean, mode?: 'quick' | 'command') => {
    dispatch({ type: 'palette', open, mode })
  }, [])

  const setModal = useCallback((modal: ModalState | null) => {
    dispatch({ type: 'modal', modal })
  }, [])

  const toggleTheme = useCallback(() => {
    const order: ThemeName[] = ['nord-dark', 'nord-light', 'ayu-dark', 'ayu-mirage']
    const current = order.indexOf(stateRef.current.theme)
    const next = order[(current + 1) % order.length]
    dispatch({ type: 'theme', theme: next })
    try {
      api.setSetting('theme', next)
    } catch {
      /* settings are best-effort */
    }
  }, [])

  const setTheme = useCallback((theme: ThemeName) => {
    dispatch({ type: 'theme', theme })
    try {
      api.setSetting('theme', theme)
    } catch {
      /* settings are best-effort */
    }
  }, [])

  const setContentFont = useCallback((font: ContentFont) => {
    dispatch({ type: 'content-font', font })
    try {
      api.setSetting('contentFont', font)
    } catch {
      /* settings are best-effort */
    }
  }, [])

  const goBack = useCallback(() => {
    const current = stateRef.current
    if (current.historyIndex <= 0) return
    const index = current.historyIndex - 1
    dispatch({ type: 'history', history: current.history, index })
    openNote(current.history[index])
  }, [openNote])

  const goForward = useCallback(() => {
    const current = stateRef.current
    if (current.historyIndex >= current.history.length - 1) return
    const index = current.historyIndex + 1
    dispatch({ type: 'history', history: current.history, index })
    openNote(current.history[index])
  }, [openNote])

  const createBackup = useCallback(async () => {
    try {
      const dir = await api.pickFolder('Choose where to save the backup')
      if (!dir) return
      const info = api.createBackup(dir)
      toast('success', `Backup saved: ${info.name}`)
    } catch (error) {
      toast('error', `Could not create the backup: ${describe(error)}`)
    }
  }, [toast])

  const restoreBackup = useCallback(
    async (archivePath: string) => {
      try {
        const dir = await api.pickFolder('Choose where to restore the backup')
        if (!dir) return
        const target = api.restoreBackup(archivePath, dir)
        toast('success', `Backup restored to ${target}`)
      } catch (error) {
        toast('error', `Could not restore the backup: ${describe(error)}`)
      }
    },
    [toast],
  )

  // --------------------------------------------------------------- effects

  // Remember the open tabs, so the workspace comes back when the app is
  // opened again.
  useEffect(() => {
    if (!state.vault) return
    saveWorkspace(state.openTabs, state.activePath)
  }, [state.vault, state.openTabs, state.activePath, saveWorkspace])

  // React to filesystem changes made outside the application.
  useEffect(() => {
    return api.onWatch((event: WatchEvent) => {
      const current = stateRef.current
      let changed = false
      for (const path of event.paths) {
        // Bring the index up to date with the file on disk first.
        try {
          api.indexNote(path)
        } catch {
          /* the file may have been removed */
        }
        const buffer = current.buffers[path]
        if (!buffer) continue
        if (event.kind === 'remove') {
          dispatch({ type: 'buffer-conflict', path, theirs: null })
          continue
        }
        try {
          const onDisk = api.readFile(path)
          if (onDisk === buffer.content) continue
          if (buffer.dirty) {
            // Unsaved local edits exist — surface the conflict instead of
            // overwriting either version.
            dispatch({ type: 'buffer-conflict', path, theirs: onDisk })
          } else {
            dispatch({ type: 'buffer-saved', path, content: onDisk })
          }
          changed = true
        } catch {
          /* the file may have been removed between the event and the read */
        }
      }
      if (changed || event.kind === 'create' || event.kind === 'remove') {
        refreshTree()
        refreshNotes()
      }
    })
  }, [refreshNotes, refreshTree])

  // Apply the persisted theme, content font and note view.
  useEffect(() => {
    if (!state.vault) return
    try {
      const theme = api.getSetting('theme')
      if (
        theme === 'nord-dark' ||
        theme === 'nord-light' ||
        theme === 'ayu-dark' ||
        theme === 'ayu-mirage'
      ) {
        dispatch({ type: 'theme', theme })
      }
      const font = api.getSetting('contentFont')
      if (font === 'iosevka' || font === 'noto') {
        dispatch({ type: 'content-font', font })
      }
      const mode = api.getSetting('viewMode')
      if (mode === 'reading' || mode === 'editing' || mode === 'source' || mode === 'split') {
        dispatch({ type: 'view-mode', mode })
      }
    } catch {
      /* settings are best-effort */
    }
  }, [state.vault])

  // Remember whether the graph panel was open.
  useEffect(() => {
    if (!state.vault) return
    try {
      dispatch({ type: 'graph-open', open: api.getSetting('graphOpen') === '1' })
    } catch {
      /* settings are best-effort */
    }
  }, [state.vault])

  // Apply the theme to the document.
  useEffect(() => {
    document.documentElement.dataset.theme = state.theme
    document.documentElement.dataset.contentFont = state.contentFont
  }, [state.theme, state.contentFont])

  // Flush pending autosaves when the window goes away.
  useEffect(() => {
    const flush = () => {
      for (const timer of timers.current.values()) clearTimeout(timer)
      timers.current.clear()
      const current = stateRef.current
      for (const [path, buffer] of Object.entries(current.buffers)) {
        if (!buffer.dirty) continue
        try {
          api.writeFile(path, buffer.content)
          api.clearRecovery(path)
        } catch {
          /* the recovery journal already holds the content */
        }
      }
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])

  const actions = useMemo<AppActions>(
    () => ({
      openVault,
      chooseVault,
      refreshTree,
      refreshNotes,
      refreshTasks,
      refreshEvents,
      refreshGraph,
      setGraphOpen,
      openNote,
      closeTab,
      closeOtherTabs,
      closeTabsToRight,
      closeAllTabs,
      moveTab,
      setActiveTab,
      setBufferContent,
      saveNote,
      saveActiveNote,
      createNote,
      createFolder,
      renameEntry,
      moveEntry,
      deleteEntry,
      restoreFromTrash,
      purgeTrash,
      insertImage,
      importImageFromDisk,
      insertTextAtCursor,
      insertLink,
      saveTask,
      toggleTask,
      deleteTask,
      saveEvent,
      deleteEvent,
      scheduleTaskOnCalendar,
      search,
      openDailyNote,
      setView,
      setViewMode,
      cycleViewMode,
      setTaskFilter,
      setCalendarMode,
      setCalendarCursor,
      setActiveTag,
      setPalette,
      setModal,
      toggleTheme,
      setTheme,
      toast,
      dismissToast,
      setContentFont,
      goBack,
      goForward,
      createBackup,
      restoreBackup,
    }),
    [
      openVault,
      chooseVault,
      refreshTree,
      refreshNotes,
      refreshTasks,
      refreshEvents,
      refreshGraph,
      setGraphOpen,
      openNote,
      closeTab,
      closeOtherTabs,
      closeTabsToRight,
      closeAllTabs,
      moveTab,
      setActiveTab,
      setBufferContent,
      saveNote,
      saveActiveNote,
      createNote,
      createFolder,
      renameEntry,
      moveEntry,
      deleteEntry,
      restoreFromTrash,
      purgeTrash,
      insertImage,
      importImageFromDisk,
      insertTextAtCursor,
      insertLink,
      saveTask,
      toggleTask,
      deleteTask,
      saveEvent,
      deleteEvent,
      scheduleTaskOnCalendar,
      search,
      openDailyNote,
      setView,
      setViewMode,
      cycleViewMode,
      setTaskFilter,
      setCalendarMode,
      setCalendarCursor,
      setActiveTag,
      setPalette,
      setModal,
      toggleTheme,
      setTheme,
      toast,
      dismissToast,
      setContentFont,
      goBack,
      goForward,
      createBackup,
      restoreBackup,
    ],
  )

  return (
    <StateContext.Provider value={state}>
      <ActionsContext.Provider value={actions}>{children}</ActionsContext.Provider>
    </StateContext.Provider>
  )
}

/** Turn an unknown thrown value into a readable sentence. */
export function describe(error: unknown): string {
  if (error instanceof Error) {
    // The Rust core prefixes the machine-readable code: "[ENOENT] message".
    return error.message.replace(/^\[([A-Z0-9]+)\]\s*/, (_, code: string) => `${code}: `)
  }
  if (typeof error === 'string') return error
  return String(error)
}
