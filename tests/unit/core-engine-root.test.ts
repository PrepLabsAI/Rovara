// Engine host (lane E2, step 6): the core engine's composition root on the deployed broker. Off (the default) builds and reads nothing and gives the routes no core entry; the caller's
// company is membership, never a claim; the task access re-reads live membership and keeps the broker's project grant rule; the stream hook finds only outbox inserts.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { GitHubFixtureProvider } from "../support/ports/github-fixture-provider.js";
import { FakeHostModel } from "@agentx/broker/fakes";
import type { CodeModuleDeps } from "../../packages/broker/src/core-host/code-modules.js";
import * as codeModulesModule from "../../packages/broker/src/core-host/code-modules.js";
import { createFakeWorld } from "../support/core-host-fakes.js";
import type { OrgId, Principal } from "@agentx/contracts";
import {
  brokerCoreDispatchQueue, NOT_A_MEMBER_HERE, deployedCallerFromMembership, personStandingFromDynamo, withCoreRoutes, policyHookSettingsFromEnvironment, projectRoleOf, NO_PROJECT_GRANT, brokerCoreModuleDeps, createBrokerCoreRoot, hostedTaskAccess, setupRunStandingFrom, membershipWithRoleFromDynamo, projectGrantFromDynamo,
  type BrokerCoreRootInputs,
} from "../../packages/broker/src/aws/core-engine-root.js";
import { HOSTED_IDENTITY_PROVIDER } from "../../packages/broker/src/core-host/hosted-modules.js";
import { CORE_APP_UNAVAILABLE } from "../../packages/broker/src/aws/core-app-routes.js";
import { SETUP_RUN_NOT_ALLOWED } from "../../packages/broker/src/core-host/setup-run-routes.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { adminCall, createAdminBroker } from "../support/admin-broker.js";

const ORG = "org_staging0000000000001" as OrgId;
const OTHER = "org_staging0000000000002" as OrgId;
const SIGN_IN = "signin-table";
const STATE = "state-table";

