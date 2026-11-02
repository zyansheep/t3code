import { assert, it } from "@effect/vitest";
import { AnnotationInteractionsReportInput } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe } from "vite-plus/test";

import { forwardAnnotationInteractions } from "./annotationInteractions.ts";

const COLLECTOR = "http://collector.test:7853/v1/interactions";
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

const decodeReport = Schema.decodeSync(AnnotationInteractionsReportInput);

const forwardWith = (env: Record<string, string>, status = 200) => {
  const requests: Array<{ readonly url: string; readonly body: string }> = [];
  const client = HttpClient.make((request) => {
    requests.push({
      url: request.url,
      body: request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
    });
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status })));
  });
  const input = decodeReport({ items: [opened] });
  const run = forwardAnnotationInteractions(input).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );
  return { requests, run };
};

describe("forwardAnnotationInteractions", () => {
  it.effect("posts a phone's open to the collector as the t3 surface, uid and all", () =>
    Effect.gen(function* () {
      const { requests, run } = forwardWith({ T3CODE_ANNOTATION_EVENTS_URL: COLLECTOR });
      yield* run;
      assert.deepStrictEqual(
        requests.map((request) => request.url),
        [COLLECTOR],
      );
      assert.deepStrictEqual(JSON.parse(requests[0]!.body), { surface: "t3", items: [opened] });
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
