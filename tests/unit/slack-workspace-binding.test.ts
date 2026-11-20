import { describe, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID, SlackTeamIdSchema } from "@agentx/contracts";
import { createSlackWorkspaceBindings, listSlackWorkspaceScopes, backfillSlackWorkspaceIndex, SlackWorkspaceRefused } from "../../packages/broker/src/aws/slack-workspace-binding.js";
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
  it("has exactly one winner when two companies claim the same team", async () => {
    const { bindings } = world(""); await bindings.backfill();
    const results = await Promise.allSettled([bindings.bind(A, TEAM, "operator"), bindings.bind(B, TEAM, "operator")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect([A, B]).toContain(await bindings.requireCompany(TEAM));
  });
  it.each(["E0AAAAAAA"])("refuses invalid or enterprise input without echo", async (team) => {
    const { bindings } = world();
    const message = await refusal(() => bindings.requireCompany(team));
    expect(message).toBe("This Slack workspace is not available.");
    await bindings.backfill();
    expect(await refusal(() => bindings.bind(A, team, "operator"))).toBe(message);
  });
  it.each<Record<string, unknown>>([{ teamId: OTHER }])("never treats an unreadable binding as implicit: %j", async (patch) => {
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

it("refuses malformed configured legacy teams instead of completing a partial backfill", async () => {
  const h = world("E0AAAAAAA");
  expect(await refusal(() => h.bindings.backfill())).toBe("This Slack workspace is not available.");
  expect(h.db.items.size).toBe(0);
});

function binding(teamId = TEAM, companyId = A) {
  return { pk: `SLACK_TEAM#${teamId}`, sk: "BINDING", entityType: "SLACK_WORKSPACE_BINDING", teamId, companyId, boundAt: new Date(NOW).toISOString(), boundBy: "operator" };
}
function view(teamId = TEAM, companyId = A) {
  return { ...binding(teamId, companyId), pk: `ORG#${companyId}#SLACK_WORKSPACES`, sk: `TEAM#${teamId}`, entityType: "COMPANY_SLACK_WORKSPACE_VIEW" };
}

it("walks every binding writer and preserves the authoritative/index pair atomically", async () => {
  for (const path of ["bind", "legacy backfill", "existing bind", "existing legacy backfill"] as const) {
    const { db, bindings } = world(path.includes("backfill") ? TEAM : "");
    expect(Object.keys(bindings).sort()).toEqual(["backfill", "bind", "channelCompanyOf", "companyOf", "requireCompany"]);
    const company = path.includes("backfill") ? IMPLICIT_COMPANY_ID : A;
    if (!path.includes("backfill")) await bindings.backfill();
    if (path.startsWith("existing")) db.set(binding(TEAM, company));
    const transactions: unknown[] = [];
    const send = db.send.bind(db);
    vi.spyOn(db, "send").mockImplementation(async (command) => {
      if (command.constructor.name === "TransactWriteCommand") transactions.push(command.input);
      return send(command);
    });
    if (path.includes("backfill")) await bindings.backfill(); else await bindings.bind(A, TEAM, "operator");
    expect(db.get(`ORG#${company}#SLACK_WORKSPACES`, `TEAM#${TEAM}`)).toEqual({ ...db.get(`SLACK_TEAM#${TEAM}`, "BINDING"), pk: `ORG#${company}#SLACK_WORKSPACES`, sk: `TEAM#${TEAM}`, entityType: "COMPANY_SLACK_WORKSPACE_VIEW" });
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({ TransactItems: [expect.any(Object), { Put: { Item: { ...view(TEAM, company), boundBy: path === "legacy backfill" ? "backfill" : "operator" } } }] });
    const before = structuredClone([...db.items]);
    if (path.includes("backfill")) await bindings.backfill(); else await bindings.bind(A, TEAM, "operator");
    expect([...db.items]).toEqual(before);
    expect(db.refusals).toEqual([]);
  }
});

it.each(["items", "bytes", "pages", "malformed", "cursor"])("query refuses %s without partial results or private cause", async (kind) => {
  let page = 0; let time = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => time);
  try {
    const client = { send: vi.fn(async () => {
      page++;
      if (page > 11) throw new Error("test provider sentinel");
      if (kind === "cause") throw new Error("private enumeration cause");
      if (kind === "late") time = 3001;
      return { Items: kind === "pages" ? [] : kind === "items" ? Array.from({ length: 17 }, (_, i) => view(`T${String(i + page * 17).padStart(8, "0")}`))
        : kind === "malformed" ? [view(), { ...view(), boundBy: "private marker" }]
        : kind === "foreign" ? [view(TEAM, B)] : kind === "foreign metadata" ? [{ ...view(), companyId: B }] : kind === "duplicate" ? [view(), view()] : [view(`T${String(page).padStart(8, "0")}`)],
        ...(kind === "bytes" ? { metadata: "x".repeat(40_000) } : {}),
        ...(["pages", "items", "bytes", "cursor"].includes(kind) ? { LastEvaluatedKey: { pk: kind === "cursor" ? "private-other-partition" : view().pk, sk: `TEAM#T${String(page).padStart(8, "0")}` } } : {}) };
    }) };
    await expect(listSlackWorkspaceScopes({ client, tableName: "state" }, A)).rejects.toThrow(/^This Slack workspace is not available\.$/);
    if (kind === "cursor") expect(client.send).toHaveBeenCalledTimes(1);
    if (kind === "pages") expect(client.send).toHaveBeenCalledTimes(10);
    if (kind === "items" || kind === "bytes") expect(client.send).toHaveBeenCalledTimes(2);
  } finally { clock.mockRestore(); }
});

it("operator index backfill is bounded, dryRun writes nothing, and repeats idempotently", async () => {
  const db = new FakeDynamoDb(); db.set(binding()); db.set(binding(OTHER, B));
  const rows = [binding(), { pk: "OTHER", sk: "META" }, binding(OTHER, B)];
  const send = vi.fn(async (command: unknown) => (command as { constructor: { name: string } }).constructor.name === "ScanCommand"
    ? { Items: rows, ScannedCount: 3 } : db.send(command as Parameters<typeof db.send>[0]));
  const deps = { client: { send }, tableName: "state", now: () => NOW };
  expect(await backfillSlackWorkspaceIndex(deps, { dryRun: true })).toEqual({ evaluated: 3, bindings: 2, written: 0, complete: true });
  expect(send.mock.calls[0]?.[0]).toMatchObject({ input: { ProjectionExpression: "pk, sk, entityType, teamId, companyId, boundAt, boundBy" } });
  expect([...db.items.values()]).toHaveLength(2);
  expect(send.mock.calls.map(([c]) => (c as { constructor: { name: string } }).constructor.name)).toEqual(["ScanCommand"]);
  expect(await backfillSlackWorkspaceIndex(deps, { dryRun: false })).toMatchObject({ written: 2, complete: true });
  const before = structuredClone([...db.items]);
  await backfillSlackWorkspaceIndex(deps, { dryRun: false }); expect([...db.items]).toEqual(before);
  expect(db.get(view().pk, view().sk)).toEqual(view());
  expect(db.get(view(OTHER, B).pk, view(OTHER, B).sk)).toEqual(view(OTHER, B));
});

it("operator backfill returns an explicit continuation and honors it without expanding the batch", async () => {
  const cursor = { pk: "OTHER", sk: "META" };
  const send = vi.fn(async () => ({ Items: [], ScannedCount: 100, LastEvaluatedKey: cursor }));
  expect(await backfillSlackWorkspaceIndex({ client: { send }, tableName: "state" }, { dryRun: true, cursor })).toEqual({ evaluated: 100, bindings: 0, written: 0, complete: false, cursor });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls).toMatchObject([[{ input: { Limit: 100, ExclusiveStartKey: cursor } }]]);
});

it.each(["items", "bytes", "late"])("operator backfill refuses %s before writes", async (kind) => {
  let time = NOW;
  const send = vi.fn(async () => {
    if (kind === "late") time += 10_001;
    return { Items: kind === "malformed" ? [{ ...binding(), boundBy: "private marker" }] : [binding()], ScannedCount: kind === "items" ? 101 : 1,
      ...(kind === "bytes" ? { metadata: "x".repeat(1_048_577) } : {}) };
  });
  await expect(backfillSlackWorkspaceIndex({ client: { send }, tableName: "state", now: () => time }, { dryRun: kind === "input" ? "false" as never : false })).rejects.toThrow(/^This Slack workspace is not available\.$/);
  expect(send.mock.calls.length).toBe(kind === "input" ? 0 : 1);
});



it.each<unknown>([null])("invalid company input refuses before Query: %j", async (company) => {
  const send = vi.fn();
  await expect(listSlackWorkspaceScopes({ client: { send }, tableName: "state" }, company as string)).rejects.toThrow(/^This Slack workspace is not available\.$/);
  expect(send).not.toHaveBeenCalled();
});



it("a same-company claim race repairs the winner's index without replacing its metadata", async () => {
  const { db, bindings } = world(""); await bindings.backfill();
  const send = db.send.bind(db); let raced = false;
  vi.spyOn(db, "send").mockImplementation(async (command) => {
    if (!raced && command.constructor.name === "TransactWriteCommand") {
      raced = true; db.set(binding());
    }
    return send(command);
  });
  await bindings.bind(A, TEAM, "another.operator");
  expect(db.get(view().pk, view().sk)).toEqual(view());
  expect(db.get(binding().pk, binding().sk)).toEqual(binding());
});


