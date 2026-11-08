import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { AnnotationReviewCard, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";
import { AppState, Pressable, useWindowDimensions, View } from "react-native";
import {
  GestureDetector,
  useCompetingGestures,
  usePanGesture,
  useTapGesture,
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
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { subscribeAppState } from "../../lib/appState";
import { cn } from "../../lib/cn";
import { MOBILE_MOTION } from "../../lib/designTokens";
import { reviewIntervalLabel } from "../../lib/reviewIntervals";
import type { ReviewCounts, ReviewGrade, ReviewSession, ReviewView } from "../../lib/reviewSession";
import { createWordReviewSession } from "../../state/word-review";

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
/** While cards are due later but none now, ask again this often. */
const WAITING_RETRY_MS = 30_000;

// Anki's colours for its three counts: new blue, learning red, review green.
const QUEUES = [
  { key: "new", label: "New", className: "text-primary-text" },
  { key: "learning", label: "Learning", className: "text-danger-foreground" },
  { key: "review", label: "To review", className: "text-emerald-500" },
] as const;

const GRADES = [
  { grade: 1, label: "Again", interval: "again", className: "text-danger-foreground" },
  { grade: 2, label: "Hard", interval: "hard", className: "text-warning-foreground" },
  { grade: 3, label: "Good", interval: "good", className: "text-emerald-500" },
  { grade: 4, label: "Easy", interval: "easy", className: "text-primary-text" },
] as const;

type Swipe = "up" | "left" | "right" | null;

/** Which swipe a released pan was, on its dominant axis; a short drag is none. */
function swipeOf(
  event: { translationX: number; translationY: number; velocityX: number; velocityY: number },
  width: number,
): Swipe {
  "worklet";
  const { translationX: dx, translationY: dy, velocityX: vx, velocityY: vy } = event;
  if (Math.abs(dx) > Math.abs(dy)) {
    if (dx < -width * 0.25 || (vx < -FLING_VELOCITY && dx < -FLING_DISTANCE)) return "left";
    if (dx > width * 0.25 || (vx > FLING_VELOCITY && dx > FLING_DISTANCE)) return "right";
    return null;
  }
  return dy < -REVEAL_DISTANCE || (vy < -FLING_VELOCITY && dy < -FLING_DISTANCE) ? "up" : null;
}

/** Review cards from one environment's server, as Anki shows them. */
export function WordReviewScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: EnvironmentId }>) {
  const navigation = useNavigation();
  const goBack = () => {
    if (navigation.canGoBack()) navigation.goBack();
  };
  return (
    <View className="flex-1 bg-screen">
      <AppBar title="Review" onBack={goBack} />
      <WordReview key={route.params.environmentId} environmentId={route.params.environmentId} />
    </View>
  );
}

function WordReview(props: { readonly environmentId: EnvironmentId }) {
  const insets = useSafeAreaInsets();
  // One session per mount; the screen keys this by environment.
  const [session] = useState(() => createWordReviewSession(props.environmentId));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs the review session for the screen's lifetime, so the card on screen is reported on unmount and around the app going to the background
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
  const view: ReviewView = useSyncExternalStore(session.subscribe, session.getView);

  return (
    <View className="flex-1" style={{ paddingBottom: insets.bottom }}>
      <CountsBar
        counts={view.counts}
        current={view._tag === "card" && !view.graded ? view.card.queue : undefined}
      />
      <ReviewBody view={view} session={session} />
    </View>
  );
}

/** New, learning and to review, in Anki's colours; the current card's queue underlined, as Anki does. */
function CountsBar(props: {
  readonly counts: ReviewCounts | null;
  readonly current: AnnotationReviewCard["queue"];
}) {
  const { counts } = props;
  if (counts === null) return <View className="h-12" />;
  return (
    <View
      className="h-12 flex-row items-center justify-center gap-6"
      accessible
      accessibilityLabel={QUEUES.map((queue) => `${counts[queue.key]} ${queue.label}`).join(", ")}
    >
      {QUEUES.map((queue) => (
        <AppText
          key={queue.key}
          className={cn("font-t3-bold text-lg tabular-nums", queue.className)}
          style={props.current === queue.key ? { textDecorationLine: "underline" } : undefined}
        >
          {counts[queue.key]}
        </AppText>
      ))}
    </View>
  );
}

function ReviewBody(props: { readonly view: ReviewView; readonly session: ReviewSession }) {
  const { view, session } = props;
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
        />
      );
    case "done":
      return (
        <StatusPane
          title="Done for today"
          action={{ label: "Review more", onPress: () => session.more() }}
        />
      );
    case "waiting":
      return <WaitingPane session={session} />;
    case "error":
      return (
        <StatusPane
          title="Could not load a card"
          detail={view.detail}
          action={{ label: "Try again", onPress: () => session.next() }}
        />
      );
    case "loading":
    case "closed":
      return (
        <View className="flex-1 items-center justify-center">
          <AppActivityIndicator />
        </View>
      );
  }
}

/** Cards are due later but none now (a learning card's next step): asks again every half minute. */
function WaitingPane(props: { readonly session: ReviewSession }) {
  const { session } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the server on a timer while cards are due later, as Anki waits out a learning step
  useEffect(() => {
    const timer = setInterval(() => session.next(), WAITING_RETRY_MS);
    return () => clearInterval(timer);
  }, [session]);
  return (
    <StatusPane
      title="More cards soon"
      detail="Cards you are learning come back in a few minutes."
      action={{ label: "Check again", onPress: () => session.next() }}
    />
  );
}

