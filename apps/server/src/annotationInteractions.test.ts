import { assert, it } from "@effect/vitest";
import { AnnotationInteractionsReportInput } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { describe } from "vite-plus/test";

import {
  adjustAnnotationIntensity,
  forwardAnnotationInteractions,
  getAnnotationStatus,
  nextAnnotationReview,
  setAnnotationEnglish,
} from "./annotationInteractions.ts";

const COLLECTOR = "http://collector.test:7853/v1/interactions";
const peek = {
  kind: "peek",
  word: "CSP",
  at: 1_800_000_000_000,
  dwellMs: 900,
  view: "v1",
  context: "m1",
  position: 0,
  box: [0, 0, 400, 40],
  annotations: [["CSP", 4, 0]],
} as const;

const decodeReport = Schema.decodeSync(AnnotationInteractionsReportInput);

/** Runs the forwarder against a fake collector that answers every post with `status`. */
const forwardWith = (
  env: Record<string, string>,
  status = 200,
  input: AnnotationInteractionsReportInput = { items: [peek] },
) => {
  const requests: Array<{ readonly url: string; readonly body: string }> = [];
  const client = HttpClient.make((request) => {
    requests.push({
      url: request.url,
      body: request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
    });
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status })));
  });
  const run = forwardAnnotationInteractions(input).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );
  return { requests, run };
};

describe("forwardAnnotationInteractions", () => {
  it.effect("posts the interactions to the configured collector as the t3 surface", () =>
    Effect.gen(function* () {
      const { requests, run } = forwardWith({ T3CODE_ANNOTATION_EVENTS_URL: COLLECTOR });
      yield* run;
      assert.deepStrictEqual(
        requests.map((request) => request.url),
        [COLLECTOR],
      );
      assert.include(requests[0]!.body, '"surface":"t3"');
      assert.include(requests[0]!.body, '"word":"CSP"');
    }),
  );

  it.effect("forwards a phone's open whole, keeping its uid for the collector's dedupe", () =>
    Effect.gen(function* () {
      const opened = {
        kind: "pin",
        word: "mondai",
        at: 1_800_000_000_000,
        dwellMs: 0,
        view: "phone-s1-abc",
        context: "m1",
        position: 0,
        box: [0, 0, 0, 0],
        annotations: [["mondai", 0, 0]],
        uid: "phone-s1-1",
      } as const;
      const { requests, run } = forwardWith(
        { T3CODE_ANNOTATION_EVENTS_URL: COLLECTOR },
        200,
        decodeReport({ items: [opened] }),
      );
      yield* run;
      assert.deepStrictEqual(JSON.parse(requests[0]!.body), { surface: "t3", items: [opened] });
    }),
  );

  it.effect("forwards a review card's timing whole, like any other item", () =>
    Effect.gen(function* () {
      const reviewed = {
        kind: "review",
        at: 1_800_000_000_000,
        card: "c42",
        word: "問題",
        revealMs: null,
        shownMs: 2_400,
        source: "desktop",
        uid: "review-1",
      } as const;
      const { requests, run } = forwardWith(
        { T3CODE_ANNOTATION_EVENTS_URL: COLLECTOR },
        200,
        decodeReport({ items: [reviewed] }),
      );
      yield* run;
      assert.deepStrictEqual(JSON.parse(requests[0]!.body), { surface: "t3", items: [reviewed] });
    }),
  );

  it.effect("sends nothing without a collector and never fails on a bad answer", () =>
    Effect.gen(function* () {
      const off = forwardWith({});
      yield* off.run;
      assert.strictEqual(off.requests.length, 0);
      const failing = forwardWith({ T3CODE_ANNOTATION_EVENTS_URL: COLLECTOR }, 500);
      yield* failing.run;
      assert.strictEqual(failing.requests.length, 1);
    }),
  );
});

/** Runs one intensity press against a fake collector that answers with `answer`, or fails to connect when `null`. */
const adjustWith = (
  env: Record<string, string>,
  answer: { readonly status: number; readonly body: unknown } | null,
) => {
  const requests: Array<{
    readonly url: string;
    readonly contentType: string;
    readonly body: string;
  }> = [];
  const client = HttpClient.make((request) => {
    requests.push({
      url: request.url,
      contentType: request.headers["content-type"] ?? "",
      body: request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
    });
    return answer === null
      ? Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request }),
          }),
        )
      : Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(answer.body), { status: answer.status }),
          ),
        );
  });
  const run = adjustAnnotationIntensity({ step: -1 }).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );
  return { requests, run };
};

const configured = { T3CODE_ANNOTATION_EVENTS_URL: COLLECTOR };

