import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import corpus from "./markdownLevel.corpus.json" with { type: "json" };
import { rehypeChatLevel } from "./markdownLevel.ts";
import { CHAT_MARKDOWN_REHYPE_PLUGINS, CHAT_MARKDOWN_REMARK_PLUGINS } from "./markdownPipeline.ts";

type Node = { type: string; tagName?: string; value?: string; children?: Node[] };
type Level = -3 | -2 | -1 | 0 | 1 | 2 | 3 | "english";

const LEVELS: Level[] = [-3, -2, -1, 0, 1, 2, 3];
const BLOCKS = new Set(["p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "td", "th", "br"]);
const JAPANESE = /[\p{scx=Han}\p{scx=Hira}\p{scx=Kana}]/gu;
// A reply cut off mid-stream (the corpus's stream_ cases are prefixes of one reply).
const isStreaming = (name: string) => name.startsWith("stream_");

/** The message's text at a level, blocks apart, without code when `prose`. */
function textAt(source: string, level: Level, { streaming = false, prose = false } = {}) {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS)
    .use(rehypeChatLevel, {
      level: level === "english" ? -3 : level,
      englishOnly: level === "english",
      streaming,
    });
  const tree = processor.runSync(processor.parse(source), { value: source } as never) as Node;
  const text = (node: Node): string => {
    if (node.type === "text") return node.value ?? "";
    if (prose && (node.tagName === "code" || node.tagName === "pre")) return " ";
    const inner = (node.children ?? []).map(text).join("");
    return BLOCKS.has(node.tagName ?? "") ? ` ${inner} ` : inner;
  };
  return text(tree).replaceAll(/\s+/gu, " ").trim();
}

const cases = Object.entries(corpus as Record<string, string>);
const japaneseIn = (text: string) => text.match(JAPANESE)?.length ?? 0;
// Markup the renderer leaves as written (no valid twin), with Japanese no gloss translates.
const UNGLOSSED_AS_WRITTEN = new Set(["jw_bad_value"]);

describe("rehypeChatLevel over the review corpus", () => {
  it.each(cases)("only adds Japanese as the level goes up: %s", (name, source) => {
    const counts = LEVELS.map((level) =>
      japaneseIn(textAt(source, level, { streaming: isStreaming(name), prose: true })),
    );
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
  });

  it.each(cases.filter(([name]) => !UNGLOSSED_AS_WRITTEN.has(name)))(
    "shows no Japanese outside code in English only: %s",
    (name, source) => {
      expect(
        textAt(source, "english", { streaming: isStreaming(name), prose: true }).match(JAPANESE),
      ).toBeNull();
    },
  );

  it.each(cases.filter(([name]) => isStreaming(name)))(
    "shows no tag still being written in a streaming reply: %s",
    (_name, source) => {
      for (const level of LEVELS) {
        expect(textAt(source, level, { streaming: true })).not.toMatch(/<\/?[a-z]/iu);
      }
    },
  );
});

const RAIN = "今日は雨です。";
const RAINING = "It is raining today.";

describe("rehypeChatLevel with malformed twins", () => {
  // Each case's text at levels 0 and 1, below and at the threshold of 1 most of them carry.
  it.each([
    // An English twin with no Japanese one right before it always shows; a Japanese one alone shows at its
    // threshold and is its last sentence mark's translation below it.
    ["en_without_ja", `Intro. ${RAINING} Outro.`, `Intro. ${RAINING} Outro.`],
    ["ja_without_en", `Intro. ${RAINING} Outro.`, `Intro. ${RAIN} Outro.`],
    ["pair_blankline_between", `${RAINING} ${RAINING}`, `${RAIN} ${RAINING}`],
    ["mismatched_on", `${RAINING}${RAINING}`, `${RAIN}${RAINING}`],
    ["swapped_order", `${RAINING}${RAINING}`, `${RAINING}${RAIN}`],
    // Broken: every pair shows its English twin, and a Japanese twin a block end closed never shows.
    ["blank_line_in_ja", RAINING, RAINING],
    ["blank_line_in_en", "It is raining.", "It is raining."],
    // A Japanese twin left open ends where its English twin starts: a pair, in a broken message.
    ["unclosed_ja", `Intro. ${RAINING} Outro.`, `Intro. ${RAINING} Outro.`],
    ["unclosed_en", "Intro. It is raining. Outro.", "Intro. It is raining. Outro."],
    ["nested_twin", "outer", "outer"],
    // A comment between twins keeps them apart.
    ["comment_between", `${RAINING}${RAINING}`, `${RAIN}${RAINING}`],
    // Fine as written.
    ["br_in_ja", RAINING, "今日は 雨です。"],
    // An empty data-en falls back to the gloss's meaning; a self-closing level tag is dropped.
    ["en_empty", "The problem is small.", "The 問題 is small."],
    ["self_closing", `after ${RAINING}`, `after ${RAIN}`],
  ])("%s", (name, below, at) => {
    const source = (corpus as Record<string, string>)[name]!;
    expect([textAt(source, 0), textAt(source, 1)]).toEqual([below, at]);
  });

  it("pairs twins with a newline or a no-break space between, not a blank line", () => {
    const twins = (between: string) =>
      `<span data-jw="ja" data-on="1">${RAIN}</span>${between}<span data-jw="en" data-on="1">${RAINING}</span>`;
    expect(textAt(twins("\n"), 0)).toBe(RAINING);
    expect(textAt(twins("\u00a0"), 1)).toBe(RAIN);
    // Without a sentence mark gloss, the lone Japanese twin is nothing below its threshold.
    expect(textAt(twins("\n\n"), 0)).toBe(RAINING);
    expect(textAt(twins("\n\n"), 1)).toBe(`${RAIN} ${RAINING}`);
  });

  it("ignores a self-closing abbr, and renders an abbr left open in a finished message as written", () => {
    expect(textAt('One <abbr title="a · b"/>two.', 0)).toBe("One two.");
    const open =
      'The <abbr title="もんだい · problem" data-en="problem" data-on="1">問題 is small.';
    expect(textAt(open, 0)).toBe("The 問題 is small.");
    // Still arriving, it follows its threshold, as plain text until it closes.
    expect(textAt(open, 0, { streaming: true })).toBe("The problem");
    expect(textAt(open, 1, { streaming: true })).toBe("The 問題 is small.");
  });

  it("renders a twin or word whose threshold is not -2 to 3 as written", () => {
    for (const name of ["on_minus3", "on_4", "on_plus1", "on_1_0", "on_space", "on_empty"]) {
      const source = (corpus as Record<string, string>)[name]!;
      expect(textAt(source, -3), name).toContain("問題");
    }
  });
});

describe("rehypeChatLevel while a reply streams", () => {
  const prefix = (name: string) => (corpus as Record<string, string>)[name]!;

  it("follows the threshold of the twin still open at the end, and renders the rest as usual", () => {
    // The Japanese twin of a sentence at -1 is still being written.
    const writing = prefix("stream_06");
    expect(textAt(writing, -2, { streaming: true })).toBe(
      "The build failed on the parse step. The 問題 is small.",
    );
    expect(textAt(writing, -1, { streaming: true })).toBe(
      "The build failed on the parse step. The 問題 is small. 今日は",
    );
    // Finished, the same open twin breaks the message, which still shows no Japanese below the threshold.
    expect(textAt(writing, -2)).toBe("The build failed on the parse step. The 問題 is small.");
    // Finished, it is its sentence's translation until its English twin arrives.
    const finished = prefix("stream_09");
    expect(textAt(finished, -2, { streaming: true })).toContain(RAINING);
    // Its English twin is being written: shown below the threshold, hidden at it.
    const english = prefix("stream_11");
    expect(textAt(english, -2, { streaming: true })).toContain(RAINING);
    expect(textAt(english, -1, { streaming: true })).toContain(RAIN);
    expect(textAt(english, -1, { streaming: true })).not.toContain("It is");
  });
});
