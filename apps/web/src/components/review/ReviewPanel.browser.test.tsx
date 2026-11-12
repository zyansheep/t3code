import { AnnotationReportError, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";

type Request<I> = { readonly environmentId: string; readonly input: I };
type NextInput = {
  readonly exclude: ReadonlyArray<string>;
  readonly more?: boolean;
  readonly peek?: boolean;
  readonly newPerDay?: number;
};

// The collector, through the client's own server: each command answers from its mock.
const collector = vi.hoisted(() => ({
  next: vi.fn<(request: Request<NextInput>) => unknown>(),
  report: vi.fn<(request: Request<{ items: ReadonlyArray<Record<string, unknown>> }>) => unknown>(),
}));
vi.mock(import("../../state/annotationInteractions"), async (original) => {
  const { AnnotationReportError: ReportError } = await import("@t3tools/contracts");
  const { fail } = await import("effect/Cause");
  const { is } = await import("effect/Schema");
  const isReportError = is(ReportError);
  // An answer that is an AnnotationReportError, or another Error, fails the command with it.
  const command = <I,>(label: string, answer: (request: Request<I>) => unknown) =>
    ({
      label,
      run: async (_registry: unknown, request: Request<I>) => {
        const value = answer(request);
        return isReportError(value) || value instanceof Error
          ? AsyncResult.failure(fail(value))
          : AsyncResult.success(value);
      },
    }) as never;
  return {
    ...(await original()),
    nextAnnotationReview: command("test:next", (request: Request<NextInput>) =>
      collector.next(request),
    ),
    reportAnnotationInteractions: command(
      "test:report",
      (request: Request<{ items: ReadonlyArray<Record<string, unknown>> }>) =>
        collector.report(request),
    ),
    getAnnotationStatus: command("test:status", () => ({
      intensity: { level: 0, until: 0 },
      english: { on: false, until: 0, at: 0 },
    })),
  };
});
vi.mock(import("../../state/primaryEnvironment"), async () => {
  const { Atom } = await import("effect/reactivity");
  return { primaryEnvironmentIdAtom: Atom.make<string | null>(null) as never };
});

import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { ReviewPanel } from "./ReviewPanel";
import { ReviewPanelToggle } from "./ReviewPanelToggle";
import { flushReviewOutbox, reportReview } from "../../state/annotationReview";

const DAY = 86_400;
const MONDAI = {
  id: "c1",
  ja: "問題",
  kana: "もんだい",
  gloss: "problem",
  queue: "new",
  intervals: { again: 60, hard: 600, good: DAY, easy: 4 * DAY },
} as const;
const KAISHA = {
  ...MONDAI,
  id: "c2",
  ja: "会社",
  kana: "かいしゃ",
  gloss: "company",
  queue: "review",
  intervals: { again: 600, hard: 3 * DAY, good: 9 * DAY, easy: 36 * DAY },
} as const;
const ZERO = { new: 0, learning: 0, review: 0 };

type Answer = { card: typeof MONDAI | typeof KAISHA | null; counts?: typeof ZERO };

/** The collector serves these answers in order, then nothing due. */
function setup(...answers: Answer[]) {
  collector.next.mockReset();
  for (const answer of answers) collector.next.mockReturnValueOnce(answer);
  collector.next.mockReturnValue({ card: null, counts: ZERO });
  collector.report.mockReset();
}

function reviews() {
  return collector.report.mock.calls.flatMap(([request]) => request.input.items);
}

const renderPanel = (visible = true) => (
  <AppAtomRegistryProvider>
    <textarea aria-label="Composer" />
    <div className="flex h-96 flex-col">
      <ReviewPanel environmentId={EnvironmentId.make("environment-review")} visible={visible} />
    </div>
  </AppAtomRegistryProvider>
);

/** Waits for `word`'s card to be painted, which starts its timing. */
async function expectCardShown(word: string) {
  await expect.element(page.getByText(word, { exact: true })).toHaveAttribute("data-shown");
}

it("reveals on Space and grades by key and by click, reporting each card with its grade", async () => {
  setup(
    { card: MONDAI, counts: { new: 2, learning: 0, review: 1 } },
    // Asked for while the first card is shown, so it counts it.
    { card: KAISHA, counts: { new: 2, learning: 0, review: 1 } },
    { card: null, counts: { new: 1, learning: 0, review: 1 } },
  );
  await using _screen = await render(renderPanel());
  await expectCardShown("問題");
  expect(collector.next).toHaveBeenCalledWith({
    environmentId: "environment-review",
    input: { source: "desktop", exclude: [] },
  });
  await expect.element(page.getByText("2 new")).toHaveAttribute("aria-current", "true");
  await expect.element(page.getByText("1 to review")).not.toHaveAttribute("aria-current");
  expect(document.body.textContent).not.toContain("problem");

  await userEvent.click(page.getByText("問題", { exact: true }));
  await userEvent.keyboard(" ");
  await expect.element(page.getByText("problem")).toBeVisible();
  await expect.element(page.getByText("もんだい")).toBeVisible();
  for (const label of ["1m", "10m", "1d", "4d"]) {
    await expect.element(page.getByText(label, { exact: true })).toBeVisible();
  }
  expect(reviews()).toEqual([]);

  await userEvent.keyboard("1");
  await expectCardShown("会社");
  await vi.waitFor(() => expect(reviews()).toHaveLength(1));
  expect(reviews()[0]).toEqual({
    kind: "review",
    at: expect.any(Number),
    card: "c1",
    word: "問題",
    revealMs: expect.any(Number),
    shownMs: expect.any(Number),
    source: "desktop",
    uid: expect.any(String),
    grade: 1,
    gradeMs: expect.any(Number),
  });
  // The first card was new, so it is off the new count.
  await expect.element(page.getByText("1 new")).toBeVisible();
  await expect.element(page.getByText("1 to review")).toHaveAttribute("aria-current", "true");

  await userEvent.click(page.getByRole("button", { name: "Show answer" }));
  await expect.element(page.getByText("company")).toBeVisible();
  await expect.element(page.getByText("1.2mo")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Easy" }));
  await vi.waitFor(() => expect(reviews()).toHaveLength(2));
  expect(reviews()[1]).toMatchObject({ card: "c2", grade: 4 });
  expect(reviews()[1]!.uid).not.toBe(reviews()[0]!.uid);
  await expect.element(page.getByText("Done for today")).toBeVisible();
});

it("is done for today when nothing is due, and Review more asks again past the limit", async () => {
  setup({ card: null, counts: ZERO }, { card: MONDAI, counts: ZERO });
  await using _screen = await render(renderPanel());
  await expect.element(page.getByText("Done for today")).toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "Review more" }));
  await expectCardShown("問題");
  expect(collector.next).toHaveBeenNthCalledWith(2, {
    environmentId: "environment-review",
    input: { source: "desktop", exclude: [], more: true },
  });
  await vi.waitFor(() =>
    expect(collector.next).toHaveBeenLastCalledWith({
      environmentId: "environment-review",
      input: { source: "desktop", exclude: ["c1"], more: true },
    }),
  );
});

