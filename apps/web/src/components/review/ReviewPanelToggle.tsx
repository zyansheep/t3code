import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { LayersIcon } from "lucide-react";
import { useEffect } from "react";

import { reviewCountsAtom, watchReviewCounts } from "~/state/annotationReview";
import { annotationStatusAtom, watchAnnotationStatus } from "~/state/annotationStatus";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { dueCount } from "./reviewSession";

/** Opens and closes the review panel, with the cards due; shown only when this client's server has a collector. */
export function ReviewPanelToggle(props: {
  readonly environmentId: EnvironmentId;
  readonly open: boolean;
  readonly shortcutLabel: string | null;
  readonly onToggle: () => void;
}) {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom) ?? props.environmentId;
  const configured = useAtomValue(annotationStatusAtom(environmentId)) !== null;
  const due = dueCount(useAtomValue(reviewCountsAtom(environmentId)));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads whether this server has a collector, which decides whether the button shows
  useEffect(() => watchAnnotationStatus(environmentId), [environmentId]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the due count fresh from the collector while the button shows
  useEffect(
    () => (configured ? watchReviewCounts(environmentId) : undefined),
    [configured, environmentId],
  );
  if (!configured) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        <Toggle
          className="shrink-0 [-webkit-app-region:no-drag]"
          pressed={props.open}
          onPressedChange={props.onToggle}
          aria-label={due > 0 ? `Toggle review panel, ${due} due` : "Toggle review panel"}
          data-review-toggle
          variant="ghost"
          size="sm"
        >
          <LayersIcon className="size-4" />
          {due > 0 ? <span className="-ms-1 text-xs tabular-nums">{due}</span> : null}
        </Toggle>
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        Review words{props.shortcutLabel ? ` (${props.shortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}
