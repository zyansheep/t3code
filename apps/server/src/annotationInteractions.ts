import {
  AnnotationEnglish,
  AnnotationEnglishSetInput,
  AnnotationIntensity,
  type AnnotationIntensityAdjustInput,
  AnnotationIntensityError,
  type AnnotationInteractionsReportInput,
  AnnotationReportError,
  AnnotationReviewCard,
  AnnotationReviewError,
  type AnnotationReviewNextInput,
  AnnotationReviewNextResult,
  AnnotationStatus,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ServerConfig from "./config.ts";

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
const NORMAL = { level: 0, until: 0 } satisfies AnnotationIntensity;
const UNREACHABLE = "collector unreachable";

/** How long the collector has to answer before it counts as out of reach. */
const COLLECTOR_TIMEOUT = "3 seconds";
// As the collector keeps them: a level lasts 3 hours from its press, English only an hour, and a press past off or
// full stays there.
const LEVEL_MS = 3 * 60 * 60_000;
const ENGLISH_MS = 60 * 60_000;
const LOWEST_LEVEL = -3;
const HIGHEST_LEVEL = 3;
/** The most ops the collector's `POST /v1/ops` takes in one request. */
const OPS_PER_POST = 100;
/** The most presses kept for the collector; past it the oldest go, so a long time out of reach can't grow the file. */
const MOST_QUEUED = 500;

/** `path` at the origin of `T3CODE_ANNOTATION_EVENTS_URL`, or why there is none. */
const intensityEndpoint = Effect.fnUntraced(function* (path: string) {
  const configured = (yield* AnnotationEventsUrl).trim();
  if (configured === "") return yield* new AnnotationIntensityError({ detail: "not configured" });
  return yield* Effect.try({
    try: () => new URL(path, configured).toString(),
    catch: () => new AnnotationIntensityError({ detail: "collector URL is not valid" }),
  });
});

interface CollectorReply {
  readonly status: number;
  readonly json: unknown;
}

/** Sends `request` to the collector: its status and JSON, or none when no answer came in time. */
const askCollector = Effect.fnUntraced(
  function* (request: HttpClientRequest.HttpClientRequest) {
    const response = yield* (yield* HttpClient.HttpClient).execute(request);
    const json = yield* Effect.option(response.json);
    return { status: response.status, json: Option.getOrUndefined(json) } satisfies CollectorReply;
  },
  Effect.timeoutOption(COLLECTOR_TIMEOUT),
  Effect.orElseSucceed(() => Option.none<CollectorReply>()),
);

/** The collector's answer when it took the request, else `undefined`. */
const intensityAnswer = (reply: CollectorReply) => {
  const answer = Option.getOrUndefined(decodeIntensityAnswer(reply.json));
  return reply.status === 200 && answer?.ok === true ? answer : undefined;
};

/** A refusal fails with the collector's own error, else its status. */
const refusal = (reply: CollectorReply) => {
  const reason = Option.getOrUndefined(decodeIntensityAnswer(reply.json))?.error?.trim();
  return new AnnotationIntensityError({
    detail: reason ? reason : `collector answered ${reply.status}`,
  });
};

const asIntensityError = Effect.mapError((error: unknown) =>
  isIntensityError(error) ? error : new AnnotationIntensityError({ detail: UNREACHABLE }),
);

const Stamp = {
  uid: Schema.String,
  day: Schema.String,
  at: Schema.Int,
  machine: Schema.String,
};
const QueuedLevel = Schema.Struct({
  level: AnnotationIntensity.fields.level,
  until: Schema.Int,
  at: Schema.Int,
  source: Schema.String,
});

/**
 * A press the collector has not taken yet, as the op the collector records for it: a `set` of the dial's level, or an
 * `english` switch with the messages on screen. Sent later, it carries the time of the press and its uid, so a resend
 * after a lost answer is applied once.
 */
const QueuedPress = Schema.Union([
  Schema.Struct({
    ...Stamp,
    kind: Schema.Literal("set"),
    prefs: Schema.Struct({
      intensity_chat: Schema.optional(QueuedLevel),
      intensity_sentences: Schema.optional(QueuedLevel),
    }),
  }),
  Schema.Struct({
    ...Stamp,
    kind: Schema.Literal("english"),
    on: Schema.Boolean,
    until: Schema.Int,
    source: Schema.String,
    contexts: AnnotationEnglishSetInput.fields.contexts,
  }),
]);
type QueuedPress = typeof QueuedPress.Type;

/** The status the collector last gave, with the presses made since, and those presses until the collector has them. */
const KeptStatus = Schema.Struct({
  status: Schema.NullOr(AnnotationStatus),
  queued: Schema.Array(QueuedPress),
});
type KeptStatus = typeof KeptStatus.Type;
const decodeKeptStatus = Schema.decodeUnknownOption(Schema.fromJsonString(KeptStatus));
const NOTHING_KEPT: KeptStatus = { status: null, queued: [] };

const KEPT_FILE = "annotation-status.json";
// One process serves every client, so this orders every read and press on the file.
const keptLock = Semaphore.makeUnsafe(1);

const keptPath = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  return (yield* Path.Path).join(stateDir, KEPT_FILE);
});

