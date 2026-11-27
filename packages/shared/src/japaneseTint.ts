/**
 * Chat Japanese's difficulty tint: the weave writes `data-p`, the predicted chance the reader looks a word up (or opens
 * a sentence's translation), on level words and sentences, and clients tint what they show from green (p = 0) through
 * yellow to red (p >= 0.5). No script-property patterns here: the phone's Hermes loads this module too.
 */

/** A chance from 0 to 1 with at most two decimals, as the weave writes it. */
export const PREDICTION = /^(?:0(?:\.\d{1,2})?|1(?:\.0{1,2})?)$/;

/** The number of steps past green; each is 0.05 of chance. */
export const TINT_STEPS = 10;

/** The tint step of a `data-p`, 0 (green) to 10 (red), or null for anything but a chance the weave writes. */
export function tintStep(value: unknown): number | null {
  if (typeof value !== "string" || !PREDICTION.test(value)) return null;
  return Math.round((Math.min(Number(value), 0.5) / 0.5) * TINT_STEPS);
}

/** The hue of a tint step: 120 (green) at 0 through 60 (yellow) to 0 (red) at 10. */
export const tintHue = (step: number) => 120 - (120 * step) / TINT_STEPS;
