// DEC 254b (b): an install administrator copies one company of the install's old layout (State table: ORG#<company>/META and MEMBER#<person>, the
// DEVELOPER_ORG pointer, the ban list) into Code's own company records (sign-in table), before Code's company sign-in is switched on. A preview writes
// nothing; an apply writes only new rows, through the sign-in Lambda; an undo removes exactly what an import wrote and nobody changed since.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, CompanyImportPreviewSchema, companyScoped, type AdminChangeInput } from "@agentx/contracts";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { companyMembershipFromDynamo, membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { companyImportThroughLambda } from "../../packages/broker/src/aws/company-import-forwarding.js";
import { routeDeveloperRequest, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { planCompanyImport, planCompanyImportUndo } from "../../packages/broker/src/aws/install-company-import.js";
import { PLANNERS, type PlanDependencies } from "../../packages/broker/src/aws/admin-change-plans.js";
import type { AuthenticatedIdentity } from "../../packages/broker/src/auth.js";
import { CompanyImportStore, COMPANY_IMPORT_BATCH, companyImportOperator } from "../../packages/broker/src/developer/company-import.js";
import { CompanySignInStore, companyKey, companyMemberKey } from "../../packages/broker/src/developer/company-membership.js";
import { tokenStoreKey } from "../../packages/cli/src/auth.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import { createAdminChangeBroker } from "../support/admin-change-broker.js";
import { identityHarness } from "../support/developer-fakes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const TIME = "2026-11-01T09:00:00.000Z";
const A = COMPANY_A.orgId, B = COMPANY_B.orgId;
const hex = (c: string) => c.repeat(64);
// Company A: an owner, their merged Slack sign-in (which has its own member record), an admin, a member, a banned and a removed member, a revoked sign-in
// and a member who never signed in to Code. Company B: its own owner and member.
const OWNER = hex("1"), DUP = hex("2"), ADMIN = hex("3"), MEMBER = hex("4"), BANNED = hex("5"), REMOVED = hex("6"), REVOKED = hex("7"), NEVER = hex("8"), B_OWNER = hex("9"), B_MEMBER = hex("a");
const OPERATOR = hex("e");
const SECRET = ["web", "app", "secret", "for", "tests"].join("-");
type Item = Record<string, unknown>;

function seedInstall(db: FakeDynamoDb) {
  db.set({ pk: "SLACK_TEAM#T0TEAM", sk: "ORG", orgId: A });
  const person = (id: string, name: string, extra: Item = {}) => db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, provider: "slack", displayName: name, revoked: false, ...extra });
  const company = (org: string, name: string) => db.set({ pk: `ORG#${org}`, sk: "META", entityType: "ORG", orgId: org, name, createdAt: TIME });
  const member = (org: string, id: string, role: string, pointer = true) => {
    if (pointer) db.set({ pk: `DEVELOPER_ORG#${id}`, sk: "ORG", entityType: "DEVELOPER_ORG", developerId: id, orgId: org });
    db.set({ pk: `ORG#${org}`, sk: `MEMBER#${id}`, entityType: "ORG_MEMBER", developerId: id, role, joinedAt: TIME });
  };
  person(OWNER, "Founder"); person(DUP, "Founder (Slack)", { slackUserId: "U0FOUNDER", mergedInto: OWNER, mergedAt: TIME });
  person(ADMIN, "Ada"); person(MEMBER, "Mia"); person(BANNED, "Bo"); person(REMOVED, "Rae"); person(REVOKED, "Rex", { revoked: true });
  person(B_OWNER, "Otto"); person(B_MEMBER, "Bea");
  company(A, "Founders Co"); company(B, "Other Co");
  member(A, OWNER, "owner"); member(A, DUP, "member"); member(A, ADMIN, "admin"); member(A, MEMBER, "member"); member(A, BANNED, "member");
  member(A, REMOVED, "member", false); member(A, REVOKED, "member"); member(A, NEVER, "member");
  db.set({ pk: `ORG#${A}#BAN`, sk: BANNED, bannedAt: TIME });
  member(B, B_OWNER, "owner"); member(B, B_MEMBER, "member");
  db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://cloud.example.com/callback"], loopback: false,
    installLevel: true, fullAccess: true, secretHash: createHash("sha256").update(SECRET).digest("hex"), createdAt: TIME, updatedAt: TIME, updatedBy: "admin" });
}

