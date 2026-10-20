import type { AnnotationReading } from "@t3tools/contracts";

/**
 * Where a reader was in chat messages with `<abbr>` annotations, for the collector that also receives popover opens
 * (`reportAnnotationInteractions`): clicks, text selections, mouse paths, each paragraph's stays on screen, and each
 * message's word count the first time it is on screen (`shown`). Positions, times and counts only, never text. One set
 * of document listeners serves every registered message.
 *
 * A stay's `ms` counts only time a reader could have spent reading: the window visible and focused, no sound or video
 * playing, and some input in the last `IDLE_MS`. The rest of its time on screen goes to `away`, `media` or `idle`. A stay
 * with no reading for `PAUSE_MS` ends there (the reader left, or left it open), and the next input starts a new one.
 */

export const ANNOTATION_SELECTOR = "abbr[data-markdown-abbreviation]";
const ANNOTATION_TEXT_MAX_LENGTH = 40;
const ANNOTATION_MAX_COUNT = 200;
export const IDLE_MS = 30_000;
const GAP_MS = 3_000; // a longer gap between ticks means throttled timers or a sleeping machine
const STAY_MIN_MS = 1_000; // a shorter stay was a scroll past
const STAY_MAX_MS = 600_000; // a longer one is sent in parts
export const PAUSE_MS = 60_000;
const TRACE_STEP_MS = 100;
const TRACE_STEP_PX = 4;
const TRACE_MAX_POINTS = 200;
const TRACE_MAX_MS = 15_000;
const TRACE_PAUSE_MS = 3_000;
const CLICK_GAP_MS = 300;
const FLUSH_MS = 5_000;
const BATCH_MAX = 50;
const BLOCK_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, dt, dd";
// Code, and text the message doesn't say (a code block's title, an alert's label, controls).
const UNCOUNTED_SELECTOR = 'pre, code, kbd, svg, [data-thread-find-ignore], [role="toolbar"]';
const LATIN = String.raw`(?:(?![\p{scx=Han}\p{scx=Hira}\p{scx=Kana}])[\p{L}\p{N}])+`;
const WORD = new RegExp(`${LATIN}(?:['’-]${LATIN})*`, "gu");
const WORDLIKE = /[\p{L}\p{N}]/u;
const SHOWN_MAX_WORDS = 10_000;
const CONTROL_SELECTOR =
  'a[href], button, input, select, textarea, summary, label, [role="button"], [role="link"]';

type Report = (items: ReadonlyArray<AnnotationReading>) => void;
type Place = Pick<AnnotationReading, "box" | "annotations">;

export interface ReadingMessage {
  readonly container: HTMLElement;
  readonly view: string;
  readonly context: string;
  readonly report: Report;
}

export interface Stay {
  at: number;
  last: number;
  lastRead: number;
  wall: number;
  ms: number;
  away: number;
  media: number;
  idle: number;
}

export interface ReadingState {
  readonly away: boolean;
  readonly media: boolean;
  readonly idle: boolean;
}

/** The message's annotations in order, with the box and positions every item carries. */
export function describeAnnotations(container: HTMLElement) {
  const triggers = [...container.querySelectorAll(ANNOTATION_SELECTOR)]
    .map((trigger) => ({ trigger, text: trigger.textContent?.trim() ?? "" }))
    .filter((entry) => entry.text.length > 0 && entry.text.length <= ANNOTATION_TEXT_MAX_LENGTH)
    .slice(0, ANNOTATION_MAX_COUNT);
  const box = container.getBoundingClientRect();
  const place: Place = {
    box: [box.left, box.top, box.width, box.height],
    annotations: triggers.map(({ trigger, text }) => {
      const rect = trigger.getBoundingClientRect();
      return [text, rect.left - box.left, rect.top - box.top] as const;
    }),
  };
  return { triggers, rect: box, place };
}

/**
 * The words a reader reads in an element: Latin-script words in its text outside code, plus one per annotation with a
 * letter or digit in it (one of only punctuation, like 。, translates a sentence). Japanese outside annotations, such as
 * particles, is not counted.
 */
export function countWords(el: Element): number {
  let words = 0;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      const element = node as Element;
      if (element.matches(ANNOTATION_SELECTOR)) {
        if (WORDLIKE.test(element.textContent ?? "")) words += 1;
        return NodeFilter.FILTER_REJECT;
      }
      return element.matches(UNCOUNTED_SELECTOR)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_SKIP;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    words += node.nodeValue?.match(WORD)?.length ?? 0;
  }
  return words;
}

