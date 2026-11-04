import type {
  AnnotationInteraction,
  AnnotationReviewCard,
  EnvironmentId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ChevronRightIcon } from "lucide-react";
import { type RefObject, useEffect, useEffectEvent, useRef, useState } from "react";

import { isEditableFocused } from "~/lib/editableFocus";
import { randomUUID } from "~/lib/utils";
import { nextAnnotationReview } from "~/state/annotationInteractions";
import { useAtomCommand } from "~/state/use-atom-command";

type ReviewView =
  | { readonly phase: "off" }
  | { readonly phase: "loading" }
  | {
      readonly phase: "card";
      readonly card: AnnotationReviewCard;
      readonly uid: string;
      readonly revealed: boolean;
    }
  | { readonly phase: "empty" }
  | { readonly phase: "error"; readonly detail: string };

type Fetched = { readonly card: AnnotationReviewCard | null } | { readonly detail: string };

interface Prefetch {
  readonly promise: Promise<Fetched>;
  value?: Fetched;
}

/** The card on screen; `at` and `shownAt` are set once it is painted. */
interface ShownCard {
  readonly card: AnnotationReviewCard;
  readonly uid: string;
  at?: number;
  shownAt?: number;
  revealMs: number | null;
}

const OFF: ReviewView = { phase: "off" };
const ABBREVIATION_SELECTOR = "[data-markdown-abbreviation]";

interface PopoverControl {
  readonly isOpen: boolean;
  open(triggerId: string): void;
  close(): void;
}

/**
 * Review cards in a message's gloss popover: the wedge or Right starts a review and moves to the next card, Up or a
 * click reveals the meaning, Escape ends it. Each card left after it was painted is reported once with how long it took
 * to reveal (`null` if never) and how long it was on screen. The next card is fetched while one is shown.
 */
export function useGlossReview({
  environmentId,
  container,
  popover,
  report,
}: {
  environmentId: EnvironmentId | null;
  container: RefObject<HTMLElement | null>;
  popover: PopoverControl;
  report: (item: AnnotationInteraction) => void;
}) {
  const fetchNext = useAtomCommand(nextAnnotationReview, {
    reportFailure: false,
    reportDefect: false,
  });
  const [view, setView] = useState<ReviewView>(OFF);
  const shown = useRef<ShownCard | null>(null);
  const session = useRef(0);
  const prefetched = useRef<Prefetch | null>(null);

  const request = (exclude: ReadonlyArray<string>): Prefetch => {
    if (environmentId === null) {
      const value = { detail: "no server connected" };
      return { promise: Promise.resolve(value), value };
    }
    const entry: Prefetch = {
      promise: fetchNext({
        environmentId,
        input: { source: "desktop", exclude: [...exclude] },
      }).then((result): Fetched => {
        if (result._tag === "Success") return result.value;
        const error = squashAtomCommandFailure(result);
        return {
          detail: error instanceof Error && error.message ? error.message : "request failed",
        };
      }),
    };
    void entry.promise.then((value) => {
      entry.value = value;
    });
    return entry;
  };

  const finish = () => {
    const current = shown.current;
    shown.current = null;
    if (!current || current.at === undefined || current.shownAt === undefined) return;
    report({
      kind: "review",
      at: current.at,
      card: current.card.id,
      word: current.card.ja,
      revealMs: current.revealMs,
      shownMs: Math.max(0, Math.round(performance.now() - current.shownAt)),
      source: "desktop",
      uid: current.uid,
    });
  };

  const show = (fetched: Fetched, generation: number) => {
    if (generation !== session.current) return;
    if ("detail" in fetched) {
      setView({ phase: "error", detail: fetched.detail });
      return;
    }
    if (fetched.card === null) {
      setView({ phase: "empty" });
      return;
    }
    const uid = randomUUID();
    shown.current = { card: fetched.card, uid, revealMs: null };
    setView({ phase: "card", card: fetched.card, uid, revealed: false });
    prefetched.current = request([fetched.card.id]);
  };

  const next = () => {
    finish();
    const generation = ++session.current;
    const entry = prefetched.current ?? request([]);
    prefetched.current = null;
    if (entry.value) {
      show(entry.value, generation);
      return;
    }
    setView({ phase: "loading" });
    void entry.promise.then((value) => show(value, generation));
  };

  const reveal = () => {
    const current = shown.current;
    if (!current || current.revealMs !== null) return;
    current.revealMs =
      current.shownAt === undefined ? 0 : Math.round(performance.now() - current.shownAt);
    setView((previous) => (previous.phase === "card" ? { ...previous, revealed: true } : previous));
  };

  const end = () => {
    finish();
    session.current += 1;
    prefetched.current = null;
    setView(OFF);
  };

  const painted = (uid: string) => {
    const current = shown.current;
    if (current?.uid !== uid || current.shownAt !== undefined) return;
    current.shownAt = performance.now();
    current.at = Date.now();
  };

  const active = view.phase !== "off";
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (isEditableFocused(event.target)) return;
    if (active) {
      if (event.key === "ArrowRight") next();
      else if (event.key === "ArrowUp") reveal();
      else if (event.key === "Escape") {
        end();
        popover.close();
      } else if (event.key !== "ArrowDown" && event.key !== "ArrowLeft") return;
      event.preventDefault();
      return;
    }
    if (event.key !== "ArrowRight" || environmentId === null) return;
    const root = container.current;
    const hovered = document.querySelector<HTMLElement>(`${ABBREVIATION_SELECTOR}:hover`);
    // A gloss hovered in another message is that message's to review.
    if (!root || (hovered && !root.contains(hovered))) return;
    if (!popover.isOpen) {
      if (!hovered?.id) return;
      popover.open(hovered.id);
    }
    event.preventDefault();
    next();
  });
  const onBlur = useEffectEvent(() => end());
  const onUnmount = useEffectEvent(() => end());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for review keys on the document while this message has glosses to review from
  useEffect(() => {
    if (environmentId === null) return;
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    document.addEventListener("keydown", listener, true);
    return () => document.removeEventListener("keydown", listener, true);
  }, [environmentId]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ends the review when the window loses focus, and reports the card on screen when the message unmounts or its glosses go (English only)
  useEffect(() => {
    if (!active || environmentId === null) return;
    const listener = () => onBlur();
    window.addEventListener("blur", listener);
    return () => {
      window.removeEventListener("blur", listener);
      onUnmount();
    };
  }, [active, environmentId]);

  return { view, available: environmentId !== null, next, reveal, end, painted };
}

