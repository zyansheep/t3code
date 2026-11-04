import type { AnnotationEnglish, AnnotationStatus, EnvironmentId } from "@t3tools/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";

import { visibleReadingContexts } from "../lib/annotationReading";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  adjustAnnotationIntensity,
  getAnnotationStatus,
  setAnnotationEnglish,
} from "./annotationInteractions";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";

/**
 * The collector's chat Japanese status per environment (its level and English only), read through that environment's
 * server: `null` until known, and while the server has no collector.
 */
export const annotationStatusAtom = Atom.family((_environmentId: EnvironmentId) =>
  Atom.make<AnnotationStatus | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel("annotation-status"),
  ),
);

/** Whether chat shows English instead of Japanese; a boolean, so only a flip re-renders messages. */
export const englishOnlyAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make((get) =>
    environmentId === null
      ? false
      : (get(annotationStatusAtom(environmentId))?.english.on ?? false),
  ).pipe(Atom.withLabel("annotation-english-only")),
);

const REFRESH_MS = 5 * 60_000;
const RETRY_MS = 10_000;
// setTimeout fires at once beyond a signed 32-bit delay.
const MAX_TIMEOUT_MS = 2_147_483_647;

interface Watched {
  settled: boolean;
  inFlight: boolean;
  attemptedAt: number;
  expiry: ReturnType<typeof setTimeout> | null;
}

const watched = new Map<EnvironmentId, Watched>();

function entry(environmentId: EnvironmentId): Watched {
  let watch = watched.get(environmentId);
  if (!watch) {
    watch = { settled: false, inFlight: false, attemptedAt: 0, expiry: null };
    watched.set(environmentId, watch);
  }
  return watch;
}

/** Stores a status and turns English only off locally when it ends, without waiting for the next refresh. */
function setStatus(environmentId: EnvironmentId, status: AnnotationStatus | null) {
  const watch = entry(environmentId);
  if (watch.expiry) clearTimeout(watch.expiry);
  watch.expiry = null;
  const english = status?.english;
  if (status && english?.on && english.until > 0) {
    const left = english.until - Date.now();
    if (left <= 0) {
      status = { ...status, english: { on: false, until: 0, at: english.at } };
    } else {
      watch.expiry = setTimeout(
        () => {
          watch.expiry = null;
          const current = appAtomRegistry.get(annotationStatusAtom(environmentId));
          if (current?.english.until !== english.until) return;
          setStatus(environmentId, { ...current, english: { ...current.english, on: false } });
        },
        Math.min(left, MAX_TIMEOUT_MS),
      );
    }
  }
  appAtomRegistry.set(annotationStatusAtom(environmentId), status);
}

function failureReason(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message ? error.message : "request failed";
}

/** Reads the status again; a server without a collector clears it, and other failures keep the last one. */
export async function refreshAnnotationStatus(environmentId: EnvironmentId): Promise<void> {
  const watch = entry(environmentId);
  if (watch.inFlight) return;
  watch.inFlight = true;
  watch.attemptedAt = Date.now();
  const result = await runAtomCommand(
    appAtomRegistry,
    getAnnotationStatus,
    { environmentId, input: {} },
    { reportFailure: false, reportDefect: false },
  );
  watch.inFlight = false;
  if (result._tag === "Success") {
    watch.settled = true;
    setStatus(environmentId, result.value);
  } else if (failureReason(result) === "not configured") {
    watch.settled = true;
    setStatus(environmentId, null);
  }
}

/** Keeps `environmentId`'s status fresh from now on, reading it now unless it is known or was just tried. */
export function watchAnnotationStatus(environmentId: EnvironmentId): void {
  const watch = entry(environmentId);
  if (watch.settled || watch.inFlight || Date.now() - watch.attemptedAt < RETRY_MS) return;
  void refreshAnnotationStatus(environmentId);
}

/** Reads the status of this client's own server at start, then of every watched server on focus and every 5 minutes. */
export function startAnnotationStatusRefresh(): () => void {
  const refreshAll = () => {
    for (const environmentId of watched.keys()) void refreshAnnotationStatus(environmentId);
  };
  const unsubscribe = appAtomRegistry.subscribe(
    primaryEnvironmentIdAtom,
    (environmentId) => {
      if (environmentId) watchAnnotationStatus(environmentId);
    },
    { immediate: true },
  );
  window.addEventListener("focus", refreshAll);
  const interval = setInterval(refreshAll, REFRESH_MS);
  return () => {
    unsubscribe();
    window.removeEventListener("focus", refreshAll);
    clearInterval(interval);
  };
}

export type AnnotationChange<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly reason: string };

/**
 * Turns English only on or off at the collector, sending the messages on screen when it turns on, and applies the
 * answer to every message at once.
 */
export async function setEnglishOnly(
  environmentId: EnvironmentId,
  on: boolean,
): Promise<AnnotationChange<AnnotationEnglish> | null> {
  const result = await runAtomCommand(
    appAtomRegistry,
    setAnnotationEnglish,
    { environmentId, input: { on, contexts: on ? visibleReadingContexts() : [] } },
    { reportFailure: false, reportDefect: false },
  );
  if (result._tag !== "Success") {
    const reason = failureReason(result);
    return reason === null ? null : { ok: false, reason };
  }
  const current = appAtomRegistry.get(annotationStatusAtom(environmentId));
  setStatus(environmentId, {
    intensity: current?.intensity ?? { level: 0, until: 0 },
    english: result.value,
  });
  return { ok: true, value: result.value };
}

/** Steps the chat level by one through the collector and keeps its answer. */
export async function stepAnnotationLevel(
  environmentId: EnvironmentId,
  step: 1 | -1,
): Promise<AnnotationChange<AnnotationStatus["intensity"]> | null> {
  const result = await runAtomCommand(
    appAtomRegistry,
    adjustAnnotationIntensity,
    { environmentId, input: { step } },
    { reportFailure: false, reportDefect: false },
  );
  if (result._tag !== "Success") {
    const reason = failureReason(result);
    return reason === null ? null : { ok: false, reason };
  }
  const current = appAtomRegistry.get(annotationStatusAtom(environmentId));
  if (current) setStatus(environmentId, { ...current, intensity: result.value });
  return { ok: true, value: result.value };
}