it("leaves keys typed in the composer alone", async () => {
  setup({ card: MONDAI, counts: { new: 1, learning: 0, review: 0 } });
  await using _screen = await render(renderPanel());
  await expectCardShown("問題");
  const composer = page.getByRole("textbox", { name: "Composer" });
  await userEvent.click(composer);
  await userEvent.keyboard(" 3{Enter}");
  await expect.element(composer).toHaveValue(" 3\n");
  expect(document.body.textContent).not.toContain("problem");
  await expect.element(page.getByRole("button", { name: "Show answer" })).toBeVisible();
  expect(reviews()).toEqual([]);
});

it("sets new cards a day from its menu, where keys typed grade nothing", async () => {
  setup();
  let limit = 10;
  collector.next.mockImplementation(({ input }) => {
    if (input.newPerDay !== undefined) limit = input.newPerDay;
    const counts = { new: 1, learning: 0, review: 0 };
    return collector.next.mock.calls.length === 1
      ? { card: MONDAI, counts, newPerDay: limit }
      : { card: null, counts, newPerDay: limit };
  });
  await using _screen = await render(renderPanel());
  await expectCardShown("問題");
  await userEvent.click(page.getByRole("button", { name: "Show answer" }));
  await userEvent.click(page.getByRole("button", { name: "Review settings" }));
  const field = page.getByLabelText("New cards a day");
  await expect.element(field).toHaveValue("10");
  await userEvent.clear(field);
  await userEvent.type(field, "25{Enter}");
  await vi.waitFor(() =>
    expect(collector.next).toHaveBeenCalledWith({
      environmentId: "environment-review",
      input: { source: "desktop", exclude: [], peek: true, newPerDay: 25 },
    }),
  );
  await expect.element(field).toHaveValue("25");
  await expect.element(page.getByText("problem")).toBeVisible();
  expect(reviews()).toEqual([]);
});

