import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { type Atom, AsyncResult } from "effect/reactivity";
import { type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import "../index.css";

import { filesystemEnvironment } from "../state/filesystem";
import { useRightPanelStore } from "../rightPanelStore";
import { remarkEnableOrderedListNumbers } from "@t3tools/shared/markdownPipeline";
import { setMarkdownTaskChecked } from "@t3tools/shared/markdownTaskList";
import { HostImageUrlContext } from "./chat/hostImageUrl";

const { workspaceSearch, filesystemMetadata } = vi.hoisted(() => ({
  workspaceSearch: vi.fn(),
  filesystemMetadata: vi.fn(),
}));
const parsedSources = vi.hoisted(() => [] as string[]);
vi.mock(import("mdast-util-from-markdown"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    fromMarkdown: ((source: string, ...rest: never[]) => {
      parsedSources.push(String(source));
      return (actual.fromMarkdown as (...args: unknown[]) => unknown)(source, ...rest);
    }) as typeof actual.fromMarkdown,
  };
});

vi.mock(import("../state/use-atom-query-runner"), async (original) => ({
  ...(await original()),
  useAtomQueryRunner: ((family: unknown) =>
    family === filesystemEnvironment.getMetadata ? filesystemMetadata : workspaceSearch) as never,
}));

// Atoms derived from the server config run in the real registry over a missing config.
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  const modelsConfig = Atom.make({
    environment: { platform: { os: "darwin" } },
    availableEditors: [],
    settings: { providerInstances: {} },
    providers: [
      {
        instanceId: "codex",
        driver: "codex",
        displayName: "Codex",
        models: [{ slug: "gpt-6.1", name: "GPT-6.1", isCustom: false, capabilities: {} }],
      },
    ],
  });
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      configValueAtom: ((environmentId: string) =>
        environmentId === "models" ? modelsConfig : noConfig) as never,
    },
  };
});
vi.mock(import("../state/session"), async (original) => {
  const { AuthStandardClientScopes } = await import("@t3tools/contracts");
  const granted = new Set<string>(AuthStandardClientScopes);
  const hasScope = (environmentId: unknown, scope: string) =>
    environmentId !== null && granted.has(scope);
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
  };
});
const { annotationReport } = vi.hoisted(() => ({
  annotationReport: vi.fn(async (_report: unknown) => ({ _tag: "Success" })),
}));
vi.mock(import("../state/use-atom-command"), async (original) => {
  const actual = await original();
  const { reportAnnotationInteractions } = await import("../state/annotationInteractions");
  return {
    ...actual,
    useAtomCommand: ((command: unknown, options: unknown) =>
      command === reportAnnotationInteractions
        ? annotationReport
        : actual.useAtomCommand(command as never, options as never)) as never,
  };
});
// English only and the level go through the collector, which answers with what was asked for (with no end, so no
// timer).
const { englishSet, collector } = vi.hoisted(() => ({
  englishSet: vi.fn((request: { input: { on: boolean } }) => ({
    on: request.input.on,
    until: 0,
    at: 0,
  })),
  collector: { level: 0 },
}));
vi.mock(import("../state/annotationInteractions"), async (original) => ({
  ...(await original()),
  setAnnotationEnglish: {
    label: "test:english",
    run: async (_registry: unknown, request: { input: { on: boolean } }) =>
      AsyncResult.success(englishSet(request)),
  } as never,
  adjustAnnotationIntensity: {
    label: "test:step",
    run: async (_registry: unknown, request: { input: { step: 1 | -1 } }) => {
      collector.level += request.input.step;
      return AsyncResult.success({ level: collector.level, until: 0 });
    },
  } as never,
}));
vi.mock(import("../state/annotationStatus"), async (original) => ({
  ...(await original()),
  watchAnnotationStatus: () => {},
}));
// The client's own server, which forwards annotation reports, rather than the one hosting the chat.
vi.mock(import("../state/primaryEnvironment"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await original()),
    primaryEnvironmentIdAtom: Atom.make<string | null>(null) as never,
  };
});
vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
const { renderDiagram } = vi.hoisted(() => ({
  renderDiagram: vi.fn<(source: string) => Promise<string> | undefined>(),
}));
// Control rendering latency without running Mermaid layout.
vi.mock(import("./chat/MermaidDiagram"), async (original) => {
  const { use } = await import("react");
  return {
    ...(await original()),
    MermaidDiagram: ({ source }: { source: string }) => {
      const pending = renderDiagram(source);
      return <svg role="img" aria-label={pending ? use(pending) : "Diagram"} />;
    },
  };
});

const appearance = vi.hoisted(() => ({
  value: "light" as "light" | "dark",
  listeners: new Set<() => void>(),
}));
vi.mock(import("../hooks/useTheme"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    appearance.listeners.add(listener);
    return () => appearance.listeners.delete(listener);
  };
  return {
    ...(await original()),
    useRenderedAppearance: () => useSyncExternalStore(subscribe, () => appearance.value),
  };
});

const settingsOverrides = vi.hoisted(() => ({ mathRenderingEnabled: false }));
vi.mock(import("../hooks/useSettings"), async (original) => {
  const actual = await original();
  type Settings = ReturnType<typeof actual.getClientSettings>;
  function useClientSettings<T = Settings>(select?: (settings: Settings) => T): T {
    const settings = { ...actual.getClientSettings(), ...settingsOverrides };
    return select ? select(settings) : (settings as T);
  }
  return { ...actual, useClientSettings };
});

