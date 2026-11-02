import { useAtomValue } from "@effect/atom-react";
import type { AnnotationReviewCard, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";
import { AppState, Modal, useWindowDimensions, View } from "react-native";
import {
  GestureDetector,
  GestureHandlerRootView,
  usePanGesture,
} from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText } from "../../components/ui/AppText";
import { IconButton } from "../../components/ui/IconButton";
import { subscribeAppState } from "../../lib/appState";
import { MOBILE_MOTION } from "../../lib/designTokens";
import type { ReviewSession, ReviewView } from "../../lib/reviewSession";
import { createFlashcardSession } from "../../state/flashcards";
import { closeFlashcards, flashcardsEnvironmentAtom } from "../../state/flashcards-open";

const ENTER_TIMING = {
  duration: MOBILE_MOTION.enter,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
};
const EXIT_TIMING = {
  duration: MOBILE_MOTION.exit,
  easing: Easing.in(Easing.cubic),
  reduceMotion: ReduceMotion.System,
};
const SETTLE_TIMING = { duration: 160, reduceMotion: ReduceMotion.System };
const REVEAL_FADE = FadeIn.duration(MOBILE_MOTION.enter).reduceMotion(ReduceMotion.System);
/** A fling counts at a shorter distance than a slow drag. */
const FLING_VELOCITY = 800;
const FLING_DISTANCE = 24;
const REVEAL_DISTANCE = 72;
const CLOSE_DISTANCE = 120;

const HINT = "swipe up to reveal · left for next";

type Swipe = "up" | "left" | "down" | null;

/** Which swipe a released pan was, on its dominant axis; a tap or a short drag is none. */
function swipeOf(
  event: { translationX: number; translationY: number; velocityX: number; velocityY: number },
  width: number,
): Swipe {
  "worklet";
  const { translationX: dx, translationY: dy, velocityX: vx, velocityY: vy } = event;
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx < -width * 0.25 || (vx < -FLING_VELOCITY && dx < -FLING_DISTANCE) ? "left" : null;
  }
  if (dy < -REVEAL_DISTANCE || (vy < -FLING_VELOCITY && dy < -FLING_DISTANCE)) return "up";
  if (dy > CLOSE_DISTANCE || (vy > FLING_VELOCITY && dy > FLING_DISTANCE)) return "down";
  return null;
}

/** Mounted once at the root: the review cards a gloss's wedge opened, full screen. */
export function FlashcardHost() {
  const environmentId = useAtomValue(flashcardsEnvironmentAtom);
  return environmentId === null ? null : (
    <FlashcardReview key={environmentId} environmentId={environmentId} />
  );
}

function FlashcardReview(props: { readonly environmentId: EnvironmentId }) {
  // One session per mount; the host keys this by environment.
  const [session] = useState(() => createFlashcardSession(props.environmentId));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs the review session for the modal's lifetime, so the card on screen is reported on unmount and around the app going to the background
  useEffect(() => {
    session.start();
    const stopAppState = subscribeAppState(() => {
      if (AppState.currentState === "background") session.suspend();
      else if (AppState.currentState === "active") session.resume();
    });
    return () => {
      stopAppState();
      session.close();
    };
  }, [session]);
  const close = () => {
    session.close();
    closeFlashcards();
  };

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={close}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        {/* A Modal is its own native hierarchy, so it measures its own safe area. */}
        <SafeAreaProvider style={{ flex: 1 }}>
          <View className="flex-1 bg-screen">
            <SafeAreaView style={{ flex: 1 }}>
              <View className="min-h-14 flex-row items-center justify-end px-2">
                <IconButton icon="xmark" accessibilityLabel="Close review" onPress={close} />
              </View>
              <ReviewBody session={session} onClose={close} />
              <AppText
                className="px-6 pb-4 pt-2 text-center text-sm text-foreground-tertiary"
                importantForAccessibility="no"
              >
                {HINT}
              </AppText>
            </SafeAreaView>
          </View>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </Modal>
  );
}

function ReviewBody(props: { readonly session: ReviewSession; readonly onClose: () => void }) {
  const { session, onClose } = props;
  const view: ReviewView = useSyncExternalStore(session.subscribe, session.getView);
  switch (view._tag) {
    case "card":
      return (
        <ReviewCard
          key={view.showing}
          card={view.card}
          showing={view.showing}
          shown={view.shown}
          revealed={view.revealed}
          session={session}
          onClose={onClose}
        />
      );
    case "empty":
      return (
        <StatusPane
          text="Nothing to review right now"
          onNext={() => session.next()}
          onClose={onClose}
        />
      );
    case "error":
      return <StatusPane text={view.detail} onNext={() => session.next()} onClose={onClose} />;
    case "loading":
    case "closed":
      return <StatusPane onClose={onClose} />;
  }
}

