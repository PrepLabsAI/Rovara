import { describe, expect, it, vi } from "vitest";
import {
  CONFIRMATION_TTL_MS,
  TURN_ARGUMENT_LIMIT,
  TURN_CALL_LIMIT,
  TURN_GATE_REASON_LIMIT,
  TURN_TEXT_LIMIT,
  TurnRecordSchema,
  EMPTY_TURN_OBSERVATION,
  type SlackRequestMessage,
  type SlackThreadWorkspaceResult,
  type TurnRecord,
} from "../../packages/contracts/src/index.js";
import { TurnRecordExport } from "../../packages/broker/src/aws/turns.js";
import { createDynamoConfirmationStore } from "../../packages/slack-service/src/confirmation-store.js";
import { processSlackRequest, type ProcessorDependencies, type TurnInput } from "../../packages/slack-service/src/processor.js";
import { DynamoTurnRecordWriter, TURN_ITEM_BYTE_BUDGET, fitTurnRecord } from "../../packages/slack-service/src/turn-records.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };
const subject = "T0BSHLLUGBD/C0123456789/1695500000.000001";
const requester = "U0123456789";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const start = Date.parse("2026-09-25T10:00:00.000Z");

function slackMessage(eventId: string, text: string, overrides: Partial<SlackRequestMessage> = {}): SlackRequestMessage {
  return { version: 1, eventId, thread, userId: requester, text, receivedAt: new Date(start).toISOString(), ...overrides };
}

/** The processor with a real confirmation store and a real turn record writer over one fake table. */
function harness(turn: (input: TurnInput) => Promise<string>) {
  const db = new FakeDynamoDb();
  const posts: string[] = [];
  const logs: Array<{ event: string; fields: Readonly<Record<string, string | number | boolean>> }> = [];
  const confirmations = createDynamoConfirmationStore(db, "threads", () => start + 60_000);
  const ensureWorkspace = vi.fn(async (): Promise<SlackThreadWorkspaceResult> => ({
    outcome: "WORKSPACE", workspaceId, status: "READY", operationId: null, created: false, orchestratorInstructions: "Delegate.",
  }));
  const dependencies: ProcessorDependencies = {
    api: () => ({ ensureWorkspace, createConversation: async () => "33333333-3333-4333-8333-333333333333", waitForOperation: vi.fn(), startClose: vi.fn(), completeClose: vi.fn() }),
    threads: { load: async () => ({ workspaceId, conversationId: "33333333-3333-4333-8333-333333333333" }), saveConversation: vi.fn(), saveSettingsRevision: vi.fn(), close: vi.fn(), finish: vi.fn(async () => undefined) },
    runTurn: turn,
    post: async (_thread, text) => { posts.push(text); },
    postConfirmation: vi.fn(async () => undefined),
    confirmations,
    now: () => start + 60_000,
    log: (event, fields) => { logs.push({ event, fields }); },
    turnRecords: new DynamoTurnRecordWriter(db as never, "turns"),
  };
  const stored = () => db.find((item) => String(item.sk).startsWith("TURN#"));
  const pending = () => confirmations.save(subject, {
    confirmationId: "44444444-4444-5444-8444-444444444444", requesterId: requester, postedAt: new Date(start - 1_000).toISOString(),
    expiresAt: new Date(start + CONFIRMATION_TTL_MS).toISOString(), calls: [{ tool: "tracker__close_item", argumentsHash: "a".repeat(64), summary: "close", kind: "destructive" }],
  });
  return { posts, logs, stored, confirmations, dependencies, pending };
}