function world() {
  const db = new FakeDynamoDb({ seed: 7 });
  seedInstall(db);
  let now = NOW;
  const store = new CompanyImportStore({ documentClient: db, tableName: "signin", now: () => now });
  const logs: Item[] = [];
  const invokes: unknown[] = [];
  const registry = companyImportThroughLambda(async (payload) => {
    const event = JSON.parse(new TextDecoder().decode(payload)) as unknown; invokes.push(event);
    return { Payload: new TextEncoder().encode(JSON.stringify(await companyImportOperator({ store, log: (entry) => logs.push(entry) }, event))) };
  });
  const reads = { documentClient: db, tableName: "State", signInTableName: "signin" };
  const importPlan = (company = A) => planCompanyImport(reads, company);
  const undoPlan = (company = A) => planCompanyImportUndo(reads, company);
  const apply = async (company = A) => registry.importCompany((await importPlan(company)).write, OPERATOR);
  const undo = async (company = A) => registry.undoImport((await undoPlan(company)).remove, OPERATOR);
  const all = () => db.find(() => true).map((item) => JSON.stringify(item)).sort();
  const imported = () => db.find((item) => item.joinedVia === "import" || item.createdBy === "import");
  const access = async (id: string, layerOn: boolean) => {
    const deps: DeveloperRouteDependencies = {
      documentClient: db, tableName: "State", now: () => now, ...(layerOn ? { companies: companyMembershipFromDynamo(db, "signin") } : {}),
      developer: { issuer: "https://signin.example.test", env: "test", methods: { slack: true, oidc: true }, signInTableName: "signin", slackTeamId: "T0TEAM",
        verifyAccessToken: async () => ({}), channelMembers: async () => ({ ok: true, memberOf: [] }) },
    };
    const request = { method: "POST", path: "/v1/dev/access", headers: { authorization: `Basic ${Buffer.from(`web-app:${SECRET}`).toString("base64")}` }, requestId: "r", body: JSON.stringify({ developerId: id }) };
    try {
      const body = await routeDeveloperRequest(deps, request, new URL("/v1/dev/access", "https://broker.example.test")) as Item;
      return { status: 200, company: { companyId: body.companyId, companyRole: body.companyRole, companyName: body.companyName } };
    } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      return { status: error.statusCode };
    }
  };
  return { db, store, registry, logs, invokes, importPlan, undoPlan, apply, undo, all, imported, access, advance: (ms: number) => { now += ms; } };
}

