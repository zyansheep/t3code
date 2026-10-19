import type { AnnotationIntensity, KeybindingCommand } from "@t3tools/contracts";

/** The step a chat Japanese shortcut sends to the collector: `1` heavier, `-1` lighter, null for other commands. */
export function annotationIntensityStep(command: KeybindingCommand | null): 1 | -1 | null {
  if (command === "annotations.heavier") return 1;
  if (command === "annotations.lighter") return -1;
  return null;
}

/** The toast title for the collector's level, such as "Chat Japanese: heavier (+1) until 9:40 PM". */
export function annotationIntensityTitle(intensity: AnnotationIntensity, locale?: string): string {
  const { level, until } = intensity;
  if (level === 0) return "Chat Japanese: normal";
  const change = level > 0 ? `heavier (+${level})` : `lighter (${level})`;
  if (until <= 0) return `Chat Japanese: ${change}`;
  const time = new Date(until).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  return `Chat Japanese: ${change} until ${time}`;
}
