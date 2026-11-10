import { AnnotationIntensityError, type AnnotationStatus, EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";

type Request<I> = { readonly environmentId: string; readonly input: I };
type Answer = AsyncResult.AsyncResult<unknown, unknown>;

// The collector, through the client's own server: each command answers from its mock.
const collector = vi.hoisted(() => ({
  status: vi.fn<(request: Request<object>) => Answer>(),
  english: vi.fn<(request: Request<{ on: boolean }>) => Answer>(),
  step: vi.fn<(request: Request<{ step: 1 | -1; surface?: "chat" | "sentences" }>) => Answer>(),
}));
vi.mock(import("../../state/annotationInteractions"), async (original) => {
  const command = <I,>(label: string, answer: (request: Request<I>) => Answer) =>
    ({ label, run: async (_registry: unknown, request: Request<I>) => answer(request) }) as never;
  return {
    ...(await original()),
    getAnnotationStatus: command<object>("test:status", (request) => collector.status(request)),
    setAnnotationEnglish: command("test:english", (request: Request<{ on: boolean }>) =>
      collector.english(request),
    ),
    adjustAnnotationIntensity: command(
      "test:step",
      (request: Request<{ step: 1 | -1; surface?: "chat" | "sentences" }>) =>
        collector.step(request),
    ),
  };
});
vi.mock(import("../../state/primaryEnvironment"), async () => {
  const { Atom } = await import("effect/reactivity");
  return { primaryEnvironmentIdAtom: Atom.make<string | null>(null) as never };
});

import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { ThreadJapanesePanel } from "./ThreadJapanesePanel";

const NOW = Date.UTC(2026, 10, 4, 12, 0);
const MINUTE = 60_000;

/** A fixed clock for the minutes left, with real timers. */
function systemTime(now: number): Disposable {
  vi.setSystemTime(now);
  return { [Symbol.dispose]: () => void vi.useRealTimers() };
}

function setup(status: AnnotationStatus) {
  collector.status.mockReset().mockReturnValue(AsyncResult.success(status));
  collector.english
    .mockReset()
    .mockImplementation(({ input }) =>
      AsyncResult.success({ on: input.on, until: input.on ? NOW + 60 * MINUTE : 0, at: NOW }),
    );
  const levels = { chat: status.intensity.level, sentences: status.sentences?.level ?? 0 };
  collector.step.mockReset().mockImplementation(({ input }) => {
    const level = (levels[input.surface ?? "chat"] += input.step);
    return AsyncResult.success({ level, until: level === 0 ? 0 : NOW + 180 * MINUTE });
  });
}

// Each test has its own server, since the status store keeps what it read for the app's lifetime.
const renderPanel = (environment: string) =>
  render(
    <AppAtomRegistryProvider>
      <ThreadJapanesePanel environmentId={EnvironmentId.make(environment)} />
    </AppAtomRegistryProvider>,
  );

it("shows nothing when the server has no collector", async () => {
  setup({ intensity: { level: 0, until: 0 }, english: { on: false, until: 0, at: 0 } });
  collector.status.mockReturnValue(
    AsyncResult.failure(Cause.fail(new AnnotationIntensityError({ detail: "not configured" }))),
  );
  await using screen = await renderPanel("environment-unconfigured");
  await vi.waitFor(() => expect(collector.status).toHaveBeenCalled());
  expect(screen.container.textContent).toBe("");
});

it("shows English only's time left and turns it off and on", async () => {
  using _clock = systemTime(NOW);
  setup({
    intensity: { level: 0, until: 0 },
    english: { on: true, until: NOW + 42 * MINUTE, at: NOW },
  });
  await using _screen = await renderPanel("environment-english");
  await expect.element(page.getByRole("heading", { name: "Japanese" })).toBeVisible();
  await expect.element(page.getByText("On · 42 min left")).toBeVisible();
  const toggle = page.getByRole("switch", { name: /English only/ });
  await expect.element(toggle).toBeChecked();

  // The whole row is the switch's label.
  await userEvent.click(page.getByText("English only"));
  await expect.element(page.getByText("Off", { exact: true })).toBeVisible();
  await expect.element(toggle).not.toBeChecked();
  expect(collector.english).toHaveBeenCalledExactlyOnceWith({
    environmentId: "environment-english",
    input: { on: false, contexts: [] },
  });

  await userEvent.click(toggle);
  await expect.element(page.getByText("On · 1 hour left")).toBeVisible();
  expect(collector.english).toHaveBeenCalledTimes(2);
  expect(collector.english).toHaveBeenLastCalledWith({
    environmentId: "environment-english",
    input: { on: true, contexts: [] },
  });
});

it("steps the level with its chevrons, between much lighter and full", async () => {
  using _clock = systemTime(NOW);
  setup({
    intensity: { level: -1, until: NOW + 90 * MINUTE },
    english: { on: false, until: 0, at: 0 },
  });
  await using _screen = await renderPanel("environment-level");
  await expect.element(page.getByText("lighter", { exact: true })).toBeVisible();
  await expect.element(page.getByText("1 h 30 min left")).toBeVisible();
  const lighter = page.getByRole("button", { name: "Lighter" });
  const heavier = page.getByRole("button", { name: "Heavier" });

  await userEvent.click(lighter);
  await expect.element(page.getByText("much lighter")).toBeVisible();
  await expect.element(lighter).toBeDisabled();
  expect(collector.step).toHaveBeenLastCalledWith({
    environmentId: "environment-level",
    input: { step: -1 },
  });

  for (const name of ["lighter", "normal", "heavier", "much heavier", "full"]) {
    await userEvent.click(heavier);
    await expect.element(page.getByText(name, { exact: true })).toBeVisible();
  }
  // Normal has no end, the others last 3 hours.
  await expect.element(page.getByText("3 hours left")).toBeVisible();
  await expect.element(heavier).toBeDisabled();
  await expect.element(lighter).toBeEnabled();
  expect(collector.step).toHaveBeenCalledTimes(6);
});

it("steps the words and the sentences each with their own chevrons, from a collector with both", async () => {
  using _clock = systemTime(NOW);
  setup({
    intensity: { level: 1, until: NOW + 90 * MINUTE },
    english: { on: false, until: 0, at: 0 },
    sentences: { level: -1, until: NOW + 30 * MINUTE },
  });
  await using _screen = await renderPanel("environment-dials");
  await expect.element(page.getByText("Words")).toBeVisible();
  await expect.element(page.getByText("Sentences")).toBeVisible();
  await expect.element(page.getByText("heavier", { exact: true })).toBeVisible();
  await expect.element(page.getByText("30 min left")).toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "Lighter sentences" }));
  await expect.element(page.getByText("much lighter")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Lighter sentences" })).toBeDisabled();
  expect(collector.step).toHaveBeenLastCalledWith({
    environmentId: "environment-dials",
    input: { step: -1, surface: "sentences" },
  });
  // The words' dial stays where it was, and steps the chat level.
  await expect.element(page.getByText("heavier", { exact: true })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Heavier words" }));
  await expect.element(page.getByText("much heavier")).toBeVisible();
  expect(collector.step).toHaveBeenLastCalledWith({
    environmentId: "environment-dials",
    input: { step: 1 },
  });
});

it("shows one dial for both from a collector without a sentence level, and the tint switch", async () => {
  setup({ intensity: { level: 0, until: 0 }, english: { on: false, until: 0, at: 0 } });
  await using _screen = await renderPanel("environment-one-dial");
  await expect.element(page.getByText("Difficulty", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Sentences")).not.toBeInTheDocument();
  const tint = page.getByRole("switch", { name: "Difficulty tint" });
  await expect.element(tint).toBeChecked();
  await userEvent.click(tint);
  await expect.element(tint).not.toBeChecked();
  expect(localStorage.getItem("t3.japaneseTint")).toBe("off");
  await userEvent.click(tint);
  await expect.element(tint).toBeChecked();
  expect(localStorage.getItem("t3.japaneseTint")).toBeNull();
  expect(collector.step).not.toHaveBeenCalled();
});
