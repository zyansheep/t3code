import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { glossOpenSession } from "../lib/glossOpens";
import {
  createCardReleases,
  createReviewSession,
  reviewFailureDetail,
  type ReviewFetch,
} from "../lib/reviewSession";
import { appAtomRegistry } from "./atom-registry";
import { reviewCountsAtom } from "./chat-japanese-view";
import { reportAnnotationReview } from "./gloss-opens";

const FETCH_TIMEOUT_MS = 15_000;
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

/** Per environment, the cards to release with the next request, the badge's peeks included. */
const releases = new Map<EnvironmentId, ReturnType<typeof createCardReleases>>();

function releasesOf(environmentId: EnvironmentId) {
  let list = releases.get(environmentId);
  if (!list) {
    list = createCardReleases();
    releases.set(environmentId, list);
  }
  return list;
}

function fetchNextCard(
  environmentId: EnvironmentId,
  request: {
    readonly exclude: ReadonlyArray<string>;
    readonly more: boolean;
    readonly peek?: boolean;
  },
): Promise<ReviewFetch> {
  const released = releasesOf(environmentId).take();
  const asked = runAtomCommand(
    appAtomRegistry,
    nextReview,
    {
      environmentId,
      input: {
        source: "mobile",
        exclude: [...request.exclude],
        ...(request.more ? { more: true } : {}),
        ...(request.peek ? { peek: true } : {}),
        ...(released.length > 0 ? { release: [...released] } : {}),
      },
    },
    { reportFailure: false, reportDefect: false },
  ).then((result): ReviewFetch => {
    if (result._tag !== "Success") {
      releasesOf(environmentId).restore(released);
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
    emit: (item) => reportAnnotationReview(environmentId, item),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    release: (cardId) => releasesOf(environmentId).add(cardId),
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
 * Asks for the counts on the review badge, unless they are recent: a peek, which serves and records no card (a server
 * from before peeks serves one, which is dropped here and counts as nothing, as only a review item does).
 */
export function refreshReviewCounts(environmentId: EnvironmentId): void {
  const now = Date.now();
  if (now - (countsAskedAt.get(environmentId) ?? 0) < COUNTS_REFRESH_MS) return;
  countsAskedAt.set(environmentId, now);
  void fetchNextCard(environmentId, { exclude: [], more: false, peek: true }).then((result) => {
    if (result._tag === "answer" && result.counts) {
      appAtomRegistry.set(reviewCountsAtom(environmentId), result.counts);
    }
  });
}
