import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AnnotationInteraction, type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { subscribeAppActive } from "../lib/appState";
import { writeFileAtomically } from "../lib/atomic-file";
import {
  createGlossOpenQueue,
  failedReportResult,
  glossContextId,
  glossContextsOf,
  glossOpenItem,
  glossOpenSession,
  type GlossOpenSendResult,
  type QueuedGlossOpen,
} from "../lib/glossOpens";
import { appAtomRegistry } from "./atom-registry";
import { glossedMessagesOnScreen } from "./chat-japanese-view";

const QUEUE_FILE = "gloss-opens.json";
const SEND_TIMEOUT_MS = 15_000;
const RETRY_MS = 120_000;

const reportOpens = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:annotations:report",
  tag: WS_METHODS.serverReportAnnotationInteractions,
});

async function queueFile() {
  const { File, Paths } = await import("expo-file-system");
  return new File(Paths.document, QUEUE_FILE);
}

/**
 * False on a failure to try again or a server that is too slow (a late arrival is stored once, by its uid); the items
 * the server refused for good when it stored the rest.
 */
async function send(
  environmentId: string,
  items: ReadonlyArray<AnnotationInteraction>,
): Promise<GlossOpenSendResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), SEND_TIMEOUT_MS);
  });
  const sent = runAtomCommand(
    appAtomRegistry,
    reportOpens,
    { environmentId: environmentId as EnvironmentId, input: { items: [...items] } },
    { reportFailure: false, reportDefect: false },
  ).then((result) =>
    AsyncResult.isSuccess(result) ? true : failedReportResult(squashAtomCommandFailure(result)),
  );
  try {
    return await Promise.race([sent, late]);
  } finally {
    clearTimeout(timer);
  }
}

const queue = createGlossOpenQueue({
  load: async () => {
    const file = await queueFile();
    return file.exists ? JSON.parse(await file.text()) : [];
  },
  save: async (entries: ReadonlyArray<QueuedGlossOpen>) =>
    writeFileAtomically(await queueFile(), JSON.stringify(entries)),
  send,
  isItem: Schema.is(AnnotationInteraction),
  now: () => Date.now(),
});

const watched = new Map<string, () => void>();
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let wakeups: (() => void) | undefined;

/** After a flush: what is still queued waits for its server to reconnect, the app's return or a slow retry. */
function watchPending() {
  const waiting = new Set(queue.pending().map((entry) => entry.environmentId));
  for (const [environmentId, stop] of watched) {
    if (waiting.has(environmentId)) continue;
    stop();
    watched.delete(environmentId);
  }
  for (const environmentId of waiting) {
    if (watched.has(environmentId)) continue;
    const state = environmentCatalog.stateAtom(environmentId as EnvironmentId);
    let connected = false;
    watched.set(
      environmentId,
      appAtomRegistry.subscribe(state, (result) => {
        const now = AsyncResult.isSuccess(result) && result.value.phase === "connected";
        if (now && !connected) deliverGlossOpens();
        connected = now;
      }),
    );
  }
  if (retryTimer !== undefined) clearTimeout(retryTimer);
  retryTimer = waiting.size > 0 ? setTimeout(deliverGlossOpens, RETRY_MS) : undefined;
}

/** Sends what is queued, and keeps doing so as servers come back. */
function deliverGlossOpens() {
  wakeups ??= subscribeAppActive(deliverGlossOpens);
  void queue
    .flush()
    .then(watchPending)
    .catch(() => undefined);
}

/** At startup: sends what an earlier run left queued. */
export function installGlossOpenDelivery(): () => void {
  deliverGlossOpens();
  return () => {
    wakeups?.();
    wakeups = undefined;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    for (const stop of watched.values()) stop();
    watched.clear();
  };
}

let session: string | undefined;
let sequence = 0;
/** The views of the words opened this run, by their message's context: what the collector has records of. */
const openedViews = new Map<string, Set<string>>();

/** The messages with glosses on screen, by the views and context their gloss-open reports carry (lib/glossOpens.ts). */
export function glossContextsOnScreen(): Array<{ view: string; context: string }> {
  return glossContextsOf(glossedMessagesOnScreen().map(glossContextId), openedViews);
}

/**
 * Reports a word tapped open in a message rendered at `level`. Never throws and never waits: a failed report must not
 * touch the UI.
 */
export function reportGlossOpen(input: {
  readonly environmentId: EnvironmentId;
  readonly messageText: string;
  readonly word: string;
  readonly level?: number | undefined;
}): void {
  try {
    const at = Date.now();
    session ??= glossOpenSession(at, Math.random().toString(36).slice(2, 8));
    sequence += 1;
    const item = glossOpenItem({
      session,
      sequence,
      messageText: input.messageText,
      word: input.word,
      at,
      level: input.level,
    });
    if (item === null) return;
    const views = openedViews.get(item.context) ?? new Set<string>();
    openedViews.set(item.context, views.add(item.view));
    void queue
      .add({ environmentId: input.environmentId, item })
      .then(deliverGlossOpens)
      .catch(() => undefined);
  } catch {
    // The gloss has already opened.
  }
}

/**
 * Queues a review card's item (lib/reviewSession.ts) beside the gloss opens and sends it. Never throws or rejects:
 * resolves true once its server has taken it, now or on a later retry (a server that could not store it refuses the
 * report, which stays queued), and false only if it is dropped unsent.
 */
export function reportAnnotationReview(
  environmentId: EnvironmentId,
  item: Extract<AnnotationInteraction, { readonly kind: "review" }>,
): Promise<boolean> {
  try {
    const uid = item.uid;
    if (uid === undefined) return Promise.resolve(false);
    const added = queue.add({ environmentId, item });
    void added.then(deliverGlossOpens).catch(() => undefined);
    return queue.settled(uid).catch(() => false);
  } catch {
    // The review goes on.
    return Promise.resolve(false);
  }
}
