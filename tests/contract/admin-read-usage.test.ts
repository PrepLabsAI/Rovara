// Spec 025 A9: usage per project, requester, origin or day, from worker usage items and Slack turn records.
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it.each([
    { input: 3, cacheRead: 900, cacheWrite: 70, expected: 973 },
    { input: 0, cacheRead: 900, cacheWrite: 0, expected: 900 },
    { input: 0, cacheRead: 0, cacheWrite: 70, expected: 70 },
    { input: 3, cacheRead: 0, cacheWrite: 0, expected: 3 },
  ])("includes cached input once for a Slack turn: $input/$cacheRead/$cacheWrite", async ({ input, cacheRead, cacheWrite, expected }) => {
    const { db, admin } = await createAdminReadBroker();
    const at = new Date(Date.now() - 3_600_000).toISOString();
    const record = turn(at, "EvCACHE000001", true);
    db.set({ ...record, usage: { ...record.usage, tokens: { input, output: 5, cacheRead, cacheWrite, total: expected + 5 } } });
    const answer = await admin("GET", "/v1/admin/usage?group_by=origin");
    expect(answer.body.groups).toEqual([
      { key: "slack", turns: 1, tasks: 0, taskDurationMs: 0, inputTokens: expected, outputTokens: 5, costUsd: 0.01, costUnknown: 0 },
    ]);
  });

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
    expect(await keys("requester")).toEqual(["developer:Maya Chen (dddddddd)", "slack:U0PRIYA001"]);
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

  // Fix round 1 (review of Tasks 8 and 9).
  const hoursAgo = (hours: number, ms = 0) => new Date(Date.now() - hours * 3_600_000 - ms).toISOString();
  const logged = () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    return () => spy.mock.calls.map((call) => String(call[0]));
  };
  afterEach(() => vi.restoreAllMocks());

  it("counts a turn whose usage no longer parses as cost unknown, and logs it by ID only", async () => {
    const { db, admin } = await createAdminReadBroker();
    db.set({ ...turn(hoursAgo(1), "EvTURN000009", true), usage: { schemaVersion: 1, outcome: "SUCCEEDED", costUsd: "a lot" } });
    const lines = logged();
    const answer = await admin("GET", "/v1/admin/usage?group_by=requester");
    expect(answer.body.groups).toEqual([{ key: "slack:U0PRIYA001", turns: 1, tasks: 0, taskDurationMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, costUnknown: 1 }]);
    const line = lines().find((entry) => entry.includes("admin.usage_unreadable"));
    expect(line).toBeDefined();
    expect(line).toContain("EvTURN000009");
    expect(line).not.toContain("hello");
    expect(line).not.toContain("a lot");
  });

  it("counts and logs a usage item that no longer parses, and skips an expired one", async () => {
    const { db, admin } = await createAdminReadBroker();
    db.set(usage(hoursAgo(1), 1, { durationMs: -1 }));
    db.set(usage(hoursAgo(2), 2, { indexExpiresAt: Math.floor(Date.now() / 1000) - 60 }));
    db.set(usage(hoursAgo(3), 3, { indexExpiresAt: Math.floor(Date.now() / 1000) + 86_400 }));
    const lines = logged();
    const answer = await admin("GET", "/v1/admin/usage?group_by=project");
    expect(answer.body.groups).toEqual([{ key: "payments", turns: 0, tasks: 1, taskDurationMs: 60_000, inputTokens: 1_000, outputTokens: 100, costUsd: 0.5, costUnknown: 0 }]);
    expect(answer.body.skipped).toBe(1);
    expect(lines().some((entry) => entry.includes("admin.usage_index_unreadable") && entry.includes("\"count\":1"))).toBe(true);
  });

  it("puts a turn without a workspace under project unknown, and groups turns by requester and day", async () => {
    const { db, admin } = await createAdminReadBroker();
    db.set({ pk: `WORKSPACE#${WORKSPACE}`, sk: "META", projectName: "payments" });
    const [first, second] = [hoursAgo(1), hoursAgo(2)];
    const orphan: Record<string, unknown> = turn(first, "EvTURN000011", true);
    delete orphan.workspaceId;
    db.set(orphan);
    db.set(turn(second, "EvTURN000012", false));
    const groups = async (groupBy: string) => ((await admin("GET", `/v1/admin/usage?group_by=${groupBy}`)).body.groups as Array<{ key: string; turns: number }>)
      .map((group) => [group.key, group.turns]);
    expect(await groups("project")).toEqual([["unknown", 1], ["payments", 1]]);
    expect(await groups("requester")).toEqual([["slack:U0PRIYA001", 2]]);
    const days = new Map<string, number>();
    for (const at of [first, second]) days.set(at.slice(0, 10), (days.get(at.slice(0, 10)) ?? 0) + 1);
    expect((await groups("day")).sort()).toEqual([...days].sort());
  });

  it("redacts a token-shaped developer name in the requester key (A16)", async () => {
    const { db, admin } = await createAdminReadBroker();
    const planted = `xoxb-${"1".repeat(12)}-${"2".repeat(13)}-${"a".repeat(24)}`;
    db.set(usage(hoursAgo(1), 1, { origin: "ai_tool", requester: { kind: "developer", developerId: "d".repeat(64), provider: "slack", name: planted } }));
    const answer = await admin("GET", "/v1/admin/usage?group_by=requester");
    expect(JSON.stringify(answer.body)).not.toContain(planted);
    expect((answer.body.groups as Array<{ key: string }>)[0]?.key).toContain("[REDACTED]");
  });

  it("reads at most 5,000 usage items, counting the ones that no longer parse", async () => {
    const { db, admin } = await createAdminReadBroker();
    for (let n = 0; n < 5_050; n += 1) {
      // The 50 oldest no longer parse; the read goes oldest first, so they count toward the cap.
      const item = usage(hoursAgo(1, n), 0, n >= 5_000 ? { durationMs: -1 } : {});
      const operationId = `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
      db.set({ ...item, ...usageIndexKey(String(item.at), operationId), operationId });
    }
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const answer = await admin("GET", `/v1/admin/usage?group_by=project&since=${encodeURIComponent(hoursAgo(26))}`);
    const tasks = (answer.body.groups as Array<{ tasks: number }>).reduce((sum, group) => sum + group.tasks, 0);
    expect(tasks).toBe(4_950);
    expect(answer.body.skipped).toBe(50);
    expect(answer.body.truncated).toBe(true);
  });

  it("reads at most 5,000 Slack turn records, exactly", async () => {
    const { db, admin } = await createAdminReadBroker();
    // 50 AI-tool records among the newest make the filtered pages uneven, so a page-sized cap would overshoot.
    for (let n = 0; n < 5_051; n += 1) {
      const eventId = `EvCAP${n.toString().padStart(7, "0")}`;
      const record = turn(hoursAgo(1, n), eventId, false);
      db.set(n % 2 === 1 && n < 100 ? { ...record, origin: "ai_tool" } : record);
    }
    const answer = await admin("GET", `/v1/admin/usage?group_by=requester&since=${encodeURIComponent(hoursAgo(26))}`);
    expect((answer.body.groups as Array<{ turns: number }>)[0]?.turns).toBe(5_000);
    expect(answer.body.truncated).toBe(true);
  });

  // Final review, item 2: a requester group is one developer, never one display name.
  it("keeps two developers with the same name in separate requester groups", async () => {
    const { db, admin } = await createAdminReadBroker();
    const developer = (id: string) => ({ origin: "ai_tool", requester: { kind: "developer", developerId: id.repeat(64), provider: "slack", name: "Maya Chen" } });
    db.set(usage(hoursAgo(1), 1, developer("a")));
    db.set(usage(hoursAgo(2), 2, developer("b")));
    db.set(usage(hoursAgo(3), 3, { ...developer("b"), requester: { kind: "developer", developerId: "b".repeat(64), provider: "slack" } }));
    const groups = (await admin("GET", "/v1/admin/usage?group_by=requester")).body.groups as Array<{ key: string; tasks: number }>;
    expect(groups.map((group) => [group.key, group.tasks]).sort()).toEqual([
      ["developer:Maya Chen (aaaaaaaa)", 1],
      ["developer:Maya Chen (bbbbbbbb)", 1],
      ["developer:bbbbbbbb", 1],
    ]);
  });

  // Final review, item 3: the route stays inside the broker's 30 s.
  it("looks up a page's workspaces in parallel, not one turn record at a time", async () => {
    const { db, admin } = await createAdminReadBroker();
    const workspaces = ["44444444-4444-4444-8444-444444444441", "44444444-4444-4444-8444-444444444442", "44444444-4444-4444-8444-444444444443"];
    workspaces.forEach((workspaceId, n) => {
      db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", projectName: `project-${n}` });
      db.set({ ...turn(hoursAgo(1, n), `EvPAR00000${n}`, false), workspaceId });
    });
    const send = db.send;
    let inFlight = 0;
    let most = 0;
    db.send = async (command) => {
      const key = (command.input as { Key?: { pk?: string; sk?: string } }).Key;
      if (command.constructor.name !== "GetCommand" || key?.sk !== "META" || !String(key.pk).startsWith("WORKSPACE#")) return send(command);
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      try {
        return await send(command);
      } finally {
        inFlight -= 1;
      }
    };
    const answer = await admin("GET", "/v1/admin/usage?group_by=project");
    expect((answer.body.groups as Array<{ key: string }>).map((group) => group.key).sort()).toEqual(["project-0", "project-1", "project-2"]);
    expect(most).toBe(3);
  });

  it("counts turn record pages filtered away toward the cap, and says it stopped early", async () => {
    const { db, admin } = await createAdminReadBroker();
    // 10,000 AI-tool records, newest first, then one Slack turn: the filter returns nothing for 100 pages.
    for (let n = 0; n < 10_000; n += 1) db.set({ ...turn(hoursAgo(1, n), `EvAIT${n.toString().padStart(7, "0")}`, false), origin: "ai_tool" });
    db.set(turn(hoursAgo(2), "EvSLACK000001", true));
    const send = db.send;
    let turnPages = 0;
    db.send = async (command) => {
      if (command.constructor.name === "QueryCommand" && String((command.input as { KeyConditionExpression?: string }).KeyConditionExpression).includes("exportPk")) turnPages += 1;
      return send(command);
    };
    const answer = await admin("GET", `/v1/admin/usage?group_by=requester&since=${encodeURIComponent(hoursAgo(26))}`);
    expect(turnPages).toBe(100);
    expect(answer.body.groups).toEqual([]);
    expect(answer.body.truncated).toBe(true);
  }, 30_000);
});
