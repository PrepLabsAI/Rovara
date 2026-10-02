import { describe, expect, it, onTestFinished, vi } from "vitest";
import { agentXError, type SlackRequestMessage, type SlackThreadWorkspaceResult } from "../../packages/contracts/src/index.js";
import { TurnRecordSchema, type TurnRecord } from "../../packages/contracts/src/turns.js";
import { processSlackRequest, type ProcessorDependencies, type TurnInput } from "../../packages/slack-service/src/processor.js";
import { DynamoTurnRecordWriter, TURN_ITEM_BYTE_BUDGET, fitTurnRecord } from "../../packages/slack-service/src/turn-records.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const conversationId = "33333333-3333-4333-8333-333333333333";
const token = "ghp_0123456789abcdefghijABCDEFGHIJ012345";
const message: SlackRequestMessage = {
  version: 1, eventId: "EvTURN00001", receivedAt: "2026-09-24T10:00:00.000Z", userId: "U0123456789",
  thread: { teamId: "T0123456789", channelId: "C0123456789", threadTs: "1695500000.000001" },
  text: `list open issues in demo, my token is ${token}`,
};
const workspace: SlackThreadWorkspaceResult = {
  outcome: "WORKSPACE", workspaceId, status: "READY", operationId: null, created: false,
  orchestratorInstructions: "Delegate coding.", settingsRevision: 2,
};

function harness(options: { runTurn?: (input: TurnInput) => Promise<string>; ensureError?: Error; write?: () => Promise<"written" | "duplicate"> } = {}) {
  const db = new FakeDynamoDb();
  const writer = new DynamoTurnRecordWriter(db as never, "turns");
  const posts: string[] = [];
  const logs: string[] = [];
  const dependencies: ProcessorDependencies = {
    api: () => ({
      ensureWorkspace: async () => { if (options.ensureError) throw options.ensureError; return workspace; },
      startClose: async () => ({ outcome: "NOT_FOUND" }),
      completeClose: vi.fn(), waitForOperation: vi.fn(),
      createConversation: async () => conversationId,
    }),
    threads: {
      load: async () => ({ workspaceId, conversationId, settingsRevision: 2 }),
      saveConversation: vi.fn(), saveSettingsRevision: vi.fn(), close: vi.fn(), finish: vi.fn(async () => undefined),
    },
    runTurn: options.runTurn ?? (async (input) => {
      input.recorder?.offer({ manifest: "m", tools: [{ name: "github__list_issues", description: "d" }], connectorOf: new Map([["github__list_issues", "github"]]), model: { provider: "p", modelId: "m" } });
      input.recorder?.toolStarted({ toolCallId: "c1", toolName: "github__list_issues", args: { state: "OPEN" } });
      input.recorder?.toolEnded({ toolCallId: "c1", toolName: "github__list_issues", isError: false,
        result: { content: [{ type: "text", text: JSON.stringify({ requestId: "r1", status: "SUCCEEDED", text: "[]", truncated: false, replayed: false }) }] } });
      input.recorder?.agentEnded([{ role: "assistant", content: [{ type: "text", text: "No open issues." }], stopReason: "stop" }]);
      return "No open issues.";
    }),
    post: async (_thread, text) => { posts.push(text); },
    log: (event, fields) => { logs.push(JSON.stringify({ event, ...fields })); },
    turnRecords: options.write ? { write: options.write } : writer,
  };
  const stored = () => db.find((item) => String(item.sk).startsWith("TURN#"));
  return { db, dependencies, posts, logs, stored };
}

