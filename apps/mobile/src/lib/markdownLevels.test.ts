import { describe, expect, it } from "vite-plus/test";

import { markdownWithHtml, parseMarkdownSource, type MarkdownNode } from "./markdownDocument";
import {
  ENGLISH_ONLY_LEVEL,
  hasLevelMarkup,
  markdownAtLevel,
  markdownEnglishOnly,
} from "./markdownLevels";
import { glossHref } from "./markdownGlosses";

const english = (html: string) => markdownEnglishOnly(markdownWithHtml(html));

const MIXED =
  'The <abbr title="もんだい · problem / issue">問題</abbr> is small. <abbr title="きょう · today">今日</abbr>は<abbr title="あめ · rain">雨</abbr>です<abbr title="It is raining today.">。</abbr> We stay in <abbr title="いま · now">今</abbr>.';

describe("markdownEnglishOnly", () => {
  it("shows meanings for glossed words and translations for glossed sentences, as the desktop does", () => {
    expect(english(MIXED)).toBe("The problem is small. It is raining today. We stay in now.");
    // Runs back to the previous sentence mark, and keeps translations apart.
    expect(
      english(
        '<abbr title="あめ · rain">雨</abbr>です<abbr title="It is rain.">。</abbr><abbr title="ほんとう · really">本当</abbr>に<abbr title="Really?">？</abbr>',
      ),
    ).toBe("It is rain. Really?");
    // Runs back to the start of a list item.
    expect(
      english(
        '- <abbr title="もう · already">もう</abbr>、<abbr title="おわり · end">終わり</abbr>です<abbr title="It is already over.">。</abbr>',
      ),
    ).toBe("- It is already over.");
    // Never runs back across code, and leaves code as written.
    expect(
      english(
        'Run `npm test` <abbr title="いま · now">今</abbr>, then `git push` <abbr title="もう · already">もう</abbr>した<abbr title="Already pushed.">！</abbr>',
      ),
    ).toBe("Run `npm test` now, then `git push` Already pushed.");
    const fenced = '```html\n<abbr title="もんだい · problem">問題</abbr>\n```';
    expect(english(fenced)).toBe(fenced);
  });

  it("keeps abbreviations that are English already as glosses", () => {
    expect(
      english(
        'Set a <abbr title="Content Security Policy">CSP</abbr> header <abbr title="いま · now">今</abbr>.',
      ),
    ).toBe(`Set a [CSP](<${glossHref("Content Security Policy")}>) header now.`);
  });

  it("stops a sentence at a line break and translates inside emphasis on its own", () => {
    expect(
      english(
        'Line one.<br><abbr title="いま · now">今</abbr>です<abbr title="It is now.">。</abbr>',
      ),
    ).toBe("Line one.  \nIt is now.");
    expect(english('**<abbr title="きょう · today">今日</abbr>** and more')).toBe(
      "**today** and more",
    );
    expect(
      english('A *<abbr title="もし · if">もし</abbr><abbr title="If so?">？</abbr>* aside.'),
    ).toBe("A *If so?* aside.");
  });

  it("escapes what it writes, so a translation reads as written", () => {
    expect(english('<abbr title="ご · [5] items * 2">五</abbr>')).toBe("\\[5\\] items \\* 2");
    expect(english('<abbr title="1. First, the plan.">。</abbr>')).toBe("1\\. First, the plan.");
  });

  it("leaves a message without glosses alone", () => {
    expect(markdownEnglishOnly("Plain *text* here.")).toBe("Plain *text* here.");
  });
});

const LEVELS = [-3, -2, -1, 0, 1, 2, 3];

/** A gloss as the native renderer gets it (markdownWithHtml). */
const gloss = (word: string, title: string) => `[${word}](<${glossHref(title)}>)`;

/** A message at a level as the phone renders it: the level, then the gloss links. */
const at = (markdown: string, level: number, streaming = false) =>
  markdownWithHtml(markdownAtLevel(markdown, level, streaming));

/** English only: -3, then older glosses as English. */
const englishOnly = (markdown: string) =>
  markdownEnglishOnly(markdownWithHtml(markdownAtLevel(markdown, ENGLISH_ONLY_LEVEL)));

