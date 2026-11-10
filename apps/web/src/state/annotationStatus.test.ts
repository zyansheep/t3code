import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const NOW = Date.UTC(2026, 10, 5, 12, 0);
const HOUR = 3_600_000;

// Status reads the test answers, in order.
const reads = vi.hoisted(() => [] as Array<(status: unknown) => void>);

// The collector: English only for an hour, and a level for three.
vi.mock(import("./annotationInteractions"), async (original) => ({
  ...(await original()),
  getAnnotationStatus: {
    label: "test:status",
    run: () =>
      new Promise((resolve) => reads.push((status) => resolve(AsyncResult.success(status)))),
  } as never,
  setAnnotationEnglish: {
    label: "test:english",
    run: async (_registry: unknown, request: { input: { on: boolean } }) =>
      AsyncResult.success({ on: request.input.on, until: NOW + HOUR, at: NOW }),
  } as never,
  // The words go to much heavier for three hours, the sentences to lighter for two.
  adjustAnnotationIntensity: {
    label: "test:step",
    run: async (_registry: unknown, request: { input: { surface?: string } }) =>
      AsyncResult.success(
        request.input.surface === "sentences"
          ? { level: -1, until: NOW + 2 * HOUR }
          : { level: 2, until: NOW + 3 * HOUR },
      ),
  } as never,
}));

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  annotationStatusAtom,
  chatLevelAtom,
  refreshAnnotationStatus,
  sentenceLevelAtom,
  setEnglishOnly,
  stepAnnotationLevel,
} from "./annotationStatus";

const status = (level: number, english: boolean) => ({
  intensity: { level, until: level === 0 ? 0 : NOW + 3 * HOUR },
  english: { on: english, until: english ? NOW + HOUR : 0, at: NOW },
});

it("renders chat at the level left once English only ends, and at normal once the level ends", async () => {
  vi.useFakeTimers({ now: NOW, toFake: ["setTimeout", "clearTimeout", "Date"] });
  using _timers = { [Symbol.dispose]: () => void vi.useRealTimers() };
  const environmentId = EnvironmentId.make("environment-ends");
  appAtomRegistry.set(annotationStatusAtom(environmentId), {
    intensity: { level: 0, until: 0 },
    english: { on: false, until: 0, at: 0 },
  });
  const level = () => appAtomRegistry.get(chatLevelAtom(environmentId));
  await stepAnnotationLevel(environmentId, 1);
  await setEnglishOnly(environmentId, true);
  expect(level()).toBe(-3);

  vi.advanceTimersByTime(HOUR);
  expect(level()).toBe(2);
  vi.advanceTimersByTime(2 * HOUR);
  expect(level()).toBe(0);
  expect(appAtomRegistry.get(annotationStatusAtom(environmentId))?.intensity).toEqual({
    level: 0,
    until: 0,
  });
});

it("keeps a level press made before the status was read, and reads the status right after it", async () => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  using _timers = { [Symbol.dispose]: () => void vi.useRealTimers() };
  reads.length = 0;
  const environmentId = EnvironmentId.make("environment-unread");
  const level = () => appAtomRegistry.get(chatLevelAtom(environmentId));
  await stepAnnotationLevel(environmentId, 1);
  expect(level()).toBe(2);
  expect(reads).toHaveLength(1);
  reads[0]!(status(2, false));
  await vi.waitFor(() =>
    expect(appAtomRegistry.get(annotationStatusAtom(environmentId))).not.toBeNull(),
  );
  await setEnglishOnly(environmentId, true);
  await setEnglishOnly(environmentId, false);
  expect(level()).toBe(2);
});

it("drops a status read that started before a press, and reads again", async () => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  using _timers = { [Symbol.dispose]: () => void vi.useRealTimers() };
  reads.length = 0;
  const environmentId = EnvironmentId.make("environment-pressed");
  appAtomRegistry.set(annotationStatusAtom(environmentId), status(0, false));
  const level = () => appAtomRegistry.get(chatLevelAtom(environmentId));
  const refresh = refreshAnnotationStatus(environmentId);
  await stepAnnotationLevel(environmentId, 1);
  expect(level()).toBe(2);
  // The read from before the press answers with the old level.
  reads[0]!(status(0, false));
  await refresh;
  expect(level()).toBe(2);
  expect(reads).toHaveLength(2);
  reads[1]!(status(2, true));
  await vi.waitFor(() => expect(level()).toBe(-3));
});

it("renders twins at the sentence level, or the word level without one, and ends each on its own", async () => {
  vi.useFakeTimers({ now: NOW, toFake: ["setTimeout", "clearTimeout", "Date"] });
  using _timers = { [Symbol.dispose]: () => void vi.useRealTimers() };
  const environmentId = EnvironmentId.make("environment-sentences");
  appAtomRegistry.set(annotationStatusAtom(environmentId), status(0, false));
  const levels = () => [
    appAtomRegistry.get(chatLevelAtom(environmentId)),
    appAtomRegistry.get(sentenceLevelAtom(environmentId)),
  ];
  // A collector with one level for both: the sentences follow the words.
  await stepAnnotationLevel(environmentId, 1);
  expect(levels()).toEqual([2, 2]);
  await stepAnnotationLevel(environmentId, -1, "sentences");
  expect(levels()).toEqual([2, -1]);
  // English only is both at -3, and keeps each level for after it.
  await setEnglishOnly(environmentId, true);
  expect(levels()).toEqual([-3, -3]);

  vi.advanceTimersByTime(HOUR);
  expect(levels()).toEqual([2, -1]);
  vi.advanceTimersByTime(HOUR);
  expect(levels()).toEqual([2, 0]);
  vi.advanceTimersByTime(HOUR);
  expect(levels()).toEqual([0, 0]);
  expect(appAtomRegistry.get(annotationStatusAtom(environmentId))?.sentences).toEqual({
    level: 0,
    until: 0,
  });
});
