/**
 * Glossed words in chat: `<abbr title="reading · meaning">word</abbr>`. The native renderer has no tooltips, so
 * markdownWithHtml turns each into a link to `t3-gloss:<title>` (`t3-gloss:p<step>:<title>` with a tint, see
 * lib/markdownTint.ts), and a tap shows the title in parentheses after the word until the next tap on it.
 */
import { tintStep } from "@t3tools/shared/japaneseTint";

const GLOSS_SCHEME = "t3-gloss:";
export const GLOSS_LINK_PATTERN = `^${GLOSS_SCHEME}`;
const GLOSS_DESTINATION = /\]\(<t3-gloss:([^>/]*)>\)/g;
// encodeURIComponent writes a title's ":" as %3A, so a title never starts like this.
const TINT_PREFIX = /^p\d{1,2}:/;

export function glossHref(
  title: string | null | undefined,
  prediction?: string | null,
): string | undefined {
  const text = title?.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  const step = tintStep(prediction);
  return `${GLOSS_SCHEME}${step === null ? "" : `p${step}:`}${encodeURIComponent(text)}`;
}

export function isGlossHref(url: string): boolean {
  return url.startsWith(GLOSS_SCHEME);
}

/** The title of a gloss link as markdownWithHtml writes it (not yet numbered), or null for another link. */
export function glossHrefTitle(url: string): string | null {
  if (!isGlossHref(url)) return null;
  const encoded = url.slice(GLOSS_SCHEME.length).replace(TINT_PREFIX, "");
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

/** The occurrence a numbered gloss link points to, and its title. */
export function glossOf(url: string): { readonly index: number; readonly title: string } | null {
  const match = /^t3-gloss:(\d+)\/(.*)$/s.exec(url);
  if (!match) return null;
  let title = match[2]!.replace(TINT_PREFIX, "");
  try {
    title = decodeURIComponent(title);
  } catch {
    // The renderer already decoded it.
  }
  return { index: Number(match[1]), title };
}

export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]<>~|$&]/g, "\\$&");
}

/**
 * Numbers each gloss link in order, so a tap names one occurrence, and writes the title of each
 * expanded occurrence after its word. The opening "(" keeps the emphasis delimiters flanking text
 * on both sides, so a word written right after the gloss can't stop the emphasis from closing.
 */
export function markdownWithGlosses(markdown: string, expanded: ReadonlySet<number>): string {
  if (!hasGlossLinks(markdown)) return markdown;
  let index = 0;
  return markdown.replace(GLOSS_DESTINATION, (_, encoded: string) => {
    const n = index++;
    const link = `](<${GLOSS_SCHEME}${n}/${encoded}>)`;
    if (!expanded.has(n)) return link;
    let title = encoded.replace(TINT_PREFIX, "");
    try {
      title = decodeURIComponent(title);
    } catch {
      // Left encoded: still readable.
    }
    return `${link} (*${escapeMarkdown(title)}*)`;
  });
}

export function hasGlossLinks(markdown: string): boolean {
  return markdown.includes(`(<${GLOSS_SCHEME}`);
}

/**
 * The word of the numbered gloss link `index` (the numbering of markdownWithGlosses), as a reader sees it: the link's
 * label without Markdown escapes or emphasis. Null when there is no such link.
 */
export function glossWord(markdown: string, index: number): string | null {
  const match = [...markdown.matchAll(GLOSS_DESTINATION)][index];
  if (match === undefined) return null;
  // The label ends where the destination starts; escapeLinkLabel leaves no unescaped "[" inside it.
  const before = markdown.slice(0, match.index);
  let start = before.length - 1;
  while (start >= 0) {
    if (before[start] === "[") {
      let backslashes = 0;
      while (before[start - 1 - backslashes] === "\\") backslashes += 1;
      if (backslashes % 2 === 0) break;
    }
    start -= 1;
  }
  if (start < 0) return null;
  return before
    .slice(start + 1)
    .replace(/\\(.)/gs, "$1")
    .replace(/^[*_~`]+|[*_~`]+$/g, "")
    .trim();
}
