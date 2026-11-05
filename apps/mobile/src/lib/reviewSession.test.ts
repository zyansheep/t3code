import { AnnotationInteractionsReportInput, type AnnotationReviewCard } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  countsAfterGrades,
  createCardReleases,
  createReviewSession,
  fetchWithin,
  REVIEW_EXCLUDE_MAX,
  reviewFailureDetail,
  type AnnotationReviewItem,
  type ReviewCounts,
  type ReviewFetch,
} from "./reviewSession";

const WALL = 1_800_000_000_000;
const decodeReport = Schema.decodeUnknownSync(AnnotationInteractionsReportInput);

const card = (
  n: number,
  queue: AnnotationReviewCard["queue"] = "review",
): AnnotationReviewCard => ({
  id: `c${n}`,
  ja: `語${n}`,
  kana: `ご${n}`,
  gloss: `word ${n}`,
  queue,
  intervals: { again: 60, hard: 600, good: 86_400, easy: 345_600 },
});

const counts = (fresh: number, learning: number, review: number): ReviewCounts => ({
  new: fresh,
  learning,
  review,
});

const answer = (value: AnnotationReviewCard | null, answerCounts?: ReviewCounts): ReviewFetch => ({
  _tag: "answer",
  card: value,
  counts: answerCounts,
});

/** Lets the callbacks of every promise already settled run (the session chains a few). */
async function settle() {
  for (let hop = 0; hop < 30; hop += 1) await Promise.resolve();
}

interface Delivery {
  readonly item: AnnotationReviewItem;
  readonly resolve: (taken: boolean) => void;
}

/**
 * A session whose server answers `answers` in order (then nothing to review). Graded items wait in `deliveries` until
 * the test resolves them, unless `autoDeliver`; the wait for them ends when the test calls `timeUp`.
 */
function harness(answers: Array<ReviewFetch | Error> = [], autoDeliver = true) {
  let mono = 1000;
  const requests: Array<{ exclude: ReadonlyArray<string>; more: boolean }> = [];
  const emitted: AnnotationReviewItem[] = [];
  const deliveries: Delivery[] = [];
  const badge: ReviewCounts[] = [];
  const released: string[] = [];
  const sleeps: Array<() => void> = [];
  let next = 0;
  const session = createReviewSession({
    fetchNext: async (request) => {
      requests.push({ exclude: [...request.exclude], more: request.more });
      const reply = answers[next++] ?? answer(null);
      if (reply instanceof Error) throw reply;
      return reply;
    },
    emit: (item) => {
      emitted.push(item);
      if (item.grade === undefined || autoDeliver) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => deliveries.push({ item, resolve }));
    },
    sleep: () => new Promise<void>((resolve) => sleeps.push(resolve)),
    release: (cardId) => released.push(cardId),
    monotonicNow: () => mono,
    wallNow: () => WALL + mono,
    uid: () => `u${emitted.length + 1}`,
    onCounts: (value) => badge.push(value),
  });
  const view = () => session.getView();
  return {
    session,
    requests,
    emitted,
    deliveries,
    badge,
    released,
    view,
    /** The wait for every grade so far runs out. */
    timeUp: () => {
      for (const wake of sleeps.splice(0)) wake();
    },
    tick: (ms: number) => {
      mono += ms;
    },
    /** The card on screen, after its enter animation; fails the test when there is none. */
    shown: () => {
      const current = view();
      if (current._tag !== "card") throw new Error(`no card: ${current._tag}`);
      session.cardShown(current.showing);
      return current.card;
    },
  };
}