describe("turn records from the Slack processor", () => {
  it("writes one record per finished event with identity, redacted text and what the orchestrator did", async () => {
    const { dependencies, stored } = harness();
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    const [item] = stored();
    expect(item).toMatchObject({
      pk: "THREAD#T0123456789/C0123456789/1695500000.000001",
      sk: "TURN#2026-09-24T10:00:00.000Z#EvTURN00001",
      exportPk: "TURNS", exportSk: "2026-09-24T10:00:00.000Z#EvTURN00001",
      expiresAt: Date.parse("2026-09-24T10:00:00.000Z") / 1000 + 30 * 86_400,
      eventId: "EvTURN00001", disposition: "answered", workspaceId, conversationId, settingsRevision: 2,
      requestedBy: { teamId: "T0123456789", userId: "U0123456789" },
      responseText: "No open issues.", emptyResponse: false, stopReason: "stop",
      calls: [expect.objectContaining({ name: "github__list_issues", connector: "github", validation: "ok", outcome: "SUCCEEDED", requestId: "r1" })],
    });
    expect(String(item?.requestText)).not.toContain(token);
    expect(String(item?.requestText)).toContain("list open issues in demo");
    const keys = new Set(["pk", "sk", "exportPk", "exportSk", "expiresAt"]);
    const record = Object.fromEntries(Object.entries(item!).filter(([key]) => !keys.has(key)));
    expect(TurnRecordSchema.safeParse(record).success).toBe(true);
  });

  it("writes one record across a redelivery", async () => {
    const { dependencies, stored, logs } = harness();
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    expect(stored()).toHaveLength(1);
    expect(logs.filter((line) => line.includes("turn_record.duplicate"))).toHaveLength(1);
  });

  it("writes nothing for a non-final failed attempt, and one record when the final attempt abandons", async () => {
    const failure = Object.assign(new Error("broker down"), { name: "TypeError" });
    const { dependencies, stored } = harness({ ensureError: failure });
    await expect(processSlackRequest(message, dependencies, { finalAttempt: false })).rejects.toThrow("broker down");
    expect(stored()).toHaveLength(0);
    await processSlackRequest(message, dependencies, { finalAttempt: true });
    expect(stored()).toHaveLength(1);
    expect(stored()[0]).toMatchObject({ disposition: "abandoned", error: { name: "TypeError" }, calls: [], offeredTools: [] });
  });

  it("records a failed turn with its error class and code, and the reply the member saw", async () => {
    const { dependencies, stored } = harness({ runTurn: async () => { throw agentXError("RUNTIME_UNAVAILABLE", "model down"); } });
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    expect(stored()[0]).toMatchObject({ disposition: "failed", error: { name: "AgentXError", code: "RUNTIME_UNAVAILABLE" } });
    expect(String(stored()[0]?.responseText)).toContain("AgentX could not complete the request");
  });

  it("records a workspace-close command that never reached the orchestrator", async () => {
    const { dependencies, stored } = harness();
    await processSlackRequest({ ...message, eventId: "EvTURN00002", text: "<@U0BOT00001> close this workspace" }, dependencies, { finalAttempt: false });
    expect(stored()[0]).toMatchObject({ disposition: "workspace_close", responseText: "This thread does not have a workspace to close." });
  });

  it("never writes request or response text to a log line", async () => {
    const { dependencies, logs } = harness();
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    for (const line of logs) {
      expect(line).not.toContain("list open issues");
      expect(line).not.toContain("No open issues.");
      expect(line).not.toContain(token);
    }
  });

  it("keeps the reply when the write fails and reports it", async () => {
    const throttled = Object.assign(new Error("slow down"), { name: "ProvisionedThroughputExceededException" });
    const { dependencies, posts, logs } = harness({ write: async () => { throw throttled; } });
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    expect(posts.at(-1)).toBe("No open issues.");
    expect(logs).toContain(JSON.stringify({ event: "turn_record.write_failed", eventId: "EvTURN00001", errorName: "ProvisionedThroughputExceededException" }));
    expect(logs).toContain(JSON.stringify({ event: "metric", metric: "TurnRecordWriteFailed", count: 1 }));
    // A write failure still built a record, so the turn itself is still counted.
    expect(logs).toContain(JSON.stringify({ event: "metric", metric: "TurnCompleted", count: 1 }));
  });
});

