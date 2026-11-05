import type {
  AnnotationInteraction,
  AnnotationReviewNextResult,
  EnvironmentId,
} from "@t3tools/contracts";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
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

/** Asks the collector for the next card through `environmentId`'s server; a `peek` asks for the counts alone. */
export async function fetchReviewCard(
  environmentId: EnvironmentId,
  input: {
    readonly exclude: ReadonlyArray<string>;
    readonly more: boolean;
    readonly peek?: boolean;
  },
): Promise<AnnotationReviewNextResult | { readonly detail: string }> {
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
      },
    },
    QUIET,
  );
  if (result._tag === "Success") return result.value;
  const error = squashAtomCommandFailure(result);
  return { detail: error instanceof Error && error.message ? error.message : "request failed" };
}

export function reportReview(
  environmentId: EnvironmentId,
  item: Extract<AnnotationInteraction, { kind: "review" }>,
) {
  return runAtomCommand(
    appAtomRegistry,
    reportAnnotationInteractions,
    { environmentId, input: { items: [item] } },
    QUIET,
  );
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
