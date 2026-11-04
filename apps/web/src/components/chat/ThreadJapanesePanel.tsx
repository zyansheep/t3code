import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronLeftIcon, ChevronRightIcon, GaugeIcon, LanguagesIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import {
  annotationStatusAtom,
  stepAnnotationLevel,
  watchAnnotationStatus,
} from "../../state/annotationStatus";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { Switch } from "../ui/switch";
import { annotationLevelName, durationLabel } from "./annotationIntensity";
import { showChatJapaneseFailure, toggleEnglishOnlyWithToast } from "./EnglishOnlyToast";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "./threadDetailsPanelStyles";

// The buttons step between much lighter and full; turning Japanese off is English only's job.
const LOWEST_STEPPED_LEVEL = -2;
const HIGHEST_LEVEL = 3;
const STATUS_CLASS = "shrink-0 text-2xs font-normal tabular-nums text-muted-foreground";

/**
 * Chat Japanese from the language-learning tool's collector: English only, and the level of Japanese. Shown only when
 * this client's own server (else the thread's) has a collector.
 */
export function ThreadJapanesePanel(props: { readonly environmentId: EnvironmentId }) {
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const environmentId = primaryEnvironmentId ?? props.environmentId;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the collector's status for this server, which the section shows
  useEffect(() => watchAnnotationStatus(environmentId), [environmentId]);
  const status = useAtomValue(annotationStatusAtom(environmentId));
  const now = Date.parse(`${useNowMinute()}Z`);
  const [busy, setBusy] = useState(false);
  if (status === null) return null;

  const { english, intensity } = status;
  // A level that ended reads as normal until the next refresh brings the collector's.
  const levelEnded = intensity.until > 0 && intensity.until <= now;
  const level = levelEnded ? 0 : intensity.level;
  const run = async (change: () => Promise<void>) => {
    setBusy(true);
    await change();
    setBusy(false);
  };
  const step = (by: 1 | -1) =>
    void run(async () => {
      const result = await stepAnnotationLevel(environmentId, by);
      if (result && !result.ok) showChatJapaneseFailure(result.reason);
    });

  return (
    <ThreadDetailsSection
      headingId="thread-details-japanese-heading"
      title="Japanese"
      data-thread-japanese-panel
    >
      <div className="flex flex-col">
        <ThreadDetailsControl render={<label />}>
          <LanguagesIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <span className={cn(THREAD_DETAILS_PANEL_LABEL_CLASS, "min-w-0 flex-1 truncate")}>
            English only
          </span>
          <span className={STATUS_CLASS}>
            {english.on
              ? english.until > 0
                ? `On · ${durationLabel(english.until - now)} left`
                : "On"
              : "Off"}
          </span>
          <Switch
            size="sm"
            checked={english.on}
            disabled={busy}
            onCheckedChange={(on) => void run(() => toggleEnglishOnlyWithToast(environmentId, on))}
          />
        </ThreadDetailsControl>
        <div className={cn("flex items-center", THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS)}>
          <GaugeIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <span className={cn(THREAD_DETAILS_PANEL_LABEL_CLASS, "min-w-0 flex-1 truncate")}>
            Difficulty
          </span>
          {level !== 0 && intensity.until > now ? (
            <span className={STATUS_CLASS}>{durationLabel(intensity.until - now)} left</span>
          ) : null}
          <span className="-me-1.5 flex shrink-0 items-center">
            <ThreadDetailsControl
              size="icon-xs"
              variant="ghost"
              part="icon"
              aria-label="Lighter"
              disabled={busy || level <= LOWEST_STEPPED_LEVEL}
              onClick={() => step(-1)}
            >
              <ChevronLeftIcon className="size-3.5" />
            </ThreadDetailsControl>
            <span
              aria-live="polite"
              className="min-w-20 text-center text-xs font-normal text-muted-foreground"
            >
              {annotationLevelName(level)}
            </span>
            <ThreadDetailsControl
              size="icon-xs"
              variant="ghost"
              part="icon"
              aria-label="Heavier"
              disabled={busy || level >= HIGHEST_LEVEL}
              onClick={() => step(1)}
            >
              <ChevronRightIcon className="size-3.5" />
            </ThreadDetailsControl>
          </span>
        </div>
      </div>
    </ThreadDetailsSection>
  );
}
