/**
 * The difficulty tint on the phone (packages/shared/src/japaneseTint.ts): a faint background from green through
 * yellow to red on each Japanese word and sentence shown with a predicted chance. The native renderer styles links by
 * URL only, so a tinted word is a gloss link carrying its step (lib/markdownGlosses.ts), and a tinted sentence's text
 * between its words is a link to `t3-tint:<step>`, which a tap leaves alone.
 */
import { TINT_STEPS, tintHue } from "@t3tools/shared/japaneseTint";
import type { LinkVariantStyle } from "react-native-enriched-markdown";

const TINT_SCHEME = "t3-tint:";

/** The link a tinted sentence's text points to. */
export const sentenceTintHref = (step: number) => `${TINT_SCHEME}${step}`;

export function isTintHref(url: string): boolean {
  return url.startsWith(TINT_SCHEME);
}

/**
 * The link styles that tint glossed words (as a gloss link draws them) and sentences (as plain text), for a light or a
 * dark theme. A sentence is fainter than its words.
 */
export function tintLinkVariants(input: {
  readonly dark: boolean;
  readonly textColor: string | undefined;
}): Record<string, LinkVariantStyle> {
  const background = (step: number, alpha: number) =>
    input.dark
      ? `hsla(${tintHue(step)}, 80%, 55%, ${alpha + 0.04})`
      : `hsla(${tintHue(step)}, 90%, 45%, ${alpha})`;
  const variants: Record<string, LinkVariantStyle> = {};
  for (let step = 0; step <= TINT_STEPS; step += 1) {
    variants[`^t3-gloss:\\d+/p${step}:`] = {
      color: input.textColor,
      underline: true,
      backgroundColor: background(step, 0.2),
    };
    variants[`^t3-tint:${step}$`] = {
      color: input.textColor,
      underline: false,
      backgroundColor: background(step, 0.08),
    };
  }
  return variants;
}
