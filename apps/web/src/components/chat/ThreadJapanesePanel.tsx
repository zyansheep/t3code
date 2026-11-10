import { useAtomValue } from "@effect/atom-react";
import type { AnnotationIntensity, EnvironmentId } from "@t3tools/contracts";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  GaugeIcon,
  HighlighterIcon,
  LanguagesIcon,
  type LucideIcon,
  PilcrowIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import {
  annotationStatusAtom,
  japaneseTintAtom,
  setJapaneseTint,
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
 * Chat Japanese from the language-learning tool's collector: English only, the level of Japanese words and the level of
 * Japanese sentences (one level for both from a collector without the second), which messages already on screen take on
 * at once, and this browser's difficulty tint. Shown only when this client's own server (else the thread's) has a
 * collector.
 */
export function ThreadJapanesePanel(props: { readonly environmentId: EnvironmentId }) {
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const environmentId = primaryEnvironmentId ?? props.environmentId;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the collector's status for this server, which the section shows
  useEffect(() => watchAnnotationStatus(environmentId), [environmentId]);
  const status = useAtomValue(annotationStatusAtom(environmentId));
  const tinted = useAtomValue(japaneseTintAtom);
  const now = Date.parse(`${useNowMinute()}Z`);
  const [busy, setBusy] = useState(false);
  if (status === null) return null;

  const { english, intensity, sentences } = status;
  const run = async (change: () => Promise<void>) => {
    setBusy(true);
    await change();
    setBusy(false);
  };
  const step = (by: 1 | -1, surface: "chat" | "sentences") =>
    void run(async () => {
      const result = await stepAnnotationLevel(environmentId, by, surface);
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
        {/* A collector with one level for both has one dial, as before. */}
        <LevelRow
          icon={GaugeIcon}
          label={sentences ? "Words" : "Difficulty"}
          noun={sentences ? " words" : ""}
          level={intensity}
          now={now}
          disabled={busy}
          onStep={(by) => step(by, "chat")}
        />
        {sentences ? (
          <LevelRow
            icon={PilcrowIcon}
            label="Sentences"
            noun=" sentences"
            level={sentences}
            now={now}
            disabled={busy}
            onStep={(by) => step(by, "sentences")}
          />
        ) : null}
        <ThreadDetailsControl render={<label />}>
          <HighlighterIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <span className={cn(THREAD_DETAILS_PANEL_LABEL_CLASS, "min-w-0 flex-1 truncate")}>
            Difficulty tint
          </span>
          <Switch size="sm" checked={tinted} onCheckedChange={setJapaneseTint} />
        </ThreadDetailsControl>
      </div>
    </ThreadDetailsSection>
  );
}

/** One dial: its time left, a step lighter, its level's name and a step heavier. */
function LevelRow(props: {
  readonly icon: LucideIcon;
  readonly label: string;
  /** What the buttons' names step, after Lighter and Heavier. */
  readonly noun: string;
  readonly level: AnnotationIntensity;
  readonly now: number;
  readonly disabled: boolean;
  readonly onStep: (by: 1 | -1) => void;
}) {
  const { level, until } = props.level;
  const Icon = props.icon;
  return (
    <div className={cn("flex items-center", THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS)}>
      <Icon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
      <span className={cn(THREAD_DETAILS_PANEL_LABEL_CLASS, "min-w-0 flex-1 truncate")}>
        {props.label}
      </span>
      {level !== 0 && until > props.now ? (
        <span className={STATUS_CLASS}>{durationLabel(until - props.now)} left</span>
      ) : null}
      <span className="-me-1.5 flex shrink-0 items-center">
        <ThreadDetailsControl
          size="icon-xs"
          variant="ghost"
          part="icon"
          aria-label={`Lighter${props.noun}`}
          disabled={props.disabled || level <= LOWEST_STEPPED_LEVEL}
          onClick={() => props.onStep(-1)}
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
          aria-label={`Heavier${props.noun}`}
          disabled={props.disabled || level >= HIGHEST_LEVEL}
          onClick={() => props.onStep(1)}
        >
          <ChevronRightIcon className="size-3.5" />
        </ThreadDetailsControl>
      </span>
    </div>
  );
}
