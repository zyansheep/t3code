import {
  type AnnotationInteraction,
  AnnotationReportError,
  type AnnotationReviewNextResult,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
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

/**
 * Sends one review item: `stored` once the collector has it, `rejected` when it refused it (a resend would not help),
 * `failed` when it may not have arrived and can be sent again under the same uid.
 */
export async function reportReview(
  environmentId: EnvironmentId,
  item: Extract<AnnotationInteraction, { kind: "review" }>,
): Promise<"stored" | "rejected" | "failed"> {
  const result = await runAtomCommand(
    appAtomRegistry,
    reportAnnotationInteractions,
    { environmentId, input: { items: [item] } },
    QUIET,
  );
  if (result._tag === "Success") return "stored";
  if (isAtomCommandInterrupted(result)) return "failed";
  const error = squashAtomCommandFailure(result);
  return isReportError(error) && !error.retryable ? "rejected" : "failed";
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

/** Keeps `environmentId`'s due counts fresh: now, on window focus and every 5 minutes. */
export function watchReviewCounts(environmentId: EnvironmentId): () => void {
  const refresh = () => void refreshReviewCounts(environmentId);
  refresh();
  window.addEventListener("focus", refresh);
  const interval = setInterval(refresh, REFRESH_MS);
  return () => {
    window.removeEventListener("focus", refresh);
    clearInterval(interval);
  };
}