export function readingState(
  page: { hidden: boolean; focused: boolean; playing: boolean; lastInput: number },
  now: number,
): ReadingState {
  const away = page.hidden || !page.focused;
  const media = !away && page.playing;
  return { away, media, idle: !away && !media && now - page.lastInput > IDLE_MS };
}

/** Adds the time since the stay's last tick to one bucket: away, media, idle, or ms (reading). */
export function account(stay: Stay, now: number, state: ReadingState): Stay {
  const dt = Math.max(0, now - stay.last);
  stay.last = now;
  stay.wall += dt;
  const bucket =
    state.away || dt > GAP_MS ? "away" : state.media ? "media" : state.idle ? "idle" : "ms";
  stay[bucket] += dt;
  if (bucket === "ms") stay.lastRead = now;
  return stay;
}

export const newStay = (now: number): Stay => ({
  at: now,
  last: now,
  lastRead: now,
  wall: 0,
  ms: 0,
  away: 0,
  media: 0,
  idle: 0,
});

/** Whether a mouse position is worth a point: far enough in time and space from the last one. */
export function tracePoint(
  last: readonly [number, number, number] | undefined,
  point: readonly [number, number, number],
): boolean {
  if (!last) return true;
  return (
    point[0] - last[0] >= TRACE_STEP_MS &&
    Math.hypot(point[1] - last[1], point[2] - last[2]) >= TRACE_STEP_PX
  );
}

interface Registered extends ReadingMessage {
  readonly blocks: Set<Element>;
}
interface BlockStay extends Stay {
  readonly message: Registered;
  readonly snapshot: { place: Place; y: number; height: number; words: number };
}
interface Trace {
  readonly message: Registered;
  readonly at: number;
  readonly points: Array<[number, number, number]>;
}

const messages = new Map<HTMLElement, Registered>();
const blockOwners = new Map<Element, Registered>();
const inView = new Set<Element>();
const stays = new Map<Element, BlockStay>();
const playing = new Set<HTMLMediaElement>();
const queue = new Map<Report, AnnotationReading[]>();
const shown = new Set<string>(); // view and context of each message sent as shown, so a remount doesn't resend it
let observer: IntersectionObserver | null = null;
let listening = false;
let lastInput = Date.now();
let pressedAt = 0;
let lastClick = 0;
let lastRange: Range | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let trace: Trace | null = null;
let traceTimer: ReturnType<typeof setTimeout> | null = null;

const audible = () =>
  [...playing].some((m) => m.isConnected && !m.paused && !m.ended && !m.muted && m.volume > 0);
const stateNow = (now: number) =>
  readingState(
    {
      hidden: document.visibilityState === "hidden",
      focused: document.hasFocus(),
      playing: audible(),
      lastInput,
    },
    now,
  );

function enqueue(message: ReadingMessage, item: AnnotationReading) {
  const items = queue.get(message.report) ?? [];
  items.push(item);
  queue.set(message.report, items);
  flushTimer ??= setTimeout(flush, FLUSH_MS);
}

/** Sends everything queued, in batches the report contract accepts. */
export function flush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  for (const [report, items] of queue) {
    for (let start = 0; start < items.length; start += BATCH_MAX) {
      report(items.slice(start, start + BATCH_MAX));
    }
  }
  queue.clear();
}

function ownerOf(target: EventTarget | null): Registered | null {
  for (let el = target instanceof Element ? target : null; el; el = el.parentElement) {
    const message = messages.get(el as HTMLElement);
    if (message) return message;
  }
  return null;
}

function base(message: Registered, at: number, place: Place) {
  return { at, view: message.view, context: message.context, ...place };
}

// ---- clicks and selections ----

function onClick(event: MouseEvent) {
  const message = ownerOf(event.target);
  const now = Date.now();
  if (!message || event.button !== 0 || now - lastClick < CLICK_GAP_MS) return;
  const target = event.target as Element;
  if (target.closest(ANNOTATION_SELECTOR) || !document.getSelection()?.isCollapsed) return; // a pin, or a selection's end
  lastClick = now;
  const { rect, place } = describeAnnotations(message.container);
  enqueue(message, {
    ...base(message, now, place),
    kind: "click",
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
    target: target.closest(CONTROL_SELECTOR) ? "link" : "text",
  });
}

