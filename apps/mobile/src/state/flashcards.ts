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
import { reportAnnotationReview } from "./gloss-opens";

const FETCH_TIMEOUT_MS = 15_000;

const nextReview = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:annotations:review-next",
  tag: WS_METHODS.serverNextAnnotationReview,
});

async function fetchNextCard(
  environmentId: EnvironmentId,
  exclude: ReadonlyArray<string>,
): Promise<ReviewFetch> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<ReviewFetch>((resolve) => {
    timer = setTimeout(
      () => resolve({ _tag: "error", detail: "The server took too long" }),
      FETCH_TIMEOUT_MS,
    );
  });
  const asked = runAtomCommand(
    appAtomRegistry,
    nextReview,
    { environmentId, input: { source: "mobile", exclude: [...exclude] } },
    { reportFailure: false, reportDefect: false },
  ).then((result): ReviewFetch => {
    if (result._tag !== "Success") {
      return { _tag: "error", detail: reviewFailureDetail(squashAtomCommandFailure(result)) };
    }
    const { card } = result.value;
    return card === null ? { _tag: "empty" } : { _tag: "card", card };
  });
  try {
    return await Promise.race([asked, late]);
  } finally {
    clearTimeout(timer);
  }
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

/** A review session against one environment's server, reporting through the gloss-open queue. */
export function createFlashcardSession(environmentId: EnvironmentId) {
  return createReviewSession({
    fetchNext: (exclude) => fetchNextCard(environmentId, exclude),
    emit: (item) => reportAnnotationReview(environmentId, item),
    monotonicNow,
    wallNow: () => Date.now(),
    uid: reviewUid,
  });
}
