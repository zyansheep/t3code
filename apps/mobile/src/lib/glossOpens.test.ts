import {
  AnnotationEnglishSetInput,
  AnnotationInteractionsReportInput,
  AnnotationInteraction,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  createGlossOpenQueue,
  fnv1a32,
  glossContextId,
  glossContextsOf,
  glossOpenItem,
  type QueuedGlossOpen,
} from "./glossOpens";

const NOW = 1_800_000_000_000;
const isItem = Schema.is(AnnotationInteraction);
const decodeReport = Schema.decodeUnknownSync(AnnotationInteractionsReportInput);
const decodeEnglish = Schema.decodeUnknownSync(AnnotationEnglishSetInput);

const open = (sequence: number, word = "mondai", at = NOW) =>
  glossOpenItem({ session: "s1", sequence, messageText: "raw text", word, at })!;

const entry = (sequence: number, environmentId = "e1", at = NOW): QueuedGlossOpen => ({
  environmentId,
  item: open(sequence, "mondai", at),
});

function harness(options: {
  stored?: unknown;
  send?: (
    environmentId: string,
    items: ReadonlyArray<AnnotationInteraction>,
  ) => boolean | Promise<boolean>;
}) {
  const sent: Array<{ environmentId: string; uids: Array<string | undefined> }> = [];
  const saves: Array<ReadonlyArray<QueuedGlossOpen>> = [];
  const queue = createGlossOpenQueue({
    load: async () => options.stored ?? [],
    save: async (entries) => {
      saves.push(entries);
    },
    send: async (environmentId, items) => {
      sent.push({ environmentId, uids: items.map((item) => item.uid) });
      return (await options.send?.(environmentId, items)) ?? true;
    },
    isItem,
    now: () => NOW,
  });
  return { queue, sent, saves };
}

describe("glossOpenItem", () => {
  it("claims the opened word and nothing else", () => {
    const item = open(7);
    expect(item).toEqual({
      kind: "pin",
      word: "mondai",
      at: NOW,
      dwellMs: 0,
      view: `phone-s1-${fnv1a32("mondai").toString(36)}`,
      context: `m${fnv1a32("raw text").toString(36)}`,
      position: 0,
      box: [0, 0, 0, 0],
      annotations: [["mondai", 0, 0]],
      uid: "phone-s1-7",
    });
    expect(item).not.toHaveProperty("words");
    expect(decodeReport({ items: [item] })).toEqual({
      items: [item],
    });
  });

  it("gives two words of one message separate views, so neither reads as left unopened", () => {
    const [a, b] = [open(1, "mondai"), open(2, "moshi")];
    expect(a.context).toBe(b.context);
    expect(a.view).not.toBe(b.view);
    expect(open(3, "mondai").view).toBe(a.view);
  });

  it("hashes as the desktop does", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
  });

  it("skips words the collector would reject", () => {
    expect(glossOpenItem({ session: "s", sequence: 1, messageText: "", word: " ", at: NOW })).toBe(
      null,
    );
    expect(
      glossOpenItem({ session: "s", sequence: 1, messageText: "", word: "x".repeat(41), at: NOW }),
    ).toBe(null);
  });
});

describe("glossContextsOf", () => {
  it("names the messages on screen by the views and context of their reported opens, as the collector has them", () => {
    const opens = [
      glossOpenItem({ session: "s1", sequence: 1, messageText: "first", word: "mondai", at: NOW })!,
      glossOpenItem({ session: "s1", sequence: 2, messageText: "first", word: "moshi", at: NOW })!,
      glossOpenItem({ session: "s1", sequence: 3, messageText: "second", word: "ima", at: NOW })!,
    ];
    const opened = new Map<string, Set<string>>();
    for (const item of opens) {
      opened.set(item.context, (opened.get(item.context) ?? new Set()).add(item.view));
    }
    const onScreen = ["first", "never opened", "second"].map(glossContextId);
    const contexts = glossContextsOf(onScreen, opened);
    expect(contexts).toEqual(opens.map(({ view, context }) => ({ view, context })));
    expect(() => decodeEnglish({ on: true, contexts })).not.toThrow();
    expect(glossContextsOf(Array(40).fill(opens[0]!.context), opened)).toHaveLength(30);
  });
});

