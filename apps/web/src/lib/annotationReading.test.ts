// @vitest-environment jsdom
import type { AnnotationReading } from "@t3tools/contracts";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import {
  IDLE_MS,
  PAUSE_MS,
  account,
  flush,
  newStay,
  readingState,
  registerReadingMessage,
  tracePoint,
} from "./annotationReading";

class FakeIntersectionObserver {
  static last: FakeIntersectionObserver | null = null;
  constructor(readonly callback: (entries: Array<Partial<IntersectionObserverEntry>>) => void) {
    FakeIntersectionObserver.last = this;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  show(target: Element, on: boolean) {
    this.callback([
      {
        target,
        isIntersecting: on,
        intersectionRatio: on ? 1 : 0,
        intersectionRect: { height: on ? 20 : 0 } as DOMRectReadOnly,
        rootBounds: { height: 800 } as DOMRectReadOnly,
      },
    ]);
  }
}

const page = { hidden: false, focused: true, playing: false, lastInput: 0 };

describe("on-screen time", () => {
  it("counts only time a reader could spend reading; the rest by why not", () => {
    const stay = newStay(0);
    account(stay, 1_000, readingState(page, 1_000));
    account(stay, 2_000, readingState({ ...page, focused: false }, 2_000));
    account(stay, 3_000, readingState({ ...page, hidden: true }, 3_000));
    account(stay, 4_000, readingState({ ...page, playing: true }, 4_000));
    account(stay, 5_000, readingState(page, IDLE_MS + 4_500));
    account(stay, 60_000, readingState(page, 60_000)); // throttled timers or a sleep
    expect(stay).toMatchObject({
      wall: 60_000,
      ms: 1_000,
      away: 57_000,
      media: 1_000,
      idle: 1_000,
    });
  });

  it("keeps a mouse point only when it moved far enough, late enough", () => {
    expect(tracePoint(undefined, [0, 5, 5])).toBe(true);
    expect(tracePoint([0, 5, 5], [50, 40, 5])).toBe(false);
    expect(tracePoint([0, 5, 5], [150, 6, 6])).toBe(false);
    expect(tracePoint([0, 5, 5], [150, 40, 5])).toBe(true);
  });
});

describe("reading signals in a message", () => {
  const report = vi.fn<(items: ReadonlyArray<AnnotationReading>) => void>();
  let container: HTMLElement;
  let stop: () => void;

  beforeAll(() => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  });

  const setup = () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    report.mockClear();
    container = document.createElement("div");
    container.innerHTML =
      '<p id="first">Read the <abbr data-markdown-abbreviation="">CSP</abbr> notes.</p>' +
      '<p id="second">Then set <abbr data-markdown-abbreviation="">HSTS</abbr> <a href="#x">here</a>.</p>' +
      "<p>No annotation in this one.</p>";
    document.body.append(container);
    stop = registerReadingMessage({ container, view: "v1", context: "m1", report });
  };
  const sent = () => {
    flush();
    return report.mock.calls.flatMap(([items]) => items);
  };

  afterEach(() => {
    stop();
    container.remove();
    document.getSelection()?.removeAllRanges();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reports clicks by position and what they hit, but not annotation clicks", () => {
    setup();
    const link = container.querySelector("a")!;
    container
      .querySelector("#first")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 30, clientY: 8 }));
    vi.advanceTimersByTime(400);
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 90, clientY: 30 }));
    vi.advanceTimersByTime(400);
    container.querySelector("abbr")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const items = sent();
    expect(items.map((item) => item.kind === "click" && [item.x, item.y, item.target])).toEqual([
      [30, 8, "text"],
      [90, 30, "link"],
    ]);
    expect(items[0]).toMatchObject({
      view: "v1",
      context: "m1",
      annotations: [
        ["CSP", 0, 0],
        ["HSTS", 0, 0],
      ],
    });
  });

  it("reports a selection once, with its length and the annotations it covered, never its text", () => {
    setup();
    const range = document.createRange();
    range.selectNodeContents(container.querySelector("#second")!);
    document.getSelection()!.addRange(range);
    document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    vi.advanceTimersByTime(250);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    vi.advanceTimersByTime(1);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    vi.advanceTimersByTime(1);
    const items = sent();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "select",
      chars: "Then set HSTS here.".length,
      covered: [1],
      ms: 250,
    });
    expect(JSON.stringify(items)).not.toContain("Then set");
  });

  it("reports a mouse path over the message when the pointer leaves it", () => {
    setup();
    const first = container.querySelector("#first")!;
    for (const [x, y] of [
      [10, 5],
      [40, 6],
      [80, 8],
    ] as const) {
      first.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: x, clientY: y }));
      vi.advanceTimersByTime(150);
    }
    document.body.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 500, clientY: 500 }),
    );
    const [trace] = sent();
    expect(trace).toMatchObject({
      kind: "trace",
      points: [
        [0, 10, 5],
        [150, 40, 6],
        [300, 80, 8],
      ],
    });
  });

  it("reports a paragraph's stay on screen, idle time apart, and not a scroll past", () => {
    setup();
    const observer = FakeIntersectionObserver.last!;
    const first = container.querySelector("#first")!;
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
    observer.show(first, true);
    vi.advanceTimersByTime(IDLE_MS + 10_000); // read, then left it open
    observer.show(first, false);
    observer.show(first, true);
    vi.advanceTimersByTime(300);
    observer.show(first, false);
    const items = sent();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "visible",
      ms: IDLE_MS,
      idle: 10_000,
      away: 0,
      wall: IDLE_MS + 10_000,
    });
  });

  it("ends a stay once nothing was read for a while, and starts a new one when the reader is back", () => {
    setup();
    const observer = FakeIntersectionObserver.last!;
    const first = container.querySelector("#first")!;
    const focus = vi.spyOn(document, "hasFocus");
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
    observer.show(first, true);
    vi.advanceTimersByTime(5_000);
    focus.mockReturnValue(false); // another window, with this one still showing
    vi.advanceTimersByTime(PAUSE_MS + 30_000);
    focus.mockReturnValue(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
    vi.advanceTimersByTime(3_000);
    observer.show(first, false);
    const items = sent();
    expect(items.map((item) => item.kind === "visible" && item.ms)).toEqual([5_000, 3_000]);
    const [left] = items;
    expect(left).toMatchObject({ kind: "visible", idle: 0 });
    expect(left?.kind === "visible" && left.wall).toBeLessThan(5_000 + PAUSE_MS + 2_000); // not the whole time away
  });
});
