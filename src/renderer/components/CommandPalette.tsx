import { useEffect, useMemo, useRef, useState } from 'react'
import type { SearchResult } from '@shared/types'
import { useActions, useAppState } from '../lib/store'
import { api } from '../lib/api'
import { plainPreview } from '../lib/markdown'

export interface PaletteCommand {
  id: string
  label: string
  hint?: string
  run(): void
}

export function CommandPalette({
  commands,
  onClose,
}: {
  commands: PaletteCommand[]
  onClose(): void
}) {
  const { paletteMode, notes, tasks, events, buffers, activePath } = useAppState()
  const { openNote, setView, search } = useActions()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const isCommandMode = paletteMode === 'command'

  const results = useMemo<SearchResult[]>(() => {
    if (isCommandMode) return []
    const trimmed = query.trim()
    if (!trimmed) {
      // Without a query, offer the most recently opened notes.
      return notes
        .filter((note) => buffers[note.path]?.dirty !== undefined || true)
        .slice(0, 12)
        .map((note) => ({
          path: note.path,
          title: note.title,
          snippet: note.excerpt,
          score: 0,
          kind: 'note' as const,
        }))
    }
    try {
      return api.searchNotes(trimmed, 40)
    } catch {
      return []
    }
  }, [query, isCommandMode, notes, buffers])

  const filteredCommands = useMemo(() => {
    const trimmed = query.trim().toLowerCase()
    if (!trimmed) return commands
    return commands.filter((command) => command.label.toLowerCase().includes(trimmed))
  }, [commands, query])

  const items = isCommandMode
    ? filteredCommands.map((command) => ({
        key: command.id,
        label: command.label,
        kind: 'command',
        hint: command.hint,
        run: command.run,
      }))
    : results.map((result) => ({
        key: result.path || result.title,
        label: result.title || result.path,
        kind: result.kind,
        hint: result.path || result.snippet,
        run: () => {
          if (result.kind === 'note' && result.path) openNote(result.path)
          else if (result.kind === 'task') setView('tasks')
          else if (result.kind === 'event') setView('calendar')
        },
      }))

  useEffect(() => {
    setIndex(0)
  }, [query, paletteMode])

  useEffect(() => {
    // Keep the search index in step with the palette query.
    if (!isCommandMode && query.trim()) search(query)
  }, [query, isCommandMode, search])

  useEffect(() => {
    const element = listRef.current?.querySelector('.palette-item.active')
    element?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setIndex((current) => Math.min(current + 1, items.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setIndex((current) => Math.max(current - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const item = items[index]
      if (item) {
        item.run()
        onClose()
      }
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  const today = new Date().toISOString().slice(0, 10)

  return (
    <div
      className="palette-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          className="palette-input"
          autoFocus
          value={query}
          placeholder={
            isCommandMode ? 'Type a command…' : 'Search notes, tasks and events…'
          }
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="palette-results" ref={listRef}>
          {items.length === 0 && (
            <div style={{ padding: '16px', color: 'var(--text-faint)', fontSize: 12.5 }}>
              No matches
            </div>
          )}
          {items.map((item, itemIndex) => (
            <div
              key={item.key}
              className={`palette-item${itemIndex === index ? ' active' : ''}`}
              onMouseEnter={() => setIndex(itemIndex)}
              onClick={() => {
                item.run()
                onClose()
              }}
            >
              <span className="kind">{item.kind}</span>
              <span>{item.label}</span>
              {item.hint && <span className="sub">{item.hint}</span>}
            </div>
          ))}
        </div>
        <div
          style={{
            borderTop: '1px solid var(--border-soft)',
            padding: '7px 14px',
            fontSize: 11,
            color: 'var(--text-faint)',
            display: 'flex',
            gap: 14,
          }}
        >
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>Enter</kbd> open
          </span>
          <span>
            <kbd>Esc</kbd> dismiss
          </span>
          {isCommandMode && (
            <span style={{ marginLeft: 'auto' }}>
              {tasks.length} tasks · {events.length} events
            </span>
          )}
          {!isCommandMode && activePath && (
            <span style={{ marginLeft: 'auto' }}>today: {today}</span>
          )}
        </div>
      </div>
    </div>
  )
}

/** Build the command list shown by the palette. */
export function buildCommands(
  actions: ReturnType<typeof useActions>,
  handlers: {
    newNote(): void
    newFolder(): void
    openVault(): void
    save(): void
    togglePreview(): void
    toggleTheme(): void
    dailyNote(): void
    backup(): void
    restore(): void
    shortcuts(): void
    about(): void
  },
): PaletteCommand[] {
  return [
    { id: 'new-note', label: 'New note', hint: 'Ctrl+N', run: handlers.newNote },
    { id: 'new-folder', label: 'New folder', hint: 'Ctrl+Shift+N', run: handlers.newFolder },
    { id: 'daily', label: "Open today's daily note", run: handlers.dailyNote },
    { id: 'open-vault', label: 'Open another vault…', hint: 'Ctrl+O', run: handlers.openVault },
    { id: 'save', label: 'Save current note', hint: 'Ctrl+S', run: handlers.save },
    { id: 'preview', label: 'Cycle the note view', hint: 'Ctrl+E', run: handlers.togglePreview },
    { id: 'theme', label: 'Toggle light / dark theme', run: handlers.toggleTheme },
    { id: 'tasks', label: 'Go to tasks', hint: 'Ctrl+2', run: () => actions.setView('tasks') },
    { id: 'calendar', label: 'Go to calendar', hint: 'Ctrl+3', run: () => actions.setView('calendar') },
    { id: 'drawings', label: 'Go to drawings', hint: 'Ctrl+4', run: () => actions.setView('drawings') },
    { id: 'backup', label: 'Back up the vault…', run: handlers.backup },
    { id: 'restore', label: 'Restore a backup…', run: handlers.restore },
    { id: 'shortcuts', label: 'Keyboard shortcuts', hint: 'Ctrl+/', run: handlers.shortcuts },
    { id: 'about', label: 'About Delta', run: handlers.about },
  ]
}

/** Short preview used by the palette when no query is typed. */
export function previewOf(content: string): string {
  return plainPreview(content, 120)
}
