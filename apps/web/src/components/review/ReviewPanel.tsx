import { useAtomValue } from "@effect/atom-react";
import {
  ANNOTATION_REVIEW_NEW_PER_DAY_MAX,
  type AnnotationReviewCard,
  type EnvironmentId,
} from "@t3tools/contracts";
import { LayersIcon, Settings2Icon } from "lucide-react";
import {
  Fragment,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { getDocumentActivity, subscribeDocumentActivity } from "~/lib/documentActivity";
import { cn, randomUUID } from "~/lib/utils";
import {
  fetchReviewCard,
  holdReviewCounts,
  releaseReviewCards,
  reportReview,
  reviewNewPerDayAtom,
  setReviewCounts,
} from "~/state/annotationReview";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { RefreshIcon } from "../ui/refresh-icon";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Label } from "../ui/label";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Separator } from "../ui/separator";
import { Spinner } from "../ui/spinner";
import {
  intervalLabel,
  REVIEW_LOADING,
  type ReviewCounts,
  type ReviewGrade,
  ReviewSession,
  type ReviewState,
} from "./reviewSession";

const GRADES = [
  { grade: 1, label: "Again", interval: "again" },
  { grade: 2, label: "Hard", interval: "hard" },
  { grade: 3, label: "Good", interval: "good" },
  { grade: 4, label: "Easy", interval: "easy" },
] as const;

const QUEUES = [
  { queue: "new", label: "new", className: "text-info-foreground" },
  { queue: "learning", label: "learning", className: "text-destructive-foreground" },
  { queue: "review", label: "to review", className: "text-success-foreground" },
] as const;

const pageVisible = () => getDocumentActivity().visible;

/**
 * Anki-style review of the collector's cards in the right panel: the word, then on Space or Enter its reading and
 * meaning with Again, Hard, Good and Easy (1 to 4; Space or Enter is Good). Keys count only while focus is in the
 * panel. A card left without a grade, when the panel closes or the window is hidden, is reported as left. Its menu sets
 * the new cards a day, kept on the collector, once the collector has said what it is.
 */
