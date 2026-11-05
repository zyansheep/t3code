/**
 * English only at render time, as the desktop's markdownEnglishOnly: a glossed word shows its meaning, and a sentence
 * whose closing mark is glossed with its translation shows that, from the previous mark, an English sentence's end,
 * code, a line break or its block's start. Works on markdownWithHtml's gloss links (markdownGlosses.ts).
 */
import type { PhrasingContent } from "mdast";

import { parseMarkdownSource, type MarkdownNode } from "./markdownDocument";
import { escapeMarkdown, glossHrefTitle, hasGlossLinks } from "./markdownGlosses";

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

/** The message with its glossed Japanese swapped for English; unchanged when it has no glosses. */
export function markdownEnglishOnly(markdown: string): string {
  if (!hasGlossLinks(markdown)) return markdown;
  const edits: Edit[] = [];
  collect(markdown, parseMarkdownSource(markdown), edits);
  // A sentence's edit covers the edits of the words and spans inside it.
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