import ChatMarkdown from "./ChatMarkdown";
import { chatMarkdownClipboardPayload } from "../markdown-clipboard";
import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { annotationStatusAtom, stepAnnotationLevel } from "../state/annotationStatus";
import { flush as flushReading, visibleReadingContexts } from "../lib/annotationReading";
import { installChatRouteCommands } from "../shortcuts/chatRouteCommands";
import { ThreadJapanesePanel } from "./chat/ThreadJapanesePanel";

// Writable under the mock above.
const setPrimaryEnvironment = (environmentId: EnvironmentId | null) =>
  appAtomRegistry.set(
    primaryEnvironmentIdAtom as unknown as Atom.Writable<EnvironmentId | null>,
    environmentId,
  );
import { AudioPreview } from "./files/AudioPreview";

it("keeps compact audio playback loaded across signed URL renewals", async () => {
  const original =
    "data:audio/wav;base64,UklGRiUAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQEAAACA";
  const renewed = `${original}#renewed`;
  const preview = (src: string, revision = "clip-v1") => (
    <AudioPreview compact name="clip.wav" src={src} revision={revision} />
  );
  await using screen = await render(preview(original));
  const audio = screen.container.querySelector("audio")!;
  await act(() => {
    audio.dispatchEvent(new Event("loadedmetadata"));
    audio.dispatchEvent(new Event("play"));
  });
  await screen.rerender(preview(renewed));
  expect(screen.container.querySelector("audio")).toBe(audio);
  expect(audio.getAttribute("src")).toBe(original);
  await expect.element(screen.getByRole("button", { name: "Pause clip.wav" })).toBeEnabled();
  await screen.rerender(preview(renewed, "clip-v2"));
  expect(screen.container.querySelector("audio")).not.toBe(audio);
  expect(screen.container.querySelector("audio")?.getAttribute("src")).toBe(renewed);
});

function setup() {
  appearance.value = "light";
  parsedSources.length = 0;
  settingsOverrides.mathRenderingEnabled = false;
  // Reports earlier tests left queued go out now, not into this test's.
  flushReading();
  annotationReport.mockClear();
  englishSet.mockClear();
  collector.level = 0;
  // Levels stored for the next start.
  localStorage.clear();
  setPrimaryEnvironment(null);
  for (const environmentId of [ENGLISH_ENVIRONMENT, ENGLISH_PRIMARY]) {
    appAtomRegistry.set(annotationStatusAtom(environmentId), null);
  }
  renderDiagram.mockReset();
  workspaceSearch.mockReset().mockResolvedValue(AsyncResult.success({ entries: [] }));
  filesystemMetadata.mockReset().mockResolvedValue(AsyncResult.success({ entries: [null] }));
}

function renderText(text: string, props: Partial<Parameters<typeof ChatMarkdown>[0]> = {}) {
  return render(<ChatMarkdown cwd="/tmp/project" text={text} {...props} />);
}

function buttonsLabelled(container: HTMLElement, label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => button.getAttribute("aria-label") === label,
  );
}

const SOURCE_NUMBER_PLUGINS = [remarkEnableOrderedListNumbers];

it("keeps decimal markers in nested user lists while documents keep their counter styles", async () => {
  setup();
  const text = "1. Outer\n   1. Nested\n   7. Skipped\n      1. Deeper\n      4. Fourth";
  await using screen = await render(
    <div className="grid grid-cols-2 gap-8 p-8">
      <section>
        <h2>User message</h2>
        <ChatMarkdown
          cwd={undefined}
          text={text}
          className="user-message-markdown"
          extraRemarkPlugins={SOURCE_NUMBER_PLUGINS}
        />
      </section>
      <section>
        <h2>Markdown preview</h2>
        <ChatMarkdown cwd={undefined} text={text} />
      </section>
    </div>,
  );
  await expect.element(screen.getByText("User message", { exact: true })).toBeVisible();
  const [message, preview] = screen.container.querySelectorAll(".chat-markdown");
  expect(
    [...message!.querySelectorAll("ol")].map((list) => getComputedStyle(list).listStyleType),
  ).toEqual(["decimal", "decimal", "decimal"]);
  expect(
    [...preview!.querySelectorAll("ol")].map((list) => getComputedStyle(list).listStyleType),
  ).toEqual(["decimal", "lower-alpha", "lower-roman"]);
});

it("shows unavailable audio when a workspace embed has no thread", async () => {
  setup();
  await using screen = await renderText("![recording](clip.wav)");
  expect(screen.container.textContent).toContain("Audio unavailable");
  expect(screen.container.textContent).not.toContain("Loading audio");
  expect(screen.container.querySelector("audio")).toBeNull();
});

it("loads a host image through the page's own route when there is no environment", async () => {
  setup();
  const pixel =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const hostImageUrl = vi.fn((_path: string) => pixel);
  await using screen = await render(
    <HostImageUrlContext value={hostImageUrl}>
      <ChatMarkdown cwd={undefined} text="![Shot](</work/my shot.png>)" />
    </HostImageUrlContext>,
  );
  await expect.element(screen.getByAltText("Shot")).toHaveAttribute("src", pixel);
  expect(new Set(hostImageUrl.mock.calls.map(([path]) => path))).toEqual(
    new Set(["/work/my shot.png"]),
  );
});

