import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AnnotationInteraction, type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { subscribeAppActive } from "../lib/appState";
import { writeFileAtomically } from "../lib/atomic-file";
import {
  createGlossOpenQueue,
  glossContextId,
  glossOpenItem,
  glossOpenSession,
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

/** False on a failure or a server that is too slow; a late arrival is stored once, by its uid. */
async function send(environmentId: string, items: ReadonlyArray<AnnotationInteraction>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), SEND_TIMEOUT_MS);
  });
  const sent = runAtomCommand(
    appAtomRegistry,
    reportOpens,
    { environmentId: environmentId as EnvironmentId, input: { items: [...items] } },
    { reportFailure: false, reportDefect: false },
  ).then(AsyncResult.isSuccess);
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

/** Sends what is queued, and keeps doing so as servers come back; settles once this round is over. */
function flushGlossOpens(): Promise<void> {
  wakeups ??= subscribeAppActive(deliverGlossOpens);
  return queue
    .flush()
    .then(watchPending)
    .catch(() => undefined);
}

function deliverGlossOpens() {
  void flushGlossOpens();
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

function phoneSession(at: number): string {
  session ??= glossOpenSession(at, Math.random().toString(36).slice(2, 8));
  return session;
}

/**
 * The messages with glosses on screen by the view and context their reports carry: the view of this app run, as each
 * opened word's own view starts, and the message's context, as the desktop names it.
 */
export function glossContextsOnScreen(): Array<{ view: string; context: string }> {
  const view = `phone-${phoneSession(Date.now())}`;
  return glossedMessagesOnScreen()
    .slice(0, 30)
    .map((text) => ({ view, context: glossContextId(text) }));
}

/** Reports a word tapped open. Never throws and never waits: a failed report must not touch the UI. */
export function reportGlossOpen(input: {
  readonly environmentId: EnvironmentId;
  readonly messageText: string;
  readonly word: string;
}): void {
  try {
    const at = Date.now();
    sequence += 1;
    const item = glossOpenItem({
      session: phoneSession(at),
      sequence,
      messageText: input.messageText,
      word: input.word,
      at,
    });
    if (item === null) return;
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
 * resolves true once the server has taken it, false when it is still queued for later.
 */
export function reportAnnotationReview(
  environmentId: EnvironmentId,
  item: Extract<AnnotationInteraction, { readonly kind: "review" }>,
): Promise<boolean> {
  try {
    return queue
      .add({ environmentId, item })
      .then(flushGlossOpens)
      .then(() => !queue.pending().some((entry) => entry.item.uid === item.uid))
      .catch(() => false);
  } catch {
    // The review goes on.
    return Promise.resolve(false);
  }
}
