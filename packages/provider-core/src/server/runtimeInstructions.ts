// @effect-diagnostics nodeBuiltinImport:off -- Effect's FileSystem has no statfs, and the free-space note is read synchronously where a session's prompt is built.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

/** Session-invariant; harnesses with a native system-prompt append can carry it once per session. */
export const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
Link each PR you create, take over, or push to: link_pull_request, or link_pull_requests for several, full URL, every stack layer, as your next call. Host tools don't link for you. If linking fails, say so. Skip PRs you only read or review and PRs named only as background. Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch. Finish any needed branch update and push first, then watch and end your turn. Otherwise act now or hand back. Delegated children never watch, even if the brief says babysit. After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>. Links and watches persist across pushes. For PR waits, no sleep, loops, gh --watch, Monitor or ScheduleWakeup. Before handback, call unwatch_pull_request on any PR you watch.
</pull_request_linking>`;

/** Omit model and effort when the harness manages them dynamically. */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  /** False when the session's system prompt already carries the linking instructions. */
  readonly pullRequestLinking?: boolean;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const runtimeInfo = `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images, video, and audio using Markdown image syntax with absolute file paths. Link every other file you cite or produce by its absolute path, as in [http.ts:42](/abs/path/http.ts:42), so the user can open it in T3 Code's files viewer.</runtime_info>`;
  return runtime.pullRequestLinking === false
    ? runtimeInfo
    : `${runtimeInfo}\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

export interface FreeDiskSpace {
  readonly path: string;
  readonly freeBytes: number;
}

/** Free space where agents write scratch files (the temp dir and home), one entry per filesystem. */
export function readFreeDiskSpace(
  paths: ReadonlyArray<string> = [NodeOS.tmpdir(), NodeOS.homedir()],
): ReadonlyArray<FreeDiskSpace> {
  const seen = new Set<number>();
  const out: Array<FreeDiskSpace> = [];
  for (const path of paths) {
    try {
      const dev = NodeFS.statSync(path).dev;
      if (seen.has(dev)) continue;
      seen.add(dev);
      const fs = NodeFS.statfsSync(path);
      out.push({ path, freeBytes: fs.bavail * fs.bsize });
    } catch {
      // A path that can't be read is left out; no note at all is better than a wrong one.
    }
  }
  return out;
}

/**
 * Free disk space for the session's opening context, so an agent knows how much room its downloads, builds and
 * scratch files have. Read once per session (Claude) or per turn (Codex), never mid-turn. Empty when unreadable.
 */
export function buildDiskSpaceNote(
  space: ReadonlyArray<FreeDiskSpace> = readFreeDiskSpace(),
): string {
  if (space.length === 0) return "";
  const where = space
    .map(({ path, freeBytes }) => `${formatGigabytes(freeBytes)} on ${path}`)
    .join(", ");
  const low = space.some(({ freeBytes }) => freeBytes < LOW_DISK_SPACE_BYTES);
  return `<disk_space>Free disk space now: ${where}.${
    low ? " That is low." : ""
  } Other agents share it: keep big downloads, builds and copies to what the task needs, and keep scratch files in one folder of your own that you delete when done.</disk_space>`;
}

const LOW_DISK_SPACE_BYTES = 30e9;

function formatGigabytes(bytes: number): string {
  const gb = bytes / 1e9;
  return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`;
}