describe("preview", () => {
  it("names what it would write and what it skips and why, by id, and writes nothing", async () => {
    const w = world();
    const before = w.all();
    const { preview } = await w.importPlan();
    expect(CompanyImportPreviewSchema.parse(preview)).toEqual(preview);
    expect(preview).toEqual({
      mode: "import", companyId: A, ready: true, company: "write",
      members: [{ personId: OWNER, role: "owner" }, { personId: ADMIN, role: "admin" }, { personId: MEMBER, role: "member" }, { personId: NEVER, role: "member" }],
      skipped: [
        { personId: DUP, reason: "merged", survivorId: OWNER },
        { personId: BANNED, reason: "banned" },
        { personId: REMOVED, reason: "removed" },
        { personId: REVOKED, reason: "sign_in_revoked" },
      ],
      refused: [],
    });
    expect(w.all()).toEqual(before);
    // Ids only: no name and no email in what the operator sees.
    expect(JSON.stringify(preview)).not.toMatch(/Founder|Mia|@/);
  });

  it("refuses the whole run on a role Code does not know, listing who", async () => {
    const w = world();
    w.db.set({ pk: `ORG#${A}`, sk: `MEMBER#${MEMBER}`, entityType: "ORG_MEMBER", developerId: MEMBER, role: "auditor", joinedAt: TIME });
    const plan = await w.importPlan();
    expect(plan.preview).toMatchObject({ ready: false, refused: [{ personId: MEMBER, reason: "unknown_role" }] });
    expect(plan.write.members).toEqual([]);
    expect(plan.write.writeCompany).toBe(false);
  });

  it("refuses the whole run when a person is already in another company in Code's records, live or removed", async () => {
    for (const revoked of [false, true]) {
      const w = world();
      w.db.set({ ...membershipKey(MEMBER), entityType: "COMPANY_MEMBERSHIP", personId: MEMBER, companyId: B, role: "member", joinedAt: TIME, ...(revoked ? { revokedAt: TIME } : {}) });
      const plan = await w.importPlan();
      expect(plan.preview).toMatchObject({ ready: false, refused: [{ personId: MEMBER, reason: "member_of_another_company" }] });
      const before = w.all();
      await w.registry.importCompany(plan.write, OPERATOR);
      expect(w.all()).toEqual(before);
    }
  });

  it("skips a person already in the same company, and reports it", async () => {
    const w = world();
    w.db.set({ ...membershipKey(ADMIN), entityType: "COMPANY_MEMBERSHIP", personId: ADMIN, companyId: A, role: "member", joinedAt: TIME, joinedVia: "preapproval" });
    const { preview } = await w.importPlan();
    expect(preview.ready).toBe(true);
    expect(preview.members.map((member) => member.personId)).not.toContain(ADMIN);
    expect(preview.skipped).toContainEqual({ personId: ADMIN, reason: "already_member" });
  });

  it("refuses a closed or missing company, the built-in company, unreadable records, and a company with no owner", async () => {
    const closed = world();
    closed.db.set({ pk: `ORG#${A}`, sk: "META", entityType: "ORG", orgId: A, name: "Founders Co", createdAt: TIME, closedAt: TIME });
    expect((await closed.importPlan()).preview).toMatchObject({ ready: false, refusal: "no_open_company" });
    expect((await world().importPlan("org_zzzzzzzzzzzzzzzzzzzz")).preview).toMatchObject({ ready: false, refusal: "no_open_company" });
    expect((await world().importPlan("org_00000000000000000000")).preview).toMatchObject({ ready: false, refusal: "built_in_company" });
    const loop = world();
    loop.db.set({ pk: `DEVELOPER#${OWNER}`, sk: "META", developerId: OWNER, provider: "slack", displayName: "Founder", revoked: false, mergedInto: DUP });
    expect((await loop.importPlan()).preview).toMatchObject({ ready: false, refused: expect.arrayContaining([{ personId: DUP, reason: "unreadable_record" }]) as unknown });
    const pointer = world();
    pointer.db.set({ pk: `DEVELOPER_ORG#${MEMBER}`, sk: "ORG", orgId: "not-an-org" });
    expect((await pointer.importPlan()).preview).toMatchObject({ ready: false, refused: [{ personId: MEMBER, reason: "unreadable_record" }] });
    const stray = world();
    stray.db.set({ ...companyMemberKey(A, MEMBER), entityType: "COMPANY_MEMBER_VIEW", personId: MEMBER, companyId: A, role: "member", joinedAt: TIME });
    expect((await stray.importPlan()).preview).toMatchObject({ ready: false, refused: [{ personId: MEMBER, reason: "unreadable_record" }] });
    const badCompany = world();
    badCompany.db.set({ ...companyKey(A), entityType: "COMPANY", companyId: A, name: "x" });
    expect((await badCompany.importPlan()).preview).toMatchObject({ ready: false, refusal: "unreadable" });
    const ownerless = world();
    ownerless.db.set({ pk: `ORG#${A}`, sk: `MEMBER#${OWNER}`, entityType: "ORG_MEMBER", developerId: OWNER, role: "admin", joinedAt: TIME });
    expect((await ownerless.importPlan()).preview).toMatchObject({ ready: false, refusal: "no_owner" });
  });

  it("refuses an unknown role even for a banned or removed person", async () => {
    const w = world();
    w.db.set({ pk: `ORG#${A}`, sk: `MEMBER#${BANNED}`, entityType: "ORG_MEMBER", developerId: BANNED, role: "auditor", joinedAt: TIME });
    expect((await w.importPlan()).preview).toMatchObject({ ready: false, refused: [{ personId: BANNED, reason: "unknown_role" }] });
  });

  it("reads a member record marked removed, and a pointer naming another company, as removed", async () => {
    const w = world();
    w.db.set({ pk: `ORG#${A}`, sk: `MEMBER#${MEMBER}`, entityType: "ORG_MEMBER", developerId: MEMBER, role: "member", joinedAt: TIME, removedAt: TIME });
    w.db.set({ pk: `DEVELOPER_ORG#${ADMIN}`, sk: "ORG", entityType: "DEVELOPER_ORG", developerId: ADMIN, orgId: B });
    const { preview } = await w.importPlan();
    expect(preview.skipped).toEqual(expect.arrayContaining([{ personId: MEMBER, reason: "removed" }, { personId: ADMIN, reason: "removed" }]) as unknown);
    expect(preview.members.map((member) => member.personId)).toEqual([OWNER, NEVER]);
  });

  it("refuses when a person the install no longer counts is still a live member in Code's records, and keeps a Code removal", async () => {
    const w = world();
    await w.apply();
    w.db.set({ pk: `ORG#${A}#BAN`, sk: MEMBER, bannedAt: TIME });
    expect((await w.importPlan()).preview).toMatchObject({ ready: false, refused: [{ personId: MEMBER, reason: "no_longer_member" }] });
    const company = new CompanySignInStore({ documentClient: w.db, tableName: "signin", now: () => NOW + 1_000 });
    expect(await company.setRevoked(A, MEMBER, true)).toBe(true);
    const { preview } = await w.importPlan();
    expect(preview.ready).toBe(true);
    expect(preview.skipped).toContainEqual({ personId: MEMBER, reason: "banned" });
    const unbanned = world();
    await unbanned.apply();
    await new CompanySignInStore({ documentClient: unbanned.db, tableName: "signin", now: () => NOW + 1_000 }).setRevoked(A, MEMBER, true);
    expect((await unbanned.importPlan()).preview.skipped).toContainEqual({ personId: MEMBER, reason: "removed_in_code" });
  });

  it("refuses when a live member in Code's records has no install member record any more", async () => {
    const w = world();
    await w.apply();
    await w.db.send(new DeleteCommand({ TableName: "State", Key: { pk: `ORG#${A}`, sk: `MEMBER#${NEVER}` } }));
    expect((await w.importPlan()).preview).toMatchObject({ ready: false, refused: [{ personId: NEVER, reason: "no_longer_member" }] });
  });

  it("refuses more members than one import copies, rather than copying some", async () => {
    const w = world();
    for (let i = 0; i < 193; i++) w.db.set({ pk: `ORG#${A}`, sk: `MEMBER#${i.toString(16).padStart(4, "0").padEnd(64, "b")}`, role: "member" });
    expect((await w.importPlan()).preview).toMatchObject({ ready: false, refusal: "too_many_members", members: [] });
  });
});