describe("adjustAnnotationIntensity", () => {
  it.effect("posts the step to the collector's intensity endpoint and returns its new level", () =>
    Effect.gen(function* () {
      const until = 1_800_000_600_000;
      const { requests, run } = adjustWith(configured, {
        status: 200,
        body: { ok: true, intensity: { level: -2, until, at: 1_800_000_000_000 } },
      });
      assert.deepStrictEqual(yield* run, { level: -2, until });
      assert.deepStrictEqual(requests, [
        {
          url: "http://collector.test:7853/v1/intensity",
          contentType: "application/json",
          body: JSON.stringify({ surface: "chat", step: -1, source: "t3" }),
        },
      ]);
    }),
  );

  it.effect("accepts the ends of the scale, off (-3) and full (+3)", () =>
    Effect.gen(function* () {
      for (const level of [-3, 3]) {
        const { run } = adjustWith(configured, {
          status: 200,
          body: { ok: true, intensity: { level, until: 1_800_000_600_000, at: 1_800_000_000_000 } },
        });
        assert.deepStrictEqual(yield* run, { level, until: 1_800_000_600_000 });
      }
    }),
  );

  it.effect("fails as not configured without a collector, sending nothing", () =>
    Effect.gen(function* () {
      const { requests, run } = adjustWith({}, { status: 200, body: { ok: true } });
      const error = yield* Effect.flip(run);
      assert.strictEqual(error.message, "not configured");
      assert.strictEqual(requests.length, 0);
    }),
  );

  it.effect("fails with the collector's error, or its status, when it refuses", () =>
    Effect.gen(function* () {
      const refused = adjustWith(configured, {
        status: 400,
        body: { ok: false, error: "chat surface is paused" },
      });
      assert.strictEqual((yield* Effect.flip(refused.run)).message, "chat surface is paused");
      const broken = adjustWith(configured, { status: 502, body: "Bad Gateway" });
      assert.strictEqual((yield* Effect.flip(broken.run)).message, "collector answered 502");
    }),
  );

  it.effect("fails as unreachable when the collector cannot be reached", () =>
    Effect.gen(function* () {
      const { run } = adjustWith(configured, null);
      assert.strictEqual((yield* Effect.flip(run)).message, "collector unreachable");
    }),
  );
});

/** Asks a fake collector for the next review card; it answers with `answer`, or fails to connect when `null`. */
const reviewWith = (
  env: Record<string, string>,
  answer: { readonly status: number; readonly body: unknown } | null,
) => {
  const requests: Array<{ readonly url: string; readonly body: string }> = [];
  const client = HttpClient.make((request) => {
    requests.push({
      url: request.url,
      body: request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
    });
    return answer === null
      ? Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request }),
          }),
        )
      : Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(answer.body), { status: answer.status }),
          ),
        );
  });
  const run = nextAnnotationReview({ source: "desktop", exclude: ["c1"] }).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );
  return { requests, run };
};

describe("nextAnnotationReview", () => {
  it.effect("posts the source and excluded cards to the collector and returns its card", () =>
    Effect.gen(function* () {
      const card = { id: "c42", ja: "問題", kana: "もんだい", gloss: "problem" };
      const { requests, run } = reviewWith(configured, { status: 200, body: { ok: true, card } });
      assert.deepStrictEqual(yield* run, { card });
      assert.deepStrictEqual(requests, [
        {
          url: "http://collector.test:7853/v1/review/next",
          body: JSON.stringify({ source: "desktop", exclude: ["c1"] }),
        },
      ]);
    }),
  );

  it.effect("returns no card when the collector has nothing to review", () =>
    Effect.gen(function* () {
      const { run } = reviewWith(configured, { status: 200, body: { ok: true, card: null } });
      assert.deepStrictEqual(yield* run, { card: null });
    }),
  );

  it.effect("fails as not configured without a collector, sending nothing", () =>
    Effect.gen(function* () {
      const { requests, run } = reviewWith({}, { status: 200, body: { ok: true, card: null } });
      assert.strictEqual((yield* Effect.flip(run)).message, "not configured");
      assert.strictEqual(requests.length, 0);
    }),
  );

  it.effect("fails with the collector's error, its status, or as unreachable", () =>
    Effect.gen(function* () {
      const refused = reviewWith(configured, {
        status: 400,
        body: { ok: false, error: "no words yet" },
      });
      assert.strictEqual((yield* Effect.flip(refused.run)).message, "no words yet");
      const broken = reviewWith(configured, { status: 502, body: "Bad Gateway" });
      assert.strictEqual((yield* Effect.flip(broken.run)).message, "collector answered 502");
      const down = reviewWith(configured, null);
      assert.strictEqual((yield* Effect.flip(down.run)).message, "collector unreachable");
    }),
  );
});

