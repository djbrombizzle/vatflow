/** Overnight wrap: allow next-day HHMM only when that landing is within this horizon. */
const OVERNIGHT_HORIZON_MS = 6 * 3600000;

/**
 * Parse HHMM or HHMMz into a UTC ms timestamp at or after `now`.
 * Accepts "1945", "1945z", "19:45", "19 45Z".
 *
 * Past times are rejected — they are not rolled to tomorrow, except when the
 * next occurrence is within a short overnight horizon (e.g. enter 0015 at 2350).
 *
 * @returns {{ ms: number|null, reason: null|"format"|"past" }}
 */
export function parseZuluHhmmDetail(s, now) {
  const digits = String(s || "").trim().replace(/\D/g, "");
  if (digits.length !== 3 && digits.length !== 4) return { ms: null, reason: "format" };
  const padded = digits.length === 3 ? "0" + digits : digits;
  const h = +padded.slice(0, 2);
  const min = +padded.slice(2, 4);
  if (h > 23 || min > 59) return { ms: null, reason: "format" };
  const d = new Date(now);
  d.setUTCHours(h, min, 0, 0);
  const ms = d.getTime();
  if (ms >= now - 60000) return { ms, reason: null }; // now or future (1-min grace)
  // Today’s clock time is in the past — only allow next-day when that landing
  // is soon (overnight wrap), otherwise reject as a past time.
  const next = ms + 86400000;
  if (next - now <= OVERNIGHT_HORIZON_MS) return { ms: next, reason: null };
  return { ms: null, reason: "past" };
}

/** @returns {number|null} */
export function parseZuluHhmm(s, now) {
  return parseZuluHhmmDetail(s, now).ms;
}
