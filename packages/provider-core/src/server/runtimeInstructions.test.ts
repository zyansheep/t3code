import { assert, describe, it } from "@effect/vitest";

import {
  buildDiskSpaceNote,
  buildRuntimeInstructions,
  readFreeDiskSpace,
} from "./runtimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("leaves PR linking to a session that already carries it, and keeps runtime identity", () => {
    const instructions = buildRuntimeInstructions({
      harness: "Antigravity",
      model: "gemini-3.8-flash",
      pullRequestLinking: false,
    });

    assert.include(instructions, "through the Antigravity harness, as gemini-3.8-flash.");
    assert.notInclude(instructions, "<pull_request_linking>");
  });

  it("links PRs the agent creates, takes over, or pushes to, and no others", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });

    assert.include(instructions, "Link each PR you create, take over, or push to");
    assert.include(instructions, "every stack layer");
    assert.include(instructions, "Skip PRs you only read or review");
    assert.include(instructions, "If linking fails, say so.");
    assert.notInclude(instructions, "git log -1");
    assert.notInclude(instructions, "work on");
    // Listing linked PRs as an end-of-work check found nothing to add in audited threads.
    assert.notInclude(instructions, "list_thread_pull_requests");
  });

  it("waits on a PR only with the watch, never with a poll loop", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });

    assert.notInclude(instructions, "Creation, pending checks, or a merge ask alone is not enough");
    assert.include(instructions, "Links and watches persist across pushes.");
    // The wake message itself carries the do-not-re-watch rule.
    assert.notInclude(instructions, "On a wake");
    assert.include(
      instructions,
      "Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch",
    );
    assert.notInclude(instructions, "merge it now");
    assert.include(instructions, "Otherwise act now or hand back.");
    assert.include(instructions, "then watch and end your turn");
    assert.include(instructions, "never watch, even if the brief says babysit");
    assert.include(
      instructions,
      "After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>.",
    );
    assert.include(
      instructions,
      "For PR waits, no sleep, loops, gh --watch, Monitor or ScheduleWakeup.",
    );
    assert.include(instructions, "call unwatch_pull_request");
  });
});

describe("buildDiskSpaceNote", () => {
  it("gives free space per filesystem, and says when it is low", () => {
    const note = buildDiskSpaceNote([
      { path: "/tmp", freeBytes: 21.4e9 },
      { path: "/home/me", freeBytes: 8.25e9 },
    ]);

    assert.include(note, "Free disk space now: 21 GB on /tmp, 8.3 GB on /home/me. That is low.");
    assert.include(note, "delete when done");
    assert.notInclude(buildDiskSpaceNote([{ path: "/tmp", freeBytes: 200e9 }]), "That is low.");
  });

  it("says nothing when the space can't be read", () => {
    assert.equal(buildDiskSpaceNote([]), "");
    assert.deepStrictEqual(readFreeDiskSpace(["/no/such/path/for/t3"]), []);
  });

  it("names a filesystem once when the temp dir and home share it", () => {
    const space = readFreeDiskSpace(["/", "/"]);

    assert.equal(space.length, 1);
    assert.isAbove(space[0]!.freeBytes, 0);
  });

  it("stays out of the runtime note, whose text must not change from turn to turn", () => {
    assert.notInclude(buildRuntimeInstructions({ harness: "Codex" }), "disk_space");
  });
});