type GlossReview = ReturnType<typeof useGlossReview>;

/** A gloss popover's contents: the gloss, or the review card, with the wedge that starts or advances the review. */
export function GlossPopoverBody({ gloss, review }: { gloss: string; review: GlossReview }) {
  if (!review.available) return gloss;
  const { view } = review;
  return (
    <div className="flex items-center gap-1">
      <div className="min-w-0">
        {view.phase === "off" ? (
          gloss
        ) : view.phase === "card" ? (
          <ReviewCard
            key={view.uid}
            card={view.card}
            uid={view.uid}
            revealed={view.revealed}
            onReveal={review.reveal}
            onPainted={review.painted}
          />
        ) : (
          <div className="flex min-w-32 items-center justify-center py-3 text-muted-foreground">
            {view.phase === "loading"
              ? "Loading…"
              : view.phase === "empty"
                ? "Nothing to review right now"
                : view.detail}
          </div>
        )}
      </div>
      <button
        type="button"
        aria-label={view.phase === "off" ? "Review a word" : "Next review card"}
        className="-me-1.5 flex shrink-0 self-stretch items-center rounded-sm px-0.5 text-muted-foreground/40 outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={review.next}
      >
        <ChevronRightIcon aria-hidden className="size-3.5" strokeWidth={1.5} />
      </button>
    </div>
  );
}

function ReviewCard({
  card,
  uid,
  revealed,
  onReveal,
  onPainted,
}: {
  card: AnnotationReviewCard;
  uid: string;
  revealed: boolean;
  onReveal: () => void;
  onPainted: (uid: string) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const reportPainted = useEffectEvent(() => onPainted(uid));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- times the card from its first paint, a frame after the commit
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      reportPainted();
      ref.current?.setAttribute("data-shown", "");
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <button
      ref={ref}
      type="button"
      className="flex min-w-32 flex-col items-center gap-0.5 rounded-sm px-1 py-1.5 text-center outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
      onClick={onReveal}
    >
      <span lang="ja" className="font-medium text-2xl text-foreground leading-tight">
        {card.ja}
      </span>
      {revealed ? (
        <>
          {card.kana ? (
            <span lang="ja" className="text-muted-foreground text-sm">
              {card.kana}
            </span>
          ) : null}
          <span className="text-foreground">{card.gloss}</span>
        </>
      ) : null}
      <span className="mt-1 text-3xs text-muted-foreground/70">
        {revealed ? "→ next" : "↑ reveal · → next"}
      </span>
    </button>
  );
}
