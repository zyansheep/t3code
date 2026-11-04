type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const SENTENCE_MARK = /^[。？！?!]+$/u;
// Other abbreviations, like CSP, are English already.
const JAPANESE = /[\p{scx=Han}\p{scx=Hira}\p{scx=Kana}]/u;
// An English sentence's end in text: its stop, any closing quotes or brackets, then a space.
const ENGLISH_SENTENCE_END = /[.?!]["'’”)\]]*\s/gu;
// Code is kept as written, and a sentence never runs back across code or a line break.
const KEPT = new Set(["code", "pre"]);
const SENTENCE_STOPS = new Set(["code", "pre", "br"]);

const textOf = (node: HastNode): string =>
  node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(textOf).join("");

function glossTitle(node: HastNode): string {
  if (node.type !== "element" || node.tagName !== "abbr") return "";
  const title = node.properties?.dataMarkdownTitle;
  return typeof title === "string" ? title.trim() : "";
}

const isSentenceMark = (node: HastNode) =>
  glossTitle(node) !== "" && SENTENCE_MARK.test(textOf(node).trim());

/** A gloss's meaning, as in `reading · meaning / alternative`: after the reading, before the alternatives. */
function glossMeaning(title: string): string {
  const dot = title.indexOf(" · ");
  return (dot === -1 ? title : title.slice(dot + 3)).split(" / ")[0]!.trim();
}

const english = (kind: "word" | "sentence", value: string): HastNode => ({
  type: "element",
  tagName: "span",
  properties: { dataEnglish: kind, lang: "en" },
  children: [{ type: "text", value }],
});

function lastEnglishSentenceEnd(text: string): number {
  let end = -1;
  for (const match of text.matchAll(ENGLISH_SENTENCE_END)) end = match.index + match[0].length;
  return end;
}

/**
 * Replaces each sentence that ends in a sentence mark gloss (`<abbr title="translation">。</abbr>`) with its
 * translation. It runs back to the previous mark, an English sentence's end in text, code, a line break, or the start.
 */
function translateSentences(children: HastNode[]): HastNode[] {
  const out: HastNode[] = [];
  let floor = 0;
  for (const child of children) {
    if (!isSentenceMark(child)) {
      out.push(child);
      if (child.type === "element" && SENTENCE_STOPS.has(child.tagName ?? "")) floor = out.length;
      continue;
    }
    let start = floor;
    for (let index = out.length - 1; index >= floor; index -= 1) {
      const node = out[index]!;
      const end = node.type === "text" ? lastEnglishSentenceEnd(node.value ?? "") : -1;
      if (end === -1) continue;
      const value = node.value ?? "";
      out.splice(index, 1, { type: "text", value: value.slice(0, end) });
      if (end < value.length) out.splice(index + 1, 0, { type: "text", value: value.slice(end) });
      start = index + 1;
      break;
    }
    const first = out[start];
    const leading = first?.type === "text" ? (/^\s+/u.exec(first.value ?? "")?.[0] ?? "") : "";
    out.splice(start);
    // Japanese runs sentences together; English needs a space after the one before.
    const before = out.length > 0 ? textOf(out.at(-1)!) : "";
    const space = leading || (before !== "" && !/\s$/u.test(before) ? " " : "");
    if (space) out.push({ type: "text", value: space });
    out.push(english("sentence", glossTitle(child)));
    floor = out.length;
  }
  return out;
}

function toEnglish(node: HastNode): void {
  if (!node.children || KEPT.has(node.tagName ?? "")) return;
  for (const child of node.children) {
    if (glossTitle(child) === "") toEnglish(child);
  }
  node.children = translateSentences(node.children).map((child) => {
    const meaning = JAPANESE.test(textOf(child)) ? glossMeaning(glossTitle(child)) : "";
    return meaning === "" ? child : english("word", meaning);
  });
}

/** English only: glossed words show their meaning and glossed sentences their translation, as plain text. */
export function rehypeEnglishOnly() {
  return toEnglish;
}
