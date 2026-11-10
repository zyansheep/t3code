import { tintStep } from "./japaneseTint.ts";

type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const SENTENCE_MARK = /^[。？！?!]+$/u;
const LEADING_JAPANESE = /^[\p{scx=Han}\p{scx=Hira}\p{scx=Kana}]+/u;
// The thresholds the contract allows; any other data-on renders its element as written.
const THRESHOLD = /^(?:-2|-1|0|1|2|3)$/;
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

/** Whether an element was left open (see `rehypeMarkLevelTags`) in a way that breaks it, not as a streaming tail. */
const leftOpen = (node: HastNode, streaming: boolean) => {
  const open = node.properties?.dataUnclosed;
  return open === "block" || (open === "end" && !streaming);
};

/**
 * An HTML parser puts an English twin inside a Japanese one left open before it; the Japanese twin ends where the
 * English one starts instead, so they pair.
 */
function closeOpenJapaneseTwins(node: HastNode) {
  const children = node.children;
  if (!children || KEPT.has(node.tagName ?? "")) return;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    closeOpenJapaneseTwins(child);
    if (child.properties?.dataJw !== "ja" || child.properties.dataUnclosed === undefined) continue;
    const inner = child.children ?? [];
    const english = inner.findIndex((node) => node.properties?.dataJw === "en");
    if (english === -1) continue;
    children.splice(index + 1, 0, ...inner.splice(english));
  }
}

/**
 * The twins of a message: a Japanese span pairs with the English span right after it (only whitespace between) with
 * the same threshold. A finished message with nested twins or a twin left open is broken; while a reply streams, the
 * twins open at its end are its tail.
 */
function readTwins(tree: HastNode, streaming: boolean) {
  closeOpenJapaneseTwins(tree);
  const twins = twinsIn(tree);
  const byNode = new Map(twins.map((twin) => [twin.node, twin]));
  const partners = new Map<HastNode, HastNode>();
  for (const twin of twins) {
    if (!twin.ja) continue;
    const next = (twin.parent.children ?? []).slice(twin.index + 1).find((node) => !isBlank(node));
    const en = next && byNode.get(next);
    if (en && !en.ja && en.on === twin.on && en.node.properties?.dataApart === undefined) {
      partners.set(twin.node, en.node);
    }
  }
  const tails = new Set(
    twins.filter((twin) => streaming && twin.node.properties?.dataUnclosed === "end"),
  );
  const broken = twins.some(
    (twin) => leftOpen(twin.node, streaming) || (twin.nested && !tails.has(twin)),
  );
  return { byNode, twins, partners, tails, broken };
}

/**
 * Renders a tree at a word level (`level`, for swapped words) and a sentence level (`sentences`, for twins): a pair by
 * its threshold (its English twin in a broken message), a lone English twin always, a lone Japanese twin at its
 * threshold and below it as its last sentence mark's translation. In a broken message a hidden Japanese twin also hides
 * all up to the next English twin, so a split span leaves no Japanese behind.
 */
function renderAt(tree: HastNode, level: number, sentences: number, streaming: boolean) {
  const { byNode, twins, partners, tails, broken } = readTwins(tree, streaming);
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
    if (partners.has(node)) return !broken && sentences >= twin.on ? [withChildren(node)] : [];
    // A Japanese twin a block end closed lost part of itself, so it never shows.
    if (sentences >= twin.on && !leftOpen(node, streaming)) return [withChildren(node)];
    if (tails.has(twin)) return [];
    hiddenUntil = broken ? nextEnglish(twin) : null;
    // Hiding, its children keep only an English twin an unclosed span took in, and what follows it.
    const kept = hiddenUntil === null ? [] : (withChildren(node).children ?? []);
    // Its sentence shows once: as its English twin when one follows, else as its sentence mark's translation.
    const translation = hiddenUntil === null ? lastSentenceTranslation(node) : "";
    return [...(translation === "" ? [] : [{ type: "text", value: translation }]), ...kept];
  }
  function visit(node: HastNode): HastNode[] {
    const twin = byNode.get(node);
    if (twin?.ja) return japaneseTwin(twin);
    if (twin) {
      if (hiddenUntil === node) hiddenUntil = null;
      const japaneseShown = paired.has(node) && !broken && sentences >= twin.on;
      return japaneseShown ? [] : [withChildren(node)];
    }
    if (hiddenUntil !== null) {
      if (!node.children || KEPT.has(node.tagName ?? "")) return [];
      const kept = withChildren(node);
      return kept.children!.length > 0 ? [kept] : [];
    }
    const on = threshold(node);
    // A word still arriving at the end of a streaming reply is plain text until it closes.
    const arriving = streaming && node.properties?.dataUnclosed === "end";
    if (node.tagName === "abbr" && arriving && (on === null || level >= on)) {
      return withChildren(node).children ?? [];
    }
    if (node.tagName !== "abbr" || on === null) return [withChildren(node)];
    const english = node.properties?.dataEn;
    const meaning = (typeof english === "string" && english) || glossMeaning(glossTitle(node));
    if (leftOpen(node, streaming)) return leftOpenWord(withChildren(node), meaning);
    if (level < on && meaning !== "") return [{ type: "text", value: meaning }];
    return [withChildren(node)];
  }
  withChildren(tree);
}

