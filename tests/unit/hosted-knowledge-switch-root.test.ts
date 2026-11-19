// L4-JA7 (journey audit B7), the wiring test on the REAL core root: a hosted company can now read and set "Knowledge stays in Rovara" and a project's "local coding tools can fetch lessons". The root, registry, runtime, lessons
// runtime and the knowledge API are real; only the deployment adapters and the sign-in/state tables are fakes. It proves (1) the root hands the router the switch API (also with lessons OFF, because the wiki tools gate reads the same
// row), (2) live membership and the broker's own project grant decide who may change what, (3) a change written here is the very value the lessons runtime's gate (the one AK3's knowledge read and #1033's wiki tools use) reads next,
// (4) two companies keep their own, (5) every change is on the audit ledger before the row changes.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { grantKeyFor } from "../../packages/broker/src/aws/company-layout.js";
import { KNOWLEDGE_STAYS_SENTENCE, companyScoped, orgProjectCatalogKey, projectRevisionKey, teamRecordPk, type JsonValue, type OrgId } from "@agentx/contracts";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { createHostedLessonsPeople } from "../../packages/broker/src/aws/hosted-lessons-people.js";
import * as lessonsModule from "../../packages/broker/src/core-host/lessons.js";
import { localToolsGate, wikiToolsGate } from "../../packages/broker/src/lessons/local-tools.js";
import { createFakeWorld, FAKE_COMPANY } from "../support/core-host-fakes.js";
import { definition } from "../support/task-flow-harness.js";