/** What is kept; a missing file keeps nothing, and so does an unreadable one, after a warning. */
const readKept = Effect.fnUntraced(function* (file: string) {
  const text = yield* Effect.option((yield* FileSystem.FileSystem).readFileString(file));
  if (Option.isNone(text)) return NOTHING_KEPT;
  const kept = decodeKeptStatus(text.value);
  if (Option.isSome(kept)) return kept.value;
  yield* Effect.logWarning("chat Japanese status file is unreadable; starting it again", { file });
  return NOTHING_KEPT;
});

const writeKept = (file: string, kept: KeptStatus) =>
  writeFileStringAtomically({ filePath: file, contents: `${JSON.stringify(kept)}\n` });

/** `effect` with the file read and nothing else reading or writing it meanwhile. */
const withKept = <A, E, R>(effect: (file: string, kept: KeptStatus) => Effect.Effect<A, E, R>) =>
  keptLock.withPermits(1)(
    Effect.gen(function* () {
      const file = yield* keptPath;
      return yield* effect(file, yield* readKept(file));
    }),
  );

const machineName = Effect.map(HostProcess.Hostname, (name) => name.slice(0, 64) || "t3");

/** A press made at `now`, stamped as the collector's ops are: its day is this machine's. */
const stamped = Effect.fnUntraced(function* (now: number) {
  return {
    uid: yield* (yield* SecureRandom.SecureRandom).uuidV4(),
    day: DateTime.formatIsoDate(
      DateTime.setZone(DateTime.makeUnsafe(now), DateTime.zoneMakeLocal()),
    ),
    at: now,
    machine: yield* machineName,
  };
});

const keep = (kept: KeptStatus, press: QueuedPress): ReadonlyArray<QueuedPress> =>
  [...kept.queued, press].slice(-MOST_QUEUED);

const levelAt = (level: AnnotationIntensity, now: number): AnnotationIntensity =>
  level.level !== 0 && level.until <= now ? NORMAL : level;

/** The status as the collector would answer at `now`: English only and each level end when their time is up. */
const statusAt = (status: AnnotationStatus, now: number): AnnotationStatus => ({
  intensity: levelAt(status.intensity, now),
  english:
    status.english.on && status.english.until <= now
      ? { on: false, until: 0, at: status.english.at }
      : status.english,
  ...(status.sentences === undefined ? {} : { sentences: levelAt(status.sentences, now) }),
});

const sameLevel = (a: AnnotationIntensity | undefined, b: AnnotationIntensity | undefined) =>
  a?.level === b?.level && a?.until === b?.until;

const sameStatus = (a: AnnotationStatus, b: AnnotationStatus | null) =>
  b !== null &&
  sameLevel(a.intensity, b.intensity) &&
  sameLevel(a.sentences, b.sentences) &&
  a.english.on === b.english.on &&
  a.english.until === b.english.until &&
  a.english.at === b.english.at;

