import { useMemo, useState, type MouseEvent } from 'react'
import type { TreeEntry } from '@shared/types'
import { useActions, useAppState } from '../lib/store'
import { FileTree } from './FileTree'
import { GraphPanel } from './GraphPanel'
import type { ContextMenuItem } from './ContextMenu'
import {
  IconCalendar,
  IconDraw,
  IconFolder,
  IconPlus,
  IconSearch,
  IconSettings,
  IconTag,
  IconTask,
  IconTrash,
  IconVault,
} from './Icons'

export function Sidebar({
  width,
  onContextMenu,
}: {
  width: number
  onContextMenu(event: MouseEvent, entry: TreeEntry): void
}) {
  const state = useAppState()
  const actions = useActions()
  const [showTags, setShowTags] = useState(false)
  const activeTag = state.activeTag
  const setActiveTag = actions.setActiveTag

  const nav = useMemo(
    () => [
      { id: 'notes' as const, label: 'Notes', Icon: IconVault },
      { id: 'tasks' as const, label: 'Tasks', Icon: IconTask },
      { id: 'calendar' as const, label: 'Calendar', Icon: IconCalendar },
      { id: 'drawings' as const, label: 'Drawings', Icon: IconDraw },
      { id: 'search' as const, label: 'Search', Icon: IconSearch },
    ],
    [],
  )

  const openTag = (tag: string) => {
    setActiveTag(tag)
    setShowTags(true)
    actions.setView('search')
  }

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-header">
        <IconVault style={{ color: 'var(--accent)' }} />
        <span className="vault-name" title={state.vault?.path}>
          {state.vault?.name ?? 'No vault'}
        </span>
        <button
          type="button"
          className="btn ghost icon"
          title="Open another vault (Ctrl+O)"
          onClick={() => void actions.chooseVault()}
        >
          <IconVault />
        </button>
      </div>

      <nav className="sidebar-nav">
        {nav.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            className={`nav-btn${state.view === id ? ' active' : ''}`}
            onClick={() => {
              actions.setView(id)
              if (id !== 'search') {
                setActiveTag(null)
                setShowTags(false)
              }
            }}
          >
            <Icon />
            {label}
          </button>
        ))}
      </nav>

      <div className="sidebar-body">
        {state.view === 'notes' && (
          <>
            <div className="sidebar-section">
              <span>Files</span>
              <span style={{ display: 'flex', gap: 2 }}>
                <button
                  type="button"
                  className="btn ghost icon"
                  title="New note (Ctrl+N)"
                  onClick={() => actions.setModal({ kind: 'new-note' })}
                >
                  <IconPlus />
                </button>
                <button
                  type="button"
                  className="btn ghost icon"
                  title="New folder (Ctrl+Shift+N)"
                  onClick={() => actions.setModal({ kind: 'new-folder' })}
                >
                  <IconFolder />
                </button>
              </span>
            </div>

            <FileTree
              entries={state.tree}
              activePath={state.activePath}
              onOpen={(path) => {
                actions.openNote(path)
                actions.setView('notes')
              }}
              onOpenDrawing={(path) => {
                actions.setView('drawings')
                void path
              }}
              onContextMenu={onContextMenu}
              onMove={(path, destination) => actions.moveEntry(path, destination)}
            />

            {state.tags.length > 0 && (
              <>
                <div className="sidebar-section">
                  <span>Tags</span>
                  <button
                    type="button"
                    className="btn ghost icon"
                    title="Show all tags"
                    onClick={() => setShowTags((value) => !value)}
                  >
                    <IconTag />
                  </button>
                </div>
                {showTags && (
                  <div className="tag-list">
                    {state.tags.map((tag) => (
                      <span
                        key={tag}
                        className={`tag-pill${activeTag === tag ? ' active' : ''}`}
                        onClick={() => openTag(tag)}
                      >
                        #{tag}
                      </span>
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        )}

        {state.view === 'search' && activeTag && (
          <>
            <div className="sidebar-section">
              <span>Tag</span>
              <button
                type="button"
                className="btn ghost icon"
                onClick={() => setActiveTag(null)}
                title="Clear tag filter"
              >
                ×
              </button>
            </div>
            <div className="tag-list">
              <span className="tag-pill active">#{activeTag}</span>
            </div>
          </>
        )}

        {state.view === 'tasks' && (
          <div className="sidebar-section" style={{ paddingTop: 14 }}>
            <span>Task overview</span>
          </div>
        )}
      </div>

      <GraphPanel />

      <div className="sidebar-footer">
        <button
          type="button"
          className={`btn ghost${state.view === 'trash' ? ' active' : ''}`}
          onClick={() => actions.setView('trash')}
          title="Trash"
        >
          <IconTrash />
        </button>
        <button
          type="button"
          className={`btn ghost${state.view === 'settings' ? ' active' : ''}`}
          onClick={() => actions.setView('settings')}
          title="Settings"
        >
          <IconSettings />
        </button>
        <span style={{ flex: 1 }} />
        <span className="muted" style={{ fontSize: 11 }}>
          {state.vault ? `${state.notes.length} notes` : 'Ctrl+O to open a vault'}
        </span>
      </div>
    </aside>
  )
}

/** Menu entries for a tree entry. */
export function sidebarMenuItems(
  entry: TreeEntry,
  handlers: {
    open(): void
    rename(): void
    remove(): void
    newNote(): void
    newFolder(): void
  },
): ContextMenuItem[] {
  const isFolder = entry.kind === 'folder'
  return [
    { label: 'Open', onSelect: handlers.open },
    ...(isFolder
      ? [
          { label: 'New note here', onSelect: handlers.newNote },
          { label: 'New folder here', onSelect: handlers.newFolder },
        ]
      : []),
    { label: 'Rename…', onSelect: handlers.rename },
    { label: '', onSelect: () => {}, separator: true },
    { label: isFolder ? 'Delete folder' : 'Delete file', onSelect: handlers.remove, danger: true },
  ]
}
