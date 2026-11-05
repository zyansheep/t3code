import { type AnnotationStatus, EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Each request waits until the test answers it, by its RPC's tag.
const rpc = vi.hoisted(() => ({
  pending: [] as Array<{ readonly tag: string; readonly answer: (value: unknown) => void }>,
}));

vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  createEnvironmentRpcCommand: (_runtime: unknown, options: { readonly tag: string }) =>
    options.tag,
  runAtomCommand: (_registry: unknown, tag: string) =>
    new Promise((resolve) => {
      rpc.pending.push({ tag, answer: (value) => resolve({ _tag: "Success", value }) });
    }),
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../lib/appState", () => ({ subscribeAppActive: () => () => undefined }));
vi.mock("./gloss-opens", () => ({ glossContextsOnScreen: () => [] }));
vi.mock("./workspace", async () => {
  const { Atom } = await import("effect/reactivity");
  return { workspaceConnections: { environmentsAtom: Atom.make([]) } };
});

const { appAtomRegistry } = await import("./atom-registry");
const { annotationStatusAtom } = await import("./chat-japanese-view");
const { stepAnnotationLevel, watchAnnotationStatus } = await import("./chat-japanese");

const NOW = 1_800_000_000_000;
const FAR = NOW + 3_600_000;
const status = (level: number, english: boolean): AnnotationStatus => ({
  intensity: { level, until: level === 0 ? 0 : FAR },
  english: { on: english, until: english ? FAR : 0, at: 0 },
});

/** Answers the oldest request with `tag`. */
async function answer(tag: string, value: unknown) {
  const index = rpc.pending.findIndex((request) => request.tag === tag);
  expect(index).not.toBe(-1);
  const [request] = rpc.pending.splice(index, 1);
  request!.answer(value);
  // Lets the answer's handling, a few awaits deep, run.
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  rpc.pending.length = 0;
});

describe("chat Japanese status and presses", () => {
  it("drops a status read asked before a press, and reads again", async () => {
    const environmentId = EnvironmentId.make("env-stale");
    appAtomRegistry.set(annotationStatusAtom(environmentId), status(0, false));
    watchAnnotationStatus(environmentId);
    const press = stepAnnotationLevel(environmentId, 1);
    await answer(WS_METHODS.serverAdjustAnnotationIntensity, { level: 1, until: FAR });
    await expect(press).resolves.toEqual({ ok: true, value: { level: 1, until: FAR } });
    // The read asked before the press answers with the level from before it.
    await answer(WS_METHODS.serverGetAnnotationStatus, status(0, false));
    expect(appAtomRegistry.get(annotationStatusAtom(environmentId))?.intensity.level).toBe(1);
    await answer(WS_METHODS.serverGetAnnotationStatus, status(1, false));
    expect(appAtomRegistry.get(annotationStatusAtom(environmentId))?.intensity.level).toBe(1);
  });

  it("keeps a press made before the status was known, and reads English only at once", async () => {
    const environmentId = EnvironmentId.make("env-unknown");
    const press = stepAnnotationLevel(environmentId, -1);
    await answer(WS_METHODS.serverAdjustAnnotationIntensity, { level: -1, until: FAR });
    await press;
    expect(appAtomRegistry.get(annotationStatusAtom(environmentId))).toEqual(status(-1, false));
    await answer(WS_METHODS.serverGetAnnotationStatus, status(-1, true));
    expect(appAtomRegistry.get(annotationStatusAtom(environmentId))).toEqual(status(-1, true));
  });
});
