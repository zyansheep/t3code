import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** Chat `<abbr>` popover interactions, forwarded by the server to `T3CODE_ANNOTATION_EVENTS_URL` when set. */
export const reportAnnotationInteractions = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:annotations:report",
  tag: WS_METHODS.serverReportAnnotationInteractions,
});
