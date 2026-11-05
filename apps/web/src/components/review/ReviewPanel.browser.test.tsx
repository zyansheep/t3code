import { EnvironmentId } from "@t3tools/contracts";
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
};

// The collector, through the client's own server: each command answers from its mock.
const collector = vi.hoisted(() => ({
  next: vi.fn<(request: Request<NextInput>) => unknown>(),
  report: vi.fn<(request: Request<{ items: ReadonlyArray<Record<string, unknown>> }>) => void>(),
}));
vi.mock(import("../../state/annotationInteractions"), async (original) => {
  const command = <I,>(label: string, answer: (request: Request<I>) => unknown) =>
    ({
      label,
      run: async (_registry: unknown, request: Request<I>) => AsyncResult.success(answer(request)),
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
