/**
 * Recurrence handling for calendar events.
 *
 * Supports the subset of RFC 5545 that a personal planner realistically
 * needs: DAILY, WEEKLY, MONTHLY and YEARLY frequencies with INTERVAL,
 * COUNT, UNTIL, BYDAY and BYMONTHDAY.
 */

export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

export interface RRule {
  freq: Frequency
  interval: number
  count?: number
  until?: number
  /** 0 = Monday … 6 = Sunday. */
  byDay?: number[]
  byMonthDay?: number[]
}

export interface RecurringEvent {
  id: string
  startUtc: number
  endUtc: number
  rrule?: string
  exdates?: string[]
}

export interface Occurrence {
  start: number
  end: number
  /** True for the first instance of the series. */
  original: boolean
}

const DAY_NAMES: Record<string, number> = {
  SU: 6,
  MO: 0,
  TU: 1,
  WE: 2,
  TH: 3,
  FR: 4,
  SA: 5,
}

/** Parse an RRULE string into its parts. */
export function parseRRule(value: string): RRule | null {
  const text = value.trim().replace(/^RRULE:/i, '')
  if (!text) return null
  const parts: Record<string, string> = {}
  for (const chunk of text.split(';')) {
    const [key, raw] = chunk.split('=')
    if (!key || raw === undefined) continue
    parts[key.trim().toUpperCase()] = raw.trim()
  }

  const freq = parts.FREQ?.toUpperCase() as Frequency | undefined
  if (!freq || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null

  const rule: RRule = {
    freq,
    interval: Math.max(1, Number.parseInt(parts.INTERVAL ?? '1', 10) || 1),
  }
  if (parts.COUNT) rule.count = Math.max(1, Number.parseInt(parts.COUNT, 10) || 1)
  if (parts.UNTIL) {
    const until = parseUntil(parts.UNTIL)
    if (until !== undefined) rule.until = until
  }
  if (parts.BYDAY) {
    const days = parts.BYDAY.split(',')
      .map((day) => DAY_NAMES[day.trim().toUpperCase()])
      .filter((day): day is number => day !== undefined)
    if (days.length > 0) rule.byDay = days
  }
  if (parts.BYMONTHDAY) {
    const monthDays = parts.BYMONTHDAY.split(',')
      .map((day) => Number.parseInt(day.trim(), 10))
      .filter((day) => !Number.isNaN(day))
    if (monthDays.length > 0) rule.byMonthDay = monthDays
  }
  return rule
}

function parseUntil(value: string): number | undefined {
  const text = value.trim()
  // Date only: 20261026
  if (/^\d{8}$/.test(text)) {
    const year = Number(text.slice(0, 4))
    const month = Number(text.slice(4, 6))
    const day = Number(text.slice(6, 8))
    return new Date(year, month - 1, day, 23, 59, 59, 999).getTime()
  }
  // Date and time: 20261026T090000Z
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(text)
  if (match) {
    return Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    )
  }
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** Serialise a rule back to an RRULE string. */
export function formatRRule(rule: RRule): string {
  const parts = [`FREQ=${rule.freq}`, `INTERVAL=${rule.interval}`]
  if (rule.count) parts.push(`COUNT=${rule.count}`)
  if (rule.until) {
    const date = new Date(rule.until)
    const stamp = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(
      date.getUTCDate(),
    ).padStart(2, '0')}T${String(date.getUTCHours()).padStart(2, '0')}${String(
      date.getUTCMinutes(),
    ).padStart(2, '0')}${String(date.getUTCSeconds()).padStart(2, '0')}Z`
    parts.push(`UNTIL=${stamp}`)
  }
  if (rule.byDay?.length) {
    const names = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
    parts.push(`BYDAY=${rule.byDay.map((d) => names[d]).join(',')}`)
  }
  if (rule.byMonthDay?.length) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(',')}`)
  return parts.join(';')
}

function startOfWeekLocal(timestamp: number): number {
  const date = new Date(timestamp)
  const day = date.getDay()
  const diff = day === 0 ? -6 : 1 - day
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + diff).getTime()
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