describe("review session", () => {
  it("shows the first card with its counts and prefetches the next, excluding the card it holds", async () => {
    const h = harness([answer(card(1), counts(5, 1, 10)), answer(card(2), counts(5, 1, 10))]);
    h.session.start();
    expect(h.view()._tag).toBe("loading");
    await settle();
    expect(h.view()).toMatchObject({ _tag: "card", card: card(1), shown: false });
    expect(h.view().counts).toEqual(counts(5, 1, 10));
    expect(h.requests).toEqual([
      { exclude: [], more: false },
      { exclude: ["c1"], more: false },
    ]);
  });

  it("reports a grade with the reveal and grade times, once, and only after a reveal", async () => {
    const h = harness([answer(card(1)), answer(card(2))]);
    h.session.start();
    await settle();
    expect(h.session.grade(3)).toBe(false); // not on screen yet
    h.tick(250);
    h.shown();
    expect(h.session.grade(3)).toBe(false); // not revealed
    h.tick(1200);
    h.session.reveal();
    h.tick(800);
    h.session.reveal(); // counted once
    expect(h.view()).toMatchObject({ _tag: "card", revealed: true, graded: false });
    h.tick(500);
    expect(h.session.grade(1)).toBe(true);
    expect(h.session.grade(4)).toBe(false);
    expect(h.view()).toMatchObject({ _tag: "card", graded: true });
    expect(h.emitted).toEqual([
      {
        kind: "review",
        at: WALL + 1250,
        card: "c1",
        word: "語1",
        revealMs: 1200,
        shownMs: 2500,
        gradeMs: 2500,
        grade: 1,
        source: "mobile",
        uid: "u1",
      },
    ]);
    expect(() => decodeReport({ items: h.emitted })).not.toThrow();
  });

  it("shows the prefetched card at once after a grade, its queue's count one lower until the server answers", async () => {
    const h = harness(
      [
        answer(card(1, "new"), counts(5, 1, 10)),
        answer(card(2, "review"), counts(5, 1, 10)),
        answer(card(3, "review"), counts(4, 2, 10)),
      ],
      false,
    );
    h.session.start();
    await settle();
    h.shown();
    h.session.reveal();
    h.session.grade(3);
    expect(h.view().counts).toEqual(counts(4, 1, 10));
    h.session.next(); // the exit animation ended
    expect(h.view()).toMatchObject({ _tag: "card", card: card(2, "review") });
    await settle();
    // The following card is asked for only once the server has the grade.
    expect(h.requests).toHaveLength(2);
    h.deliveries[0]!.resolve(true);
    await settle();
    expect(h.requests.at(-1)).toEqual({ exclude: ["c2"], more: false });
    expect(h.view().counts).toEqual(counts(4, 2, 10));
    expect(h.badge.at(-1)).toEqual(counts(4, 2, 10));
  });

  it("does not move on from a card that has not been graded", async () => {
    const h = harness([answer(card(1)), answer(card(2))]);
    h.session.start();
    await settle();
    h.shown();
    h.session.reveal();
    h.session.next();
    expect(h.view()).toMatchObject({ _tag: "card", card: card(1) });
    expect(h.emitted).toEqual([]);
  });

  it("asks again after the grade when the prefetch had no card, so a card due again comes back", async () => {
    const h = harness([
      answer(card(1, "learning"), counts(0, 1, 0)),
      answer(null, counts(0, 1, 0)), // the prefetch: only c1 is due, and the client holds it
      answer(card(1, "learning"), counts(0, 1, 0)), // Again: due in a minute, within learn-ahead
    ]);
    h.session.start();
    await settle();
    h.shown();
    h.session.reveal();
    h.session.grade(1);
    h.session.next();
    await settle();
    expect(h.view()).toMatchObject({ _tag: "card", card: card(1, "learning"), showing: 2 });
    expect(h.requests.map((request) => request.exclude)).toEqual([[], ["c1"], [], ["c1"]]);
  });

  it("excludes a graded card until its report lands, however late, and waits for that only so long", async () => {
    const h = harness([answer(card(1)), answer(card(2)), answer(card(3))], false);
    h.session.start();
    await settle();
    h.shown();
    h.session.reveal();
    h.session.grade(2);
    h.session.next();
    await settle();
    expect(h.requests).toHaveLength(2); // the next card waits for the grade
    h.timeUp();
    await settle();
    expect(h.requests.at(-1)?.exclude).toEqual(["c2", "c1"]);
    h.deliveries[0]!.resolve(true); // a retry got it through
    await settle();
    h.shown();
    h.session.reveal();
    h.session.grade(3);
    h.session.next();
    h.deliveries[1]!.resolve(false); // dropped unsent: the card is free to come back
    await settle();
    expect(h.requests.at(-1)?.exclude).toEqual(["c3"]);
  });

  it("counts an answer as knowing every grade made before it was asked for", async () => {
    const h = harness(
      [
        answer(card(1, "new"), counts(5, 0, 0)),
        answer(card(2, "new"), counts(5, 0, 0)),
        answer(card(3, "new"), counts(3, 0, 0)),
      ],
      false,
    );
    h.session.start();
    await settle();
    h.shown();
    h.session.reveal();
    h.session.grade(3);
    h.session.next(); // c2 at once; the request for c3 waits for c1's grade
    h.shown();
    h.session.reveal();
    h.session.grade(3); // made before that request goes
    h.deliveries[0]!.resolve(true);
    await settle();
    expect(h.requests).toHaveLength(3);
    expect(h.view().counts).toEqual(counts(3, 0, 0));
  });

  it("clamps the durations it reports to a day", async () => {
    const h = harness([answer(card(1))]);
    h.session.start();
    await settle();
    h.shown();
    h.tick(2 * 86_400_000);
    h.session.reveal();
    h.tick(1000);
    h.session.grade(4);
    expect(h.emitted[0]).toMatchObject({
      revealMs: 86_400_000,
      shownMs: 86_400_000,
      gradeMs: 86_400_000,
    });
    expect(() => decodeReport({ items: h.emitted })).not.toThrow();
  });

  it("releases cards served but never shown: the prefetched one and one closed before it was on screen", async () => {
    const h = harness([answer(card(1)), answer(card(2))]);
    h.session.start();
    await settle();
    h.session.close(); // c1 still sliding in, c2 prefetched
    await settle();
    expect(h.released).toEqual(["c1", "c2"]);
    expect(h.emitted).toEqual([]);
  });

  it("releases the card left unshown by the background, and nothing it showed", async () => {
    const h = harness([answer(card(1)), answer(card(2)), answer(card(3))]);
    h.session.start();
    await settle();
    h.session.suspend();
    h.session.resume();
    await settle();
    h.shown();
    h.session.close();
    await settle();
    expect(h.released).toEqual(["c1", "c3"]);
  });

  it("starts over when started again after close, as a remounted screen does", async () => {
    const h = harness([answer(card(1)), answer(card(2)), answer(card(3)), answer(card(4))]);
    h.session.start();
    await settle();
    h.session.close();
    h.session.start();
    await settle();
    expect(h.view()).toMatchObject({ _tag: "card", card: card(3) });
    h.shown();
    h.session.reveal();
    expect(h.session.grade(3)).toBe(true);
  });

  it("is done for the day when there is no card and nothing due, and reviews more on request", async () => {
    const h = harness([answer(null, counts(0, 0, 0)), answer(card(7, "new"), counts(3, 0, 0))]);
    h.session.start();
    await settle();
    expect(h.view()).toEqual({ _tag: "done", counts: counts(0, 0, 0) });
    h.session.more();
    await settle();
    expect(h.view()).toMatchObject({ _tag: "card", card: card(7, "new") });
    expect(h.requests.map((request) => request.more)).toEqual([false, true, true]);
  });

  it("waits when cards are due later, and asks again on next", async () => {
    const h = harness([answer(null, counts(0, 1, 0)), answer(card(1, "learning"))]);
    h.session.start();
    await settle();
    expect(h.view()._tag).toBe("waiting");
    h.session.more(); // only once the day is done
    h.session.next();
    await settle();
    expect(h.view()).toMatchObject({ _tag: "card", card: card(1, "learning") });
    expect(h.requests.map((request) => request.more)).toEqual([false, false, false]);
  });

  it("is done when an older server answers no card and no counts", async () => {
    const h = harness([answer(null)]);
    h.session.start();
    await settle();
    expect(h.view()).toEqual({ _tag: "done", counts: null });
  });

  it("reports a card left without a grade when the screen closes, once, and nothing after", async () => {
    const h = harness([answer(card(1)), answer(card(2))]);
    h.session.start();
    await settle();
    h.shown();
    h.tick(300);
    h.session.reveal();
    h.tick(400);
    h.session.close();
    h.session.close();
    h.session.next();
    h.session.reveal();
    expect(h.session.grade(3)).toBe(false);
    await settle();
    expect(h.emitted).toEqual([
      expect.objectContaining({ card: "c1", revealMs: 300, shownMs: 700 }),
    ]);
    expect(h.emitted[0]).not.toHaveProperty("grade");
    expect(h.view()._tag).toBe("closed");
    expect(() => decodeReport({ items: h.emitted })).not.toThrow();
  });

  it("reports nothing for a card that never got on screen", async () => {
    const h = harness([answer(card(1)), answer(card(2))]);
    h.session.start();
    await settle();
    h.session.close();
    expect(h.emitted).toEqual([]);
  });

  it("leaves the card ungraded when the app goes to the background and brings the next on return", async () => {
    const h = harness([answer(card(1)), answer(card(2)), answer(card(3))]);
    h.session.start();
    await settle();
    h.shown();
    h.tick(300);
    h.session.suspend();
    h.session.suspend();
    h.tick(60_000);
    h.session.reveal(); // a left card no longer counts
    expect(h.session.grade(3)).toBe(false);
    expect(h.emitted).toEqual([
      expect.objectContaining({ card: "c1", revealMs: null, shownMs: 300 }),
    ]);
    h.session.resume();
    await settle();
    expect(h.view()).toMatchObject({ _tag: "card", card: card(2) });
    h.session.close(); // the new card was never shown
    expect(h.emitted).toHaveLength(1);
  });

  it("asks again on return from the background when the day was done", async () => {
    const h = harness([answer(null, counts(0, 0, 0)), answer(card(1), counts(1, 0, 0))]);
    h.session.start();
    await settle();
    h.session.suspend();
    h.session.resume();
    await settle();
    expect(h.view()).toMatchObject({ _tag: "card", card: card(1) });
  });

  it("shows the short detail of an error, reports nothing, and asks again on next", async () => {
    const h = harness([{ _tag: "error", detail: "collector down" }, new Error("socket closed")]);
    h.session.start();
    await settle();
    expect(h.view()).toEqual({ _tag: "error", detail: "collector down", counts: null });
    h.session.next();
    await settle();
    expect(h.view()).toEqual({ _tag: "error", detail: "socket closed", counts: null });
    h.session.close();
    expect(h.emitted).toEqual([]);
  });

  it("asks again when the prefetch failed", async () => {
    const h = harness([answer(card(1)), { _tag: "error", detail: "timeout" }, answer(card(2))]);
    h.session.start();
    await settle();
    h.shown();
    h.session.reveal();
    h.session.grade(3);
    h.session.next();
    await settle();
    expect(h.view()).toMatchObject({ _tag: "card", card: card(2) });
    expect(h.requests.map((request) => request.exclude)).toEqual([[], ["c1"], [], ["c2"]]);
  });

  it("drops an answer that arrives after close, releasing its card", async () => {
    let release: (value: ReviewFetch) => void = () => undefined;
    const released: string[] = [];
    const session = createReviewSession({
      fetchNext: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      emit: () => undefined,
      sleep: () => Promise.resolve(),
      release: (cardId) => released.push(cardId),
      monotonicNow: () => 0,
      wallNow: () => WALL,
      uid: () => "u",
    });
    session.start();
    await settle();
    session.close();
    release(answer(card(1), counts(1, 0, 0)));
    await settle();
    expect(session.getView()).toEqual({ _tag: "closed", counts: null });
    expect(released).toEqual(["c1"]);
  });

  it("excludes at most 20 cards whose grades the server has not confirmed, the latest first", async () => {
    const h = harness(
      Array.from({ length: 25 }, (_, index) => answer(card(index + 1))),
      false,
    );
    h.session.start();
    await settle();
    for (let index = 0; index < 22; index += 1) {
      h.shown();
      h.session.reveal();
      h.session.grade(3);
      h.session.next();
      h.timeUp();
      await settle();
    }
    const last = h.requests.at(-1)!;
    expect(last.exclude).toHaveLength(REVIEW_EXCLUDE_MAX);
    expect(last.exclude[0]).toBe("c23");
    expect(new Set(h.emitted.map((item) => item.uid)).size).toBe(22);
  });
});

