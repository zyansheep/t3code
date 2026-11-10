import {
  AnnotationEnglish,
  type AnnotationEnglishSetInput,
  AnnotationIntensity,
  type AnnotationIntensityAdjustInput,
  AnnotationIntensityError,
  type AnnotationInteractionsReportInput,
  AnnotationReportError,
  AnnotationReviewCard,
  AnnotationReviewError,
  type AnnotationReviewNextInput,
  AnnotationReviewNextResult,
  type AnnotationStatus,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

/** Where chat `<abbr>` popover interactions go: an external collector, for example a language-learning tool. */
const AnnotationEventsUrl = Config.String("T3CODE_ANNOTATION_EVENTS_URL").pipe(
  Config.withDefault(""),
);

const isReportError = Schema.is(AnnotationReportError);
const decodeReportAnswer = Schema.decodeUnknownOption(
  Schema.Struct({
    rejected: Schema.optional(Schema.Finite),
    reasons: Schema.optional(
      Schema.Array(Schema.Struct({ item: Schema.Int, error: Schema.String })),
    ),
  }),
);

/**
 * Posts `items` to the collector; fails when it cannot be reached or fails, or names the review items it rejected (by
 * its reasons; one that sends none rejected them all). Other items it rejects or ignores are best effort.
 */
const postInteractions = Effect.fn("postInteractions")(
  function* (url: string, input: AnnotationInteractionsReportInput) {
    const client = yield* HttpClient.HttpClient;
    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyJson({ surface: "t3", items: input.items }),
    );
    const response = yield* client.execute(request);
    if (response.status !== 200) {
      return yield* new AnnotationReportError({
        detail: `collector answered ${response.status}`,
        retryable: true,
      });
    }
    const answer = Option.getOrUndefined(
      Option.flatMap(yield* Effect.option(response.json), decodeReportAnswer),
    );
    const reviews = input.items.flatMap((item, index) => (item.kind === "review" ? [index] : []));
    const rejected = answer?.reasons
      ? answer.reasons.filter((reason) => reviews.includes(reason.item))
      : (answer?.rejected ?? 0) > 0
        ? reviews.map((item) => ({ item, error: "rejected" }))
        : [];
    if (rejected.length > 0) {
      return yield* new AnnotationReportError({
        detail: `collector rejected ${rejected.length} of ${input.items.length}: ${rejected[0]!.error}`,
        retryable: false,
        rejected,
      });
    }
  },
  Effect.timeout("5 seconds"),
  Effect.mapError((error) =>
    isReportError(error)
      ? error
      : new AnnotationReportError({ detail: "collector unreachable", retryable: true }),
  ),
);

/**
 * Forwards chat clients' annotation interactions to `T3CODE_ANNOTATION_EVENTS_URL` as `{"surface": "t3", "items"}`
 * (the server forwards because clients may be remote). Unset means off. Reading reports are best effort; a batch with
 * review items, whose grades schedule cards, fails with an `AnnotationReportError` when the collector does not store it.
 */
export const forwardAnnotationInteractions = Effect.fn("forwardAnnotationInteractions")(function* (
  input: AnnotationInteractionsReportInput,
) {
  const url = (yield* Effect.orElseSucceed(AnnotationEventsUrl, () => "")).trim();
  if (url === "" || input.items.length === 0) return;
  const posted = postInteractions(url, input);
  if (input.items.some((item) => item.kind === "review")) return yield* posted;
  yield* posted.pipe(Effect.ignore());
});

const isIntensityError = Schema.is(AnnotationIntensityError);
const decodeIntensityAnswer = Schema.decodeUnknownOption(
  Schema.Struct({
    ok: Schema.Boolean,
    intensity: Schema.optional(AnnotationIntensity),
    english: Schema.optional(AnnotationEnglish),
    sentences: Schema.optional(AnnotationIntensity),
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
 * Asks the collector at the origin of `T3CODE_ANNOTATION_EVENTS_URL` to make chat's words (`surface: "chat"`, the
 * default) or sentences (`"sentences"`) heavier (`step: 1`) or lighter (`-1`) for a while, with `POST /v1/intensity`,
 * and returns that dial's new level and when it ends. Fails with a reason short enough to show: `not configured`, the
 * collector's own error (a collector with one level for both refuses the sentences), or `collector unreachable`.
 */
export const adjustAnnotationIntensity = Effect.fn("adjustAnnotationIntensity")(
  function* (input: AnnotationIntensityAdjustInput) {
    const url = yield* intensityEndpoint("/v1/intensity");
    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyJson({
        surface: input.surface ?? "chat",
        step: input.step,
        source: "t3",
      }),
    );
    const { answer, refusal } = yield* askIntensityCollector(request);
    if (answer?.intensity === undefined) return yield* refusal();
    return answer.intensity;
  },
  Effect.timeout("3 seconds"),
  asIntensityError,
);

/**
 * Reads the collector's chat levels and English-only state with `GET /v1/intensity?surface=chat`: the word level, and
 * the sentence level from a collector with two (one with one level for both answers without it, and the status has
 * none). A collector that predates English only answers without it, which reads as off. Fails like
 * `adjustAnnotationIntensity`.
 */
export const getAnnotationStatus = Effect.fn("getAnnotationStatus")(
  function* () {
    const url = yield* intensityEndpoint("/v1/intensity?surface=chat");
    const { answer, refusal } = yield* askIntensityCollector(HttpClientRequest.get(url));
    if (answer?.intensity === undefined) return yield* refusal();
    return {
      intensity: answer.intensity,
      english: answer.english ?? ENGLISH_OFF,
      ...(answer.sentences === undefined ? {} : { sentences: answer.sentences }),
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
    counts: AnnotationReviewNextResult.fields.counts,
    error: Schema.optional(Schema.String),
  }),
);

/**
 * Asks the collector at the origin of `T3CODE_ANNOTATION_EVENTS_URL` for the next word to review, with
 * `POST /v1/review/next`, and returns its card (`null`: nothing is due now) with its counts when it sends them. Fails
 * with a reason short enough to show: `not configured`, the collector's own error, its status, or
 * `collector unreachable`.
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
      HttpClientRequest.bodyJson({
        source: input.source,
        exclude: input.exclude,
        ...(input.more === undefined ? {} : { more: input.more }),
        ...(input.peek === undefined ? {} : { peek: input.peek }),
        ...(input.release === undefined ? {} : { release: input.release }),
      }),
    );
    const response = yield* client.execute(request);
    const answer = Option.getOrUndefined(
      Option.flatMap(yield* Effect.option(response.json), decodeReviewAnswer),
    );
    if (response.status === 200 && answer?.ok === true && answer.card !== undefined) {
      return {
        card: answer.card,
        ...(answer.counts === undefined ? {} : { counts: answer.counts }),
      } satisfies AnnotationReviewNextResult;
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
