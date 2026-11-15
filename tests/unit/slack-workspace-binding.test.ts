import { describe, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID, SlackTeamIdSchema } from "@agentx/contracts";
import { createSlackWorkspaceBindings, SlackWorkspaceRefused } from "../../packages/broker/src/aws/slack-workspace-binding.js";
import { tenantIsCompanys } from "../../packages/broker/src/core/channel/company.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const TEAM = "T0AAAAAAA";
const OTHER = "T0BBBBBBB";
const NOW = Date.parse("2026-11-15T12:00:00.000Z");
function world(legacyTeamId: string | undefined = TEAM) {
  const db = new FakeDynamoDb();
  const bindings = createSlackWorkspaceBindings({ client: db, tableName: "state", legacyTeamId, now: () => NOW });
  return { db, bindings };
}
async function refusal(work: () => Promise<unknown>) {
  try { await work(); return "unexpected success"; } catch (error) {
    expect(error instanceof SlackWorkspaceRefused).toBe(true);
    return error instanceof Error ? error.message : "unexpected error";
  }
}
describe("Slack workspace directory", () => {
  it("serves only the legacy workspace implicitly before backfill", async () => {
    const { bindings } = world();
    expect(await bindings.companyOf(TEAM)).toBe(IMPLICIT_COMPANY_ID);
    expect(await bindings.companyOf(OTHER)).toBeUndefined();
    expect(await world("").bindings.companyOf(TEAM)).toBeUndefined();
    const unknown = await refusal(() => bindings.requireCompany(OTHER));
    expect(unknown).toBe("This Slack workspace is not available.");
    expect(await refusal(() => bindings.bind(A, OTHER, "operator"))).toBe(unknown);
    expect(await bindings.companyOf(OTHER)).toBeUndefined();
    await bindings.bind(IMPLICIT_COMPANY_ID, OTHER, "operator");
    expect(await bindings.companyOf(OTHER)).toBe(IMPLICIT_COMPANY_ID);
  });
  it("backfills at most one team, then changes nothing on repeat", async () => {
    const { db, bindings } = world();
    expect(await bindings.backfill()).toEqual({ teamsRead: 1 });
    const before = JSON.stringify([...db.items.values()]);
    const writes = db.commandNames().filter((name) => name === "PutCommand").length;
    expect(await bindings.backfill()).toEqual({ teamsRead: 0 });
    expect(JSON.stringify([...db.items.values()])).toBe(before);
    expect(db.commandNames().filter((name) => name === "PutCommand")).toHaveLength(writes);
    expect(await bindings.companyOf(TEAM)).toBe(IMPLICIT_COMPANY_ID);
    expect(await bindings.companyOf(OTHER)).toBeUndefined();
    const empty = world("");
    expect(await empty.bindings.backfill()).toEqual({ teamsRead: 0 });
    expect(await empty.bindings.companyOf(TEAM)).toBeUndefined();
  });
  it("claims conditionally, is idempotent, and refuses another company with unknown bytes", async () => {
    const { db, bindings } = world("");
    await bindings.backfill();
    await bindings.bind(A, TEAM, "operator");
    const before = JSON.stringify([...db.items.values()]);
    const writes = db.commandNames().filter((name) => name === "PutCommand").length;
    await bindings.bind(A, TEAM, "operator2");
    expect(JSON.stringify([...db.items.values()])).toBe(before);
    expect(db.commandNames().filter((name) => name === "PutCommand")).toHaveLength(writes);
    const unknown = await refusal(() => bindings.requireCompany(OTHER));
    expect(await refusal(() => bindings.bind(B, TEAM, "operator"))).toBe(unknown);
    expect(await bindings.requireCompany(TEAM)).toBe(A);
    expect(unknown).not.toMatch(new RegExp([A, B, TEAM, OTHER].join("|")));
  });
  it("has exactly one winner when two companies claim the same team", async () => {
    const { bindings } = world(""); await bindings.backfill();
    const results = await Promise.allSettled([bindings.bind(A, TEAM, "operator"), bindings.bind(B, TEAM, "operator")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect([A, B]).toContain(await bindings.requireCompany(TEAM));
  });
  it.each(["E0AAAAAAA", "invalid", "", null, 17, {}, "T".repeat(1_000_000)])("refuses invalid or enterprise input without echo", async (team) => {
    const { bindings } = world();
    const message = await refusal(() => bindings.requireCompany(team as string));
    expect(message).toBe("This Slack workspace is not available.");
    await bindings.backfill();
    expect(await refusal(() => bindings.bind(A, team as string, "operator"))).toBe(message);
  });
  it.each([{}, { entityType: "wrong" }, { companyId: "not-an-org" }, { teamId: OTHER }, { boundBy: "free text" }, { boundAt: "yesterday" }])("never treats an unreadable binding as implicit: %j", async (patch) => {
    const { db, bindings } = world();
    db.set({ pk: `SLACK_TEAM#${TEAM}`, sk: "BINDING", entityType: "SLACK_WORKSPACE_BINDING", teamId: TEAM, companyId: A, boundAt: new Date(NOW).toISOString(), boundBy: "operator", ...patch });
    if (Object.keys(patch).length === 0) db.set({ pk: `SLACK_TEAM#${TEAM}`, sk: "BINDING" });
    expect(await refusal(() => bindings.requireCompany(TEAM))).toBe("This Slack workspace is not available.");
  });
  it("fails closed on a broken reader or marker, never logging its cause", async () => {
    const bindings = createSlackWorkspaceBindings({ client: { send: async () => { throw new Error("private-company-token-cause"); } }, tableName: "state", legacyTeamId: TEAM });
    expect(await refusal(() => bindings.requireCompany(TEAM))).toBe("This Slack workspace is not available.");
    const h = world(); h.db.set({ pk: "SLACK_WORKSPACE_BINDING", sk: "BACKFILL", entityType: "wrong" });
    expect(await refusal(() => h.bindings.requireCompany(TEAM))).toBe("This Slack workspace is not available.");
  });
  it("validates company/operator input and never writes a token-shaped operator label", async () => {
    const { bindings } = world(""); await bindings.backfill();
    for (const [company, by] of [["not-an-org", "operator"], [A, "operator text"], [A, ["xoxb", "private"].join("-")]]) {
      expect(await refusal(() => bindings.bind(company!, TEAM, by!))).toBe("This Slack workspace is not available.");
    }
  });
  it("shares its answer with core tenant checks", async () => {
    const { bindings } = world(""); await bindings.backfill(); await bindings.bind(A, TEAM, "operator");
    expect(SlackTeamIdSchema.safeParse(TEAM).success).toBe(true);
    expect(await tenantIsCompanys(bindings.channelCompanyOf, A, "slack", TEAM)).toBe(true);
    expect(await tenantIsCompanys(bindings.channelCompanyOf, B, "slack", TEAM)).toBe(false);
    expect(await bindings.channelCompanyOf({ channel: "other", tenant: TEAM })).toBeUndefined();
  });
});

it("refuses oversized or late storage responses without a fallback or a late write", async () => {
  for (const kind of ["oversized", "late"] as const) {
    let time = NOW; let writes = 0;
    const bindings = createSlackWorkspaceBindings({ tableName: "state", legacyTeamId: TEAM, now: () => time, client: { send: async (command) => {
      if ((command as { constructor: { name: string } }).constructor.name === "PutCommand") writes++;
      if (kind === "late") { time += 10_001; return {}; }
      return { Item: { pk: `SLACK_TEAM#${TEAM}`, sk: "BINDING", entityType: "SLACK_WORKSPACE_BINDING", teamId: TEAM, companyId: A, boundAt: new Date(NOW).toISOString(), boundBy: "operator" }, responseMetadata: "a".repeat(1_000_000) };
    } } });
    expect(await refusal(() => bindings.requireCompany(TEAM))).toBe("This Slack workspace is not available.");
    expect(await refusal(() => bindings.backfill())).toBe("This Slack workspace is not available.");
    expect(writes).toBe(0);
  }
});

it("never restores implicit fallback after the marker even if the legacy row disappears", async () => {
  const { db, bindings } = world(); await bindings.backfill();
  db.delete(`SLACK_TEAM#${TEAM}`, "BINDING");
  expect(await bindings.companyOf(TEAM)).toBeUndefined();
});

it("refuses malformed configured legacy teams instead of completing a partial backfill", async () => {
  const h = world("E0AAAAAAA");
  expect(await refusal(() => h.bindings.backfill())).toBe("This Slack workspace is not available.");
  expect(h.db.items.size).toBe(0);
});

it("treats malformed channel-company queries as unavailable", async () => {
  const { bindings } = world();
  expect(await bindings.channelCompanyOf(null as never)).toBeUndefined();
});

it("enumerates only explicit company bindings with one total scan budget", async () => {
  const { listSlackWorkspaceScopes } = await import("../../packages/broker/src/aws/slack-workspace-binding.js");
  const { db, bindings } = world("");
  const client = { send: async () => ({ Items: [...db.items.values()] }) };
  expect(await listSlackWorkspaceScopes({ client, tableName: "state" }, A)).toEqual([]);
  await bindings.backfill(); await bindings.bind(A, TEAM, "operator"); await bindings.bind(B, OTHER, "operator");
  expect(await listSlackWorkspaceScopes({ client, tableName: "state" }, A)).toEqual([{ companyId: A, teamId: TEAM }]);
  expect(await listSlackWorkspaceScopes({ client, tableName: "state" }, B)).toEqual([{ companyId: B, teamId: OTHER }]);
  let calls = 0;
  await expect(listSlackWorkspaceScopes({ client: { send: async () => { calls++; return { Items: Array.from({ length: 100 }, () => ({ ignored: true })), LastEvaluatedKey: { pk: "again" } }; } }, tableName: "state" }, A)).rejects.toThrow("This Slack workspace is not available.");
  expect(calls).toBe(10);
});

it("workspace enumeration hides storage causes", async () => {
  const { listSlackWorkspaceScopes } = await import("../../packages/broker/src/aws/slack-workspace-binding.js");
  await expect(listSlackWorkspaceScopes({ client: { send: async () => { throw new Error("private enumeration cause"); } }, tableName: "state" }, A)).rejects.toThrow(/^This Slack workspace is not available\.$/);
});


it("workspace enumeration accepts its full item and returned-scope limits", async () => {
  const { listSlackWorkspaceScopes } = await import("../../packages/broker/src/aws/slack-workspace-binding.js");
  const rows = Array.from({ length: 32 }, (_, index) => {
    const teamId = `T${String(index).padStart(8, "0")}`;
    return { pk: `SLACK_TEAM#${teamId}`, sk: "BINDING", entityType: "SLACK_WORKSPACE_BINDING", teamId, companyId: A, boundAt: new Date(NOW).toISOString(), boundBy: "operator" };
  });
  let page = 0;
  const client = { send: async () => ({ Items: page++ === 0 ? [...rows, ...Array.from({ length: 68 }, () => ({ ignored: true }))] : Array.from({ length: 100 }, () => ({ ignored: true })), ...(page === 10 ? {} : { LastEvaluatedKey: { pk: "next" } }) }) };
  expect(await listSlackWorkspaceScopes({ client, tableName: "state" }, A)).toEqual(rows.map(({ companyId, teamId }) => ({ companyId, teamId })));
  expect(page).toBe(10);
});

it.each(["items", "bytes", "scopes", "late", "malformed"])("workspace enumeration rejects %s without a partial result", async (kind) => {
  const { listSlackWorkspaceScopes } = await import("../../packages/broker/src/aws/slack-workspace-binding.js");
  const row = (index: number) => {
    const teamId = `T${String(index).padStart(8, "0")}`;
    return { pk: `SLACK_TEAM#${teamId}`, sk: "BINDING", entityType: "SLACK_WORKSPACE_BINDING", teamId, companyId: A, boundAt: new Date(NOW).toISOString(), boundBy: "operator" };
  };
  let time = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => time);
  try {
    const client = { send: async () => {
      if (kind === "late") time = 3001;
      return { Items: kind === "items" ? Array.from({ length: 1001 }, () => ({ ignored: true }))
        : kind === "scopes" ? Array.from({ length: 33 }, (_, index) => row(index))
        : kind === "malformed" ? [row(0), { ...row(1), pk: "private marker" }] : [row(0)],
      ...(kind === "bytes" ? { metadata: "x".repeat(1_048_577) } : {}) };
    } };
    await expect(listSlackWorkspaceScopes({ client, tableName: "state" }, A)).rejects.toThrow(/^This Slack workspace is not available\.$/);
  } finally { clock.mockRestore(); }
});
