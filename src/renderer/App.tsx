import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import type { TreeEntry } from '@shared/types'
import { AppProvider, useActions, useAppState } from './lib/store'
import { api } from './lib/api'
import { Sidebar, sidebarMenuItems } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { StatusBar } from './components/StatusBar'
import { Toasts } from './components/Toasts'
import { Modal } from './components/Modal'
import { CommandPalette, buildCommands } from './components/CommandPalette'
import { ContextMenu, useContextMenu } from './components/ContextMenu'
import { NoteView } from './views/NoteView'
import { TasksView } from './views/TasksView'
import { CalendarView } from './views/CalendarView'
import { DrawingsView } from './views/DrawingsView'
import { SearchView, TagResults } from './views/SearchView'
import { SettingsView } from './views/SettingsView'
import { TrashView } from './views/TrashView'
import { IconVault } from './components/Icons'

const MIN_SIDEBAR = 180
const MAX_SIDEBAR = 520

function Workspace() {
  const state = useAppState()
  const actions = useActions()
  const [sidebarWidth, setSidebarWidth] = useState(268)
  const [dragging, setDragging] = useState(false)
  const contextMenu = useContextMenu()
  const tabMenu = useContextMenu()
  const dragStart = useRef(0)

  // Open the vault supplied on the command line, once.
  const openedFromArgs = useRef(false)
  useEffect(() => {
    if (openedFromArgs.current) return
    openedFromArgs.current = true
    const initial = api.initialVaultPath()
    if (initial) actions.openVault(initial)
  }, [actions])

  // ---------------------------------------------------------- resizing
  const onResizeStart = (event: MouseEvent) => {
    event.preventDefault()
    dragStart.current = event.clientX
    setDragging(true)
    const onMove = (moveEvent: globalThis.MouseEvent) => {
      const delta = moveEvent.clientX - dragStart.current
      setSidebarWidth((current) => Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, current + delta)))
      dragStart.current = moveEvent.clientX
    }
    const onUp = () => {
      setDragging(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // ------------------------------------------------------ menu commands
  useEffect(() => {
    return api.onMenuCommand((command) => {
      switch (command) {
        case 'file.new-note':
          actions.setModal({ kind: 'new-note' })
          break
        case 'file.new-folder':
          actions.setModal({ kind: 'new-folder' })
          break
        case 'file.open-vault':
          void actions.chooseVault()
          break
        case 'file.save':
          void actions.saveActiveNote()
          break
        case 'file.backup':
          void actions.createBackup()
          break
        case 'file.restore':
          actions.setModal({ kind: 'restore' })
          break
        case 'edit.find':
          actions.setPalette(true, 'quick')
          actions.setView('search')
          break
        case 'view.notes':
          actions.setView('notes')
          break
        case 'view.tasks':
          actions.setView('tasks')
          break
        case 'view.calendar':
          actions.setView('calendar')
          break
        case 'view.drawings':
          actions.setView('drawings')
          break
        case 'view.search':
          actions.setView('search')
          break
        case 'view.toggle-preview':
          actions.cycleViewMode()
          break
        case 'view.toggle-theme':
          actions.toggleTheme()
          break
        case 'nav.quick-open':
          actions.setPalette(true, 'quick')
          break
        case 'nav.command-palette':
          actions.setPalette(true, 'command')
          break
        case 'nav.next-tab': {
          const index = state.openTabs.indexOf(state.activePath ?? '')
          const next = state.openTabs[(index + 1) % Math.max(1, state.openTabs.length)]
          if (next) actions.setActiveTab(next)
          break
        }
        case 'nav.prev-tab': {
          const index = state.openTabs.indexOf(state.activePath ?? '')
          const size = Math.max(1, state.openTabs.length)
          const prev = state.openTabs[(index - 1 + size) % size]
          if (prev) actions.setActiveTab(prev)
          break
        }
        case 'nav.back':
          actions.goBack()
          break
        case 'nav.forward':
          actions.goForward()
          break
        case 'help.shortcuts':
          actions.setModal({ kind: 'shortcuts' })
          break
        case 'help.about':
          actions.setModal({ kind: 'about' })
          break
        default:
          break
      }
    })
  }, [actions, state.openTabs, state.activePath])

  // ---------------------------------------------------- keyboard shortcuts
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)

      const mod = event.ctrlKey || event.metaKey
      if (!mod) return

      if (event.key === 'p' && event.shiftKey) {
        event.preventDefault()
        actions.setPalette(true, 'command')
        return
      }
      if (event.key === 'p') {
        event.preventDefault()
        actions.setPalette(true, 'quick')
        return
      }
      if (event.key === 'n' && event.shiftKey) {
        event.preventDefault()
        actions.setModal({ kind: 'new-folder' })
        return
      }
      if (event.key === 'n') {
        event.preventDefault()
        actions.setModal({ kind: 'new-note' })
        return
      }
      if (event.key === 's') {
        event.preventDefault()
        void actions.saveActiveNote()
        return
      }
      if (event.key === 'o') {
        event.preventDefault()
        void actions.chooseVault()
        return
      }
      if (event.key === 'e' && !typing) {
        event.preventDefault()
        actions.cycleViewMode()
        return
      }
      if (event.key === 'l' && event.shiftKey) {
        event.preventDefault()
        actions.toggleTheme()
        return
      }
      if (event.key === '/') {
        event.preventDefault()
        actions.setModal({ kind: 'shortcuts' })
        return
      }
      if (['1', '2', '3', '4'].includes(event.key) && !event.shiftKey) {
        event.preventDefault()
        const views = ['notes', 'tasks', 'calendar', 'drawings'] as const
        actions.setView(views[Number(event.key) - 1])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions])

  // ------------------------------------------------------- tree context menu
  const onTreeContextMenu = useCallback(
    (event: MouseEvent, entry: TreeEntry) => {
      contextMenu.open(event, sidebarMenuItems(entry, {
        open: () => {
          if (entry.kind === 'folder') {
            actions.openNote(entry.path)
          } else {
            actions.openNote(entry.path)
          }
        },
        rename: () => actions.setModal({ kind: 'rename', target: entry.path }),
        remove: () => actions.setModal({ kind: 'delete-confirm', target: entry.path }),
        newNote: () => actions.setModal({ kind: 'new-note' }),
        newFolder: () => actions.setModal({ kind: 'new-folder' }),
      }))
    },
    [actions, contextMenu],
  )

  const commands = useMemo(
    () =>
      buildCommands(actions, {
        newNote: () => actions.setModal({ kind: 'new-note' }),
        newFolder: () => actions.setModal({ kind: 'new-folder' }),
        openVault: () => void actions.chooseVault(),
        save: () => void actions.saveActiveNote(),
        togglePreview: () => actions.cycleViewMode(),
        toggleTheme: () => actions.toggleTheme(),
        dailyNote: () => actions.openDailyNote(new Date().toISOString().slice(0, 10)),
        backup: () => void actions.createBackup(),
        restore: () => actions.setModal({ kind: 'restore' }),
        shortcuts: () => actions.setModal({ kind: 'shortcuts' }),
        about: () => actions.setModal({ kind: 'about' }),
      }),
    [actions],
  )

  const wordCount = useMemo(() => {
    const path = state.activePath
    const buffer = path ? state.buffers[path] : undefined
    if (!buffer) return 0
    const trimmed = buffer.content.trim()
    return trimmed ? trimmed.split(/\s+/).length : 0
  }, [state.activePath, state.buffers])

  if (!state.vault) {
    return (
      <div className="app" style={{ gridTemplateColumns: '1fr' }}>
        <div className="empty" style={{ height: '100vh' }}>
          <IconVault style={{ fontSize: 40, color: 'var(--accent)' }} />
          <h3>Welcome to Delta</h3>
          <p>
            Choose a folder to use as your vault. Notes stay as ordinary Markdown files you can read
            and edit anywhere — Delta never needs an account or a server.
          </p>
          <button type="button" className="btn primary" onClick={() => void actions.chooseVault()}>
            Open a vault…
          </button>
          <span className="kbd-hint">Ctrl+O</span>
        </div>
        <Toasts />
      </div>
    )
  }

  return (
    <div className="app" style={{ ['--sidebar-width' as string]: `${sidebarWidth}px` }}>
      <div style={{ position: 'relative', display: 'flex', minWidth: 0 }}>
        <Sidebar width={sidebarWidth} onContextMenu={onTreeContextMenu} />
        <div
          className={`resizer${dragging ? ' dragging' : ''}`}
          style={{ left: sidebarWidth - 2 }}
          onMouseDown={onResizeStart}
        />
      </div>

      <main className="main">
        {state.view === 'notes' && <TabBar
          tabs={state.openTabs}
          activePath={state.activePath}
          buffers={state.buffers}
          onSelect={(path) => actions.setActiveTab(path)}
          onClose={(path) => actions.closeTab(path)}
          onNewTab={() => actions.setModal({ kind: 'new-note' })}
          onContextMenu={(path, event) => {
            tabMenu.open(event, [
              { label: 'Close', onSelect: () => actions.closeTab(path) },
              {
                label: 'Close others',
                onSelect: () => actions.closeOtherTabs(path),
              },
              {
                label: 'Close to the right',
                onSelect: () => actions.closeTabsToRight(path),
              },
              { label: 'Close all', onSelect: () => actions.closeAllTabs() },
              { label: '', separator: true, onSelect: () => {} },
              {
                label: 'Rename',
                onSelect: () => actions.setModal({ kind: 'rename', target: path }),
              },
            ])
          }}
          onMove={(from, to) => actions.moveTab(from, to)}
        />}
        {state.view === 'notes' && <NoteView />}
        {state.view === 'tasks' && <TasksView />}
        {state.view === 'calendar' && <CalendarView />}
        {state.view === 'drawings' && <DrawingsView />}
        {state.view === 'search' &&
          (state.activeTag ? <TagResults tag={state.activeTag} /> : <SearchView />)}
        {state.view === 'settings' && <SettingsView />}
        {state.view === 'trash' && <TrashView />}

        <StatusBar
          vaultName={state.vault.name}
          saveState={state.saveState}
          activePath={state.activePath}
          wordCount={wordCount}
          showStats={state.view === 'notes'}
        />
      </main>

      {state.paletteOpen && (
        <CommandPalette commands={commands} onClose={() => actions.setPalette(false)} />
      )}
      {contextMenu.menu && (
        <ContextMenu
          x={contextMenu.menu.x}
          y={contextMenu.menu.y}
          items={contextMenu.menu.items}
          onClose={contextMenu.close}
        />
      )}
      {tabMenu.menu && (
        <ContextMenu
          x={tabMenu.menu.x}
          y={tabMenu.menu.y}
          items={tabMenu.menu.items}
          onClose={tabMenu.close}
        />
      )}
      <Modal />
      <Toasts />
    </div>
  )
}

export default function App() {
  return (
    <AppProvider>
      <Workspace />
    </AppProvider>
  )
}
