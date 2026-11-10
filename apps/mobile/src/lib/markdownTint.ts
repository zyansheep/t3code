/**
 * The difficulty tint on the phone (packages/shared/src/japaneseTint.ts): a faint background from green through yellow
 * to red on each glossed Japanese word shown with a predicted chance. The native renderer styles text by link URL only,
 * so a tinted word is a gloss link carrying its step (lib/markdownGlosses.ts). Sentences get no tint here, unlike on
 * the desktop: as links, Android's long press would no longer select their text and a tap on them would be swallowed.
 */
import { TINT_STEPS, tintHue } from "@t3tools/shared/japaneseTint";
import type { LinkVariantStyle } from "react-native-enriched-markdown";

/** The link styles that tint glossed words, drawn as a gloss link is, for a light or a dark theme. */
export function tintLinkVariants(input: {
  readonly dark: boolean;
  readonly textColor: string | undefined;
}): Record<string, LinkVariantStyle> {
  const variants: Record<string, LinkVariantStyle> = {};
  for (let step = 0; step <= TINT_STEPS; step += 1) {
    variants[`^t3-gloss:\\d+/p${step}:`] = {
      color: input.textColor,
      underline: true,
      backgroundColor: input.dark
        ? `hsla(${tintHue(step)}, 80%, 55%, 0.24)`
        : `hsla(${tintHue(step)}, 90%, 45%, 0.2)`,
    };
  }
  return variants;
}