describe("turns that stop because a confirmation was refused (spec 014 FR-021)", () => {
  it("records a yes from another member as confirmation_refused, not abandoned, and counts no completed turn", async () => {
    const turn = vi.fn(async () => "unused");
    const { posts, logs, stored, dependencies, pending } = harness(turn);
    await pending();
    await processSlackRequest(slackMessage("EvGATEREF001", "yes", { userId: "U0456789012", receivedAt: new Date(start + 60_000).toISOString() }), dependencies, { finalAttempt: false });
    expect(turn).not.toHaveBeenCalled();
    expect(stored()).toHaveLength(1);
    expect(stored()[0]).toMatchObject({ disposition: "confirmation_refused", responseText: posts.at(-1), calls: [] });
    expect(stored()[0]).not.toHaveProperty("error");
    expect(logs.filter((line) => line.event === "metric")).toEqual([]);
  });

  it("records a claim refused between the check and the turn as confirmation_refused", async () => {
    const turn = vi.fn(async () => "unused");
    const { posts, stored, dependencies, pending, confirmations } = harness(turn);
    await pending();
    const claim = confirmations.claim.bind(confirmations);
    confirmations.claim = async (claimSubject, id, eventId) => {
      await claim(claimSubject, id, "EvGATEOTHER01");
      return claim(claimSubject, id, eventId);
    };
    await processSlackRequest(slackMessage("EvGATEREF002", "yes", { receivedAt: new Date(start + 60_000).toISOString() }), dependencies, { finalAttempt: false });
    expect(turn).not.toHaveBeenCalled();
    expect(posts.at(-1)).toBe("That confirmation was already used, so nothing was run. Ask me again if you still want it.");
    expect(stored()[0]).toMatchObject({ disposition: "confirmation_refused", responseText: posts.at(-1) });
  });

  it("M3: records a cancel as confirmation_cancelled, not abandoned, and counts no completed turn", async () => {
    const turn = vi.fn(async () => "unused");
    const { posts, logs, stored, dependencies, pending } = harness(turn);
    await pending();
    await processSlackRequest(slackMessage("EvGATEREF003", "cancel", { receivedAt: new Date(start + 60_000).toISOString() }), dependencies, { finalAttempt: false });
    expect(turn).not.toHaveBeenCalled();
    expect(posts.at(-1)).toBe("Cancelled. Nothing was run.");
    expect(stored()[0]).toMatchObject({ disposition: "confirmation_cancelled", responseText: posts.at(-1), calls: [] });
    expect(stored()[0]).not.toHaveProperty("error");
    expect(logs.filter((line) => line.event === "metric")).toEqual([]);
  });

  it("M3: records a lone yes to all as yes_to_all_granted, not abandoned, and counts no completed turn", async () => {
    const turn = vi.fn(async () => "unused");
    const { posts, logs, stored, dependencies } = harness(turn);
    await processSlackRequest(slackMessage("EvGATEREF004", "yes to all in this thread", { receivedAt: new Date(start + 60_000).toISOString() }), dependencies, { finalAttempt: false });
    expect(turn).not.toHaveBeenCalled();
    expect(stored()[0]).toMatchObject({ disposition: "yes_to_all_granted", responseText: posts.at(-1), calls: [] });
    expect(logs.filter((line) => line.event === "metric")).toEqual([]);
  });

  it("records the model's reply and an answered disposition for a turn whose confirmation was its only post", async () => {
    const reply = "I have asked you in the Slack thread to confirm closing TRK-9.";
    const { posts, stored, dependencies } = harness(async (input) => {
      input.gate!.asks.push({ toolCallId: "c1", tool: "tracker__close_item", argumentsHash: "b".repeat(64), summary: "close", kind: "destructive" });
      return reply;
    });
    await processSlackRequest(slackMessage("EvGATEQUIET1", "close TRK-9", { receivedAt: new Date(start + 60_000).toISOString() }), dependencies, { finalAttempt: false, queuedBehind: 0 });
    expect(dependencies.postConfirmation).toHaveBeenCalledOnce();
    expect(posts).toEqual([]);
    expect(stored()).toHaveLength(1);
    expect(stored()[0]).toMatchObject({ disposition: "answered", responseText: reply });
  });

  it("keeps every other disposition an older record used", () => {
    for (const disposition of ["answered", "failed", "abandoned", "workspace_close", "workspace_limit", "workspace_closed", "workspace_unavailable", "confirmation_refused",
      "confirmation_cancelled", "yes_to_all_granted"]) {
      expect(TurnRecordSchema.shape.disposition.safeParse(disposition).success, disposition).toBe(true);
    }
  });
});

