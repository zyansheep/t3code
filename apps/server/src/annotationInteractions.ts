import {
  AnnotationIntensity,
  type AnnotationIntensityAdjustInput,
  AnnotationIntensityError,
  type AnnotationInteractionsReportInput,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

/** Where chat `<abbr>` popover interactions go: an external collector, for example a language-learning tool. */
const AnnotationEventsUrl = Config.String("T3CODE_ANNOTATION_EVENTS_URL").pipe(
  Config.withDefault(""),
);

/**
 * Forwards popover interactions from chat clients to `T3CODE_ANNOTATION_EVENTS_URL` as
 * `{"surface": "t3", "items": [...]}`. Best effort: unset means off, and a slow or failing collector never fails the
 * client's request. The server forwards rather than the client, because clients may be remote.
 */
export const forwardAnnotationInteractions = (input: AnnotationInteractionsReportInput) =>
  Effect.gen(function* () {
    const url = (yield* AnnotationEventsUrl).trim();
    if (url === "" || input.items.length === 0) return;
    const client = yield* HttpClient.HttpClient;
    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyJson({ surface: "t3", items: input.items }),
    );
    yield* HttpClientResponse.filterStatusOk(yield* client.execute(request));
  }).pipe(
    Effect.timeout("5 seconds"),
    Effect.ignore,
    Effect.withSpan("forwardAnnotationInteractions"),
  );

const isIntensityError = Schema.is(AnnotationIntensityError);
const decodeIntensityAnswer = Schema.decodeUnknownOption(
  Schema.Struct({
    ok: Schema.Boolean,
    intensity: Schema.optional(AnnotationIntensity),
    error: Schema.optional(Schema.String),
  }),
);

/**
 * Asks the collector at the origin of `T3CODE_ANNOTATION_EVENTS_URL` to make chat annotations heavier (`step: 1`) or
 * lighter (`-1`) for a while, with `POST /v1/intensity`, and returns its new level and when that ends. Unlike
 * interaction reports this waits for the answer and fails with a reason short enough to show: `not configured`, the
 * collector's own error, or `collector unreachable`.
 */
export const adjustAnnotationIntensity = (input: AnnotationIntensityAdjustInput) =>
  Effect.gen(function* () {
    const configured = (yield* AnnotationEventsUrl).trim();
    if (configured === "") return yield* new AnnotationIntensityError({ detail: "not configured" });
    const url = yield* Effect.try({
      try: () => new URL("/v1/intensity", configured).toString(),
      catch: () => new AnnotationIntensityError({ detail: "collector URL is not valid" }),
    });
    const client = yield* HttpClient.HttpClient;
    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyJson({ surface: "chat", step: input.step, source: "t3" }),
    );
    const response = yield* client.execute(request);
    const answer = Option.getOrUndefined(
      Option.flatMap(yield* Effect.option(response.json), decodeIntensityAnswer),
    );
    if (response.status === 200 && answer?.ok === true && answer.intensity !== undefined) {
      return answer.intensity;
    }
    const reason = answer?.error?.trim();
    return yield* new AnnotationIntensityError({
      detail: reason ? reason : `collector answered ${response.status}`,
    });
  }).pipe(
    Effect.timeout("3 seconds"),
    Effect.mapError((error) =>
      isIntensityError(error)
        ? error
        : new AnnotationIntensityError({ detail: "collector unreachable" }),
    ),
    Effect.withSpan("adjustAnnotationIntensity"),
  );