/** Generate every occurrence of a series, starting from the series origin. */
function* iterate(rule: RRule, origin: number): Generator<number> {
  const start = new Date(origin)
  const duration = rule.interval
  let produced = 0
  const maxIterations = 3000

  if (rule.freq === 'DAILY') {
    let cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate())
    for (let i = 0; i < maxIterations; i++) {
      const time = new Date(
        cursor.getFullYear(),
        cursor.getMonth(),
        cursor.getDate(),
        start.getHours(),
        start.getMinutes(),
        start.getSeconds(),
        start.getMilliseconds(),
      ).getTime()
      if (rule.until !== undefined && time > rule.until) return
      produced += 1
      yield time
      if (rule.count !== undefined && produced >= rule.count) return
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + duration)
    }
    return
  }

  if (rule.freq === 'WEEKLY') {
    const days = rule.byDay?.length ? rule.byDay : [((start.getDay() + 6) % 7)]
    const weekStart = startOfWeekLocal(origin)
    for (let w = 0; w < maxIterations; w++) {
      const base = new Date(weekStart)
      base.setDate(base.getDate() + w * 7 * duration)
      for (const day of [...days].sort((a, b) => a - b)) {
        const time = new Date(
          base.getFullYear(),
          base.getMonth(),
          base.getDate() + day,
          start.getHours(),
          start.getMinutes(),
          start.getSeconds(),
          start.getMilliseconds(),
        ).getTime()
        if (time < origin) continue
        if (rule.until !== undefined && time > rule.until) return
        produced += 1
        yield time
        if (rule.count !== undefined && produced >= rule.count) return
      }
    }
    return
  }

  if (rule.freq === 'MONTHLY') {
    let year = start.getFullYear()
    let month = start.getMonth()
    for (let i = 0; i < maxIterations; i++) {
      const monthDays = rule.byMonthDay?.length ? rule.byMonthDay : [start.getDate()]
      for (const day of monthDays) {
        const clamped = Math.min(day, daysInMonth(year, month))
        const time = new Date(
          year,
          month,
          clamped,
          start.getHours(),
          start.getMinutes(),
          start.getSeconds(),
          start.getMilliseconds(),
        ).getTime()
        if (time < origin) continue
        if (rule.until !== undefined && time > rule.until) return
        produced += 1
        yield time
        if (rule.count !== undefined && produced >= rule.count) return
      }
      month += duration
      year += Math.floor(month / 12)
      month = ((month % 12) + 12) % 12
    }
    return
  }

  // YEARLY
  let year = start.getFullYear()
  for (let i = 0; i < maxIterations; i++) {
    const month = start.getMonth()
    const day = Math.min(start.getDate(), daysInMonth(year, month))
    const time = new Date(
      year,
      month,
      day,
      start.getHours(),
      start.getMinutes(),
      start.getSeconds(),
      start.getMilliseconds(),
    ).getTime()
    if (rule.until !== undefined && time > rule.until) return
    produced += 1
    yield time
    if (rule.count !== undefined && produced >= rule.count) return
    year += duration
  }
}

/** Every occurrence of the series, ignoring the requested window. */
export function allOccurrences(event: RecurringEvent): number[] {
  const rule = event.rrule ? parseRRule(event.rrule) : null
  if (!rule) return [event.startUtc]
  const excluded = new Set((event.exdates ?? []).map((value) => Number(value)))
  const out: number[] = []
  for (const time of iterate(rule, event.startUtc)) {
    if (excluded.has(time)) continue
    out.push(time)
  }
  return out
}

/** Occurrences that fall inside a time window. */
export function occurrencesIn(
  event: RecurringEvent,
  windowStart: number,
  windowEnd: number,
): Occurrence[] {
  const rule = event.rrule ? parseRRule(event.rrule) : null
  if (!rule) {
    if (event.startUtc >= windowStart && event.startUtc < windowEnd) {
      return [{ start: event.startUtc, end: event.endUtc, original: true }]
    }
    return []
  }

  const excluded = new Set((event.exdates ?? []).map((value) => Number(value)))
  const duration = Math.max(0, event.endUtc - event.startUtc)
  const out: Occurrence[] = []
  let index = 0
  for (const time of iterate(rule, event.startUtc)) {
    if (time >= windowStart && time < windowEnd && !excluded.has(time)) {
      out.push({ start: time, end: time + duration, original: index === 0 })
    }
    index += 1
    if (time > windowEnd && out.length > 0) break
  }
  return out
}

/** Count the occurrences that start before `boundary`. */
export function countBefore(event: RecurringEvent, boundary: number): number {
  let count = 0
  for (const time of allOccurrences(event)) {
    if (time < boundary) count += 1
    else break
  }
  return count
}

/**
 * Split a series at an occurrence: the original keeps the earlier
 * occurrences and a new series starts at the split point.
 */
export function splitSeries(
  event: RecurringEvent,
  splitStart: number,
): { before: RecurringEvent; after: RecurringEvent } | null {
  const rule = event.rrule ? parseRRule(event.rrule) : null
  if (!rule) return null

  const occurrences = allOccurrences(event)
  const splitIndex = occurrences.findIndex((time) => time >= splitStart)
  if (splitIndex <= 0) return null

  const keptCount = splitIndex
  const beforeRule: RRule = { ...rule }
  if (rule.count) {
    beforeRule.count = keptCount
    delete beforeRule.until
  } else {
    beforeRule.until = splitStart - 1
  }

  const afterRule: RRule = { ...rule }
  delete afterRule.count
  delete afterRule.until

  const duration = Math.max(0, event.endUtc - event.startUtc)
  return {
    before: {
      ...event,
      rrule: formatRRule(beforeRule),
      exdates: event.exdates ?? [],
    },
    after: {
      ...event,
      startUtc: splitStart,
      endUtc: splitStart + duration,
      rrule: formatRRule(afterRule),
      exdates: [],
    },
  }
}
