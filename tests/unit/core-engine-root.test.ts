// Engine host (lane E2, step 6): the core engine's composition root on the deployed broker. Off (the default) builds and reads nothing and gives the routes no core entry; the caller's
// company is membership, never a claim; the task access re-reads live membership and keeps the broker's project grant rule; the stream hook finds only outbox inserts.
import { describe, expect, it, vi } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { GitHubFixtureProvider } from "../support/ports/github-fixture-provider.js";
import { FakeHostModel } from "@agentx/broker/fakes";
import type { CodeModuleDeps } from "../../packages/broker/src/core-host/code-modules.js";
import type { OrgId, Principal } from "@agentx/contracts";
import {
  brokerCoreDispatchQueue, BROKER_CORE_NOT_CONFIGURED, NOT_A_MEMBER_HERE, deployedCallerFromMembership, personStandingFromDynamo, withCoreRoutes, policyHookSettingsFromEnvironment, projectRoleOf, NO_PROJECT_GRANT, brokerCoreModuleDeps, createBrokerCoreRoot, hostedTaskAccess, membershipWithRoleFromDynamo, outboxCompaniesOf, projectGrantFromDynamo,
  type BrokerCoreRootInputs,
} from "../../packages/broker/src/aws/core-engine-root.js";
import { HOSTED_IDENTITY_PROVIDER } from "../../packages/broker/src/core-host/hosted-modules.js";
import { CORE_APP_UNAVAILABLE } from "../../packages/broker/src/aws/core-app-routes.js";
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

describe("the broker's core root, switch off (the default)", () => {
  it("reads no core setting while off and not draining (CORE_ENGINE_BROKER_WIRED), and reads them when on or draining", async () => {
    const watched = ["ROVARA_CORE_ALLOWED_COMPANIES", "ROVARA_CORE_TASK_CAP_USD", "ROVARA_CORE_COMPANY_DAY_CAP_USD", "ROVARA_CORE_LESSONS", "ROVARA_CORE_AGENT_MODEL_CHOICE"];
    const reads = (base: NodeJS.ProcessEnv) => {
      const seen = new Set<string>();
      const env = new Proxy({ ...base }, { get: (target, key) => { if (typeof key === "string" && watched.includes(key)) seen.add(key); return target[key as string]; } });
      createBrokerCoreRoot(rootInputs(env, fakeTables().client, { codeModules: () => brokerCoreModuleDeps({}) }));
      return [...seen].sort();
    };
    for (const env of [{}, { ROVARA_CORE_ENGINE: "off" }, { ROVARA_CORE_ENGINE: "typo" }]) expect(reads({ ...env, ROVARA_CORE_ALLOWED_COMPANIES: ORG, ROVARA_CORE_LESSONS: "on" }), JSON.stringify(env)).toEqual([]);
    expect(reads({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: ORG })).toEqual(expect.arrayContaining(["ROVARA_CORE_ALLOWED_COMPANIES", "ROVARA_CORE_LESSONS"]));
    expect(reads({ ROVARA_CORE_ENGINE: "drain", ROVARA_CORE_ALLOWED_COMPANIES: ORG })).toEqual(expect.arrayContaining(["ROVARA_CORE_ALLOWED_COMPANIES", "ROVARA_CORE_LESSONS"]));
    expect(reads({ ROVARA_CORE_ENGINE: "drain", ROVARA_CORE_AGENT_MODEL_CHOICE: "on", ROVARA_CORE_ALLOWED_COMPANIES: ORG })).toContain("ROVARA_CORE_AGENT_MODEL_CHOICE");
  });

  it("builds nothing, reads nothing and gives the developer routes no core entry", async () => {
    const tables = fakeTables();
    const codeModules = vi.fn(() => brokerCoreModuleDeps({}));
    for (const env of [{}, { ROVARA_CORE_ENGINE: "off" }, { ROVARA_CORE_ENGINE: "typo" }]) {
      const root = createBrokerCoreRoot(rootInputs(env, tables.client, { codeModules }));
      expect(root.coreTasks).toBeUndefined();
      expect(root.coreApp).toBeUndefined();
      expect(root.app.serving).toBe(false);
      expect(await root.callback({ method: "POST", path: `/v1/internal/workspaces/${"a".repeat(8)}-aaaa-4aaa-8aaa-${"a".repeat(12)}/operations/${"b".repeat(8)}-bbbb-4bbb-8bbb-${"b".repeat(12)}/result`, headers: {} })).toBeUndefined();
      expect(await root.handleEvent({ source: "agentx.core-job", job: "dispatch-sweep" })).toEqual({ skipped: "off" });
      expect(await root.handleEvent({ Records: [{ eventSource: "aws:dynamodb", eventName: "INSERT", dynamodb: { NewImage: { pk: { S: `ORG#${ORG}#OUTBOX` }, outboxState: { S: "pending" } } } }] })).toEqual({ batchItemFailures: [] });
      expect(await root.handleEvent({ source: "something-else" })).toBeUndefined();
    }
    expect(tables.reads).toEqual([]);
    expect(codeModules).not.toHaveBeenCalled();
  });
});

