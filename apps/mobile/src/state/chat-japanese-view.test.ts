import { EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  annotationStatusAtom,
  chatJapaneseLevelAtom,
  chatJapaneseSentenceLevelAtom,
} from "./chat-japanese-view";

const status = (level: number, english: boolean) => ({
  intensity: { level, until: level === 0 ? 0 : 1_800_000_000_000 },
  english: { on: english, until: english ? 1_800_000_000_000 : 0, at: 0 },
});

describe("chatJapaneseLevelAtom", () => {
  it("renders chat at the collector's level, at -3 while English only is on, and at normal without one", () => {
    const registry = AtomRegistry.make();
    const environmentId = EnvironmentId.make("env-level");
    const level = chatJapaneseLevelAtom(environmentId);
    const seen: number[] = [];
    const stop = registry.subscribe(level, (value) => seen.push(value), { immediate: true });

    registry.set(annotationStatusAtom(environmentId), status(2, false));
    registry.set(annotationStatusAtom(environmentId), status(2, true));
    registry.set(annotationStatusAtom(environmentId), status(-1, false));
    registry.set(annotationStatusAtom(environmentId), null);
    stop();

    expect(seen).toEqual([0, 2, -3, -1, 0]);
  });

  it("renders twins at the sentence level, the word level from a collector with one, and -3 in English only", () => {
    const registry = AtomRegistry.make();
    const environmentId = EnvironmentId.make("env-sentences");
    const sentences = chatJapaneseSentenceLevelAtom(environmentId);
    const seen: number[] = [];
    const stop = registry.subscribe(sentences, (value) => seen.push(value), { immediate: true });

    registry.set(annotationStatusAtom(environmentId), status(2, false));
    const both = { ...status(2, false), sentences: { level: -1, until: 1_800_000_000_000 } };
    registry.set(annotationStatusAtom(environmentId), both);
    registry.set(annotationStatusAtom(environmentId), {
      ...both,
      english: status(2, true).english,
    });
    stop();

    expect(seen).toEqual([0, 2, -1, -3]);
    expect(registry.get(chatJapaneseLevelAtom(environmentId))).toBe(-3);
  });
});
