import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
} from "@t3tools/shared/markdownPipeline";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { createMarkdownRenderer } from "./markdownRenderer";
import { rehypeChatLevel } from "./markdownLevel";

const renderer = (rehypePlugins: Parameters<typeof createMarkdownRenderer>[0]["rehypePlugins"]) =>
  createMarkdownRenderer({
    remarkPlugins: CHAT_MARKDOWN_REMARK_PLUGINS,
    rehypePlugins,
    components: {},
    urlTransform: (url) => url,
  });

const asWritten = renderer(CHAT_MARKDOWN_REHYPE_PLUGINS);
const renderers = new Map<string, ReturnType<typeof renderer>>();

/** The message's HTML through the chat pipeline (raw HTML, sanitizer) at a level, or in English only. */
function html(source: string, level: number | "english") {
  const key = String(level);
  let render = renderers.get(key);
  if (!render) {
    const options =
      level === "english" ? { level: -3, englishOnly: true } : { level, englishOnly: false };
    render = renderer([...CHAT_MARKDOWN_REHYPE_PLUGINS, [rehypeChatLevel, options]]);
    renderers.set(key, render);
  }
  return renderToStaticMarkup(render(source, false));
}

const textAt = (source: string, level: number | "english") =>
  html(source, level).replaceAll(/<[^>]+>/g, "");

const JAPANESE = /[\p{scx=Han}\p{scx=Hira}\p{scx=Kana}]/u;
const LEVELS = [-3, -2, -1, 0, 1, 2, 3];

// A swapped word, and a sentence with twins whose English carries a word of its own with a lower threshold.
const WORD = '<abbr title="もんだい · problem" data-en="problem" data-on="1">問題</abbr>';
const TWINS =
  '<span data-jw="ja" data-on="2"><abbr title="きょう · today">今日</abbr>は<abbr title="あめ · rain">雨</abbr>です<abbr title="It is raining today.">。</abbr></span>' +
  '<span data-jw="en" data-on="2">It is raining <abbr title="きょう · today" data-en="today" data-on="-1">今日</abbr>.</span>';
const MESSAGE = `The ${WORD} is small. ${TWINS} We stay in.`;

describe("rehypeChatLevel", () => {
  it("shows a swapped word as its gloss at or above its threshold and as its English below", () => {
    expect(html(`The ${WORD} is small.`, 1)).toBe(
      '<p>The <abbr data-en="problem" data-on="1" data-markdown-title="もんだい · problem">問題</abbr> is small.</p>',
    );
    expect(html(`The ${WORD} is small.`, 3)).toContain(">問題</abbr>");
    expect(html(`The ${WORD} is small.`, 0)).toBe("<p>The problem is small.</p>");
  });

  it("shows one twin of a sentence: the Japanese at or above its threshold, else the English", () => {
    expect(textAt(MESSAGE, 2)).toBe("The 問題 is small. 今日は雨です。 We stay in.");
    expect(html(MESSAGE, 2)).not.toContain('data-jw="en"');
    // Below it the English twin, whose own word turns English at its lower threshold.
    expect(textAt(MESSAGE, 1)).toBe("The 問題 is small. It is raining 今日. We stay in.");
    expect(html(MESSAGE, 1)).not.toContain('data-jw="ja"');
    expect(textAt(MESSAGE, 0)).toBe("The problem is small. It is raining 今日. We stay in.");
    expect(textAt(MESSAGE, -1)).toBe("The problem is small. It is raining 今日. We stay in.");
    expect(textAt(MESSAGE, -2)).toBe("The problem is small. It is raining today. We stay in.");
  });

  it("shows no Japanese at -3", () => {
    expect(textAt(MESSAGE, -3)).toBe("The problem is small. It is raining today. We stay in.");
    expect(html(MESSAGE, -3)).not.toContain("<abbr");
  });

  it("only adds Japanese as the level goes up", () => {
    const glossed = (level: number) =>
      [...html(MESSAGE, level).matchAll(/<abbr[^>]*>([^<]*)<\/abbr>/g)].map((match) => match[1]);
    expect(LEVELS.map(glossed)).toEqual([
      [],
      [],
      ["今日"],
      ["今日"],
      ["問題", "今日"],
      ["問題", "今日", "雨", "。"],
      ["問題", "今日", "雨", "。"],
    ]);
  });

  it("keeps markdown inside the twins", () => {
    const source =
      '<span data-jw="ja" data-on="0"><abbr title="あめ · rain">雨</abbr>です<abbr title="It is rain.">。</abbr></span><span data-jw="en" data-on="0">It is **rain**, see `rain.ts`.</span>';
    expect(html(source, 0)).toBe(
      '<p><span data-jw="ja" data-on="0"><abbr data-markdown-title="あめ · rain">雨</abbr>です<abbr data-markdown-title="It is rain.">。</abbr></span></p>',
    );
    expect(html(source, -1)).toBe(
      '<p><span data-jw="en" data-on="0">It is <strong>rain</strong>, see <code data-inline-code="">rain.ts</code>.</span></p>',
    );
  });

  it("leaves code as written", () => {
    const source = `Run \`${WORD}\` now.\n\n\`\`\`html\n${TWINS}\n\`\`\``;
    for (const level of [-3, 3, "english"] as const) {
      expect(html(source, level)).toBe(renderToStaticMarkup(asWritten(source, false)));
    }
  });

  it("renders messages without levels as written at every level", () => {
    const source =
      'The <abbr title="もんだい · problem">問題</abbr> is small. <span data-jw="ja">今日</span>, a <abbr title="Content Security Policy">CSP</abbr>.';
    for (const level of LEVELS) {
      expect(html(source, level)).toBe(renderToStaticMarkup(asWritten(source, false)));
    }
  });

  it("turns old messages into English in English only, as before", () => {
    const source =
      'The <abbr title="もんだい · problem / issue">問題</abbr> is small. <abbr title="きょう · today">今日</abbr>は<abbr title="あめ · rain">雨</abbr>です<abbr title="It is raining today.">。</abbr> A <abbr title="Content Security Policy">CSP</abbr>.';
    expect(textAt(source, "english")).toBe("The problem is small. It is raining today. A CSP.");
  });

  it("shows new messages at -3 in English only, with a gloss outside the twins in English too", () => {
    const source = `${MESSAGE} <abbr title="いま · now">今</abbr>.`;
    expect(textAt(source, "english")).toBe(
      "The problem is small. It is raining today. We stay in. now.",
    );
    expect(JAPANESE.test(textAt(source, "english"))).toBe(false);
    // The level alone leaves a gloss without a threshold as written.
    expect(textAt(source, -3)).toContain("今");
  });

  it("keeps only well-formed level markup past the sanitizer", () => {
    const source =
      '<span data-jw="ja" data-on="x" onclick="alert(1)">今日</span><span data-jw="zz" data-on="1">today</span>';
    expect(html(source, 0)).toBe(
      '<p><span data-jw="ja">今日</span><span data-on="1">today</span></p>',
    );
  });
});
