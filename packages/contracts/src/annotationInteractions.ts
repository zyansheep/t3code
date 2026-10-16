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

/**
 * One opened `<abbr>` popover in a chat message: which annotation, how it opened (`peek`: hover, `pin`: click, tap or
 * Enter), when and for how long, and where every annotation of the same message sat relative to the message, as
 * `[text, x, y]`. Text and positions only, never the message itself.
 */
export const AnnotationInteraction = Schema.Struct({
  kind: Schema.Literals(["peek", "pin"]),
  word: AnnotationText,
  at: Schema.Finite,
  dwellMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  view: AnnotationId,
  context: AnnotationId,
  position: Schema.Int,
  box: Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite, Schema.Finite]),
  annotations: Schema.Array(Schema.Tuple([AnnotationText, Schema.Finite, Schema.Finite])).check(
    Schema.isMaxLength(200),
  ),
});
export type AnnotationInteraction = typeof AnnotationInteraction.Type;

export const AnnotationInteractionsReportInput = Schema.Struct({
  items: Schema.Array(AnnotationInteraction).check(Schema.isMaxLength(50)),
});
export type AnnotationInteractionsReportInput = typeof AnnotationInteractionsReportInput.Type;