function StatusPane(props: {
  readonly title: string;
  readonly detail?: string;
  readonly action: { readonly label: string; readonly onPress: () => void };
}) {
  return (
    <View className="flex-1 items-center justify-center gap-3 px-8">
      <AppText
        className="text-center font-t3-bold text-xl text-foreground"
        accessibilityRole="header"
        accessibilityLiveRegion="polite"
      >
        {props.title}
      </AppText>
      {props.detail ? (
        <AppText className="text-center text-base text-foreground-muted">{props.detail}</AppText>
      ) : null}
      <View className="mt-3">
        <Button label={props.action.label} tone="primary" onPress={props.action.onPress} />
      </View>
    </View>
  );
}

/**
 * One card: it slides in from the right and counts as shown when that ends. A tap or a swipe up reveals it; once
 * revealed, the four buttons grade it, as do a swipe left (Again) and right (Good). A graded card leaves to its side.
 */
function ReviewCard(props: {
  readonly card: AnnotationReviewCard;
  readonly showing: number;
  readonly shown: boolean;
  readonly revealed: boolean;
  readonly session: ReviewSession;
}) {
  const { card, showing, session, revealed } = props;
  const { width } = useWindowDimensions();
  const translateX = useSharedValue(width * 0.6);
  const translateY = useSharedValue(0);
  const opacity = useSharedValue(0);
  /** Set on the UI thread once the card is going, so a second swipe can't reach it. */
  const gone = useSharedValue(false);
  const reveal = () => session.reveal();
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

  /** Grades the card and sends it off to the left (Again) or the right; the next card comes when it has gone. */
  const grade = (value: ReviewGrade) => {
    if (gone.get() || !session.grade(value)) return;
    gone.set(true);
    const side = value === 1 ? -1 : 1;
    translateY.set(withTiming(0, EXIT_TIMING));
    opacity.set(withTiming(0, EXIT_TIMING));
    translateX.set(
      withTiming(side * width, EXIT_TIMING, (finished) => {
        if (finished) runOnJS(next)();
      }),
    );
  };

  const pan = usePanGesture({
    enabled: props.shown,
    onUpdate: (event) => {
      if (gone.value) return;
      translateX.set(revealed ? event.translationX : event.translationX * 0.2);
      translateY.set(event.translationY * 0.4);
    },
    onDeactivate: (event) => {
      if (gone.value) return;
      const swipe = event.canceled ? null : swipeOf(event, width);
      if (revealed && (swipe === "left" || swipe === "right")) {
        runOnJS(grade)(swipe === "left" ? 1 : 3);
        return;
      }
      if (swipe === "up") runOnJS(reveal)();
      translateX.set(withTiming(0, SETTLE_TIMING));
      translateY.set(withTiming(0, SETTLE_TIMING));
    },
  });
  const tap = useTapGesture({
    enabled: props.shown && !revealed,
    onActivate: () => {
      runOnJS(reveal)();
    },
  });
  const gesture = useCompetingGestures(pan, tap);
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateX: translateX.value }, { translateY: translateY.value }],
  }));

  return (
    <View className="flex-1">
      <GestureDetector gesture={gesture}>
        <Animated.View
          collapsable={false}
          className="flex-1 items-center justify-center px-6"
          style={animatedStyle}
          accessible
          accessibilityLabel={
            revealed ? [card.ja, card.kana, card.gloss].filter(Boolean).join(", ") : card.ja
          }
          accessibilityHint={
            revealed ? "Swipe left for again, right for good" : "Tap to show the answer"
          }
          accessibilityActions={revealed ? [] : [{ name: "activate", label: "Show answer" }]}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === "activate") reveal();
          }}
        >
          <AppText className="text-center text-foreground" style={{ fontSize: 56, lineHeight: 72 }}>
            {card.ja}
          </AppText>
          {revealed ? (
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
      <View className="min-h-20 justify-center px-3 pb-3 pt-2">
        {revealed ? (
          <View className="flex-row gap-2">
            {GRADES.map((entry) => {
              const seconds = card.intervals?.[entry.interval];
              const interval = seconds === undefined ? null : reviewIntervalLabel(seconds);
              return (
                <Pressable
                  key={entry.grade}
                  accessibilityRole="button"
                  accessibilityLabel={interval ? `${entry.label}, ${interval}` : entry.label}
                  onPress={() => grade(entry.grade)}
                  className="min-h-16 flex-1 items-center justify-center rounded-2xl bg-subtle px-1 active:opacity-70"
                >
                  {interval ? (
                    <AppText className="text-xs tabular-nums text-foreground-muted">
                      {interval}
                    </AppText>
                  ) : null}
                  <AppText className={cn("font-t3-bold text-base", entry.className)}>
                    {entry.label}
                  </AppText>
                </Pressable>
              );
            })}
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Show answer"
            accessibilityState={{ disabled: !props.shown }}
            disabled={!props.shown}
            onPress={reveal}
            className="min-h-16 items-center justify-center rounded-2xl bg-subtle active:opacity-70"
          >
            <AppText className="font-t3-medium text-base text-foreground">Show answer</AppText>
          </Pressable>
        )}
      </View>
    </View>
  );
}