it("loads the <picture> source for the current theme through the image route", async () => {
  setup();
  const pixel =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const hostImageUrl = (path: string) => `${pixel}#${path}`;
  await using screen = await render(
    <HostImageUrlContext value={hostImageUrl}>
      <ChatMarkdown
        cwd={undefined}
        text={
          '<picture><source media="(prefers-color-scheme: dark)" srcset="/work/dark.png"><img src="/work/light.png" alt="Shot"></picture>'
        }
      />
    </HostImageUrlContext>,
  );
  await expect
    .element(screen.getByAltText("Shot"))
    .toHaveAttribute("src", `${pixel}#/work/light.png`);

  await act(() => {
    appearance.value = "dark";
    for (const listener of appearance.listeners) listener();
  });
  await expect
    .element(screen.getByAltText("Shot"))
    .toHaveAttribute("src", `${pixel}#/work/dark.png`);
});

it("reuses the parse of a streaming reply's finished blocks when it remounts", async () => {
  setup();
  const message = (
    <ChatMarkdown cwd="/tmp/project" text={"Finished block\n\nStill growing"} isStreaming />
  );
  {
    await using _first = await render(message);
  }
  await using screen = await render(message);
  await expect.element(screen.getByText("Still growing")).toBeVisible();
  expect(parsedSources.filter((source) => source.includes("Finished block"))).toHaveLength(1);
});

it("reuses the parse of a remounted message that has stable extra plugins", async () => {
  setup();
  const parsed = vi.fn();
  const countingPlugins = [() => () => void parsed()];
  const message = (
    <ChatMarkdown cwd="/tmp/project" text="Cached text" extraRemarkPlugins={countingPlugins} />
  );
  {
    await using _first = await render(message);
  }
  await using screen = await render(message);
  await expect.element(screen.getByText("Cached text")).toBeVisible();
  expect(parsed).toHaveBeenCalledTimes(1);
});

it("highlights a code block's own source when an earlier block of the same length was cached", async () => {
  setup();
  const highlightedText = (container: HTMLElement) =>
    container.querySelector(".chat-markdown-shiki")?.textContent?.trim();
  // These two lines share a 32-bit FNV-1a hash and a length.
  const first = 'const commitSha = "f36a6d8fe0aa";';
  const second = 'const commitSha = "cb06f8d135b3";';
  {
    await using screen = await renderText(`\`\`\`ts\n${first}\n\`\`\``);
    await vi.waitFor(() => expect(highlightedText(screen.container)).toBe(first));
  }
  await using screen = await renderText(`\`\`\`ts\n${second}\n\`\`\``);
  await vi.waitFor(() => expect(highlightedText(screen.container)).toBe(second));
});

describe("ChatMarkdown favicon privacy", () => {
  it("suppresses private link images while preserving public links across updates", async () => {
    setup();
    const markdown = (url: string) => <ChatMarkdown cwd="/tmp/project" text={`[Link](${url})`} />;
    await using screen = await render(markdown("https://example.com"));
    const { container, rerender } = screen;
    expect([...container.querySelectorAll("img")].map((image) => image.src)).toEqual([
      "https://www.google.com/s2/favicons?domain=example.com&sz=32",
    ]);
    for (const url of ["http://192.168.1.10:8080", "http://localhost:3000", "http://home.arpa"]) {
      await rerender(markdown(url));
      expect(container.querySelectorAll("img")).toHaveLength(0);
    }
    await rerender(markdown("https://example.com"));
    expect(container.querySelectorAll("img")).toHaveLength(1);
    await rerender(markdown("https://github.com/pingdotgg/t3code/pull/1"));
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.querySelector("a svg")).not.toBeNull();
  });
});

describe("ChatMarkdown external link labels", () => {
  it("keeps a leading emoji whole", async () => {
    setup();
    await using screen = await render(
      <ChatMarkdown cwd="/tmp/project" text="[😀 Read the documentation](https://example.com)" />,
    );
    await vi.waitFor(() => {
      const link = screen.container.querySelector("a");
      expect(link?.textContent).toContain("😀 Read");
      const walker = document.createTreeWalker(link!, NodeFilter.SHOW_TEXT);
      const textNodes: string[] = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode.nodeValue ?? "");
      expect(textNodes.filter((node) => /\p{Surrogate}/u.test(node))).toEqual([]);
    });
  });
});

