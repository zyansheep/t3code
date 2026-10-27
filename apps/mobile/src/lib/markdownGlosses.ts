/**
 * Glossed words in chat: `<abbr title="reading · meaning">word</abbr>`. The native renderer has no
 * tooltips, so markdownWithHtml turns each one into a link to `t3-gloss:<title>`, and a tap shows
 * the title in parentheses after the word until the next tap on it.
 */

const GLOSS_SCHEME = "t3-gloss:";
export const GLOSS_LINK_PATTERN = `^${GLOSS_SCHEME}`;
const GLOSS_DESTINATION = /\]\(<t3-gloss:([^>/]*)>\)/g;

export function glossHref(title: string | null | undefined): string | undefined {
  const text = title?.replace(/\s+/g, " ").trim();
  return text ? `${GLOSS_SCHEME}${encodeURIComponent(text)}` : undefined;
}

export function isGlossHref(url: string): boolean {
  return url.startsWith(GLOSS_SCHEME);
}

/** The occurrence a numbered gloss link points to, and its title. */
export function glossOf(url: string): { readonly index: number; readonly title: string } | null {
  const match = /^t3-gloss:(\d+)\/(.*)$/s.exec(url);
  if (!match) return null;
  let title = match[2]!;
  try {
    title = decodeURIComponent(title);
  } catch {
    // The renderer already decoded it.
  }
  return { index: Number(match[1]), title };
}

function escapeMarkdown(text: string): string {
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
    let title = encoded;
    try {
      title = decodeURIComponent(encoded);
    } catch {
      // Left encoded: still readable.
    }
    return `${link} (*${escapeMarkdown(title)}*)`;
  });
}

export function hasGlossLinks(markdown: string): boolean {
  return markdown.includes(`(<${GLOSS_SCHEME}`);
}
