import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** Chat `<abbr>` popover interactions, forwarded by the server to `T3CODE_ANNOTATION_EVENTS_URL` when set. */
export const reportAnnotationInteractions = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:annotations:report",
  tag: WS_METHODS.serverReportAnnotationInteractions,
});

/**
 * Makes chat annotations heavier or lighter for a while through the collector, answering with its new level. Presses
 * run one at a time, so a burst of them lands in order and the last answer is the current level.
 */
export const adjustAnnotationIntensity = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:annotations:intensity",
  tag: WS_METHODS.serverAdjustAnnotationIntensity,
  concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
});
