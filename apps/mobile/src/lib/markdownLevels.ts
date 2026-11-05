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
const ELEMENT_TAG = /^<(\/?)(abbr|span)[\s/>]/i;
// The thresholds the contract has: a level from -2 up, written exactly so.
const THRESHOLD = /^(-2|-1|0|1|2|3)$/;
const LEVEL_MARKUP = /\sdata-on=/i;
// What may stand between a Japanese twin and its English one: whitespace within a block.
const BETWEEN_TWINS = /^\s*$/;
const BLANK_LINE = /\n[ \t]*\r?\n/;
// An `<abbr>` or `<span>` tag at the end of a message still streaming in, at any point before its `>`; a quoted
// attribute value may hold a `>`.
const PARTIAL_TAG =
  /<\/?(?:(?:abbr|span)(?:\s(?:[^<>"']|"[^"]*"|'[^']*')*(?:"[^"]*|'[^']*')?)?|a(?:bb?)?|s(?:pa?)?)?$/i;

interface HtmlTag {
  readonly start: number;
  readonly end: number;
  readonly html: string;
  /** Where the block or span holding the tag ends. */
  readonly blockEnd: number;
}

/** An `<abbr>` or `<span>`: its tags, and where it ends (its closing tag, or what the rules below make of none). */
interface Element {
  readonly name: "abbr" | "span";
  readonly opening: HtmlTag;
  closing: HtmlTag | undefined;
  end: number;
  /** Left open in a finished message, or crossing a block: markup the weave did not write. */
  broken: boolean;
}

/**
 * A message still streaming in, without an `<abbr>` or `<span>` tag at its end that has not finished arriving, which
 * would show as text, attributes and all, until its `>` came.
 */
export function withoutPartialTag(markdown: string): string {
  return markdown.replace(PARTIAL_TAG, "");
}

/** Whether a message has the weave's level markup, so it renders, and its reports go, by level. */
export function hasLevelMarkup(markdown: string): boolean {
  return LEVEL_MARKUP.test(markdown);
}

/** An element's `data-on`, the lowest level it shows Japanese at; null for anything but a threshold of the contract. */
function threshold(element: Element): number | null {
  const value = attribute(element.opening.html, "data-on");
  return value !== null && THRESHOLD.test(value) ? Number(value) : null;
}

/** The tags of an HTML node, by their offsets in the message; code inside an HTML block keeps its tags. */
function htmlTags(markdown: string, node: MarkdownNode, blockEnd: number): HtmlTag[] {
  const start = startOf(node);
  const end = endOf(node);
  if (node.type !== "html" || start === undefined || end === undefined) return [];
  return markdownHtmlTags(markdown.slice(start, end)).map((match) => ({
    start: start + match.index,
    end: start + match.index + match[0].length,
    html: match[0],
    blockEnd,
  }));
}

// Code is never an HTML node, so code keeps whatever markup it shows.
function collectTags(markdown: string, node: MarkdownNode, tags: HtmlTag[]) {
  if (!("children" in node)) return;
  const children: ReadonlyArray<MarkdownNode> = node.children;
  const last = children.length > 0 ? endOf(children[children.length - 1]!) : undefined;
  for (const child of children) {
    const end = FLOW_PARENTS.has(node.type) ? endOf(child) : last;
    if (end !== undefined) tags.push(...htmlTags(markdown, child, end));
    collectTags(markdown, child, tags);
  }
}

/**
 * Pairs `<abbr>` and `<span>` tags in the order they come, inner ones first and across blocks. One left open ends at the
 * end of its block, as HTML closes it, or at the end of the message while `streaming` in there.
 */
function pairElements(tags: ReadonlyArray<HtmlTag>, messageEnd: number, streaming: boolean) {
  const open = { abbr: [] as Element[], span: [] as Element[] };
  const elements: Element[] = [];
  for (const tag of [...tags].sort((a, b) => a.start - b.start)) {
    const match = ELEMENT_TAG.exec(tag.html);
    if (!match) continue;
    const name = match[2]!.toLowerCase() as "abbr" | "span";
    if (match[1] === "/") {
      const element = open[name].pop();
      if (!element) continue;
      element.closing = tag;
      element.end = tag.end;
      element.broken = tag.start > element.opening.blockEnd;
      continue;
    }
    if (tag.html.endsWith("/>")) continue;
    const element: Element = {
      name,
      opening: tag,
      closing: undefined,
      end: tag.blockEnd,
      broken: false,
    };
    open[name].push(element);
    elements.push(element);
  }
  for (const element of [...open.abbr, ...open.span]) {
    element.broken = !(streaming && element.opening.blockEnd >= messageEnd);
  }
  return elements;
}

const twinOf = (element: Element) => {
  const twin = element.name === "span" ? attribute(element.opening.html, "data-jw") : null;
  return twin === "ja" || twin === "en" ? twin : null;
};

const inside = (inner: Element, outer: Element) =>
  inner !== outer && inner.opening.start >= outer.opening.end && inner.end <= outer.end;

/** The translation a Japanese twin's last glossed sentence mark carries, or "" without one. */
function lastTranslation(markdown: string, twin: Element, abbrs: ReadonlyArray<Element>): string {
  let translation = "";
  for (const abbr of abbrs) {
    if (!abbr.closing || !inside(abbr, twin)) continue;
    const text = markdown.slice(abbr.opening.end, abbr.closing.start).trim();
    const title = attribute(abbr.opening.html, "title")?.trim() ?? "";
    if (title !== "" && SENTENCE_MARK.test(text)) translation = title;
  }
  return translation;
}

/**
 * The message as written at `level` (-3 to 3, -3 while English only is on), before markdownWithHtml drops attributes:
 * a swapped word, `<abbr data-en data-on="N">`, and a sentence's twins, `<span data-jw="ja|en" data-on="N">`, show
 * their Japanese at levels N and up and their English below; anything without a threshold stays as written.
 */
export function markdownAtLevel(source: string, level: number, streaming = false): string {
  const markdown = streaming ? withoutPartialTag(source) : source;
  if (!hasLevelMarkup(markdown)) return markdown;
  const tags: HtmlTag[] = [];
  collectTags(markdown, parseMarkdownSource(markdown), tags);
  const elements = pairElements(tags, markdown.trimEnd().length, streaming);
  const abbrs = elements.filter((element) => element.name === "abbr");
  const twins = elements.filter(
    (element) => twinOf(element) !== null && threshold(element) !== null,
  );
  // A Japanese twin left open ends where an English twin starts in its block, as the weave writes them.
  twins.forEach((twin, index) => {
    const next = twins[index + 1];
    if (twin.closing || !twin.broken || twinOf(twin) !== "ja" || !next) return;
    if (twinOf(next) === "en" && next.opening.start < twin.end) twin.end = next.opening.start;
  });
  // A Japanese twin goes with the English one right after it, whitespace apart within a block, at the same threshold.
  const partner = new Map<Element, Element>();
  for (const twin of twins) {
    const next = twins.find((other) => other.opening.start >= twin.end);
    if (twinOf(twin) !== "ja" || !next || twinOf(next) !== "en") continue;
    if (threshold(next) !== threshold(twin) || partner.has(next)) continue;
    const between = markdown.slice(twin.end, next.opening.start);
    if (BETWEEN_TWINS.test(between) && !BLANK_LINE.test(between)) {
      partner.set(twin, next).set(next, twin);
    }
  }
  // Markup the weave did not write (a twin left open, across a block or inside another) turns every pair English.
  const broken = twins.some((twin) => twin.broken || twins.some((outer) => inside(twin, outer)));
  const edits: Edit[] = [];
  const show = (element: Element) => {
    edits.push({ start: element.opening.start, end: element.opening.end, content: "" });
    if (element.closing)
      edits.push({ start: element.closing.start, end: element.closing.end, content: "" });
  };
  const replace = (element: Element, content: string) =>
    edits.push({ start: element.opening.start, end: element.end, content });

  for (const twin of twins) {
    const on = threshold(twin)!;
    const japanese = twinOf(twin) === "ja";
    if (partner.has(twin)) {
      if ((!broken && level >= on) === japanese) show(twin);
      else replace(twin, "");
    } else if (!japanese || level >= on) {
      // An English twin alone always shows; a Japanese one alone shows at its threshold, and below it its translation.
      show(twin);
    } else replace(twin, plainText(lastTranslation(markdown, twin, abbrs)));
  }
  for (const abbr of abbrs) {
    const on = threshold(abbr);
    // A word left open in a finished message stays as written: where it ends is anyone's guess.
    if (on === null || level >= on || abbr.broken) continue;
    const english =
      attribute(abbr.opening.html, "data-en") ||
      glossMeaning(attribute(abbr.opening.html, "title") ?? "");
    replace(abbr, plainText(english));
  }
  // A hidden twin's edit covers the words inside it.
  return applyEdits(markdown, edits);
}
