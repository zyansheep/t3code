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

/**
 * One glossed word opened in a chat message (`peek`: hover, `pin`: tap or click); `uid` stores a resent report once.
 * Text and positions only, never the message. The part of the Z3 Code desktop's report the phone sends, under the same
 * RPC; the phone knows no positions, so it lists only the opened word (apps/mobile/src/lib/glossOpens.ts).
 */
export const AnnotationOpen = Schema.Struct({
  at: Schema.Finite,
  view: AnnotationId,
  context: AnnotationId,
  box: Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite, Schema.Finite]),
  annotations: Schema.Array(Schema.Tuple([AnnotationText, Schema.Finite, Schema.Finite])).check(
    Schema.isMaxLength(200),
  ),
  kind: Schema.Literals(["peek", "pin"]),
  word: AnnotationText,
  dwellMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  position: Schema.Int,
  uid: Schema.optional(AnnotationId),
});
export type AnnotationOpen = typeof AnnotationOpen.Type;

/**
 * One review card shown from a gloss popover's wedge (desktop) or the phone's flashcards: the card the collector
 * served, when it was shown, how long until its meaning was revealed (`null`: moved on or closed without revealing)
 * and how long it was on screen in all.
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
  /** Again, Hard, Good or Easy; only after a reveal. Without it the card was left and stays due. */
  grade: Schema.optional(Schema.Literals([1, 2, 3, 4])),
  /** From shown to the grade: `revealMs <= gradeMs <= shownMs`. */
  gradeMs: Schema.optional(Duration),
});

export const AnnotationInteraction = Schema.Union([AnnotationOpen, AnnotationReview]);
export type AnnotationInteraction = typeof AnnotationInteraction.Type;

export const ANNOTATION_REPORT_MAX_ITEMS = 50;

export const AnnotationInteractionsReportInput = Schema.Struct({
  items: Schema.Array(AnnotationInteraction).check(Schema.isMaxLength(ANNOTATION_REPORT_MAX_ITEMS)),
});
export type AnnotationInteractionsReportInput = typeof AnnotationInteractionsReportInput.Type;

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
 * ("Review more" once the day is done) lifts today's limit on new cards for this request, and `peek` asks for the
 * counts alone (for a badge): no card is served or recorded.
 */
export const AnnotationReviewNextInput = Schema.Struct({
  source: Schema.Literals(["desktop", "mobile"]),
  exclude: Schema.Array(AnnotationId).check(Schema.isMaxLength(20)),
  more: Schema.optional(Schema.Boolean),
  peek: Schema.optional(Schema.Boolean),
});
export type AnnotationReviewNextInput = typeof AnnotationReviewNextInput.Type;

/**
 * A card to review: the word as written, its reading (may be empty) and its meaning, its queue, and for each grade the
 * seconds until it would come back.
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

const ReviewCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * The next card, or `null` when there is nothing to review, with Anki's three counts: new cards left today, learning
 * cards due now and review cards due today.
 */
export const AnnotationReviewNextResult = Schema.Struct({
  card: Schema.NullOr(AnnotationReviewCard),
  counts: Schema.optional(
    Schema.Struct({ new: ReviewCount, learning: ReviewCount, review: ReviewCount }),
  ),
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
