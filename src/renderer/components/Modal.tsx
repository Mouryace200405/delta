import { useEffect, useMemo, useState } from 'react'
import type { EventRecord, TaskRecord } from '@shared/types'
import { useActions, useAppState } from '../lib/store'
import { api } from '../lib/api'
import { isoDate, isoTime, localTimestamp } from '../lib/dates'
import { splitSeries } from '../lib/recurrence'
import { IconClose } from './Icons'

export function Modal() {
  const state = useAppState()
  const actions = useActions()
  const modal = state.modal

  useEffect(() => {
    if (!modal) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') actions.setModal(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modal, actions])

  if (!modal) return null

  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) actions.setModal(null)
      }}
    >
      <div className={`modal${modal.kind === 'shortcuts' ? ' wide' : ''}`} role="dialog" aria-modal="true">
        {modal.kind === 'new-note' && <NewNoteModal />}
        {modal.kind === 'new-folder' && <NewFolderModal />}
        {modal.kind === 'rename' && <RenameModal />}
        {modal.kind === 'task' && <TaskModal />}
        {modal.kind === 'event' && <EventModal />}
        {modal.kind === 'recurrence-scope' && <RecurrenceScopeModal />}
        {modal.kind === 'shortcuts' && <ShortcutsModal />}
        {modal.kind === 'about' && <AboutModal />}
        {modal.kind === 'delete-confirm' && <DeleteConfirmModal />}
        {modal.kind === 'restore' && <RestoreModal />}
      </div>
    </div>
  )
}

function Header({ title, onClose }: { title: string; onClose(): void }) {
  return (
    <div className="modal-header">
      <span>{title}</span>
      <button type="button" className="btn ghost icon" onClick={onClose} aria-label="Close">
        <IconClose />
      </button>
    </div>
  )
}

function Footer({
  onCancel,
  onConfirm,
  confirmLabel,
  danger,
}: {
  onCancel(): void
  onConfirm(): void
  confirmLabel: string
  danger?: boolean
}) {
  return (
    <div className="modal-footer">
      <button type="button" className="btn" onClick={onCancel}>
        Cancel
      </button>
      <button
        type="button"
        className={`btn ${danger ? 'danger' : 'primary'}`}
        onClick={onConfirm}
      >
        {confirmLabel}
      </button>
    </div>
  )
}

function NewNoteModal() {
  const actions = useActions()
  const { tree } = useAppState()
  const [name, setName] = useState('')
  const [folder, setFolder] = useState('')

  const folders = useMemo(
    () => tree.filter((entry) => entry.kind === 'folder').map((entry) => entry.path),
    [tree],
  )

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    actions.createNote(trimmed, folder || undefined)
    actions.setModal(null)
  }

  return (
    <>
      <Header title="New note" onClose={() => actions.setModal(null)} />
      <div className="modal-body">
        <div className="field">
          <label htmlFor="note-name">Name</label>
          <input
            id="note-name"
            className="input"
            autoFocus
            value={name}
            placeholder="Meeting notes"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit()
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="note-folder">Folder</label>
          <select
            id="note-folder"
            className="select"
            value={folder}
            onChange={(event) => setFolder(event.target.value)}
          >
            <option value="">(vault root)</option>
            {folders.map((path) => (
              <option key={path} value={path}>
                {path}
              </option>
            ))}
          </select>
        </div>
      </div>
      <Footer onCancel={() => actions.setModal(null)} onConfirm={submit} confirmLabel="Create" />
    </>
  )
}

function NewFolderModal() {
  const actions = useActions()
  const { tree } = useAppState()
  const [name, setName] = useState('')
  const [folder, setFolder] = useState('')

  const folders = useMemo(
    () => tree.filter((entry) => entry.kind === 'folder').map((entry) => entry.path),
    [tree],
  )

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    actions.createFolder(trimmed, folder || undefined)
    actions.setModal(null)
  }

  return (
    <>
      <Header title="New folder" onClose={() => actions.setModal(null)} />
      <div className="modal-body">
        <div className="field">
          <label htmlFor="folder-name">Name</label>
          <input
            id="folder-name"
            className="input"
            autoFocus
            value={name}
            placeholder="Projects"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit()
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="folder-parent">Inside</label>
          <select
            id="folder-parent"
            className="select"
            value={folder}
            onChange={(event) => setFolder(event.target.value)}
          >
            <option value="">(vault root)</option>
            {folders.map((path) => (
              <option key={path} value={path}>
                {path}
              </option>
            ))}
          </select>
        </div>
      </div>
      <Footer onCancel={() => actions.setModal(null)} onConfirm={submit} confirmLabel="Create" />
    </>
  )
}

