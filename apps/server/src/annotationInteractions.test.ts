import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe } from "vite-plus/test";

import { forwardAnnotationInteractions } from "./annotationInteractions.ts";

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
