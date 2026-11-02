import { AnnotationInteractionsReportInput, type AnnotationReviewCard } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  createReviewSession,
  REVIEW_EXCLUDE_MAX,
  reviewFailureDetail,
  type AnnotationReviewItem,
  type ReviewFetch,
} from "./reviewSession";

const WALL = 1_800_000_000_000;
const decodeReport = Schema.decodeUnknownSync(AnnotationInteractionsReportInput);

const card = (n: number): AnnotationReviewCard => ({
  id: `c${n}`,
  ja: `語${n}`,
  kana: `ご${n}`,
  gloss: `word ${n}`,
});

/** Lets the callbacks of every promise already settled run (the session chains a few). */
async function settle() {
  for (let hop = 0; hop < 20; hop += 1) await Promise.resolve();
}

function harness(answers: Array<ReviewFetch | Error> = []) {
  let mono = 1000;
  const requests: Array<ReadonlyArray<string>> = [];
  const emitted: AnnotationReviewItem[] = [];
  let next = 0;
  const session = createReviewSession({
    fetchNext: async (exclude) => {
      requests.push([...exclude]);
      const answer = answers[next++] ?? { _tag: "empty" };
      if (answer instanceof Error) throw answer;
      return answer;
    },
    emit: (item) => emitted.push(item),
    monotonicNow: () => mono,
    wallNow: () => WALL + mono,
    uid: () => `u${emitted.length + 1}`,
  });
  return {
    session,
    requests,
    emitted,
    tick: (ms: number) => {
      mono += ms;
    },
    /** The showing number of the card on screen; fails the test when there is none. */
    showing: () => {
      const view = session.getView();
      if (view._tag !== "card") throw new Error(`no card: ${view._tag}`);
      return view.showing;
    },
  };
}

const cardAnswer = (n: number): ReviewFetch => ({ _tag: "card", card: card(n) });