it("reports the card on screen as left when the panel closes, and hands back the next one it never showed", async () => {
  setup(
    { card: MONDAI, counts: { new: 2, learning: 0, review: 0 } },
    { card: KAISHA, counts: { new: 2, learning: 0, review: 0 } },
  );
  await using screen = await render(renderPanel());
  await expectCardShown("問題");
  await vi.waitFor(() => expect(collector.next).toHaveBeenCalledTimes(2));
  await userEvent.click(page.getByRole("button", { name: "Show answer" }));
  await expect.element(page.getByText("problem")).toBeVisible();

  await screen.rerender(renderPanel(false));
  await vi.waitFor(() => expect(reviews()).toHaveLength(1));
  expect(reviews()[0]).toMatchObject({ card: "c1", revealMs: expect.any(Number) });
  expect(reviews()[0]).not.toHaveProperty("grade");

  await screen.rerender(renderPanel(true));
  await vi.waitFor(() => expect(collector.next).toHaveBeenCalledTimes(3));
  expect(collector.next).toHaveBeenLastCalledWith({
    environmentId: "environment-review",
    input: { source: "desktop", exclude: [], release: ["c2"] },
  });
});

it("shows the cards due beside the header button, read with a peek that serves no card", async () => {
  setup();
  collector.next.mockReturnValue({ card: null, counts: { new: 12, learning: 3, review: 40 } });
  const onToggle = vi.fn();
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <ReviewPanelToggle
        environmentId={EnvironmentId.make("environment-badge")}
        open={false}
        shortcutLabel="Alt+Shift+R"
        onToggle={onToggle}
      />
    </AppAtomRegistryProvider>,
  );
  const toggle = page.getByRole("button", { name: "Toggle review panel, 55 due" });
  await expect.element(toggle).toBeVisible();
  expect(collector.next).toHaveBeenCalledExactlyOnceWith({
    environmentId: "environment-badge",
    input: { source: "desktop", exclude: [], peek: true },
  });
  await userEvent.click(toggle);
  expect(onToggle).toHaveBeenCalledOnce();
});

const NOW = Date.UTC(2026, 10, 5, 12, 0);
const DAY_MS = 86_400_000;

/** A fixed clock for when reports were queued, with real timers. */
function systemTime(now: number): Disposable {
  vi.setSystemTime(now);
  return { [Symbol.dispose]: () => void vi.useRealTimers() };
}

const graded = (uid: string) =>
  ({
    kind: "review",
    at: NOW,
    card: `card-${uid}`,
    word: "問題",
    revealMs: 900,
    shownMs: 2_000,
    grade: 3,
    gradeMs: 2_000,
    source: "desktop",
    uid,
  }) as const;

const outbox = (environment: string) =>
  JSON.parse(
    localStorage.getItem(`t3code:annotation-review-outbox:v1:${environment}`) ?? "[]",
  ) as Array<{
    item: { uid: string };
  }>;
const sent = () =>
  collector.report.mock.calls.map(([request]) => request.input.items.map((item) => item.uid));