/** Loading, nothing to review or an error: no card, so only left (ask again) and down (close) mean anything. */
function StatusPane(props: {
  readonly text?: string;
  readonly onNext?: () => void;
  readonly onClose: () => void;
}) {
  const { width } = useWindowDimensions();
  const { onNext, onClose } = props;
  const next = () => onNext?.();
  const gesture = usePanGesture({
    onDeactivate: (event) => {
      if (event.canceled) return;
      const swipe = swipeOf(event, width);
      if (swipe === "down") runOnJS(onClose)();
      else if (swipe === "left") runOnJS(next)();
    },
  });
  return (
    <GestureDetector gesture={gesture}>
      <View collapsable={false} className="flex-1 items-center justify-center px-8">
        {props.text === undefined ? (
          <AppActivityIndicator />
        ) : (
          <AppText
            className="text-center text-base text-foreground-muted"
            accessibilityLiveRegion="polite"
          >
            {props.text}
          </AppText>
        )}
      </View>
    </GestureDetector>
  );
}

/**
 * One card: it slides in from the right and counts as shown when that ends; swipe up reveals, swipe left sends it off
 * to the left, swipe down closes. A tap does nothing.
 */
function ReviewCard(props: {
  readonly card: AnnotationReviewCard;
  readonly showing: number;
  readonly shown: boolean;
  readonly revealed: boolean;
  readonly session: ReviewSession;
  readonly onClose: () => void;
}) {
  const { card, showing, session, onClose } = props;
  const { width } = useWindowDimensions();
  const translateX = useSharedValue(width * 0.6);
  const translateY = useSharedValue(0);
  const opacity = useSharedValue(0);
  /** Set on the UI thread once the card is going, so a second swipe can't reach it. */
  const gone = useSharedValue(false);
  const reveal = () => session.reveal();
  const leave = () => session.leave();
  const next = () => session.next();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs the card's enter animation once; its end is when the card counts as shown
  useEffect(() => {
    const markShown = () => session.cardShown(showing);
    translateX.set(
      withTiming(0, ENTER_TIMING, (finished) => {
        if (finished) runOnJS(markShown)();
      }),
    );
    opacity.set(withTiming(1, ENTER_TIMING));
    return () => {
      cancelAnimation(translateX);
      cancelAnimation(translateY);
      cancelAnimation(opacity);
    };
  }, [session, showing, translateX, translateY, opacity]);

  const gesture = usePanGesture({
    enabled: props.shown,
    onUpdate: (event) => {
      if (gone.value) return;
      translateX.set(event.translationX < 0 ? event.translationX : event.translationX * 0.2);
      translateY.set(event.translationY * 0.4);
    },
    onDeactivate: (event) => {
      if (gone.value) return;
      const swipe = event.canceled ? null : swipeOf(event, width);
      if (swipe === "left") {
        gone.set(true);
        runOnJS(leave)();
        translateY.set(withTiming(0, EXIT_TIMING));
        opacity.set(withTiming(0, EXIT_TIMING));
        translateX.set(
          withTiming(-width, EXIT_TIMING, (finished) => {
            if (finished) runOnJS(next)();
          }),
        );
        return;
      }
      if (swipe === "down") {
        gone.set(true);
        runOnJS(onClose)();
        return;
      }
      if (swipe === "up") runOnJS(reveal)();
      translateX.set(withTiming(0, SETTLE_TIMING));
      translateY.set(withTiming(0, SETTLE_TIMING));
    },
  });
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateX: translateX.value }, { translateY: translateY.value }],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        collapsable={false}
        className="flex-1 items-center justify-center px-6"
        style={animatedStyle}
        accessible
        accessibilityLabel={
          props.revealed ? [card.ja, card.kana, card.gloss].filter(Boolean).join(", ") : card.ja
        }
        accessibilityHint={HINT}
        accessibilityActions={[
          { name: "reveal", label: "Reveal meaning" },
          { name: "next", label: "Next card" },
        ]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === "reveal") reveal();
          else if (event.nativeEvent.actionName === "next") next();
        }}
      >
        <AppText className="text-center text-foreground" style={{ fontSize: 56, lineHeight: 72 }}>
          {card.ja}
        </AppText>
        {props.revealed ? (
          <Animated.View entering={REVEAL_FADE} className="mt-6 items-center gap-2">
            {card.kana.length > 0 ? (
              <AppText
                className="text-center text-foreground-secondary"
                style={{ fontSize: 24, lineHeight: 32 }}
              >
                {card.kana}
              </AppText>
            ) : null}
            <AppText
              className="text-center text-foreground-muted"
              style={{ fontSize: 18, lineHeight: 26 }}
            >
              {card.gloss}
            </AppText>
          </Animated.View>
        ) : null}
      </Animated.View>
    </GestureDetector>
  );
}
