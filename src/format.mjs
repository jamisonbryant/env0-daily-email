// Formatting helpers: escaping, durations, dates, and display-only string tidying.
// Everything here is pure and has no I/O.

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes a value for use in HTML text or a double-quoted attribute. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/** Shortens a string for display, keeping the full value available elsewhere (e.g. a title attribute). */
export function truncate(value, max) {
  const s = String(value ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Human duration with at most two units: "<1m", "45m", "3h 12m", "2d 4h". */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < MINUTE) return '<1m';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    const m = Math.floor((ms % HOUR) / MINUTE);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  return h ? `${d}d ${h}h` : `${d}d`;
}

/** Relative age with one unit: "<1m ago", "45m ago", "3h ago", "12d ago". */
export function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < MINUTE) return '<1m ago';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`;
  return `${Math.floor(ms / DAY)}d ago`;
}

/** Throws a RangeError if the time zone is not a valid IANA zone. */
export function assertTimeZone(timeZone) {
  new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
}

function toDate(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Oct 9, 2026" in the given zone, or null if the value is not a date. */
export function formatDate(value, timeZone) {
  const d = toDate(value);
  if (!d) return null;
  return new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'short', day: 'numeric' }).format(d);
}

/** "Monday, October 12, 2026" in the given zone. */
export function formatLongDate(value, timeZone) {
  const d = toDate(value);
  if (!d) return null;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(d);
}

/** "Oct 12, 2026, 9:05 AM EDT" in the given zone. */
export function formatDateTime(value, timeZone) {
  const d = toDate(value);
  if (!d) return null;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(d);
}