describe("ChatMarkdown streaming", () => {
  it("runs only a complete single-line shell block after a click", async () => {
    setup();
    const onRunShellCommand = vi.fn();
    const message = (text: string, isStreaming = false) => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        isStreaming={isStreaming}
        onRunShellCommand={onRunShellCommand}
      />
    );
    await using screen = await render(message("```bash\necho hello\n```", true));
    const { container, rerender } = screen;
    const runButtons = () => buttonsLabelled(container, "Run in terminal");
    expect(runButtons()).toHaveLength(0);

    await rerender(message("```bash\necho hello\n```"));
    await act(async () => runButtons()[0]!.click());
    expect(onRunShellCommand).toHaveBeenCalledExactlyOnceWith("echo hello");

    for (const text of [
      "~~~bash\necho tilde\n~~~",
      "> ```bash\n> echo quote\n> ```",
      "````bash\necho four\n````",
      "- Command\n\n  ```bash\n  echo list\n  ```",
      "```bash\r\necho crlf\r\n```\r",
    ]) {
      await rerender(message(text));
      expect(runButtons()).toHaveLength(1);
    }

    for (const text of [
      "```bash\necho one\necho two\n```",
      "```typescript\necho hello\n```",
      "```bash\n\n```",
      "```bash\necho hello\n\n```",
      "```bash\necho hello\\\n```",
      "```bash\necho safe \u202e#\n```",
      "```bash\necho incomplete",
      "~~~bash\necho incomplete",
      "````bash\necho incomplete\n```",
      '<pre><code class="language-bash">echo html</code></pre>',
    ]) {
      await rerender(message(text));
      expect(runButtons()).toHaveLength(0);
    }
  });

  it("edits the current task text and marker after reusing a renderer", async () => {
    setup();
    let editedText: string | undefined;
    let rerender: (next: ReactElement) => Promise<void> = async () => {};
    const message = (text: string): ReactElement => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        onTaskListChange={({ markerOffset, checked }) => {
          editedText = setMarkdownTaskChecked(text, markerOffset, checked);
          void rerender(message(editedText));
        }}
      />
    );
    await using rendered = await render(message("- [ ] First\n- [ ] Second"));
    rerender = rendered.rerender;
    const { container } = rendered;
    const checkboxes = () => container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    const original = checkboxes()[1]!;
    await rerender(message("- [ ] A longer first task\n- [ ] Second"));
    expect(checkboxes()[1]).toBe(original);

    await act(async () => original.click());
    expect(editedText).toBe("- [ ] A longer first task\n- [x] Second");
    await vi.waitFor(() => expect(checkboxes()[1]!.checked).toBe(true));
    await rerender(message("- [ ] A longer first task\n- [ ] Second"));
    expect(checkboxes()[1]).toBe(original);
    expect(checkboxes()[1]!.checked).toBe(false);
  });

  it.each([
    ["read-only", undefined],
    ["editable", () => {}],
  ])(
    "unchecks the remaining %s task when the checked row above it is removed",
    async (_, onTaskListChange) => {
      setup();
      const message = (text: string) => (
        <ChatMarkdown cwd="/tmp/project" text={text} onTaskListChange={onTaskListChange} />
      );
      await using screen = await render(message("- [x] Completed item\n- [ ] Pending item"));
      await screen.rerender(message("- [ ] Pending item"));
      const checkboxes =
        screen.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      expect(checkboxes).toHaveLength(1);
      expect(checkboxes[0]!.checked).toBe(false);
    },
  );
});

describe("ChatMarkdown workspace file opens", () => {
  const threadRef = {
    environmentId: EnvironmentId.make("workspace"),
    threadId: ThreadId.make("thread"),
  };

  it("keeps a newer absolute file open when an earlier repo-relative lookup finishes", async () => {
    setup();
    const result = AsyncResult.success({
      entries: [{ path: "notes/a.md", kind: "file" }],
      truncated: false,
    });
    let resolvePending!: (value: typeof result) => void;
    const pending = new Promise<typeof result>((resolve) => {
      resolvePending = resolve;
    });
    workspaceSearch.mockReturnValueOnce(pending);
    using openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});
    await using screen = await renderText(
      "[Notes](physics/notes/a.md) and [Other](/elsewhere/b.md:9)",
      {
        cwd: "/school/physics",
        threadRef,
      },
    );
    const { container } = screen;
    const [notes, other] = container.querySelectorAll("a");
    await act(async () => notes!.click());
    expect(workspaceSearch).toHaveBeenCalledOnce();
    expect(openFile).not.toHaveBeenCalled();

    await act(async () => other!.click());
    await act(async () => resolvePending(result));

    expect(openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "/elsewhere/b.md", 9);
    expect(workspaceSearch).toHaveBeenCalledOnce();
  });
});

describe("ChatMarkdown skill chips", () => {
  it("shows the skill's details and opens its instructions", async () => {
    setup();
    const threadRef = {
      environmentId: EnvironmentId.make("workspace"),
      threadId: ThreadId.make("thread"),
    };
    await using screen = await renderText("Run $review now", {
      threadRef,
      skills: [
        {
          name: "review",
          displayName: "Review",
          description: "Reviews the current branch.",
          path: "/skills/review/SKILL.md",
          enabled: true,
        },
      ],
    });
    using openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});

    await userEvent.click(screen.getByRole("button", { name: "Skill Review. Show details" }));
    await expect.element(page.getByText("Reviews the current branch.")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "View instructions" }));

    expect(openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "/skills/review/SKILL.md");
  });

  it("names a mentioned model as its provider does, without a thread", async () => {
    setup();
    await using screen = await renderText("Ask (model:codex/gpt-6.1), not model:openai/gpt-4o.", {
      environmentId: EnvironmentId.make("models"),
    });

    await expect
      .element(screen.getByRole("button", { name: "Model GPT-6.1. Show details" }))
      .toBeVisible();
    expect(buttonsLabelled(screen.container, "Model gpt-4o. Show details")).toEqual([]);
    expect(screen.container.textContent).toBe("Ask (GPT-6.1), not model:openai/gpt-4o.");
  });
});

