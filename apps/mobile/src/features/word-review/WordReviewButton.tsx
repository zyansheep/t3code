import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";
import { View } from "react-native";

import { AndroidHeaderIconButton } from "../../components/ui/AndroidScreenHeader";
import { AppText } from "../../components/ui/AppText";
import { subscribeAppActive } from "../../lib/appState";
import { reviewCountsTotal } from "../../lib/reviewSession";
import {
  connectedEnvironmentIdsAtom,
  japaneseEnvironmentAtom,
  watchAnnotationStatus,
} from "../../state/chat-japanese";
import { reviewCountsAtom } from "../../state/chat-japanese-view";
import { refreshReviewCounts } from "../../state/word-review";

/** The connected environment whose server has the collector, watching each connected one's status to find it. */
function useJapaneseEnvironment(): EnvironmentId | null {
  const connected = useAtomValue(connectedEnvironmentIdsAtom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads each connected server's chat Japanese status from the server, which says whether it has review cards
  useEffect(() => {
    for (const environmentId of connected.split("\n")) {
      if (environmentId !== "") watchAnnotationStatus(environmentId as EnvironmentId);
    }
  }, [connected]);
  return useAtomValue(japaneseEnvironmentAtom);
}

/** Review, in the threads list's header, with the cards due today as its badge; only with a collector. */
export function WordReviewButton() {
  const environmentId = useJapaneseEnvironment();
  return environmentId === null ? null : <WordReviewEntry environmentId={environmentId} />;
}

function WordReviewEntry(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const navigation = useNavigation();
  const counts = useAtomValue(reviewCountsAtom(environmentId));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server for the badge's counts now and as the app comes back, at most every ten minutes
  useEffect(() => {
    refreshReviewCounts(environmentId);
    return subscribeAppActive(() => refreshReviewCounts(environmentId));
  }, [environmentId]);
  const due = counts === null ? 0 : reviewCountsTotal(counts);
  return (
    <View>
      <AndroidHeaderIconButton
        accessibilityLabel={due > 0 ? `Review, ${due} due` : "Review"}
        icon="rectangle.stack"
        onPress={() => navigation.navigate("WordReview", { environmentId })}
      />
      {due > 0 ? (
        <View
          pointerEvents="none"
          className="absolute right-1 top-1 h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1"
        >
          <AppText
            allowFontScaling={false}
            className="font-t3-bold text-[11px] leading-[14px] tabular-nums text-primary-foreground"
          >
            {due > 99 ? "99+" : due}
          </AppText>
        </View>
      ) : null}
    </View>
  );
}