function sameRange(a: Range, b: Range | null) {
  try {
    return !!b && a.compareBoundaryPoints(0, b) === 0 && a.compareBoundaryPoints(2, b) === 0; // start, end
  } catch {
    return false; // b's nodes left the document
  }
}

// After a mouse drag, a double or triple click, or Shift with the arrow keys. Over more than three messages it is a
// select-all, not reading.
function onSelectionEnd(event: MouseEvent | KeyboardEvent) {
  if (event instanceof KeyboardEvent && !event.shiftKey && event.key !== "Shift") return;
  const startedAt = event instanceof MouseEvent ? pressedAt : 0;
  setTimeout(() => {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (sameRange(range, lastRange)) return;
    const chars = selection.toString().length; // a count only
    const touched = [...messages.values()].filter((m) => range.intersectsNode(m.container));
    if (chars === 0 || touched.length === 0 || touched.length > 3) return;
    lastRange = range.cloneRange();
    const now = Date.now();
    const box =
      typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
    for (const message of touched) {
      const { triggers, rect, place } = describeAnnotations(message.container);
      enqueue(message, {
        ...base(message, now, place),
        kind: "select",
        x: (box?.left ?? rect.left) - rect.left,
        y: (box?.top ?? rect.top) - rect.top,
        width: box?.width ?? 0,
        height: box?.height ?? 0,
        chars,
        covered: triggers.flatMap(({ trigger }, index) =>
          range.intersectsNode(trigger) ? [index] : [],
        ),
        ms: startedAt ? Math.max(0, now - startedAt) : 0,
      });
    }
  }, 0);
}

// ---- mouse paths ----

function endTrace() {
  if (traceTimer) clearTimeout(traceTimer);
  traceTimer = null;
  const done = trace;
  trace = null;
  if (!done || done.points.length < 2 || !messages.has(done.message.container)) return;
  const { place } = describeAnnotations(done.message.container);
  enqueue(done.message, {
    ...base(done.message, done.at, place),
    kind: "trace",
    points: done.points,
  });
}

function onPointer(event: PointerEvent | WheelEvent) {
  lastInput = Date.now();
  resumeStays();
  if ("pointerType" in event && event.pointerType === "touch") return;
  const message =
    trace && trace.message.container.contains(event.target as Node)
      ? trace.message
      : ownerOf(event.target);
  if (trace && trace.message !== message) endTrace();
  if (!message) return;
  const now = Date.now();
  const rect = message.container.getBoundingClientRect();
  trace ??= { message, at: now, points: [] };
  const point: [number, number, number] = [
    now - trace.at,
    Math.round(event.clientX - rect.left),
    Math.round(event.clientY - rect.top),
  ];
  if (!tracePoint(trace.points.at(-1), point)) return;
  trace.points.push(point);
  if (trace.points.length >= TRACE_MAX_POINTS || point[0] >= TRACE_MAX_MS) return endTrace();
  if (traceTimer) clearTimeout(traceTimer);
  traceTimer = setTimeout(endTrace, TRACE_PAUSE_MS);
}

// ---- stays on screen ----

function band(block: Element, container: HTMLElement) {
  const rect = block.getBoundingClientRect();
  return { y: rect.top - container.getBoundingClientRect().top, height: rect.height };
}

function startStay(block: Element) {
  const message = blockOwners.get(block);
  if (!message || stays.has(block) || document.visibilityState === "hidden") return;
  const now = Date.now();
  const snapshot = {
    place: describeAnnotations(message.container).place,
    ...band(block, message.container),
    words: countWords(block),
  };
  stays.set(block, { ...newStay(now), message, snapshot });
  ticker ??= setInterval(tick, 1_000);
  const key = `${message.view} ${message.context}`;
  if (shown.has(key)) return;
  shown.add(key);
  const words = Math.min(countWords(message.container), SHOWN_MAX_WORDS);
  if (words > 0) enqueue(message, { ...base(message, now, snapshot.place), kind: "shown", words });
}

