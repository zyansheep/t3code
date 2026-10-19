import type { AnnotationIntensity } from "@t3tools/contracts";

/** The toast title for the collector's level, such as "Chat Japanese: heavier (+1) until 9:40 PM". */
export function annotationIntensityTitle(intensity: AnnotationIntensity, locale?: string): string {
  const { level, until } = intensity;
  if (level === 0) return "Chat Japanese: normal";
  const change = level > 0 ? `heavier (+${level})` : `lighter (${level})`;
  if (until <= 0) return `Chat Japanese: ${change}`;
  const time = new Date(until).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  return `Chat Japanese: ${change} until ${time}`;
}
