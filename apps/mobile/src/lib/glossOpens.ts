/**
 * Words tapped open on the phone, and nothing else: it has no line positions or read depth, and the collector reads any
 * listed but unopened word as seen and not looked up. So each word gets its own `phone-` view whose context lists only
 * that word, sent without a word count, which the collector then treats as an opened-only episode, never a message read.
 * The same queue carries the review cards of the flashcards (lib/reviewSession.ts).
 */
import type { AnnotationInteraction, AnnotationOpen } from "@t3tools/contracts";
import { ANNOTATION_REPORT_MAX_ITEMS } from "@t3tools/contracts";

const WORD_MAX_LENGTH = 40;
/** The collector rejects items older than 7 days, so older ones are not worth keeping. */
const MAX_AGE_MS = 7 * 86_400_000;
const MAX_QUEUED = 300;

/** 32-bit FNV-1a over UTF-16 code units, as the desktop hashes a message for its context id. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** A session id, once per app run: a later run is a new showing of the same message, as a new desktop window is. */
export function glossOpenSession(nowMs: number, random: string): string {
  return `${nowMs.toString(36)}${random}`;
}

/** The report of one word tapped open, or null when the collector would not take the word (as the desktop skips it). */
// One view per word: a context keeps only its latest list, so a growing list would make later words look unopened
// in an earlier episode. A tap counts whatever its length and may never be closed, so dwellMs stays 0.
export function glossOpenItem(input: {
  readonly session: string;
  readonly sequence: number;
  readonly messageText: string;
  readonly word: string;
  readonly at: number;
}): AnnotationOpen | null {
  const word = input.word.trim();
  if (word.length === 0 || word.length > WORD_MAX_LENGTH) return null;
  return {
    kind: "pin",
    word,
    at: input.at,
    dwellMs: 0,
    view: `phone-${input.session}-${fnv1a32(word).toString(36)}`,
    context: `m${fnv1a32(input.messageText).toString(36)}`,
    position: 0,
    box: [0, 0, 0, 0],
    annotations: [[word, 0, 0]],
    uid: `phone-${input.session}-${input.sequence}`,
  };
}

export interface QueuedGlossOpen {
  readonly environmentId: string;
  readonly item: AnnotationInteraction;
}

export interface GlossOpenQueueOptions {
  /** Reads what an earlier run left; throws or returns junk when there is nothing usable. */
  readonly load: () => Promise<unknown>;
  readonly save: (entries: ReadonlyArray<QueuedGlossOpen>) => Promise<void>;
  /** Sends one batch to one environment; true once the server has taken it. */
  readonly send: (
    environmentId: string,
    items: ReadonlyArray<AnnotationInteraction>,
  ) => Promise<boolean>;
  readonly isItem: (value: unknown) => value is AnnotationInteraction;
  readonly now: () => number;
}

/**
 * A small queue that survives a restart: the oldest go first, past MAX_QUEUED the oldest are dropped, and each batch
 * stays queued until its server has taken it. No method rejects, so a failed report can't reach the UI.
 */
export function createGlossOpenQueue(options: GlossOpenQueueOptions) {
  let entries: ReadonlyArray<QueuedGlossOpen> = [];
  let flushing: Promise<void> | null = null;
  let flushAgain = false;

  const bounded = (list: ReadonlyArray<QueuedGlossOpen>) => {
    const oldest = options.now() - MAX_AGE_MS;
    return list.filter((entry) => entry.item.at >= oldest).slice(-MAX_QUEUED);
  };

  const persist = async () => {
    try {
      await options.save(entries);
    } catch {
      // Only a restart before the next write can lose these.
    }
  };

  const loaded = (async () => {
    try {
      const stored = await options.load();
      if (!Array.isArray(stored)) return;
      const restored = stored.filter(
        (entry): entry is QueuedGlossOpen =>
          typeof entry?.environmentId === "string" &&
          options.isItem(entry?.item) &&
          entry.item.uid !== undefined,
      );
      const seen = new Set(entries.map((entry) => entry.item.uid));
      entries = bounded([...restored.filter((entry) => !seen.has(entry.item.uid)), ...entries]);
    } catch {
      // A missing or unreadable file is an empty queue.
    }
  })();

  const remove = (taken: ReadonlySet<string | undefined>) => {
    entries = entries.filter((entry) => !taken.has(entry.item.uid));
  };

  const drain = async () => {
    await loaded;
    entries = bounded(entries);
    const failed = new Set<string>();
    for (;;) {
      const first = entries.find((entry) => !failed.has(entry.environmentId));
      if (first === undefined) break;
      const batch = entries
        .filter((entry) => entry.environmentId === first.environmentId)
        .slice(0, ANNOTATION_REPORT_MAX_ITEMS)
        .map((entry) => entry.item);
      let sent = false;
      try {
        sent = await options.send(first.environmentId, batch);
      } catch {
        sent = false;
      }
      if (sent) remove(new Set(batch.map((item) => item.uid)));
      else failed.add(first.environmentId);
    }
    await persist();
  };

  const flush = (): Promise<void> => {
    if (flushing !== null) {
      flushAgain = true;
      return flushing;
    }
    flushing = (async () => {
      do {
        flushAgain = false;
        await drain();
      } while (flushAgain);
    })()
      .catch(() => undefined)
      .finally(() => {
        flushing = null;
      });
    return flushing;
  };

  const add = async (entry: QueuedGlossOpen): Promise<void> => {
    entries = bounded([...entries, entry]);
    await loaded;
    await persist();
  };

  return { add, flush, pending: () => entries };
}
