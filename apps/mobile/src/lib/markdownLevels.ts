/**
 * Chat Japanese at the reader's level, at render time, so the level and English only change messages on screen:
 * markdownAtLevel for the weave's leveled replies, and markdownEnglishOnly, as the desktop's, for older messages'
 * glosses under English only.
 */
import type { PhrasingContent } from "mdast";

import {
  attribute,
  markdownHtmlTags,
  parseMarkdownSource,
  type MarkdownNode,
} from "./markdownDocument";
import { escapeMarkdown, glossHrefTitle, hasGlossLinks } from "./markdownGlosses";

/** The level English only renders at: nothing is Japanese there, whatever an element's threshold. */
export const ENGLISH_ONLY_LEVEL = -3;

const SENTENCE_MARK = /^[\u3002\uFF1F\uFF01?!]+$/;
// Kana, kanji and CJK punctuation; other abbreviations, like CSP, are English already.
const JAPANESE =
  /[\u3000-\u303F\u3040-\u30FF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF66-\uFF9F]/;
// An English sentence's end in text: its stop, any closing quotes or brackets, then a space.
const ENGLISH_SENTENCE_END = /[.?!]["'’”)\]]*\s/g;

const PHRASING_PARENTS = new Set([
  "paragraph",
  "heading",
  "tableCell",
  "emphasis",
  "strong",
  "delete",
  "link",
]);

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly content: string;
}

const textOf = (node: MarkdownNode): string =>
  "value" in node && typeof node.value === "string"
    ? node.value
    : "children" in node
      ? node.children.map(textOf).join("")
      : "";

/** The gloss title of a gloss link, or "" for anything else. */
function glossTitle(node: MarkdownNode): string {
  return node.type === "link" ? (glossHrefTitle(node.url)?.trim() ?? "") : "";
}

const isSentenceMark = (node: MarkdownNode) =>
  glossTitle(node) !== "" && SENTENCE_MARK.test(textOf(node).trim());

/** A gloss's meaning, as in `reading · meaning / alternative`: after the reading, before the alternatives. */
function glossMeaning(title: string): string {
  const dot = title.indexOf(" · ");
  return (dot === -1 ? title : title.slice(dot + 3)).split(" / ")[0]!.trim();
}

