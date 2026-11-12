/**
 * The review screen without the view, as Anki runs it. Each card left sends one review item, graded or (left ungraded)
 * still due. The next card is asked for while this one is shown, but only once the server has every grade so far, so a
 * card due again within minutes can come back and the counts are current; on screen they drop at each grade meanwhile.
 */
import type {
  AnnotationQueuedInteraction,
  AnnotationReviewCard,
  AnnotationReviewNextResult,
} from "@t3tools/contracts";

export type AnnotationReviewItem = Extract<
  AnnotationQueuedInteraction,
  { readonly kind: "review" }
>;
export type ReviewGrade = NonNullable<AnnotationReviewItem["grade"]>;
export type ReviewCounts = NonNullable<AnnotationReviewNextResult["counts"]>;
type ReviewQueue = NonNullable<AnnotationReviewCard["queue"]>;

/** What the server answered (a card or none, with its counts when it sends them), or a short reason it could not. */
export type ReviewFetch =
  | {
      readonly _tag: "answer";
      readonly card: AnnotationReviewCard | null;
      readonly counts?: ReviewCounts | undefined;
      /** The new cards a day in effect, from a server that sends it. */
      readonly newPerDay?: number | undefined;
    }
  | { readonly _tag: "error"; readonly detail: string };

/**
 * What the view draws. `showing` numbers each time a card comes on screen; `shown` turns true once its enter animation
 * has ended, and only then do taps and swipes count. `done`: nothing left today; `waiting`: cards are due later, so the
 * view asks again in a while.
 */
export type ReviewPhase =
  | { readonly _tag: "loading" }
  | {
      readonly _tag: "card";
      readonly card: AnnotationReviewCard;
      readonly showing: number;
      readonly shown: boolean;
      readonly revealed: boolean;
      readonly graded: boolean;
    }
  | { readonly _tag: "done" }
  | { readonly _tag: "waiting" }
  | { readonly _tag: "error"; readonly detail: string }
  | { readonly _tag: "closed" };

/** The phase with the counts to show over it (null: the server sends none). */
export type ReviewView = ReviewPhase & { readonly counts: ReviewCounts | null };

export interface ReviewSessionOptions {
  /**
   * Never rejects: a failure comes back as `{ _tag: "error" }`. A `peek` asks for the counts alone, serving no card;
   * `newPerDay` sets the new cards a day first.
   */
  readonly fetchNext: (request: {
    readonly exclude: ReadonlyArray<string>;
    readonly more: boolean;
    readonly peek?: boolean;
    readonly newPerDay?: number;
  }) => Promise<ReviewFetch>;
  /**
   * Queues a review item for the server; must not throw into the view. For a graded item it settles once the item has
   * left the queue, however long its retries take: true when the server stored it, false when it was dropped.
   */
  readonly emit: (item: AnnotationReviewItem) => Promise<boolean> | void;
  /** Resolves after `ms`: how long the next card waits for a grade to land before it is asked for anyway. */
  readonly sleep: (ms: number) => Promise<void>;
  /** A card served to this client and dropped before it was shown, for the next request's `release`. */
  readonly release: (cardId: string) => void;
  /** A monotonic clock in ms (performance.now where there is one), for the durations. */
  readonly monotonicNow: () => number;
  /** Epoch ms, for `at`. */
  readonly wallNow: () => number;
  /** A fresh id per review item. */
  readonly uid: () => string;
  /** The counts the server last answered with, adjusted for grades since; for the badge elsewhere. */
  readonly onCounts?: (counts: ReviewCounts) => void;
}

/** The server takes at most 20 ids to exclude. */
export const REVIEW_EXCLUDE_MAX = 20;
/** How long the next card waits for the server to take a grade before it is asked for anyway. */
export const REVIEW_DELIVERY_WAIT_MS = 4_000;
/** The collector takes durations up to a day; a card left on screen longer counts as a day. */
const DURATION_MAX_MS = 86_400_000;
const DETAIL_MAX_LENGTH = 160;

interface Showing {
  readonly card: AnnotationReviewCard;
  readonly showing: number;
  shownAtMono: number | null;
  shownAtWall: number | null;
  revealedAtMono: number | null;
  graded: boolean;
  left: boolean;
}

interface Answer {
  readonly result: ReviewFetch;
  readonly sequence: number;
}

interface Prefetch {
  readonly promise: Promise<Answer>;
  answer: Answer | null;
}

