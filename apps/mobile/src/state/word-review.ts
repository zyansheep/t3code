import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { glossOpenSession } from "../lib/glossOpens";
import { createReviewSession, reviewFailureDetail, type ReviewFetch } from "../lib/reviewSession";
import { appAtomRegistry } from "./atom-registry";
import { reviewCountsAtom } from "./chat-japanese-view";
import { reportAnnotationReview } from "./gloss-opens";

const FETCH_TIMEOUT_MS = 15_000;
/** How long the next card waits for the server to take a grade before it is asked for anyway. */
const DELIVERY_WAIT_MS = 4_000;
/** The badge's counts are asked for at most this often outside a review. */
const COUNTS_REFRESH_MS = 10 * 60_000;

const nextReview = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:annotations:review-next",
  tag: WS_METHODS.serverNextAnnotationReview,
});

function withTimeout<A>(promise: Promise<A>, ms: number, late: A): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<A>((resolve) => {
    timer = setTimeout(() => resolve(late), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function fetchNextCard(
  environmentId: EnvironmentId,
  request: { readonly exclude: ReadonlyArray<string>; readonly more: boolean },
): Promise<ReviewFetch> {
  const asked = runAtomCommand(
    appAtomRegistry,
    nextReview,
    {
      environmentId,
      input: {
        source: "mobile",
        exclude: [...request.exclude],
        ...(request.more ? { more: true } : {}),
      },
    },
    { reportFailure: false, reportDefect: false },
  ).then((result): ReviewFetch => {
    if (result._tag !== "Success") {
      return { _tag: "error", detail: reviewFailureDetail(squashAtomCommandFailure(result)) };
    }
    return { _tag: "answer", card: result.value.card, counts: result.value.counts };
  });
  return withTimeout(asked, FETCH_TIMEOUT_MS, {
    _tag: "error",
    detail: "The server took too long",
  });
}

/** Monotonic where the runtime has performance.now (Hermes does), so a clock change can't bend a duration. */
function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

let uidSession: string | undefined;
let uidSequence = 0;

function reviewUid(): string {
  uidSession ??= glossOpenSession(Date.now(), Math.random().toString(36).slice(2, 8));
  uidSequence += 1;
  return `phone-review-${uidSession}-${uidSequence}`;
}

const countsAskedAt = new Map<EnvironmentId, number>();

/** A review session against one environment's server, reporting through the gloss-open queue. */
export function createWordReviewSession(environmentId: EnvironmentId) {
  return createReviewSession({
    fetchNext: (request) => fetchNextCard(environmentId, request),
    emit: (item) =>
      withTimeout(reportAnnotationReview(environmentId, item), DELIVERY_WAIT_MS, false),
    monotonicNow,
    wallNow: () => Date.now(),
    uid: reviewUid,
    onCounts: (counts) => {
      countsAskedAt.set(environmentId, Date.now());
      appAtomRegistry.set(reviewCountsAtom(environmentId), counts);
    },
  });
}

/**
 * Asks for the counts on the review badge, unless they are recent. There is no request for counts alone, so this asks
 * for a card it does not show, which the server takes as nothing (only a review item counts).
 */
export function refreshReviewCounts(environmentId: EnvironmentId): void {
  const now = Date.now();
  if (now - (countsAskedAt.get(environmentId) ?? 0) < COUNTS_REFRESH_MS) return;
  countsAskedAt.set(environmentId, now);
  void fetchNextCard(environmentId, { exclude: [], more: false }).then((result) => {
    if (result._tag === "answer" && result.counts) {
      appAtomRegistry.set(reviewCountsAtom(environmentId), result.counts);
    }
  });
}
