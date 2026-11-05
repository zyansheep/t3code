import * as Schema from "effect/Schema";

const ANNOTATION_TEXT_MAX_LENGTH = 40;
const ANNOTATION_ID_MAX_LENGTH = 64;

const AnnotationText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(ANNOTATION_TEXT_MAX_LENGTH),
);
const AnnotationId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(ANNOTATION_ID_MAX_LENGTH),
);

const Duration = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** Where a message sat and where every annotation in it sat relative to the message, as `[text, x, y]`. */
const AnnotationPlace = {
  at: Schema.Finite,
  view: AnnotationId,
  context: AnnotationId,
  box: Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite, Schema.Finite]),
  annotations: Schema.Array(Schema.Tuple([AnnotationText, Schema.Finite, Schema.Finite])).check(
    Schema.isMaxLength(200),
  ),
};

/**
 * One opened `<abbr>` popover in a chat message: which annotation, how it opened (`peek`: hover, `pin`: click, tap or
 * Enter), when and for how long. Text and positions only, never the message itself.
 */
const AnnotationOpen = Schema.Struct({
  ...AnnotationPlace,
  kind: Schema.Literals(["peek", "pin"]),
  word: AnnotationText,
  dwellMs: Duration,
  position: Schema.Int,
  /** Client id, so a report sent twice (the phone's queue retries) is stored once. */
  uid: Schema.optional(AnnotationId),
});

/**
 * Where the reader was in a message with annotations, by position only: a click (`target`: link or control, or text), a
 * selection (box, length, covered annotations by index), a paragraph's stay on screen (`ms` readable time, `wall` all of
 * it, `away`/`media`/`idle` the rest), or a mouse path (`[ms since at, x, y]`). `words` counts Latin-script words outside
 * code plus one per annotation that is a word (one of only punctuation translates a sentence).
 */
const AnnotationClick = Schema.Struct({
  ...AnnotationPlace,
  kind: Schema.Literal("click"),
  x: Schema.Finite,
  y: Schema.Finite,
  target: Schema.Literals(["text", "link"]),
});
const AnnotationSelect = Schema.Struct({
  ...AnnotationPlace,
  kind: Schema.Literal("select"),
  x: Schema.Finite,
  y: Schema.Finite,
  width: Duration,
  height: Duration,
  chars: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  covered: Schema.Array(Schema.Int).check(Schema.isMaxLength(200)),
  ms: Duration,
});
const AnnotationVisible = Schema.Struct({
  ...AnnotationPlace,
  kind: Schema.Literal("visible"),
  y: Schema.Finite,
  height: Duration,
  words: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ms: Duration,
  wall: Duration,
  away: Duration,
  media: Duration,
  idle: Duration,
});
const AnnotationTrace = Schema.Struct({
  ...AnnotationPlace,
  kind: Schema.Literal("trace"),
  points: Schema.Array(Schema.Tuple([Duration, Schema.Finite, Schema.Finite])).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(200),
  ),
});

/** A message's first time on screen in its view, sent once with its `words`, which opens are counted against. */
const AnnotationShown = Schema.Struct({
  ...AnnotationPlace,
  kind: Schema.Literal("shown"),
  words: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 })),
});

/**
 * One review card shown in the desktop's review panel or the phone's flashcards: the card the collector served, when it
 * was shown, how long until its meaning was revealed (`null`: left without revealing) and how long it was on screen in
 * all. A graded card carries its `grade` (1 Again, 2 Hard, 3 Good, 4 Easy) and `gradeMs`, with
 * `revealMs <= gradeMs <= shownMs`; one without was left, which the collector does not schedule.
 */
const AnnotationReview = Schema.Struct({
  kind: Schema.Literal("review"),
  at: Schema.Finite,
  card: AnnotationId,
  word: AnnotationText,
  revealMs: Schema.NullOr(Duration),
  shownMs: Duration,
  source: Schema.Literals(["desktop", "mobile"]),
  uid: Schema.optional(AnnotationId),
  grade: Schema.optional(Schema.Literals([1, 2, 3, 4])),
  gradeMs: Schema.optional(Duration),
});

export const AnnotationInteraction = Schema.Union([
  AnnotationOpen,
  AnnotationClick,
  AnnotationSelect,
  AnnotationVisible,
  AnnotationTrace,
  AnnotationShown,
  AnnotationReview,
]);
export type AnnotationInteraction = typeof AnnotationInteraction.Type;
export type AnnotationReading = Exclude<
  AnnotationInteraction,
  typeof AnnotationOpen.Type | typeof AnnotationReview.Type
>;

export const AnnotationInteractionsReportInput = Schema.Struct({
  items: Schema.Array(AnnotationInteraction).check(Schema.isMaxLength(50)),
});
export type AnnotationInteractionsReportInput = typeof AnnotationInteractionsReportInput.Type;

