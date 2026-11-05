import type {
  AnnotationInteraction,
  AnnotationReviewCard,
  AnnotationReviewNextResult,
} from "@t3tools/contracts";

/** 1 Again, 2 Hard, 3 Good, 4 Easy. */
export type ReviewGrade = 1 | 2 | 3 | 4;
export type ReviewItem = Extract<AnnotationInteraction, { kind: "review" }>;
/** New cards left today, learning cards due now and review cards due today. */
export type ReviewCounts = NonNullable<AnnotationReviewNextResult["counts"]>;
/** The collector's answer, or why there is none. */
export type ReviewFetched = AnnotationReviewNextResult | { readonly detail: string };

export type ReviewView =
  | { readonly phase: "loading" }
  | {
      readonly phase: "card";
      readonly card: AnnotationReviewCard;
      readonly uid: string;
      readonly revealed: boolean;
    }
  /** Nothing due now, but a learning card comes back later today. */
  | { readonly phase: "waiting" }
  | { readonly phase: "done" }
  | { readonly phase: "error"; readonly detail: string };

export interface ReviewState {
  readonly view: ReviewView;
  readonly counts: ReviewCounts | null;
}

export const REVIEW_LOADING: ReviewState = { view: { phase: "loading" }, counts: null };

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;
const MONTH = YEAR / 12;

const tenths = (value: number) => String(Math.round(value * 10) / 10);

/** Anki's label above an answer button for `seconds` until the card comes back: `<1m`, `10m`, `3d`, `1.2mo`. */
export function intervalLabel(seconds: number): string {
  if (seconds < MINUTE) return "<1m";
  if (seconds < HOUR) return `${Math.round(seconds / MINUTE)}m`;
  if (seconds < DAY) return `${Math.round(seconds / HOUR)}h`;
  if (seconds < MONTH) return `${Math.round(seconds / DAY)}d`;
  if (seconds < YEAR) return `${tenths(seconds / MONTH)}mo`;
  return `${tenths(seconds / YEAR)}y`;
}

export function dueCount(counts: ReviewCounts | null): number {
  return counts ? counts.new + counts.learning + counts.review : 0;
}

/** The card on screen; `at` and `shownAt` are set once it is painted. */
interface Shown {
  readonly card: AnnotationReviewCard;
  readonly uid: string;
  at?: number;
  shownAt?: number;
  revealMs: number | null;
}

interface Request {
  /** How many cards were graded when it went out; the ones graded since are still in its counts. */
  graded: number;
  value?: ReviewFetched;
}

export interface ReviewSessionDeps {
  readonly fetchNext: (input: {
    readonly exclude: ReadonlyArray<string>;
    readonly more: boolean;
  }) => Promise<ReviewFetched>;
  readonly report: (item: ReviewItem) => Promise<unknown>;
  readonly onChange: (state: ReviewState) => void;
  readonly uid: () => string;
  /** Epoch ms, for when a card was shown. */
  readonly now: () => number;
  /** Monotonic ms, for how long it was shown. */
  readonly clock: () => number;
}

const WAITING_RETRY_MS = 30_000;

/**
 * One review panel's cards: shows one, reveals it, reports it graded or left, and shows the next, which it asks for
 * while the current one is shown (without it), once every grade before has reached the collector. Counts on screen are
 * the latest answer's, less the cards graded after it went out.
 */
