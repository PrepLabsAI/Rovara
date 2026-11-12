// Issue #438: an adapter's conversation hears what a turn did as typed events, so it can act without parsing text: a
// `pr` event with the pull request's repository, number, head commit and action, a `check_report` naming its task
// and, for a publication, the commit it checked, and `done` with how the request ended. Every field is optional, so
// an adapter that knows none of them reads the events as before.
import { describe, expect, it, vi } from "vitest";
import { ChannelEventSchema, type ChannelEvent, type ChannelQueueItem, type SlackThreadWorkspaceResult } from "../../packages/contracts/src/index.js";
import { TurnRecorder } from "../../packages/orchestrator/src/turn-recorder.js";
import { channelRequestHandler } from "../../packages/slack-service/src/channel-requests.js";
import type { TurnInput } from "../../packages/slack-service/src/processor.js";

const conversation = { channel: "scheduler", tenant: "acme", space: "graph-7", thread: "task-3" };
const actor = { channel: "scheduler", tenant: "acme", userId: "svc" };
const workspaceId = "11111111-1111-4111-8111-111111111111";
const taskOperation = "0f0e0d0c-0b0a-4908-8706-050403020100";
const publishOperation = "1f0e0d0c-0b0a-4908-8706-050403020101";
const sha = "c".repeat(40);
const message: ChannelQueueItem = {
  kind: "message", projectName: "web", developerId: "dev-1", stepUp: [],
  message: { version: 2, channel: "scheduler", eventId: "evt-1", conversation, actor, text: "fix the login bug and open a PR", receivedAt: "2026-11-11T10:01:00.000Z" },
};
const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }], details: {} });
const report = {
  status: "verified", source: "project", preambleVersion: "1", preambleSha256: "a".repeat(64), extraTry: "not_needed", agentClaim: "success",
  checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "failed", after: "passed", class: "fixed", output: "", durationMs: 1200 }],
};
const published = {
  repository: "web", number: 42, url: "https://github.com/acme/web/pull/42", headBranch: `agentx/${workspaceId}`, baseBranch: "main", commit: sha, reconciled: false, draft: false, codeBuildChecks: [],
  checks: [{ index: 0, cwd: ".", executable: "npm", exitCode: 0, stdout: "", stderr: "", startedAt: "2026-11-11T10:05:00.000Z", completedAt: "2026-11-11T10:06:00.000Z", outcome: "passed" }],
};

/** A turn that runs a worker task, then opens its pull request. */
function codingTurn(input: TurnInput): Promise<string> {
  const recorder = input.recorder!;
  recorder.toolStarted({ toolCallId: "1", toolName: "agentx_submit_task", args: {} });
  recorder.toolEnded({ toolCallId: "1", toolName: "agentx_submit_task", isError: false, result: text({ operationId: taskOperation, status: "SUCCEEDED", checks: report }) });
  recorder.toolStarted({ toolCallId: "2", toolName: "agentx_create_pull_request", args: { repository: "web", title: "Fix the login bug" } });
  recorder.toolEnded({ toolCallId: "2", toolName: "agentx_create_pull_request", isError: false, result: text({ operationId: publishOperation, status: "SUCCEEDED", result: published }) });
  return Promise.resolve("Fixed, and the pull request is open.");
}

function harness(runTurn: (input: TurnInput) => Promise<string>) {
  const events: ChannelEvent[] = [];
  const workspace: SlackThreadWorkspaceResult = { outcome: "WORKSPACE", workspaceId, status: "READY", operationId: null, created: false, orchestratorInstructions: "Delegate coding." };
  const handle = channelRequestHandler({
    processor: {
      api: () => ({
        ensureWorkspace: async () => workspace, startClose: async () => ({ outcome: "NOT_FOUND" }),
        completeClose: vi.fn(), waitForOperation: vi.fn(), createConversation: async () => "33333333-3333-4333-8333-333333333333",
      }),
      threads: { load: async () => ({ workspaceId, conversationId: "33333333-3333-4333-8333-333333333333" }), saveConversation: vi.fn(), saveSettingsRevision: vi.fn(), close: vi.fn(), finish: vi.fn(async () => undefined) },
      runTurn,
      log: () => undefined,
    },
    send: async (event) => { events.push(ChannelEventSchema.parse(event)); },
    log: () => undefined,
  });
  return { events, run: () => handle(message, { finalAttempt: false }) };
}
const ofType = <T extends ChannelEvent["type"]>(events: ChannelEvent[], type: T) => events.filter((event): event is Extract<ChannelEvent, { type: T }> => event.type === type);