/**
 * A report with review items the collector did not store: `retryable` when it could not be reached or failed, so the
 * same items (same uids) can be sent again; not when it rejected one, which a resend would not change.
 */
export class AnnotationReportError extends Schema.TaggedError<AnnotationReportError>()(
  "AnnotationReportError",
  { detail: Schema.String, retryable: Schema.Boolean },
) {
  override get message(): string {
    return this.detail;
  }
}

/** One press of a chat shortcut that makes annotated words heavier (`1`) or lighter (`-1`) for a while. */
export const AnnotationIntensityAdjustInput = Schema.Struct({
  step: Schema.Literals([1, -1]),
});
export type AnnotationIntensityAdjustInput = typeof AnnotationIntensityAdjustInput.Type;

/**
 * The collector's temporary chat level after a press, from `-3` (no Japanese) to `3` (everything that can be Japanese
 * is), and when it ends (epoch ms, `0` at level 0).
 */
export const AnnotationIntensity = Schema.Struct({
  level: Schema.Int.check(Schema.isBetween({ minimum: -3, maximum: 3 })),
  until: Schema.Finite,
});
export type AnnotationIntensity = typeof AnnotationIntensity.Type;

/** Chat in English only, no Japanese, for a while: whether it is on, when it ends and when it was set (epoch ms, `0` if never). */
export const AnnotationEnglish = Schema.Struct({
  on: Schema.Boolean,
  until: Schema.Finite,
  at: Schema.Finite,
});
export type AnnotationEnglish = typeof AnnotationEnglish.Type;

/** The collector's chat level and English-only state, as the client shows and renders them. */
export const AnnotationStatus = Schema.Struct({
  intensity: AnnotationIntensity,
  english: AnnotationEnglish,
});
export type AnnotationStatus = typeof AnnotationStatus.Type;

/**
 * Turns English only on or off. `contexts` are the messages on screen when it is turned on, by the `view` and `context`
 * their annotation reports carry, so the collector knows whose Japanese the reader swapped for English; empty when off.
 */
export const AnnotationEnglishSetInput = Schema.Struct({
  on: Schema.Boolean,
  contexts: Schema.Array(Schema.Struct({ view: AnnotationId, context: AnnotationId })).check(
    Schema.isMaxLength(30),
  ),
});
export type AnnotationEnglishSetInput = typeof AnnotationEnglishSetInput.Type;

export class AnnotationIntensityError extends Schema.TaggedError<AnnotationIntensityError>()(
  "AnnotationIntensityError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * Asks the collector for the next card to review; `exclude` holds the ids of cards the client already has, `more`
 * (Review more, once the day is done) ignores today's new-card limit for this request, `peek` asks for the counts
 * alone, with no card served or recorded, and `release` names cards served to this client but never shown, so the
 * collector can serve them again at once.
 */
export const AnnotationReviewNextInput = Schema.Struct({
  source: Schema.Literals(["desktop", "mobile"]),
  exclude: Schema.Array(AnnotationId).check(Schema.isMaxLength(20)),
  more: Schema.optional(Schema.Boolean),
  peek: Schema.optional(Schema.Boolean),
  release: Schema.optional(Schema.Array(AnnotationId).check(Schema.isMaxLength(20))),
});
export type AnnotationReviewNextInput = typeof AnnotationReviewNextInput.Type;

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * A card to review: the word as written, its reading (may be empty) and its meaning, with its queue and, per grade,
 * the seconds until it would come back (what Anki prints above its buttons). Collectors before scheduling send neither.
 */
export const AnnotationReviewCard = Schema.Struct({
  id: AnnotationId,
  ja: AnnotationText,
  kana: Schema.String.check(Schema.isMaxLength(ANNOTATION_TEXT_MAX_LENGTH)),
  gloss: Schema.String.check(Schema.isMaxLength(200)),
  queue: Schema.optional(Schema.Literals(["new", "learning", "review"])),
  intervals: Schema.optional(
    Schema.Struct({ again: Duration, hard: Duration, good: Duration, easy: Duration }),
  ),
});
export type AnnotationReviewCard = typeof AnnotationReviewCard.Type;

/**
 * The next card, or `null` when nothing is due now, with Anki's three numbers: new cards left today, learning cards
 * due now and review cards due today (all 0: done for today).
 */
export const AnnotationReviewNextResult = Schema.Struct({
  card: Schema.NullOr(AnnotationReviewCard),
  counts: Schema.optional(Schema.Struct({ new: Count, learning: Count, review: Count })),
});
export type AnnotationReviewNextResult = typeof AnnotationReviewNextResult.Type;

export class AnnotationReviewError extends Schema.TaggedError<AnnotationReviewError>()(
  "AnnotationReviewError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
