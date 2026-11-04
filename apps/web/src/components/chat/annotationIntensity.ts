const LEVEL_NAMES = new Map([
  [-3, "off"],
  [-2, "much lighter"],
  [-1, "lighter"],
  [0, "normal"],
  [1, "heavier"],
  [2, "much heavier"],
  [3, "full"],
]);

/** The chat Japanese level's name, from off (-3) through normal (0) to full (+3). */
export function annotationLevelName(level: number): string {
  return LEVEL_NAMES.get(level) ?? "normal";
}

/** A time left, to the minute: "42 min", "1 hour", "2 h 5 min". */
export function durationLabel(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (rest === 0) return hours === 1 ? "1 hour" : `${hours} hours`;
  return `${hours} h ${rest} min`;
}