describe("apply", () => {
  it("writes the company record and each live member with the copied role, marked as imported, through conditional transactions with a log row", async () => {
    const w = world();
    expect(await w.apply()).toEqual({ rows: 4, company: true });
    const record = w.db.get(companyKey(A).pk, "META")!;
    expect(record).toMatchObject({ entityType: "COMPANY", companyId: A, name: "Founders Co", status: "active", createdBy: "import", importedAt: new Date(NOW).toISOString() });
    for (const [id, role] of [[OWNER, "owner"], [ADMIN, "admin"], [MEMBER, "member"], [NEVER, "member"]] as const) {
      const row = w.db.get(`COMPANY_MEMBER#${id}`, "COMPANY")!;
      expect(row).toEqual({ ...membershipKey(id), entityType: "COMPANY_MEMBERSHIP", personId: id, companyId: A, role, joinedAt: TIME, joinedVia: "import", importedAt: new Date(NOW).toISOString(), importedRole: role });
      expect(w.db.get(companyMemberKey(A, id).pk, companyMemberKey(A, id).sk)).toEqual({ ...row, ...companyMemberKey(A, id), entityType: "COMPANY_MEMBER_VIEW" });
    }
    // Never a merged-away id, a banned, removed or revoked person.
    for (const id of [DUP, BANNED, REMOVED, REVOKED]) expect(w.db.get(`COMPANY_MEMBER#${id}`, "COMPANY")).toBeUndefined();
    const logs = w.db.find((item) => item.pk === companyScoped(A, "COMPANY_LOG"));
    expect(logs).toEqual([expect.objectContaining({ entityType: "COMPANY_LOG", event: "company-import", companyId: A, createdBy: OPERATOR, people: [OWNER, ADMIN, MEMBER, NEVER], companyRecord: true })]);
    expect(JSON.stringify(w.logs)).not.toMatch(/Founders|@/);
  });

  it("makes the access check with Code's company layer on answer the same company and role as the old layout", async () => {
    const w = world();
    const live = [OWNER, ADMIN, MEMBER];
    const before = await Promise.all(live.map((id) => w.access(id, false)));
    expect(before.map((answer) => answer.company?.companyRole)).toEqual(["owner", "admin", "member"]);
    // Before the import, the layer on knows nobody.
    for (const id of live) expect((await w.access(id, true)).status).toBe(401);
    await w.apply();
    for (const [index, id] of live.entries()) {
      const on = await w.access(id, true);
      expect(on).toEqual({ status: 200, company: { companyId: A, companyRole: before[index]!.company!.companyRole, companyName: "Founders Co" } });
      expect(on).toEqual(before[index]);
    }
    // The skipped stay without a company on both sides.
    for (const id of [BANNED, REMOVED, REVOKED]) {
      expect((await w.access(id, false)).status).toBe(401);
      expect((await w.access(id, true)).status).toBe(401);
    }
  });

  it("re-running after a success writes nothing at all", async () => {
    const w = world();
    await w.apply();
    const after = w.all();
    const plan = await w.importPlan();
    expect(plan.preview).toMatchObject({ ready: true, company: "exists", members: [] });
    expect(plan.preview.skipped.filter((entry) => entry.reason === "already_member").map((entry) => entry.personId)).toEqual([OWNER, ADMIN, MEMBER, NEVER]);
    expect(await w.registry.importCompany(plan.write, OPERATOR)).toEqual({ rows: 0, company: false });
    expect(w.all()).toEqual(after);
  });

  it("importing A never touches B, and B imports on its own", async () => {
    const w = world();
    const bRows = () => w.db.find((item) => JSON.stringify(item).includes(B) || [B_OWNER, B_MEMBER].some((id) => JSON.stringify(item).includes(id))).map((item) => JSON.stringify(item)).sort();
    const before = bRows();
    await w.apply(A);
    expect(bRows()).toEqual(before);
    expect(w.imported().every((item) => item.companyId === A)).toBe(true);
    expect(await w.apply(B)).toEqual({ rows: 2, company: true });
    expect(w.db.get(`COMPANY_MEMBER#${B_OWNER}`, "COMPANY")).toMatchObject({ companyId: B, role: "owner" });
    expect(w.db.get(`COMPANY_MEMBER#${OWNER}`, "COMPANY")).toMatchObject({ companyId: A, role: "owner" });
  });

  it("never overwrites: a row that appears between the plan and the write stops the run with nothing overwritten", async () => {
    const w = world();
    const plan = await w.importPlan();
    const racer = { ...membershipKey(MEMBER), entityType: "COMPANY_MEMBERSHIP", personId: MEMBER, companyId: B, role: "member", joinedAt: TIME };
    w.db.set(racer);
    await expect(w.registry.importCompany(plan.write, OPERATOR)).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(w.db.get(`COMPANY_MEMBER#${MEMBER}`, "COMPANY")).toEqual(racer);
    expect(w.imported()).toEqual([]);
  });

  it("a run stopped after some people is not reported as stale", async () => {
    const registry = companyImportThroughLambda(async () => ({ Payload: new TextEncoder().encode(JSON.stringify({ ok: false, error: "conflict", rows: 3 })) }));
    await expect(registry.importCompany({ companyId: A, name: "Founders Co", writeCompany: false, members: [] }, OPERATOR)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: expect.stringContaining("after 3 people") as unknown });
  });

  it("writes in bounded transactions, one log row each, and every row conditional", async () => {
    const db = new FakeDynamoDb({ seed: 3 });
    const sent: Array<{ TransactItems: Array<Record<string, { ConditionExpression?: string }>> }> = [];
    const client = { send: async (command: unknown) => { sent.push((command as { input: never }).input); return db.send(command as never); } };
    const store = new CompanyImportStore({ documentClient: client, tableName: "signin", now: () => NOW });
    const members = Array.from({ length: COMPANY_IMPORT_BATCH + 5 }, (_, i) => ({ personId: i.toString(16).padStart(64, "d"), role: "member" as const }));
    expect(await companyImportOperator({ store, log: () => undefined }, { kind: "company-import", companyId: A, name: "Founders Co", writeCompany: true, members, createdBy: OPERATOR }))
      .toEqual({ ok: true, rows: COMPANY_IMPORT_BATCH + 5, company: true });
    expect(sent.map((input) => input.TransactItems.length)).toEqual([1 + COMPANY_IMPORT_BATCH * 2 + 1, 5 * 2 + 1]);
    for (const input of sent) for (const action of input.TransactItems) expect(Object.values(action)[0]!.ConditionExpression).toBe("attribute_not_exists(pk)");
    expect(db.find((item) => item.event === "company-import")).toHaveLength(2);
  });

  it("the sign-in Lambda refuses a malformed or widened event, and the built-in company", async () => {
    const store = new CompanyImportStore({ documentClient: new FakeDynamoDb({ seed: 1 }), tableName: "signin", now: () => NOW });
    const ok = { kind: "company-import", companyId: A, name: "Founders Co", writeCompany: true, members: [{ personId: OWNER, role: "owner" }], createdBy: OPERATOR };
    for (const event of [{ ...ok, companyId: "org_00000000000000000000" }, { ...ok, extra: 1 }, { ...ok, members: [{ personId: OWNER, role: "auditor" }] },
      { ...ok, members: [{ personId: OWNER, role: "owner" }, { personId: OWNER, role: "member" }] }, { ...ok, createdBy: "operator" }, { ...ok, name: "" }, null]) {
      expect(await companyImportOperator({ store, log: () => undefined }, event)).toEqual({ ok: false, error: "invalid_request" });
    }
  });
});

