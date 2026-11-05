import { describe, expect, it } from "vite-plus/test";

import { markdownWithHtml } from "./markdownDocument";
import { markdownEnglishOnly } from "./markdownEnglishOnly";
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