export function ReviewPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly visible: boolean;
}) {
  // The collector is reached through this client's own server, which may not host the thread.
  const environmentId = useAtomValue(primaryEnvironmentIdAtom) ?? props.environmentId;
  const windowVisible = useSyncExternalStore(subscribeDocumentActivity, pageVisible);
  const active = props.visible && windowVisible;
  const [state, setState] = useState<ReviewState>(REVIEW_LOADING);
  const newPerDay = useAtomValue(reviewNewPerDayAtom(environmentId));
  const session = useRef<ReviewSession | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const changed = useEffectEvent((next: ReviewState) => {
    setState(next);
    setReviewCounts(environmentId, next.counts);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs a review session against the collector while the panel and window are visible; ending it reports the card on screen as left
  useEffect(() => {
    if (!active) return;
    const release = holdReviewCounts();
    const current = new ReviewSession({
      fetchNext: (input) => fetchReviewCard(environmentId, input),
      report: (item) => reportReview(environmentId, item),
      release: (ids) => releaseReviewCards(environmentId, ids),
      onChange: (next) => changed(next),
      uid: randomUUID,
      now: () => Date.now(),
      clock: () => performance.now(),
    });
    session.current = current;
    current.start();
    return () => {
      current.leave();
      if (session.current === current) session.current = null;
      release();
    };
  }, [active, environmentId]);

  const act = (action: (current: ReviewSession) => void) => {
    const current = session.current;
    if (current) action(current);
    root.current?.focus({ preventScroll: true });
  };
  const { view, counts } = state;
  const setNewPerDay = async (value: number) => {
    const current = session.current;
    const answer = current
      ? await current.setNewPerDay(value)
      : await fetchReviewCard(environmentId, {
          exclude: [],
          more: false,
          peek: true,
          newPerDay: value,
        });
    if ("detail" in answer) return answer.detail;
    if (!current) setReviewCounts(environmentId, answer.counts ?? null);
    return null;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys typed in the menu, a portal, reach the panel through React but are not its.
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    if (view.phase !== "card" || event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const confirm = event.key === " " || event.key === "Enter";
    // A focused button answers Enter and Space itself.
    if (confirm && event.target !== event.currentTarget && event.target instanceof Element) {
      if (event.target.closest("button")) return;
    }
    const grade = confirm ? 3 : "1234".indexOf(event.key) + 1;
    if (!confirm && (grade === 0 || !view.revealed)) return;
    event.preventDefault();
    if (event.repeat) return;
    if (!view.revealed) act((current) => current.reveal());
    else act((current) => current.grade(grade as ReviewGrade));
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element) || !event.currentTarget.contains(event.target)) return;
    if (event.target.closest("button")) return;
    root.current?.focus({ preventScroll: true });
  };

  return (
    <div
      ref={root}
      role="application"
      aria-label="Review"
      tabIndex={-1}
      data-workspace-focus-default
      data-review-panel
      className="flex min-h-0 flex-1 flex-col outline-none"
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
    >
      {counts || newPerDay !== null ? (
        <div className="grid min-h-9 shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-border/70 px-2 py-1.5">
          {counts ? (
            <ReviewCountsBar
              className="col-start-2"
              counts={counts}
              current={view.phase === "card" ? view.card.queue : undefined}
            />
          ) : null}
          {newPerDay !== null ? (
            <div className="col-start-3 flex justify-end">
              <ReviewSettings newPerDay={newPerDay} onSetNewPerDay={setNewPerDay} />
            </div>
          ) : null}
        </div>
      ) : null}
      {view.phase === "card" ? (
        <>
          <div className="scrollbar-gutter-both flex min-h-0 flex-1 flex-col items-center justify-center-safe gap-3 overflow-y-auto p-6 text-center">
            <ReviewWord
              key={view.uid}
              word={view.card.ja}
              onPainted={() => session.current?.painted(view.uid)}
            />
            {view.revealed ? (
              <>
                <Separator className="max-w-60" />
                {view.card.kana ? (
                  <span lang="ja" className="text-lg text-muted-foreground">
                    {view.card.kana}
                  </span>
                ) : null}
                <span className="max-w-sm text-base text-foreground">{view.card.gloss}</span>
              </>
            ) : null}
          </div>
          <div className="shrink-0 border-t border-border/70 p-3">
            {view.revealed ? (
              <ReviewGrades
                intervals={view.card.intervals}
                onGrade={(grade) => act((current) => current.grade(grade))}
              />
            ) : (
              <div className="flex justify-center">
                <Button
                  variant="outline"
                  className="min-w-40"
                  aria-keyshortcuts="Space Enter"
                  onClick={() => act((current) => current.reveal())}
                >
                  Show answer
                </Button>
              </div>
            )}
          </div>
        </>
      ) : view.phase === "loading" ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner size="md" tone="muted" />
        </div>
      ) : (
        <Empty>
          <EmptyMedia variant="icon">
            <LayersIcon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>
              {view.phase === "done"
                ? "Done for today"
                : view.phase === "waiting"
                  ? "Next card soon"
                  : "Could not load a card"}
            </EmptyTitle>
            <EmptyDescription>
              {view.phase === "done"
                ? "No more cards are due today."
                : view.phase === "waiting"
                  ? "A card you are learning is due again in a few minutes."
                  : view.detail}
            </EmptyDescription>
          </EmptyHeader>
          {view.phase === "done" ? (
            <Button variant="outline" onClick={() => act((current) => current.reviewMore())}>
              Review more
            </Button>
          ) : view.phase === "error" ? (
            <Button size="sm" variant="outline" onClick={() => act((current) => current.start())}>
              <RefreshIcon size="sm" />
              Retry
            </Button>
          ) : null}
        </Empty>
      )}
    </div>
  );
}