describe("createCardReleases", () => {
  it("hands each card over once, at most 20 a request, and takes back those of a failed request", () => {
    const releases = createCardReleases();
    for (let index = 1; index <= 22; index += 1) releases.add(`c${index}`);
    releases.add("c22");
    const taken = releases.take();
    expect(taken).toHaveLength(REVIEW_EXCLUDE_MAX);
    expect(taken.at(-1)).toBe("c22");
    expect(releases.take()).toEqual([]);
    releases.add("c30");
    releases.restore(["c21"]);
    expect(releases.take()).toEqual(["c21", "c30"]);
  });
});

describe("countsAfterGrades", () => {
  it("takes one card off each graded card's queue, never below zero", () => {
    expect(countsAfterGrades(counts(2, 0, 3), ["new", "learning", "review", undefined])).toEqual(
      counts(1, 0, 2),
    );
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

describe("fetchWithin", () => {
  const served = { id: "c9", ja: "mondai", kana: "", gloss: "problem" } as AnnotationReviewCard;

  it("gives up after its time, and releases a card that comes after it", async () => {
    vi.useFakeTimers();
    try {
      let answer!: (fetch: ReviewFetch) => void;
      const released: string[] = [];
      const fetched = fetchWithin(
        new Promise((resolve) => {
          answer = resolve;
        }),
        15_000,
        (id) => released.push(id),
      );
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(fetched).resolves.toEqual({ _tag: "error", detail: "The server took too long" });
      answer({ _tag: "answer", card: served });
      await vi.runAllTimersAsync();
      expect(released).toEqual(["c9"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands an answer in time on, releasing nothing", async () => {
    const released: string[] = [];
    const answer: ReviewFetch = { _tag: "answer", card: served };
    await expect(
      fetchWithin(Promise.resolve(answer), 15_000, (id) => released.push(id)),
    ).resolves.toBe(answer);
    expect(released).toEqual([]);
  });
});
