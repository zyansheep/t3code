import type { AnnotationStatus, EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { ENGLISH_ONLY_LEVEL } from "../lib/markdownLevels";
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

/** Whether chat from this environment shows English instead of Japanese; a boolean, so only a flip re-renders. */
export const englishOnlyAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => get(annotationStatusAtom(environmentId))?.english.on ?? false).pipe(
    Atom.withLabel("mobile:annotation-english-only"),
  ),
);

/**
 * The level chat from this environment renders at (lib/markdownLevels.ts): the collector's, -3 while English only is on,
 * normal until known or with no collector; a number, so only a change re-renders.
 */
export const chatJapaneseLevelAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const status = get(annotationStatusAtom(environmentId));
    if (status === null) return 0;
    return status.english.on ? ENGLISH_ONLY_LEVEL : status.intensity.level;
  }).pipe(Atom.withLabel("mobile:annotation-chat-level")),
);

/**
 * The level chat from this environment renders its twins at: the collector's sentence level, its word level when it has
 * one level for both, -3 while English only is on, normal until known or with no collector.
 */
export const chatJapaneseSentenceLevelAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const status = get(annotationStatusAtom(environmentId));
    if (status === null) return 0;
    return status.english.on ? ENGLISH_ONLY_LEVEL : (status.sentences ?? status.intensity).level;
  }).pipe(Atom.withLabel("mobile:annotation-sentence-level")),
);

/** Anki's three counts the review cards last came with, for the badge; null until known. */
export const reviewCountsAtom = Atom.family((_environmentId: EnvironmentId) =>
  Atom.make<ReviewCounts | null>(null).pipe(Atom.keepAlive, Atom.withLabel("mobile:review-counts")),
);

/** Messages with glosses on screen now, by text, each as often as it is shown. */
const glossedOnScreen = new Map<string, number>();

/** A message with glosses came on screen; the returned function says it left. */
export function showGlossedMessage(text: string): () => void {
  glossedOnScreen.set(text, (glossedOnScreen.get(text) ?? 0) + 1);
  return () => {
    const left = (glossedOnScreen.get(text) ?? 1) - 1;
    if (left > 0) glossedOnScreen.set(text, left);
    else glossedOnScreen.delete(text);
  };
}

/** The texts of the messages with glosses on screen, oldest shown first. */
export function glossedMessagesOnScreen(): ReadonlyArray<string> {
  return [...glossedOnScreen.keys()];
}
