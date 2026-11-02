/**
 * The flashcards opened from a gloss's wedge, without the view: one card at a time from the server, the next one
 * fetched while this one is shown, and one review item per card left. The only measure is the time from the card being
 * on screen (its enter animation over) to the reveal swipe, or that the reader moved on without revealing; a tap means
 * nothing. A card that never got on screen, an error and "nothing to review" report nothing.
 */
import type { AnnotationInteraction, AnnotationReviewCard } from "@t3tools/contracts";

export type AnnotationReviewItem = Extract<AnnotationInteraction, { readonly kind: "review" }>;

/** What the server answered: a card, nothing to review, or a short reason it could not. */
export type ReviewFetch =
  | { readonly _tag: "card"; readonly card: AnnotationReviewCard }
  | { readonly _tag: "empty" }
  | { readonly _tag: "error"; readonly detail: string };

/**
 * What the view draws. `showing` numbers each time a card comes on screen, so the same card served twice is two
 * showings; `shown` turns true once its enter animation has ended, and only then do swipes count.
 */
export type ReviewView =
  | { readonly _tag: "loading" }
  | {
      readonly _tag: "card";
      readonly card: AnnotationReviewCard;
      readonly showing: number;
      readonly shown: boolean;
      readonly revealed: boolean;
    }
  | { readonly _tag: "empty" }
  | { readonly _tag: "error"; readonly detail: string }
  | { readonly _tag: "closed" };

export interface ReviewSessionOptions {
  /** Never rejects: a failure comes back as `{ _tag: "error" }`. */
  readonly fetchNext: (exclude: ReadonlyArray<string>) => Promise<ReviewFetch>;
  /** Queues a review item for the server; must not throw into the view. */
  readonly emit: (item: AnnotationReviewItem) => void;
  /** A monotonic clock in ms (performance.now where there is one), for the durations. */
  readonly monotonicNow: () => number;
  /** Epoch ms, for `at`. */
  readonly wallNow: () => number;
  /** A fresh id per review item. */
  readonly uid: () => string;
}

/** The server takes at most 20 ids to exclude. */
export const REVIEW_EXCLUDE_MAX = 20;
const DETAIL_MAX_LENGTH = 160;

interface Showing {
  readonly card: AnnotationReviewCard;
  readonly showing: number;
  shownAtMono: number | null;
  shownAtWall: number | null;
  revealedAtMono: number | null;
  left: boolean;
}

interface Prefetch {
  readonly promise: Promise<ReviewFetch>;
  result: ReviewFetch | null;
}

const duration = (from: number, to: number) => Math.max(0, Math.round(to - from));

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
  let view: ReviewView = { _tag: "loading" };
  const listeners = new Set<() => void>();
  let current: Showing | null = null;
  let prefetch: Prefetch | null = null;
  /** Card ids this session has shown, the latest first: the server is asked not to serve them again. */
  let seen: ReadonlyArray<string> = [];
  let showings = 0;
  /** Bumped per request whose answer the view waits for; an older answer is dropped. */
  let request = 0;
  let started = false;
  let closed = false;

  const setView = (next: ReviewView) => {
    view = next;
    for (const listener of listeners) listener();
  };

  const exclude = () => seen.slice(0, REVIEW_EXCLUDE_MAX);

  const fetchNext = (): Promise<ReviewFetch> => {
    let promise: Promise<ReviewFetch>;
    try {
      promise = options.fetchNext(exclude());
    } catch (error) {
      return Promise.resolve({ _tag: "error", detail: reviewFailureDetail(error) });
    }
    return promise.catch((error: unknown): ReviewFetch => ({
      _tag: "error",
      detail: reviewFailureDetail(error),
    }));
  };

  const startPrefetch = () => {
    const entry: Prefetch = { promise: fetchNext(), result: null };
    void entry.promise.then((result) => {
      entry.result = result;
    });
    prefetch = entry;
  };

  const apply = (result: ReviewFetch) => {
    if (result._tag === "empty") return setView({ _tag: "empty" });
    if (result._tag === "error") return setView({ _tag: "error", detail: result.detail });
    showings += 1;
    current = {
      card: result.card,
      showing: showings,
      shownAtMono: null,
      shownAtWall: null,
      revealedAtMono: null,
      left: false,
    };
    seen = [result.card.id, ...seen.filter((id) => id !== result.card.id)];
    setView({ _tag: "card", card: result.card, showing: showings, shown: false, revealed: false });
    startPrefetch();
  };

  const load = (promise: Promise<ReviewFetch>) => {
    request += 1;
    const mine = request;
    setView({ _tag: "loading" });
    void promise.then((result) => {
      if (closed || mine !== request) return;
      apply(result);
    });
  };

  /** Ends the current showing: one review item if it got on screen, nothing otherwise. */
  const leave = () => {
    const showing = current;
    if (showing === null || showing.left) return;
    showing.left = true;
    if (showing.shownAtMono === null || showing.shownAtWall === null) return;
    const now = options.monotonicNow();
    const item: AnnotationReviewItem = {
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
    try {
      options.emit(item);
    } catch {
      // The review goes on; a lost report must not reach the view.
    }
  };

  /** Brings in the following card: the prefetched one unless that failed, then a fresh request. */
  const advance = () => {
    const ready = prefetch;
    prefetch = null;
    current = null;
    if (ready !== null && ready.result?._tag !== "error") load(ready.promise);
    else load(fetchNext());
  };

  return {
    getView: (): ReviewView => view,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Asks for the first card. */
    start() {
      if (started || closed) return;
      started = true;
      load(fetchNext());
    },
    /** The card of `showing` is on screen, its enter animation over: its clock starts now, once. */
    cardShown(showing: number) {
      const card = current;
      if (closed || card === null || card.showing !== showing || card.left) return;
      if (card.shownAtMono !== null) return;
      card.shownAtMono = options.monotonicNow();
      card.shownAtWall = options.wallNow();
      setView({ _tag: "card", card: card.card, showing, shown: true, revealed: false });
    },
    /** The reveal swipe: counted once, and only for a card already on screen. */
    reveal() {
      const card = current;
      if (closed || card === null || card.left || card.shownAtMono === null) return;
      if (card.revealedAtMono !== null) return;
      card.revealedAtMono = options.monotonicNow();
      setView({
        _tag: "card",
        card: card.card,
        showing: card.showing,
        shown: true,
        revealed: true,
      });
    },
    /**
     * The card is going (swipe left released): reported now, before its exit animation. The view stays until next().
     */
    leave() {
      if (!closed) leave();
    },
    /** Swipe left: leaves the card, if any, and shows the next; from "nothing to review" or an error it asks again. */
    next() {
      if (closed || !started) return;
      if (view._tag === "loading") return;
      leave();
      advance();
    },
    /** The app went to the background: the card is left, and a fresh one comes in on return. */
    suspend() {
      if (!closed) leave();
    },
    resume() {
      if (closed || current === null || !current.left) return;
      advance();
    },
    /** Swipe down, the close button, Back or unmount: leaves the card; the session ends. */
    close() {
      if (closed) return;
      leave();
      closed = true;
      prefetch = null;
      setView({ _tag: "closed" });
    },
  };
}

export type ReviewSession = ReturnType<typeof createReviewSession>;
