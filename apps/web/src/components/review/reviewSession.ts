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
  /** `failed`: it may not have arrived, and is sent again under the same uid. */
  readonly report: (item: ReviewItem) => Promise<"stored" | "rejected" | "failed">;
  /** Cards the collector served that were never shown, to hand back. */
  readonly release: (ids: ReadonlyArray<string>) => void;
  readonly onChange: (state: ReviewState) => void;
  readonly uid: () => string;
  /** Epoch ms, for when a card was shown. */
  readonly now: () => number;
  /** Monotonic ms, for how long it was shown. */
  readonly clock: () => number;
}

const WAITING_RETRY_MS = 30_000;
const MAX_EXCLUDE = 20;
// The collector refuses longer times; a card left on screen overnight counts as a day.
const MAX_REPORTED_MS = 86_400_000;
const reportedMs = (ms: number) => Math.min(MAX_REPORTED_MS, ms);
/** Waits between resends of a review report: 1 s, doubling to a minute. */
const reportRetryDelay = (attempt: number) => Math.min(60_000, 1_000 * 2 ** attempt);

/**
 * One review panel's cards: shows one, reports it graded or left, and asks for the next while it is shown, once earlier
 * reports have had a first answer. A report that may not have arrived is resent under its uid until stored, its card
 * excluded meanwhile; cards served but never shown are released. Counts are the latest answer's, less later grades.
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
  /** Graded cards whose report the collector does not have yet. */
  private readonly unstored = new Set<string>();
  private more = false;
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: ReviewSessionDeps) {
    this.deps = deps;
  }

  /** Asks for a card and shows it. */
  start() {
    this.leave();
    this.update({ phase: "loading" });
    this.ask();
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
    if (!request || value) this.ask();
  }

  /**
   * Reports the card on screen as left without a grade and drops what is still to come, releasing a card the collector
   * served that was never shown (an answer still out is released when it comes).
   */
  leave() {
    const shown = this.shown;
    this.shown = null;
    if (shown?.at !== undefined) this.send(shown);
    else if (shown) this.deps.release([shown.card.id]);
    const value = this.request?.value;
    if (value && "card" in value && value.card) this.deps.release([value.card.id]);
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
    const item: ReviewItem = {
      kind: "review",
      at: shown.at,
      card: shown.card.id,
      word: shown.card.ja,
      revealMs: shown.revealMs === null ? null : reportedMs(shown.revealMs),
      shownMs: reportedMs(shownMs),
      source: "desktop",
      uid: shown.uid,
      ...(graded ? { grade: graded.grade, gradeMs: reportedMs(graded.gradeMs) } : {}),
    };
    this.reports = Promise.allSettled([this.reports, this.deliver(item, 0)]);
  }

  /** Sends `item`, and again after a while for as long as it may not have arrived; settles on the first answer. */
  private async deliver(item: ReviewItem, attempt: number): Promise<void> {
    const outcome = await this.deps.report(item).catch(() => "failed" as const);
    if (outcome !== "failed") {
      this.unstored.delete(item.card);
      return;
    }
    if (item.grade !== undefined) this.unstored.add(item.card);
    setTimeout(() => void this.deliver(item, attempt + 1), reportRetryDelay(attempt));
  }

  /** Every report sent so far has settled, so the collector knows each grade. */
  private async settled() {
    let reports;
    do {
      reports = this.reports;
      await reports;
    } while (reports !== this.reports);
  }

  /** Asks for a card once earlier reports have had their first answer, excluding the cards held then. */
  private ask() {
    const generation = this.generation;
    const request: Request = { graded: this.graded.length };
    this.request = request;
    void this.settled().then(async () => {
      if (generation !== this.generation) return;
      request.graded = this.graded.length;
      const held = new Set([...(this.shown ? [this.shown.card.id] : []), ...this.unstored]);
      const value = await this.deps
        .fetchNext({ exclude: [...held].slice(0, MAX_EXCLUDE), more: this.more })
        .catch((): ReviewFetched => ({ detail: "request failed" }));
      if (generation !== this.generation || this.request !== request) {
        if ("card" in value && value.card) this.deps.release([value.card.id]);
        return;
      }
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
      this.ask();
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
    this.ask();
  }
}