function RenameModal() {
  const actions = useActions()
  const { modal } = useAppState()
  const path = modal?.target ?? ''
  const [name, setName] = useState(path.split('/').pop() ?? '')

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed || !path) return
    actions.renameEntry(path, trimmed)
    actions.setModal(null)
  }

  return (
    <>
      <Header title="Rename" onClose={() => actions.setModal(null)} />
      <div className="modal-body">
        <div className="field">
          <label htmlFor="rename-input">New name</label>
          <input
            id="rename-input"
            className="input"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit()
            }}
          />
          <span className="muted" style={{ fontSize: 11 }}>
            {path}
          </span>
        </div>
      </div>
      <Footer onCancel={() => actions.setModal(null)} onConfirm={submit} confirmLabel="Rename" />
    </>
  )
}

function TaskModal() {
  const actions = useActions()
  const { modal, notes } = useAppState()
  const draft = modal?.draft ?? { title: '' }
  const [title, setTitle] = useState(draft.title ?? '')
  const [description, setDescription] = useState(draft.description ?? '')
  const [status, setStatus] = useState(draft.status ?? 'todo')
  const [priority, setPriority] = useState(draft.priority ?? 'none')
  const [dueDate, setDueDate] = useState(draft.dueDate ?? '')
  const [startTime, setStartTime] = useState(draft.startTime ?? '')
  const [endTime, setEndTime] = useState(draft.endTime ?? '')
  const [duration, setDuration] = useState(draft.durationMinutes ? String(draft.durationMinutes) : '')
  const [noteId, setNoteId] = useState(draft.noteId ?? '')
  const [recurrence, setRecurrence] = useState(draft.recurrence ?? '')

  const submit = () => {
    const trimmed = title.trim()
    if (!trimmed) return
    const task: Partial<TaskRecord> & { title: string } = {
      ...draft,
      id: draft.id ?? '',
      title: trimmed,
      description,
      status,
      priority,
      timezone: draft.timezone ?? 'local',
      createdAt: draft.createdAt ?? 0,
      updatedAt: 0,
    }
    if (dueDate) task.dueDate = dueDate
    if (startTime) task.startTime = startTime
    if (endTime) task.endTime = endTime
    if (duration) task.durationMinutes = Number(duration)
    if (noteId) task.noteId = noteId
    if (recurrence) task.recurrence = recurrence
    actions.saveTask(task)
    actions.setModal(null)
  }

  return (
    <>
      <Header title={draft.id ? 'Edit task' : 'New task'} onClose={() => actions.setModal(null)} />
      <div className="modal-body">
        <div className="field">
          <label htmlFor="task-title">Title</label>
          <input
            id="task-title"
            className="input"
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="task-desc">Description</label>
          <textarea
            id="task-desc"
            className="textarea"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor="task-status">Status</label>
            <select
              id="task-status"
              className="select"
              value={status}
              onChange={(event) => setStatus(event.target.value as TaskRecord['status'])}
            >
              <option value="todo">To do</option>
              <option value="doing">In progress</option>
              <option value="done">Done</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="task-priority">Priority</label>
            <select
              id="task-priority"
              className="select"
              value={priority}
              onChange={(event) => setPriority(event.target.value as TaskRecord['priority'])}
            >
              <option value="none">None</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor="task-due">Due date</label>
            <input
              id="task-due"
              className="input"
              type="date"
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="task-start">Start time</label>
            <input
              id="task-start"
              className="input"
              type="time"
              value={startTime}
              onChange={(event) => setStartTime(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="task-end">End time</label>
            <input
              id="task-end"
              className="input"
              type="time"
              value={endTime}
              onChange={(event) => setEndTime(event.target.value)}
            />
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor="task-duration">Duration (minutes)</label>
            <input
              id="task-duration"
              className="input"
              type="number"
              min={0}
              value={duration}
              onChange={(event) => setDuration(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="task-recurrence">Repeats (RRULE)</label>
            <input
              id="task-recurrence"
              className="input"
              placeholder="FREQ=WEEKLY;COUNT=4"
              value={recurrence}
              onChange={(event) => setRecurrence(event.target.value)}
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="task-note">Linked note</label>
          <select
            id="task-note"
            className="select"
            value={noteId}
            onChange={(event) => setNoteId(event.target.value)}
          >
            <option value="">(none)</option>
            {notes.map((note) => (
              <option key={note.id} value={note.id}>
                {note.title || note.path}
              </option>
            ))}
          </select>
        </div>
      </div>
      <Footer onCancel={() => actions.setModal(null)} onConfirm={submit} confirmLabel="Save task" />
    </>
  )
}

function EventModal() {
  const actions = useActions()
  const { modal } = useAppState()
  const draft = modal?.eventDraft ?? { title: '' }
  const start = draft.startUtc ?? Date.now()
  const end = draft.endUtc ?? start + 3_600_000

  const [title, setTitle] = useState(draft.title ?? '')
  const [description, setDescription] = useState(draft.description ?? '')
  const [allDay, setAllDay] = useState(draft.allDay ?? false)
  const [startDate, setStartDate] = useState(isoDate(new Date(start)))
  const [startTime, setStartTime] = useState(isoTime(new Date(start)))
  const [endDate, setEndDate] = useState(isoDate(new Date(end)))
  const [endTime, setEndTime] = useState(isoTime(new Date(end)))
  const [location, setLocation] = useState(draft.location ?? '')
  const [rrule, setRrule] = useState(draft.rrule ?? '')

  const submit = () => {
    const trimmed = title.trim()
    if (!trimmed) return
    const startUtc = allDay
      ? localTimestamp(startDate)
      : localTimestamp(startDate, startTime)
    const endUtc = allDay
      ? localTimestamp(endDate) + 86_400_000
      : localTimestamp(endDate, endTime)
    const event: Partial<EventRecord> & { title: string } = {
      ...draft,
      id: draft.id ?? '',
      title: trimmed,
      description,
      allDay: allDay,
      startUtc: startUtc,
      endUtc: Math.max(endUtc, startUtc + 60_000),
      timezone: draft.timezone ?? 'local',
      exdates: draft.exdates ?? [],
      createdAt: draft.createdAt ?? 0,
      updatedAt: 0,
    }
    if (location) event.location = location
    if (rrule) event.rrule = rrule
    actions.saveEvent(event)
    actions.setModal(null)
  }

  return (
    <>
      <Header title={draft.id ? 'Edit event' : 'New event'} onClose={() => actions.setModal(null)} />
      <div className="modal-body">
        <div className="field">
          <label htmlFor="event-title">Title</label>
          <input
            id="event-title"
            className="input"
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="event-desc">Description</label>
          <textarea
            id="event-desc"
            className="textarea"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        <div className="field">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={allDay}
              onChange={(event) => setAllDay(event.target.checked)}
              style={{ accentColor: 'var(--accent)' }}
            />
            All day
          </label>
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor="event-start-date">Starts</label>
            <input
              id="event-start-date"
              className="input"
              type="date"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
            />
          </div>
          {!allDay && (
            <div className="field">
              <label htmlFor="event-start-time">Time</label>
              <input
                id="event-start-time"
                className="input"
                type="time"
                value={startTime}
                onChange={(event) => setStartTime(event.target.value)}
              />
            </div>
          )}
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor="event-end-date">Ends</label>
            <input
              id="event-end-date"
              className="input"
              type="date"
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
            />
          </div>
          {!allDay && (
            <div className="field">
              <label htmlFor="event-end-time">Time</label>
              <input
                id="event-end-time"
                className="input"
                type="time"
                value={endTime}
                onChange={(event) => setEndTime(event.target.value)}
              />
            </div>
          )}
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor="event-location">Location</label>
            <input
              id="event-location"
              className="input"
              value={location}
              onChange={(event) => setLocation(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="event-rrule">Repeats (RRULE)</label>
            <input
              id="event-rrule"
              className="input"
              placeholder="FREQ=WEEKLY;BYDAY=MO,WE"
              value={rrule}
              onChange={(event) => setRrule(event.target.value)}
            />
          </div>
        </div>
      </div>
      <Footer onCancel={() => actions.setModal(null)} onConfirm={submit} confirmLabel="Save event" />
    </>
  )
}

/** Ask whether a recurring change applies to one occurrence or the series. */
function RecurrenceScopeModal() {
  const actions = useActions()
  const { modal } = useAppState()
  const action = modal?.recurrence
  if (!action) return null

  const applyScope = (scope: 'single' | 'following' | 'all') => {
    const { event, occurrenceStart } = action
    const duration = Math.max(0, event.endUtc - event.startUtc)

    if (scope === 'all') {
      if (action.type === 'delete') {
        actions.deleteEvent(event.id)
      } else if (action.type === 'move' && action.newStart !== undefined) {
        actions.saveEvent({
          ...event,
          startUtc: action.newStart,
          endUtc: action.newStart + duration,
        })
      } else if (action.type === 'edit') {
        actions.setModal({ kind: 'event', eventDraft: { ...event } })
      }
      actions.setModal(null)
      return
    }

    if (scope === 'single') {
      // Exclude this occurrence, then create a one-off for the change.
      const exdates = [...(event.exdates ?? []), String(occurrenceStart)]
      if (action.type === 'delete') {
        actions.saveEvent({ ...event, exdates })
      } else if (action.type === 'move' && action.newStart !== undefined) {
        actions.saveEvent({ ...event, exdates })
        actions.saveEvent({
          title: event.title,
          description: event.description,
          startUtc: action.newStart,
          endUtc: action.newStart + duration,
          allDay: event.allDay,
          timezone: event.timezone,
          exdates: [],
          location: event.location,
          noteId: event.noteId,
          taskId: event.taskId,
        })
      } else if (action.type === 'edit') {
        actions.saveEvent({ ...event, exdates })
        actions.setModal({
          kind: 'event',
          eventDraft: {
            ...event,
            id: '',
            startUtc: occurrenceStart,
            endUtc: occurrenceStart + duration,
            rrule: undefined,
            exdates: [],
          },
        })
      }
      actions.setModal(null)
      return
    }

    // "This and following": truncate the series and start a new one.
    const split = splitSeries(
      {
        id: event.id,
        startUtc: event.startUtc,
        endUtc: event.endUtc,
        rrule: event.rrule,
        exdates: event.exdates,
      },
      occurrenceStart,
    )
    if (!split) {
      // No earlier occurrences — treat it as the whole series.
      applyScope('all')
      return
    }
    actions.saveEvent({
      ...event,
      rrule: split.before.rrule,
      exdates: split.before.exdates,
    })
    if (action.type === 'delete') {
      // Truncating the original series already removes the later occurrences.
      actions.setModal(null)
      return
    }
    actions.saveEvent({
      title: event.title,
      description: event.description,
      startUtc: action.newStart ?? split.after.startUtc,
      endUtc: action.newStart
        ? action.newStart + duration
        : split.after.startUtc + duration,
      allDay: event.allDay,
      timezone: event.timezone,
      rrule: split.after.rrule,
      exdates: [],
      location: event.location,
      noteId: event.noteId,
      taskId: event.taskId,
    })
    actions.setModal(null)
  }

  const label = action.type === 'delete' ? 'delete' : action.type === 'move' ? 'move' : 'edit'

  return (
    <>
      <Header title={`Recurring event — ${label}`} onClose={() => actions.setModal(null)} />
      <div className="modal-body">
        <p style={{ marginTop: 0 }}>
          “{action.event.title}” repeats. Which occurrences should this apply to?
        </p>
        <div className="field">
          <button type="button" className="btn" style={{ width: '100%' }} onClick={() => applyScope('single')}>
            This event only
          </button>
        </div>
        <div className="field">
          <button type="button" className="btn" style={{ width: '100%' }} onClick={() => applyScope('following')}>
            This event and following ones
          </button>
        </div>
        <div className="field">
          <button type="button" className="btn" style={{ width: '100%' }} onClick={() => applyScope('all')}>
            All events in the series
          </button>
        </div>
      </div>
      <Footer onCancel={() => actions.setModal(null)} onConfirm={() => applyScope('all')} confirmLabel="All events" />
    </>
  )
}

function ShortcutsModal() {
  const actions = useActions()
  const shortcuts: [string, string][] = [
    ['Ctrl+N', 'New note'],
    ['Ctrl+Shift+N', 'New folder'],
    ['Ctrl+O', 'Open another vault'],
    ['Ctrl+S', 'Save the current note'],
    ['Ctrl+P', 'Quick open'],
    ['Ctrl+Shift+P', 'Command palette'],
    ['Ctrl+1…4', 'Switch between notes, tasks, calendar and drawings'],
    ['Ctrl+E', 'Cycle the note view (reading, split, editing)'],
    ['Ctrl+Shift+L', 'Toggle light / dark theme'],
    ['Ctrl+Enter', 'Follow the link under the cursor'],
    ['Ctrl+Tab', 'Next tab'],
    ['Ctrl+Shift+Tab', 'Previous tab'],
    ['Ctrl+Alt+←/→', 'Back / forward'],
    ['Ctrl+/', 'Show this list'],
    ['Esc', 'Close a dialog or menu'],
  ]
  return (
    <>
      <Header title="Keyboard shortcuts" onClose={() => actions.setModal(null)} />
      <div className="modal-body">
        <div className="shortcut-grid">
          {shortcuts.map(([keys, description]) => (
            <div className="shortcut-row" key={keys}>
              <span>{description}</span>
              <kbd>{keys}</kbd>
            </div>
          ))}
        </div>
      </div>
      <Footer onCancel={() => actions.setModal(null)} onConfirm={() => actions.setModal(null)} confirmLabel="Close" />
    </>
  )
}

function AboutModal() {
  const actions = useActions()
  let version = '0.0.0'
  try {
    version = api.coreVersion()
  } catch {
    /* the core may not be loaded yet */
  }
  return (
    <>
      <Header title="About Delta" onClose={() => actions.setModal(null)} />
      <div className="modal-body">
        <p style={{ marginTop: 0 }}>
          <strong>Delta</strong> is a local-first knowledge base: Markdown notes, tasks, a calendar
          and Excalidraw drawings in one workspace.
        </p>
        <div className="divider" />
        <div className="shortcut-grid">
          <div className="shortcut-row">
            <span>Rust core</span>
            <kbd>{version}</kbd>
          </div>
          <div className="shortcut-row">
            <span>Storage</span>
            <kbd>Markdown + SQLite</kbd>
          </div>
          <div className="shortcut-row">
            <span>Network</span>
            <kbd>Not required</kbd>
          </div>
          <div className="shortcut-row">
            <span>Theme</span>
            <kbd>Nord</kbd>
          </div>
        </div>
      </div>
      <Footer onCancel={() => actions.setModal(null)} onConfirm={() => actions.setModal(null)} confirmLabel="Close" />
    </>
  )
}

function RestoreModal() {
  const actions = useActions()
  const [backups, setBackups] = useState<{ path: string; name: string; size: number }[]>([])
  const [dir, setDir] = useState('')

  const browse = async () => {
    const chosen = await api.pickFolder('Choose the folder that holds your backups')
    if (!chosen) return
    setDir(chosen)
    try {
      setBackups(api.listBackups(chosen))
    } catch {
      setBackups([])
    }
  }

  return (
    <>
      <Header title="Restore a backup" onClose={() => actions.setModal(null)} />
      <div className="modal-body">
        <p style={{ marginTop: 0 }}>
          A backup archive is restored into a folder you choose, keeping the original vault
          structure intact.
        </p>
        <div className="field">
          <button type="button" className="btn" style={{ width: '100%' }} onClick={() => void browse()}>
            Choose the backup folder…
          </button>
        </div>
        {dir && (
          <p className="muted" style={{ fontSize: 11.5 }}>
            {dir}
          </p>
        )}
        {backups.length === 0 && dir && (
          <p className="muted" style={{ fontSize: 12 }}>
            No .zip archives found in that folder.
          </p>
        )}
        {backups.map((backup) => (
          <div className="setting-row" key={backup.path}>
            <div>
              <div className="label mono">{backup.name}</div>
              <div className="desc">{api.humanSize(backup.size)}</div>
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => {
                void actions.restoreBackup(backup.path)
                actions.setModal(null)
              }}
            >
              Restore…
            </button>
          </div>
        ))}
      </div>
      <Footer onCancel={() => actions.setModal(null)} onConfirm={() => actions.setModal(null)} confirmLabel="Close" />
    </>
  )
}

function DeleteConfirmModal() {
  const actions = useActions()
  const { modal } = useAppState()
  const target = modal?.target ?? ''
  return (
    <>
      <Header title="Delete" onClose={() => actions.setModal(null)} />
      <div className="modal-body">
        <p style={{ marginTop: 0 }}>
          Move <strong>{target}</strong> to the trash? It can be restored afterwards.
        </p>
      </div>
      <Footer
        onCancel={() => actions.setModal(null)}
        onConfirm={() => {
          actions.deleteEntry(target)
          actions.setModal(null)
        }}
        confirmLabel="Move to trash"
        danger
      />
    </>
  )
}
