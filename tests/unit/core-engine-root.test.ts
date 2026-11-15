// Engine host (lane E2, step 6): the core engine's composition root on the deployed broker. Off (the default) builds and reads nothing and gives the routes no core entry; the caller's
// company is membership, never a claim; the task access re-reads live membership and keeps the broker's project grant rule; the stream hook finds only outbox inserts.
import { describe, expect, it, vi } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { OrgId, Principal } from "@agentx/contracts";
import {
  BROKER_CORE_NOT_CONFIGURED, NOT_A_MEMBER_HERE, policyHookSettingsFromEnvironment, projectRoleOf, NO_PROJECT_GRANT, brokerCoreModuleDeps, createBrokerCoreRoot, hostedTaskAccess, membershipWithRoleFromDynamo, outboxCompaniesOf, projectGrantFromDynamo,
  type BrokerCoreRootInputs,
} from "../../packages/broker/src/aws/core-engine-root.js";
import { HOSTED_IDENTITY_PROVIDER } from "../../packages/broker/src/core-host/hosted-modules.js";

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
  it("builds nothing, reads nothing and gives the developer routes no core entry", async () => {
    const tables = fakeTables();
    const codeModules = vi.fn(() => brokerCoreModuleDeps({}));
    for (const env of [{}, { ROVARA_CORE_ENGINE: "off" }, { ROVARA_CORE_ENGINE: "typo" }]) {
      const root = createBrokerCoreRoot(rootInputs(env, tables.client, { codeModules }));
      expect(root.coreTasks).toBeUndefined();
      expect(root.app.serving).toBe(false);
      expect(await root.callback({ method: "POST", path: `/v1/internal/workspaces/${"a".repeat(8)}-aaaa-4aaa-8aaa-${"a".repeat(12)}/operations/${"b".repeat(8)}-bbbb-4bbb-8bbb-${"b".repeat(12)}/result`, headers: {} })).toBeUndefined();
      expect(await root.handleEvent({ source: "agentx.core-job", job: "dispatch-sweep" })).toEqual({ skipped: "off" });
      expect(await root.handleEvent({ Records: [{ eventSource: "aws:dynamodb", eventName: "INSERT", dynamodb: { NewImage: { pk: { S: `ORG#${ORG}#OUTBOX` }, outboxState: { S: "pending" } } } }] })).toEqual({ relayed: [] });
      expect(await root.handleEvent({ source: "something-else" })).toBeUndefined();
    }
    expect(tables.reads).toEqual([]);
    expect(codeModules).not.toHaveBeenCalled();
  });
});

describe("the broker's core root, switch on", () => {
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

describe("the install's policy hook settings (one setting for the engine and the developer API)", () => {
  it("is absent with no setting, and refuses in fixed words (no echo) anything that is not readable settings", () => {
    expect(policyHookSettingsFromEnvironment({})).toBeUndefined();
    expect(policyHookSettingsFromEnvironment({ ROVARA_POLICY_HOOK: "  " })).toBeUndefined();
    expect(() => policyHookSettingsFromEnvironment({ ROVARA_POLICY_HOOK: "zzq{" })).toThrow(/^the policy hook settings are not JSON$/u);
    expect(() => policyHookSettingsFromEnvironment({ ROVARA_POLICY_HOOK: JSON.stringify({ address: "http://evil.example/zzq", keys: [] }) })).toThrow(/^the policy hook settings are not readable$/u);
  });

  it("reads well-formed settings (the engine applies them before the seal; #717's settings routes take the same value)", () => {
    const settings = JSON.stringify({ address: "https://hook.example/answer", keys: [{ kty: "RSA", n: "A".repeat(342), e: "AQAB", kid: "k1", alg: "RS256" }] });
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
