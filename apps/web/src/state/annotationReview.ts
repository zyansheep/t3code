import {
  AnnotationInteraction,
  AnnotationReportError,
  type AnnotationReviewNextResult,
  type EnvironmentId,
} from "@t3tools/contracts";
import { isTransportConnectionErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { nextAnnotationReview, reportAnnotationInteractions } from "./annotationInteractions";

const QUIET = { reportFailure: false, reportDefect: false } as const;
type ReviewCounts = NonNullable<AnnotationReviewNextResult["counts"]>;

/** Review cards due per environment (new, learning, review), from the collector's last answer: `null` until known. */
export const reviewCountsAtom = Atom.family((_environmentId: EnvironmentId) =>
  Atom.make<ReviewCounts | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel("annotation-review-counts"),
  ),
);

const MAX_RELEASE = 20;
/** Cards served to this client but never shown, per environment, to name in the next request. */
const unshown = new Map<EnvironmentId, Set<string>>();

/** Hands cards served but never shown back to the collector with the next request, so it can serve them again. */
export function releaseReviewCards(environmentId: EnvironmentId, ids: ReadonlyArray<string>): void {
  if (ids.length === 0) return;
  const pending = unshown.get(environmentId) ?? new Set<string>();
  for (const id of ids) pending.add(id);
  // The oldest go first once there are more than one request can name.
  for (const id of [...pending].slice(0, Math.max(0, pending.size - MAX_RELEASE))) {
    pending.delete(id);
  }
  unshown.set(environmentId, pending);
}

/**
 * Asks the collector for the next card through `environmentId`'s server, handing back the cards released since the
 * last answer; a `peek` asks for the counts alone.
 */
export async function fetchReviewCard(
  environmentId: EnvironmentId,
  input: {
    readonly exclude: ReadonlyArray<string>;
    readonly more: boolean;
    readonly peek?: boolean;
  },
): Promise<AnnotationReviewNextResult | { readonly detail: string }> {
  const release = [...(unshown.get(environmentId) ?? [])];
  const result = await runAtomCommand(
    appAtomRegistry,
    nextAnnotationReview,
    {
      environmentId,
      input: {
        source: "desktop",
        exclude: [...input.exclude],
        ...(input.more ? { more: true } : {}),
        ...(input.peek ? { peek: true } : {}),
        ...(release.length > 0 ? { release } : {}),
      },
    },
    QUIET,
  );
  if (result._tag === "Success") {
    const pending = unshown.get(environmentId);
    for (const id of release) pending?.delete(id);
    return result.value;
  }
  const error = squashAtomCommandFailure(result);
  return { detail: error instanceof Error && error.message ? error.message : "request failed" };
}

const isReportError = Schema.is(AnnotationReportError);
const decodeInteraction = Schema.decodeUnknownOption(AnnotationInteraction);

type ReviewItem = Extract<AnnotationInteraction, { kind: "review" }>;
type ReportOutcome = "stored" | "rejected" | "failed";
/** `error`: refused for some other reason than the collector's, which may never change; kept for a few tries. */
type SendOutcome = ReportOutcome | "error";
interface Queued {
  readonly item: ReviewItem;
  readonly queuedAt: number;
  /** Sends that ended in an `error`. */
  readonly errors: number;
}

const MAX_BATCH = 50;
const MAX_ERRORS = 5;
const OUTBOX_LIMIT = 200;
const OUTBOX_MAX_AGE_MS = 7 * 24 * 3_600_000;
const outboxKey = (environmentId: EnvironmentId) =>
  `t3code:annotation-review-outbox:v1:${environmentId}`;

/** Review reports not yet stored, kept across reloads: the newest 200 of the last 7 days. */
function readOutbox(environmentId: EnvironmentId): Queued[] {
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(outboxKey(environmentId)) ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const since = Date.now() - OUTBOX_MAX_AGE_MS;
  return raw
    .flatMap((entry: { item?: unknown; queuedAt?: unknown; errors?: unknown }) => {
      const item = Option.getOrUndefined(decodeInteraction(entry?.item));
      const queuedAt = entry?.queuedAt;
      const errors = typeof entry?.errors === "number" ? entry.errors : 0;
      return item?.kind === "review" && item.uid && typeof queuedAt === "number" && queuedAt > since
        ? [{ item, queuedAt, errors }]
        : [];
    })
    .slice(-OUTBOX_LIMIT);
}

function writeOutbox(environmentId: EnvironmentId, queued: ReadonlyArray<Queued>) {
  try {
    if (queued.length === 0) localStorage.removeItem(outboxKey(environmentId));
    else
      localStorage.setItem(outboxKey(environmentId), JSON.stringify(queued.slice(-OUTBOX_LIMIT)));
  } catch {
    // Storage full or blocked: the session still resends while the app is open.
  }
}

/**
 * Takes stored and rejected reports out of the outbox as it is in storage now (another window may have added some),
 * and counts an `error` against a report sent alone, dropping it after `MAX_ERRORS`.
 */
function settle(
  environmentId: EnvironmentId,
  items: ReadonlyArray<ReviewItem>,
  outcomes: ReadonlyArray<SendOutcome>,
) {
  const done = new Set(
    items.flatMap((item, index) =>
      outcomes[index] === "stored" || outcomes[index] === "rejected" ? [item.uid] : [],
    ),
  );
  const errored = new Set(items.length === 1 && outcomes[0] === "error" ? [items[0]!.uid] : []);
  if (done.size === 0 && errored.size === 0) return;
  writeOutbox(
    environmentId,
    readOutbox(environmentId).flatMap((queued) => {
      if (done.has(queued.item.uid)) return [];
      if (!errored.has(queued.item.uid)) return [queued];
      return queued.errors + 1 >= MAX_ERRORS ? [] : [{ ...queued, errors: queued.errors + 1 }];
    }),
  );
}