// A swapped word from level 1 up, and a sentence's twins with the Japanese from level 2 up; the English twin has a word
// of its own from level 0 up.
const LEVELED =
  'The <abbr title="もんだい · problem" data-en="problem" data-on="1">問題</abbr> is small. ' +
  '<span data-jw="ja" data-on="2"><abbr title="きょう · today">今日</abbr>は<abbr title="あめ · rain">雨</abbr>です<abbr title="It is raining today.">。</abbr></span>' +
  '<span data-jw="en" data-on="2">It is raining <abbr title="きょう · today" data-en="today" data-on="0">今日</abbr>.</span>' +
  " We stay in.";

const TODAY = gloss("今日", "きょう · today");
const JAPANESE_SENTENCE = `${TODAY}は${gloss("雨", "あめ · rain")}です${gloss("。", "It is raining today.")}`;

describe("markdownAtLevel", () => {
  it("shows a swapped word as its gloss at its threshold and up, and as its English below", () => {
    const word = 'A <abbr title="もんだい · problem" data-en="problem" data-on="1">問題</abbr>.';
    expect(at(word, 1)).toBe(`A ${gloss("問題", "もんだい · problem")}.`);
    expect(at(word, 3)).toBe(`A ${gloss("問題", "もんだい · problem")}.`);
    expect(at(word, 0)).toBe("A problem.");
    expect(at(word, -2)).toBe("A problem.");
  });

  it("shows a sentence's Japanese twin at its threshold and up, and its English twin below", () => {
    const twins =
      '<span data-jw="ja" data-on="0"><abbr title="あめ · rain">雨</abbr>です<abbr title="It is rain.">。</abbr></span>' +
      '<span data-jw="en" data-on="0">It is rain.</span> Then more.';
    const japanese = `${gloss("雨", "あめ · rain")}です${gloss("。", "It is rain.")} Then more.`;
    expect(at(twins, 0)).toBe(japanese);
    expect(at(twins, 2)).toBe(japanese);
    expect(at(twins, -1)).toBe("It is rain. Then more.");
  });

  it("renders a whole reply at each level, the English twin's own words by their thresholds", () => {
    const problem = gloss("問題", "もんだい · problem");
    expect(at(LEVELED, 3)).toBe(`The ${problem} is small. ${JAPANESE_SENTENCE} We stay in.`);
    expect(at(LEVELED, 2)).toBe(`The ${problem} is small. ${JAPANESE_SENTENCE} We stay in.`);
    expect(at(LEVELED, 1)).toBe(`The ${problem} is small. It is raining ${TODAY}. We stay in.`);
    expect(at(LEVELED, 0)).toBe(`The problem is small. It is raining ${TODAY}. We stay in.`);
    expect(at(LEVELED, -1)).toBe("The problem is small. It is raining today. We stay in.");
  });

  it("nests: what is Japanese at a level stays Japanese a level up", () => {
    const japanese = (level: number) =>
      [...at(LEVELED, level).matchAll(/\[([^\]]+)\]\(<t3-gloss:/g)].length;
    const counts = LEVELS.map(japanese);
    expect(counts).toEqual([0, 0, 0, 1, 2, 4, 4]);
    // A hidden twin takes the words inside it along; another span inside a shown one keeps its text.
    const inner =
      '<span data-jw="ja" data-on="1"><span class="x">中</span><abbr title="なか · inside" data-en="inside" data-on="0">中</abbr></span>' +
      '<span data-jw="en" data-on="1"><span class="x">In</span> <abbr title="なか · inside" data-en="inside" data-on="-1">中</abbr>.</span>';
    expect(at(inner, 2)).toBe(`中${gloss("中", "なか · inside")}`);
    expect(at(inner, 0)).toBe(`In ${gloss("中", "なか · inside")}.`);
    expect(at(inner, -2)).toBe("In inside.");
  });

  it("shows nothing Japanese at -3, the lowest threshold included", () => {
    const lowest =
      'Now <abbr title="いま · now" data-en="right now" data-on="-2">今</abbr>. ' +
      '<span data-jw="ja" data-on="-2"><abbr title="あめ · rain">雨</abbr><abbr title="Rain.">。</abbr></span><span data-jw="en" data-on="-2">Rain.</span>';
    expect(at(lowest, -2)).toBe(
      `Now ${gloss("今", "いま · now")}. ${gloss("雨", "あめ · rain")}${gloss("。", "Rain.")}`,
    );
    expect(at(lowest, -3)).toBe("Now right now. Rain.");
    expect(at(LEVELED, -3)).toBe("The problem is small. It is raining today. We stay in.");
  });

  it("leaves a message from before levels as it is, at every level", () => {
    for (const level of LEVELS) {
      expect(markdownAtLevel(MIXED, level)).toBe(MIXED);
      expect(markdownAtLevel("Plain *text* here.", level)).toBe("Plain *text* here.");
    }
    // An element with no whole-number threshold is one from before levels too.
    const unleveled =
      '<span data-jw="ja"><abbr title="あめ · rain" data-on="high">雨</abbr></span><span data-jw="en">Rain</span>';
    expect(markdownAtLevel(unleveled, -3)).toBe(unleveled);
    expect(hasLevelMarkup(MIXED)).toBe(false);
    expect(hasLevelMarkup(LEVELED)).toBe(true);
  });

  it("takes only the contract's thresholds, written exactly, and leaves any other element as written", () => {
    for (const on of ["-3", "4", " 1", "1 ", "+1", "01", "1.0", "", "-0"]) {
      const word = `A <abbr title="あめ · rain" data-en="rain" data-on="${on}">雨</abbr>.`;
      const twins = `<span data-jw="ja" data-on="${on}">雨</span><span data-jw="en" data-on="${on}">Rain</span>`;
      for (const level of [-3, 3]) {
        expect(markdownAtLevel(word, level)).toBe(word);
        expect(markdownAtLevel(twins, level)).toBe(twins);
      }
    }
    for (const on of ["-2", "-1", "0", "1", "2", "3"]) {
      expect(at(`<abbr title="あめ · rain" data-en="rain" data-on="${on}">雨</abbr>`, -3)).toBe(
        "rain",
      );
    }
  });

  it("turns older glosses into English under English only, in older and leveled messages alike", () => {
    expect(englishOnly(MIXED)).toBe("The problem is small. It is raining today. We stay in now.");
    expect(englishOnly(LEVELED)).toBe("The problem is small. It is raining today. We stay in.");
    expect(englishOnly(`${LEVELED} Back <abbr title="いま · now">今</abbr>.`)).toBe(
      "The problem is small. It is raining today. We stay in. Back now.",
    );
  });

  it("leaves code as written, the markup in it included", () => {
    const inline =
      'Use `<span data-jw="ja" data-on="2">x</span>` and `<abbr data-en="a" data-on="3">b</abbr>` here.';
    const fenced =
      '```html\n<span data-jw="ja" data-on="2">雨</span><span data-jw="en" data-on="2">Rain</span>\n```';
    const inTwin =
      '<span data-jw="ja" data-on="1">`npm test`<abbr title="Run it.">。</abbr></span><span data-jw="en" data-on="1">Run `npm test`.</span>';
    for (const level of LEVELS) {
      expect(markdownAtLevel(inline, level)).toBe(inline);
      expect(markdownAtLevel(fenced, level)).toBe(fenced);
    }
    expect(at(inTwin, 1)).toBe(`\`npm test\`${gloss("。", "Run it.")}`);
    expect(at(inTwin, 0)).toBe("Run `npm test`.");
  });

  it("keeps Markdown inside a twin rendering as Markdown", () => {
    const styled =
      '- <span data-jw="ja" data-on="1">**<abbr title="きょう · today">今日</abbr>**<abbr title="Today.">。</abbr></span>' +
      '<span data-jw="en" data-on="1">It is **very** *wet*, see [the docs](https://example.com).</span>';
    const kinds = (markdown: string) => {
      const found = new Set<string>();
      const walk = (node: MarkdownNode) => {
        found.add(node.type);
        if ("children" in node) node.children.forEach(walk);
      };
      walk(parseMarkdownSource(markdown));
      return found;
    };
    const english = at(styled, 0);
    expect(english).toBe("- It is **very** *wet*, see [the docs](https://example.com).");
    expect([...kinds(english)]).toEqual(
      expect.arrayContaining(["listItem", "strong", "emphasis", "link"]),
    );
    const japanese = at(styled, 1);
    expect(japanese).toBe(`- **${TODAY}**${gloss("。", "Today.")}`);
    expect([...kinds(japanese)]).toEqual(expect.arrayContaining(["strong", "link"]));
  });

  it("writes a swapped word's English as plain text", () => {
    expect(at('A <abbr title="ご · five" data-en="[5] items * 2" data-on="1">五</abbr>', 0)).toBe(
      "A \\[5\\] items \\* 2",
    );
    expect(
      at('<abbr title="あめ · rain" data-en="&quot;rain&quot;" data-on="1">雨</abbr>', 0),
    ).toBe('"rain"');
    // Without its English, a swapped word shows its gloss's meaning.
    expect(at('A <abbr title="あめ · rain / shower" data-on="1">雨</abbr>.', 0)).toBe("A rain.");
  });

  it("hides a twin still streaming in by its threshold", () => {
    const streaming = 'Hi. <span data-jw="ja" data-on="2"><abbr title="あめ · rain">雨</abbr>で';
    expect(at(streaming, 1, true)).toBe("Hi. ");
    expect(at(streaming, 2, true)).toBe(`Hi. ${gloss("雨", "あめ · rain")}で`);
    const english = `${streaming}<abbr title="Rain.">。</abbr></span><span data-jw="en" data-on="2">It is ra`;
    expect(at(english, 1, true)).toBe("Hi. It is ra");
    expect(at(english, 2, true)).toBe(`Hi. ${gloss("雨", "あめ · rain")}で${gloss("。", "Rain.")}`);
    // Only at the end of what has come: a twin left open in an earlier paragraph is broken, not streaming.
    expect(at(`${streaming}\n\nMore`, 1, true)).toBe(`Hi. ${gloss("雨", "あめ · rain")}で\n\nMore`);
  });

  it("fails safe on broken twins: English below the threshold, and never cuts the text after them", () => {
    const rain = gloss("雨", "あめ · rain");
    // A blank line inside a twin keeps it one twin.
    const blankJapanese =
      '<span data-jw="ja" data-on="1"><abbr title="あめ · rain">雨</abbr>。\n\n<abbr title="あめ · rain">雨</abbr>。</span><span data-jw="en" data-on="1">Rain. Rain.</span> After.';
    expect(at(blankJapanese, 0)).toBe("Rain. Rain. After.");
    expect(at(blankJapanese, 1)).toBe(`${rain}。\n\n${rain}。 After.`);
    const blankEnglish =
      '<span data-jw="ja" data-on="1"><abbr title="あめ · rain">雨</abbr>。</span><span data-jw="en" data-on="1">Rain.\n\nRain.</span> After.';
    expect(at(blankEnglish, 0)).toBe("Rain.\n\nRain. After.");
    expect(at(blankEnglish, 1)).toBe(`${rain}。 After.`);

    // A Japanese twin left open ends where its English twin starts.
    const openJapanese =
      '<span data-jw="ja" data-on="1"><abbr title="あめ · rain">雨</abbr>。<span data-jw="en" data-on="1">Rain.</span> After.\n\nNext.';
    expect(at(openJapanese, 0)).toBe("Rain. After.\n\nNext.");
    expect(at(openJapanese, 1)).toBe(`${rain}。 After.\n\nNext.`);
    // An English twin left open shows at every level, and its Japanese twin goes.
    const openEnglish =
      '<span data-jw="ja" data-on="1"><abbr title="あめ · rain">雨</abbr>。</span><span data-jw="en" data-on="1">Rain. After.\n\nNext.';
    for (const level of LEVELS) expect(at(openEnglish, level)).toBe("Rain. After.\n\nNext.");
    // A Japanese twin left open with no English stays as written rather than cut what follows.
    const alone = 'Hi. <span data-jw="ja" data-on="1"><abbr title="あめ · rain">雨</abbr>。 After.';
    expect(at(alone, 0)).toBe(`Hi. ${rain}。 After.`);
    // A word left open stays as written too.
    const word = 'A <abbr title="あめ · rain" data-en="rain" data-on="1">雨 after.';
    expect(at(word, 0)).toBe("A 雨 after.");
  });
});