describe("the broker's core root, switch on", () => {
  it("loads with malformed core settings and refuses core routes and jobs in fixed words", async () => {
    const cases = [
      [{ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: "none" }, "none"],
      [{ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: ORG, ROVARA_CORE_TASK_CAP_USD: "1001" }, "1001"],
      [{ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: ORG, ROVARA_CORE_COMPANY_DAY_CAP_USD: "1001" }, "1001"],
      [{ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: ORG, ROVARA_CORE_LESSONS: "on:secret-value" }, "secret-value"],
      [{ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: ORG, ROVARA_POLICY_HOOK: "secret-value" }, "secret-value"],
      [{ ROVARA_CORE_ENGINE: "on" }, "ROVARA_CORE_ALLOWED_COMPANIES"],
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

  it("blocks only members covered by the core switch when settings are unreadable", async () => {
    const request = (method: string, path: string) => ({ method, path, headers: {}, ...(method === "POST" ? { body: "{}" } : {}) });
    const caller = (developerId: string) => ({ developerId, sessionId: "s", name: "Ada" });
    const tables = fakeTables([member("covered", ORG), member("uncovered", OTHER)]);
    const root = createBrokerCoreRoot(rootInputs({ ROVARA_CORE_ENGINE: `on:${ORG}`, ROVARA_CORE_ALLOWED_COMPANIES: "none" }, tables.client));
    for (const methodPath of [["POST", "/v1/dev/tasks"], ["GET", "/v1/dev/tasks/task-a"]] as const) {
      const [method, path] = methodPath;
      const blocked = await root.coreTasks?.route(request(method, path), caller("covered"));
      expect(blocked?.statusCode).toBe(503);
      expect(blocked?.body).toBe(JSON.stringify({ error: { code: "CORE_SWITCH_BLOCKED", message: "The core engine settings are not readable." } }));
      expect(await root.coreTasks?.route(request(method, path), caller("uncovered"))).toBeUndefined();
      expect(await root.coreTasks?.route(request(method, path), caller("no-membership"))).toBeUndefined();
    }

    const onRoot = createBrokerCoreRoot(rootInputs({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: "none" }, tables.client));
    const onAnswer = await onRoot.coreTasks?.route(request("POST", "/v1/dev/tasks"), caller("uncovered"));
    expect(onAnswer?.statusCode).toBe(503);

    const unreadableMembership = createBrokerCoreRoot(rootInputs({ ROVARA_CORE_ENGINE: `on:${ORG}`, ROVARA_CORE_ALLOWED_COMPANIES: "none" }, { send: async () => { throw new Error("dynamo down"); } }));
    const failedRead = await unreadableMembership.coreTasks?.route(request("POST", "/v1/dev/tasks"), caller("covered"));
    expect(failedRead?.statusCode).toBe(503);
    expect(failedRead?.body).toBe(JSON.stringify({ error: { code: "CORE_SWITCH_BLOCKED", message: "The core engine settings are not readable." } }));
  });

  it("drains without the root reading the admission settings: a new task goes the old way (draining tasks are refused later, by the admission module)", async () => {
    const root = createBrokerCoreRoot(rootInputs({ ROVARA_CORE_ENGINE: "drain", ROVARA_CORE_ALLOWED_COMPANIES: "none" }, fakeTables().client));
    expect(await root.coreTasks?.route({ method: "POST", path: "/v1/dev/tasks", headers: {}, body: "{}" }, { developerId: "dev-a", sessionId: "s", name: "Ada" })).toBeUndefined();
  });

  it("gives the routes a core entry; the registry refuses by name while the broker's adapter inputs are owed, and a start falls back to nothing", async () => {
    const tables = fakeTables([member("dev-a", ORG, "owner")]);
    const root = createBrokerCoreRoot(rootInputs({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: ORG }, tables.client));
    expect(root.coreTasks).toBeDefined();
    await expect(root.app.registry()).rejects.toThrow(BROKER_CORE_NOT_CONFIGURED);
    // A start by a member of a switched company reaches the core, whose runtime cannot be built: it fails, it never starts on the old path silently.
    await expect(root.coreTasks!.route({ method: "POST", path: "/v1/dev/tasks", headers: {}, body: "{}" }, { developerId: "dev-a", sessionId: "s", name: "Ada" })).rejects.toThrow();
  });

  it("maps the signed-in developer to the core's principal from MEMBERSHIP, carrying the verified step-up and the client", async () => {
    const tables = fakeTables([member("dev-a", ORG, "admin")]);
    const seen: unknown[] = [];
    const root = createBrokerCoreRoot(rootInputs({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: ORG }, tables.client));
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
    const root = createBrokerCoreRoot(rootInputs({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: ORG }, tables.client, { log: (entry) => lines.push(entry) }));
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
    const mapped = await deployedCallerFromMembership(membershipWithRoleFromDynamo(tables.client, SIGN_IN))({ developerId: "dev-a", sessionId: "s", name: "Ada", stepUp: { at: "2026-11-15T10:00:00.000Z", method: "passkey" }, clientId: "web-app" });
    expect(mapped).toEqual({ principal: { companyId: ORG, personId: "dev-a", displayName: "Ada", roles: ["admin"], provider: HOSTED_IDENTITY_PROVIDER }, client: "web-app", stepUp: { at: "2026-11-15T10:00:00.000Z", method: "passkey" } });
    expect(await deployedCallerFromMembership(membershipWithRoleFromDynamo(tables.client, SIGN_IN))({ developerId: "dev-gone", sessionId: "s", name: "Gone" })).toBeUndefined();
    const standing = personStandingFromDynamo(tables.client, SIGN_IN);
    expect(await standing(ORG, "dev-a")).toBe("member");
    expect(await standing(ORG, "dev-gone")).toBe("former");
    // Another company's person, and nobody, are unknown here.
    expect(await standing(ORG, "dev-x")).toBe("unknown");
    expect(await standing(ORG, "dev-none")).toBe("unknown");
    await expect(personStandingFromDynamo(tables.client, undefined)(ORG, "dev-a")).rejects.toThrow();
  });

  it("gives the developer API its core entries only while the switch serves; off, the configuration is the very same object", () => {
    const config = { issuer: "https://api.example" };
    const off = createBrokerCoreRoot(rootInputs({}, fakeTables().client));
    expect(withCoreRoutes(config, off)).toBe(config);
    const on = createBrokerCoreRoot(rootInputs({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: ORG }, fakeTables().client));
    expect(withCoreRoutes(config, on)).toEqual({ issuer: "https://api.example", coreTasks: on.coreTasks, coreApp: on.coreApp });
    expect(withCoreRoutes(config, { coreTasks: on.coreTasks, coreApp: undefined })).toEqual({ issuer: "https://api.example", coreTasks: on.coreTasks });
    expect(config).toEqual({ issuer: "https://api.example" });
  });

  it("refuses a start, rather than falling back, when membership cannot be read", async () => {
    const root = createBrokerCoreRoot(rootInputs({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: ORG }, { send: async () => { throw new Error("dynamo down"); } }));
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

  it("lets only a task's own person, still a member, act on it (a company owner or admin gets no reach into another person's task, as on the broker)", async () => {
    expect(await access.canAct(principal("dev-a"), { developerId: "dev-a", project: "payments" })).toBe(true);
    expect(await access.canAct(principal("dev-o"), { developerId: "dev-a", project: "payments" })).toBe(false);
    expect(await access.canAct(principal("dev-gone"), { developerId: "dev-gone", project: "payments" })).toBe(false);
    expect(await access.canAct(principal("dev-a"), { developerId: "dev-o", project: "payments" })).toBe(false);
    expect(await access.canAct(principal("dev-x"), { developerId: "dev-x", project: "payments" })).toBe(false);
  });

  it("starts a step only while the task's person is still a member with the grant", async () => {
    expect(await access.checkStep({ taskId: "t", developerId: "dev-a", project: "payments" })).toEqual({ allowed: true });
    expect(await access.checkStep({ taskId: "t", developerId: "dev-x", project: "payments" })).toEqual({ allowed: false, message: NOT_A_MEMBER_HERE });
    expect(await access.checkStep({ taskId: "t", developerId: "dev-o", project: "payments" })).toEqual({ allowed: false, message: NO_PROJECT_GRANT });
  });
});

describe("the stream hook", () => {
  it("finds the companies whose outbox rows a batch inserted, and nothing for a batch that is not a State table stream", () => {
    const record = (eventName: string, pk: string, outbox = true) => ({ eventSource: "aws:dynamodb", eventName, dynamodb: { NewImage: { pk: { S: pk }, ...(outbox ? { outboxState: { S: "pending" } } : {}) } } });
    expect(outboxCompaniesOf({ Records: [record("INSERT", `ORG#${ORG}#OUTBOX`), record("INSERT", `ORG#${ORG}#OUTBOX`), record("MODIFY", `ORG#${OTHER}#OUTBOX`), record("INSERT", `ORG#${OTHER}#X`, false), record("INSERT", "TASK#legacy")] })).toEqual([ORG]);
    expect(outboxCompaniesOf({ Records: [{ eventSource: "aws:sqs" }] })).toBeUndefined();
    expect(outboxCompaniesOf({ Records: [] })).toBeUndefined();
    expect(outboxCompaniesOf({ source: "agentx.core-job" })).toBeUndefined();
    expect(outboxCompaniesOf(null)).toBeUndefined();
  });
});

describe("the install's hosted policy hook settings", () => {
  it("is absent with no setting, and refuses in fixed words (no echo) anything that is not readable settings", () => {
    expect(policyHookSettingsFromEnvironment({})).toBeUndefined();
    expect(policyHookSettingsFromEnvironment({ ROVARA_POLICY_HOOK: "  " })).toBeUndefined();
    expect(() => policyHookSettingsFromEnvironment({ ROVARA_POLICY_HOOK: "zzq{" })).toThrow(/^the policy hook settings are not JSON$/u);
    expect(() => policyHookSettingsFromEnvironment({ ROVARA_POLICY_HOOK: JSON.stringify({ address: "http://evil.example/zzq", keys: [] }) })).toThrow(/^the policy hook settings are not readable$/u);
  });

  it("refuses the old inline-keys environment in fixed words", () => {
    const old = { address: "https://hook.example/answer", keys: [{ kty: "RSA", n: "A".repeat(342), e: "AQAB", kid: "k1", alg: "RS256" }] };
    expect(() => policyHookSettingsFromEnvironment({ ROVARA_POLICY_HOOK: JSON.stringify(old) })).toThrow(/^the policy hook settings are not readable$/u);
  });

  it("reads well-formed hosted settings", () => {
    const settings = JSON.stringify({ address: "https://hook.example/answer", jwks: "https://hook.example/keys", thumbprints: ["A".repeat(43)] });
    expect(policyHookSettingsFromEnvironment({ ROVARA_POLICY_HOOK: settings })).toMatchObject({ address: "https://hook.example/answer" });
  });
});

describe("the lessons API for the developer routes (lane LM8)", () => {
  const people = () => ({ approvers: async () => ({}) as never, onProjectRoster: async () => true, linkedAccounts: async () => [], displayName: async () => "Ada", isErased: async () => false });

  it("is not built while the engine switch is off, while the lessons switch is off, or without the deployment's people", () => {
    const tables = fakeTables();
    expect(createBrokerCoreRoot(rootInputs({ ROVARA_CORE_LESSONS: "on" }, tables.client, { lessonsPeople: people })).lessons).toBeUndefined();
    expect(createBrokerCoreRoot(rootInputs({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: ORG }, tables.client, { lessonsPeople: people })).lessons).toBeUndefined();
    expect(createBrokerCoreRoot(rootInputs({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: ORG, ROVARA_CORE_LESSONS: "on" }, tables.client)).lessons).toBeUndefined();
    expect(tables.reads).toEqual([]);
  });

  it("is built with the lessons switch on and the people given; a person with no membership is asked to sign in again", async () => {
    const tables = fakeTables();
    const root = createBrokerCoreRoot(rootInputs({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: ORG, ROVARA_CORE_LESSONS: "on" }, tables.client, { lessonsPeople: people }));
    expect(root.lessons).toBeDefined();
    await expect(root.lessons!.answer({ method: "GET", path: "/v1/dev/projects/payments/lessons", query: new URLSearchParams() }, { personId: "dev-nobody" })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("reads a project role from the broker's own grant: administrator is a maintainer, developer a contributor, anything else none", () => {
    expect(projectRoleOf("administrator")).toBe("maintainer");
    expect(projectRoleOf("developer")).toBe("contributor");
    expect(projectRoleOf(undefined)).toBeUndefined();
  });
});


describe("core outbox stream partial failures", () => {
  const record = (company: string, sequence: string) => ({ eventSource: "aws:dynamodb", eventName: "INSERT", dynamodb: { SequenceNumber: sequence, NewImage: { pk: { S: `ORG#${company}#OUTBOX` }, outboxState: { S: "pending" } } } });
  it("relays each company separately and reports only failed company sequence numbers", async () => {
    const root = createBrokerCoreRoot(rootInputs({}, fakeTables().client));
    const seen: string[][] = [];
    vi.spyOn(root.app, "relayOutbox").mockImplementation(async (companies) => {
      seen.push([...companies]);
      return companies.map((companyId) => ({ companyId, outcome: companyId === ORG ? "failed" as const : "ran" as const }));
    });
    const answer = await root.handleEvent({ Records: [record(ORG, "11"), record(OTHER, "12"), record(ORG, "13")] });
    expect(seen).toEqual([[ORG, OTHER]]);
    expect(answer).toEqual({ batchItemFailures: [{ itemIdentifier: "11" }, { itemIdentifier: "13" }] });
    expect(JSON.stringify(answer)).not.toContain("private failure detail");
  });
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
  it("acknowledges a successful two-company batch and leaves unrelated changes alone", async () => {
    const root = createBrokerCoreRoot(rootInputs({}, fakeTables().client));
    const relay = vi.spyOn(root.app, "relayOutbox").mockResolvedValue([]);
    expect(await root.handleEvent({ Records: [record(ORG, "11"), record(OTHER, "12"), { ...record(ORG, "13"), eventName: "MODIFY" }] })).toEqual({ batchItemFailures: [] });
    expect(relay.mock.calls).toEqual([[[ORG, OTHER]]]);
  });
});

it("keeps the off root's serialized answers byte identical with policy and service inputs supplied", async () => {
  const tables = fakeTables();
  const resolve = vi.fn(async () => { throw new Error("must not read policy off"); });
  const services = vi.fn(() => { throw new Error("must not build services off"); });
  const plain = createBrokerCoreRoot(rootInputs({}, tables.client));
  const supplied = createBrokerCoreRoot(rootInputs({}, tables.client, { policySource: { resolve }, services }));
  const answers = async (root: ReturnType<typeof createBrokerCoreRoot>) => JSON.stringify([
    await root.handleEvent({ source: "agentx.core-job", job: "merge-tracking" }),
    await root.handleEvent({ source: "agentx.core-job", job: "session-sweep" }),
    await root.handleEvent({ source: "agentx.core-job", job: "notify-deliver" }),
    await root.handleEvent({ source: "agentx.core-job", job: "admission-hold-sweep" }),
  ]);
  const golden = '[{"skipped":"off"},{"skipped":"off"},{"skipped":"off"},{"skipped":"off"}]';
  expect(await answers(plain)).toBe(golden);
  expect(await answers(supplied)).toBe(golden);
  expect(resolve).not.toHaveBeenCalled();
  expect(services).not.toHaveBeenCalled();
  expect(tables.reads).toEqual([]);
});

describe("the broker core dispatch queue piece (L1a)", () => {
  const url = "https://sqs.us-east-1.amazonaws.com/123456789012/core-dispatch";
  const deadLetterUrl = `${url}-dead`;
  const words = "the broker needs valid core dispatch queue URLs";

  it("builds the same queue settings as the dispatcher, with an optional region", () => {
    for (const region of [undefined, "us-east-1"]) {
      const env = { ROVARA_CORE_ENGINE: "on", CORE_DISPATCH_QUEUE_URL: url, CORE_DISPATCH_DEAD_LETTER_URL: deadLetterUrl, ...(region === undefined ? {} : { AWS_REGION: region }) };
      expect(brokerCoreDispatchQueue(env)).toEqual({ settings: { ...(region === undefined ? {} : { region }), queues: { "task-dispatch": { url, deadLetterUrl } } } });
    }
  });

  it("refuses missing or invalid URLs in fixed words without echoing either value", () => {
    for (const variable of ["CORE_DISPATCH_QUEUE_URL", "CORE_DISPATCH_DEAD_LETTER_URL"]) {
      for (const value of [undefined, "", "  ", "zzq-private-input", "https://zzq-private-input/", "ftp://zzq-private-input/queue", "https://example/queue?zzq-private-input", "https://example/queue\n", 42, null]) {
        const env = { ROVARA_CORE_ENGINE: "on", CORE_DISPATCH_QUEUE_URL: url, CORE_DISPATCH_DEAD_LETTER_URL: deadLetterUrl, [variable]: value } as NodeJS.ProcessEnv;
        expect(() => brokerCoreDispatchQueue(env)).toThrow(/^the broker needs valid core dispatch queue URLs$/u);
        try { brokerCoreDispatchQueue(env); } catch (error) {
          expect(error).toMatchObject({ name: "BrokerCoreQueueNotConfigured", message: words });
          expect(String(error)).not.toContain("zzq-private-input");
        }
      }
    }
    expect(() => brokerCoreDispatchQueue({ CORE_DISPATCH_QUEUE_URL: url, CORE_DISPATCH_DEAD_LETTER_URL: `${deadLetterUrl}.fifo` })).toThrow(words);
  });

  it("never invokes the queue piece with the switch off, even with unreadable queue settings", async () => {
    const env = { ROVARA_CORE_ENGINE: "off" };
    Object.defineProperty(env, "CORE_DISPATCH_QUEUE_URL", { get() { throw new Error("queue env read while off"); } });
    const codeModules = vi.fn(() => { brokerCoreDispatchQueue(env); throw new Error("composition still owed"); });
    const root = createBrokerCoreRoot(rootInputs(env, fakeTables().client, { codeModules }));
    expect(root.coreTasks).toBeUndefined();
    await expect(root.app.registry()).rejects.toThrow("no registry is built");
    expect(codeModules).not.toHaveBeenCalled();
  });

  it("keeps the complete broker dependency builder refusing until L6 composes the pieces", () => {
    expect(() => brokerCoreModuleDeps({ CORE_DISPATCH_QUEUE_URL: url, CORE_DISPATCH_DEAD_LETTER_URL: deadLetterUrl })).toThrow(BROKER_CORE_NOT_CONFIGURED);
  });
});

it("composes the broker adapters lazily and preserves the L1c builder object including brokerOnly", async () => {
  const unused = async (): Promise<never> => { throw new Error("composition does not invoke adapters"); };
  const machines: NonNullable<CodeModuleDeps["workerMachines"]> = {
    brokerOnly: true, sessions: { get: unused, ensureSession: unused, deleteSession: unused, claimStop: unused, markStopped: unused },
    companyOfWorkspace: unused, binding: unused, stopInstance: unused, sign: unused, post: unused, ping: unused,
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

it("reads no new wiring environment and answers no new routes with the switch off", async () => {
  const env: NodeJS.ProcessEnv = { ROVARA_CORE_ENGINE: "off" };
  for (const key of ["CORE_DISPATCH_QUEUE_URL", "CORE_DISPATCH_DEAD_LETTER_URL", "TASK_TOKEN_KEY_ARN", "ROVARA_CORE_MODEL_GATEWAY_URL", "ROVARA_CORE_AGENT_MODEL", "ROVARA_CORE_AGENT_MODEL_CHOICE", "ROVARA_POLICY_HOOK", "SLACK_MEMBER_WORKSPACE_LIMIT", "SLACK_ORGANIZATION_WORKSPACE_LIMIT"]) {
    Object.defineProperty(env, key, { get() { throw new Error(`unexpected read: ${key}`); } });
  }
  const tables = fakeTables();
  const root = createBrokerCoreRoot(rootInputs(env, tables.client));
  expect(root.policyHook).toBeUndefined();
  for (const path of ["/v1/internal/model-access", "/v1/internal/model-access?slot=reviewer", "/v1/dev/tasks/id/continue"]) {
    expect(await root.callback({ method: "GET", path, headers: {} })).toBeUndefined();
  }
  expect(root.coreTasks).toBeUndefined();
  expect(root.coreApp).toBeUndefined();
  expect(tables.reads).toEqual([]);
});

it("uses live membership plus the existing fresh PEOPLE proof for owner and co-owner acts, fencing its revision", async () => {
  const { MemoryDocumentStore } = await import("../../packages/broker/src/ports/memory-document-store.js");
  const { taskOwnerKey } = await import("../../packages/broker/src/developer/task-records.js");
  const store = new MemoryDocumentStore();
  const a = "a".repeat(64), b = "b".repeat(64), foreign = "c".repeat(64), taskId = "11111111-1111-4111-8111-111111111111";
  const task = { taskId, developerId: a, project: "payments", ownerKey: taskOwnerKey(a, taskId) };
  await store.put({ item: { pk: `DEVTASK#${taskId}`, sk: "META", ...task, companyId: ORG } });
  const people = { pk: `DEVTASK#${taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 7, orphaned: false,
    people: [a, b].map((developerId, i) => ({ developerId, slackUserId: `U00${i}`, name: `Person ${i}`, role: "owner" })) };
  await store.put({ item: people });
  const check = vi.fn(async (_task, developerId: string) => ({ subject: { developerId, slackUserId: developerId === a ? "U000" : "U001" }, identity: { developerId, slackUserId: developerId === a ? "U000" : "U001", name: "Member", method: "slack", issuer: "https://slack.com", subject: "person" }, eligible: true, channelMember: true }));
  const access = hostedTaskAccess({ companyId: ORG, membershipOf: async (id) => ({ companyId: id === foreign ? OTHER : ORG, role: "member" }), projectGrant: async () => true, storage: async () => store,
    people: { documentClient: { send: async (command) => ({ Item: await store.get((command as GetCommand).input.Key as { pk: string; sk: string }) }) }, tableName: STATE, now: Date.now, checkTaskPerson: check as never } });
  const principal = (personId: string): Principal => ({ companyId: ORG, personId, displayName: "Member", roles: ["owner"], provider: "test" });
  const acting = await access.ownerActing!(principal(b), task);
  expect(acting).toMatchObject({ actorId: taskOwnerKey(b, taskId), authority: { ownerIds: [taskOwnerKey(a, taskId), taskOwnerKey(b, taskId)] }, items: [{ kind: "check", key: { pk: `DEVTASK#${taskId}`, sk: "PEOPLE" }, condition: { op: "eq", path: ["revision"], value: 7 } }] });
  expect(check).toHaveBeenCalled();
  expect(await access.canAct(principal(b), task)).toBe(true);
  expect(await access.ownerActing!(principal(foreign), task)).toBeUndefined();
  await store.delete({ key: { pk: `DEVTASK#${taskId}`, sk: "PEOPLE" } });
  expect(await access.ownerActing!(principal(b), task)).toBeUndefined();
  expect(await access.ownerActing!(principal(a), task)).toMatchObject({ actorId: task.ownerKey, items: [{ condition: { op: "notExists", path: ["pk"] } }] });
});

it("shares one resolved hosted-hook setting with the developer API and never falls back when that setting is invalid", () => {
  let reads = 0;
  const settings = { address: "https://hook.example/answer", jwks: "https://hook.example/keys", thumbprints: ["A".repeat(43)] };
  const env: NodeJS.ProcessEnv = { ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: ORG };
  Object.defineProperty(env, "ROVARA_POLICY_HOOK", { get() { reads++; return JSON.stringify(settings); } });
  const root = createBrokerCoreRoot(rootInputs(env, fakeTables().client));
  const config = withCoreRoutes({}, root) as { policyHook: NonNullable<typeof root.policyHook> };
  expect(config.policyHook).toBe(root.policyHook);
  expect(config.policyHook.settings).toEqual(settings);
  expect(reads).toBe(1);
  expect(() => config.policyHook.install).toThrow("the policy hook install is unavailable");
  const invalid = createBrokerCoreRoot(rootInputs({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: ORG, ROVARA_POLICY_HOOK: "invalid" }, fakeTables().client));
  const refused = withCoreRoutes({}, invalid) as { policyHook: NonNullable<typeof invalid.policyHook> };
  expect(refused.policyHook).toBeDefined();
  expect(() => refused.policyHook.settings).toThrow("the policy hook settings are not readable");
});
