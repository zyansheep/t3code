import type { AnnotationEnglish, AnnotationStatus, EnvironmentId } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import {
  type AtomCommandResult,
  createEnvironmentRpcCommand,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { subscribeAppActive } from "../lib/appState";
import { appAtomRegistry } from "./atom-registry";
import { annotationStatusAtom } from "./chat-japanese-view";
import { glossContextsOnScreen } from "./gloss-opens";
import { workspaceConnections } from "./workspace";

/**
 * The collector's chat Japanese, as the Z3 Code desktop reads and changes it (apps/web's state/annotationStatus.ts),
 * through each environment's server: whether there is a collector, its level, stepped lighter or heavier for a while,
 * and English only.
 */

const getAnnotationStatus = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:annotations:status",
  tag: WS_METHODS.serverGetAnnotationStatus,
});

// Steps and toggles run one at a time, so the last answer is the current state.
const adjustAnnotationIntensity = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:annotations:intensity",
  tag: WS_METHODS.serverAdjustAnnotationIntensity,
  concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
});

const setAnnotationEnglish = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:annotations:english",
  tag: WS_METHODS.serverSetAnnotationEnglish,
  concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
});

const REFRESH_MS = 5 * 60_000;
const RETRY_MS = 10_000;
// setTimeout fires at once beyond a signed 32-bit delay.
const MAX_TIMEOUT_MS = 2_147_483_647;

interface Watched {
  settledAt: number;
  inFlight: boolean;
  attemptedAt: number;
  expiry: ReturnType<typeof setTimeout> | null;
  levelExpiry: ReturnType<typeof setTimeout> | null;
  /** Presses applied so far: a status read that started before the latest one is out of date when it answers. */
  presses: number;
}

const watched = new Map<EnvironmentId, Watched>();
let stopWakeups: (() => void) | undefined;

function entry(environmentId: EnvironmentId): Watched {
  let watch = watched.get(environmentId);
  if (!watch) {
    watch = {
      settledAt: 0,
      inFlight: false,
      attemptedAt: 0,
      expiry: null,
      levelExpiry: null,
      presses: 0,
    };
    watched.set(environmentId, watch);
  }
  return watch;
}

/**
 * Stores a status and, without waiting for the next refresh, turns English only off and the level back to normal
 * locally when they end, so chat renders as the collector has it.
 */
function setStatus(environmentId: EnvironmentId, status: AnnotationStatus | null) {
  const watch = entry(environmentId);
  if (watch.expiry) clearTimeout(watch.expiry);
  if (watch.levelExpiry) clearTimeout(watch.levelExpiry);
  watch.expiry = null;
  watch.levelExpiry = null;
  const intensity = status?.intensity;
  if (status && intensity && intensity.level !== 0 && intensity.until > 0) {
    const left = intensity.until - Date.now();
    if (left <= 0) {
      status = { ...status, intensity: { level: 0, until: 0 } };
    } else {
      watch.levelExpiry = setTimeout(
        () => {
          watch.levelExpiry = null;
          const current = appAtomRegistry.get(annotationStatusAtom(environmentId));
          if (current?.intensity.until !== intensity.until) return;
          setStatus(environmentId, { ...current, intensity: { level: 0, until: 0 } });
        },
        Math.min(left, MAX_TIMEOUT_MS),
      );
    }
  }
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

/**
 * Keeps a press's answer over any status read already asked, and, when the status was unknown, reads it at once for the
 * half the press did not answer (English only for a level, the level for English only).
 */
function applyPress(environmentId: EnvironmentId, status: AnnotationStatus) {
  const watch = entry(environmentId);
  const known = appAtomRegistry.get(annotationStatusAtom(environmentId)) !== null;
  watch.presses += 1;
  setStatus(environmentId, status);
  if (!known) void refreshAnnotationStatus(environmentId);
}

/** Reads the status again; a server without a collector clears it, and other failures keep the last one. */
async function refreshAnnotationStatus(environmentId: EnvironmentId): Promise<void> {
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
  // Asked before a press, it may hold the state from before it: read again instead.
  if (watch.presses !== presses) {
    void refreshAnnotationStatus(environmentId);
    return;
  }
  if (result._tag === "Success") {
    watch.settledAt = Date.now();
    setStatus(environmentId, result.value);
  } else if (failureReason(result) === "not configured") {
    watch.settledAt = Date.now();
    setStatus(environmentId, null);
  }
}

/**
 * Keeps `environmentId`'s status fresh from now on: read now unless it is recent or was just tried, and again each time
 * the app comes back to the foreground.
 */
export function watchAnnotationStatus(environmentId: EnvironmentId): void {
  stopWakeups ??= subscribeAppActive(() => {
    for (const id of watched.keys()) void refreshAnnotationStatus(id);
  });
  const watch = entry(environmentId);
  const now = Date.now();
  if (watch.inFlight || now - watch.settledAt < REFRESH_MS || now - watch.attemptedAt < RETRY_MS) {
    return;
  }
  void refreshAnnotationStatus(environmentId);
}

/**
 * The first connected environment whose server has a collector: the one the review cards come from. Watching the
 * connected environments' statuses is up to whoever shows it (useJapaneseEnvironment).
 */
export const japaneseEnvironmentAtom = Atom.make((get) => {
  for (const environment of get(workspaceConnections.environmentsAtom)) {
    if (!environment.isEnabled || environment.connectionState !== "connected") continue;
    if (get(annotationStatusAtom(environment.environmentId)) !== null) {
      return environment.environmentId;
    }
  }
  return null;
}).pipe(Atom.withLabel("mobile:japanese-environment"));

/** Connected environments, to watch for a collector. */
export const connectedEnvironmentIdsAtom = Atom.make((get) =>
  get(workspaceConnections.environmentsAtom)
    .filter((environment) => environment.isEnabled && environment.connectionState === "connected")
    .map((environment) => environment.environmentId)
    .join("\n"),
).pipe(Atom.withLabel("mobile:connected-environment-ids"));

export type ChatJapaneseChange<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly reason: string };

/**
 * Turns English only on or off at the collector, sending the messages with glosses on screen when it turns on, and
 * applies the answer to every message at once. Null when the request was interrupted.
 */
export async function setEnglishOnly(
  environmentId: EnvironmentId,
  on: boolean,
): Promise<ChatJapaneseChange<AnnotationEnglish> | null> {
  const result = await runAtomCommand(
    appAtomRegistry,
    setAnnotationEnglish,
    { environmentId, input: { on, contexts: on ? glossContextsOnScreen() : [] } },
    { reportFailure: false, reportDefect: false },
  );
  if (result._tag !== "Success") {
    const reason = failureReason(result);
    return reason === null ? null : { ok: false, reason };
  }
  const current = appAtomRegistry.get(annotationStatusAtom(environmentId));
  applyPress(environmentId, {
    intensity: current?.intensity ?? { level: 0, until: 0 },
    english: result.value,
  });
  return { ok: true, value: result.value };
}

/** Steps the chat level by one through the collector and keeps its answer. */
export async function stepAnnotationLevel(
  environmentId: EnvironmentId,
  step: 1 | -1,
): Promise<ChatJapaneseChange<AnnotationStatus["intensity"]> | null> {
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
  applyPress(environmentId, {
    english: current?.english ?? { on: false, until: 0, at: 0 },
    intensity: result.value,
  });
  return { ok: true, value: result.value };
}