const adapters = vi.hoisted(() => ({ modules: [] as unknown[] }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", () => ({ codeAdapterModules: () => adapters.modules }));
vi.mock("../../packages/broker/src/core-host/hosted-modules.js", async (original) => ({ ...await original<object>(), hostedSecurityModules: () => [] }));
vi.mock("../../packages/broker/src/core-host/lessons.js", async (original) => {
  const real = await original<{ createCoreLessons: typeof lessonsModule.createCoreLessons }>();
  return { ...real, createCoreLessons: vi.fn(real.createCoreLessons) };
});

const A = FAKE_COMPANY as OrgId;
const B = "org_corehost00000000000b" as OrgId;
const secret = Buffer.alloc(32, 7);
const id = (n: number): string => n.toString(16).padStart(64, "0");
const [OWNER_A, ADMIN_A, MAINT_A, DEV_A, STRANGER_A, OWNER_B, MAINT_B] = [id(1), id(2), id(3), id(4), id(5), id(6), id(7)];
const COMPANY_PATH = "/v1/dev/company/lessons/local-tools";
const PROJECT_PATH = "/v1/dev/projects/payments/lessons/local-tools";

async function setup(env: Record<string, string> = { ROVARA_CORE_LESSONS: "on" }) {
  const world = createFakeWorld();
  adapters.modules = world.modules;
  const rows = new Map<string, Record<string, unknown>>();
  const member = (personId: string, companyId: OrgId, role: string) => {
    rows.set(`signin|COMPANY_MEMBER#${personId}|COMPANY`, { pk: `COMPANY_MEMBER#${personId}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId, companyId, role, joinedAt: "2026-10-01T00:00:00.000Z" });
    rows.set(`signin|${companyScoped(companyId, "MEMBERS")}|MEMBER#${personId}`, { pk: companyScoped(companyId, "MEMBERS"), sk: `MEMBER#${personId}`, entityType: "COMPANY_MEMBER_VIEW", personId, companyId, role, joinedAt: "2026-10-01T00:00:00.000Z" });
  };
  member(OWNER_A, A, "owner"); member(ADMIN_A, A, "admin"); member(MAINT_A, A, "member"); member(DEV_A, A, "member"); member(STRANGER_A, A, "member");
  member(OWNER_B, B, "owner"); member(MAINT_B, B, "member");
  // DEC 254zzz80 (#1106, batch b21): a named company's project grant lives in that company's own partition (company-layout.ts grantKeyFor).
  const grant = (personId: string, companyId: OrgId, role: string) => { const key = grantKeyFor(companyId, personId, "payments"); rows.set(`state|${key.pk}|${key.sk}`, { ...key, projectName: "payments", role }); };
  grant(MAINT_A, A, "administrator"); grant(DEV_A, A, "developer"); grant(MAINT_B, B, "administrator");
  // Company A and company B each have a project called "payments" in their own catalog; only B has "only-b".
  for (const [company, name] of [[A, "payments"], [B, "payments"], [B, "only-b"]] as const) {
    await world.store.put({ item: { ...projectRevisionKey(company, name, 1), entityType: "PROJECT", definition: JSON.parse(JSON.stringify({ ...definition, name })) as JsonValue } });
    await world.store.put({ item: { ...orgProjectCatalogKey(company, name), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
  }
  const client = { async send(command: unknown) {
    if (command instanceof GetCommand) {
      const { TableName, Key } = command.input as { TableName: string; Key: { pk: string; sk: string } };
      if (TableName === "signin" || TableName === "state") return { Item: rows.get(`${TableName}|${Key.pk}|${Key.sk}`) };
      return { Item: await world.store.get(Key) };
    }
    if (command instanceof QueryCommand) {
      const input = command.input as { ExpressionAttributeValues: Record<string, string> };
      const pk = input.ExpressionAttributeValues[":pk"]!;
      const items = [...rows.entries()].filter(([k]) => k.startsWith(`signin|${pk}|`)).map(([, row]) => row);
      return { Items: items, ScannedCount: items.length };
    }
    throw new Error("unexpected write");
  } };
  const root = createBrokerCoreRoot({
    env: { ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: "all", ...env },
    documentClient: client, stateTableName: "state", signInTableName: "signin", callbackSigningKey: secret.toString(), repositoryGrantKey: secret,
    codeModules: () => ({}) as never, repositoryCredential: async () => { throw new Error("unused"); }, origin: () => "https://api.example", log: () => undefined,
    now: () => new Date(world.clock.now), ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
    services: () => Object.fromEntries(["merge-tracking", "session-sweep", "notify-deliver", "admission-hold-sweep"].map((name) => [name, { pass: async () => ({}) }])),
    lessonsPeople: createHostedLessonsPeople({ documentClient: client, stateTableName: "state", signInTableName: "signin", now: () => world.clock.now }),
  });
  return { root, rows, world };
}
type Setup = Awaited<ReturnType<typeof setup>>;
const call = (s: Setup, method: string, path: string, personId: string, body?: unknown) => s.root.knowledgeSwitch!.answer({ method, path, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, { personId, webApp: true });

/** The lessons runtime the company's knowledge read and wiki gate use (the one `createCoreLessons` built for company `A`). */
const lessonsRuntimeOf = (company: OrgId) => {
  const results = vi.mocked(lessonsModule.createCoreLessons).mock.results.map((result) => result.value as Awaited<ReturnType<typeof lessonsModule.createCoreLessons>>);
  const found = results.filter((one) => one?.companyId === company).at(-1);
  if (found === undefined) throw new Error("no lessons runtime for the company");
  return found.runtime;
};

describe("the core root hands the router the switch API", () => {
  it("serves it whenever the core serves, with the lessons switch on or off (the wiki tools gate reads the same row either way)", async () => {
    expect((await setup({ ROVARA_CORE_LESSONS: "on" })).root.knowledgeSwitch).toBeDefined();
    const off = await setup({});
    expect(off.root.lessons).toBeUndefined();
    expect(off.root.knowledgeSwitch).toBeDefined();
    expect(await call(off, "GET", COMPANY_PATH, OWNER_A)).toEqual({ stays: false });
    expect(await call(off, "PUT", COMPANY_PATH, OWNER_A, { stays: true })).toEqual({ stays: true });
  });

  it("is handed to both of the broker's router calls and to the router's dependency type", () => {
    const broker = readFileSync("packages/broker/src/aws/broker.ts", "utf8");
    expect(broker.match(/\.\.\.\(core\?\.knowledgeSwitch === undefined \? \{\} : \{ knowledgeSwitch: core\.knowledgeSwitch \}\)/gu)).toHaveLength(2);
    expect(readFileSync("packages/broker/src/aws/developer-routes.ts", "utf8")).toMatch(/knowledgeSwitch\?: Pick<KnowledgeSwitchApi, "answer">;/u);
  });
});

describe("on the real root, with the real membership and project grants", () => {
  it("the company's switch: an owner or admin sets it; a project admin, a developer and a plain member are refused and nothing is written", async () => {
    const s = await setup();
    expect(await call(s, "PUT", COMPANY_PATH, OWNER_A, { stays: true })).toEqual({ stays: true });
    expect(await call(s, "GET", COMPANY_PATH, ADMIN_A)).toEqual({ stays: true });
    expect(await call(s, "PUT", COMPANY_PATH, ADMIN_A, { stays: false })).toEqual({ stays: false });
    const before = s.world.audit.length;
    for (const who of [MAINT_A, DEV_A, STRANGER_A]) {
      await expect(call(s, "GET", COMPANY_PATH, who), who).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(call(s, "PUT", COMPANY_PATH, who, { stays: true }), who).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(s.world.audit.length).toBe(before);
    expect(await call(s, "GET", COMPANY_PATH, OWNER_A)).toEqual({ stays: false });
  });

  it("a project's switch: its admin (grant: administrator) or a company owner or admin sets it; a developer reads only; a person with no part in it gets 'No such project.'", async () => {
    const s = await setup();
    expect(await call(s, "GET", PROJECT_PATH, DEV_A)).toMatchObject({ enabled: true, canChange: false });
    expect(await call(s, "PUT", PROJECT_PATH, MAINT_A, { enabled: false })).toMatchObject({ enabled: false, own: false, reason: "project_setting", canChange: true });
    await expect(call(s, "PUT", PROJECT_PATH, DEV_A, { enabled: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(call(s, "GET", PROJECT_PATH, STRANGER_A)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(call(s, "PUT", PROJECT_PATH, STRANGER_A, { enabled: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await call(s, "PUT", PROJECT_PATH, ADMIN_A, { enabled: true })).toMatchObject({ enabled: true, canChange: true });
    expect(await call(s, "PUT", PROJECT_PATH, OWNER_A, { enabled: false })).toMatchObject({ enabled: false, canChange: true });
  });

  it("a person of no company, a removed member and a demoted owner are refused on the very next call (membership read live)", async () => {
    const s = await setup();
    await expect(call(s, "GET", COMPANY_PATH, id(99))).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    const row = s.rows.get(`signin|COMPANY_MEMBER#${OWNER_A}|COMPANY`)!;
    s.rows.set(`signin|COMPANY_MEMBER#${OWNER_A}|COMPANY`, { ...row, role: "member" });
    await expect(call(s, "PUT", COMPANY_PATH, OWNER_A, { stays: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    s.rows.delete(`signin|COMPANY_MEMBER#${OWNER_A}|COMPANY`);
    await expect(call(s, "GET", COMPANY_PATH, OWNER_A)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });
});

describe("the value written here is the value the gates read", () => {
  it("the lessons runtime's own settings (what AK3's localToolsGate and #1033's wiki tools gate are handed) see each change on the very next call", async () => {
    const s = await setup();
    await s.root.app.runtimeFor(A);
    const runtime = lessonsRuntimeOf(A);
    const gates = { localTools: runtime.localTools, settings: runtime.settings };
    const key = { workspaceId: A, project: "payments" };
    expect(await localToolsGate(gates, key)).toMatchObject({ kind: "on" });
    await call(s, "PUT", PROJECT_PATH, MAINT_A, { enabled: false });
    expect(await localToolsGate(gates, key)).toEqual({ kind: "off", reason: "project_setting" });
    expect(await wikiToolsGate(gates, key)).toBeUndefined();
    await call(s, "PUT", PROJECT_PATH, MAINT_A, { enabled: true });
    expect(await localToolsGate(gates, key)).toMatchObject({ kind: "on" });
    await call(s, "PUT", COMPANY_PATH, OWNER_A, { stays: true });
    expect(await localToolsGate(gates, key)).toEqual({ kind: "off", reason: "company_stays" });
    expect(await wikiToolsGate(gates, key)).toEqual({ status: "off", reason: "company_stays", message: KNOWLEDGE_STAYS_SENTENCE });
    // The row the wiki tools gate falls back to when a company has no lessons runtime is this very row.
    expect(await s.world.store.get({ pk: teamRecordPk(A), sk: "LESSONSET#COMPANYSTAY" })).toMatchObject({ stays: true });
    expect(await call(s, "GET", PROJECT_PATH, DEV_A)).toMatchObject({ enabled: false, reason: "company_stays", companyStays: true });
    await call(s, "PUT", COMPANY_PATH, OWNER_A, { stays: false });
    expect(await wikiToolsGate(gates, key)).toBeUndefined();
  });

  it("the source reads the stored items through the same class the gates use, over the registry's own storage", () => {
    const root = readFileSync("packages/broker/src/aws/core-engine-root.ts", "utf8");
    expect(root).toMatch(/knowledgeSwitch: createKnowledgeSwitchApi\(\{\n\s+companyOf: async \(caller\) => await membershipOf\(caller\.personId\),\n\s+store: async \(\) => \(await app\.registry\(\)\)\.require\("storage"\),\n\s+audit: async \(\) => \(await app\.registry\(\)\)\.require\("audit-sink"\),/u);
    expect(root).toContain("new DocumentLocalToolsSettings(registry.require(\"storage\"))");
  });
});

describe("two companies and the ledger", () => {
  it("company B's owner changes B only; the same project name is two switches; neither company reads the other's project", async () => {
    const s = await setup();
    await call(s, "PUT", PROJECT_PATH, MAINT_A, { enabled: false });
    await call(s, "PUT", COMPANY_PATH, OWNER_B, { stays: true });
    expect(await call(s, "GET", COMPANY_PATH, OWNER_A)).toEqual({ stays: false });
    expect(await call(s, "GET", COMPANY_PATH, OWNER_B)).toEqual({ stays: true });
    const bState = await call(s, "GET", PROJECT_PATH, MAINT_B);
    expect(bState).toMatchObject({ enabled: false, reason: "company_stays", companyStays: true });
    // A's project switch (set off above) is not B's: B's project has made no choice of its own.
    expect(bState).not.toHaveProperty("own");
    expect(await call(s, "GET", PROJECT_PATH, MAINT_A)).toMatchObject({ enabled: false, own: false, reason: "project_setting", companyStays: false });
    expect(await s.world.store.get({ pk: teamRecordPk(B), sk: "LESSONSET#COMPANYSTAY" })).toMatchObject({ stays: true });
    expect(await s.world.store.get({ pk: teamRecordPk(A), sk: "LESSONSET#COMPANYSTAY" })).toBeUndefined();
    // B's project "only-b" is not in A's catalog: A's owner is told there is no such project; B's own owner sees it.
    await expect(call(s, "GET", "/v1/dev/projects/only-b/lessons/local-tools", OWNER_A)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await call(s, "GET", "/v1/dev/projects/only-b/lessons/local-tools", OWNER_B)).toMatchObject({ canChange: true });
  });

  it("every change is on the audit ledger (who, scope and the new value), recorded for the company that made it", async () => {
    const s = await setup();
    const start = s.world.audit.length;
    await call(s, "PUT", COMPANY_PATH, OWNER_A, { stays: true });
    await call(s, "PUT", PROJECT_PATH, MAINT_A, { enabled: false });
    await call(s, "PUT", COMPANY_PATH, OWNER_B, { stays: true });
    const events = s.world.audit.slice(start).filter((event) => event.action === "lesson.local_tools_switched");
    expect(events.map((event) => [event.companyId, event.details?.["scope"], event.details?.["enabled"]])).toEqual([[A, "company", false], [A, "project", false], [B, "company", false]]);
    expect(events.map((event) => JSON.stringify(event.actor))).toEqual([expect.stringContaining(OWNER_A), expect.stringContaining(MAINT_A), expect.stringContaining(OWNER_B)]);
    expect(JSON.stringify(events)).not.toContain("payments");
  });
});
