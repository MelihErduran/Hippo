// Time helpers. Everything is epoch milliseconds in storage; local time only
// appears at the edges (parsing what the user or model wrote, and display).

export type Clock = () => number;
export const systemClock: Clock = () => Date.now();

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
export const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

const pad = (n: number) => String(n).padStart(2, '0');

/** "HH:MM" -> minutes since midnight. Throws on bad input. */
export function parseHm(hm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) throw new Error(`Expected HH:MM, got "${hm}"`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) throw new Error(`Bad time "${hm}"`);
  return h * 60 + min;
}

export function fmtHm(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** Minutes since local midnight. */
export function localMinutes(ms: number): number {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

/** Local calendar date as YYYY-MM-DD. */
export function localDateKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** ms for a given local date at minutes past midnight. */
export function atLocalMinutes(dayMs: number, minutes: number): number {
  const d = new Date(startOfLocalDay(dayMs));
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return d.getTime();
}

export function weekdayKey(ms: number): WeekdayKey {
  return WEEKDAY_KEYS[new Date(ms).getDay()]!;
}

/**
 * Parse a local date or datetime the model or user wrote.
 *   "2026-11-06T23:59"  -> that local time
 *   "2026-11-06"        -> 23:59 local that day (deadline semantics)
 * Offsets ("Z", "+02:00") are honored if present. Returns null if unparseable.
 */
export function parseLocalDateTime(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = s.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (dateOnly) {
    const d = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 23, 59, 0, 0);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (local) {
    const d = new Date(
      Number(local[1]), Number(local[2]) - 1, Number(local[3]),
      Number(local[4]), Number(local[5]), Number(local[6] ?? 0), 0,
    );
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(t)) {
    const ms = Date.parse(t);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/** "2026-11-06T23:59" in local time, the format models are asked to emit. */
export function toLocalIso(ms: number): string {
  const d = new Date(ms);
  return `${localDateKey(ms)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtClock(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  const m = d.getMinutes();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "Fri 11:59 PM", or "Nov 20 11:59 PM" when more than 6 days away. */
export function fmtWhen(ms: number, now: number): string {
  const d = new Date(ms);
  const days = Math.abs(startOfLocalDay(ms) - startOfLocalDay(now)) / DAY;
  if (days < 1) return `today ${fmtClock(ms)}`;
  if (days > 6) {
    const mon = d.toLocaleString('en-US', { month: 'short' });
    return `${mon} ${d.getDate()} ${fmtClock(ms)}`;
  }
  return `${WEEKDAYS[d.getDay()]} ${fmtClock(ms)}`;
}

/** "in 3h", "in 2d", "overdue 1d", "now". */
export function fmtRelative(target: number, now: number): string {
  const diff = target - now;
  const abs = Math.abs(diff);
  let unit: string;
  if (abs < 2 * MINUTE) return 'now';
  if (abs < HOUR) unit = `${Math.round(abs / MINUTE)}m`;
  else if (abs < 2 * DAY) unit = `${Math.round(abs / HOUR)}h`;
  else unit = `${Math.round(abs / DAY)}d`;
  return diff >= 0 ? `in ${unit}` : `overdue ${unit}`;
}

export function fmtNowForPrompt(now: number): string {
  const d = new Date(now);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const offStr = `UTC${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  return `${WEEKDAYS_LONG[d.getDay()]} ${toLocalIso(now)} (${tz}, ${offStr})`;
}

/** A two-week calendar so models never do date arithmetic themselves. */
export function calendarForPrompt(now: number, days = 14): string {
  const lines: string[] = [];
  for (let i = 0; i < days; i++) {
    const ms = startOfLocalDay(now) + i * DAY + 12 * HOUR; // noon avoids DST edges
    const label = i === 0 ? ' (today)' : i === 1 ? ' (tomorrow)' : '';
    lines.push(`${WEEKDAYS_LONG[new Date(ms).getDay()]} = ${localDateKey(ms)}${label}`);
  }
  return lines.join('\n');
}

/**
 * Snooze targets: "30m", "2h", "3d", "tomorrow" (9:00 tomorrow), "tonight" (19:00),
 * or anything parseLocalDateTime accepts.
 */
export function parseSnooze(input: string, now: number): number | null {
  const s = input.trim().toLowerCase();
  const rel = /^(\d+(?:\.\d+)?)\s*(m|min|mins|h|hr|hrs|d|day|days|w|wk|week|weeks)$/.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const u = rel[2]!;
    const mult = u.startsWith('m') ? MINUTE : u.startsWith('h') ? HOUR : u.startsWith('d') ? DAY : 7 * DAY;
    return now + n * mult;
  }
  if (s === 'tomorrow') return atLocalMinutes(now + DAY, 9 * 60);
  if (s === 'tonight') return atLocalMinutes(now, 19 * 60);
  return parseLocalDateTime(input);
}

/** "Thu Nov 5, 11:59 PM": absolute, for files that are not regenerated every minute. */
export function fmtAbsolute(ms: number): string {
  const d = new Date(ms);
  const mon = d.toLocaleString('en-US', { month: 'short' });
  return `${WEEKDAYS[d.getDay()]} ${mon} ${d.getDate()}, ${fmtClock(ms)}`;
}
