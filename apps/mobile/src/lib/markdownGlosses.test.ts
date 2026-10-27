import { describe, expect, it } from "vite-plus/test";
import { parseMarkdown } from "react-native-enriched-markdown/src/web/parseMarkdown";
import { markdownForNativeRendering, markdownWithHtml } from "./markdownDocument";
import { glossHref, glossOf, hasGlossLinks, markdownWithGlosses } from "./markdownGlosses";
import { ENRICHED_INLINE_FILE_LINK_REGEX } from "./enrichedLinkPresentation";

const PROBLEM = '<abbr title="もんだい · problem">問題</abbr>';
const problemHref = glossHref("もんだい · problem")!;

describe("glossed words in native Markdown", () => {
  it("turns each titled abbr into a gloss link", () => {
    expect(markdownWithHtml(`The ${PROBLEM}は easy.`)).toBe(`The [問題](<${problemHref}>)は easy.`);
    expect(
      markdownWithHtml(
        '終わりました<abbr title="It\'s done.">。</abbr> And <abbr title="if">もし</abbr>.',
      ),
    ).toBe(`終わりました[。](<${glossHref("It's done.")}>) And [もし](<${glossHref("if")}>).`);
  });

  it("keeps code, untitled abbrs and abbrs inside links as plain text", () => {
    expect(markdownWithHtml(`Run \`${PROBLEM}\` here.`)).toBe(`Run \`${PROBLEM}\` here.`);
    expect(markdownWithHtml("<abbr>問題</abbr> stays.")).toBe("問題 stays.");
    expect(markdownWithHtml(`<a href="https://example.com">${PROBLEM}</a>`)).toBe(
      "[問題](<https://example.com>)",
    );
    expect(markdownWithHtml(`[${PROBLEM}](https://example.com)`)).toBe(
      "[問題](https://example.com)",
    );
    expect(markdownWithHtml(`<abbr title="x"><a href="https://example.com">y</a></abbr>`)).toBe(
      "[y](<https://example.com>)",
    );
  });

  it("numbers the links and writes an opened gloss after its word", async () => {
    const markdown = markdownForNativeRendering(
      `${PROBLEM}は${PROBLEM}です<abbr title="The problem is *the* problem.">。</abbr>`,
      ENRICHED_INLINE_FILE_LINK_REGEX,
    );
    expect(hasGlossLinks(markdown)).toBe(true);
    const closed = markdownWithGlosses(markdown, new Set());
    expect(closed).toContain(`(<t3-gloss:1/${problemHref.slice("t3-gloss:".length)}>)`);
    const opened = markdownWithGlosses(markdown, new Set([0, 2]));
    const paragraph = (await parseMarkdown(opened))?.children?.[0];
    expect(paragraph).toMatchObject({
      type: "Paragraph",
      children: [
        { type: "Link", children: [{ type: "Text", content: "問題" }] },
        { type: "Text", content: " (" },
        { type: "Emphasis", children: [{ type: "Text", content: "もんだい · problem" }] },
        { type: "Text", content: ")は" },
        { type: "Link" },
        { type: "Text", content: "です" },
        { type: "Link", children: [{ type: "Text", content: "。" }] },
        { type: "Text", content: " (" },
        {
          type: "Emphasis",
          children: [{ type: "Text", content: "The problem is *the* problem." }],
        },
        { type: "Text", content: ")" },
      ],
    });
    const url = (paragraph as { children: Array<{ attributes?: { url?: string } }> }).children[0]!
      .attributes!.url!;
    expect(glossOf(url)).toEqual({ index: 0, title: "もんだい · problem" });
  });

  it("leaves Markdown with no glosses alone", () => {
    expect(markdownWithGlosses("[a](<https://example.com>)", new Set([0]))).toBe(
      "[a](<https://example.com>)",
    );
    expect(glossOf("https://example.com")).toBeNull();
  });
});