describe("undo", () => {
  it("previews, then deletes exactly the rows the import wrote and nothing else; a second undo is a no-op", async () => {
    const w = world();
    // Someone already in the company (an owner) before the import: the undo never touches them.
    w.db.set({ ...membershipKey(ADMIN), entityType: "COMPANY_MEMBERSHIP", personId: ADMIN, companyId: A, role: "owner", joinedAt: TIME, joinedVia: "preapproval" });
    w.db.set({ ...companyMemberKey(A, ADMIN), entityType: "COMPANY_MEMBER_VIEW", personId: ADMIN, companyId: A, role: "owner", joinedAt: TIME, joinedVia: "preapproval" });
    const before = w.all();
    await w.apply();
    const { preview } = await w.undoPlan();
    expect(preview).toEqual({ mode: "undo", companyId: A, ready: true, company: "keep",
      members: [{ personId: OWNER, role: "owner" }, { personId: MEMBER, role: "member" }, { personId: NEVER, role: "member" }], skipped: [], refused: [] });
    expect(await w.undo()).toEqual({ rows: 3, company: false });
    const left = w.all().filter((row) => !row.includes('"COMPANY_LOG"'));
    // The company record stays: a member who was not imported is still in it.
    expect(left).toEqual([...before, JSON.stringify(w.db.get(companyKey(A).pk, "META"))].sort());
    expect(w.db.find((item) => item.event === "company-import-undo")).toHaveLength(1);
    const again = w.all();
    expect(await w.undo()).toEqual({ rows: 0, company: false });
    expect(w.all()).toEqual(again);
  });

  it("refuses an undo that would leave live members with no owner", async () => {
    const w = world();
    w.db.set({ ...membershipKey(ADMIN), entityType: "COMPANY_MEMBERSHIP", personId: ADMIN, companyId: A, role: "admin", joinedAt: TIME, joinedVia: "preapproval" });
    w.db.set({ ...companyMemberKey(A, ADMIN), entityType: "COMPANY_MEMBER_VIEW", personId: ADMIN, companyId: A, role: "admin", joinedAt: TIME, joinedVia: "preapproval" });
    await w.apply();
    const plan = await w.undoPlan();
    expect(plan.preview).toMatchObject({ ready: false, refusal: "no_owner", members: [] });
    const before = w.all();
    await w.registry.undoImport(plan.remove, OPERATOR);
    expect(w.all()).toEqual(before);
  });

  it("deletes the company record too when no member is left, and leaves the install exactly as before", async () => {
    const w = world();
    const before = w.all();
    await w.apply();
    expect((await w.undoPlan()).preview.company).toBe("delete");
    expect(await w.undo()).toEqual({ rows: 4, company: true });
    expect(w.all().filter((row) => !row.includes('"COMPANY_LOG"'))).toEqual(before);
  });

  it("refuses a row whose role changed after the import (kept, reported), and still undoes the rest", async () => {
    const w = world();
    await w.apply();
    const company = new CompanySignInStore({ documentClient: w.db, tableName: "signin", now: () => NOW + 1_000 });
    expect(await company.setRole(A, MEMBER, "owner")).toBe("changed");
    const { preview } = await w.undoPlan();
    expect(preview.skipped).toEqual([{ personId: MEMBER, reason: "changed_since_import" }]);
    expect(preview.company).toBe("keep");
    await w.undo();
    expect(w.db.get(`COMPANY_MEMBER#${MEMBER}`, "COMPANY")).toMatchObject({ companyId: A, role: "owner" });
    expect(w.db.get(companyMemberKey(A, MEMBER).pk, companyMemberKey(A, MEMBER).sk)).toMatchObject({ role: "owner" });
    for (const id of [OWNER, ADMIN, NEVER]) expect(w.db.get(`COMPANY_MEMBER#${id}`, "COMPANY")).toBeUndefined();
    expect(w.db.get(companyKey(A).pk, "META")).toBeDefined();
  });

  it("keeps a row edited in the table directly (role set without the member helper, or an extra field), and a removed member", async () => {
    const w = world();
    await w.apply();
    const owner = w.db.get(`COMPANY_MEMBER#${OWNER}`, "COMPANY")!;
    w.db.set({ ...owner, role: "admin" });
    const admin = w.db.get(companyMemberKey(A, ADMIN).pk, companyMemberKey(A, ADMIN).sk)!;
    w.db.set({ ...admin, note: "x" });
    const company = new CompanySignInStore({ documentClient: w.db, tableName: "signin", now: () => NOW + 1_000 });
    expect(await company.setRevoked(A, NEVER, true)).toBe(true);
    const { preview } = await w.undoPlan();
    expect(preview.members).toEqual([{ personId: MEMBER, role: "member" }]);
    expect(preview.skipped.map((entry) => entry.personId)).toEqual([OWNER, ADMIN, NEVER]);
  });

  it("keeps a membership row that gained any field after the import, even with its mirror unchanged", async () => {
    const w = world();
    await w.apply();
    const row = w.db.get(`COMPANY_MEMBER#${OWNER}`, "COMPANY")!;
    w.db.set({ ...row, note: "x" });
    expect((await w.undoPlan()).preview).toMatchObject({ ready: true, skipped: [{ personId: OWNER, reason: "changed_since_import" }] });
  });

  it("a row changed between the undo's plan and its write stops that batch, and nothing is deleted from it", async () => {
    const w = world();
    await w.apply();
    const plan = await w.undoPlan();
    const row = w.db.get(`COMPANY_MEMBER#${MEMBER}`, "COMPANY")!;
    w.db.set({ ...row, revokedAt: TIME });
    await expect(w.registry.undoImport(plan.remove, OPERATOR)).rejects.toMatchObject({ code: "CHANGE_STALE" });
    for (const id of [OWNER, ADMIN, MEMBER, NEVER]) expect(w.db.get(`COMPANY_MEMBER#${id}`, "COMPANY")).toBeDefined();
    expect(w.db.get(companyKey(A).pk, "META")).toBeDefined();
  });

  it("undoing A never touches B's import", async () => {
    const w = world();
    await w.apply(A); await w.apply(B);
    const bRows = () => w.db.find((item) => item.companyId === B).map((item) => JSON.stringify(item)).sort();
    const before = bRows();
    await w.undo(A);
    expect(bRows()).toEqual(before);
    expect(w.db.get(`COMPANY_MEMBER#${B_OWNER}`, "COMPANY")).toMatchObject({ companyId: B });
  });
});

