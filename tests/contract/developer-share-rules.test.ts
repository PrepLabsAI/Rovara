// Spec 025 FR-031, FR-032, D5, D6: who shares where, in which mode, and what the thread says.
import { describe, expect, it } from "vitest";
import { AgentXError, DEFAULT_DEVELOPER_TASK_POLICY, type DeveloperTaskPolicy } from "@agentx/contracts";
import { decideShare, decideMode, channelLabel } from "../../packages/broker/src/developer/share.js";
import { CUT_MARKER } from "../../packages/broker/src/aws/slack-details-view.js";
import { CANCELLED_REPLY, CLOSED_REPLY, endedReply, modeReply, pullRequestReply, READY_REPLY, setupFailedReply, startMessage } from "../../packages/broker/src/developer/share-messages.js";

const policy = (overrides: Partial<DeveloperTaskPolicy> = {}): DeveloperTaskPolicy => ({ ...DEFAULT_DEVELOPER_TASK_POLICY, ...overrides });
const ONE = [{ channelId: "C0123456789", name: "payments-dev", isPrivate: false }];
const TWO = [...ONE, { channelId: "G0PRIVATE01", name: "payments-secret", isPrivate: true }];
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

  it("uses the only bound channel and the project's default mode, view (D6)", () => {
    expect(decideShare({ project: "payments", policy: policy(), shareToChannel: true, bound: ONE })).toEqual({ channelId: "C0123456789", channelName: "payments-dev", mode: "view", sharedReason: "requested" });
  });

  it("shares a start that did not ask when the project requires it, and says so (US3 scenario 2)", () => {
    expect(decideShare({ project: "payments", policy: policy({ share: "required" }), shareToChannel: false, bound: ONE })).toMatchObject({ sharedReason: "required", mode: "view" });
  });

  it("turns continue into view when the project does not allow continue, and says why (D5, US3 scenario 8)", () => {
    const ledger = policy({ share: "required", shareMode: { default: "view", allowContinue: false } });
    expect(decideShare({ project: "ledger", policy: ledger, shareToChannel: false, shareMode: "continue", bound: ONE })).toEqual({
      channelId: "C0123456789", channelName: "payments-dev", mode: "view", sharedReason: "required", modeReason: "continue_not_allowed",
    });
    expect(decideMode(ledger, "view")).toEqual({ mode: "view" });
  });

  it("finds a named channel by ID or by public name, with or without #, in any case", () => {
    for (const channel of ["C0123456789", "payments-dev", "#Payments-Dev"]) {
      expect(decideShare({ project: "payments", policy: policy(), shareToChannel: true, channel, bound: TWO })?.channelId).toBe("C0123456789");
    }
    expect(decideShare({ project: "payments", policy: policy(), shareToChannel: true, channel: "G0PRIVATE01", bound: TWO })).toMatchObject({ channelId: "G0PRIVATE01" });
    expect(decideShare({ project: "payments", policy: policy(), shareToChannel: true, channel: "G0PRIVATE01", bound: TWO })).not.toHaveProperty("channelName");
  });

  it("never matches a private channel by name, and never shows its name (R10)", () => {
    const answer = refusal(() => decideShare({ project: "payments", policy: policy(), shareToChannel: true, channel: "payments-secret", bound: TWO }));
    expect(answer.code).toBe("CHANNEL_REQUIRED");
    // The input is the caller's own words; the list of channels never shows a private name.
    expect(answer.message).toContain("its channels are #payments-dev, G0PRIVATE01");
  });

  it("refuses CHANNEL_REQUIRED with no bound channel, and CHANNEL_AMBIGUOUS with several and none named", () => {
    expect(refusal(() => decideShare({ project: "payments", policy: policy({ share: "required" }), shareToChannel: false, bound: [] }))).toMatchObject({ code: "CHANNEL_REQUIRED" });
    const ambiguous = refusal(() => decideShare({ project: "payments", policy: policy(), shareToChannel: true, bound: TWO }));
    expect(ambiguous.code).toBe("CHANNEL_AMBIGUOUS");
    expect(ambiguous.message).toContain("#payments-dev");
  });

  it("never echoes a channel input that could carry markup", () => {
    const answer = refusal(() => decideShare({ project: "payments", policy: policy(), shareToChannel: true, channel: "<!here> hi", bound: ONE }));
    expect(answer.message).not.toContain("<!here>");
    expect(answer.message).toContain("that channel");
  });

  it("labels a channel by its public name, else by ID", () => {
    expect(TWO.map(channelLabel)).toEqual(["#payments-dev", "G0PRIVATE01"]);
    expect(channelLabel({ channelId: "C0UNKNOWN01" })).toBe("C0UNKNOWN01");
  });
});

