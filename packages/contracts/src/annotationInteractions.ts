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
});

/**
 * Where the reader was in a message with annotations, by position only: a click (`target`: a link or control, or
 * text), a text selection (its box, length and the annotations it covered, by index), one stay of a paragraph on
 * screen (its band in the message; `ms` the time a reader could have been reading it, `wall` all of it, and `away`,
 * `media` and `idle` the rest by why it doesn't count), or a mouse path (`[ms since at, x, y]` points).
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

export const AnnotationInteraction = Schema.Union([
  AnnotationOpen,
  AnnotationClick,
  AnnotationSelect,
  AnnotationVisible,
  AnnotationTrace,
]);
export type AnnotationInteraction = typeof AnnotationInteraction.Type;
export type AnnotationReading = Exclude<AnnotationInteraction, typeof AnnotationOpen.Type>;

export const AnnotationInteractionsReportInput = Schema.Struct({
  items: Schema.Array(AnnotationInteraction).check(Schema.isMaxLength(50)),
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

export class AnnotationIntensityError extends Schema.TaggedError<AnnotationIntensityError>()(
  "AnnotationIntensityError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
