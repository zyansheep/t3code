import { type AnnotationEnglish, AnnotationStatus, type EnvironmentId } from "@t3tools/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";

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

/** Whether the server's status is known, so reports can say which level a message was rendered at. */
export const annotationStatusKnownAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make((get) =>
    environmentId === null ? false : get(annotationStatusAtom(environmentId)) !== null,
  ).pipe(Atom.withLabel("annotation-status-known")),
);

/**
 * The level chat messages render at, from -3 (no Japanese) to 3: English only renders as -3. Until the server's status
 * is known, the last one this browser stored for it, else normal. A number, so only a change re-renders messages.
 */
export const chatLevelAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make((get) => {
    if (environmentId === null) return 0;
    const status =
      get(annotationStatusAtom(environmentId)) ?? storedStatus(environmentId, Date.now());
    return status === null ? 0 : status.english.on ? -3 : status.intensity.level;
  }).pipe(Atom.withLabel("annotation-level")),
);

const STORAGE_KEY_PREFIX = "t3.annotationStatus:";
const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(AnnotationStatus));

// Reading localStorage throws where the browser blocks storage; that must not break the page.
function storage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function storedStatus(environmentId: EnvironmentId, now: number): AnnotationStatus | null {
  const stored = storage()?.getItem(STORAGE_KEY_PREFIX + environmentId);
  const status = stored ? Option.getOrNull(decodeStored(stored)) : null;
  return status && statusAt(status, now);
}

function storeStatus(environmentId: EnvironmentId, status: AnnotationStatus | null) {
  try {
    if (status) storage()?.setItem(STORAGE_KEY_PREFIX + environmentId, JSON.stringify(status));
    else storage()?.removeItem(STORAGE_KEY_PREFIX + environmentId);
  } catch {
    // A full or blocked storage only loses the guess for the next start.
  }
}

const REFRESH_MS = 5 * 60_000;
const RETRY_MS = 10_000;
// setTimeout fires at once beyond a signed 32-bit delay.
const MAX_TIMEOUT_MS = 2_147_483_647;

interface Watched {
  settled: boolean;
  inFlight: boolean;
  attemptedAt: number;
  expiry: ReturnType<typeof setTimeout> | null;
  /** Presses (level steps and English only) sent so far, so a read that started before one is not kept. */
  presses: number;
  retry: ReturnType<typeof setTimeout> | null;
  failures: number;
}

const watched = new Map<EnvironmentId, Watched>();

function entry(environmentId: EnvironmentId): Watched {
  let watch = watched.get(environmentId);
  if (!watch) {
    watch = {
      settled: false,
      inFlight: false,
      attemptedAt: 0,
      expiry: null,
      presses: 0,
      retry: null,
      failures: 0,
    };
    watched.set(environmentId, watch);
  }
  return watch;
}

/** The status as the collector would answer at `now`: English only and the level end when their time is up. */
function statusAt(status: AnnotationStatus, now: number): AnnotationStatus {
  const { english, intensity } = status;
  return {
    english:
      english.on && english.until > 0 && english.until <= now
        ? { on: false, until: 0, at: english.at }
        : english,
    intensity:
      intensity.level !== 0 && intensity.until > 0 && intensity.until <= now
        ? { level: 0, until: 0 }
        : intensity,
  };
}

/**
 * Stores a status, and ends English only and the level locally when their time is up, so messages render at the new
 * level without waiting for the next refresh.
 */
function setStatus(environmentId: EnvironmentId, status: AnnotationStatus | null) {
  const watch = entry(environmentId);
  if (watch.expiry) clearTimeout(watch.expiry);
  watch.expiry = null;
  const now = Date.now();
  const current = status && statusAt(status, now);
  const ends = current
    ? [current.english.on ? current.english.until : 0, current.intensity.until].filter(
        (until) => until > now,
      )
    : [];
  if (ends.length > 0) {
    watch.expiry = setTimeout(
      () => {
        watch.expiry = null;
        setStatus(environmentId, appAtomRegistry.get(annotationStatusAtom(environmentId)));
      },
      Math.min(Math.min(...ends) - now, MAX_TIMEOUT_MS),
    );
  }
  storeStatus(environmentId, current);
  appAtomRegistry.set(annotationStatusAtom(environmentId), current);
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
  const presses = watch.presses;
  const result = await runAtomCommand(
    appAtomRegistry,
    getAnnotationStatus,
    { environmentId, input: {} },
    { reportFailure: false, reportDefect: false },
  );
  watch.inFlight = false;
  // A press since it started may have changed what it read: read again instead.
  if (watch.presses !== presses) {
    void refreshAnnotationStatus(environmentId);
    return;
  }
  if (result._tag === "Success") {
    watch.settled = true;
    setStatus(environmentId, result.value);
  } else if (failureReason(result) === "not configured") {
    watch.settled = true;
    setStatus(environmentId, null);
  } else if (!watch.settled && !watch.retry) {
    // A first read can fail while the server is still connecting; without a retry here the status (and the review
    // button) would wait for the next focus or the 5-minute refresh. Backs off to that refresh's interval.
    const delay = Math.min(RETRY_MS * 2 ** watch.failures, REFRESH_MS);
    watch.failures += 1;
    watch.retry = setTimeout(() => {
      watch.retry = null;
      void refreshAnnotationStatus(environmentId);
    }, delay);
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
  entry(environmentId).presses += 1;
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
  // The level was a guess: read it now.
  if (!current) void refreshAnnotationStatus(environmentId);
  return { ok: true, value: result.value };
}

/** Steps the chat level by one through the collector and keeps its answer. */
export async function stepAnnotationLevel(
  environmentId: EnvironmentId,
  step: 1 | -1,
): Promise<AnnotationChange<AnnotationStatus["intensity"]> | null> {
  entry(environmentId).presses += 1;
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
  // A press before the status was read is still the collector's answer; English only is a guess until read now.
  const current = appAtomRegistry.get(annotationStatusAtom(environmentId));
  setStatus(environmentId, {
    english: current?.english ?? { on: false, until: 0, at: 0 },
    intensity: result.value,
  });
  if (!current) void refreshAnnotationStatus(environmentId);
  return { ok: true, value: result.value };
}