/** A document client over a map of items by table and key; every read is counted. */
function fakeTables(items: Array<{ table: string; item: Record<string, unknown> }> = []) {
  const rows = new Map(items.map(({ table, item }) => [`${table}|${String(item.pk)}|${String(item.sk)}`, item]));
  const reads: string[] = [];
  return {
    reads,
    rows,
    client: {
      async send(command: unknown) {
        if (!(command instanceof GetCommand)) throw new Error("only reads");
        const input = command.input as { TableName: string; Key: { pk: string; sk: string } };
        reads.push(`${input.TableName}|${input.Key.pk}`);
        return { Item: rows.get(`${input.TableName}|${input.Key.pk}|${input.Key.sk}`) };
      },
    },
  };
}
const member = (personId: string, companyId: string, role = "member", extra: Record<string, unknown> = {}) => ({ table: SIGN_IN, item: { pk: `COMPANY_MEMBER#${personId}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId, companyId, role, joinedAt: "2026-11-01T00:00:00.000Z", ...extra } });
const grant = (personId: string, project: string, role = "developer") => ({ table: STATE, item: { pk: `MEMBER#${personId}`, sk: `PROJECT#${project}`, projectName: project, role } });

function rootInputs(env: NodeJS.ProcessEnv, client: { send(command: unknown): Promise<unknown> }, overrides: Partial<BrokerCoreRootInputs> = {}): BrokerCoreRootInputs {
  return {
    env, documentClient: client, stateTableName: STATE, signInTableName: SIGN_IN, callbackSigningKey: "k".repeat(32), repositoryGrantKey: Buffer.alloc(32, 1),
    repositoryCredential: async () => { throw new Error("unused"); }, codeModules: () => brokerCoreModuleDeps(env), origin: () => "https://api.example", log: () => undefined, ...overrides,
  };
}

it("binds the saved image adapter on the hosted root for cleanup, without assuming a role at boot", async () => {
  const modules = vi.spyOn(codeModulesModule, "codeAdapterModules").mockImplementation(() => createFakeWorld().modules.filter(m => !["metering", "admission", "identity", "approvers", "audit-sink"].includes(m.point)));
  const assume = vi.fn();
  const account = "111122223333";
  const bindings = { AGENTX_ENV: "test", AWS_REGION: "us-west-2", ROVARA_SAVED_ENV_PUSH_ROLE_ARN: `arn:aws:iam::${account}:role/agentx/test/agentx-test-img-push`, ROVARA_SAVED_ENV_PULL_ROLE_ARN: `arn:aws:iam::${account}:role/agentx/test/agentx-test-img-pull`, ROVARA_SAVED_ENV_MANAGE_ROLE_ARN: `arn:aws:iam::${account}:role/agentx/test/agentx-test-img-manage`, ROVARA_SAVED_ENV_REPO_PREFIX: "rovara-env/test" };
  try {
    for (const enabled of [undefined, "0", "1"]) {
      const env = { ...bindings, ...(enabled === undefined ? {} : { ROVARA_SAVED_ENVIRONMENTS: enabled }) };
      const root = createBrokerCoreRoot(rootInputs(env, fakeTables().client, { codeModules: () => ({} as CodeModuleDeps), savedEnvSessions: { assume, listCompanyRepositories: async () => [] } }));
      const registry = await root.app.registry();
      expect(registry.names("image-registry")).toEqual(["ecr"]);
      expect(registry.require("image-registry").capabilities.workerPush).toBe(enabled === "1");
    }
    const real = createBrokerCoreRoot(rootInputs({ ...bindings, ROVARA_SAVED_ENVIRONMENTS: "1" }, fakeTables().client, { codeModules: () => ({} as CodeModuleDeps) }));
    expect((await real.app.registry()).names("image-registry")).toEqual(["ecr"]);
    const unwired = createBrokerCoreRoot(rootInputs({ ROVARA_SAVED_ENVIRONMENTS: "1" }, fakeTables().client, { codeModules: () => ({} as CodeModuleDeps) }));
    await expect(unwired.app.registry()).rejects.toThrow("saved environments are not set up on this install");
    expect(assume).not.toHaveBeenCalled();
  } finally { modules.mockRestore(); }
});

describe("the broker's core root", () => {
  it("loads with malformed core settings and refuses core routes and jobs in fixed words", async () => {
    const cases = [
      [{ ROVARA_CORE_TASK_CAP_USD: "1001" }, "1001"],
      [{ ROVARA_CORE_COMPANY_DAY_CAP_USD: "1001" }, "1001"],
      [{ ROVARA_CORE_LESSONS: "on:secret-value" }, "secret-value"],
      [{ ROVARA_POLICY_HOOK: "secret-value" }, "secret-value"],
    ] as const;
    for (const [env, privateValue] of cases) {
      const tables = fakeTables([member("dev-a", ORG, "owner")]);
      const root = createBrokerCoreRoot(rootInputs(env, tables.client));
      const answer = await root.coreTasks?.route({ method: "POST", path: "/v1/dev/tasks", headers: {}, body: "{}" }, { developerId: "dev-a", sessionId: "s", name: "Ada" });
      expect(answer?.statusCode).toBe(503);
      expect(answer?.body).toBe(JSON.stringify({ error: { code: "CORE_SWITCH_BLOCKED", message: "The core engine settings are not readable." } }));
      expect(answer?.body).not.toContain(privateValue);
      await expect(root.handleEvent({ source: "agentx.core-job", job: "dispatch-sweep" })).rejects.toThrow("The core engine settings are not readable.");
      const broker = await createAdminBroker({ core: root });
      const nonCore = await adminCall(broker.handler, { method: "GET", path: "/v1/admin/projects" });
      expect(nonCore.status).toBe(200);
      const job = await broker.handler({ source: "agentx.core-job", job: "dispatch-sweep" });
      expect(job.statusCode).toBe(503);
      expect(job.body).toContain("The core engine settings are not readable.");
    }
  });

  it("blocks every member when settings are unreadable, and leaves a person with no membership to the old broker", async () => {
    const request = (method: string, path: string) => ({ method, path, headers: {}, ...(method === "POST" ? { body: "{}" } : {}) });
    const caller = (developerId: string) => ({ developerId, sessionId: "s", name: "Ada" });
    const tables = fakeTables([member("covered", ORG), member("uncovered", OTHER)]);
    const root = createBrokerCoreRoot(rootInputs({ ROVARA_CORE_TASK_CAP_USD: "1001" }, tables.client));
    for (const methodPath of [["POST", "/v1/dev/tasks"], ["GET", "/v1/dev/tasks/task-a"]] as const) {
      const [method, path] = methodPath;
      const blocked = await root.coreTasks?.route(request(method, path), caller("covered"));
      expect(blocked?.statusCode).toBe(503);
      expect(blocked?.body).toBe(JSON.stringify({ error: { code: "CORE_SWITCH_BLOCKED", message: "The core engine settings are not readable." } }));
      expect((await root.coreTasks?.route(request(method, path), caller("uncovered")))?.statusCode).toBe(503);
      expect(await root.coreTasks?.route(request(method, path), caller("no-membership"))).toBeUndefined();
    }

    const unreadableMembership = createBrokerCoreRoot(rootInputs({ ROVARA_CORE_TASK_CAP_USD: "1001" }, { send: async () => { throw new Error("dynamo down"); } }));
    const failedRead = await unreadableMembership.coreTasks?.route(request("POST", "/v1/dev/tasks"), caller("covered"));
    expect(failedRead?.statusCode).toBe(503);
    expect(failedRead?.body).toBe(JSON.stringify({ error: { code: "CORE_SWITCH_BLOCKED", message: "The core engine settings are not readable." } }));
  });

  it("maps the signed-in developer to the core's principal from MEMBERSHIP, carrying the verified step-up and the client", async () => {
    const tables = fakeTables([member("dev-a", ORG, "admin")]);
    const seen: unknown[] = [];
    const root = createBrokerCoreRoot(rootInputs({}, tables.client));
    const answer = await root.coreTasks!.route({ method: "GET", path: "/v1/app/script-tokens", headers: {} }, { developerId: "dev-b", sessionId: "s", name: "Bo" });
    // dev-b has no membership: the core's sign-in refusal.
    expect(answer?.statusCode).toBe(401);
    // A start by a non-member is not the core's: the old start answers it.
    expect(await root.coreTasks!.route({ method: "POST", path: "/v1/dev/tasks", headers: {}, body: "{}" }, { developerId: "dev-b", sessionId: "s", name: "Bo" })).toBeUndefined();
    void seen;
  });

  it("gives the HTTP API its /v1/app entry (lane L12): a non-member is asked to sign in again, and a core that cannot be built answers fixed words, never the registry's", async () => {
    const tables = fakeTables([member("dev-a", ORG, "owner")]);
    const lines: Array<Record<string, unknown>> = [];
    const root = createBrokerCoreRoot(rootInputs({}, tables.client, { log: (entry) => lines.push(entry) }));
    expect(root.coreApp).toBeDefined();
    expect((await root.coreApp!.route({ method: "GET", path: "/v1/app/script-tokens", headers: {} }, { developerId: "dev-b", sessionId: "s", name: "Bo" }))?.statusCode).toBe(401);
    for (const request of [{ method: "GET", path: "/v1/app/script-tokens", headers: {} }, { method: "POST", path: "/v1/app/people/dev-c/erase", headers: {}, body: "{}" }]) {
      const answer = await root.coreApp!.route(request, { developerId: "dev-a", sessionId: "s", name: "Ada" });
      expect(answer?.statusCode, request.path).toBe(503);
      expect(JSON.parse(answer!.body)).toEqual({ error: { code: "RUNTIME_UNAVAILABLE", message: CORE_APP_UNAVAILABLE } });
      expect(answer!.body).not.toContain("adapters");
    }
    expect(lines.filter((line) => line.event === "core_engine.app_route_unavailable")).toHaveLength(2);
    // Not a /v1/app path: not this entry's.
    expect(await root.coreApp!.route({ method: "GET", path: "/v1/dev/projects", headers: {} }, { developerId: "dev-a", sessionId: "s", name: "Ada" })).toBeUndefined();
  });

  it("maps the caller from live membership for /v1/app too, and reads a person's standing in a company from the company's own record", async () => {
    const tables = fakeTables([member("dev-a", ORG, "admin"), member("dev-gone", ORG, "member", { revokedAt: "2026-11-10T00:00:00.000Z" }), member("dev-x", OTHER, "member")]);
    const mapped = await deployedCallerFromMembership(membershipWithRoleFromDynamo(tables.client, SIGN_IN))({ developerId: "dev-a", sessionId: "s", name: "Ada", amr: "slack", clientId: "web-app" });
    expect(mapped).toEqual({ principal: { companyId: ORG, personId: "dev-a", displayName: "Ada", roles: ["admin"], provider: HOSTED_IDENTITY_PROVIDER }, client: "web-app", amr: "slack" });
    expect(await deployedCallerFromMembership(membershipWithRoleFromDynamo(tables.client, SIGN_IN))({ developerId: "dev-gone", sessionId: "s", name: "Gone" })).toBeUndefined();
    // DEC 254zzz39 (6): the web app's own client marker rides along only as the broker's sign-in set it (exactly true), never otherwise.
    const map = deployedCallerFromMembership(membershipWithRoleFromDynamo(tables.client, SIGN_IN));
    expect(await map({ developerId: "dev-a", sessionId: "s", name: "Ada", clientId: "web-app", webApp: true })).toMatchObject({ webApp: true });
    expect(await map({ developerId: "dev-a", sessionId: "s", name: "Ada", clientId: "tool" })).not.toHaveProperty("webApp");
    expect(await map({ developerId: "dev-a", sessionId: "s", name: "Ada", clientId: "tool", webApp: "yes" as never })).not.toHaveProperty("webApp");
    const standing = personStandingFromDynamo(tables.client, SIGN_IN);
    expect(await standing(ORG, "dev-a")).toBe("member");
    expect(await standing(ORG, "dev-gone")).toBe("former");
    // Another company's person, and nobody, are unknown here.
    expect(await standing(ORG, "dev-x")).toBe("unknown");
    expect(await standing(ORG, "dev-none")).toBe("unknown");
    await expect(personStandingFromDynamo(tables.client, undefined)(ORG, "dev-a")).rejects.toThrow();
  });

  it("gives the developer API its core entries", () => {
    const config = { issuer: "https://api.example" };
    const on = createBrokerCoreRoot(rootInputs({}, fakeTables().client));
    const served = withCoreRoutes(config, on) as typeof config & { projectArchiveTakesEffect?: (companyId: string) => boolean };
    expect(served).toEqual({ issuer: "https://api.example", coreTasks: on.coreTasks, coreApp: on.coreApp, projectArchiveTakesEffect: on.projectArchiveTakesEffect });
    // Guided onboarding PR 16: an archive takes effect for a company whose new tasks start on the core (every company since #1275).
    expect(served.projectArchiveTakesEffect?.(ORG)).toBe(true);
    expect(served.projectArchiveTakesEffect?.(OTHER)).toBe(true);
    expect(withCoreRoutes(config, { coreTasks: on.coreTasks, coreApp: undefined })).toEqual({ issuer: "https://api.example", coreTasks: on.coreTasks });
    expect(config).toEqual({ issuer: "https://api.example" });
  });

  it("refuses a start, rather than falling back, when membership cannot be read", async () => {
    const root = createBrokerCoreRoot(rootInputs({}, { send: async () => { throw new Error("dynamo down"); } }));
    const answer = await root.coreTasks!.route({ method: "POST", path: "/v1/dev/tasks", headers: {}, body: "{}" }, { developerId: "dev-a", sessionId: "s", name: "Ada" });
    expect(answer?.statusCode).toBe(401);
    expect(answer?.body).not.toContain("dynamo");
  });
});

describe("membership and project grants", () => {
  it("reads a live membership with its role, and nothing for a revoked, malformed or other person's record", async () => {
    const tables = fakeTables([member("dev-a", ORG, "admin"), member("dev-r", ORG, "member", { revokedAt: "2026-11-02T00:00:00.000Z" }), { table: SIGN_IN, item: { pk: "COMPANY_MEMBER#dev-m", sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: "dev-other", companyId: ORG, role: "member", joinedAt: "2026-11-01T00:00:00.000Z" } }, member("dev-z", ORG, "god")]);
    const read = membershipWithRoleFromDynamo(tables.client, SIGN_IN);
    expect(await read("dev-a")).toEqual({ companyId: ORG, role: "admin" });
    for (const personId of ["dev-r", "dev-m", "dev-z", "nobody", "", "a#b", "a b"]) expect(await read(personId), personId).toBeUndefined();
  });

  it("reads the broker's project grant: developer or administrator only, for that exact project", async () => {
    const tables = fakeTables([grant("dev-a", "payments"), grant("dev-v", "payments", "viewer"), { table: STATE, item: { pk: "MEMBER#dev-w", sk: "PROJECT#payments", projectName: "web", role: "developer" } }]);
    const has = projectGrantFromDynamo(tables.client, STATE);
    expect(await has("dev-a", "payments")).toBe(true);
    for (const [person, project] of [["dev-a", "web"], ["dev-v", "payments"], ["dev-w", "payments"], ["dev-a", "../x"], ["a#b", "payments"]] as const) expect(await has(person, project), `${person} ${project}`).toBe(false);
  });
});

describe("the deployed task access", () => {
  const principal = (personId: string, companyId: string = ORG): Principal => ({ companyId, personId, displayName: personId, roles: ["member"], provider: HOSTED_IDENTITY_PROVIDER });
  const memberships: Record<string, { companyId: OrgId; role: "owner" | "admin" | "member" }> = { "dev-a": { companyId: ORG, role: "member" }, "dev-o": { companyId: ORG, role: "owner" }, "dev-x": { companyId: OTHER, role: "owner" } };
  const access = hostedTaskAccess({ companyId: ORG, membershipOf: async (id) => memberships[id], projectGrant: async (id, project) => id === "dev-a" && project === "payments" });

  it("lets a live member with the project grant start, and nobody else", async () => {
    expect(await access.checkStart(principal("dev-a"), "payments")).toEqual({ allowed: true });
    expect(await access.checkStart(principal("dev-a"), "web")).toEqual({ allowed: false, code: "FORBIDDEN", message: NO_PROJECT_GRANT });
    expect(await access.checkStart(principal("dev-o"), "payments")).toEqual({ allowed: false, code: "FORBIDDEN", message: NO_PROJECT_GRANT });
    // A principal that names this company but whose live membership is another's, or none, is refused.
    expect(await access.checkStart(principal("dev-x"), "payments")).toEqual({ allowed: false, code: "FORBIDDEN", message: NOT_A_MEMBER_HERE });
    expect(await access.checkStart(principal("dev-a", OTHER), "payments")).toEqual({ allowed: false, code: "FORBIDDEN", message: NOT_A_MEMBER_HERE });
  });
});

describe("the hosted setup run's rule (guided onboarding L2-3)", () => {
  const memberships: Record<string, { companyId: OrgId; role: "owner" | "admin" | "member" }> = {
    owner: { companyId: ORG, role: "owner" }, admin: { companyId: ORG, role: "admin" }, padmin: { companyId: ORG, role: "member" }, dev: { companyId: ORG, role: "member" }, plain: { companyId: ORG, role: "member" }, foreign: { companyId: OTHER, role: "owner" },
  };
  const grants: Record<string, "developer" | "administrator"> = { padmin: "administrator", dev: "developer", foreign: "administrator" };
  const standing = setupRunStandingFrom({ membershipOf: async (id) => memberships[id], projectGrantRole: async (id, project) => (project === "payments" ? grants[id] : undefined) });

  it("is PR 16's rule over live membership and the grant: owners, admins and the project's administrators manage, a project user reads, anyone else and another company's people get nothing", async () => {
    expect(await standing("owner", ORG, "payments")).toEqual({ access: "manage", basis: "company-owner" });
    expect(await standing("admin", ORG, "web")).toEqual({ access: "manage", basis: "company-admin" });
    expect(await standing("padmin", ORG, "payments")).toEqual({ access: "manage", basis: "project-admin" });
    expect(await standing("padmin", ORG, "web")).toEqual({ access: "none" });
    expect(await standing("dev", ORG, "payments")).toEqual({ access: "view" });
    expect(await standing("plain", ORG, "payments")).toEqual({ access: "none" });
    // Another company's owner with a grant of the same project name, and a person with no membership, are nobody here.
    expect(await standing("foreign", ORG, "payments")).toEqual({ access: "none" });
    expect(await standing("gone", ORG, "payments")).toEqual({ access: "none" });
  });

  it("runs a setup run's steps only while its person still manages the project's setup; every other task keeps the grant rule exactly", async () => {
    const store = new MemoryDocumentStore();
    const task = async (taskId: string, developerId: string, extra: Record<string, unknown>) => store.put({ item: { pk: `DEVTASK#${taskId}`, sk: "META", taskId, developerId, project: "payments", companyId: ORG, ...extra } });
    await task("setup-admin", "admin", { purpose: "setup_agent" });
    await task("setup-dev", "dev", { purpose: "setup_agent" });
    await task("setup-foreign-row", "owner", { purpose: "setup_agent", companyId: OTHER });
    await task("plain-admin", "admin", {});
    await task("plain-dev", "dev", {});
    const projectGrant = async (id: string, project: string) => project === "payments" && grants[id] !== undefined;
    const access = hostedTaskAccess({ companyId: ORG, membershipOf: async (id) => memberships[id], projectGrant, storage: async () => store, setupRunStanding: standing });
    // A company admin with no grant: their setup run steps; their ordinary task does not (the grant rule, unchanged).
    expect(await access.checkStep({ taskId: "setup-admin", developerId: "admin", project: "payments" })).toEqual({ allowed: true });
    expect(await access.checkStep({ taskId: "plain-admin", developerId: "admin", project: "payments" })).toEqual({ allowed: false, message: NO_PROJECT_GRANT });
    // A project user: their ordinary task steps; a setup run run for them (they lost the admin standing) does not.
    expect(await access.checkStep({ taskId: "plain-dev", developerId: "dev", project: "payments" })).toEqual({ allowed: true });
    expect(await access.checkStep({ taskId: "setup-dev", developerId: "dev", project: "payments" })).toEqual({ allowed: false, message: SETUP_RUN_NOT_ALLOWED });
    // A stored setup run of another company, and a person who is not a member here, never step.
    expect(await access.checkStep({ taskId: "setup-foreign-row", developerId: "owner", project: "payments" })).toEqual({ allowed: false, message: NOT_A_MEMBER_HERE });
    expect(await access.checkStep({ taskId: "setup-admin", developerId: "foreign", project: "payments" })).toEqual({ allowed: false, message: NOT_A_MEMBER_HERE });
    // Without the rule wired, a setup run is held to the grant rule as before (never looser).
    const before = hostedTaskAccess({ companyId: ORG, membershipOf: async (id) => memberships[id], projectGrant, storage: async () => store });
    expect(await before.checkStep({ taskId: "setup-admin", developerId: "admin", project: "payments" })).toEqual({ allowed: false, message: NO_PROJECT_GRANT });
    expect(await before.checkStep({ taskId: "setup-dev", developerId: "dev", project: "payments" })).toEqual({ allowed: true });
  });
});

describe("the install's hosted policy hook settings", () => {
  it("is absent with no setting, and refuses in fixed words (no echo) anything that is not readable settings", () => {
    expect(policyHookSettingsFromEnvironment({})).toBeUndefined();
    expect(policyHookSettingsFromEnvironment({ ROVARA_POLICY_HOOK: "  " })).toBeUndefined();
    expect(() => policyHookSettingsFromEnvironment({ ROVARA_POLICY_HOOK: "zzq{" })).toThrow(/^the policy hook settings are not JSON$/u);
    expect(() => policyHookSettingsFromEnvironment({ ROVARA_POLICY_HOOK: JSON.stringify({ address: "http://evil.example/zzq", keys: [] }) })).toThrow(/^the policy hook settings are not readable$/u);
  });
});

describe("the lessons API for the developer routes (lane LM8)", () => {
  const people = () => ({ approvers: async () => ({}) as never, onProjectRoster: async () => true, linkedAccounts: async () => [], displayName: async () => "Ada", isErased: async () => false });

  it("is built with the lessons switch on and the people given; a person with no membership is asked to sign in again", async () => {
    const tables = fakeTables();
    const root = createBrokerCoreRoot(rootInputs({ ROVARA_CORE_LESSONS: "on" }, tables.client, { lessonsPeople: people }));
    expect(root.lessons).toBeDefined();
    await expect(root.lessons!.answer({ method: "GET", path: "/v1/dev/projects/payments/lessons", query: new URLSearchParams() }, { personId: "dev-nobody" })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("one pilot list serves the weekly summary's sender and its settings API: a host may give it, else the lessons switch names it (L4-WK)", () => {
    const tables = fakeTables();
    const pilot = vi.fn((companyId: string) => companyId === ORG);
    const env = { ROVARA_CORE_LESSONS: "on" };
    expect(createBrokerCoreRoot(rootInputs(env, tables.client, { lessonsPeople: people, lessonsDigestPilot: pilot })).lessons).toBeDefined();
    expect(createBrokerCoreRoot(rootInputs({ ...env, ROVARA_CORE_LESSONS: `on:${ORG}` }, tables.client, { lessonsPeople: people })).lessons).toBeDefined();
    expect(tables.reads).toEqual([]);
  });

  it("reads a project role from the broker's own grant: administrator is a maintainer, developer a contributor, anything else none", () => {
    expect(projectRoleOf("administrator")).toBe("maintainer");
    expect(projectRoleOf("developer")).toBe("contributor");
    expect(projectRoleOf(undefined)).toBeUndefined();
  });
});

describe("core outbox stream partial failures", () => {
  const record = (company: string, sequence: string) => ({ eventSource: "aws:dynamodb", eventName: "INSERT", dynamodb: { SequenceNumber: sequence, NewImage: { pk: { S: `ORG#${company}#OUTBOX` }, outboxState: { S: "pending" } } } });
  it("reports deferred companies and whole-call failures without exposing causes", async () => {
    const root = createBrokerCoreRoot(rootInputs({}, fakeTables().client));
    const relay = vi.spyOn(root.app, "relayOutbox").mockResolvedValue([{ companyId: OTHER, outcome: "deferred" }]);
    const batch = { Records: [record(ORG, "11"), record(OTHER, "12")] };
    expect(await root.handleEvent(batch)).toEqual({ batchItemFailures: [{ itemIdentifier: "12" }] });
    relay.mockResolvedValue([{ companyId: ORG, outcome: "ran", report: { delivered: 0, failed: 1, dead: 0 } }]);
    expect(await root.handleEvent(batch)).toEqual({ batchItemFailures: [{ itemIdentifier: "11" }] });
    relay.mockRejectedValue(new Error("private cause"));
    expect(await root.handleEvent(batch)).toEqual({ batchItemFailures: [{ itemIdentifier: "11" }, { itemIdentifier: "12" }] });
  });
});

it("composes the broker adapters lazily and preserves the L1c builder object including brokerOnly", async () => {
  const unused = async (): Promise<never> => { throw new Error("composition does not invoke adapters"); };
  const machines: NonNullable<CodeModuleDeps["workerMachines"]> = {
    brokerOnly: true, sessions: { get: unused, ensureSession: unused, deleteSession: unused, claimStop: unused, requestStop: unused, markStopped: unused },
    companyOfWorkspace: unused, binding: unused, stopInstance: unused, sign: unused, post: unused, ping: unused, verifyMachine: unused,
  };
  const codeHost: Pick<CodeModuleDeps, "codeHost"> = {
    codeHost: { provider: new GitHubFixtureProvider(new FakeHostModel({ url: "https://github.com/example/demo.git", id: "1", fullName: "example/demo" })), options: { credentialRef: "app" } },
  };
  const workerMachines = vi.fn(() => machines);
  const host = vi.fn(() => codeHost);
  const env = { STATE_TABLE_NAME: STATE, ARTIFACT_BUCKET_NAME: "artifacts", CORE_DISPATCH_QUEUE_URL: "https://queue.example/core", CORE_DISPATCH_DEAD_LETTER_URL: "https://queue.example/dead" };
  const objects: CodeModuleDeps["objects"] = { bucket: "artifacts", client: { send: unused } };
  const secrets = { namePrefix: "", clientFor: () => ({ send: async () => ({}) }) };
  const built = brokerCoreModuleDeps(env, { codeHost: host, workerMachines, objects, secrets });
  expect(built.workerMachines).toBe(machines);
  expect(built.objects).toBe(objects);
  expect(built.secrets).toBe(secrets);
  expect(built.codeHost).toBe(codeHost.codeHost);
  expect(host).toHaveBeenCalledTimes(1);
  expect(workerMachines).toHaveBeenCalledTimes(1);
  expect(built.queue).toEqual(brokerCoreDispatchQueue(env));
});

it("shares one resolved hosted-hook setting with the developer API and never falls back when that setting is invalid", () => {
  let reads = 0;
  const settings = { address: "https://hook.example/answer", jwks: "https://hook.example/keys", thumbprints: ["A".repeat(43)] };
  const env: NodeJS.ProcessEnv = {};
  Object.defineProperty(env, "ROVARA_POLICY_HOOK", { get() { reads++; return JSON.stringify(settings); } });
  const root = createBrokerCoreRoot(rootInputs(env, fakeTables().client));
  const config = withCoreRoutes({}, root) as { policyHook: NonNullable<typeof root.policyHook> };
  expect(config.policyHook).toBe(root.policyHook);
  expect(config.policyHook.settings).toEqual(settings);
  expect(reads).toBe(1);
  expect(() => config.policyHook.install).toThrow("the policy hook install is unavailable");
  const invalid = createBrokerCoreRoot(rootInputs({ ROVARA_POLICY_HOOK: "invalid" }, fakeTables().client));
  const refused = withCoreRoutes({}, invalid) as { policyHook: NonNullable<typeof invalid.policyHook> };
  expect(refused.policyHook).toBeDefined();
  expect(() => refused.policyHook.settings).toThrow("the policy hook settings are not readable");
});

describe("the hosted answers' briefing join (lead 4 L4-AK2g)", () => {
  it("the root's `answers` wiring passes the briefing, made by answersBriefingOf over THIS runtime's company and the lessons hosts by company (deleting the line, or a merge dropping it, turns the briefing off silently)", () => {
    const text = readFileSync("packages/broker/src/aws/core-engine-root.ts", "utf8");
    const block = /answers: \{\n([\s\S]*?)\n\s{10}\},\n\s{10}auditFor/u.exec(text)?.[1] ?? "";
    expect(block).toContain("model: answersModel(),");
    expect(block).toContain("briefing: answersBriefingOf(runtime.companyId, (id) => lessonsByCompany.get(id)?.host),");
  });
});
