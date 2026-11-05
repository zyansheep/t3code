const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Anki's units: a month is 30 days and a year 365.
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

// A whole number prints without ".0", as Anki prints "1mo" and "2y".
const tenths = (value: number) => String(Math.round(value * 10) / 10);

/**
 * The label Anki prints above an answer button for a card coming back in `seconds`: `<1m`, `10m`, `1h`, `3d`, `1.2mo`,
 * `2.1y`. Whole minutes, hours and days, tenths of months and years.
 */
export function reviewIntervalLabel(seconds: number): string {
  const span = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  if (span < MINUTE) return "<1m";
  if (span < HOUR) {
    const minutes = Math.round(span / MINUTE);
    return minutes < 60 ? `${minutes}m` : "1h";
  }
  if (span < DAY) {
    const hours = Math.round(span / HOUR);
    return hours < 24 ? `${hours}h` : "1d";
  }
  if (span < MONTH) {
    const days = Math.round(span / DAY);
    return days < 30 ? `${days}d` : "1mo";
  }
  if (span < YEAR) return `${tenths(span / MONTH)}mo`;
  return `${tenths(span / YEAR)}y`;
}