describe("turn record failures and pass-through", () => {
  it("reports a record that fails the schema as a write failure and keeps the reply", async () => {
    const { dependencies, posts, logs, stored } = harness({
      runTurn: async (input) => {
        // A tool name past the contract's 128 characters makes the record fail TurnRecordSchema.
        input.recorder?.offer({ manifest: "m", tools: [{ name: "x".repeat(200), description: "d" }], connectorOf: new Map(), model: { provider: "p", modelId: "m" } });
        return "No open issues.";
      },
    });
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    expect(posts.at(-1)).toBe("No open issues.");
    expect(stored()).toHaveLength(0);
    expect(logs).toContain(JSON.stringify({ event: "turn_record.write_failed", eventId: "EvTURN00001", errorName: "ZodError" }));
    expect(logs).toContain(JSON.stringify({ event: "metric", metric: "TurnRecordWriteFailed", count: 1 }));
    // A record that never built has nothing to derive turn metrics from.
    expect(logs.filter((line) => line.includes("\"event\":\"metric\""))).toEqual([JSON.stringify({ event: "metric", metric: "TurnRecordWriteFailed", count: 1 })]);
  });

  it("passes recording errors from the observation into the record and never logs them", async () => {
    const { dependencies, stored, logs } = harness({
      runTurn: async (input) => {
        input.recorder?.recordingFailed("handler_failed:agent_end");
        return "No open issues.";
      },
    });
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    expect(stored()[0]).toMatchObject({ recordingErrors: ["handler_failed:agent_end"] });
    for (const line of logs) expect(line).not.toContain("handler_failed");
  });

  it("redacts a credential in failure text before it reaches the record", async () => {
    const { dependencies, stored } = harness({ runTurn: async () => { throw new Error(`upstream rejected ${token}`); } });
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    expect(stored()[0]).toMatchObject({ disposition: "failed", error: { name: "Error" } });
    expect(String(stored()[0]?.responseText)).toContain("upstream rejected");
    expect(String(stored()[0]?.responseText)).not.toContain(token);
  });

  it("records the abandonment notice, not the unposted answer, when posting the answer fails on the final attempt", async () => {
    const { dependencies, stored } = harness();
    const post = dependencies.post;
    dependencies.post = async (thread, text) => {
      if (text === "No open issues.") throw Object.assign(new Error("slack down"), { name: "SlackPostError" });
      await post(thread, text);
    };
    await processSlackRequest(message, dependencies, { finalAttempt: true });
    expect(stored()[0]).toMatchObject({ disposition: "abandoned", error: { name: "SlackPostError" } });
    expect(String(stored()[0]?.responseText)).toContain("AgentX could not process this request");
  });

  it("records only a notice that was posted when the abandonment notice also fails to post", async () => {
    const { dependencies, stored } = harness();
    const post = dependencies.post;
    dependencies.post = async (thread, text) => {
      if (text === "No open issues." || text.startsWith("AgentX could not process")) throw Object.assign(new Error("slack down"), { name: "SlackPostError" });
      await post(thread, text);
    };
    await processSlackRequest(message, dependencies, { finalAttempt: true });
    expect(stored()[0]).toMatchObject({ disposition: "abandoned" });
    expect(String(stored()[0]?.responseText)).not.toContain("AgentX could not process");
    expect(stored()[0]?.responseText).toBe("Working on it now. I'll post the result in this thread when it's done.");
  });

  it("gives up on a write that never finishes, reports it and still finishes the thread", async () => {
    const { dependencies, posts, logs } = harness();
    const finish = vi.fn(async () => undefined);
    dependencies.threads = { ...dependencies.threads, finish };
    // A client that only settles when its abort signal fires, like a hung DynamoDB request.
    const hung = { send: (_command: unknown, options?: { abortSignal?: AbortSignal }) => new Promise((_resolve, reject) => {
      options?.abortSignal?.addEventListener("abort", () => { reject(options.abortSignal?.reason as Error); });
    }) };
    dependencies.turnRecords = new DynamoTurnRecordWriter(hung as never, "turns", 20);
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    expect(posts.at(-1)).toBe("No open issues.");
    expect(logs).toContain(JSON.stringify({ event: "turn_record.write_failed", eventId: "EvTURN00001", errorName: "TimeoutError" }));
    expect(logs).toContain(JSON.stringify({ event: "metric", metric: "TurnRecordWriteFailed", count: 1 }));
    // A write that times out still built a record, so the turn itself is still counted.
    expect(logs).toContain(JSON.stringify({ event: "metric", metric: "TurnCompleted", count: 1 }));
    expect(finish).toHaveBeenCalledOnce();
  });

  it("hands runTurn a recorder for the check report, and replies with the model's text alone, when no turn-record sink is configured", async () => {
    const inputs: TurnInput[] = [];
    const { dependencies, posts } = harness({ runTurn: async (input) => { inputs.push(input); return "No open issues."; } });
    const withoutSink: ProcessorDependencies = { ...dependencies };
    delete withoutSink.turnRecords;
    await processSlackRequest(message, withoutSink, { finalAttempt: false });
    // Spec 051 FR-009: the recorder carries the turn's check reports; with none, the reply is unchanged.
    expect(inputs[0]).toHaveProperty("recorder");
    expect(posts.at(-1)).toBe("No open issues.");
  });
});