const hasCard = (answer: Answer) => answer.result._tag === "answer" && answer.result.card !== null;

const duration = (from: number, to: number) =>
  Math.min(DURATION_MAX_MS, Math.max(0, Math.round(to - from)));

export const reviewCountsTotal = (counts: ReviewCounts) =>
  counts.new + counts.learning + counts.review;

/** `counts` with one card fewer in each queue graded since. */
export function countsAfterGrades(
  counts: ReviewCounts,
  queues: ReadonlyArray<ReviewQueue | undefined>,
): ReviewCounts {
  const next = { ...counts };
  for (const queue of queues) {
    if (queue !== undefined) next[queue] = Math.max(0, next[queue] - 1);
  }
  return next;
}

/**
 * A review fetch that gives up after `ms` with an error. An answer arriving later is dropped, but a card in it was
 * served all the same, so it goes to `release` for the next request: no served card is left unknown to the collector.
 */
export function fetchWithin(
  fetch: Promise<ReviewFetch>,
  ms: number,
  release: (cardId: string) => void,
): Promise<ReviewFetch> {
  let late = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ReviewFetch>((resolve) => {
    timer = setTimeout(() => {
      late = true;
      resolve({ _tag: "error", detail: "The server took too long" });
    }, ms);
  });
  const answered = fetch.then((answer) => {
    if (late && answer._tag === "answer" && answer.card) release(answer.card.id);
    return answer;
  });
  return Promise.race([answered, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Cards served to this client and dropped unshown, for the next request's `release`: at most 20 a request, the latest
 * kept when there are more; a request that failed puts its own back.
 */
export function createCardReleases() {
  let ids: ReadonlyArray<string> = [];
  const keep = (list: ReadonlyArray<string>) => [...new Set(list)].slice(-REVIEW_EXCLUDE_MAX);
  return {
    add(id: string) {
      ids = keep([...ids.filter((other) => other !== id), id]);
    },
    take(): ReadonlyArray<string> {
      const taken = ids;
      ids = [];
      return taken;
    },
    restore(taken: ReadonlyArray<string>) {
      ids = keep([...taken, ...ids]);
    },
  };
}

/** A short line for the view out of whatever a failed request gave. */
export function reviewFailureDetail(failure: unknown): string {
  let detail = "";
  if (typeof failure === "string") detail = failure;
  else if (typeof failure === "object" && failure !== null) {
    const { detail: own, message } = failure as { detail?: unknown; message?: unknown };
    if (typeof own === "string") detail = own;
    else if (typeof message === "string") detail = message;
  }
  detail = detail.replace(/\s+/g, " ").trim();
  if (detail.length === 0) return "Could not load a card";
  return detail.length > DETAIL_MAX_LENGTH ? `${detail.slice(0, DETAIL_MAX_LENGTH - 1)}…` : detail;
}

export function createReviewSession(options: ReviewSessionOptions) {
  let phase: ReviewPhase = { _tag: "loading" };
  let counts: ReviewCounts | null = null;
  let view: ReviewView = { ...phase, counts };
  const listeners = new Set<() => void>();
  let current: Showing | null = null;
  let prefetch: Prefetch | null = null;
  /** Cards graded whose grade the server may not have yet, the latest first: they are not to be served again. */
  let undelivered: ReadonlyArray<string> = [];
  /** Settles once the server has every grade so far, or the wait for each has run out. */
  let delivered: Promise<void> = Promise.resolve();
  /** The queue of each card graded, in order, for the counts. */
  const gradedQueues: Array<ReviewQueue | undefined> = [];
  let showings = 0;
  /** Bumped per request whose answer the view waits for; an older answer is dropped. */
  let request = 0;
  let asked = 0;
  let countsFrom = 0;
  /** "Review more": today's limit on new cards no longer holds for this session. */
  let more = false;
  let started = false;
  let closed = false;

  const publish = () => {
    view = { ...phase, counts };
    for (const listener of listeners) listener();
  };
  const setPhase = (next: ReviewPhase) => {
    phase = next;
    publish();
  };
  const setCounts = (next: ReviewCounts) => {
    counts = next;
    options.onCounts?.(next);
  };

  const exclude = () => {
    const held = current !== null && !current.left ? [current.card.id] : [];
    return [...new Set([...held, ...undelivered])].slice(0, REVIEW_EXCLUDE_MAX);
  };

  /** Asks the server once every grade so far has reached it; what to exclude is read when it asks. */
  const ask = (setting?: { readonly peek: true; readonly newPerDay: number }): Promise<Answer> =>
    delivered.then(() => {
      asked += 1;
      const sequence = asked;
      // Grades made from here on are news to this answer; earlier ones the server has, or will have, counted.
      const gradesBefore = gradedQueues.length;
      let promise: Promise<ReviewFetch>;
      try {
        promise = options.fetchNext({ exclude: exclude(), more, ...setting });
      } catch (error) {
        promise = Promise.resolve({ _tag: "error", detail: reviewFailureDetail(error) });
      }
      return promise
        .catch((error: unknown): ReviewFetch => ({
          _tag: "error",
          detail: reviewFailureDetail(error),
        }))
        .then((result) => {
          // The newest answer's counts, less the grades it did not know of, go on screen at once.
          if (!closed && result._tag === "answer" && result.counts && sequence > countsFrom) {
            countsFrom = sequence;
            setCounts(countsAfterGrades(result.counts, gradedQueues.slice(gradesBefore)));
            publish();
          }
          return { result, sequence };
        });
    });

  /** A card served and dropped before it was on screen: free for the server to serve again. */
  const drop = (answer: Answer) => {
    if (answer.result._tag === "answer" && answer.result.card !== null) {
      options.release(answer.result.card.id);
    }
  };

  const startPrefetch = () => {
    const entry: Prefetch = { promise: ask(), answer: null };
    void entry.promise.then((answer) => {
      entry.answer = answer;
    });
    prefetch = entry;
  };

  const apply = ({ result }: Answer) => {
    if (result._tag === "error") return setPhase({ _tag: "error", detail: result.detail });
    if (result.card === null) {
      const due = result.counts === undefined ? 0 : reviewCountsTotal(result.counts);
      return setPhase({ _tag: due > 0 ? "waiting" : "done" });
    }
    showings += 1;
    current = {
      card: result.card,
      showing: showings,
      shownAtMono: null,
      shownAtWall: null,
      revealedAtMono: null,
      graded: false,
      left: false,
    };
    setPhase(cardPhase(current));
    startPrefetch();
  };

  const cardPhase = (card: Showing): ReviewPhase => ({
    _tag: "card",
    card: card.card,
    showing: card.showing,
    shown: card.shownAtMono !== null,
    revealed: card.revealedAtMono !== null,
    graded: card.graded,
  });

  const load = (promise: Promise<Answer>) => {
    request += 1;
    const mine = request;
    setPhase({ _tag: "loading" });
    void promise.then((answer) => {
      if (closed || mine !== request) return drop(answer);
      apply(answer);
    });
  };

  const emit = (item: AnnotationReviewItem): Promise<boolean> => {
    try {
      return Promise.resolve(options.emit(item)).then(
        (taken) => taken === true,
        () => false,
      );
    } catch {
      // The review goes on; a lost report must not reach the view.
      return Promise.resolve(false);
    }
  };

  const item = (showing: Showing, now: number): AnnotationReviewItem | null => {
    if (showing.shownAtMono === null || showing.shownAtWall === null) return null;
    return {
      kind: "review",
      at: showing.shownAtWall,
      card: showing.card.id,
      word: showing.card.ja,
      revealMs:
        showing.revealedAtMono === null
          ? null
          : duration(showing.shownAtMono, showing.revealedAtMono),
      shownMs: duration(showing.shownAtMono, now),
      source: "mobile",
      uid: options.uid(),
    };
  };

  /** Ends the current showing without a grade: one review item if it got on screen, else its card is released. */
  const leave = () => {
    const showing = current;
    if (showing === null || showing.left) return;
    showing.left = true;
    const left = item(showing, options.monotonicNow());
    if (left !== null) void emit(left);
    else options.release(showing.card.id);
  };

  /**
   * Brings in the following card: the prefetched one unless it failed or had none, which is asked again now that the
   * server has the last grade (the card just graded may be due again already).
   */
  const advance = () => {
    const ready = prefetch;
    prefetch = null;
    current = null;
    if (ready?.answer && hasCard(ready.answer)) {
      request += 1;
      return apply(ready.answer);
    }
    load(
      ready === null ? ask() : ready.promise.then((answer) => (hasCard(answer) ? answer : ask())),
    );
  };

  return {
    getView: (): ReviewView => view,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Asks for the first card; after close(), starts over (a remounted screen reuses its session). */
    start() {
      if (started && !closed) return;
      if (closed) {
        closed = false;
        current = null;
        more = false;
        // Answers to the closed run's requests are dropped, and their counts too.
        countsFrom = asked;
      }
      started = true;
      load(ask());
    },
    /** The card of `showing` is on screen, its enter animation over: its clock starts now, once. */
    cardShown(showing: number) {
      const card = current;
      if (closed || card === null || card.showing !== showing || card.left) return;
      if (card.shownAtMono !== null) return;
      card.shownAtMono = options.monotonicNow();
      card.shownAtWall = options.wallNow();
      setPhase(cardPhase(card));
    },
    /** A tap or the reveal swipe: counted once, and only for a card already on screen. */
    reveal() {
      const card = current;
      if (closed || card === null || card.left || card.shownAtMono === null) return;
      if (card.revealedAtMono !== null) return;
      card.revealedAtMono = options.monotonicNow();
      setPhase(cardPhase(card));
    },
    /**
     * A grade for the revealed card, reported now, before its exit animation; false when there is no revealed card on
     * screen to grade. The view calls next() once the card has gone.
     */
    grade(grade: ReviewGrade): boolean {
      const card = current;
      if (closed || card === null || card.left || card.revealedAtMono === null) return false;
      const report = item(card, options.monotonicNow());
      if (report === null) return false;
      card.left = true;
      card.graded = true;
      gradedQueues.push(card.card.queue);
      if (counts !== null) setCounts(countsAfterGrades(counts, [card.card.queue]));
      const id = card.card.id;
      undelivered = [id, ...undelivered.filter((other) => other !== id)];
      // The card leaves at its grade, so it was on screen exactly that long.
      // Excluded until its report leaves the queue, however late; the next card waits for that only so long.
      const settled = emit({ ...report, grade, gradeMs: report.shownMs }).then(() => {
        undelivered = undelivered.filter((other) => other !== id);
      });
      const waited = Promise.race([settled, options.sleep(REVIEW_DELIVERY_WAIT_MS)]);
      delivered = Promise.all([delivered, waited]).then(() => undefined);
      setPhase(cardPhase(card));
      return true;
    },
    /** After a graded card's exit: the next card. From an error or "due later", asks again. */
    next() {
      if (closed || !started) return;
      if (phase._tag === "error" || phase._tag === "waiting") return load(ask());
      if (phase._tag !== "card" || current === null || !current.graded) return;
      advance();
    },
    /**
     * Sets the new cards a day once the server has every grade so far, with a peek whose counts go on screen; resolves
     * with why it failed, or null. What the old limit decided is asked again: the next card for the one on screen, or
     * the card the screen waits for (a day that was done may have new cards now).
     */
    setNewPerDay(newPerDay: number): Promise<string | null> {
      if (closed || !started) return Promise.resolve("The review is closed");
      return ask({ peek: true, newPerDay }).then(({ result }) => {
        if (result._tag === "error") return result.detail;
        if (closed) return null;
        if (phase._tag !== "card") {
          load(ask());
          return null;
        }
        const dropped = prefetch;
        if (dropped !== null) void dropped.promise.then(drop);
        startPrefetch();
        return null;
      });
    },
    /** "Review more" once the day is done: new cards past today's limit, for the rest of the session. */
    more() {
      if (closed || !started || phase._tag !== "done") return;
      more = true;
      load(ask());
    },
    /** The app went to the background: the card is left ungraded, and comes in again on return. */
    suspend() {
      if (!closed) leave();
    },
    /** Back from the background: a card left meanwhile gives way to the next, and an empty day is asked again. */
    resume() {
      if (closed || !started) return;
      if (phase._tag === "done" || phase._tag === "waiting" || phase._tag === "error") {
        return load(ask());
      }
      if (current !== null && current.left && !current.graded) advance();
    },
    /** The screen closed (Back, unmount): leaves the card ungraded; the session ends. */
    close() {
      if (closed) return;
      leave();
      closed = true;
      const dropped = prefetch;
      prefetch = null;
      if (dropped !== null) void dropped.promise.then(drop);
      setPhase({ _tag: "closed" });
    },
  };
}

export type ReviewSession = ReturnType<typeof createReviewSession>;
