import type { AnnotationIntensity, EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { LanguagesIcon } from "lucide-react";

import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { adjustAnnotationIntensity } from "~/state/annotationInteractions";

import { annotationIntensityTitle } from "./annotationIntensity";

// One toast for every press, so a new press updates it instead of stacking another.
const TOAST_ID = "annotation-intensity";
const LEVELS = [-3, -2, -1, 0, 1, 2, 3] as const;

/** Seven steps from off (-3) to full (+3), filled from normal toward the current level. */
function AnnotationIntensityMeter({ level }: { level: number }) {
  return (
    <span
      role="meter"
      aria-label="Chat Japanese level"
      aria-valuemin={-3}
      aria-valuemax={3}
      aria-valuenow={level}
      className="inline-flex shrink-0 items-center gap-0.5"
    >
      {LEVELS.map((step) => (
        <span
          key={step}
          className={cn(
            "h-1.5 rounded-full",
            step === 0 ? "w-1.5" : "w-2.5",
            step === level
              ? "bg-primary"
              : (step > 0 && step < level) || (step < 0 && step > level)
                ? "bg-primary/45"
                : "bg-muted-foreground/25",
          )}
        />
      ))}
    </span>
  );
}

function showIntensity(intensity: AnnotationIntensity) {
  toastManager.add({
    id: TOAST_ID,
    type: "info",
    title: annotationIntensityTitle(intensity),
    description: (
      <span className="mt-0.5 flex items-center gap-2">
        <AnnotationIntensityMeter level={intensity.level} />
        <span>
          {intensity.level <= -3
            ? "No Japanese from your next message"
            : intensity.level >= 3
              ? "As much Japanese as fits, from your next message"
              : "Applies from your next message"}
        </span>
      </span>
    ),
    timeout: 4000,
    data: { leadingIcon: <LanguagesIcon className="size-4 text-muted-foreground" /> },
  });
}

function showFailure(reason: string) {
  toastManager.add({
    id: TOAST_ID,
    type: "error",
    title: "Chat Japanese: couldn't change",
    description: reason,
    timeout: 6000,
    data: {},
  });
}

/**
 * Sends one heavier or lighter press to the collector through `environmentId`'s server and shows the answer in a toast
 * that later presses replace.
 */
export async function adjustAnnotationIntensityWithToast(
  environmentId: EnvironmentId | null,
  step: 1 | -1,
) {
  if (environmentId === null) {
    showFailure("no server connected");
    return;
  }
  const result = await runAtomCommand(
    appAtomRegistry,
    adjustAnnotationIntensity,
    { environmentId, input: { step } },
    { reportFailure: false, reportDefect: false },
  );
  if (result._tag === "Success") {
    showIntensity(result.value);
    return;
  }
  if (isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  showFailure(error instanceof Error && error.message ? error.message : "request failed");
}
