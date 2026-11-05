type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const SENTENCE_MARK = /^[。？！?!]+$/u;
// The thresholds the contract allows; any other data-on renders its element as written.
const THRESHOLD = /^(?:-2|-1|0|1|2|3)$/;
const TWIN_OPEN = /<span\b[^>]*\sdata-jw=[^>]*>/giu;
const SPAN_CLOSE = /<\/span\s*>/iu;
const BLANK_LINE = /\n[ \t]*\n/u;
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

/** The lowest level an element shows at (`data-on`), or `null` for markup without levels. */
function threshold(node: HastNode): number | null {
  const value = node.properties?.dataOn;
  return typeof value === "string" && THRESHOLD.test(value) ? Number(value) : null;
}

interface Twin {
  readonly node: HastNode;
  readonly ja: boolean;
  readonly on: number;
  readonly parent: HastNode;
  readonly index: number;
  /** Inside another twin, as an unclosed span leaves the next one. */
  readonly nested: boolean;
}

function twinsIn(parent: HastNode, out: Twin[] = [], nested = false): Twin[] {
  if (KEPT.has(parent.tagName ?? "")) return out;
  (parent.children ?? []).forEach((node, index) => {
    const twin =
      node.type === "element" && node.tagName === "span" ? node.properties?.dataJw : null;
    const on = threshold(node);
    const isTwin = on !== null && (twin === "ja" || twin === "en");
    if (isTwin) out.push({ node, ja: twin === "ja", on, parent, index, nested });
    twinsIn(node, out, nested || isTwin);
  });
  return out;
}

const isBlank = (node: HastNode) => node.type === "text" && (node.value ?? "").trim() === "";

/** Whether a pair sits as written: the English twin right after the Japanese one, neither inside another twin. */
const adjacent = (ja: Twin, en: Twin) =>
  !ja.nested &&
  !en.nested &&
  ja.parent === en.parent &&
  (ja.parent.children ?? []).slice(ja.index + 1, en.index).every(isBlank);

/** A twin span in the source that holds a blank line or never closes, which markdown splits apart. */
function splitTwinInSource(source: string): boolean {
  for (const open of source.matchAll(TWIN_OPEN)) {
    const rest = source.slice(open.index + open[0].length);
    const end = rest.search(SPAN_CLOSE);
    if (end === -1 || BLANK_LINE.test(rest.slice(0, end))) return true;
  }
  return false;
}

/**
 * Pairs each Japanese twin with the English twin after it in document order. A twin without its partner, a pair out
 * of place, or a twin the source shows split apart breaks the message: its parts may have landed outside their spans.
 */
function pairTwins(tree: HastNode, source: string) {
  const twins = twinsIn(tree);
  const partners = new Map<HastNode, HastNode>();
  let broken = false;
  for (let index = 0; index < twins.length; index += 1) {
    const twin = twins[index]!;
    const next = twins[index + 1];
    if (twin.ja && next && !next.ja && next.on === twin.on) {
      partners.set(twin.node, next.node);
      if (!adjacent(twin, next)) broken = true;
      index += 1;
    } else broken = true;
  }
  return {
    twins: new Map(twins.map((twin) => [twin.node, twin])),
    partners,
    broken: broken || (twins.length > 0 && splitTwinInSource(source)),
  };
}

/**
 * Renders a tree at `level`. A Japanese twin below its threshold hides everything up to its English twin in document
 * order, so a twin split apart by markdown leaves nothing of its Japanese behind; a broken message shows every
 * sentence's English twin.
 */
function renderAt(tree: HastNode, level: number, source: string) {
  const { twins, partners, broken } = pairTwins(tree, source);
  let hiddenUntil: HastNode | null = null;
  const japanese = (on: number) => !broken && level >= on;
  const withChildren = (node: HastNode): HastNode => {
    if (!node.children || KEPT.has(node.tagName ?? "")) return node;
    const children: HastNode[] = [];
    // A word's English joins the text around it, so English only finds sentence ends in one text node.
    for (const child of node.children.flatMap(visit)) {
      const previous = children.at(-1);
      if (child.type === "text" && previous?.type === "text") {
        children[children.length - 1] = {
          type: "text",
          value: (previous.value ?? "") + (child.value ?? ""),
        };
      } else children.push(child);
    }
    node.children = children;
    return node;
  };
  function visit(node: HastNode): HastNode[] {
    const twin = twins.get(node);
    if (twin?.ja) {
      if (japanese(twin.on)) return [withChildren(node)];
      hiddenUntil = partners.get(node) ?? null;
      // An unclosed Japanese twin holds its English one; only that survives.
      return hiddenUntil === null ? [] : (withChildren(node).children ?? []);
    }
    if (twin) {
      if (hiddenUntil === node) hiddenUntil = null;
      return japanese(twin.on) ? [] : [withChildren(node)];
    }
    if (hiddenUntil !== null) {
      if (!node.children || KEPT.has(node.tagName ?? "")) return [];
      const kept = withChildren(node);
      return kept.children!.length > 0 ? [kept] : [];
    }
    const on = threshold(node);
    if (node.tagName === "abbr" && on !== null && level < on) {
      const english = node.properties?.dataEn;
      const meaning = typeof english === "string" ? english : glossMeaning(glossTitle(node));
      if (meaning !== "") return [{ type: "text", value: meaning }];
    }
    return [withChildren(node)];
  }
  withChildren(tree);
}

export interface ChatLevel {
  /** The chat level, from -3 (no Japanese) to 3. */
  readonly level: number;
  /** English only, which also turns glosses in messages without levels into English. */
  readonly englishOnly: boolean;
}

/**
 * Renders a chat message at a level. A swapped word (`<abbr data-on>`) stays a gloss at or above its threshold and is
 * its English (`data-en`, else its gloss's meaning) below it; a sentence's twins (`<span data-jw="ja|en" data-on>`)
 * show the Japanese at or above it and the English below it. Markup without `data-on` renders as written, except that
 * in English only glossed words show their meaning and glossed sentences their translation, as plain text.
 */
export function rehypeChatLevel({ level, englishOnly }: ChatLevel) {
  return (tree: HastNode, file?: { value?: unknown }) => {
    renderAt(tree, level, String(file?.value ?? ""));
    if (englishOnly) toEnglish(tree);
  };
}