/** Plain text, escaped so it reads as written wherever it lands, a line's start included. */
function plainText(text: string): string {
  return escapeMarkdown(text)
    .replace(/^([#+\-=])/, "\\$1")
    .replace(/^(\d+)([.)])/, "$1\\$2");
}

function lastEnglishSentenceEnd(text: string): number {
  let end = -1;
  for (const match of text.matchAll(ENGLISH_SENTENCE_END)) end = match.index + match[0].length;
  return end;
}

const startOf = (node: MarkdownNode) => node.position?.start.offset;
const endOf = (node: MarkdownNode) => node.position?.end.offset;

/** The edits for one block's or one span's own children: whole sentences first, then words. */
function translate(markdown: string, children: ReadonlyArray<PhrasingContent>, edits: Edit[]) {
  let floor = 0;
  children.forEach((child, index) => {
    if (child.type === "inlineCode" || child.type === "break") {
      floor = index + 1;
      return;
    }
    const markStart = startOf(child);
    const markEnd = endOf(child);
    if (markStart === undefined || markEnd === undefined || !isSentenceMark(child)) return;
    let start = startOf(children[floor]!) ?? markStart;
    for (let back = index - 1; back >= floor; back -= 1) {
      const node = children[back]!;
      const nodeStart = startOf(node);
      if (node.type !== "text" || nodeStart === undefined) continue;
      const end = lastEnglishSentenceEnd(markdown.slice(nodeStart, endOf(node)));
      if (end === -1) continue;
      start = nodeStart + end;
      break;
    }
    // Leading space stays; Japanese runs sentences together, so English needs one after the text before.
    start += /^\s*/.exec(markdown.slice(start, markEnd))![0].length;
    const before = start > (startOf(children[0]!) ?? start) ? markdown[start - 1] : undefined;
    const space = before !== undefined && !/\s/.test(before) ? " " : "";
    edits.push({ start, end: markEnd, content: space + plainText(glossTitle(child)) });
    floor = index + 1;
  });
  for (const child of children) {
    const start = startOf(child);
    const end = endOf(child);
    if (start === undefined || end === undefined || isSentenceMark(child)) continue;
    if (!JAPANESE.test(textOf(child))) continue;
    const meaning = glossMeaning(glossTitle(child));
    if (meaning !== "") edits.push({ start, end, content: plainText(meaning) });
  }
}

/** Spans inside a sentence get their own sentences and words first, as the desktop's tree walk does. */
function collect(markdown: string, node: MarkdownNode, edits: Edit[]) {
  if (!("children" in node)) return;
  for (const child of node.children) {
    if (glossTitle(child) === "") collect(markdown, child, edits);
  }
  if (PHRASING_PARENTS.has(node.type)) {
    translate(markdown, node.children as ReadonlyArray<PhrasingContent>, edits);
  }
}

/** Applies the outermost edits: an edit covers the edits inside it. */
function applyEdits(markdown: string, edits: Edit[]): string {
  edits.sort((a, b) => a.start - b.start || b.end - a.end);
  let result = "";
  let offset = 0;
  for (const edit of edits) {
    if (edit.start < offset) continue;
    result += markdown.slice(offset, edit.start) + edit.content;
    offset = edit.end;
  }
  return result + markdown.slice(offset);
}

/**
 * The message with its glossed Japanese swapped for English, on markdownWithHtml's gloss links: a glossed word shows its
 * meaning, and a sentence whose closing mark is glossed with its translation shows that, from the previous mark, an
 * English sentence's end, code, a line break or its block's start. Unchanged when it has no glosses.
 */
export function markdownEnglishOnly(markdown: string): string {
  if (!hasGlossLinks(markdown)) return markdown;
  const edits: Edit[] = [];
  collect(markdown, parseMarkdownSource(markdown), edits);
  // A sentence's edit covers the edits of the words and spans inside it.
  return applyEdits(markdown, edits);
}

// Their children are blocks, so each HTML node among them is a block of its own.
const FLOW_PARENTS = new Set(["root", "blockquote", "listItem", "footnoteDefinition"]);
const LEVELED_TAG = /^<(\/?)(abbr|span)[\s/>]/i;

interface HtmlTag {
  readonly start: number;
  readonly end: number;
  readonly html: string;
}

const shownAt = (threshold: number, level: number) =>
  level > ENGLISH_ONLY_LEVEL && level >= threshold;

/** An element's `data-on`, the lowest level it shows Japanese at; null without a whole number there. */
function threshold(tag: HtmlTag): number | null {
  const value = attribute(tag.html, "data-on")?.trim();
  return value !== undefined && /^-?\d+$/.test(value) ? Number(value) : null;
}

/**
 * The edits for one element with a threshold, from its opening tag through its closing one, or through `end`, the end
 * of what holds it, while its closing tag has not streamed in yet.
 */
function levelEdits(
  name: "abbr" | "span",
  opening: HtmlTag,
  closing: HtmlTag | undefined,
  end: number,
  level: number,
  edits: Edit[],
) {
  const on = threshold(opening);
  if (on === null) return;
  const whole = { start: opening.start, end: closing?.end ?? end };
  if (name === "abbr") {
    if (shownAt(on, level)) return;
    const english =
      attribute(opening.html, "data-en") ?? glossMeaning(attribute(opening.html, "title") ?? "");
    edits.push({ ...whole, content: plainText(english) });
    return;
  }
  const twin = attribute(opening.html, "data-jw");
  if (twin !== "ja" && twin !== "en") return;
  if ((twin === "ja") !== shownAt(on, level)) {
    edits.push({ ...whole, content: "" });
    return;
  }
  // The twin shown: its tags go, what they hold stays, Markdown and glosses included.
  edits.push({ start: opening.start, end: opening.end, content: "" });
  if (closing) edits.push({ start: closing.start, end: closing.end, content: "" });
}

/** Pairs one run's `<abbr>` and `<span>` tags, inner ones first, and edits those with a threshold. */
function pairLeveled(tags: ReadonlyArray<HtmlTag>, end: number, level: number, edits: Edit[]) {
  const open = { abbr: [] as HtmlTag[], span: [] as HtmlTag[] };
  for (const tag of tags) {
    const match = LEVELED_TAG.exec(tag.html);
    if (!match) continue;
    const name = match[2]!.toLowerCase() as "abbr" | "span";
    if (match[1] === "") {
      if (!tag.html.endsWith("/>")) open[name].push(tag);
      continue;
    }
    const opening = open[name].pop();
    if (opening) levelEdits(name, opening, tag, end, level, edits);
  }
  for (const name of ["abbr", "span"] as const) {
    for (const opening of open[name]) levelEdits(name, opening, undefined, end, level, edits);
  }
}

/** The tags of an HTML node, by their offsets in the message; code inside an HTML block keeps its tags. */
function htmlTags(markdown: string, node: MarkdownNode): HtmlTag[] {
  const start = startOf(node);
  const end = endOf(node);
  if (node.type !== "html" || start === undefined || end === undefined) return [];
  return markdownHtmlTags(markdown.slice(start, end)).map((match) => ({
    start: start + match.index,
    end: start + match.index + match[0].length,
    html: match[0],
  }));
}

// Inline HTML comes one tag per node, so a paragraph's or a span's tags pair across its children, as markdownWithHtml
// pairs anchors; code is never an HTML node, so code keeps whatever it shows.
function collectLeveled(markdown: string, node: MarkdownNode, level: number, edits: Edit[]) {
  if (!("children" in node)) return;
  const children: ReadonlyArray<MarkdownNode> = node.children;
  if (FLOW_PARENTS.has(node.type)) {
    for (const child of children) {
      const end = endOf(child);
      if (end !== undefined) pairLeveled(htmlTags(markdown, child), end, level, edits);
    }
  } else {
    const tags = children.flatMap((child) => htmlTags(markdown, child));
    const end = children.length > 0 ? endOf(children[children.length - 1]!) : undefined;
    if (tags.length > 0 && end !== undefined) pairLeveled(tags, end, level, edits);
  }
  for (const child of children) collectLeveled(markdown, child, level, edits);
}

/**
 * The message as written at `level` (-3 to 3, -3 while English only is on), before markdownWithHtml drops attributes:
 * a swapped word, `<abbr data-en="English" data-on="N">`, and a sentence's twins, `<span data-jw="ja" data-on="N">`
 * then `<span data-jw="en" data-on="N">`, show their Japanese at levels N and up and their English below; nothing is
 * Japanese at -3. Anything without a threshold stays as it is, so a message from before levels comes back unchanged.
 */
export function markdownAtLevel(markdown: string, level: number): string {
  if (!/\sdata-on\s*=/i.test(markdown)) return markdown;
  const edits: Edit[] = [];
  collectLeveled(markdown, parseMarkdownSource(markdown), level, edits);
  // A hidden twin's edit covers the words inside it.
  return applyEdits(markdown, edits);
}