describe("ChatMarkdown headings", () => {
  it("keeps insight streaming, reference links, and heading anchors in one message", async () => {
    setup();
    const rule = "─".repeat(20);
    const text = `## Setup\n\nBefore [source][src].\n\n★ Insight ${rule}\nA **streaming** note.`;
    const message = (text: string, isStreaming: boolean) => (
      <ChatMarkdown
        cwd={undefined}
        text={text}
        renderInsights
        lineBreaks
        isStreaming={isStreaming}
      />
    );
    await using screen = await render(message(text, true));
    await expect.element(screen.getByRole("note")).toHaveTextContent("Insight A streaming note.");
    await screen.rerender(
      message(
        `${text}\n${rule}\n\n## Setup\n\nAfter [source][src].\n\n[src]:\n  https://example.com`,
        false,
      ),
    );
    await expect.element(screen.getByRole("note")).toHaveTextContent("Insight A streaming note.");
    expect([...screen.container.querySelectorAll("h2")].map((heading) => heading.id)).toEqual([
      "user-content-setup",
      "user-content-setup-1",
    ]);
    expect(
      [...screen.container.querySelectorAll("a")].filter(
        (link) => link.href === "https://example.com/",
      ),
    ).toHaveLength(2);
    await expect.element(screen.getByRole("note")).not.toHaveTextContent("After");
  });

  it("never gives two headings the same id, even when a suffix matches another heading", async () => {
    setup();
    await using screen = await renderText(
      '## Setup\n\n## Setup\n\n## Setup-1\n\n<h2 id="install-1">Pinned</h2>\n\n## Install\n\n## Install',
      { parseRawHtml: true },
    );
    const { container } = screen;
    expect([...container.querySelectorAll("h2")].map((heading) => heading.id)).toEqual([
      "user-content-setup",
      "user-content-setup-1",
      "user-content-setup-1-1",
      "user-content-install-1",
      "user-content-install",
      "user-content-install-2",
    ]);
  });
});

describe("ChatMarkdown inline code selection", () => {
  it("selects the whole inline code span on double-click, but only a word in fenced code", async () => {
    setup();
    await using screen = await renderText(
      "Run `migration-gate --dry-run` first.\n\n```txt\nfenced-block word\n```",
    );
    await userEvent.dblClick(screen.getByText("migration-gate --dry-run"));
    expect(window.getSelection()?.toString()).toBe("migration-gate --dry-run");

    window.getSelection()?.removeAllRanges();
    const fenced = screen.container.querySelector("pre code")!;
    await userEvent.dblClick(fenced, { position: { x: 4, y: 4 } });
    expect(window.getSelection()?.toString()).toBe("fenced");
  });

  it("selects the whole line on triple-click beside a favicon link or a file chip", async () => {
    setup();
    await using screen = await renderText(
      "Before [docs](https://example.com/docs) after words\n\nBefore [App.tsx](/tmp/project/src/App.tsx) after words",
    );
    const tripleClickWord = async (paragraph: HTMLElement, word: string) => {
      const text = [...paragraph.childNodes].find((node) => node.textContent?.includes(word))!;
      const range = document.createRange();
      range.setStart(text, text.textContent!.indexOf(word));
      range.setEnd(text, text.textContent!.indexOf(word) + word.length);
      const wordBox = range.getBoundingClientRect();
      const paragraphBox = paragraph.getBoundingClientRect();
      window.getSelection()?.removeAllRanges();
      await userEvent.tripleClick(paragraph, {
        position: {
          x: wordBox.left - paragraphBox.left + wordBox.width / 2,
          y: wordBox.top - paragraphBox.top + wordBox.height / 2,
        },
      });
      return window.getSelection()?.toString().trim();
    };

    const paragraphs = screen.container.querySelectorAll("p");
    expect(paragraphs).toHaveLength(2);
    const selections = [];
    const lines = [];
    for (const paragraph of paragraphs) {
      lines.push(paragraph.textContent?.trim(), paragraph.textContent?.trim());
      selections.push(
        await tripleClickWord(paragraph, "Before"),
        await tripleClickWord(paragraph, "after"),
      );
    }
    expect(selections).toEqual(lines);
  });
});

describe("ChatMarkdown alert copy", () => {
  it("copies a fully selected callout as alert Markdown and a partial one as text", async () => {
    setup();
    await using screen = await renderText("> [!WARNING]\n> Back up first.");
    const [label, body] = screen.container.querySelectorAll('[role="note"] > p');
    const select = (startNode: Node, endNode: Node, endOffset: number) => {
      const range = document.createRange();
      range.setStart(startNode, 0);
      range.setEnd(endNode, endOffset);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return chatMarkdownClipboardPayload(selection)?.text;
    };
    const labelText = label!.lastChild!;
    const bodyText = body!.firstChild!;

    expect(select(labelText, bodyText, bodyText.textContent!.length)).toBe(
      "> [!WARNING]\n> Back up first.",
    );
    expect(select(labelText, bodyText, "Back up".length)).toBe("Warning\n\nBack up");
  });
});

describe("ChatMarkdown file chip tooltips", () => {
  it("wraps a long path so its file name stays inside the tooltip", async () => {
    setup();
    const path =
      "/tmp/project/packages/client-runtime/src/state/generated/environment-connection-handshake-retry-policy-fixtures.ts";
    await using screen = await renderText(`See [the fixtures](${path}).`);

    await userEvent.hover(screen.container.querySelector(".chat-markdown-file-link")!);
    const tooltip = page.getByText(path);
    await expect.element(tooltip).toBeVisible();

    const popup = tooltip.element().closest("[data-side]")!;
    const pathEnd = document.createRange();
    pathEnd.selectNodeContents(tooltip.element());
    expect(pathEnd.getBoundingClientRect().right).toBeLessThanOrEqual(
      popup.getBoundingClientRect().right,
    );
  });
});

