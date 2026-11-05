import { useAtomValue } from "@effect/atom-react";
import { minuteTick } from "@t3tools/client-runtime/clock";
import type { EnvironmentId } from "@t3tools/contracts";
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

/**
 * The thread menu's chat Japanese, as the desktop's thread details have it: English only, and the level with a step
 * lighter and a step heavier. Nothing while the thread's server has no collector.
 */
export function useChatJapaneseActions(environmentId: EnvironmentId): ReadonlyArray<AppBarAction> {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the collector's chat Japanese status through this server, which the menu shows and English only renders
  useEffect(() => watchAnnotationStatus(environmentId), [environmentId]);
  const status = useAtomValue(annotationStatusAtom(environmentId));
  // Only a menu with times in it follows the clock.
  const minute = useSyncExternalStore(
    status === null ? subscribeNever : minuteTick.subscribe,
    minuteTick.getSnapshot,
    minuteTick.getSnapshot,
  );
  const [busy, setBusy] = useState(false);
  if (status === null) return [];

  const now = minuteTickToEpochMs(minute);
  const { english, intensity } = status;
  // A level that ended reads as normal until the next refresh brings the collector's.
  const level = intensity.until > 0 && intensity.until <= now ? 0 : intensity.level;
  const levelLine = `Now ${LEVEL_NAMES.get(level) ?? "normal"}${
    level !== 0 && intensity.until > now ? `, ${durationLabel(intensity.until - now)} left` : ""
  }`;
  const run = (change: () => Promise<{ ok: boolean; reason?: string } | null>) => {
    setBusy(true);
    void change()
      .then((result) => {
        if (result && !result.ok) Dialog.alert("Chat Japanese: couldn't change", result.reason);
      })
      .finally(() => setBusy(false));
  };

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
    {
      accessibilityLabel: "Lighter Japanese",
      icon: "chevron.left",
      overflowOnly: true,
      subtitle: levelLine,
      disabled: busy || level <= LOWEST_STEPPED_LEVEL,
      onPress: () => run(() => stepAnnotationLevel(environmentId, -1)),
    },
    {
      accessibilityLabel: "Heavier Japanese",
      icon: "chevron.right",
      overflowOnly: true,
      subtitle: levelLine,
      disabled: busy || level >= HIGHEST_LEVEL,
      onPress: () => run(() => stepAnnotationLevel(environmentId, 1)),
    },
  ];
}
