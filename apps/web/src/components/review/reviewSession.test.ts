import type { AnnotationReviewCard } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  intervalLabel,
  type ReviewCounts,
  type ReviewFetched,
  type ReviewItem,
  ReviewSession,
  type ReviewState,
} from "./reviewSession";

const DAY = 86_400;

describe("intervalLabel", () => {
  it("prints Anki's labels: minutes, hours, days, then months and years to a tenth", () => {
    expect(intervalLabel(0)).toBe("<1m");
    expect(intervalLabel(59)).toBe("<1m");
    expect(intervalLabel(60)).toBe("1m");
    expect(intervalLabel(600)).toBe("10m");
    expect(intervalLabel(3_600)).toBe("1h");
    expect(intervalLabel(5 * 3_600)).toBe("5h");
    expect(intervalLabel(DAY)).toBe("1d");
    expect(intervalLabel(3 * DAY)).toBe("3d");
    expect(intervalLabel(30 * DAY)).toBe("30d");
    expect(intervalLabel(365 * DAY * (1 / 12))).toBe("1mo");
    expect(intervalLabel(36 * DAY)).toBe("1.2mo");
    expect(intervalLabel(364 * DAY)).toBe("12mo");
    expect(intervalLabel(365 * DAY)).toBe("1y");
    expect(intervalLabel(2.1 * 365 * DAY)).toBe("2.1y");
  });
});

const EPOCH = 1_800_000_000_000;
const INTERVALS = { again: 60, hard: 360, good: DAY, easy: 4 * DAY };
const A = {
  id: "a",
  ja: "問題",
  kana: "もんだい",
  gloss: "problem",
  queue: "new",
  intervals: INTERVALS,
} satisfies AnnotationReviewCard;
const B = {
  ...A,
  id: "b",
  ja: "会社",
  kana: "かいしゃ",
  gloss: "company",
  queue: "review",
} as const;
const COUNTS = { new: 2, learning: 0, review: 1 } satisfies ReviewCounts;

interface Ask {
  readonly input: { readonly exclude: ReadonlyArray<string>; readonly more: boolean };
  readonly answer: (value: ReviewFetched) => void;
}

type Outcome = "stored" | "rejected" | "failed";

/**
 * A session against a fake collector whose answers the test gives, on a clock it moves. Reports are stored at once
 * (or with the next of `outcomes`), or with `holdReports` when the test lands them.
 */
function harness(options: { holdReports?: boolean; outcomes?: Outcome[] } = {}) {
  const asks: Ask[] = [];
  const askWaiters = new Map<number, (ask: Ask) => void>();
  const reports: ReviewItem[] = [];
  const released: string[] = [];
  const landed: Array<(outcome?: Outcome) => void> = [];
  const events: string[] = [];
  let state: ReviewState | null = null;
  const changeWaiters: Array<(state: ReviewState) => void> = [];
  let time = 0;
  let uids = 0;
  const session = new ReviewSession({
    fetchNext: (input) =>
      new Promise<ReviewFetched>((answer) => {
        events.push("ask");
        const ask = { input, answer };
        askWaiters.get(asks.length)?.(ask);
        asks.push(ask);
      }),
    report: (item) => {
      reports.push(item);
      if (!options.holdReports) return Promise.resolve(options.outcomes?.shift() ?? "stored");
      return new Promise<Outcome>((resolve) =>
        landed.push((outcome = "stored") => {
          events.push("landed");
          resolve(outcome);
        }),
      );
    },
    release: (ids) => released.push(...ids),
    onChange: (next) => {
      state = next;
      for (const waiter of changeWaiters.splice(0)) waiter(next);
    },
    uid: () => `uid-${++uids}`,
    now: () => EPOCH + time,
    clock: () => time,
  });
  return {
    session,
    reports,
    released,
    landed,
    events,
    state: () => state!,
    /** The `index`th request to the collector, once it is made. */
    ask: (index: number) =>
      asks[index]
        ? Promise.resolve(asks[index])
        : new Promise<Ask>((resolve) => askWaiters.set(index, resolve)),
    /** Answers `ask` and waits for what the session shows next. */
    answer: (ask: Ask, value: ReviewFetched) => {
      const changed = new Promise<ReviewState>((resolve) => changeWaiters.push(resolve));
      ask.answer(value);
      return changed;
    },
    advance: (ms: number) => {
      time += ms;
    },
  };
}