describe("a coding turn in an adapter's conversation (#438)", () => {
  it("sends the reply, then the pull request, the checks, and done with its outcome, in that order", async () => {
    const { events, run } = harness(codingTurn);
    await run();
    expect(events.map((event) => event.type)).toEqual(["message", "pr", "check_report", "check_report", "done"]);
    expect(ofType(events, "pr")[0]!.data).toEqual({
      url: "https://github.com/acme/web/pull/42", title: "Fix the login bug", taskId: publishOperation,
      repository: "acme/web", number: 42, headSha: sha, baseBranch: "main", draft: false, action: "opened",
    });
    const [task, publication] = ofType(events, "check_report");
    expect(task!.data).toMatchObject({ status: "passed", taskId: taskOperation, checks: [{ name: "npm test", status: "passed" }] });
    expect(publication!.data).toMatchObject({ status: "passed", taskId: publishOperation, checks: [{ name: "1: npm", status: "passed" }] });
    expect(ofType(events, "done")[0]!.data).toEqual({ inReplyTo: "evt-1", outcome: "succeeded", taskId: publishOperation });
  });

  it("names, for a task, the same commit as the pull request's head and the checks that ran on it", async () => {
    const { events, run } = harness(codingTurn);
    await run();
    const pr = ofType(events, "pr")[0]!.data;
    const checked = ofType(events, "check_report").find((event) => event.data.taskId === pr.taskId)!.data;
    expect(checked.commits).toEqual([{ repository: "acme/web", sha: pr.headSha }]);
  });

  it("names a pull request change by its action", async () => {
    const { events, run } = harness(async (input) => {
      input.recorder!.toolStarted({ toolCallId: "1", toolName: "agentx_close_pull_request", args: {} });
      input.recorder!.toolEnded({ toolCallId: "1", toolName: "agentx_close_pull_request", isError: false, result: text({ operationId: publishOperation, status: "SUCCEEDED", result: { ...published, action: "close", state: "closed", checks: [] } }) });
      return "Closed.";
    });
    await run();
    expect(ofType(events, "pr")[0]!.data).toMatchObject({ action: "closed", title: "acme/web#42", number: 42 });
    expect(ofType(events, "check_report")).toEqual([]);
  });

  it("ends a turn that ran nothing as no_change, and a failed one as failed with a code", async () => {
    const quiet = harness(async () => "Nothing to do.");
    await quiet.run();
    expect(ofType(quiet.events, "done")[0]!.data).toEqual({ inReplyTo: "evt-1", outcome: "no_change" });
    const failing = harness(async () => { throw new Error("model down"); });
    await failing.run();
    expect(ofType(failing.events, "done")[0]!.data).toMatchObject({ outcome: "failed", code: "request_failed" });
  });
});

describe("adapters that know none of the new fields (#438)", () => {
  it("still read every event as they did, since each field is optional", () => {
    const base = { version: 1, id: "evt_AAAAAAAAAAAAAAAAAAAA", channel: "scheduler", conversation, createdAt: "2026-11-11T10:00:00.000Z" };
    expect(ChannelEventSchema.safeParse({ ...base, type: "pr", data: { url: "https://github.com/acme/web/pull/42", title: "t" } }).success).toBe(true);
    expect(ChannelEventSchema.safeParse({ ...base, type: "check_report", data: { text: "ok", status: "passed" } }).success).toBe(true);
    expect(ChannelEventSchema.safeParse({ ...base, type: "done", data: {} }).success).toBe(true);
    expect(ChannelEventSchema.safeParse({ ...base, type: "done", data: { outcome: "maybe" } }).success).toBe(false);
  });
});

describe("the turn recorder's pull requests (#438)", () => {
  const recorded = (name: string, value: unknown) => {
    const recorder = new TurnRecorder();
    recorder.toolStarted({ toolCallId: "1", toolName: name, args: {} });
    recorder.toolEnded({ toolCallId: "1", toolName: name, isError: false, result: text(value) });
    return recorder.pullRequests();
  };
  it("keeps only a succeeded result whose URL is the GitHub pull request it names", () => {
    expect(recorded("agentx_create_pull_request", { operationId: publishOperation, status: "SUCCEEDED", result: published })).toHaveLength(1);
    expect(recorded("agentx_create_pull_request", { operationId: publishOperation, status: "FAILED", result: published })).toEqual([]);
    expect(recorded("agentx_create_pull_request", { status: "SUCCEEDED", result: { ...published, url: "https://evil.example.com/acme/web/pull/42" } })).toEqual([]);
    expect(recorded("agentx_create_pull_request", { status: "SUCCEEDED", result: { ...published, number: 43 } })).toEqual([]);
    expect(recorded("agentx_create_pull_request", { status: "SUCCEEDED", result: { ...published, commit: "not-a-sha" } })).toEqual([]);
    expect(recorded("agentx_submit_task", { status: "SUCCEEDED", result: published })).toEqual([]);
  });
});