const withDial = (
  status: AnnotationStatus,
  surface: "chat" | "sentences",
  level: AnnotationIntensity,
): AnnotationStatus =>
  surface === "chat" ? { ...status, intensity: level } : { ...status, sentences: level };

const decodeOpsAnswer = Schema.decodeUnknownOption(
  Schema.Struct({
    ok: Schema.Literal(true),
    results: Schema.Array(
      Schema.Struct({ ok: Schema.Boolean, error: Schema.optional(Schema.String) }),
    ),
  }),
);

/**
 * Sends the kept presses to the collector's `POST /v1/ops`, oldest first, and returns those still waiting: all from the
 * first batch it does not take. A press it refuses goes too, since sending it again would not mend it.
 */
const sendQueued = Effect.fnUntraced(function* (queued: ReadonlyArray<QueuedPress>) {
  if (queued.length === 0) return queued;
  const url = yield* intensityEndpoint("/v1/ops");
  const machine = yield* machineName;
  let left = queued;
  while (left.length > 0) {
    const batch = left.slice(0, OPS_PER_POST);
    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyJson({ machine, ops: batch }),
    );
    const reply = yield* askCollector(request);
    const results =
      Option.isSome(reply) && reply.value.status === 200
        ? Option.getOrUndefined(decodeOpsAnswer(reply.value.json))?.results
        : undefined;
    if (results?.length !== batch.length) break;
    for (const [index, result] of results.entries()) {
      if (result.ok) continue;
      yield* Effect.logWarning(
        "the collector refused a chat Japanese press kept while out of reach",
        {
          kind: batch[index]?.kind,
          error: result.error,
        },
      );
    }
    left = left.slice(batch.length);
  }
  return left;
});

/**
 * Steps chat's words (`surface: "chat"`) or sentences heavier or lighter with the collector's `POST /v1/intensity`, and
 * returns that dial's new level. Out of reach, or with presses still waiting, the press is made here from the status
 * last known and kept until a status read reaches the collector. Fails as `not configured` or with the collector's error.
 */
export const adjustAnnotationIntensity = Effect.fn("adjustAnnotationIntensity")(function* (
  input: AnnotationIntensityAdjustInput,
) {
  const surface = input.surface ?? "chat";
  const url = yield* intensityEndpoint("/v1/intensity");
  return yield* withKept((file, kept) =>
    Effect.gen(function* () {
      if (kept.queued.length === 0) {
        const request = yield* HttpClientRequest.post(url).pipe(
          HttpClientRequest.bodyJson({ surface, step: input.step, source: "t3" }),
        );
        const reply = yield* askCollector(request);
        if (Option.isSome(reply)) {
          const level = intensityAnswer(reply.value)?.intensity;
          if (level === undefined) return yield* refusal(reply.value);
          if (kept.status) {
            yield* writeKept(file, { ...kept, status: withDial(kept.status, surface, level) });
          }
          return level;
        }
      }
      const now = yield* Clock.currentTimeMillis;
      const status = statusAt(kept.status ?? { intensity: NORMAL, english: ENGLISH_OFF }, now);
      const from = surface === "chat" ? status.intensity : (status.sentences ?? status.intensity);
      const next = Math.max(LOWEST_LEVEL, Math.min(HIGHEST_LEVEL, from.level + input.step));
      const level = { level: next, until: next === 0 ? 0 : now + LEVEL_MS };
      const value = { ...level, at: now, source: "t3" };
      const press = {
        ...(yield* stamped(now)),
        kind: "set" as const,
        prefs: surface === "chat" ? { intensity_chat: value } : { intensity_sentences: value },
      };
      yield* writeKept(file, {
        status: withDial(status, surface, level),
        queued: keep(kept, press),
      });
      return level;
    }),
  );
}, asIntensityError);

/**
 * Sends the presses kept here, then reads the word level, the sentence level (none from a collector with one dial) and
 * English only (off from a collector without it) with `GET /v1/intensity?surface=chat`. Out of reach, it answers with
 * the status kept here, run out as the collector's would, or fails as `collector unreachable` when none is known yet.
 */