it("only the forwarder (broker) and the sign-in Lambda's store and server name the import events", () => {
  const owners = ["packages/broker/src/aws/company-import-forwarding.ts", "packages/broker/src/developer/company-import.ts", "packages/broker/src/developer/server.ts"];
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith(".ts") && /["'`]company-import(-undo)?["'`]/.test(readFileSync(path, "utf8"))) found.push(path);
    }
  };
  walk("packages/broker/src");
  expect(found.sort()).toEqual(owners);
});

describe("the sign-in Lambda", () => {
  it("takes the import with Code's company layer off, and only with the import store", async () => {
    const h = identityHarness();
    expect(h.deps.company).toBeUndefined();
    const event = { kind: "company-import", companyId: A, name: "Founders Co", writeCompany: true, members: [{ personId: OWNER, role: "owner" }], createdBy: OPERATOR };
    const without = await h.handler(event as never);
    expect(without).not.toMatchObject({ ok: true });
    expect(h.db.find((item) => item.joinedVia === "import")).toEqual([]);
    h.deps.companyImport = new CompanyImportStore({ documentClient: h.db, tableName: "signin", now: h.now });
    expect(await h.handler(event as never)).toEqual({ ok: true, rows: 1, company: true });
    expect(h.db.find((item) => item.joinedVia === "import")).toHaveLength(2);
  });
});