it("keeps a review report that may not have arrived across a reload, and sends it again under its uid", async () => {
  using _clock = systemTime(NOW);
  setup();
  const environment = EnvironmentId.make("environment-outbox");
  collector.report.mockReturnValueOnce(
    new AnnotationReportError({ detail: "collector unreachable", retryable: true }),
  );
  expect(await reportReview(environment, graded("u1"))).toBe("failed");
  expect(outbox(environment).map((entry) => entry.item.uid)).toEqual(["u1"]);

  // After a reload only the outbox is left; the next start sends it again.
  await flushReviewOutbox(environment);
  expect(sent()).toEqual([["u1"], ["u1"]]);
  expect(outbox(environment)).toEqual([]);
});

it("settles each report in a batch by index, and keeps only the newest 200 of the last 7 days", async () => {
  using _clock = systemTime(NOW);
  setup();
  const environment = "environment-outbox-batch";
  const queued = [
    { item: graded("stale"), queuedAt: NOW - 8 * DAY_MS },
    ...Array.from({ length: 202 }, (_, index) => ({
      item: graded(`u${index}`),
      queuedAt: NOW - 202 + index,
    })),
  ];
  localStorage.setItem(`t3code:annotation-review-outbox:v1:${environment}`, JSON.stringify(queued));

  collector.report.mockReturnValue(
    new AnnotationReportError({ detail: "collector answered 502", retryable: true }),
  );
  await flushReviewOutbox(EnvironmentId.make(environment));
  expect(sent()).toEqual([Array.from({ length: 50 }, (_, index) => `u${index + 2}`)]);
  expect(outbox(environment)).toHaveLength(200);
  expect(outbox(environment)[0]!.item.uid).toBe("u2");

  // The collector refuses the second of each batch for good and stores the rest: nothing is left to send.
  collector.report.mockReturnValue(
    new AnnotationReportError({
      detail: "collector rejected 1 of 50: card released unshown",
      retryable: false,
      rejected: [{ item: 1, error: "card released unshown" }],
    }),
  );
  await flushReviewOutbox(EnvironmentId.make(environment));
  expect(sent()).toHaveLength(5);
  expect(outbox(environment)).toEqual([]);
  expect(await reportReview(EnvironmentId.make(environment), graded("lone"))).toBe("stored");
});

const queue = (environment: string, ...uids: string[]) =>
  localStorage.setItem(
    `t3code:annotation-review-outbox:v1:${environment}`,
    JSON.stringify(uids.map((uid) => ({ item: graded(uid), queuedAt: NOW }))),
  );

it("settles reports against the outbox as it stands in storage, sending what another window added", async () => {
  using _clock = systemTime(NOW);
  setup();
  const environment = "environment-outbox-windows";
  queue(environment, "u1");
  collector.report.mockImplementationOnce(() => {
    // Another window queues a report while this one's batch is out.
    queue(environment, "u1", "u2");
    return {};
  });
  collector.report.mockReturnValue({});
  await flushReviewOutbox(EnvironmentId.make(environment));
  expect(sent()).toEqual([["u1"], ["u2"]]);
  expect(outbox(environment)).toEqual([]);
});

it("sends a batch refused for another reason one report at a time, and drops a report refused alone 5 times", async () => {
  using _clock = systemTime(NOW);
  setup();
  const environment = "environment-outbox-refused";
  queue(environment, "bad", "good");
  collector.report.mockImplementation(({ input }) =>
    input.items.some((item) => item.uid === "bad") ? new Error("invalid report") : {},
  );
  await flushReviewOutbox(EnvironmentId.make(environment));
  expect(sent()).toEqual([["bad", "good"], ["bad"], ["good"]]);
  expect(outbox(environment).map((entry) => entry.item.uid)).toEqual(["bad"]);
  for (let flush = 0; flush < 4; flush += 1)
    await flushReviewOutbox(EnvironmentId.make(environment));
  expect(sent()).toHaveLength(7);
  expect(outbox(environment)).toEqual([]);

  // A dropped connection says nothing about the report: it stays, uncounted, for the next flush.
  collector.report.mockReturnValue(new Error("Socket is not connected"));
  expect(await reportReview(EnvironmentId.make(environment), graded("offline"))).toBe("failed");
  for (let flush = 0; flush < 6; flush += 1)
    await flushReviewOutbox(EnvironmentId.make(environment));
  expect(outbox(environment).map((entry) => entry.item.uid)).toEqual(["offline"]);
});
