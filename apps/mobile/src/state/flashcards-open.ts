import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "./atom-registry";

/**
 * The environment whose review cards are open full screen, or null. Kept apart from the review's requests, so the chat
 * feed can open the cards without loading the connection runtime.
 */
export const flashcardsEnvironmentAtom = Atom.make<EnvironmentId | null>(null).pipe(Atom.keepAlive);

/** A gloss's wedge was tapped: review cards from this environment's server. */
export function openFlashcards(environmentId: EnvironmentId): void {
  appAtomRegistry.set(flashcardsEnvironmentAtom, environmentId);
}

export function closeFlashcards(): void {
  appAtomRegistry.set(flashcardsEnvironmentAtom, null);
}
