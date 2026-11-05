import type { AnnotationStatus, EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { ReviewCounts } from "../lib/reviewSession";

/**
 * The collector's chat Japanese as views read it, apart from the requests (state/chat-japanese.ts), so the chat feed
 * reads it without loading the connection runtime.
 */

/** The collector's chat level and English only, through one environment's server: null until known or with none. */
export const annotationStatusAtom = Atom.family((_environmentId: EnvironmentId) =>
  Atom.make<AnnotationStatus | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel("mobile:annotation-status"),
  ),
);

/** Anki's three counts the review cards last came with, for the badge; null until known. */
export const reviewCountsAtom = Atom.family((_environmentId: EnvironmentId) =>
  Atom.make<ReviewCounts | null>(null).pipe(Atom.keepAlive, Atom.withLabel("mobile:review-counts")),
);
