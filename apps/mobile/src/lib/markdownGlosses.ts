/**
 * Glossed words in chat: `<abbr title="reading · meaning">word</abbr>`. The native renderer has no
 * tooltips, so markdownWithHtml turns each one into a link to `t3-gloss:<title>`, and a tap shows
 * the title in parentheses after the word until the next tap on it. The parentheses can end in a
 * wedge, a `t3-review:` link that opens the flashcards.
 */

const GLOSS_SCHEME = "t3-gloss:";
export const GLOSS_LINK_PATTERN = `^${GLOSS_SCHEME}`;
const REVIEW_SCHEME = "t3-review:";
export const REVIEW_LINK_PATTERN = `^${REVIEW_SCHEME}`;
/** Stemless and in every font; drawn as a padded pill so it is easy to hit. */
export const REVIEW_WEDGE = "›";
const GLOSS_DESTINATION = /\]\(<t3-gloss:([^>/]*)>\)/g;

export function glossHref(title: string | null | undefined): string | undefined {
  const text = title?.replace(/\s+/g, " ").trim();
  return text ? `${GLOSS_SCHEME}${encodeURIComponent(text)}` : undefined;
}

export function isGlossHref(url: string): boolean {
  return url.startsWith(GLOSS_SCHEME);
}

export function isReviewHref(url: string): boolean {
  return url.startsWith(REVIEW_SCHEME);
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
 * With `reviewWedge`, an expanded title ends in the wedge, inside the closing ")".
 */
export function markdownWithGlosses(
  markdown: string,
  expanded: ReadonlySet<number>,
  options: { readonly reviewWedge?: boolean } = {},
): string {
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
    const wedge = options.reviewWedge ? ` [${REVIEW_WEDGE}](<${REVIEW_SCHEME}${n}>)` : "";
    return `${link} (*${escapeMarkdown(title)}*${wedge})`;
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