describe("createGlossOpenQueue", () => {
  it("sends in order, in batches of at most 50, and forgets what was taken", async () => {
    const { queue, sent, saves } = harness({});
    for (let i = 1; i <= 60; i += 1) await queue.add(entry(i));
    await queue.flush();
    expect(sent.map((call) => call.uids.length)).toEqual([50, 10]);
    expect(sent[0]!.uids[0]).toBe("phone-s1-1");
    expect(queue.pending()).toEqual([]);
    expect(saves.at(-1)).toEqual([]);
  });

  it("keeps a failed batch for the next flush, with the same uid", async () => {
    let online = false;
    const { queue, sent } = harness({ send: () => online });
    await queue.add(entry(1));
    await queue.flush();
    expect(queue.pending()).toHaveLength(1);
    online = true;
    await queue.flush();
    expect(queue.pending()).toEqual([]);
    expect(sent.map((call) => call.uids)).toEqual([["phone-s1-1"], ["phone-s1-1"]]);
  });

  it("settles an item's fate only when it leaves the queue: taken on a retry, or dropped unsent", async () => {
    // A server that could not store a review refuses the whole report, which stays queued.
    let storing = false;
    const { queue } = harness({ send: () => storing });
    await queue.add(entry(1));
    let fate: boolean | undefined;
    void queue.settled("phone-s1-1").then((taken) => {
      fate = taken;
    });
    await queue.flush();
    expect(fate).toBeUndefined();
    storing = true;
    await queue.flush();
    expect(fate).toBe(true);
    await expect(queue.settled("never-queued")).resolves.toBe(true);

    const full = harness({ send: () => false });
    await full.queue.add(entry(1));
    const dropped = full.queue.settled("phone-s1-1");
    for (let i = 2; i <= 301; i += 1) await full.queue.add(entry(i));
    await expect(dropped).resolves.toBe(false);
  });

  it("never rejects when sending or saving throws", async () => {
    const queue = createGlossOpenQueue({
      load: async () => {
        throw new Error("unreadable");
      },
      save: async () => {
        throw new Error("disk full");
      },
      send: async () => {
        throw new Error("offline");
      },
      isItem,
      now: () => NOW,
    });
    await expect(queue.add(entry(1))).resolves.toBeUndefined();
    await expect(queue.flush()).resolves.toBeUndefined();
    expect(queue.pending()).toHaveLength(1);
  });

  it("lets one server's failure hold back only its own reports", async () => {
    const { queue } = harness({ send: (environmentId) => environmentId === "up" });
    await queue.add(entry(1, "down"));
    await queue.add(entry(2, "up"));
    await queue.flush();
    expect(queue.pending().map((queued) => queued.environmentId)).toEqual(["down"]);
  });

  it("is bounded in size and age, the oldest going first", async () => {
    const { queue } = harness({ send: () => false });
    await queue.add(entry(1, "e1", NOW - 8 * 86_400_000));
    for (let i = 2; i <= 400; i += 1) await queue.add(entry(i));
    const pending = queue.pending();
    expect(pending).toHaveLength(300);
    expect(pending[0]!.item.uid).toBe("phone-s1-101");
    expect(pending.at(-1)!.item.uid).toBe("phone-s1-400");
  });

  it("restores what an earlier run left, before new opens, and ignores junk", async () => {
    const { queue } = harness({
      stored: [entry(1), { environmentId: "e1", item: { kind: "visible" } }, 3, null],
    });
    await queue.add(entry(2));
    expect(queue.pending().map((queued) => queued.item.uid)).toEqual(["phone-s1-1", "phone-s1-2"]);
    const junk = harness({ stored: { not: "a list" } });
    await junk.queue.flush();
    expect(junk.sent).toEqual([]);
  });

  it("carries review items beside opens, and restores them", async () => {
    const review = {
      kind: "review" as const,
      at: NOW,
      card: "c1",
      word: "問題",
      revealMs: null,
      shownMs: 900,
      source: "mobile" as const,
      uid: "phone-review-s1-1",
    };
    const { queue, sent } = harness({ stored: [{ environmentId: "e1", item: review }] });
    await queue.add(entry(1));
    await queue.flush();
    expect(sent).toEqual([{ environmentId: "e1", uids: ["phone-review-s1-1", "phone-s1-1"] }]);
    expect(decodeReport({ items: [review, open(1)] }).items).toHaveLength(2);
  });
});