/** Anki's three numbers, the current card's queue underlined. */
function ReviewCountsBar(props: {
  readonly className?: string;
  readonly counts: ReviewCounts;
  readonly current: AnnotationReviewCard["queue"];
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-center gap-1.5 text-sm font-medium tabular-nums",
        props.className,
      )}
    >
      {QUEUES.map(({ queue, label, className }, index) => (
        <Fragment key={queue}>
          {index > 0 ? (
            <span aria-hidden className="text-muted-foreground">
              +
            </span>
          ) : null}
          <span
            data-queue={queue}
            aria-current={props.current === queue ? "true" : undefined}
            className={cn(
              className,
              props.current === queue && "underline decoration-2 underline-offset-4",
            )}
          >
            {props.counts[queue]}
            <span className="sr-only"> {label}</span>
          </span>
        </Fragment>
      ))}
    </div>
  );
}

/**
 * The panel's menu: the new cards a day, shared by every client of the collector. Shows the value from the collector's
 * latest answer; one it refuses goes back to that value, with why.
 */
function ReviewSettings(props: {
  readonly newPerDay: number;
  readonly onSetNewPerDay: (value: number) => Promise<string | null>;
}) {
  const id = useId();
  const [field, setField] = useState({
    saved: props.newPerDay,
    draft: props.newPerDay as number | null,
    error: null as string | null,
  });
  if (field.saved !== props.newPerDay) {
    setField({ saved: props.newPerDay, draft: props.newPerDay, error: null });
  }
  const commit = (next: number | null) => {
    const value = next === null ? field.saved : Math.round(next);
    setField((current) => ({ ...current, draft: value, error: null }));
    if (value === field.saved) return;
    void props.onSetNewPerDay(value).then((error) => {
      if (error === null) return;
      setField((current) => ({ ...current, draft: current.saved, error }));
    });
  };
  return (
    <Popover>
      <PopoverTrigger
        render={<Button variant="ghost" size="icon-xs" aria-label="Review settings" />}
      >
        <Settings2Icon />
      </PopoverTrigger>
      <PopoverPopup align="end" padding="compact">
        <div className="flex items-center gap-3">
          <Label htmlFor={id}>New cards a day</Label>
          <NumberField
            id={id}
            className="w-28"
            size="sm"
            min={0}
            max={ANNOTATION_REVIEW_NEW_PER_DAY_MAX}
            step={1}
            value={field.draft}
            onValueChange={(draft) => setField((current) => ({ ...current, draft }))}
            onValueCommitted={commit}
          >
            <NumberFieldGroup>
              <NumberFieldDecrement aria-label="Fewer new cards a day" />
              {/* The field commits on blur, so Enter blurs it. */}
              <NumberFieldInput
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
              <NumberFieldIncrement aria-label="More new cards a day" />
            </NumberFieldGroup>
          </NumberField>
        </div>
        {field.error ? (
          <p role="alert" className="mt-2 text-xs text-destructive-foreground">
            {field.error}
          </p>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

/** The word on its own; its timing starts at its first paint, a frame after the commit. */
function ReviewWord(props: { readonly word: string; readonly onPainted: () => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const painted = useEffectEvent(() => {
    props.onPainted();
    ref.current?.setAttribute("data-shown", "");
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- times the card from its first paint, a frame after the commit
  useEffect(() => {
    const frame = requestAnimationFrame(() => painted());
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <span
      ref={ref}
      lang="ja"
      data-review-word
      className="text-5xl font-medium leading-tight text-foreground"
    >
      {props.word}
    </span>
  );
}

function ReviewGrades(props: {
  readonly intervals: AnnotationReviewCard["intervals"];
  readonly onGrade: (grade: ReviewGrade) => void;
}) {
  return (
    <div className="mx-auto grid max-w-md grid-cols-4 gap-2">
      {GRADES.map(({ grade, label, interval }) => (
        <div key={grade} className="flex min-w-0 flex-col items-center gap-1">
          {props.intervals ? (
            <span className="text-2xs text-muted-foreground tabular-nums">
              {intervalLabel(props.intervals[interval])}
            </span>
          ) : null}
          <Button
            variant="outline"
            className="w-full"
            aria-keyshortcuts={grade === 3 ? "3 Space Enter" : String(grade)}
            onClick={() => props.onGrade(grade)}
          >
            {label}
          </Button>
        </div>
      ))}
    </div>
  );
}
