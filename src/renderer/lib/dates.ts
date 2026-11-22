/**
 * Date helpers built on the native Date API.
 *
 * Everything works in the user's local zone. Calendar arithmetic is done on
 * local calendar fields (year/month/day) rather than by adding milliseconds,
 * so a 23-hour or 25-hour DST day never shifts a date.
 */

export const MS_DAY = 86_400_000

export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
  } catch {
    return 'local'
  }
}

export function today(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

export function isoDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function isoTime(date: Date): string {
  const h = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  return `${h}:${min}`
}

export function parseIsoDate(value: string): Date {
  const [y, m, d] = value.split('-').map(Number)
  if (!y || !m || !d) return today()
  return new Date(y, m - 1, d)
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

export function addMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, 1)
}

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

export function endOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0)
}

export function startOfWeek(date: Date): Date {
  const day = date.getDay()
  const diff = day === 0 ? -6 : 1 - day
  return addDays(new Date(date.getFullYear(), date.getMonth(), date.getDate()), diff)
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

export function endOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999)
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

export function daysBetween(a: Date, b: Date): number {
  const start = startOfDay(a).getTime()
  const end = startOfDay(b).getTime()
  return Math.round((end - start) / MS_DAY)
}

/** The 6-week grid a month view renders, starting on Monday. */
export function monthGrid(date: Date): Date[] {
  const first = startOfMonth(date)
  const start = startOfWeek(first)
  return Array.from({ length: 42 }, (_, i) => addDays(start, i))
}

export function weekDays(date: Date): Date[] {
  const start = startOfWeek(date)
  return Array.from({ length: 7 }, (_, i) => addDays(start, i))
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

export function monthName(date: Date): string {
  return MONTHS[date.getMonth()]
}

export function weekdayName(date: Date): string {
  return WEEKDAYS[(date.getDay() + 6) % 7]
}

export function shortWeekday(date: Date): string {
  return weekdayName(date).slice(0, 3)
}

export function formatDate(date: Date, style: 'short' | 'medium' | 'long' = 'medium'): string {
  if (style === 'short') {
    return `${date.getDate()} ${MONTHS[date.getMonth()].slice(0, 3)}`
  }
  if (style === 'long') {
    return `${weekdayName(date)}, ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`
  }
  return `${date.getDate()} ${MONTHS[date.getMonth()].slice(0, 3)} ${date.getFullYear()}`
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function formatTimeRange(start: number, end: number): string {
  return `${formatTime(start)}–${formatTime(end)}`
}

/** Human phrasing for a due date, relative to today. */
export function dueLabel(dueDate: string): { text: string; tone: 'overdue' | 'today' | 'soon' | 'later' } {
  const target = parseIsoDate(dueDate)
  const diff = daysBetween(today(), target)
  if (diff < 0) return { text: `Overdue by ${Math.abs(diff)}d`, tone: 'overdue' }
  if (diff === 0) return { text: 'Due today', tone: 'today' }
  if (diff === 1) return { text: 'Due tomorrow', tone: 'soon' }
  if (diff <= 7) return { text: `Due in ${diff}d`, tone: 'soon' }
  return { text: `Due ${formatDate(target)}`, tone: 'later' }
}

/** Convert a local date and HH:MM into an epoch timestamp. */
export function localTimestamp(date: string, time?: string): number {
  const d = parseIsoDate(date)
  const [h, m] = (time ?? '00:00').split(':').map(Number)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h || 0, m || 0, 0, 0).getTime()
}

/** Split an epoch timestamp into the calendar fields the calendar renders. */
export function timestampParts(timestamp: number) {
  const date = new Date(timestamp)
  return {
    year: date.getFullYear(),
    month: date.getMonth(),
    day: date.getDate(),
    hours: date.getHours(),
    minutes: date.getMinutes(),
    date,
  }
}