/** Starts a session and shows `card`, painted at the session's time 0. */
async function showFirst(h: ReturnType<typeof harness>, card: AnnotationReviewCard = A) {
  h.session.start();
  const shown = await h.answer(await h.ask(0), { card, counts: COUNTS });
  if (shown.view.phase === "card") h.session.painted(shown.view.uid);
  return shown;
}

describe("ReviewSession", () => {
  it("shows a card, asks for the next one without it, and reveals on request", async () => {
    const h = harness();
    h.session.start();
    expect(h.state().view).toEqual({ phase: "loading" });
    const first = await h.ask(0);
    expect(first.input).toEqual({ exclude: [], more: false });

    const shown = await h.answer(first, { card: A, counts: COUNTS });
    expect(shown).toEqual({
      view: { phase: "card", card: A, uid: "uid-1", revealed: false },
      counts: COUNTS,
    });
    expect((await h.ask(1)).input).toEqual({ exclude: ["a"], more: false });

    h.session.reveal();
    expect(h.state().view).toMatchObject({ phase: "card", revealed: true });
    expect(h.reports).toEqual([]);
  });

  it("reports a graded card once with its timing, shows the next at once and asks again once the grade lands", async () => {
    const h = harness({ holdReports: true });
    await showFirst(h);
    // Asked while the first card was shown, so its counts still have it.
    await h.answer(await h.ask(1), { card: B, counts: { new: 2, learning: 0, review: 1 } });
    h.advance(1_500);
    h.session.reveal();
    h.advance(500);
    h.session.grade(3);

    expect(h.reports).toEqual([
      {
        kind: "review",
        at: EPOCH,
        card: "a",
        word: "問題",
        revealMs: 1_500,
        shownMs: 2_000,
        source: "desktop",
        uid: "uid-1",
        grade: 3,
        gradeMs: 2_000,
      },
    ]);
    expect(h.state()).toEqual({
      view: { phase: "card", card: B, uid: "uid-2", revealed: false },
      counts: { new: 1, learning: 0, review: 1 },
    });

    h.landed[0]!();
    expect((await h.ask(2)).input).toEqual({ exclude: ["b"], more: false });
    expect(h.events).toEqual(["ask", "ask", "landed", "ask"]);
    // A grade needs the meaning revealed.
    h.session.grade(4);
    expect(h.reports).toHaveLength(1);
  });

  it("asks again after a grade when the answer it had was no card", async () => {
    const h = harness();
    await showFirst(h);
    await h.answer(await h.ask(1), { card: null, counts: { new: 1, learning: 0, review: 0 } });
    h.session.reveal();
    h.session.grade(1);
    expect(h.state()).toEqual({
      view: { phase: "loading" },
      counts: { new: 0, learning: 0, review: 0 },
    });

    // Again put the card back in learning.
    const again = await h.answer(await h.ask(2), {
      card: { ...A, queue: "learning" },
      counts: { new: 0, learning: 1, review: 0 },
    });
    expect(again.view).toMatchObject({ phase: "card", card: { id: "a", queue: "learning" } });
    expect(again.counts).toEqual({ new: 0, learning: 1, review: 0 });
  });

  it("reports a card left on screen without a grade and drops the answers still to come", async () => {
    const h = harness();
    await showFirst(h);
    const prefetch = await h.ask(1);
    h.advance(700);
    h.session.leave();
    expect(h.reports).toEqual([
      {
        kind: "review",
        at: EPOCH,
        card: "a",
        word: "問題",
        revealMs: null,
        shownMs: 700,
        source: "desktop",
        uid: "uid-1",
      },
    ]);
    // The next card, still on its way, was served but will never be shown: it is handed back.
    prefetch.answer({ card: B, counts: COUNTS });
    await vi.waitFor(() => expect(h.released).toEqual(["b"]));

    h.session.start();
    expect((await h.ask(2)).input).toEqual({ exclude: [], more: false });
    expect(h.state().view).toEqual({ phase: "loading" });
    // A card never painted was never seen, so leaving it reports nothing and hands it back, with the next one.
    await h.answer(await h.ask(2), { card: B, counts: COUNTS });
    await h.answer(await h.ask(3), { card: A, counts: COUNTS });
    h.session.leave();
    expect(h.reports).toHaveLength(1);
    expect(h.released).toEqual(["b", "b", "a"]);
  });

  it("caps the times it reports at a day", async () => {
    const h = harness();
    await showFirst(h);
    h.advance(30 * 3_600_000);
    h.session.reveal();
    h.advance(3 * 3_600_000);
    h.session.grade(2);
    expect(h.reports[0]).toMatchObject({
      revealMs: 86_400_000,
      shownMs: 86_400_000,
      gradeMs: 86_400_000,
    });
  });

  it("sends a grade that may not have arrived again, under its uid, excluding its card until it is stored", async () => {
    using _timers = fakeTimers();
    const h = harness({ outcomes: ["failed", "failed", "stored"] });
    await showFirst(h);
    await h.answer(await h.ask(1), { card: null, counts: COUNTS });
    h.session.reveal();
    h.session.grade(3);
    // The next card is asked for after the first answer, without the card whose grade is not stored.
    expect((await h.ask(2)).input).toEqual({ exclude: ["a"], more: false });
    expect(h.reports).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(h.reports).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.reports).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.reports).toHaveLength(3);
    expect(new Set(h.reports.map((item) => item.uid))).toEqual(new Set(["uid-1"]));
    expect(h.reports[2]).toEqual(h.reports[0]);

    // Stored now, so it is no longer held back, and nothing is sent again.
    await h.answer(await h.ask(2), { card: B, counts: COUNTS });
    expect((await h.ask(3)).input).toEqual({ exclude: ["b"], more: false });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.reports).toHaveLength(3);
  });

  it("does not send a rejected report again", async () => {
    using _timers = fakeTimers();
    const h = harness({ outcomes: ["rejected"] });
    await showFirst(h);
    h.session.reveal();
    h.session.grade(3);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.reports).toHaveLength(1);
    // The collector still has the card due, so it may serve it again.
    expect((await h.ask(1)).input).toEqual({ exclude: [], more: false });
  });

  it("works out which cards to exclude when the request goes out, not when it is made", async () => {
    const h = harness({ holdReports: true });
    await showFirst(h);
    await h.answer(await h.ask(1), { card: B, counts: COUNTS });
    h.session.reveal();
    h.session.grade(3);
    // B is on screen, and the request for the card after it waits for the first grade to land.
    const shownB = h.state().view;
    if (shownB.phase === "card") h.session.painted(shownB.uid);
    h.session.reveal();
    h.session.grade(4);
    h.landed[0]!();
    h.landed[1]!();
    // Made while B was on screen, but sent once B was graded and stored, so B is not held back.
    expect((await h.ask(2)).input).toEqual({ exclude: [], more: false });
  });

  it("is done when nothing is due, and Review more asks past the new-card limit from then on", async () => {
    const h = harness();
    h.session.start();
    const done = await h.answer(await h.ask(0), {
      card: null,
      counts: { new: 0, learning: 0, review: 0 },
    });
    expect(done.view).toEqual({ phase: "done" });

    h.session.reviewMore();
    const more = await h.ask(1);
    expect(more.input).toEqual({ exclude: [], more: true });
    await h.answer(more, { card: A, counts: { new: 0, learning: 0, review: 0 } });
    expect((await h.ask(2)).input).toEqual({ exclude: ["a"], more: true });
  });

  it("waits for a learning card due later and asks again after a while", async () => {
    using _timers = fakeTimers();
    const h = harness();
    h.session.start();
    const waiting = await h.answer(await h.ask(0), {
      card: null,
      counts: { new: 0, learning: 1, review: 0 },
    });
    expect(waiting.view).toEqual({ phase: "waiting" });
    vi.advanceTimersByTime(30_000);
    expect((await h.ask(1)).input).toEqual({ exclude: [], more: false });
  });

  it("shows the collector's error, and works with a collector that sends no counts or intervals", async () => {
    const h = harness();
    h.session.start();
    const failed = await h.answer(await h.ask(0), { detail: "collector unreachable" });
    expect(failed).toEqual({
      view: { phase: "error", detail: "collector unreachable" },
      counts: null,
    });

    h.session.start();
    const old = { id: "a", ja: "問題", kana: "もんだい", gloss: "problem" };
    const shown = await h.answer(await h.ask(1), { card: old });
    expect(shown).toEqual({
      view: { phase: "card", card: old, uid: "uid-1", revealed: false },
      counts: null,
    });
    (await h.ask(2)).answer({ card: null });
    h.session.reveal();
    h.session.grade(3);
    // A null answered before the grade is asked again.
    const done = await h.answer(await h.ask(3), { card: null });
    expect(done).toEqual({ view: { phase: "done" }, counts: null });
  });
});

function fakeTimers(): Disposable {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  return { [Symbol.dispose]: () => void vi.useRealTimers() };
}
