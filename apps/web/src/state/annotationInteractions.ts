import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** Chat `<abbr>` popover interactions, forwarded by the server to `T3CODE_ANNOTATION_EVENTS_URL` when set. */
export const reportAnnotationInteractions = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:annotations:report",
  tag: WS_METHODS.serverReportAnnotationInteractions,
});

/**
 * Makes chat annotations heavier or lighter for a while through the collector, answering with its new level. Steps
 * run one at a time, so a burst of them lands in order and the last answer is the current level.
 */
export const adjustAnnotationIntensity = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:annotations:intensity",
  tag: WS_METHODS.serverAdjustAnnotationIntensity,
  concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
});

/** The next word to review in a gloss popover, served by the collector through this client's own server. */
export const nextAnnotationReview = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:annotations:review",
  tag: WS_METHODS.serverNextAnnotationReview,
});

/** The collector's chat level and English-only state, through this client's own server. */
export const getAnnotationStatus = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:annotations:status",
  tag: WS_METHODS.serverGetAnnotationStatus,
});

/** Turns English only on or off; toggles run one at a time, so the last answer is the current state. */
export const setAnnotationEnglish = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:annotations:english",
  tag: WS_METHODS.serverSetAnnotationEnglish,
  concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
});