describe("the thread's texts (FR-032, C8)", () => {
  const input = { developerName: "Maya Chen", slackUserId: "U0MAYA001", client: "Claude Code", title: "Fix the flaky retry test", project: "payments", status: "STARTING", sharedReason: "requested" as const };

  it("names the developer, the client, the title, the project, the status and the mode", () => {
    const view = startMessage({ ...input, mode: "view" });
    expect(view).toContain("<@U0MAYA001> started a task from Claude Code: *Fix the flaky retry test*");
    expect(view).toContain("`payments`");
    expect(view).toContain("STARTING");
    expect(view).toContain("follow-ups happen in");
    expect(startMessage({ ...input, mode: "continue" })).toContain("may mention AgentX in this thread to steer the task");
  });

  it("writes an unlinked developer's name as plain, escaped text, and says when the project required sharing", () => {
    const text = startMessage({ ...input, slackUserId: undefined, developerName: "Omar <!channel>", mode: "view", sharedReason: "required" });
    expect(text).toContain("Omar &lt;!channel&gt; started a task");
    expect(text).toContain("This project shares every task started from an AI tool.");
  });

  it("escapes the title, so a title cannot notify the channel", () => {
    expect(startMessage({ ...input, title: "<!here> fix", mode: "view" })).toContain("*&lt;!here&gt; fix*");
  });

  it("gives the status, failure and summary, redacted and cut to 1,500 characters", () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const text = endedReply({ status: "SUCCEEDED", summary: `Done with ${secret} ${"x".repeat(3_000)}` });
    expect(text).toContain("The task ended SUCCEEDED.");
    expect(text).not.toContain(secret);
    expect(text.length).toBeLessThan(1_700);
    expect(endedReply({ status: "FAILED", failure: { category: "task_failed", message: "tests failed" } })).toContain("FAILED (task_failed): tests failed");
    expect(setupFailedReply("npm ci exited 1")).toContain("npm ci exited 1");
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

  it("keeps a failure message full of & within 300 characters after escaping (F21)", () => {
    const text = endedReply({ status: "FAILED", failure: { category: "task_failed", message: "&".repeat(300) } });
    const message = text.slice("The task ended FAILED (task_failed): ".length);
    expect(message.length).toBeLessThanOrEqual(300);
    expect(setupFailedReply("&".repeat(300)).length).toBeLessThanOrEqual("The workspace could not be set up, so the task did not run: ".length + 300);
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

  it("marks a summary the redaction cap cut, even when the rest fits", () => {
    const text = endedReply({ status: "SUCCEEDED", summary: "x".repeat(3_000) });
    expect(text.endsWith(CUT_MARKER)).toBe(true);
    expect(text.slice("The task ended SUCCEEDED.\n".length).length).toBeLessThanOrEqual(1_500);
    expect(endedReply({ status: "SUCCEEDED", summary: "short and whole" })).toBe("The task ended SUCCEEDED.\n>short and whole");
    expect(setupFailedReply("y".repeat(600)).endsWith(CUT_MARKER)).toBe(true);
  });

  it("links a pull request, says the mode, and says a close ended the thread", () => {
    expect(pullRequestReply("https://github.com/example/demo/pull/7")).toBe("Pull request opened: https://github.com/example/demo/pull/7");
    expect(modeReply("view")).toContain("view only");
    expect(modeReply("continue")).toContain("open to the channel");
    expect(CLOSED_REPLY).toContain("no longer drives it");
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