function endStay(block: Element) {
  const stay = stays.get(block);
  if (!stay) return;
  const now = Date.now();
  account(stay, now, stateNow(now));
  stays.delete(block);
  if (stays.size === 0 && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
  if (stay.ms < STAY_MIN_MS) return;
  const { message } = stay;
  const fresh = block.isConnected && message.container.isConnected;
  const place = fresh ? describeAnnotations(message.container).place : stay.snapshot.place;
  const where = fresh ? band(block, message.container) : stay.snapshot;
  enqueue(message, {
    ...base(message, stay.at, place),
    kind: "visible",
    y: where.y,
    height: where.height,
    words: fresh ? countWords(block) : stay.snapshot.words,
    ms: stay.ms,
    wall: stay.wall,
    away: stay.away,
    media: stay.media,
    idle: stay.idle,
  });
}

function tick() {
  const now = Date.now();
  const state = stateNow(now);
  const full: Element[] = [];
  const left: Element[] = [];
  for (const [block, stay] of stays) {
    account(stay, now, state);
    if (stay.wall >= STAY_MAX_MS) full.push(block);
    else if (now - stay.lastRead > PAUSE_MS) left.push(block);
  }
  for (const block of full) {
    endStay(block);
    startStay(block);
  }
  for (const block of left) endStay(block);
}

// After a pause ended them, the paragraphs still on screen get new stays once the reader is back.
function resumeStays() {
  if (stays.size < inView.size) for (const block of inView) startStay(block);
}

// Half of a paragraph on screen, or for a taller one, enough of it to fill 40% of the window.
function onIntersection(entries: IntersectionObserverEntry[]) {
  for (const entry of entries) {
    const viewport = entry.rootBounds?.height ?? window.innerHeight;
    const enough =
      entry.isIntersecting &&
      (entry.intersectionRatio >= 0.5 || entry.intersectionRect.height >= 0.4 * viewport);
    if (enough) {
      inView.add(entry.target);
      startStay(entry.target);
    } else {
      inView.delete(entry.target);
      endStay(entry.target);
    }
  }
}

function onVisibility() {
  if (document.visibilityState === "hidden") {
    for (const block of stays.keys()) endStay(block);
    endTrace();
    flush();
  } else {
    for (const block of inView) startStay(block);
  }
}

function onMedia(event: Event) {
  const media = event.target;
  if (!(media instanceof HTMLMediaElement)) return;
  if (!media.paused && !media.ended) playing.add(media);
  else playing.delete(media);
}

function noteInput() {
  lastInput = Date.now();
  resumeStays();
}

function listen() {
  if (listening) return;
  listening = true;
  const passive = { capture: true, passive: true } as const;
  document.addEventListener("click", onClick, passive);
  document.addEventListener("mousedown", () => (pressedAt = Date.now()), passive);
  document.addEventListener("mouseup", onSelectionEnd, passive);
  document.addEventListener("keyup", onSelectionEnd, passive);
  document.addEventListener("pointermove", onPointer, passive);
  document.addEventListener("wheel", onPointer, passive);
  for (const type of ["pointerdown", "keydown", "touchstart"]) {
    document.addEventListener(type, noteInput, passive);
  }
  for (const type of ["play", "playing", "pause", "ended", "emptied"]) {
    document.addEventListener(type, onMedia, true);
  }
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", () => {
    for (const block of stays.keys()) endStay(block);
    endTrace();
    flush();
  });
  if (typeof IntersectionObserver !== "undefined") {
    observer = new IntersectionObserver(onIntersection, {
      threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1],
    });
  }
}

/**
 * Starts reporting reading signals for one rendered message; the returned function stops it, sending what its
 * paragraphs' stays and mouse path have gathered. Paragraphs are the innermost blocks with an annotation.
 */
export function registerReadingMessage(message: ReadingMessage): () => void {
  listen();
  const blocks = new Set(
    [...message.container.querySelectorAll(BLOCK_SELECTOR)].filter(
      (block) => !block.querySelector(BLOCK_SELECTOR) && block.querySelector(ANNOTATION_SELECTOR),
    ),
  );
  const registered: Registered = { ...message, blocks };
  messages.set(message.container, registered);
  for (const block of blocks) {
    blockOwners.set(block, registered);
    observer?.observe(block);
  }
  return () => {
    for (const block of blocks) {
      endStay(block);
      inView.delete(block);
      blockOwners.delete(block);
      observer?.unobserve(block);
    }
    if (trace?.message === registered) endTrace();
    messages.delete(message.container);
  };
}
