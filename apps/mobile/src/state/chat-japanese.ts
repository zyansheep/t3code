import type { AnnotationStatus, EnvironmentId } from "@t3tools/contracts";
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
import { workspaceConnections } from "./workspace";

/**
 * The collector's chat Japanese, as the Z3 Code desktop reads it (apps/web's state/annotationStatus.ts), through each
 * environment's server: whether there is a collector, its level and English only.
 */

const getAnnotationStatus = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:annotations:status",
  tag: WS_METHODS.serverGetAnnotationStatus,
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
}

const watched = new Map<EnvironmentId, Watched>();
let stopWakeups: (() => void) | undefined;

function entry(environmentId: EnvironmentId): Watched {
  let watch = watched.get(environmentId);
  if (!watch) {
    watch = { settledAt: 0, inFlight: false, attemptedAt: 0, expiry: null };
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
async function refreshAnnotationStatus(environmentId: EnvironmentId): Promise<void> {
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
