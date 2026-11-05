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
// The thresholds the contract has: a level from -2 up, written exactly so.
const THRESHOLD = /^(-2|-1|0|1|2|3)$/;
const LEVEL_MARKUP = /\sdata-on=/i;

interface HtmlTag {
  readonly start: number;
  readonly end: number;
  readonly html: string;
  /** Where the block or span holding the tag ends. */
  readonly blockEnd: number;
}

/** An element with a threshold: its opening tag, its closing one when there is one, and `data-on`. */
interface Leveled {
  readonly name: "abbr" | "span";
  readonly opening: HtmlTag;
  closing: HtmlTag | undefined;
  readonly on: number;
}

/** Whether a message has the weave's level markup, so it renders, and its reports go, by level. */
export function hasLevelMarkup(markdown: string): boolean {
  return LEVEL_MARKUP.test(markdown);
}

/** An element's `data-on`, the lowest level it shows Japanese at; null for anything but a threshold of the contract. */
function threshold(tag: HtmlTag): number | null {
  const value = attribute(tag.html, "data-on");
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
 * Pairs `<abbr>` and `<span>` tags in the order they come, inner ones first and across blocks, so a twin with a blank
 * line in it is still one; returns those with a threshold.
 */
function leveledElements(tags: ReadonlyArray<HtmlTag>): Leveled[] {
  const open = { abbr: [] as Leveled[], span: [] as Leveled[] };
  const elements: Leveled[] = [];
  for (const tag of [...tags].sort((a, b) => a.start - b.start)) {
    const match = LEVELED_TAG.exec(tag.html);
    if (!match) continue;
    const name = match[2]!.toLowerCase() as "abbr" | "span";
    if (match[1] === "/") {
      const opening = open[name].pop();
      if (opening) opening.closing = tag;
      continue;
    }
    if (tag.html.endsWith("/>")) continue;
    const element: Leveled = { name, opening: tag, closing: undefined, on: threshold(tag) ?? NaN };
    open[name].push(element);
    if (!Number.isNaN(element.on)) elements.push(element);
  }
  return elements;
}

const twinOf = (element: Leveled) =>
  element.name === "span" ? attribute(element.opening.html, "data-jw") : null;

/**
 * The message as written at `level` (-3 to 3, -3 while English only is on), before markdownWithHtml drops attributes:
 * a swapped word, `<abbr data-en data-on="N">`, and a sentence's twins, `<span data-jw="ja|en" data-on="N">`, show
 * their Japanese at levels N and up and their English below; anything without a threshold stays as written.
 */
export function markdownAtLevel(markdown: string, level: number, streaming = false): string {
  if (!hasLevelMarkup(markdown)) return markdown;
  const tags: HtmlTag[] = [];
  collectTags(markdown, parseMarkdownSource(markdown), tags);
  const elements = leveledElements(tags);
  const messageEnd = markdown.trimEnd().length;
  const edits: Edit[] = [];
  const twins = elements.filter((element) => {
    const twin = twinOf(element);
    return twin === "ja" || twin === "en";
  });
  // Where each element ends: its closing tag, or the end while `streaming` in. Broken markup never cuts what follows:
  // a Japanese twin left open ends where its English twin starts, or stays as written; an English one left open shows
  // and its Japanese twin goes.
  const endOfElement = (element: Leveled): number | null => {
    if (element.closing) return element.closing.end;
    if (streaming && element.opening.blockEnd >= messageEnd) return element.opening.blockEnd;
    if (twinOf(element) !== "ja") return null;
    const next = twins[twins.indexOf(element) + 1];
    return next && twinOf(next) === "en" ? next.opening.start : null;
  };
  const english = new Set<Leveled>();
  twins.forEach((twin, index) => {
    if (twinOf(twin) === "en" && endOfElement(twin) === null) {
      english.add(twin);
      const previous = twins[index - 1];
      if (previous && twinOf(previous) === "ja") english.add(previous);
    }
  });

  for (const element of elements) {
    const { opening, closing } = element;
    const end = endOfElement(element);
    if (element.name === "abbr") {
      if (level >= element.on || end === null) continue;
      const englishText =
        attribute(opening.html, "data-en") ?? glossMeaning(attribute(opening.html, "title") ?? "");
      edits.push({ start: opening.start, end, content: plainText(englishText) });
      continue;
    }
    const twin = twinOf(element);
    if (twin !== "ja" && twin !== "en") continue;
    if (end === null) {
      // An English twin left open shows; a Japanese one with no English stays as written.
      if (twin === "en") edits.push({ start: opening.start, end: opening.end, content: "" });
      continue;
    }
    const visible =
      twin === "ja" ? level >= element.on && !english.has(element) : level < element.on;
    if (!visible) {
      edits.push({ start: opening.start, end, content: "" });
      continue;
    }
    // The twin shown: its tags go, what they hold stays, Markdown and glosses included.
    edits.push({ start: opening.start, end: opening.end, content: "" });
    if (closing) edits.push({ start: closing.start, end: closing.end, content: "" });
  }
  // A hidden twin's edit covers the words inside it.
  return applyEdits(markdown, edits);
}