const receivedAt = "2026-09-25T10:00:00.000Z";
function record(eventId: string, extra: Partial<TurnRecord> = {}): TurnRecord {
  return {
    ...EMPTY_TURN_OBSERVATION, eventId, subject, receivedAt, requestedBy: { teamId: thread.teamId, userId: requester }, disposition: "answered", workspaceId,
    startedAt: receivedAt, finishedAt: receivedAt, durationMs: 0, requestText: "close TRK-9", responseText: "done", ...extra,
  };
}
const call = { name: "tracker__close_item", connector: "tracker", arguments: "{\"id\":\"TRK-9\"}", argumentsFingerprint: "a".repeat(32), validation: "ok", outcome: "FAILED", durationMs: 3 } as const;
const gate = { outcome: "ask", source: "default", kind: "destructive", reason: "the tool's name says \"close\"; destructive actions always ask" } as const;

describe("gate decisions in stored and exported turn records (spec 014 FR-021)", () => {
  it("exports a record written before the gate and one with decisions side by side, skipping neither", async () => {
    const keys = (item: TurnRecord) => ({ pk: `THREAD#${subject}`, sk: `TURN#${item.receivedAt}#${item.eventId}`, exportPk: "TURNS", exportSk: `${item.receivedAt}#${item.eventId}`, expiresAt: Date.parse(item.receivedAt) / 1000 + 86_400 });
    const older = record("EvGATEOLD001", { calls: [call] });
    const newer = record("EvGATENEW001", { calls: [{ ...call, gate }, { ...call, name: "tracker__list_items", outcome: "SUCCEEDED", gate: { outcome: "allow", source: "default", kind: "read", reason: "reads run without asking" } }] });
    const log = vi.fn();
    const exporter = new TurnRecordExport({ source: { page: async () => ({ items: [{ ...keys(newer), ...newer }, { ...keys(older), ...older }] }) }, projectOf: async () => "payments", now: () => start, log });
    const page = await exporter.page(new URLSearchParams({ since: "2026-09-24T00:00:00Z" }));
    expect(page).not.toHaveProperty("skipped");
    expect(log).not.toHaveBeenCalled();
    expect(page.turns.map((turn) => turn.calls.map((entry) => entry.gate))).toEqual([
      [gate, { outcome: "allow", source: "default", kind: "read", reason: "reads run without asking" }],
      [undefined],
    ]);
    expect(page.turns[1]!.calls[0]).not.toHaveProperty("gate");
  });

  it("fits a record with every call decided, the longest reasons and texts, under the storage budget and keeps each decision", () => {
    const longest = record("EvGATEBIG001", {
      requestText: "€".repeat(TURN_TEXT_LIMIT), responseText: "€".repeat(TURN_TEXT_LIMIT),
      calls: Array.from({ length: TURN_CALL_LIMIT }, () => ({ ...call, arguments: "€".repeat(TURN_ARGUMENT_LIMIT), gate: { ...gate, rule: "999", reason: "€".repeat(TURN_GATE_REASON_LIMIT) } })),
    });
    expect(TurnRecordSchema.safeParse(longest).success).toBe(true);
    const fitted = fitTurnRecord(longest);
    expect(Buffer.byteLength(JSON.stringify(fitted), "utf8")).toBeLessThanOrEqual(TURN_ITEM_BYTE_BUDGET);
    expect(TurnRecordSchema.parse(fitted).calls.every((entry) => entry.gate?.reason.length === TURN_GATE_REASON_LIMIT)).toBe(true);
  });
});