describe("turn record size", () => {
  it("never stores the export-only project field", async () => {
    const db = new FakeDynamoDb();
    const record: TurnRecord = {
      offeredTools: [], calls: [], emptyResponse: false, workerOperations: [], project: "demo",
      eventId: "EvTURN00004", subject: "T0123456789/C0123456789/1695500000.000001", receivedAt: "2026-09-24T10:00:00.000Z",
      requestedBy: { teamId: "T0123456789", userId: "U0123456789" }, disposition: "answered",
      startedAt: "2026-09-24T10:00:00.000Z", finishedAt: "2026-09-24T10:00:01.000Z", durationMs: 1_000,
      requestText: "hi", responseText: "hello",
    };
    expect(await new DynamoTurnRecordWriter(db as never, "turns").write(record)).toBe("written");
    expect(db.find(() => true)[0]).not.toHaveProperty("project");
  });
  it("fits an oversized record under the item limit", async () => {
    // "€" is one UTF-16 unit and three UTF-8 bytes, the most bytes per counted character.
    const call = { name: "agentx_submit_task", arguments: "€".repeat(2_048), argumentsFingerprint: "b".repeat(32), validation: "ok" as const, outcome: "SUCCEEDED" as const, durationMs: 1 };
    const record: TurnRecord = {
      offeredTools: [], calls: Array.from({ length: 50 }, () => call), emptyResponse: false, workerOperations: [],
      eventId: "EvTURN00003", subject: "T0123456789/C0123456789/1695500000.000001", receivedAt: "2026-09-24T10:00:00.000Z",
      requestedBy: { teamId: "T0123456789", userId: "U0123456789" }, disposition: "answered",
      startedAt: "2026-09-24T10:00:00.000Z", finishedAt: "2026-09-24T10:00:01.000Z", durationMs: 1_000,
      requestText: "€".repeat(40_000), responseText: "€".repeat(40_000),
    };
    expect(Buffer.byteLength(JSON.stringify(record))).toBeGreaterThan(TURN_ITEM_BYTE_BUDGET);
    const fitted = fitTurnRecord(record);
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(TURN_ITEM_BYTE_BUDGET);
    expect(fitted.textTruncated).toBe(true);
    expect(TurnRecordSchema.safeParse(fitted).success).toBe(true);
    const db = new FakeDynamoDb();
    expect(await new DynamoTurnRecordWriter(db as never, "turns").write(record)).toBe("written");
    expect(Buffer.byteLength(JSON.stringify(db.find(() => true)[0]))).toBeLessThanOrEqual(TURN_ITEM_BYTE_BUDGET + 512);
  });
});

