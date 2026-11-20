// Spec 025 FR-031, FR-032, D5, D6: who shares where, in which mode, and what the thread says.
import { describe, expect, it } from "vitest";
import { AgentXError, DEFAULT_DEVELOPER_TASK_POLICY, type DeveloperTaskPolicy } from "@agentx/contracts";
import { decideShare } from "../../packages/broker/src/developer/share.js";
import { CUT_MARKER } from "../../packages/broker/src/aws/slack-details-view.js";
import { CANCELLED_REPLY, CLOSED_REPLY, endedReply, modeReply, pullRequestReply, READY_REPLY, SETUP_OUTPUT_SHOWN_MAX, setupFailedReply, startMessage } from "../../packages/broker/src/developer/share-messages.js";

const policy = (overrides: Partial<DeveloperTaskPolicy> = {}): DeveloperTaskPolicy => ({ ...DEFAULT_DEVELOPER_TASK_POLICY, ...overrides });
const ONE = [{ channelId: "C0123456789", name: "payments-dev", isPrivate: false }];
const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof AgentXError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected a refusal");
};

describe("decideShare (FR-031)", () => {
  it("shares nothing unless asked or required, even when a channel or mode is named (C3)", () => {
    expect(decideShare({ project: "payments", policy: policy(), shareToChannel: false, channel: "#payments-dev", shareMode: "continue", bound: ONE })).toBeUndefined();
  });

  it("never echoes a channel input that could carry markup", () => {
    const answer = refusal(() => decideShare({ project: "payments", policy: policy(), shareToChannel: true, channel: "<!here> hi", bound: ONE }));
    expect(answer.message).not.toContain("<!here>");
    expect(answer.message).toContain("that channel");
  });

});

describe("the thread's texts (FR-032, C8)", () => {
  const input = { developerName: "Maya Chen", slackUserId: "U0MAYA001", client: "Claude Code", title: "Fix the flaky retry test", project: "payments", status: "STARTING", sharedReason: "requested" as const };

  it("writes an unlinked developer's name as plain, escaped text, and says when the project required sharing", () => {
    const text = startMessage({ ...input, slackUserId: undefined, developerName: "Omar <!channel>", mode: "view", sharedReason: "required" });
    expect(text).toContain("Omar &lt;!channel&gt; started a task");
    expect(text).toContain("This project shares every task started from an AI tool.");
  });

  it("says a failed or cancelled pull request as the pull request, not as the task ending (final review M4)", () => {
    expect(endedReply({ kind: "publish", status: "FAILED", failure: { category: "publication_failed", message: "push rejected" } }))
      .toBe("The pull request could not be opened (FAILED, publication_failed): push rejected");
    expect(endedReply({ kind: "publish", status: "INTERRUPTED", failure: { category: "interrupted", message: "the worker stopped" } }))
      .toBe("The pull request could not be opened (INTERRUPTED, interrupted): the worker stopped");
    expect(endedReply({ kind: "publish", status: "CANCELLED" })).toBe("The pull request was cancelled before it opened.");
    // A task operation still reads as the task.
    expect(endedReply({ kind: "task", status: "CANCELLED" })).toBe("The task ended CANCELLED.");
  });

  it("keeps a summary full of & within 1,500 characters after escaping (F21)", () => {
    const head = "The task ended SUCCEEDED.";
    const text = endedReply({ status: "SUCCEEDED", summary: "&".repeat(1_500) });
    expect(text.startsWith(`${head}\n>`)).toBe(true);
    const summary = text.slice(head.length + 2);
    expect(summary.length).toBeLessThanOrEqual(1_500);
    expect(summary).not.toMatch(/&(?!amp;)/);
    expect(summary.endsWith(CUT_MARKER)).toBe(true);
  });

  it("keeps a many-line quoted summary, every > counted, within 1,500 characters", () => {
    const head = "The task ended SUCCEEDED.";
    const text = endedReply({ status: "SUCCEEDED", summary: Array.from({ length: 700 }, () => "a").join("\n") });
    const summary = text.slice(head.length + 1);
    expect(summary.startsWith(">a\n>a")).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(1_500);
    expect(summary.endsWith(CUT_MARKER)).toBe(true);
    for (const line of summary.split("\n")) expect(line.startsWith(">")).toBe(true);
  });

  it("keeps a failed setup's last lines of output, quoted, after what failed (#225)", () => {
    const token = `ghp_${"Z9y8X7w6V5".repeat(4)}`;
    expect(setupFailedReply(`setup step 0 (npm ci in repo/app) exited 1\nLast lines:\nnpm ERR! code E401\nnpm ERR! 401 Unauthorized <token ${token}>`))
      .toBe("The workspace could not be set up, so the task did not run: setup step 0 (npm ci in repo/app) exited 1\nLast lines of its output:\n>npm ERR! code E401\n>npm ERR! 401 Unauthorized &lt;token [REDACTED]&gt;");
    // The lines are bounded, and keep their end, where the error is.
    const long = setupFailedReply(`setup step 0 (npm ci in repo/app) exited 1\nLast lines:\n${Array.from({ length: 20 }, (_, index) => `line ${index} ${"x".repeat(60)}`).join("\n")}`);
    const quoted = long.split("Last lines of its output:\n")[1]!;
    expect(quoted.length).toBeLessThanOrEqual(SETUP_OUTPUT_SHOWN_MAX);
    expect(quoted.endsWith(`line 19 ${"x".repeat(60)}`)).toBe(true);
    for (const line of quoted.split("\n")) expect(line.startsWith(">")).toBe(true);
    // One last line longer than the bound keeps its end.
    const one = setupFailedReply(`setup step 0 (make in repo/app) exited 2\nLast lines:\n${"a".repeat(2_000)} the real error`).split("Last lines of its output:\n")[1]!;
    expect(one.startsWith(">...a")).toBe(true);
    expect(one.endsWith(" the real error")).toBe(true);
    expect(one.length).toBeLessThanOrEqual(SETUP_OUTPUT_SHOWN_MAX);
  });

  it("uses no em dash in any text", () => {
    const texts = [
      startMessage({ ...input, mode: "view" }),
      startMessage({ ...input, mode: "continue" }),
      endedReply({ status: "CANCELLED" }),
      endedReply({ status: "FAILED", failure: { category: "task_failed", message: "tests failed" } }),
      endedReply({ status: "SUCCEEDED", summary: "All green." }),
      modeReply("view"),
      modeReply("continue"),
      pullRequestReply("https://github.com/example/demo/pull/7"),
      READY_REPLY,
      CANCELLED_REPLY,
      CLOSED_REPLY,
      setupFailedReply(undefined),
    ];
    for (const text of texts) expect(text).not.toContain("\u2014");
  });
});
