import { useAtomValue } from "@effect/atom-react";
import { minuteTick } from "@t3tools/client-runtime/clock";
import type { AnnotationIntensity, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";

import type { AppBarAction } from "../../components/ui/AppBar.types";
import * as Dialog from "../../components/ui/Dialog";
import { minuteTickToEpochMs } from "../../lib/clock";
import {
  setEnglishOnly,
  stepAnnotationLevel,
  watchAnnotationStatus,
} from "../../state/chat-japanese";
import { annotationStatusAtom } from "../../state/chat-japanese-view";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

const LEVEL_NAMES = new Map([
  [-3, "off"],
  [-2, "much lighter"],
  [-1, "lighter"],
  [0, "normal"],
  [1, "heavier"],
  [2, "much heavier"],
  [3, "full"],
]);
// The steps go between much lighter and full; turning Japanese off is English only's job.
const LOWEST_STEPPED_LEVEL = -2;
const HIGHEST_LEVEL = 3;

const subscribeNever = () => () => undefined;

/** A time left, to the minute: "42 min", "1 hour", "2 h 5 min". */
function durationLabel(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (rest === 0) return hours === 1 ? "1 hour" : `${hours} hours`;
  return `${hours} h ${rest} min`;
}

// A level that ended reads as normal until the next refresh brings the collector's.
const levelNow = (dial: AnnotationIntensity, now: number) =>
  dial.until > 0 && dial.until <= now ? 0 : dial.level;

/** A dial's line in the menu: its level now, and its time left. */
function levelLine(dial: AnnotationIntensity, now: number): string {
  const level = levelNow(dial, now);
  return `Now ${LEVEL_NAMES.get(level) ?? "normal"}${
    level !== 0 && dial.until > now ? `, ${durationLabel(dial.until - now)} left` : ""
  }`;
}

/**
 * The thread menu's chat Japanese, as the desktop's thread details have it: English only; the word level and, from a
 * collector with one, the sentence level, each with a step lighter and a step heavier; and this phone's difficulty
 * tint. Nothing while the thread's server has no collector.
 */
export function useChatJapaneseActions(environmentId: EnvironmentId): ReadonlyArray<AppBarAction> {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the collector's chat Japanese status through this server, which the menu shows and English only renders
  useEffect(() => watchAnnotationStatus(environmentId), [environmentId]);
  const status = useAtomValue(annotationStatusAtom(environmentId));
  const { chatJapaneseTintEnabled: tinted, setChatJapaneseTintEnabled } =
    useAppearancePreferences();
  // Only a menu with times in it follows the clock.
  const minute = useSyncExternalStore(
    status === null ? subscribeNever : minuteTick.subscribe,
    minuteTick.getSnapshot,
    minuteTick.getSnapshot,
  );
  const [busy, setBusy] = useState(false);
  if (status === null) return [];

  const now = minuteTickToEpochMs(minute);
  const { english, intensity, sentences } = status;
  const run = (change: () => Promise<{ ok: boolean; reason?: string } | null>) => {
    setBusy(true);
    void change()
      .then((result) => {
        if (result && !result.ok) Dialog.alert("Chat Japanese: couldn't change", result.reason);
      })
      .finally(() => setBusy(false));
  };
  // A collector with one level for both has one dial, as before.
  const dials: ReadonlyArray<{
    readonly surface: "chat" | "sentences";
    readonly noun: string;
    readonly dial: AnnotationIntensity;
  }> = [
    { surface: "chat", noun: sentences ? "Japanese words" : "Japanese", dial: intensity },
    ...(sentences
      ? ([{ surface: "sentences", noun: "Japanese sentences", dial: sentences }] as const)
      : []),
  ];

  return [
    {
      accessibilityLabel: "English only",
      icon: "globe",
      overflowOnly: true,
      selected: english.on,
      subtitle: english.on
        ? english.until > now
          ? `On, ${durationLabel(english.until - now)} left`
          : "On"
        : "Off",
      disabled: busy,
      onPress: () => run(() => setEnglishOnly(environmentId, !english.on)),
    },
    ...dials.flatMap(({ surface, noun, dial }): AppBarAction[] => {
      const subtitle = levelLine(dial, now);
      const level = levelNow(dial, now);
      return [
        {
          accessibilityLabel: `Lighter ${noun}`,
          icon: "chevron.left",
          overflowOnly: true,
          subtitle,
          disabled: busy || level <= LOWEST_STEPPED_LEVEL,
          onPress: () => run(() => stepAnnotationLevel(environmentId, -1, surface)),
        },
        {
          accessibilityLabel: `Heavier ${noun}`,
          icon: "chevron.right",
          overflowOnly: true,
          subtitle,
          disabled: busy || level >= HIGHEST_LEVEL,
          onPress: () => run(() => stepAnnotationLevel(environmentId, 1, surface)),
        },
      ];
    }),
    {
      accessibilityLabel: "Difficulty tint",
      icon: "paintbrush",
      overflowOnly: true,
      selected: tinted,
      // Words only: a tinted sentence would be a link, which Android's long press can't select.
      subtitle: tinted ? "On for words, on this phone" : "Off, on this phone",
      onPress: () => setChatJapaneseTintEnabled(!tinted),
    },
  ];
}