describe("turn metrics", () => {
  it("emits the Slack service metrics once per written record, never for a duplicate", async () => {
    // The turn's start and finish times come from new Date(); a frozen clock makes TurnDurationMs 0 on
    // every machine instead of only on a fast one.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-29T05:00:00Z") });
    onTestFinished(() => { vi.useRealTimers(); });
    const { dependencies, logs } = harness({
      runTurn: async (input) => {
        input.recorder?.offer({ manifest: "m", tools: [], connectorOf: new Map([["github__list_issues", "github"]]), model: { provider: "p", modelId: "m" } });
        input.recorder?.toolStarted({ toolCallId: "1", toolName: "github__list_issues", args: {} });
        input.recorder?.toolEnded({ toolCallId: "1", toolName: "github__list_issues", isError: true, result: { content: [{ type: "text", text: "Validation failed for tool \"github__list_issues\"" }] } });
        input.recorder?.toolStarted({ toolCallId: "2", toolName: "agentx_submit_task", args: {} });
        input.recorder?.toolEnded({ toolCallId: "2", toolName: "agentx_submit_task", isError: true, result: { content: [{ type: "text", text: "Validation failed for tool \"agentx_submit_task\"" }] } });
        input.recorder?.toolStarted({ toolCallId: "3", toolName: "agentx_sync_pull_request", args: {} });
        input.recorder?.toolEnded({ toolCallId: "3", toolName: "agentx_sync_pull_request", isError: true, result: { content: [{ type: "text", text: "Tool agentx_sync_pull_request not found" }] } });
        input.recorder?.agentEnded([{ role: "assistant", content: [], stopReason: "stop" }]);
        // Real time passes during the turn; only the frozen Date keeps the duration at 0.
        await new Promise((resolve) => { setTimeout(resolve, 5); });
        return "AgentX completed the request without returning a textual response.";
      },
    });
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    const metricLines = logs.filter((line) => line.includes("\"event\":\"metric\"")).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(metricLines).toEqual([
      { event: "metric", metric: "TurnCompleted", count: 1 },
      // FR-045's slow-turn alarm (spec 015 phase 15d2): every answered or failed turn reports its duration.
      { event: "metric", metric: "TurnDurationMs", count: 0 },
      { event: "metric", metric: "TurnEmptyResponse", count: 1 },
      { event: "metric", metric: "ToolSchemaError", connector: "github", count: 1 },
      { event: "metric", metric: "ToolSchemaError", connector: "agentx", count: 1 },
      { event: "metric", metric: "ToolUnknownName", count: 1 },
    ]);
  });

  it("does not count a workspace command as a completed turn", async () => {
    const { dependencies, logs } = harness();
    await processSlackRequest({ ...message, eventId: "EvTURN00004", text: "close this workspace" }, dependencies, { finalAttempt: false });
    expect(logs.filter((line) => line.includes("\"event\":\"metric\""))).toEqual([]);
  });

  it("reports a metrics-emission failure on its own event, never mislabelled as a write failure", async () => {
    const { dependencies, logs } = harness();
    dependencies.log = (event, fields) => {
      if (event === "metric") throw new Error("logger down");
      logs.push(JSON.stringify({ event, ...fields }));
    };
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    expect(logs.some((line) => line.includes("turn_record.write_failed"))).toBe(false);
    const parsed = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed).toContainEqual({ event: "turn_metrics.emit_failed", eventId: "EvTURN00001", errorName: "Error" });
  });

  it("never lets a logging failure inside recordTurn escape processSlackRequest", async () => {
    // The write fails, and once it does, every subsequent log call also fails (a broken logger
    // during the same incident): recordTurn must still resolve, so the reply stands and the thread
    // still finishes, rather than escaping to a redelivery that would post the reply again.
    let throwFromLog = false;
    const { dependencies, posts } = harness({
      write: async () => {
        throwFromLog = true;
        throw Object.assign(new Error("slow down"), { name: "ProvisionedThroughputExceededException" });
      },
    });
    const finish = vi.fn(async () => undefined);
    dependencies.threads = { ...dependencies.threads, finish };
    dependencies.log = (event, fields) => {
      if (throwFromLog) throw new Error("logger down");
      void event; void fields;
    };
    await expect(processSlackRequest(message, dependencies, { finalAttempt: false })).resolves.toBeUndefined();
    expect(posts.filter((text) => text === "No open issues.")).toHaveLength(1);
    expect(finish).toHaveBeenCalledOnce();
  });
});

