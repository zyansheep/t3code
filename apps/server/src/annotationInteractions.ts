import {
  AnnotationEnglish,
  type AnnotationEnglishSetInput,
  AnnotationIntensity,
  type AnnotationIntensityAdjustInput,
  AnnotationIntensityError,
  type AnnotationInteractionsReportInput,
  AnnotationReviewCard,
  AnnotationReviewError,
  type AnnotationReviewNextInput,
  type AnnotationReviewNextResult,
  type AnnotationStatus,
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
export const forwardAnnotationInteractions = Effect.fn("forwardAnnotationInteractions")(
  function* (input: AnnotationInteractionsReportInput) {
    const url = (yield* AnnotationEventsUrl).trim();
    if (url === "" || input.items.length === 0) return;
    const client = yield* HttpClient.HttpClient;
    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyJson({ surface: "t3", items: input.items }),
    );
    yield* HttpClientResponse.filterStatusOk(yield* client.execute(request));
  },
  Effect.timeout("5 seconds"),
  Effect.ignore(),
);

const isIntensityError = Schema.is(AnnotationIntensityError);
const decodeIntensityAnswer = Schema.decodeUnknownOption(
  Schema.Struct({
    ok: Schema.Boolean,
    intensity: Schema.optional(AnnotationIntensity),
    english: Schema.optional(AnnotationEnglish),
    error: Schema.optional(Schema.String),
  }),
);
const ENGLISH_OFF = { on: false, until: 0, at: 0 } satisfies AnnotationEnglish;

/** `path` at the origin of `T3CODE_ANNOTATION_EVENTS_URL`, or why there is none. */
const intensityEndpoint = Effect.fnUntraced(function* (path: string) {
  const configured = (yield* AnnotationEventsUrl).trim();
  if (configured === "") return yield* new AnnotationIntensityError({ detail: "not configured" });
  return yield* Effect.try({
    try: () => new URL(path, configured).toString(),
    catch: () => new AnnotationIntensityError({ detail: "collector URL is not valid" }),
  });
});

/** Sends `request` and decodes the answer; a refusal fails with the collector's own error, else its status. */
const askIntensityCollector = Effect.fnUntraced(function* (
  request: HttpClientRequest.HttpClientRequest,
) {
  const response = yield* (yield* HttpClient.HttpClient).execute(request);
  const answer = Option.getOrUndefined(
    Option.flatMap(yield* Effect.option(response.json), decodeIntensityAnswer),
  );
  const refusal = () => {
    const reason = answer?.error?.trim();
    return new AnnotationIntensityError({
      detail: reason ? reason : `collector answered ${response.status}`,
    });
  };
  return { answer: response.status === 200 && answer?.ok === true ? answer : undefined, refusal };
});

const asIntensityError = Effect.mapError((error: unknown) =>
  isIntensityError(error)
    ? error
    : new AnnotationIntensityError({ detail: "collector unreachable" }),
);

/**
 * Asks the collector at the origin of `T3CODE_ANNOTATION_EVENTS_URL` to make chat annotations heavier (`step: 1`) or
 * lighter (`-1`) for a while, with `POST /v1/intensity`, and returns its new level and when that ends. Fails with a
 * reason short enough to show: `not configured`, the collector's own error, or `collector unreachable`.
 */
export const adjustAnnotationIntensity = Effect.fn("adjustAnnotationIntensity")(
  function* (input: AnnotationIntensityAdjustInput) {
    const url = yield* intensityEndpoint("/v1/intensity");
    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyJson({ surface: "chat", step: input.step, source: "t3" }),
    );
    const { answer, refusal } = yield* askIntensityCollector(request);
    if (answer?.intensity === undefined) return yield* refusal();
    return answer.intensity;
  },
  Effect.timeout("3 seconds"),
  asIntensityError,
);

/**
 * Reads the collector's chat level and English-only state with `GET /v1/intensity?surface=chat`; a collector that
 * predates English only answers without it, which reads as off. Fails like `adjustAnnotationIntensity`.
 */
export const getAnnotationStatus = Effect.fn("getAnnotationStatus")(
  function* () {
    const url = yield* intensityEndpoint("/v1/intensity?surface=chat");
    const { answer, refusal } = yield* askIntensityCollector(HttpClientRequest.get(url));
    if (answer?.intensity === undefined) return yield* refusal();
    return {
      intensity: answer.intensity,
      english: answer.english ?? ENGLISH_OFF,
    } satisfies AnnotationStatus;
  },
  Effect.timeout("3 seconds"),
  asIntensityError,
);

/**
 * Turns English only on or off at the collector with `POST /v1/english`, sending the messages on screen, and returns
 * its new state. Fails like `adjustAnnotationIntensity`.
 */
export const setAnnotationEnglish = Effect.fn("setAnnotationEnglish")(
  function* (input: AnnotationEnglishSetInput) {
    const url = yield* intensityEndpoint("/v1/english");
    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyJson({ on: input.on, source: "t3", contexts: input.contexts }),
    );
    const { answer, refusal } = yield* askIntensityCollector(request);
    if (answer?.english === undefined) return yield* refusal();
    return answer.english;
  },
  Effect.timeout("3 seconds"),
  asIntensityError,
);

const isReviewError = Schema.is(AnnotationReviewError);
const decodeReviewAnswer = Schema.decodeUnknownOption(
  Schema.Struct({
    ok: Schema.Boolean,
    card: Schema.optional(Schema.NullOr(AnnotationReviewCard)),
    error: Schema.optional(Schema.String),
  }),
);

/**
 * Asks the collector at the origin of `T3CODE_ANNOTATION_EVENTS_URL` for the next word to review, with
 * `POST /v1/review/next`; `card: null` means nothing is due. Fails with a reason short enough to show on the card:
 * `not configured`, the collector's own error, its status, or `collector unreachable`.
 */
export const nextAnnotationReview = Effect.fn("nextAnnotationReview")(
  function* (input: AnnotationReviewNextInput) {
    const configured = (yield* AnnotationEventsUrl).trim();
    if (configured === "") return yield* new AnnotationReviewError({ detail: "not configured" });
    const url = yield* Effect.try({
      try: () => new URL("/v1/review/next", configured).toString(),
      catch: () => new AnnotationReviewError({ detail: "collector URL is not valid" }),
    });
    const client = yield* HttpClient.HttpClient;
    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyJson({ source: input.source, exclude: input.exclude }),
    );
    const response = yield* client.execute(request);
    const answer = Option.getOrUndefined(
      Option.flatMap(yield* Effect.option(response.json), decodeReviewAnswer),
    );
    if (response.status === 200 && answer?.ok === true && answer.card !== undefined) {
      return { card: answer.card } satisfies AnnotationReviewNextResult;
    }
    const reason = answer?.error?.trim();
    return yield* new AnnotationReviewError({
      detail: reason ? reason : `collector answered ${response.status}`,
    });
  },
  Effect.timeout("3 seconds"),
  Effect.mapError((error) =>
    isReviewError(error) ? error : new AnnotationReviewError({ detail: "collector unreachable" }),
  ),
);