describe("ChatMarkdown editor deep links", () => {
  const hrefs = (container: HTMLElement) =>
    [...container.querySelectorAll("a")].map((link) => link.getAttribute("href"));

  it("keeps local editor file links", async () => {
    setup();
    await using screen = await renderText(
      "[file.md line 3](cursor://file/Users/me/repo/file.md:3) and [same](vscode://file/Users/me/repo/file.md:3:7)",
    );
    expect(hrefs(screen.container)).toEqual([
      "cursor://file/Users/me/repo/file.md:3",
      "vscode://file/Users/me/repo/file.md:3:7",
    ]);
  });

  it("still drops other editor links and unknown schemes", async () => {
    setup();
    await using screen = await renderText(
      "[prompt](cursor://anysphere.cursor-deeplink/prompt?text=hi) [user](cursor://me@file/Users/me/file.md) [unknown](foo://file/Users/me/file.md)",
    );
    expect(screen.container.innerHTML).not.toContain("://");
    expect(hrefs(screen.container).filter(Boolean)).toEqual([]);
  });
});

describe("ChatMarkdown Windows file links", () => {
  const environmentId = EnvironmentId.make("env-windows");
  const renderWindows = (text: string, parseRawHtml: boolean) =>
    renderText(text, {
      cwd: "C:/Users/shawn/project",
      environmentId,
      lineBreaks: !parseRawHtml,
      parseRawHtml,
    });
  const fileHrefs = (container: HTMLElement) =>
    [...container.querySelectorAll(".chat-markdown-file-link")].map((chip) =>
      chip.getAttribute("href"),
    );

  it("still rejects unsafe schemes", async () => {
    setup();
    for (const parseRawHtml of [true, false]) {
      await using screen = await renderWindows(
        "[unsafe](javascript:alert(1)) and [unknown](d:alert(1))",
        parseRawHtml,
      );
      const { container } = screen;
      expect(container.innerHTML).not.toContain("javascript:");
      expect(container.innerHTML).not.toContain("d:alert");
      expect(fileHrefs(container)).toEqual([]);
    }
  });
});

describe("ChatMarkdown abbreviations", () => {
  it("shows an abbreviation's expansion in a popover on click, not a native tooltip", async () => {
    setup();
    await using screen = await renderText(
      'Set a <abbr title="Content Security Policy">CSP</abbr> header.',
    );
    const abbreviation = screen.container.querySelector("abbr")!;
    expect(abbreviation.textContent).toBe("CSP");
    expect(abbreviation.hasAttribute("title")).toBe(false);
    expect(document.body.textContent).not.toContain("Content Security Policy");

    await userEvent.click(abbreviation);
    await expect.element(page.getByText("Content Security Policy")).toBeVisible();
  });

  it("reports a pinned abbreviation with every abbreviation of its message when it closes", async () => {
    setup();
    const environmentId = EnvironmentId.make("environment-abbr");
    const localEnvironmentId = EnvironmentId.make("environment-local");
    setPrimaryEnvironment(localEnvironmentId);
    await using screen = await render(
      <AppAtomRegistryProvider>
        <ChatMarkdown
          cwd="/tmp/project"
          text={
            'Set a <abbr title="Content Security Policy">CSP</abbr> and <abbr title="HTTP Strict Transport Security">HSTS</abbr> header.'
          }
          // Chat messages name their environment only through the thread.
          threadRef={{ environmentId, threadId: ThreadId.make("thread-abbr") }}
        />
      </AppAtomRegistryProvider>,
    );
    const abbreviation = screen.container.querySelector("abbr")!;
    await userEvent.click(abbreviation);
    await expect.element(page.getByText("Content Security Policy")).toBeVisible();
    await userEvent.click(abbreviation);

    await vi.waitFor(() => expect(annotationReport).toHaveBeenCalledTimes(1));
    const [report] = annotationReport.mock.calls[0] as unknown as [
      { environmentId: string; input: { items: Array<Record<string, unknown>> } },
    ];
    expect(report.environmentId).toBe(localEnvironmentId);
    expect(report.input.items).toHaveLength(1);
    expect(report.input.items[0]).toMatchObject({
      kind: "pin",
      word: "CSP",
      position: 0,
      annotations: [
        ["CSP", expect.any(Number), expect.any(Number)],
        ["HSTS", expect.any(Number), expect.any(Number)],
      ],
    });
    expect(JSON.stringify(report)).not.toContain("header");
  });
});

const ENGLISH_ENVIRONMENT = EnvironmentId.make("environment-english");
const ENGLISH_PRIMARY = EnvironmentId.make("environment-english-local");

function setEnglishOnly(environmentId: EnvironmentId, on: boolean) {
  appAtomRegistry.set(annotationStatusAtom(environmentId), {
    intensity: { level: 0, until: 0 },
    english: { on, until: 0, at: 0 },
  });
}

function renderMessages(...texts: string[]) {
  return render(
    <AppAtomRegistryProvider>
      {texts.map((text) => (
        <ChatMarkdown
          key={text}
          cwd="/tmp/project"
          text={text}
          threadRef={{ environmentId: ENGLISH_ENVIRONMENT, threadId: ThreadId.make("thread-en") }}
        />
      ))}
    </AppAtomRegistryProvider>,
  );
}

const blockTexts = (container: HTMLElement) =>
  [...container.querySelectorAll("p, li, pre")].map((block) => block.textContent?.trim());

