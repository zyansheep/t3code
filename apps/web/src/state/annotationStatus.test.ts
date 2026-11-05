import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const NOW = Date.UTC(2026, 10, 5, 12, 0);
const HOUR = 3_600_000;

// The collector: English only for an hour, and a level for three.
vi.mock(import("./annotationInteractions"), async (original) => ({
  ...(await original()),
  setAnnotationEnglish: {
    label: "test:english",
    run: async (_registry: unknown, request: { input: { on: boolean } }) =>
      AsyncResult.success({ on: request.input.on, until: NOW + HOUR, at: NOW }),
  } as never,
  adjustAnnotationIntensity: {
    label: "test:step",
    run: async () => AsyncResult.success({ level: 2, until: NOW + 3 * HOUR }),
  } as never,
}));

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  annotationStatusAtom,
  chatLevelAtom,
  setEnglishOnly,
  stepAnnotationLevel,
} from "./annotationStatus";

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
