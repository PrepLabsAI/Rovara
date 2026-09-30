// Spec 025 A9: usage per project, requester, origin or day, from worker usage items and Slack turn records.
import { describe, expect, it } from "vitest";
import { EMPTY_TURN_OBSERVATION, usageIndexKey } from "../../packages/contracts/src/index.js";
import { createAdminReadBroker } from "../support/admin-read-broker.js";

const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const usage = (at: string, n: number, extra: Record<string, unknown> = {}) => {
  const operationId = `1111111${n}-1111-4111-8111-111111111111`;
  return {
    ...usageIndexKey(at, operationId), entityType: "USAGE_INDEX", operationId, workspaceId: WORKSPACE, project: "payments", origin: "slack",
    requester: { kind: "slack", teamId: "T0BSHLLUGBD", userId: "U0PRIYA001" }, at, durationMs: 60_000, inputTokens: 1_000, outputTokens: 100, costUsd: 0.5, ...extra,
  };
};
const turn = (receivedAt: string, eventId: string, withUsage: boolean) => ({
  ...EMPTY_TURN_OBSERVATION, pk: "THREAD#T0BSHLLUGBD/C0123456789/1695500000.000100", sk: `TURN#${receivedAt}#${eventId}`, exportPk: "TURNS", exportSk: `${receivedAt}#${eventId}`,
  expiresAt: Math.floor(Date.now() / 1000) + 86_400, eventId, subject: "T0BSHLLUGBD/C0123456789/1695500000.000100", receivedAt,
  requestedBy: { teamId: "T0BSHLLUGBD", userId: "U0PRIYA001" }, workspaceId: WORKSPACE, disposition: "answered", startedAt: receivedAt, finishedAt: receivedAt,
  durationMs: 10, requestText: "hi", responseText: "hello",
  ...(withUsage ? { usage: { schemaVersion: 1, outcome: "SUCCEEDED", provider: "bedrock", modelId: "m", cacheRetention: "short", tokens: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, total: 55 }, cacheReadRatio: 0, costUsd: 0.01 } } : {}),
});

describe("GET /v1/admin/usage (FR-030, A9)", () => {
  it("adds up worker tasks and Slack turns per project", async () => {
    const { db, admin } = await createAdminReadBroker();
    const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    // The Slack turns name this workspace; its record gives them their project.
    db.set({ pk: `WORKSPACE#${WORKSPACE}`, sk: "META", projectName: "payments" });
    db.set(usage(at(1), 1));
    db.set(usage(at(2), 2, { costUsd: null }));
    db.set(usage(at(3), 3, { project: "ledger", origin: "ai_tool", requester: { kind: "developer", developerId: "d".repeat(64), provider: "slack", name: "Maya Chen" } }));
    db.set(turn(at(1), "EvTURN000001", true));
    db.set(turn(at(2), "EvTURN000002", false));
    const answer = await admin("GET", `/v1/admin/usage?group_by=project&since=${encodeURIComponent(at(24))}`);
    expect(answer.body.groups).toEqual([
      { key: "payments", turns: 2, tasks: 2, taskDurationMs: 120_000, inputTokens: 2_050, outputTokens: 205, costUsd: 0.51, costUnknown: 1 },
      { key: "ledger", turns: 0, tasks: 1, taskDurationMs: 60_000, inputTokens: 1_000, outputTokens: 100, costUsd: 0.5, costUnknown: 0 },
    ]);
    expect(answer.body.truncated).toBe(false);
  });

  it("groups by requester, origin and day", async () => {
    const { db, admin } = await createAdminReadBroker();
    const at = new Date(Date.now() - 3_600_000).toISOString();
    db.set(usage(at, 1));
    db.set(usage(at, 2, { origin: "ai_tool", requester: { kind: "developer", developerId: "d".repeat(64), provider: "slack", name: "Maya Chen" } }));
    const keys = async (groupBy: string) => ((await admin("GET", `/v1/admin/usage?group_by=${groupBy}`)).body.groups as Array<{ key: string }>).map((group) => group.key).sort();
    expect(await keys("requester")).toEqual(["developer:Maya Chen", "slack:U0PRIYA001"]);
    expect(await keys("origin")).toEqual(["ai_tool", "slack"]);
    expect(await keys("day")).toEqual([at.slice(0, 10)]);
  });

  it("needs group_by, and refuses an unknown one", async () => {
    const { admin } = await createAdminReadBroker();
    expect((await admin("GET", "/v1/admin/usage")).body.error).toEqual({ code: "CONFIG_INVALID", message: "group_by must be project, requester, origin or day" });
    expect((await admin("GET", "/v1/admin/usage?group_by=model")).body.error).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("reads at most 5,000 usage items across days, and says it stopped early", async () => {
    const { db, admin } = await createAdminReadBroker();
    const at = (hoursAgo: number, n: number) => new Date(Date.now() - hoursAgo * 3_600_000 - n).toISOString();
    for (let n = 0; n < 5_000; n += 1) {
      const item = usage(at(26, n), 0, { costUsd: 0 });
      const operationId = `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
      db.set({ ...item, ...usageIndexKey(String(item.at), operationId), operationId });
    }
    db.set(usage(at(1, 0), 9));
    const answer = await admin("GET", `/v1/admin/usage?group_by=project&since=${encodeURIComponent(at(30, 0))}`);
    expect((answer.body.groups as Array<{ tasks: number }>)[0]?.tasks).toBe(5_000);
    expect(answer.body.truncated).toBe(true);
  });
});