/** Runs `effect` against a fake collector that answers with `answer`, or fails to connect when `null`. */
const collectorWith = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  env: Record<string, string>,
  answer: { readonly status: number; readonly body: unknown } | null,
) => {
  const requests: Array<{ readonly method: string; readonly url: string; readonly body: string }> =
    [];
  const client = HttpClient.make((request) => {
    requests.push({
      method: request.method,
      url: request.url,
      body: request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
    });
    return answer === null
      ? Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request }),
          }),
        )
      : Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(answer.body), { status: answer.status }),
          ),
        );
  });
  const run = effect.pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );
  return { requests, run };
};

describe("getAnnotationStatus", () => {
  const intensity = { level: 1, until: 1_800_000_600_000, at: 1_800_000_000_000 };

  it.effect("reads the chat level and English only from the collector's intensity endpoint", () =>
    Effect.gen(function* () {
      const english = { on: true, until: 1_800_003_600_000, at: 1_800_000_000_000 };
      const { requests, run } = collectorWith(getAnnotationStatus(), configured, {
        status: 200,
        body: { ok: true, intensity, english },
      });
      assert.deepStrictEqual(yield* run, {
        intensity: { level: 1, until: 1_800_000_600_000 },
        english,
      });
      assert.deepStrictEqual(requests, [
        { method: "GET", url: "http://collector.test:7853/v1/intensity?surface=chat", body: "" },
      ]);
    }),
  );

  it.effect("reads English only as off from a collector that predates it", () =>
    Effect.gen(function* () {
      const { run } = collectorWith(getAnnotationStatus(), configured, {
        status: 200,
        body: { ok: true, intensity },
      });
      assert.deepStrictEqual((yield* run).english, { on: false, until: 0, at: 0 });
    }),
  );

  it.effect(
    "fails as not configured, with the collector's error, its status, or as unreachable",
    () =>
      Effect.gen(function* () {
        const off = collectorWith(getAnnotationStatus(), {}, { status: 200, body: { ok: true } });
        assert.strictEqual((yield* Effect.flip(off.run)).message, "not configured");
        assert.strictEqual(off.requests.length, 0);
        const refused = collectorWith(getAnnotationStatus(), configured, {
          status: 400,
          body: { ok: false, error: "unknown surface" },
        });
        assert.strictEqual((yield* Effect.flip(refused.run)).message, "unknown surface");
        const broken = collectorWith(getAnnotationStatus(), configured, {
          status: 502,
          body: "Bad Gateway",
        });
        assert.strictEqual((yield* Effect.flip(broken.run)).message, "collector answered 502");
        const down = collectorWith(getAnnotationStatus(), configured, null);
        assert.strictEqual((yield* Effect.flip(down.run)).message, "collector unreachable");
      }),
  );
});

describe("setAnnotationEnglish", () => {
  const contexts = [
    { view: "v1", context: "m1" },
    { view: "v1", context: "m2" },
  ];

  it.effect("posts the switch and the messages on screen, and returns the new state", () =>
    Effect.gen(function* () {
      const english = { on: true, until: 1_800_003_600_000, at: 1_800_000_000_000 };
      const { requests, run } = collectorWith(
        setAnnotationEnglish({ on: true, contexts }),
        configured,
        { status: 200, body: { ok: true, english } },
      );
      assert.deepStrictEqual(yield* run, english);
      assert.deepStrictEqual(requests, [
        {
          method: "POST",
          url: "http://collector.test:7853/v1/english",
          body: JSON.stringify({ on: true, source: "t3", contexts }),
        },
      ]);
    }),
  );

  it.effect(
    "fails as not configured, with the collector's error, its status, or as unreachable",
    () =>
      Effect.gen(function* () {
        const off = setAnnotationEnglish({ on: false, contexts: [] });
        const unset = collectorWith(off, {}, { status: 200, body: { ok: true } });
        assert.strictEqual((yield* Effect.flip(unset.run)).message, "not configured");
        assert.strictEqual(unset.requests.length, 0);
        const refused = collectorWith(off, configured, {
          status: 400,
          body: { ok: false, error: "chat surface is paused" },
        });
        assert.strictEqual((yield* Effect.flip(refused.run)).message, "chat surface is paused");
        const empty = collectorWith(off, configured, { status: 200, body: { ok: true } });
        assert.strictEqual((yield* Effect.flip(empty.run)).message, "collector answered 200");
        const down = collectorWith(off, configured, null);
        assert.strictEqual((yield* Effect.flip(down.run)).message, "collector unreachable");
      }),
  );
});
