import type { AnnotationInteractionsReportInput } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
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
export const forwardAnnotationInteractions = (input: AnnotationInteractionsReportInput) =>
  Effect.gen(function* () {
    const url = (yield* AnnotationEventsUrl).trim();
    if (url === "" || input.items.length === 0) return;
    const client = yield* HttpClient.HttpClient;
    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyJson({ surface: "t3", items: input.items }),
    );
    yield* HttpClientResponse.filterStatusOk(yield* client.execute(request));
  }).pipe(
    Effect.timeout("5 seconds"),
    Effect.ignore,
    Effect.withSpan("forwardAnnotationInteractions"),
  );
