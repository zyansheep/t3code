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

export const ANNOTATION_REPORT_MAX_ITEMS = 50;

export const AnnotationInteractionsReportInput = Schema.Struct({
  items: Schema.Array(AnnotationOpen).check(Schema.isMaxLength(ANNOTATION_REPORT_MAX_ITEMS)),
});
export type AnnotationInteractionsReportInput = typeof AnnotationInteractionsReportInput.Type;
