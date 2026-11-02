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
});

export const AnnotationInteraction = Schema.Union([AnnotationOpen, AnnotationReview]);
export type AnnotationInteraction = typeof AnnotationInteraction.Type;

export const ANNOTATION_REPORT_MAX_ITEMS = 50;

export const AnnotationInteractionsReportInput = Schema.Struct({
  items: Schema.Array(AnnotationInteraction).check(Schema.isMaxLength(ANNOTATION_REPORT_MAX_ITEMS)),
});
export type AnnotationInteractionsReportInput = typeof AnnotationInteractionsReportInput.Type;

/** Asks the collector for the next card to review; `exclude` holds the ids of cards the client already has. */
export const AnnotationReviewNextInput = Schema.Struct({
  source: Schema.Literals(["desktop", "mobile"]),
  exclude: Schema.Array(AnnotationId).check(Schema.isMaxLength(20)),
});
export type AnnotationReviewNextInput = typeof AnnotationReviewNextInput.Type;

/** A card to review: the word as written, its reading (may be empty) and its meaning. */
export const AnnotationReviewCard = Schema.Struct({
  id: AnnotationId,
  ja: AnnotationText,
  kana: Schema.String.check(Schema.isMaxLength(ANNOTATION_TEXT_MAX_LENGTH)),
  gloss: Schema.String.check(Schema.isMaxLength(200)),
});
export type AnnotationReviewCard = typeof AnnotationReviewCard.Type;

/** The next card, or `null` when there is nothing to review. */
export const AnnotationReviewNextResult = Schema.Struct({
  card: Schema.NullOr(AnnotationReviewCard),
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