describe("review session", () => {
  it("shows the first card and prefetches the next, excluding the card it has", async () => {
    const h = harness([cardAnswer(1), cardAnswer(2)]);
    h.session.start();
    expect(h.session.getView()._tag).toBe("loading");
    await settle();
    expect(h.session.getView()).toMatchObject({ _tag: "card", card: card(1), shown: false });
    expect(h.requests).toEqual([[], ["c1"]]);
  });

  it("counts the reveal once, from the card being on screen", async () => {
    const h = harness([cardAnswer(1), cardAnswer(2)]);
    h.session.start();
    await settle();
    h.tick(250); // enter animation
    h.session.cardShown(h.showing());
    h.tick(1200);
    h.session.reveal();
    h.tick(800);
    h.session.reveal();
    expect(h.session.getView()).toMatchObject({ _tag: "card", revealed: true });
    h.tick(500);
    h.session.next();
    expect(h.emitted).toEqual([
      {
        kind: "review",
        at: WALL + 1250,
        card: "c1",
        word: "語1",
        revealMs: 1200,
        shownMs: 2500,
        source: "mobile",
        uid: "u1",
      },
    ]);
    expect(() => decodeReport({ items: h.emitted })).not.toThrow();
  });

  it("ignores a reveal before the card is on screen", async () => {
    const h = harness([cardAnswer(1)]);
    h.session.start();
    await settle();
    h.session.reveal();
    expect(h.session.getView()).toMatchObject({ revealed: false });
    h.session.cardShown(h.showing());
    h.tick(300);
    h.session.reveal();
    h.session.close();
    expect(h.emitted.map((item) => item.revealMs)).toEqual([300]);
  });

  it("emits one item on next, then shows the prefetched card", async () => {
    const h = harness([cardAnswer(1), cardAnswer(2), cardAnswer(3)]);
    h.session.start();
    await settle();
    h.session.cardShown(h.showing());
    h.tick(400);
    h.session.reveal();
    h.session.leave(); // the swipe is released
    h.tick(200); // its exit animation
    h.session.next();
    h.session.next(); // a second call while the next card loads does nothing
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]).toMatchObject({ card: "c1", revealMs: 400, shownMs: 400 });
    await settle();
    expect(h.session.getView()).toMatchObject({ _tag: "card", card: card(2), revealed: false });
    expect(h.requests).toEqual([[], ["c1"], ["c2", "c1"]]);
  });

  it("emits revealMs null when the reader moves on without revealing", async () => {
    const h = harness([cardAnswer(1), cardAnswer(2)]);
    h.session.start();
    await settle();
    h.session.cardShown(h.showing());
    h.tick(900);
    h.session.next();
    expect(h.emitted).toEqual([
      expect.objectContaining({ card: "c1", revealMs: null, shownMs: 900 }),
    ]);
    expect(() => decodeReport({ items: h.emitted })).not.toThrow();
  });

  it("emits on close, once, and nothing after", async () => {
    const h = harness([cardAnswer(1), cardAnswer(2)]);
    h.session.start();
    await settle();
    h.session.cardShown(h.showing());
    h.tick(700);
    h.session.close();
    h.session.close();
    h.session.next();
    h.session.reveal();
    await settle();
    expect(h.emitted).toEqual([expect.objectContaining({ revealMs: null, shownMs: 700 })]);
    expect(h.session.getView()._tag).toBe("closed");
  });

  it("emits nothing for a card that never got on screen", async () => {
    const h = harness([cardAnswer(1), cardAnswer(2)]);
    h.session.start();
    await settle();
    h.session.close();
    expect(h.emitted).toEqual([]);
  });

  it("shows nothing to review and emits nothing", async () => {
    const h = harness([{ _tag: "empty" }]);
    h.session.start();
    await settle();
    expect(h.session.getView()).toEqual({ _tag: "empty" });
    h.session.close();
    expect(h.emitted).toEqual([]);
  });

  it("shows the short detail of an error and emits nothing", async () => {
    const h = harness([{ _tag: "error", detail: "collector down" }, new Error("socket closed")]);
    h.session.start();
    await settle();
    expect(h.session.getView()).toEqual({ _tag: "error", detail: "collector down" });
    h.session.next(); // asks again
    await settle();
    expect(h.session.getView()).toEqual({ _tag: "error", detail: "socket closed" });
    h.session.close();
    expect(h.emitted).toEqual([]);
  });

  it("asks again when the prefetch failed", async () => {
    const h = harness([cardAnswer(1), { _tag: "error", detail: "timeout" }, cardAnswer(2)]);
    h.session.start();
    await settle();
    h.session.cardShown(h.showing());
    h.session.next();
    await settle();
    expect(h.session.getView()).toMatchObject({ _tag: "card", card: card(2) });
    expect(h.requests).toEqual([[], ["c1"], ["c1"], ["c2", "c1"]]);
  });

  it("leaves the card when the app goes to the background and brings the next on return", async () => {
    const h = harness([cardAnswer(1), cardAnswer(2), cardAnswer(3)]);
    h.session.start();
    await settle();
    h.session.cardShown(h.showing());
    h.tick(300);
    h.session.suspend();
    h.session.suspend();
    h.tick(60_000);
    h.session.reveal(); // a left card no longer counts
    expect(h.emitted).toEqual([expect.objectContaining({ revealMs: null, shownMs: 300 })]);
    h.session.resume();
    await settle();
    expect(h.session.getView()).toMatchObject({ _tag: "card", card: card(2) });
    h.session.close(); // the new card was never shown
    expect(h.emitted).toHaveLength(1);
  });

  it("drops an answer that arrives after close", async () => {
    let release: (value: ReviewFetch) => void = () => undefined;
    const emitted: AnnotationReviewItem[] = [];
    const session = createReviewSession({
      fetchNext: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      emit: (item) => emitted.push(item),
      monotonicNow: () => 0,
      wallNow: () => WALL,
      uid: () => "u",
    });
    session.start();
    session.close();
    release(cardAnswer(1));
    await settle();
    expect(session.getView()._tag).toBe("closed");
  });

  it("excludes at most 20 cards, the latest first", async () => {
    const h = harness(Array.from({ length: 25 }, (_, index) => cardAnswer(index + 1)));
    h.session.start();
    await settle();
    for (let index = 0; index < 23; index += 1) {
      h.session.cardShown(h.showing());
      h.session.next();
      await settle();
    }
    const last = h.requests.at(-1)!;
    expect(last).toHaveLength(REVIEW_EXCLUDE_MAX);
    expect(last[0]).toBe("c24");
    expect(h.emitted).toHaveLength(23);
    expect(new Set(h.emitted.map((item) => item.uid)).size).toBe(23);
  });
});

describe("reviewFailureDetail", () => {
  it("prefers the server's detail, then a message, then a fallback", () => {
    expect(reviewFailureDetail({ _tag: "AnnotationReviewError", detail: "no deck" })).toBe(
      "no deck",
    );
    expect(reviewFailureDetail(new Error("  socket\n closed "))).toBe("socket closed");
    expect(reviewFailureDetail(undefined)).toBe("Could not load a card");
    expect(reviewFailureDetail("x".repeat(400))).toHaveLength(160);
  });
});
