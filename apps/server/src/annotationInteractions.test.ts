import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { describe } from "vite-plus/test";

import {
  adjustAnnotationIntensity,
  forwardAnnotationInteractions,
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

/** Runs the forwarder against a fake collector that answers every post with `status`. */
const forwardWith = (env: Record<string, string>, status = 200) => {
  const requests: Array<{ readonly url: string; readonly body: string }> = [];
  const client = HttpClient.make((request) => {
    requests.push({
      url: request.url,
      body: request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
    });
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status })));
  });
  const run = forwardAnnotationInteractions({ items: [peek] }).pipe(
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