export class ReviewSession {
  private readonly deps: ReviewSessionDeps;
  private view: ReviewView = REVIEW_LOADING.view;
  /** The latest counts the collector sent, and how many cards were graded when it was asked. */
  private base: { readonly counts: ReviewCounts; readonly graded: number } | null = null;
  private generation = 0;
  private shown: Shown | null = null;
  private request: Request | null = null;
  private readonly graded: Array<AnnotationReviewCard["queue"]> = [];
  private reports: Promise<unknown> = Promise.resolve();
  private more = false;
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: ReviewSessionDeps) {
    this.deps = deps;
  }

  /** Asks for a card and shows it. */
  start() {
    this.leave();
    this.update({ phase: "loading" });
    this.ask([]);
  }

  /** "Review more" once the day is done: new cards beyond today's limit, from now on. */
  reviewMore() {
    this.more = true;
    this.start();
  }

  /** Starts the card's timing at its first paint. */
  painted(uid: string) {
    const shown = this.shown;
    if (shown?.uid !== uid || shown.shownAt !== undefined) return;
    shown.shownAt = this.deps.clock();
    shown.at = this.deps.now();
  }

  reveal() {
    const shown = this.shown;
    const view = this.view;
    if (!shown || shown.revealMs !== null || view.phase !== "card") return;
    shown.revealMs =
      shown.shownAt === undefined ? 0 : Math.round(this.deps.clock() - shown.shownAt);
    this.update({ ...view, revealed: true });
  }

  /** Reports the revealed card with its grade and shows the next one. */
  grade(grade: ReviewGrade) {
    const shown = this.shown;
    if (!shown || shown.revealMs === null) return;
    this.painted(shown.uid);
    const shownAt = shown.shownAt ?? this.deps.clock();
    const gradeMs = Math.max(shown.revealMs, Math.round(this.deps.clock() - shownAt));
    this.send(shown, { grade, gradeMs });
    this.graded.push(shown.card.queue);
    this.shown = null;
    const request = this.request;
    const value = request?.value;
    if (request && value && "card" in value && value.card !== null) {
      this.request = null;
      this.present(value, request);
      return;
    }
    this.update({ phase: "loading" });
    // The answer still out may be a card; a null or an error from before this grade is asked again.
    if (!request || value) this.ask([]);
  }

  /** Reports the card on screen as left without a grade and drops what is still to come. */
  leave() {
    const shown = this.shown;
    this.shown = null;
    if (shown) this.send(shown);
    this.generation += 1;
    this.request = null;
    clearTimeout(this.retry);
  }

  private update(view: ReviewView) {
    this.view = view;
    this.deps.onChange({ view, counts: this.counts() });
  }

  /** The latest counts less the cards graded since they were asked for. */
  private counts(): ReviewCounts | null {
    if (!this.base) return null;
    const counts = { ...this.base.counts };
    for (const queue of this.graded.slice(this.base.graded)) {
      if (queue) counts[queue] = Math.max(0, counts[queue] - 1);
    }
    return counts;
  }

  private keepCounts(value: ReviewFetched, request: Request) {
    if ("counts" in value && value.counts) {
      this.base = { counts: value.counts, graded: request.graded };
    }
  }

  private send(shown: Shown, graded?: { readonly grade: ReviewGrade; readonly gradeMs: number }) {
    if (shown.at === undefined || shown.shownAt === undefined) return;
    const shownMs = graded
      ? graded.gradeMs
      : Math.max(0, Math.round(this.deps.clock() - shown.shownAt));
    const sent = this.deps.report({
      kind: "review",
      at: shown.at,
      card: shown.card.id,
      word: shown.card.ja,
      revealMs: shown.revealMs,
      shownMs,
      source: "desktop",
      uid: shown.uid,
      ...graded,
    });
    this.reports = Promise.allSettled([this.reports, sent]);
  }

  /** Every report sent so far has settled, so the collector knows each grade. */
  private async settled() {
    let reports;
    do {
      reports = this.reports;
      await reports;
    } while (reports !== this.reports);
  }

  private ask(exclude: ReadonlyArray<string>) {
    const generation = this.generation;
    const request: Request = { graded: this.graded.length };
    this.request = request;
    void this.settled().then(async () => {
      if (generation !== this.generation) return;
      request.graded = this.graded.length;
      const value = await this.deps
        .fetchNext({ exclude, more: this.more })
        .catch((): ReviewFetched => ({ detail: "request failed" }));
      if (generation !== this.generation || this.request !== request) return;
      request.value = value;
      this.answered(request, value);
    });
  }

  private answered(request: Request, value: ReviewFetched) {
    if (this.shown) {
      // The next card, kept for the grade; its counts are newer than those on screen.
      if ("counts" in value && value.counts) {
        this.keepCounts(value, request);
        this.update(this.view);
      }
      return;
    }
    this.request = null;
    if (!("card" in value && value.card !== null) && request.graded < this.graded.length) {
      this.ask([]);
      return;
    }
    this.present(value, request);
  }

  private present(value: ReviewFetched, request: Request) {
    if ("detail" in value) {
      this.update({ phase: "error", detail: value.detail });
      return;
    }
    this.keepCounts(value, request);
    if (value.card === null) {
      if (dueCount(this.counts()) === 0) {
        this.update({ phase: "done" });
        return;
      }
      this.update({ phase: "waiting" });
      this.retry = setTimeout(() => this.start(), WAITING_RETRY_MS);
      return;
    }
    const uid = this.deps.uid();
    this.shown = { card: value.card, uid, revealMs: null };
    this.update({ phase: "card", card: value.card, uid, revealed: false });
    this.ask([value.card.id]);
  }
}