/** Sends review items in one report, settling each: stored, rejected for good, or failed and worth sending again. */
async function sendReviews(
  environmentId: EnvironmentId,
  items: ReadonlyArray<ReviewItem>,
): Promise<SendOutcome[]> {
  const result = await runAtomCommand(
    appAtomRegistry,
    reportAnnotationInteractions,
    { environmentId, input: { items: [...items] } },
    QUIET,
  );
  const outcomes = ((): SendOutcome[] => {
    if (result._tag === "Success") return items.map(() => "stored");
    if (isAtomCommandInterrupted(result)) return items.map(() => "failed");
    const error = squashAtomCommandFailure(result);
    if (!isReportError(error)) {
      // A dropped connection says nothing about the reports; any other refusal may be about one of them.
      const message = error instanceof Error ? error.message : String(error);
      return items.map(() => (isTransportConnectionErrorMessage(message) ? "failed" : "error"));
    }
    if (error.retryable) return items.map(() => "failed");
    const rejected = new Set(error.rejected?.map((reason) => reason.item));
    return items.map((_item, index) => (rejected.has(index) ? "rejected" : "stored"));
  })();
  settle(environmentId, items, outcomes);
  return outcomes;
}

/**
 * Sends one review item, kept in this environment's outbox until the collector stores or rejects it: `failed` when
 * it may not have arrived. The outbox's next flush sends it again under the same uid.
 */
export async function reportReview(
  environmentId: EnvironmentId,
  item: ReviewItem,
): Promise<ReportOutcome> {
  const queued = readOutbox(environmentId);
  if (!queued.some((entry) => entry.item.uid === item.uid)) {
    writeOutbox(environmentId, [...queued, { item, queuedAt: Date.now(), errors: 0 }]);
  }
  const [outcome] = await sendReviews(environmentId, [item]);
  return outcome === "stored" || outcome === "rejected" ? outcome : "failed";
}

const flushing = new Set<EnvironmentId>();

/**
 * Sends the review reports an earlier run could not, under their uids, a batch at a time as the outbox stands in
 * storage, until one may not have arrived. A batch refused for another reason goes again one report at a time, so
 * only the report at fault counts the refusal.
 */
export async function flushReviewOutbox(environmentId: EnvironmentId): Promise<void> {
  if (flushing.has(environmentId)) return;
  flushing.add(environmentId);
  const tried = new Set<string>();
  writeOutbox(environmentId, readOutbox(environmentId));
  try {
    while (true) {
      const batch = readOutbox(environmentId)
        .filter((queued) => !tried.has(queued.item.uid ?? ""))
        .slice(0, MAX_BATCH)
        .map((queued) => queued.item);
      if (batch.length === 0) return;
      for (const item of batch) tried.add(item.uid ?? "");
      const outcomes = await sendReviews(environmentId, batch);
      if (outcomes.includes("failed")) return;
      if (batch.length === 1 || !outcomes.includes("error")) continue;
      for (const item of batch) {
        const [outcome] = await sendReviews(environmentId, [item]);
        if (outcome === "failed") return;
      }
    }
  } finally {
    flushing.delete(environmentId);
  }
}

export function setReviewCounts(environmentId: EnvironmentId, counts: ReviewCounts | null): void {
  if (counts) appAtomRegistry.set(reviewCountsAtom(environmentId), counts);
}

const REFRESH_MS = 5 * 60_000;
const MIN_REFRESH_GAP_MS = 30_000;
let openPanels = 0;
const refreshes = new Map<EnvironmentId, { inFlight: boolean; attemptedAt: number }>();

/** While a review panel shows cards, its answers keep the counts and no refresh asks for them. */
export function holdReviewCounts(): () => void {
  openPanels += 1;
  return () => {
    openPanels -= 1;
  };
}

async function refreshReviewCounts(environmentId: EnvironmentId): Promise<void> {
  const refresh = refreshes.get(environmentId) ?? { inFlight: false, attemptedAt: 0 };
  refreshes.set(environmentId, refresh);
  if (openPanels > 0 || refresh.inFlight || Date.now() - refresh.attemptedAt < MIN_REFRESH_GAP_MS)
    return;
  refresh.inFlight = true;
  refresh.attemptedAt = Date.now();
  // A peek: a card asked for and dropped would count as served and be held back for a while.
  const answer = await fetchReviewCard(environmentId, { exclude: [], more: false, peek: true });
  refresh.inFlight = false;
  if ("counts" in answer && openPanels === 0) setReviewCounts(environmentId, answer.counts ?? null);
}

/**
 * Keeps `environmentId`'s due counts fresh, now, on window focus and every 5 minutes, sending the review reports an
 * earlier run could not each time.
 */
export function watchReviewCounts(environmentId: EnvironmentId): () => void {
  const refresh = () => {
    void flushReviewOutbox(environmentId);
    void refreshReviewCounts(environmentId);
  };
  refresh();
  window.addEventListener("focus", refresh);
  const interval = setInterval(refresh, REFRESH_MS);
  return () => {
    window.removeEventListener("focus", refresh);
    clearInterval(interval);
  };
}