describe("turn record fitting flags", () => {
  it("marks omitted call arguments with argumentsOmitted and keeps callsTruncated for more than 50 calls only", () => {
    const call = { name: "agentx_submit_task", arguments: "€".repeat(2_048), argumentsFingerprint: "b".repeat(32), validation: "ok" as const, outcome: "SUCCEEDED" as const, durationMs: 1 };
    const record: TurnRecord = {
      offeredTools: [], calls: Array.from({ length: 50 }, () => call), emptyResponse: false, workerOperations: [],
      eventId: "EvTURN00004", subject: "T0123456789/C0123456789/1695500000.000001", receivedAt: "2026-09-24T10:00:00.000Z",
      requestedBy: { teamId: "T0123456789", userId: "U0123456789" }, disposition: "answered",
      startedAt: "2026-09-24T10:00:00.000Z", finishedAt: "2026-09-24T10:00:01.000Z", durationMs: 1_000,
      requestText: "list issues", responseText: "none",
    };
    const fitted = fitTurnRecord(record, 100_000);
    expect(fitted.calls.every((fittedCall) => fittedCall.arguments === "[omitted]")).toBe(true);
    expect(fitted.argumentsOmitted).toBe(true);
    expect(fitted).not.toHaveProperty("callsTruncated");
    expect(TurnRecordSchema.safeParse(fitted).success).toBe(true);
  });

  it("still reads an older record that has no argumentsOmitted field", () => {
    const older = {
      offeredTools: [], calls: [], callsTruncated: true, emptyResponse: false, workerOperations: [],
      eventId: "EvTURN00005", subject: "T0123456789/C0123456789/1695500000.000001", receivedAt: "2026-09-24T10:00:00.000Z",
      requestedBy: { teamId: "T0123456789", userId: "U0123456789" }, disposition: "answered",
      startedAt: "2026-09-24T10:00:00.000Z", finishedAt: "2026-09-24T10:00:01.000Z", durationMs: 1_000,
      requestText: "list issues", responseText: "none",
    };
    expect(TurnRecordSchema.safeParse(older).success).toBe(true);
  });
});

describe("turn record duplicate log", () => {
  it("never reports a failure to log a duplicate as a write failure", async () => {
    const { dependencies, logs } = harness({ write: async () => "duplicate" });
    const finish = vi.fn(async () => undefined);
    dependencies.threads.finish = finish;
    dependencies.log = (event, fields) => {
      if (event === "turn_record.duplicate") throw new Error("logger down");
      logs.push(JSON.stringify({ event, ...fields }));
    };
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    expect(logs.some((line) => line.includes("turn_record.write_failed"))).toBe(false);
    expect(logs.some((line) => line.includes("TurnRecordWriteFailed"))).toBe(false);
    // A duplicate still skips turn metrics.
    expect(logs.filter((line) => line.includes("\"event\":\"metric\""))).toEqual([]);
    expect(finish).toHaveBeenCalledTimes(1);
  });
});

describe("turn records keep the reply as posted in Slack formatting (spec 014 FR-022)", () => {
  it("records the formatted reply the member saw, not the model's Markdown", async () => {
    const { dependencies, posts, stored } = harness({ runTurn: async () => "Created [CHA-6](https://linear.app/x/issue/CHA-6).\\nNothing else changed." });
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    expect(posts.at(-1)).toBe("Created <https://linear.app/x/issue/CHA-6|CHA-6>.\nNothing else changed.");
    expect(stored()[0]?.responseText).toBe(posts.at(-1));
  });

  it("records the last formatted chunk that reached Slack when a later post fails on the final attempt", async () => {
    const { dependencies, stored } = harness({ runTurn: async () => "**Step** done.\\n".repeat(400) });
    const post = dependencies.post;
    let replies = 0;
    dependencies.post = async (thread, text) => {
      if (text.startsWith("*Step*") && ++replies > 1) throw Object.assign(new Error("slack down"), { name: "SlackPostError" });
      if (text.startsWith("AgentX could not process")) throw Object.assign(new Error("slack down"), { name: "SlackPostError" });
      await post(thread, text);
    };
    await processSlackRequest(message, dependencies, { finalAttempt: true });
    const recorded = String(stored()[0]?.responseText);
    expect(stored()[0]).toMatchObject({ disposition: "abandoned" });
    expect(recorded.startsWith("*Step* done.\n*Step* done.")).toBe(true);
    expect(recorded).not.toContain("**");
    expect(recorded).not.toContain("\\n");
  });
});
