import { useMemo, useState, type DragEvent } from 'react'
import type { EventRecord, TaskRecord } from '@shared/types'
import { useActions, useAppState } from '../lib/store'
import {
  addDays,
  addMonths,
  formatDate,
  formatTime,
  isoDate,
  localTimestamp,
  monthGrid,
  monthName,
  parseIsoDate,
  startOfWeek,
  today,
  weekDays,
} from '../lib/dates'
import { occurrencesIn } from '../lib/recurrence'
import { IconPlus } from '../components/Icons'

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const HOUR_HEIGHT = 46
const START_HOUR = 6
const END_HOUR = 23

interface ScheduledItem {
  id: string
  title: string
  start: number
  end: number
  allDay: boolean
  kind: 'event' | 'task'
  done?: boolean
  event?: EventRecord
  task?: TaskRecord
}

export function CalendarView() {
  const state = useAppState()
  const actions = useActions()
  const cursor = parseIsoDate(state.calendarCursor)
  const [dragId, setDragId] = useState<string | null>(null)

  const items = useMemo<ScheduledItem[]>(() => {
    const out: ScheduledItem[] = []

    for (const event of state.events) {
      out.push({
        id: `event:${event.id}`,
        title: event.title,
        start: event.startUtc,
        end: event.endUtc,
        allDay: event.allDay,
        kind: 'event',
        event,
      })
    }
    for (const task of state.tasks) {
      if (task.status === 'cancelled') continue
      if (task.dueDate) {
        const start = localTimestamp(task.dueDate, task.startTime ?? '09:00')
        const duration = (task.durationMinutes ?? 60) * 60_000
        out.push({
          id: `task:${task.id}`,
          title: task.title,
          start,
          end: start + duration,
          allDay: !task.startTime,
          kind: 'task',
          done: task.status === 'done',
          task,
        })
      }
    }
    return out
  }, [state.events, state.tasks])

  const expanded = useMemo(() => {
    const out: ScheduledItem[] = []
    for (const item of items) {
      if (item.kind === 'task') {
        out.push(item)
        continue
      }
      const event = item.event!
      if (!event.rrule) {
        out.push(item)
        continue
      }
      // Expand a recurring series across a wide window around the cursor.
      const windowStart = new Date(cursor.getFullYear(), cursor.getMonth() - 2, 1).getTime()
      const windowEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 3, 1).getTime()
      const occurrences = occurrencesIn(
        {
          id: event.id,
          startUtc: event.startUtc,
          endUtc: event.endUtc,
          rrule: event.rrule,
          exdates: event.exdates,
        },
        windowStart,
        windowEnd,
      )
      for (const occurrence of occurrences) {
        out.push({
          ...item,
          id: `event:${event.id}:${occurrence.start}`,
          start: occurrence.start,
          end: occurrence.end,
          original: occurrence.original,
        } as ScheduledItem & { original: boolean })
      }
    }
    return out
  }, [items, cursor])

  const byDay = useMemo(() => {
    const map = new Map<string, ScheduledItem[]>()
    for (const item of expanded) {
      const key = isoDate(new Date(item.start))
      const list = map.get(key) ?? []
      list.push(item)
      map.set(key, list)
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        if (a.allDay !== b.allDay) return a.allDay ? -1 : 1
        return a.start - b.start
      })
    }
    return map
  }, [expanded])

  const move = (item: ScheduledItem, newStart: number) => {
    if (!item.event) return
    const duration = Math.max(0, item.end - item.start)
    const event = item.event
    if (event.rrule) {
      actions.setModal({
        kind: 'recurrence-scope',
        recurrence: {
          type: 'move',
          event,
          occurrenceStart: item.start,
          newStart,
          newEnd: newStart + duration,
        },
      })
      return
    }
    actions.saveEvent({
      ...event,
      startUtc: newStart,
      endUtc: newStart + duration,
    })
  }

  const removeItem = (item: ScheduledItem) => {
    if (item.task) {
      actions.deleteTask(item.task.id)
      return
    }
    const event = item.event!
    if (event.rrule) {
      actions.setModal({
        kind: 'recurrence-scope',
        recurrence: { type: 'delete', event, occurrenceStart: item.start },
      })
      return
    }
    actions.deleteEvent(event.id)
  }

  const editItem = (item: ScheduledItem) => {
    if (item.task) {
      actions.setModal({ kind: 'task', draft: { ...item.task } })
      return
    }
    const event = item.event!
    if (event.rrule) {
      actions.setModal({
        kind: 'recurrence-scope',
        recurrence: { type: 'edit', event, occurrenceStart: item.start },
      })
      return
    }
    actions.setModal({ kind: 'event', eventDraft: { ...event } })
  }

  /**
   * `exactTime` is set by the week/day grid, where the drop position already
   * encodes an hour of the day. The month grid keeps the original time and
   * only changes the date.
   */
  const onDropOnDay = (event: DragEvent, day: Date, exactTime = false) => {
    event.preventDefault()
    const id = event.dataTransfer.getData('text/plain')
    setDragId(null)
    if (!id) return
    const item = expanded.find((candidate) => candidate.id === id)
    if (!item) return
    const source = new Date(item.start)
    const hours = exactTime ? day.getHours() : source.getHours()
    const minutes = exactTime ? day.getMinutes() : source.getMinutes()
    const newStart = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      hours,
      minutes,
    ).getTime()
    move(item, newStart)
  }

  const headerLabel =
    state.calendarMode === 'month'
      ? `${monthName(cursor)} ${cursor.getFullYear()}`
      : state.calendarMode === 'week'
        ? `${formatDate(startOfWeek(cursor), 'short')} – ${formatDate(addDays(startOfWeek(cursor), 6), 'short')}`
        : formatDate(cursor, 'long')

  const step = (direction: number) => {
    if (state.calendarMode === 'month') {
      const next = addMonths(cursor, direction)
      actions.setCalendarCursor(isoDate(next))
    } else if (state.calendarMode === 'week') {
      actions.setCalendarCursor(isoDate(addDays(cursor, direction * 7)))
    } else {
      actions.setCalendarCursor(isoDate(addDays(cursor, direction)))
    }
  }

  const createAt = (day: Date, time?: string) => {
    const date = isoDate(day)
    const start = localTimestamp(date, time ?? '09:00')
    actions.setModal({
      kind: 'event',
      eventDraft: {
        title: '',
        startUtc: start,
        endUtc: start + 60 * 60_000,
        allDay: false,
        timezone: 'local',
        exdates: [],
      },
    })
  }

  return (
    <div className="calendar-layout">
      <div className="toolbar">
        <button type="button" className="btn" onClick={() => step(-1)} aria-label="Previous period">
          ‹
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => actions.setCalendarCursor(isoDate(today()))}
        >
          Today
        </button>
        <button type="button" className="btn" onClick={() => step(1)} aria-label="Next period">
          ›
        </button>
        <span className="toolbar-title" style={{ marginLeft: 8 }}>
          {headerLabel}
        </span>
        <span className="toolbar-spacer" />
        <div className="seg">
          {(['month', 'week', 'day'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={state.calendarMode === mode ? 'active' : ''}
              onClick={() => actions.setCalendarMode(mode)}
            >
              {mode[0].toUpperCase() + mode.slice(1)}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn primary"
          onClick={() => createAt(cursor)}
        >
          <IconPlus /> New event
        </button>
      </div>

      <div className="calendar-grid-wrap">
        {state.calendarMode === 'month' && (
          <MonthGrid
            cursor={cursor}
            byDay={byDay}
            onDropOnDay={onDropOnDay}
            onCreate={createAt}
            onEdit={editItem}
            onDelete={removeItem}
            dragId={dragId}
            setDragId={setDragId}
          />
        )}
        {(state.calendarMode === 'week' || state.calendarMode === 'day') && (
          <TimeGrid
            days={state.calendarMode === 'week' ? weekDays(cursor) : [cursor]}
            byDay={byDay}
            onDropOnDay={onDropOnDay}
            onCreate={createAt}
            onEdit={editItem}
            onDelete={removeItem}
            dragId={dragId}
            setDragId={setDragId}
          />
        )}
      </div>
    </div>
  )
}

function MonthGrid({
  cursor,
  byDay,
  onDropOnDay,
  onCreate,
  onEdit,
  onDelete,
  dragId,
  setDragId,
}: {
  cursor: Date
  byDay: Map<string, ScheduledItem[]>
  onDropOnDay(event: DragEvent, day: Date, exactTime?: boolean): void
  onCreate(day: Date, time?: string): void
  onEdit(item: ScheduledItem): void
  onDelete(item: ScheduledItem): void
  dragId: string | null
  setDragId(id: string | null): void
}) {
  const days = useMemo(() => monthGrid(cursor), [cursor])
  const now = today()

  return (
    <div className="cal-grid">
      {WEEKDAY_LABELS.map((label) => (
        <div className="cal-weekday" key={label}>
          {label}
        </div>
      ))}
      {days.map((day) => {
        const key = isoDate(day)
        const items = byDay.get(key) ?? []
        const outside = day.getMonth() !== cursor.getMonth()
        const isToday = key === isoDate(now)
        return (
          <div
            key={key}
            className={`cal-cell${outside ? ' outside' : ''}${isToday ? ' today' : ''}`}
            onDragOver={(event) => {
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
            }}
            onDrop={(event) => onDropOnDay(event, day)}
            onDoubleClick={() => onCreate(day)}
          >
            <div className="cal-daynum">{day.getDate()}</div>
            {items.slice(0, 4).map((item) => (
              <div
                key={item.id}
                className={`cal-event${item.kind === 'task' ? ' task' : ''}${item.done ? ' done' : ''}${
                  item.allDay ? ' allday' : ''
                }${dragId === item.id ? ' dragging' : ''}`}
                draggable
                onDragStart={(event) => {
                  setDragId(item.id)
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', item.id)
                }}
                onDragEnd={() => setDragId(null)}
                onClick={(event) => {
                  event.stopPropagation()
                  onEdit(item)
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  onDelete(item)
                }}
                title={`${item.title}${item.kind === 'task' ? ' (task)' : ''}${
                  item.allDay ? ' — all day' : ` — ${formatTime(item.start)}`
                }`}
              >
                {item.kind === 'task' && (item.done ? '☑ ' : '☐ ')}
                {item.title}
              </div>
            ))}
            {items.length > 4 && (
              <div className="muted" style={{ fontSize: 10.5, paddingLeft: 4 }}>
                +{items.length - 4} more
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function TimeGrid({
  days,
  byDay,
  onDropOnDay,
  onCreate,
  onEdit,
  onDelete,
  dragId,
  setDragId,
}: {
  days: Date[]
  byDay: Map<string, ScheduledItem[]>
  onDropOnDay(event: DragEvent, day: Date, exactTime?: boolean): void
  onCreate(day: Date, time?: string): void
  onEdit(item: ScheduledItem): void
  onDelete(item: ScheduledItem): void
  dragId: string | null
  setDragId(id: string | null): void
}) {
  const now = today()
  const hours = Array.from({ length: END_HOUR - START_HOUR + 1 }, (_, i) => START_HOUR + i)

  const positioned = (day: Date) => {
    const items = (byDay.get(isoDate(day)) ?? []).filter((item) => !item.allDay)
    return items.map((item) => {
      const start = new Date(item.start)
      const offset = (start.getHours() + start.getMinutes() / 60 - START_HOUR) * HOUR_HEIGHT
      const durationMinutes = Math.max(15, (item.end - item.start) / 60_000)
      const height = (durationMinutes / 60) * HOUR_HEIGHT
      return { item, offset: Math.max(0, offset), height: Math.max(18, height) }
    })
  }

  return (
    <div className="cal-week" style={{ gridTemplateColumns: `52px repeat(${days.length}, minmax(0, 1fr))` }}>
      <div className="cal-timecol">
        {hours.map((hour) => (
          <div className="cal-hour-label" key={hour}>
            {String(hour).padStart(2, '0')}:00
          </div>
        ))}
      </div>

      {days.map((day) => {
        const key = isoDate(day)
        const allDay = (byDay.get(key) ?? []).filter((item) => item.allDay)
        return (
          <div className="cal-daycol" key={key}>
            <div className={`cal-daycol-header${key === isoDate(now) ? ' today' : ''}`}>
              {WEEKDAY_LABELS[(day.getDay() + 6) % 7]} {day.getDate()}
            </div>
            {allDay.map((item) => (
              <div
                key={item.id}
                className={`cal-event${item.kind === 'task' ? ' task' : ''}${item.done ? ' done' : ''} allday`}
                style={{ margin: '2px 2px 0' }}
                draggable
                onDragStart={(event) => {
                  setDragId(item.id)
                  event.dataTransfer.setData('text/plain', item.id)
                }}
                onDragEnd={() => setDragId(null)}
                onClick={() => onEdit(item)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  onDelete(item)
                }}
              >
                {item.title}
              </div>
            ))}
            {hours.map((hour) => (
              <div
                className="cal-hour-line"
                key={hour}
                onDoubleClick={() => onCreate(day, `${String(hour).padStart(2, '0')}:00`)}
                onDragOver={(event) => {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                }}
                onDrop={(event) => {
                  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
                  const minutes = ((event.clientY - rect.top) / HOUR_HEIGHT) * 60
                  const snapped = Math.round(minutes / 15) * 15
                  const hour = Math.min(23, Math.max(0, START_HOUR + Math.floor(snapped / 60)))
                  const minute = Math.floor(snapped % 60)
                  const target = new Date(
                    day.getFullYear(),
                    day.getMonth(),
                    day.getDate(),
                    hour,
                    minute,
                  )
                  onDropOnDay(event, target, true)
                }}
              />
            ))}
            {positioned(day).map(({ item, offset, height }) => (
              <div
                key={item.id}
                className={`cal-event absolute${item.kind === 'task' ? ' task' : ''}${item.done ? ' done' : ''}${
                  dragId === item.id ? ' dragging' : ''
                }`}
                style={{
                  top: offset + 26,
                  height: Math.min(height, 400),
                  background:
                    item.kind === 'task'
                      ? 'color-mix(in srgb, var(--green) 30%, transparent)'
                      : 'color-mix(in srgb, var(--accent-dim) 34%, transparent)',
                }}
                draggable
                onDragStart={(event) => {
                  setDragId(item.id)
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', item.id)
                }}
                onDragEnd={() => setDragId(null)}
                onClick={() => onEdit(item)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  onDelete(item)
                }}
                title={item.title}
              >
                {item.title}
                <div style={{ fontSize: 10, opacity: 0.8 }}>{formatTime(item.start)}</div>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}

/** Small helper used by the modal to prefill a new event. */
export function defaultEventAt(day: Date): Partial<EventRecord> & { title: string } {
  const date = isoDate(day)
  const start = localTimestamp(date, '09:00')
  return {
    title: '',
    startUtc: start,
    endUtc: start + 3_600_000,
    allDay: false,
    timezone: 'local',
    exdates: [],
  }
}