export const getAnnotationStatus = Effect.fn("getAnnotationStatus")(function* () {
  const url = yield* intensityEndpoint("/v1/intensity?surface=chat");
  return yield* withKept((file, kept) =>
    Effect.gen(function* () {
      const queued = yield* sendQueued(kept.queued);
      const reply =
        queued.length === 0
          ? yield* askCollector(HttpClientRequest.get(url))
          : Option.none<CollectorReply>();
      if (Option.isNone(reply)) {
        if (queued.length !== kept.queued.length) yield* writeKept(file, { ...kept, queued });
        if (kept.status === null) {
          return yield* new AnnotationIntensityError({ detail: UNREACHABLE });
        }
        return statusAt(kept.status, yield* Clock.currentTimeMillis);
      }
      const answer = intensityAnswer(reply.value);
      if (answer?.intensity === undefined) {
        if (queued.length !== kept.queued.length) yield* writeKept(file, { ...kept, queued });
        return yield* refusal(reply.value);
      }
      const status = {
        intensity: answer.intensity,
        english: answer.english ?? ENGLISH_OFF,
        ...(answer.sentences === undefined ? {} : { sentences: answer.sentences }),
      } satisfies AnnotationStatus;
      if (!sameStatus(status, kept.status) || queued !== kept.queued) {
        yield* writeKept(file, { status, queued });
      }
      return status;
    }),
  );
}, asIntensityError);

/**
 * Turns English only on or off at the collector with `POST /v1/english`, sending the messages on screen, and returns
 * its new state. While the collector is out of reach, the press is made and kept here, as for a level.
 */
export const setAnnotationEnglish = Effect.fn("setAnnotationEnglish")(function* (
  input: AnnotationEnglishSetInput,
) {
  const url = yield* intensityEndpoint("/v1/english");
  return yield* withKept((file, kept) =>
    Effect.gen(function* () {
      if (kept.queued.length === 0) {
        const request = yield* HttpClientRequest.post(url).pipe(
          HttpClientRequest.bodyJson({ on: input.on, source: "t3", contexts: input.contexts }),
        );
        const reply = yield* askCollector(request);
        if (Option.isSome(reply)) {
          const english = intensityAnswer(reply.value)?.english;
          if (english === undefined) return yield* refusal(reply.value);
          if (kept.status) yield* writeKept(file, { ...kept, status: { ...kept.status, english } });
          return english;
        }
      }
      const now = yield* Clock.currentTimeMillis;
      const english = { on: input.on, until: input.on ? now + ENGLISH_MS : 0, at: now };
      const press = {
        ...(yield* stamped(now)),
        kind: "english" as const,
        on: english.on,
        until: english.until,
        source: "t3",
        contexts: input.contexts,
      };
      const status = statusAt(kept.status ?? { intensity: NORMAL, english: ENGLISH_OFF }, now);
      yield* writeKept(file, { status: { ...status, english }, queued: keep(kept, press) });
      return english;
    }),
  );
}, asIntensityError);

const isReviewError = Schema.is(AnnotationReviewError);
const decodeReviewAnswer = Schema.decodeUnknownOption(
  Schema.Struct({
    ok: Schema.Boolean,
    card: Schema.optional(Schema.NullOr(AnnotationReviewCard)),
    counts: AnnotationReviewNextResult.fields.counts,
    newPerDay: AnnotationReviewNextResult.fields.newPerDay,
    error: Schema.optional(Schema.String),
  }),
);

/**
 * Asks the collector at the origin of `T3CODE_ANNOTATION_EVENTS_URL` for the next word to review (`POST /v1/review/next`,
 * passing a `newPerDay` on to save first) and returns its card (`null`: nothing due now) with its counts and new cards
 * a day when it sends them. Fails with a reason short enough to show: `not configured`, the collector's own error, its
 * status, or `collector unreachable`.
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
        ...(input.newPerDay === undefined ? {} : { newPerDay: input.newPerDay }),
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
        ...(answer.newPerDay === undefined ? {} : { newPerDay: answer.newPerDay }),
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