const MIXED =
  'The <abbr title="もんだい · problem / issue">問題</abbr> is small. <abbr title="きょう · today">今日</abbr>は<abbr title="あめ · rain">雨</abbr>です<abbr title="It is raining today.">。</abbr> We stay in <abbr title="いま · now">今</abbr>.';

describe("ChatMarkdown English only", () => {
  it("shows meanings for glossed words and translations for glossed sentences, then Japanese again", async () => {
    setup();
    setEnglishOnly(ENGLISH_ENVIRONMENT, true);
    await using screen = await renderMessages(
      [
        MIXED,
        // Runs back to the previous sentence mark, and keeps translations apart.
        '<abbr title="あめ · rain">雨</abbr>です<abbr title="It is rain.">。</abbr><abbr title="ほんとう · really">本当</abbr>に<abbr title="Really?">？</abbr>',
        // Runs back to the start of a list item.
        '- <abbr title="もう · already">もう</abbr>、<abbr title="おわり · end">終わり</abbr>です<abbr title="It is already over.">。</abbr>',
        // Never runs back across code, and leaves code as written.
        'Run `npm test` <abbr title="いま · now">今</abbr>, then `git push` <abbr title="もう · already">もう</abbr>した<abbr title="Already pushed.">！</abbr>',
        '```html\n<abbr title="もんだい · problem">問題</abbr>\n```',
        // Abbreviations that aren't Japanese stay.
        'Set a <abbr title="Content Security Policy">CSP</abbr> header <abbr title="いま · now">今</abbr>.',
      ].join("\n\n"),
    );
    await vi.waitFor(() =>
      expect(blockTexts(screen.container)).toEqual([
        "The problem is small. It is raining today. We stay in now.",
        "It is rain. Really?",
        "It is already over.",
        "Run npm test now, then git push Already pushed.",
        '<abbr title="もんだい · problem">問題</abbr>',
        "Set a CSP header now.",
      ]),
    );
    expect([...screen.container.querySelectorAll("abbr")].map((abbr) => abbr.textContent)).toEqual([
      "CSP",
    ]);
    expect(screen.container.querySelector("code")?.textContent).toBe("npm test");

    await act(() => setEnglishOnly(ENGLISH_ENVIRONMENT, false));
    await vi.waitFor(() =>
      expect(blockTexts(screen.container)[0]).toBe(
        "The 問題 is small. 今日は雨です。 We stay in 今.",
      ),
    );
    expect(screen.container.querySelectorAll("abbr[data-markdown-abbreviation]")).toHaveLength(17);
  });

  it("reports no reading and offers no gloss while it is on", async () => {
    setup();
    setEnglishOnly(ENGLISH_ENVIRONMENT, true);
    await using screen = await renderMessages(MIXED);
    const paragraph = screen.container.querySelector("p")!;
    await vi.waitFor(() => expect(paragraph.querySelector("[data-english]")).not.toBeNull());
    await userEvent.click(page.getByText("problem", { exact: false }));
    paragraph.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    flushReading();
    expect(annotationReport).not.toHaveBeenCalled();

    // The same click, once Japanese is back, is reported.
    await act(() => setEnglishOnly(ENGLISH_ENVIRONMENT, false));
    await vi.waitFor(() => expect(paragraph.querySelector("abbr")).not.toBeNull());
    await vi.waitFor(() => expect(visibleReadingContexts()).toHaveLength(1));
    paragraph.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    flushReading();
    expect(annotationReport).toHaveBeenCalled();
    await userEvent.click(paragraph.querySelector("abbr")!);
    await expect.element(page.getByText("もんだい · problem / issue")).toBeVisible();
  });

  it("toggles from the shortcut, sending the messages on screen when it turns on", async () => {
    setup();
    setPrimaryEnvironment(ENGLISH_PRIMARY);
    using stack = new DisposableStack();
    const state = {
      matches: [
        { routeId: "__root__", pathname: "/", params: {} },
        { routeId: "/_chat", pathname: "/", params: {} },
      ],
    };
    stack.defer(installChatRouteCommands({ state } as never));
    await using screen = await renderMessages(MIXED, 'One <abbr title="いま · now">今</abbr>.');
    await vi.waitFor(() => expect(visibleReadingContexts()).toHaveLength(2));
    const onScreen = visibleReadingContexts();

    const pressShortcut = () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "E",
          code: "KeyE",
          altKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    pressShortcut();
    await vi.waitFor(() =>
      expect(englishSet).toHaveBeenCalledWith({
        environmentId: ENGLISH_PRIMARY,
        input: { on: true, contexts: onScreen },
      }),
    );
    await vi.waitFor(() =>
      expect(blockTexts(screen.container)).toEqual([
        "The problem is small. It is raining today. We stay in now.",
        "One now.",
      ]),
    );

    pressShortcut();
    await vi.waitFor(() =>
      expect(englishSet).toHaveBeenLastCalledWith({
        environmentId: ENGLISH_PRIMARY,
        input: { on: false, contexts: [] },
      }),
    );
    await vi.waitFor(() => expect(blockTexts(screen.container)[1]).toBe("One 今."));
  });
});

// A swapped word from heavier (1) up, and a sentence whose Japanese twin shows from much heavier (2) up; its English
// twin has a word of its own from normal (0) up.
const LEVELED =
  'The <abbr title="もんだい · problem" data-en="problem" data-on="1">問題</abbr> is small. ' +
  '<span data-jw="ja" data-on="2"><abbr title="あめ · rain">雨</abbr>です<abbr title="It is rain.">。</abbr></span>' +
  '<span data-jw="en" data-on="2">It is <abbr title="あめ · rain" data-en="rain" data-on="0">雨</abbr>.</span>';

