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

/**
 * How the twin spans in the source end: whether one holds a blank line or never closes (markdown splits it apart), and
 * whether the last one is still open at the end, which while a reply streams is its tail.
 */
function twinSpansInSource(source: string) {
  const opens = [...source.matchAll(TWIN_OPEN)];
  let split = false;
  let openAtEnd = 0;
  for (const open of opens) {
    const rest = source.slice(open.index + open[0].length);
    const end = rest.search(SPAN_CLOSE);
    if (end === -1) openAtEnd += 1;
    else if (BLANK_LINE.test(rest.slice(0, end))) split = true;
  }
  return { split, openAtEnd };
}

/** The translation of the Japanese twin's last sentence mark (`<abbr title="translation">。</abbr>`). */
function lastSentenceTranslation(node: HastNode): string {
  let translation = "";
  const visit = (child: HastNode) => {
    if (isSentenceMark(child)) translation = glossTitle(child);
    else child.children?.forEach(visit);
  };
  node.children?.forEach(visit);
  return translation;
}

/**
 * The twins of a message: a Japanese span pairs with the English span right after it (only whitespace between) with
 * the same threshold. A finished message with nested twins or a twin split apart or left open is broken; while a reply
 * streams, the last twin may still be open, as its tail.
 */
function readTwins(tree: HastNode, source: string, streaming: boolean) {
  const twins = twinsIn(tree);
  const byNode = new Map(twins.map((twin) => [twin.node, twin]));
  const partners = new Map<HastNode, HastNode>();
  for (const twin of twins) {
    if (!twin.ja) continue;
    const next = (twin.parent.children ?? []).slice(twin.index + 1).find((node) => !isBlank(node));
    const en = next && byNode.get(next);
    if (en && !en.ja && en.on === twin.on) partners.set(twin.node, en.node);
  }
  const { split, openAtEnd } = twins.length > 0 ? twinSpansInSource(source) : NO_SPANS;
  const tail = streaming && openAtEnd === 1 ? (twins.at(-1)?.node ?? null) : null;
  const broken =
    split || openAtEnd > (tail ? 1 : 0) || twins.some((twin) => twin.nested && twin.node !== tail);
  return { byNode, twins, partners, tail, broken };
}

const NO_SPANS = { split: false, openAtEnd: 0 };

/**
 * Renders a tree at `level`: a pair by its threshold (its English twin in a broken message), a lone English twin always,
 * a lone Japanese twin at its threshold and below it as its last sentence mark's translation. In a broken message a
 * hidden Japanese twin also hides all up to the next English twin, so a split span leaves no Japanese behind.
 */
function renderAt(tree: HastNode, level: number, source: string, streaming: boolean) {
  const { byNode, twins, partners, tail, broken } = readTwins(tree, source, streaming);
  const paired = new Set(partners.values());
  const nextEnglish = (twin: Twin) =>
    twins.slice(twins.indexOf(twin) + 1).find((next) => !next.ja && next.on === twin.on)?.node ??
    null;
  let hiddenUntil: HastNode | null = null;
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
  function japaneseTwin(twin: Twin): HastNode[] {
    const node = twin.node;
    if (partners.has(node)) return !broken && level >= twin.on ? [withChildren(node)] : [];
    if (level >= twin.on) return [withChildren(node)];
    if (node === tail) return [];
    const translation = lastSentenceTranslation(node);
    hiddenUntil = broken ? nextEnglish(twin) : null;
    // Hiding, its children keep only an English twin an unclosed span took in, and what follows it.
    const kept = hiddenUntil === null ? [] : (withChildren(node).children ?? []);
    return [...(translation === "" ? [] : [{ type: "text", value: translation }]), ...kept];
  }
  function visit(node: HastNode): HastNode[] {
    const twin = byNode.get(node);
    if (twin?.ja) return japaneseTwin(twin);
    if (twin) {
      if (hiddenUntil === node) hiddenUntil = null;
      const japaneseShown = paired.has(node) && !broken && level >= twin.on;
      return japaneseShown ? [] : [withChildren(node)];
    }
    if (hiddenUntil !== null) {
      if (!node.children || KEPT.has(node.tagName ?? "")) return [];
      const kept = withChildren(node);
      return kept.children!.length > 0 ? [kept] : [];
    }
    const on = threshold(node);
    if (node.tagName === "abbr" && on !== null && level < on) {
      const english = node.properties?.dataEn;
      const meaning = (typeof english === "string" && english) || glossMeaning(glossTitle(node));
      if (meaning !== "") return [{ type: "text", value: meaning }];
    }
    return [withChildren(node)];
  }
  withChildren(tree);
}

// A tag still being written at the end of a streaming reply, which would show as text until it closes.
const PARTIAL_TAG = /<(?:\/?[A-Za-z!][^<>]*)?$/u;

/** The element holding the last text outside code that isn't only whitespace. */
function lastProseParent(node: HastNode): HastNode | null {
  if (KEPT.has(node.tagName ?? "")) return null;
  for (const child of [...(node.children ?? [])].reverse()) {
    if (child.type === "text") {
      if (isBlank(child)) continue;
      return node;
    }
    const parent = lastProseParent(child);
    if (parent) return parent;
    if (!isBlank(child)) return null;
  }
  return null;
}

/** Cuts a tag still being written from the end of the reply's last text, which markdown may have split into parts. */
function dropPartialTag(tree: HastNode) {
  const children = lastProseParent(tree)?.children;
  if (!children) return;
  let last = children.length - 1;
  while (last >= 0 && isBlank(children[last]!)) last -= 1;
  let first = last;
  while (first > 0 && children[first - 1]!.type === "text") first -= 1;
  const run = children.slice(first, last + 1);
  let cut = PARTIAL_TAG.exec(run.map((node) => node.value ?? "").join(""))?.[0].length ?? 0;
  for (const node of run.reverse()) {
    const value = node.value ?? "";
    node.value = value.slice(0, Math.max(0, value.length - cut));
    cut = Math.max(0, cut - value.length);
  }
}

export interface ChatLevel {
  /** The chat level, from -3 (no Japanese) to 3. */
  readonly level: number;
  /** English only, which also turns glosses in messages without levels into English. */
  readonly englishOnly: boolean;
  /** The source is a reply still streaming, whose last element may still be open. */
  readonly streaming?: boolean;
}

/**
 * Renders a chat message at a level. A swapped word (`<abbr data-on>`) stays a gloss at or above its threshold and is
 * its English (`data-en`, else its gloss's meaning) below it; a sentence's twins (`<span data-jw="ja|en" data-on>`)
 * show as `renderAt` says. Markup without a valid `data-on` (-2 to 3) renders as written, except that in English only
 * glossed words show their meaning and glossed sentences their translation, as plain text.
 */
export function rehypeChatLevel({ level, englishOnly, streaming = false }: ChatLevel) {
  return (tree: HastNode, file?: { value?: unknown }) => {
    if (streaming) dropPartialTag(tree);
    renderAt(tree, level, String(file?.value ?? ""), streaming);
    if (englishOnly) toEnglish(tree);
  };
}
