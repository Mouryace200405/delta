import { useMemo, useState } from 'react'
import type { TaskRecord } from '@shared/types'
import { useActions, useAppState, type TaskFilter } from '../lib/store'
import { dueLabel, isoDate, parseIsoDate, today } from '../lib/dates'
import { IconCalendar, IconCheck, IconClose, IconLink, IconPlus } from '../components/Icons'

const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
}

const STATUS_LABEL: Record<string, string> = {
  todo: 'To do',
  doing: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
}

export function TasksView() {
  const state = useAppState()
  const actions = useActions()
  const [quickTitle, setQuickTitle] = useState('')

  const counts = useMemo(() => {
    const now = today()
    const iso = isoDate(now)
    let todayCount = 0
    let overdue = 0
    let upcoming = 0
    let completed = 0
    for (const task of state.tasks) {
      if (task.status === 'done') {
        completed += 1
        continue
      }
      if (!task.dueDate) continue
      if (task.dueDate === iso) todayCount += 1
      else if (task.dueDate < iso) overdue += 1
      else upcoming += 1
    }
    return {
      all: state.tasks.length,
      today: todayCount,
      upcoming,
      overdue,
      completed,
      priority: state.tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled').length,
      status: state.tasks.length,
    }
  }, [state.tasks])

  const visible = useMemo(() => {
    const iso = isoDate(today())
    const open = state.tasks.filter((t) => t.status !== 'cancelled')

    switch (state.taskFilter) {
      case 'today':
        return open.filter((t) => t.status !== 'done' && t.dueDate === iso)
      case 'upcoming':
        return open.filter((t) => t.status !== 'done' && (t.dueDate ?? '') > iso)
      case 'overdue':
        return open.filter((t) => t.status !== 'done' && (t.dueDate ?? '') < iso)
      case 'completed':
        return state.tasks.filter((t) => t.status === 'done')
      case 'priority':
        return [...open].sort((a, b) => {
          const pa = PRIORITY_ORDER[a.priority] ?? 9
          const pb = PRIORITY_ORDER[b.priority] ?? 9
          if (pa !== pb) return pa - pb
          return (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999')
        })
      case 'status':
        return [...open].sort((a, b) => a.status.localeCompare(b.status))
      default:
        return open
    }
  }, [state.tasks, state.taskFilter])

  const grouped = useMemo(() => {
    if (state.taskFilter !== 'status') return null
    const map = new Map<string, TaskRecord[]>()
    for (const task of visible) {
      const list = map.get(task.status) ?? []
      list.push(task)
      map.set(task.status, list)
    }
    return map
  }, [visible, state.taskFilter])

  const noteTitle = (path?: string) => {
    if (!path) return undefined
    return state.notes.find((note) => note.path === path)?.title ?? path.split('/').pop()
  }

  const addQuick = () => {
    const title = quickTitle.trim()
    if (!title) return
    actions.saveTask({
      title,
      description: '',
      status: 'todo',
      priority: 'none',
      timezone: 'local',
      createdAt: 0,
      updatedAt: 0,
    })
    setQuickTitle('')
  }

  const filters: { id: TaskFilter; label: string; count: number }[] = [
    { id: 'all', label: 'All tasks', count: counts.all },
    { id: 'today', label: 'Today', count: counts.today },
    { id: 'upcoming', label: 'Upcoming', count: counts.upcoming },
    { id: 'overdue', label: 'Overdue', count: counts.overdue },
    { id: 'completed', label: 'Completed', count: counts.completed },
    { id: 'priority', label: 'By priority', count: counts.priority },
    { id: 'status', label: 'By status', count: counts.status },
  ]

  return (
    <div className="task-layout">
      <div className="task-filters">
        {filters.map((filter) => (
          <div
            key={filter.id}
            className={`task-filter${state.taskFilter === filter.id ? ' active' : ''}`}
            onClick={() => actions.setTaskFilter(filter.id)}
          >
            <span>{filter.label}</span>
            <span className="count">{filter.count}</span>
          </div>
        ))}
      </div>

      <div className="task-list">
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input
            className="input"
            placeholder="Add a task and press Enter…"
            value={quickTitle}
            onChange={(event) => setQuickTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') addQuick()
            }}
          />
          <button type="button" className="btn primary" onClick={addQuick}>
            <IconPlus /> Add
          </button>
        </div>

        {visible.length === 0 ? (
          <div className="empty">
            <h3>Nothing here</h3>
            <p>
              {state.taskFilter === 'completed'
                ? 'Completed tasks will appear here.'
                : 'Add a task using the field above, or press Ctrl+2 to switch views.'}
            </p>
          </div>
        ) : grouped ? (
          Array.from(grouped.entries()).map(([status, list]) => (
            <div key={status}>
              <div className="sidebar-section" style={{ paddingLeft: 0 }}>
                {STATUS_LABEL[status] ?? status} · {list.length}
              </div>
              {list.map((task) => (
                <TaskRow key={task.id} task={task} noteTitle={noteTitle} />
              ))}
            </div>
          ))
        ) : (
          visible.map((task) => <TaskRow key={task.id} task={task} noteTitle={noteTitle} />)
        )}
      </div>
    </div>
  )
}

function TaskRow({
  task,
  noteTitle,
}: {
  task: TaskRecord
  noteTitle(path?: string): string | undefined
}) {
  const actions = useActions()
  const { notes } = useAppState()
  const done = task.status === 'done'
  const due = task.dueDate ? dueLabel(task.dueDate) : null
  const linkedNote = task.noteId
    ? notes.find((note) => note.id === task.noteId)?.path
    : undefined

  return (
    <div className={`task-row${done ? ' done' : ''}`}>
      <button
        type="button"
        className={`task-check${done ? ' checked' : ''}`}
        aria-label={done ? 'Mark as not done' : 'Mark as done'}
        onClick={() => actions.toggleTask(task)}
      >
        {done && <IconCheck />}
      </button>

      <div className="task-body">
        <div className="task-title">{task.title}</div>
        {task.description && <div className="task-desc">{task.description}</div>}
        <div className="task-meta">
          {task.priority !== 'none' && (
            <span className={`chip prio-${task.priority}`}>{task.priority}</span>
          )}
          {due && <span className={`chip ${due.tone}`}>{due.text}</span>}
          {task.startTime && <span className="chip">{task.startTime}</span>}
          {task.recurrence && <span className="chip">recurring</span>}
          {linkedNote && (
            <span className="chip linked" onClick={() => actions.openNote(linkedNote)}>
              <IconLink /> {noteTitle(task.noteId)}
            </span>
          )}
          {task.status !== 'done' && task.status !== 'cancelled' && (
            <span
              className="chip linked"
              onClick={() => actions.scheduleTaskOnCalendar(task, isoDate(today()))}
              title="Schedule this task for today"
            >
              <IconCalendar /> schedule
            </span>
          )}
        </div>
      </div>

      <div className="task-actions">
        <button
          type="button"
          className="btn ghost icon"
          title="Edit task"
          onClick={() => actions.setModal({ kind: 'task', draft: { ...task } })}
        >
          ✎
        </button>
        <button
          type="button"
          className="btn ghost icon danger"
          title="Delete task"
          onClick={() => actions.deleteTask(task.id)}
        >
          <IconClose />
        </button>
      </div>
    </div>
  )
}

/** Parse a due date into a Date (helper kept local to the view). */
export function dueDateOf(task: TaskRecord): Date | undefined {
  return task.dueDate ? parseIsoDate(task.dueDate) : undefined
}
