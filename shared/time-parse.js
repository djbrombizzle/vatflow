/**
 * Parse HHMM or HHMMz into a UTC ms timestamp on or after `now`.
 * Rolls forward one day when the time is more than ~1 min in the past.
 */
export function parseZuluHhmm(s, now) {
  const m = String(s || "").trim().replace(/z$/i, "").match(/^(\d{2})(\d{2})$/);
  if (!m) return null;
  const h = +m[1], min = +m[2];
  if (h > 23 || min > 59) return null;
  const d = new Date(now);
  d.setUTCHours(h, min, 0, 0);
  let ms = d.getTime();
  if (ms < now - 60000) ms += 86400000;
  return ms;
}
