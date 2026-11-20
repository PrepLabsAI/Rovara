// L4-HW3b: the hosted broker reads each project's own merge rules (the record the developer API's code-settings route saves) for the How we work page and for merge tracking, instead of
// no settings (the page was not served) and Code's defaults (merge tracking). The root, registry and runtime are real; the deployment adapters are the fake world's and the State table is a
// map of items. Laptop: its rules stay fixed (`fixedCodeSettings`, local/app/app.ts:395-398 and local/app/tracking.ts:34), checked at the end.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { DEFAULT_CODE_SETTINGS, PLAYBOOK_FILE_PATH, IMPLICIT_COMPANY_ID, projectRevisionKey, orgProjectCatalogKey, type JsonValue, type OrgId } from "@agentx/contracts";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { codeSettingsKey, codeSettingsReader, companyCodeSettingsReader } from "../../packages/broker/src/aws/project-code-settings.js";
import { createBrokerCoreServices } from "../../packages/broker/src/aws/core-job-services.js";
import { createFakeWorld, FAKE_COMPANY } from "../support/core-host-fakes.js";
import { host as serviceHost, ORG as SERVICE_ORG } from "../support/service-host.js";

const adapters = vi.hoisted(() => ({ modules: [] as unknown[] }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", () => ({ codeAdapterModules: () => adapters.modules }));
vi.mock("../../packages/broker/src/core-host/hosted-modules.js", async (original) => ({ ...await original<object>(), hostedSecurityModules: () => [] }));

const A = FAKE_COMPANY as OrgId;
const B = "org_corehost00000000000b" as OrgId;
const STATE = "state-table";
const SIGN_IN = "signin-table";
const secret = Buffer.alloc(32, 7);
const PROJECT = { name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }] };
const saved = (companyId: string, project: string, settings: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ table: STATE, item: { ...codeSettingsKey(companyId, project), entityType: "PROJECT_CODE_SETTINGS", companyId, project, settings, ...extra } });
const A_RULES = { allowSelfApproval: true, mergeMethod: "merge", codeReviewers: ["alice-reviewer"], revision: 3 };
const member = (personId: string, companyId: string) => ({ table: SIGN_IN, item: { pk: `COMPANY_MEMBER#${personId}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId, companyId, role: "owner", joinedAt: "2026-11-01T00:00:00.000Z" } });
const grant = (personId: string, project: string) => ({ table: STATE, item: { pk: `MEMBER#${personId}`, sk: `PROJECT#${project}`, projectName: project, role: "developer" } });

/** A document client over a map of items by table and key; every read is recorded. */
function tables(items: Array<{ table: string; item: Record<string, unknown> }>) {
  const rows = new Map(items.map(({ table, item }) => [`${table}|${String(item["pk"])}|${String(item["sk"])}`, item]));
  const reads: string[] = [];
  return { reads, client: { async send(command: unknown) {
    if (!(command instanceof GetCommand)) throw new Error("only reads");
    const input = command.input as { TableName: string; Key: { pk: string; sk: string } };
    reads.push(`${input.TableName}|${input.Key.pk}`);
    return { Item: rows.get(`${input.TableName}|${input.Key.pk}|${input.Key.sk}`) };
  } } };
}

describe("the hosted reader of a project's merge rules", () => {
  const store = (t: ReturnType<typeof tables>) => ({ documentClient: t.client, tableName: STATE });

  it("reads THE company's own project record; another company's same-named project never shares it; a project with none saved has Code's defaults", async () => {
    const t = tables([saved(A, "payments", A_RULES), saved(B, "payments", { ...DEFAULT_CODE_SETTINGS, mergeMethod: "squash", revision: 1 })]);
    const readerA = companyCodeSettingsReader(store(t), A);
    expect(await readerA.read(A, "payments")).toEqual(A_RULES);
    expect(await companyCodeSettingsReader(store(t), B).read(B, "payments")).toMatchObject({ mergeMethod: "squash", revision: 1, codeReviewers: [] });
    expect(await readerA.read(A, "other")).toEqual(DEFAULT_CODE_SETTINGS);
    expect(t.reads).toEqual([`${STATE}|CODE_SETTINGS#${A}#payments`, `${STATE}|CODE_SETTINGS#${B}#payments`, `${STATE}|CODE_SETTINGS#${A}#other`]);
  });

  it("a runtime bound to one company refuses to be asked about another, reading nothing", async () => {
    const t = tables([saved(B, "payments", A_RULES)]);
    await expect(companyCodeSettingsReader(store(t), A).read(B, "payments")).rejects.toThrow("the project's merge rules could not be read");
    expect(t.reads).toEqual([]);
  });

  it("refuses a record that names another company or does not parse, never applying it", async () => {
    const t = tables([saved(A, "payments", A_RULES, { companyId: B }), saved(A, "wrong", A_RULES, { project: "elsewhere" }), saved(A, "junk", { mergeMethod: "yolo" })]);
    const reader = companyCodeSettingsReader(store(t), A);
    for (const project of ["payments", "wrong", "junk"]) await expect(reader.read(A, project), project).rejects.toThrow("the project's merge rules could not be read");
  });
});

describe("merge tracking on the hosted job services", () => {
  it("asks for the tracked task's own company and project settings (never Code's defaults), once per task pass", async () => {
    const t = tables([saved(SERVICE_ORG, "web", { allowSelfApproval: true, mergeMethod: "merge", codeReviewers: ["bob"], revision: 2 })]);
    const w = await serviceHost();
    const inner = companyCodeSettingsReader({ documentClient: t.client, tableName: STATE }, SERVICE_ORG);
    const answers: unknown[] = [];
    const settings = { read: async (orgId: OrgId, project: string) => { const answer = await inner.read(orgId, project); answers.push(answer); return answer; } };
    const services = createBrokerCoreServices({ companyId: SERVICE_ORG, flow: w.h.flow, registry: w.registry, ciMode: async () => "their_ci_fix" as const, people: w.people, settings });
    expect(await services["merge-tracking"].pass({ budgetMs: 1000 })).toMatchObject({ attempted: 1 });
    expect(t.reads).toEqual([`${STATE}|CODE_SETTINGS#${IMPLICIT_COMPANY_ID}#web`]);
    expect(answers).toEqual([{ allowSelfApproval: true, mergeMethod: "merge", codeReviewers: ["bob"], revision: 2 }]);
  });
});

describe("the hosted broker's core root and how we work", () => {
  async function setup(options: { codeSettings: boolean }) {
    const world = createFakeWorld();
    adapters.modules = [...world.modules];
    world.host.model.commit("main", { [PLAYBOOK_FILE_PATH]: "version: 1\nrules: HOSTED-RULE" });
    // Company B has its own project of the same name, plus one only it has.
    for (const [company, name] of [[A, "payments"], [B, "payments"], [B, "b-only"]] as const) {
      await world.store.put({ item: { ...projectRevisionKey(company, name, 1), entityType: "PROJECT", definition: JSON.parse(JSON.stringify({ ...PROJECT, name })) as JsonValue } });
      await world.store.put({ item: { ...orgProjectCatalogKey(company, name), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
    }
    const t = tables([member("dev-a", A), member("dev-b", B), grant("dev-a", "payments"), grant("dev-b", "payments"), grant("dev-b", "b-only"), grant("dev-a", "b-only"),
      saved(A, "payments", A_RULES), saved(B, "payments", { ...DEFAULT_CODE_SETTINGS, allowSelfApproval: false, mergeMethod: "squash", codeReviewers: ["only-b-reviewer"], revision: 1 })]);
    const root = createBrokerCoreRoot({
      env: { ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: "all" },
      documentClient: t.client, stateTableName: STATE, signInTableName: SIGN_IN, callbackSigningKey: secret.toString(), repositoryGrantKey: secret,
      codeModules: () => ({}) as never, repositoryCredential: async () => { throw new Error("unused"); }, origin: () => "https://api.example", log: () => undefined,
      now: () => new Date(world.clock.now), ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
      services: () => Object.fromEntries(["merge-tracking", "session-sweep", "notify-deliver", "admission-hold-sweep"].map((name) => [name, { pass: async () => ({}) }])),
      ...(options.codeSettings ? { codeSettings: codeSettingsReader({ documentClient: t.client, tableName: STATE }) } : {}),
    });
    const get = async (person: string, path: string) => await root.coreApp!.route({ method: "GET", path, headers: {} }, { developerId: person, sessionId: "s", name: person });
    return { get, t };
  }

  it("serves the page with each company's OWN saved rules, and nothing of the other company's", async () => {
    const { get } = await setup({ codeSettings: true });
    const a = await get("dev-a", "/v1/app/projects/payments/how-we-work");
    expect(a?.statusCode).toBe(200);
    expect(a!.body).toContain("Self-approval: allowed");
    expect(a!.body).toContain("Merge method: merge");
    expect(a!.body).toContain("alice-reviewer");
    expect(a!.body).not.toContain("only-b-reviewer");
    const b = await get("dev-b", "/v1/app/projects/payments/how-we-work");
    expect(b?.statusCode).toBe(200);
    expect(b!.body).toContain("only-b-reviewer");
    expect(b!.body).toContain("Self-approval: not allowed");
    expect(b!.body).toContain("Merge method: squash");
    expect(b!.body).not.toContain("alice-reviewer");
  });

  it("refuses a project that is only in another company's catalog (even with a grant row for it) in the same words as a missing one, reading no settings for it", async () => {
    const { get, t } = await setup({ codeSettings: true });
    const before = t.reads.length;
    const refused = await get("dev-a", "/v1/app/projects/b-only/how-we-work");
    const missing = await get("dev-a", "/v1/app/projects/ghost/how-we-work");
    expect(refused?.statusCode).toBe(404);
    expect(refused!.body).toBe(missing!.body);
    expect(t.reads.slice(before).some((read) => read.includes("CODE_SETTINGS"))).toBe(false);
    // Not a member of any company: the sign-in refusal.
    expect((await get("dev-c", "/v1/app/projects/payments/how-we-work"))?.statusCode).toBe(401);
  });

  it("is not served when the deployment passes no settings (the page never says anything about the company it cannot read)", async () => {
    const { get } = await setup({ codeSettings: false });
    expect((await get("dev-a", "/v1/app/projects/payments/how-we-work"))?.statusCode).toBe(404);
  });
});

describe("what the deployed broker passes", () => {
  const broker = readFileSync("packages/broker/src/aws/broker.ts", "utf8");
  it("gives the core root the stored settings for how we work, and the company's own reader to its merge tracker", () => {
    expect(broker).toMatch(/codeSettings: codeSettingsReader\(\{ documentClient, tableName: requiredEnvironment\("STATE_TABLE_NAME"\) \}\)/u);
    // Batch b18: the hosted services (createHostedBrokerCoreServices) take more seams after `settings` (human edit, thread moments, notification).
    expect(broker).toMatch(/createHostedBrokerCoreServices\(\{ companyId, flow, registry, ciMode: wiring\.ciMode!,\s*settings: companyCodeSettingsReader\(\{ documentClient, tableName: requiredEnvironment\("STATE_TABLE_NAME"\) \}, companyId\),/u);
  });
});