describe("an install administrator's preview and changes", () => {
  async function setUp() {
    const held: { store?: CompanyImportStore } = {};
    const registry = companyImportThroughLambda(async (payload) => ({ Payload: new TextEncoder().encode(JSON.stringify(await companyImportOperator({ store: held.store!, log: () => undefined }, JSON.parse(new TextDecoder().decode(payload))))) }));
    const harness = await createAdminChangeBroker({ companyImport: registry });
    held.store = new CompanyImportStore({ documentClient: harness.db, tableName: "signin", now: Date.now });
    seedInstall(harness.db);
    const change = async (input: AdminChangeInput) => {
      const planned = await harness.propose(input, ["cli"]);
      return { planned, apply: () => harness.apply((planned.body.change as { changeId: string }).changeId, "cli") };
    };
    const imported = () => harness.db.find((item) => item.joinedVia === "import" || item.createdBy === "import");
    return { harness, change, imported };
  }

  it("the preview route reads only and needs the administrator claim", async () => {
    const { harness, imported } = await setUp();
    const before = harness.db.find(() => true).map((item) => JSON.stringify(item)).sort();
    const preview = await harness.admin("GET", `/v1/admin/company-import?companyId=${A}&mode=import`);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ mode: "import", companyId: A, ready: true, company: "write" });
    expect((await harness.admin("GET", `/v1/admin/company-import?companyId=${A}&mode=undo`)).body).toMatchObject({ mode: "undo", members: [] });
    expect(harness.db.find(() => true).map((item) => JSON.stringify(item)).sort()).toEqual(before);
    expect((await harness.admin("GET", `/v1/admin/company-import?companyId=${A}`, { admin: false })).status).toBe(403);
    expect((await harness.admin("GET", "/v1/admin/company-import?companyId=nope")).status).toBe(400);
    expect(imported()).toEqual([]);
  });

  it("an apply shows its effect by id, writes only on the yes, and its undo removes the rows", async () => {
    const { harness, change, imported } = await setUp();
    const { planned, apply } = await change({ kind: "import_install_company", companyId: A });
    expect(planned.status).toBe(201);
    const effect = (planned.body.change as { effect: string }).effect;
    expect(effect).toContain(`Copy company ${A}`);
    expect(effect).toContain(OWNER);
    expect(effect).not.toMatch(/Founders|@/);
    expect(imported()).toEqual([]);
    expect((await apply()).body.change).toMatchObject({ status: "applied" });
    expect(imported()).toHaveLength(9);
    expect(harness.db.get(`COMPANY_MEMBER#${OWNER}`, "COMPANY")).toMatchObject({ companyId: A, role: "owner", joinedVia: "import" });
    const undo = await change({ kind: "undo_install_company_import", companyId: A });
    expect((undo.planned.body.change as { effect: string }).effect).toContain("Remove what the import");
    expect((await undo.apply()).body.change).toMatchObject({ status: "applied" });
    expect(imported()).toEqual([]);
  });

  it("a refused run is refused at planning, naming who, and a change the state moved under goes stale", async () => {
    const { harness, change, imported } = await setUp();
    harness.db.set({ pk: `ORG#${A}`, sk: `MEMBER#${MEMBER}`, entityType: "ORG_MEMBER", developerId: MEMBER, role: "auditor", joinedAt: TIME });
    const refused = await change({ kind: "import_install_company", companyId: A });
    expect(refused.planned.status).toBe(400);
    expect(refused.planned.body.error).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining(`a role Code does not know: ${MEMBER}`) as unknown });
    harness.db.set({ pk: `ORG#${A}`, sk: `MEMBER#${MEMBER}`, entityType: "ORG_MEMBER", developerId: MEMBER, role: "member", joinedAt: TIME });
    const planned = await change({ kind: "import_install_company", companyId: A });
    harness.db.set({ pk: `ORG#${A}#BAN`, sk: ADMIN, bannedAt: TIME });
    expect((await planned.apply()).body.error).toMatchObject({ code: "CHANGE_STALE" });
    expect(imported()).toEqual([]);
    expect((await harness.admin("POST", "/v1/admin/changes", { admin: false, body: { requestId: "77777777-7777-4777-8777-777777777777", change: { kind: "import_install_company", companyId: A }, client: { cliVersion: "0.0.7" }, methods: ["cli"] } })).status).toBe(403);
  });

  it("each planner refuses a caller without the administrator claim before reading anything", async () => {
    const deps = { actions: {} } as unknown as PlanDependencies;
    const caller = { isAdministrator: false, ownerKey: OPERATOR } as unknown as AuthenticatedIdentity;
    for (const input of [{ kind: "import_install_company", companyId: A }, { kind: "undo_install_company_import", companyId: A }] as const) {
      await expect(PLANNERS[input.kind]!(deps, caller, input, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("answers not found where it is not set up", async () => {
    const harness = await createAdminChangeBroker();
    expect((await harness.admin("GET", `/v1/admin/company-import?companyId=${A}`)).status).toBe(404);
    expect((await harness.propose({ kind: "import_install_company", companyId: A }, ["cli"])).status).toBe(404);
  });
});

describe("rovara admin company import", () => {
  const CHANGE = "55555555-5555-4555-8555-555555555555";
  const deployment = { controlPlaneUrl: "http://127.0.0.1:8787", auth: { issuer: "https://identity.example.test", clientId: "agentx-client", audience: "agentx-api" } };
  const view = (status: string) => ({ changeId: CHANGE, kind: "import_install_company", status, effect: `Copy company ${A}.`, methodsOffered: ["cli"], createdAt: "2026-11-12T09:00:00.000Z", expiresAt: "2026-11-12T09:10:00.000Z", ...(status === "applied" ? { methodUsed: "cli" } : {}) });
  const preview = { mode: "import", companyId: A, ready: true, company: "write", members: [{ personId: OWNER, role: "owner" }], skipped: [{ personId: DUP, reason: "merged", survivorId: OWNER }], refused: [] };

  async function cli() {
    const directory = await mkdtemp(join(tmpdir(), "agentx-cli-company-import-"));
    const deploymentFile = join(directory, "deployment.yaml");
    await writeFile(deploymentFile, JSON.stringify(deployment), "utf8");
    const tokens = new InMemoryTokenStore();
    await tokens.set(tokenStoreKey(deployment.auth), { accessToken: "access-secret-9d2e", expiresAt: Date.now() + 60_000 });
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      calls.push({ method: init?.method ?? "GET", url: `${url.pathname}${url.search}`, ...(init?.body === undefined ? {} : { body: JSON.parse(init.body as string) as unknown }) });
      if (url.pathname === "/v1/admin/company-import") return Response.json({ ...preview, mode: url.searchParams.get("mode") });
      if (url.pathname === "/v1/admin/changes") return Response.json({ change: view("pending") });
      return Response.json({ change: view("applied") });
    }) as unknown as typeof globalThis.fetch;
    let stdout = "";
    const io = { fetchImplementation: fetch, tokenStore: tokens, confirm: async () => true, stdout: { write: (text: string) => { stdout += text; return true; } }, stderr: { write: () => true } };
    const run = (args: string[]) => executeCli(["--config-dir", directory, "--deployment-file", deploymentFile, "--allow-loopback", "admin", "company", "import", ...args], io);
    return { run, calls, out: () => stdout };
  }

  it("previews by default and proposes nothing", async () => {
    const session = await cli();
    expect(await session.run(["--from-install", A])).toBe(0);
    expect(session.calls).toEqual([{ method: "GET", url: `/v1/admin/company-import?companyId=${A}&mode=import` }]);
    expect(session.out()).toContain("preview only, nothing was written");
    expect(session.out()).toContain(`${OWNER}  owner`);
    expect(session.out()).toContain(`${DUP}  merged into ${OWNER}`);
    const undo = await cli();
    expect(await undo.run(["--from-install", A, "--undo"])).toBe(0);
    expect(undo.calls).toEqual([{ method: "GET", url: `/v1/admin/company-import?companyId=${A}&mode=undo` }]);
  });

  it("--apply makes the admin change, and --undo --apply its undo", async () => {
    const session = await cli();
    expect(await session.run(["--from-install", A, "--apply"])).toBe(0);
    expect((session.calls[0]!.body as { change: unknown }).change).toEqual({ kind: "import_install_company", companyId: A });
    expect(session.calls.some((call) => call.url.endsWith("/apply"))).toBe(true);
    const undo = await cli();
    expect(await undo.run(["--from-install", A, "--undo", "--apply", "--yes"])).toBe(0);
    expect((undo.calls[0]!.body as { change: unknown }).change).toEqual({ kind: "undo_install_company_import", companyId: A });
  });

  it("refuses a malformed company id and --yes without --apply, calling nothing", async () => {
    for (const args of [["--from-install", "acme"], ["--from-install", A, "--yes"]]) {
      const session = await cli();
      expect(await session.run(args)).not.toBe(0);
      expect(session.calls).toEqual([]);
    }
  });
});
