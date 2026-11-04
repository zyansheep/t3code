import type { EnvironmentId } from "@t3tools/contracts";
import { LanguagesIcon } from "lucide-react";

import { toastManager } from "~/components/ui/toast";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { englishOnlyAtom, setEnglishOnly } from "~/state/annotationStatus";

import { durationLabel } from "./annotationIntensity";

// One toast for every press, so a new press updates it instead of stacking another.
const TOAST_ID = "chat-japanese";

/** Shows why a chat Japanese change failed, in the toast later changes replace. */
export function showChatJapaneseFailure(reason: string) {
  toastManager.add({
    id: TOAST_ID,
    type: "error",
    title: "Chat Japanese: couldn't change",
    description: reason,
    timeout: 6000,
    data: {},
  });
}

/** Turns English only on or off (`on`, else the other way) through `environmentId`'s server, saying so in a toast. */
export async function toggleEnglishOnlyWithToast(
  environmentId: EnvironmentId | null,
  on?: boolean,
) {
  if (environmentId === null) {
    showChatJapaneseFailure("no server connected");
    return;
  }
  const change = await setEnglishOnly(
    environmentId,
    on ?? !appAtomRegistry.get(englishOnlyAtom(environmentId)),
  );
  if (change === null) return;
  if (!change.ok) {
    showChatJapaneseFailure(change.reason);
    return;
  }
  const { until } = change.value;
  toastManager.add({
    id: TOAST_ID,
    type: "info",
    title: !change.value.on
      ? "Japanese back on"
      : until > 0
        ? `English only for ${durationLabel(until - Date.now())}`
        : "English only",
    timeout: 3000,
    data: { leadingIcon: <LanguagesIcon className="size-4 text-muted-foreground" /> },
  });
}
