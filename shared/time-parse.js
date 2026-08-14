/**
 * Parse HHMM or HHMMz into a UTC ms timestamp on or after `now`.
 * Accepts "1945", "1945z", "19:45", "19 45Z". Rolls forward one day when
 * the time is more than ~1 min in the past.
 */
export function parseZuluHhmm(s, now) {
  const digits = String(s || "").trim().replace(/\D/g, "");
  if (digits.length !== 3 && digits.length !== 4) return null;
  const padded = digits.length === 3 ? "0" + digits : digits;
  const h = +padded.slice(0, 2);
  const min = +padded.slice(2, 4);
  if (h > 23 || min > 59) return null;
  const d = new Date(now);
  d.setUTCHours(h, min, 0, 0);
  let ms = d.getTime();
  if (ms < now - 60000) ms += 86400000;
  return ms;
}
