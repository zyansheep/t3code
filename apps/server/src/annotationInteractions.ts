import {
  AnnotationIntensityError,
  type AnnotationInteractionsReportInput,
  AnnotationReviewError,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

/** Where chat gloss interactions go: an external collector, for example a language-learning tool. */
const AnnotationEventsUrl = Config.String("T3CODE_ANNOTATION_EVENTS_URL").pipe(
  Config.withDefault(""),
);

/**
 * Forwards gloss interactions from chat clients to `T3CODE_ANNOTATION_EVENTS_URL` as
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

/**
 * Review cards are served by the Z3 Code desktop server, which the phone talks to; this server only declares the RPC
 * (the contract is shared), so a client that asks it gets a short reason instead of a card.
 */
export const noAnnotationReview = Effect.fail(
  new AnnotationReviewError({ detail: "This server has no review cards" }),
);

/**
 * Chat Japanese status, level and English only come from the Z3 Code desktop server's collector too. "not configured" is
 * the answer a desktop server without a collector gives, which clients read as no Japanese controls.
 */
export const noAnnotationControls = Effect.fail(
  new AnnotationIntensityError({ detail: "not configured" }),
);