describe("ChatMarkdown levels", () => {
  it("hides an abbr tag still arriving at the end of a streaming reply, before it has any levels", async () => {
    setup();
    await using screen = await renderText(
      'Say x<y. The <abbr title="もんだい · problem" data-en="pro',
      {
        isStreaming: true,
      },
    );
    expect(screen.container.textContent).toBe("Say x<y. The ");
  });

  it("renders a message at the reader's level, again from the panel's arrows, and reports what it shows at that level", async () => {
    setup();
    setEnglishOnly(ENGLISH_ENVIRONMENT, false);
    await using screen = await render(
      <AppAtomRegistryProvider>
        <ThreadJapanesePanel environmentId={ENGLISH_ENVIRONMENT} />
        <ChatMarkdown
          cwd="/tmp/project"
          text={LEVELED}
          threadRef={{ environmentId: ENGLISH_ENVIRONMENT, threadId: ThreadId.make("thread-en") }}
        />
      </AppAtomRegistryProvider>,
    );
    const paragraph = screen.container.querySelector("p")!;
    const reported = (kind: string) =>
      annotationReport.mock.calls
        .flatMap(
          ([report]) => (report as { input: { items: Array<{ kind: string }> } }).input.items,
        )
        .filter((item) => item.kind === kind);
    const glossed = (...words: string[]) =>
      words.map((word) => [word, expect.any(Number), expect.any(Number)]);
    const pin = async (word: Element, gloss: string) => {
      await userEvent.click(word);
      await expect.element(page.getByText(gloss)).toBeVisible();
      await userEvent.click(word);
      await vi.waitFor(() => expect(reported("pin")).toHaveLength(1));
      const [opened] = reported("pin");
      annotationReport.mockClear();
      return opened;
    };
    expect(paragraph.textContent).toBe("The problem is small. It is 雨.");
    expect(await pin(paragraph.querySelector("abbr")!, "あめ · rain")).toMatchObject({
      word: "雨",
      position: 0,
      level: 0,
      annotations: glossed("雨"),
    });

    const heavier = page.getByRole("button", { name: "Heavier" });
    await userEvent.click(heavier);
    await vi.waitFor(() => expect(paragraph.textContent).toBe("The 問題 is small. It is 雨."));
    await userEvent.click(heavier);
    await expect.element(page.getByText("much heavier")).toBeVisible();
    await vi.waitFor(() => expect(paragraph.textContent).toBe("The 問題 is small. 雨です。"));
    // The same paragraph, rendered again in place.
    expect(screen.container.querySelector("p")).toBe(paragraph);
    expect(await pin(paragraph.querySelector("abbr")!, "もんだい · problem")).toMatchObject({
      word: "問題",
      position: 0,
      level: 2,
      annotations: glossed("問題", "雨", "。"),
    });
    paragraph.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    flushReading();
    expect(reported("click")).toEqual([
      expect.objectContaining({ level: 2, annotations: glossed("問題", "雨", "。") }),
    ]);

    // English only renders as no Japanese at all.
    await act(() => setEnglishOnly(ENGLISH_ENVIRONMENT, true));
    await vi.waitFor(() => expect(paragraph.textContent).toBe("The problem is small. It is rain."));
    expect(paragraph.querySelector("abbr")).toBeNull();
  });

  it("reports only once its server's level is known, rendering until then at the level stored last", async () => {
    setup();
    // The level the collector answered at an earlier start, then a new start that hasn't read it yet.
    setEnglishOnly(ENGLISH_ENVIRONMENT, false);
    await stepAnnotationLevel(ENGLISH_ENVIRONMENT, 1);
    appAtomRegistry.set(annotationStatusAtom(ENGLISH_ENVIRONMENT), null);
    await using screen = await renderMessages(`${LEVELED} Again.`);
    const paragraph = screen.container.querySelector("p")!;
    expect(paragraph.textContent).toBe("The 問題 is small. It is 雨. Again.");
    const pinned = async () => {
      const word = paragraph.querySelector("abbr")!;
      await userEvent.click(word);
      await expect.element(page.getByText("もんだい · problem")).toBeVisible();
      await userEvent.click(word);
      await expect.element(page.getByText("もんだい · problem")).not.toBeInTheDocument();
      flushReading();
      return annotationReport.mock.calls.flatMap(
        ([report]) => (report as { input: { items: Array<{ kind: string }> } }).input.items,
      );
    };
    expect(await pinned()).toEqual([]);
    expect(visibleReadingContexts()).toEqual([]);

    await act(() =>
      appAtomRegistry.set(annotationStatusAtom(ENGLISH_ENVIRONMENT), {
        intensity: { level: 1, until: 0 },
        english: { on: false, until: 0, at: 0 },
      }),
    );
    await vi.waitFor(() => expect(visibleReadingContexts()).toHaveLength(1));
    const items = await pinned();
    expect(items.filter((item) => item.kind === "pin")).toEqual([
      expect.objectContaining({ word: "問題", level: 1 }),
    ]);
    expect(items.filter((item) => item.kind === "shown")).toEqual([
      expect.objectContaining({ level: 1 }),
    ]);
  });
});