/**
 * A word left open in a finished message, which the HTML parser closed at its block's end, so it holds the rest of the
 * block: it is its English at every level, standing for its own text (the Japanese it starts with), and the rest of
 * the block renders as usual.
 */
function leftOpenWord(word: HastNode, meaning: string): HastNode[] {
  const children = word.children ?? [];
  const first = children[0];
  if (first?.type === "text") first.value = (first.value ?? "").replace(LEADING_JAPANESE, "");
  return [...(meaning === "" ? [] : [{ type: "text", value: meaning }]), ...children];
}

// An abbr or span tag at the end of a streaming reply, at any point before its `>`; a quoted attribute value may
// hold a `>`. The phone's pattern, with an open single-quoted value allowed too.
const PARTIAL_TAG =
  /<\/?(?:(?:abbr|span)(?:\s(?:[^<>"']|"[^"]*"|'[^']*')*(?:"[^"]*|'[^']*)?)?|a(?:bb?)?|s(?:pa?)?)?$/iu;

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
  /** The word level, from -3 (no Japanese) to 3, which swapped words (`<abbr data-on>`) show by. */
  readonly level: number;
  /** The sentence level, which twins (`<span data-jw data-on>`) show by; `level` when absent. */
  readonly sentenceLevel?: number;
  /** English only, which also turns glosses in messages without levels into English. */
  readonly englishOnly: boolean;
  /** The source is a reply still streaming, whose last element may still be open. */
  readonly streaming?: boolean;
}

/**
 * Renders a chat message at its levels. A swapped word (`<abbr data-on>`) stays a gloss at or above its threshold on
 * the word level and is its English (`data-en`, else its gloss's meaning) below it; a sentence's twins
 * (`<span data-jw="ja|en" data-on>`) show by the sentence level, as `renderAt` says. Markup without a valid `data-on`
 * (-2 to 3) renders as written, except that in English only glossed words show their meaning and glossed sentences
 * their translation, as plain text. Each Japanese element left on screen with a valid `data-p` gets its tint
 * (`data-tint`, see `markTints`).
 */
export function rehypeChatLevel({
  level,
  sentenceLevel,
  englishOnly,
  streaming = false,
}: ChatLevel) {
  return (tree: HastNode) => {
    if (streaming) dropPartialTag(tree);
    renderAt(tree, level, sentenceLevel ?? level, streaming);
    if (englishOnly) toEnglish(tree);
    else markTints(tree);
  };
}

/**
 * Marks the tint (`data-tint`, its step) on what shows Japanese and has a valid `data-p`: a level word, a sentence's
 * Japanese twin, and a glossed word inside one. Run after `renderAt`, so whatever is left is on screen.
 */
function markTints(tree: HastNode) {
  const visit = (node: HastNode, inTwin: boolean) => {
    if (KEPT.has(node.tagName ?? "")) return;
    const leveled = threshold(node) !== null;
    const twin = leveled && node.tagName === "span" && node.properties?.dataJw === "ja";
    const word = node.tagName === "abbr" && (leveled || inTwin) && JAPANESE.test(textOf(node));
    const step = twin || word ? tintStep(node.properties?.dataP) : null;
    if (step !== null) node.properties = { ...node.properties, dataTint: String(step) };
    for (const child of node.children ?? []) visit(child, inTwin || twin);
  };
  visit(tree, false);
}

const LEVEL_TAG = /<(\/?)(abbr|span)\b([^>]*?)(\/?)>/giu;
const LEVEL_ATTRIBUTE = /\sdata-(?:on|jw)\s*=/iu;
const COMMENT = /^\s*<!--[\s\S]*-->\s*$/u;
const CLOSE_SPAN = /^\s*<\/span\s*>\s*$/iu;
const OPEN_SPAN = /^\s*<span\b/iu;
const RAW_BLOCKS = new Set(["p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "td", "th", "dt", "dd"]);

interface OpenTag {
  readonly raw: HastNode;
  /** Where its `>` is in the raw HTML. */
  readonly end: number;
  readonly name: string;
  readonly leveled: boolean;
}

/**
 * Before the HTML parser: marks each abbr, and each span with levels, that its block leaves open (`data-unclosed`: "end" in the
 * message's last block, else "block"), drops a self-closing abbr or level span, which would take in the rest of its
 * block, and marks a span right after a closing span and a comment `data-apart`, so twins a comment separates don't pair.
 */
export function rehypeMarkLevelTags() {
  return (tree: HastNode) => {
    const blocks = new Map<HastNode, HastNode[]>();
    let lastBlock: HastNode | null = null;
    const visit = (node: HastNode, block: HastNode | null) => {
      if (KEPT.has(node.tagName ?? "")) return;
      const children = node.children ?? [];
      children.forEach((child, index) => {
        if (child.type === "raw" && COMMENT.test(child.value ?? "")) {
          const previous = children.slice(0, index).findLast((sibling) => !isBlank(sibling));
          const next = children.slice(index + 1).find((sibling) => !isBlank(sibling));
          if (
            previous?.type === "raw" &&
            CLOSE_SPAN.test(previous.value ?? "") &&
            next?.type === "raw"
          ) {
            next.value = (next.value ?? "").replace(OPEN_SPAN, '$& data-apart=""');
          }
        }
        const own = RAW_BLOCKS.has(child.tagName ?? "") ? child : block;
        if (child.type === "raw") {
          const key = own ?? child;
          blocks.set(key, [...(blocks.get(key) ?? []), child]);
        }
        if ((child.type === "raw" || child.type === "text") && !isBlank(child)) {
          lastBlock = own ?? child;
        }
        visit(child, own);
      });
    };
    visit(tree, null);
    for (const [block, raws] of blocks) {
      if (!raws.some((raw) => raw.value?.includes("<"))) continue;
      markBlock(raws, block === lastBlock ? "end" : "block");
    }
  };
}

function markBlock(raws: HastNode[], unclosed: "end" | "block") {
  const stack: OpenTag[] = [];
  const edits = new Map<HastNode, Array<{ start: number; end: number; text: string }>>();
  const edit = (raw: HastNode, start: number, end: number, text: string) =>
    edits.set(raw, [...(edits.get(raw) ?? []), { start, end, text }]);
  const markOpen = (tag: OpenTag, how: "end" | "block") => {
    if (tag.leveled || tag.name === "abbr")
      edit(tag.raw, tag.end, tag.end, ` data-unclosed="${how}"`);
  };
  for (const raw of raws) {
    for (const match of (raw.value ?? "").matchAll(LEVEL_TAG)) {
      const [whole, closing, tagName, attributes, selfClosing] = match;
      const name = tagName!.toLowerCase();
      const leveled = LEVEL_ATTRIBUTE.test(attributes ?? "");
      if (selfClosing) {
        if (name === "abbr" || leveled) edit(raw, match.index, match.index + whole.length, "");
      } else if (!closing) {
        stack.push({ raw, end: match.index + whole.length - 1, name, leveled });
      } else {
        const open = stack.findLastIndex((tag) => tag.name === name);
        // The HTML parser closes what is still open inside the matching tag with it.
        if (open !== -1) for (const tag of stack.splice(open).slice(1)) markOpen(tag, "block");
      }
    }
  }
  for (const tag of stack) markOpen(tag, unclosed);
  for (const [raw, changes] of edits) {
    let value = raw.value ?? "";
    for (const change of [...changes].sort((a, b) => b.start - a.start)) {
      value = value.slice(0, change.start) + change.text + value.slice(change.end);
    }
    raw.value = value;
  }
}
