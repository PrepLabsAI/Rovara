import { describe, expect, it, vi } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, orgProjectCatalogKey, projectRevisionKey, type JsonValue, type OrgId, type Principal, type ProjectDefinition } from "@agentx/contracts";
import { createBrokerCoreRoot, hostedTaskAccess, type BrokerCoreRootInputs } from "../../packages/broker/src/aws/core-engine-root.js";
import type { DeveloperTaskRouteDependencies } from "../../packages/broker/src/aws/developer-tasks.js";
import { prepareTaskPeopleStart } from "../../packages/broker/src/developer/task-people-start.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import type { TaskPersonIdentityDependencies } from "../../packages/broker/src/developer/task-person-identity.js";
import { HOSTED_IDENTITY_PROVIDER } from "../../packages/broker/src/core-host/hosted-modules.js";
import { createFakeWorld, FAKE_COMPANY } from "../support/core-host-fakes.js";

const adapters = vi.hoisted(() => ({ modules: [] as unknown[] }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", () => ({ codeAdapterModules: () => adapters.modules }));
vi.mock("../../packages/broker/src/core-host/hosted-modules.js", async (original) => ({ ...await original<object>(), hostedSecurityModules: () => [] }));

const A = FAKE_COMPANY as OrgId;
const B = "org_corehost00000000000b" as OrgId;
const MAYA = ownerKeyForSubject("https://signin.example.test", "maya");
const OMAR = "e".repeat(64);
const secret = Buffer.alloc(32, 7);

describe("hosted task access proof outcomes", () => {
  const principal: Principal = { companyId: A, personId: MAYA, displayName: "Maya", roles: ["member"], provider: HOSTED_IDENTITY_PROVIDER };
  const task = { taskId: crypto.randomUUID(), developerId: MAYA, project: "payments" };

  for (const method of ["canRead", "canAct"] as const) {
    it(`${method} hides a denied live proof`, async () => {
      const projectGrant = vi.fn(async () => true);
      const access = hostedTaskAccess({ companyId: A, projectGrant, membershipOf: async () => { throw agentXError("TASK_ACCESS_DENIED", "proof denied"); } });
      await expect(access[method]!(principal, task)).resolves.toBe(false);
      expect(projectGrant).not.toHaveBeenCalled();
    });

    it(`${method} preserves an unexpected proof-service error`, async () => {
      const error = agentXError("RUNTIME_UNAVAILABLE", "proof reader unavailable");
      const access = hostedTaskAccess({ companyId: A, projectGrant: async () => true, membershipOf: async () => { throw error; } });
      await expect(access[method]!(principal, task)).rejects.toBe(error);
    });

    it(`${method} accepts a current company member's own task`, async () => {
      const access = hostedTaskAccess({ companyId: A, projectGrant: async () => true, membershipOf: async () => ({ companyId: A, role: "member" }) });
      await expect(access[method]!(principal, task)).resolves.toBe(true);
    });
  }
});

function root(taskRules?: BrokerCoreRootInputs["taskRules"]) {
  const world = createFakeWorld();
  adapters.modules = world.modules;
  const memberships: Record<string, OrgId> = { [MAYA]: A, [OMAR]: B };
  const client = { async send(command: unknown) {
    if (!(command instanceof GetCommand)) throw new Error("unexpected write");
    const { TableName, Key } = command.input as { TableName: string; Key: { pk: string; sk: string } };
    const person = Key.pk.replace(/^COMPANY_MEMBER#/u, "");
    if (TableName === "signin" && Key.pk.startsWith("COMPANY_MEMBER#") && memberships[person] !== undefined) return { Item: { pk: Key.pk, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: person, companyId: memberships[person], role: "member", joinedAt: "2026-11-01T00:00:00.000Z" } };
    // DEC 254zzz80: a person's grant sits in their own company's partition (`ORG#<company>#MEMBER#<person>`), as a named company keeps its grants.
    const grant = /^ORG#(org_[0-9a-z]{20})#MEMBER#(.+)$/u.exec(Key.pk);
    if (TableName === "state" && Key.sk === "PROJECT#payments" && grant !== null && memberships[grant[2]!] === grant[1]) return { Item: { pk: Key.pk, sk: Key.sk, projectName: "payments", role: "developer" } };
    return { Item: undefined };
  } };
  const built = createBrokerCoreRoot({
    env: {}, documentClient: client, stateTableName: "state", signInTableName: "signin", callbackSigningKey: secret.toString(), repositoryGrantKey: secret,
    codeModules: () => ({}) as never, repositoryCredential: async () => { throw new Error("unused"); }, origin: () => "https://api.example", log: () => undefined,
    now: () => new Date(world.clock.now), ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
    services: () => Object.fromEntries(["merge-tracking", "session-sweep", "notify-deliver", "admission-hold-sweep"].map((name) => [name, { pass: async () => ({}) }])),
    lessonsPeople: () => ({ approvers: async () => ({ complete: true, membershipVersion: 1, ownerIds: [], eligibleIds: [], lastEligibleLossAtMs: null }), onProjectRoster: async () => true, linkedAccounts: async () => [], displayName: async () => "Member", isErased: async () => false }),
    ...(taskRules === undefined ? {} : { taskRules }),
  });
  return { root: built, world };
}


describe("hosted root starts without People proof", () => {
  async function start(proof?: TaskPersonIdentityDependencies, missingHook = false, adapter: string = HOSTED_IDENTITY_PROVIDER) {
    const { root: built, world } = root(proof === undefined ? undefined : () => ({
      taskPeopleStart: missingHook ? undefined : task => prepareTaskPeopleStart(proof, task),
    }) as DeveloperTaskRouteDependencies);
    const runtime = await built.app.runtimeFor(A);
    const definition: ProjectDefinition = { name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }] };
    await world.store.put({ item: { ...projectRevisionKey(A, "payments", 1), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(definition)) as JsonValue } });
    await world.store.put({ item: { ...orgProjectCatalogKey(A, "payments"), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
    const principal: Principal = { companyId: A, personId: MAYA, displayName: "Maya", roles: ["member"], provider: adapter };
    return { world, result: runtime.flow.start({ principal, origin: "app" }, { requestId: crypto.randomUUID(), project: "payments", instructions: "Fix it", workflow: true, workflowPath: "QUICK" }) };
  }

  function proof(): TaskPersonIdentityDependencies {
    const db = new FakeDynamoDb();
    return {
      documentClient: { send: command => db.send(command as never) }, tableName: "state", slackTeamId: "", uuid: () => crypto.randomUUID(), now: Date.now,
      developerRecord: async () => ({ developerId: MAYA, provider: "cloud", issuer: "https://signin.example.test", subject: "maya", displayName: "Maya", revoked: false, firstSignInAt: "2026-11-01", lastSignInAt: "2026-11-01" }),
      companyMembership: async () => ({ companyId: A }), projectGrant: async () => true,
      taskPersonProof: async () => { throw new Error("web proof must not call Slack"); },
      projectChannelIds: async () => [], targetProjectAccess: async () => {},
    };
  }

  it("the deployed flow commits META without People or immutable identity rows", async () => {
    const h = await start(proof());
    const { task } = await h.result;
    const pk = `DEVTASK#${task.taskId}`;
    expect(await h.world.store.get({ pk, sk: "META" })).toMatchObject({ provider: "rovara-sign-in", developerId: MAYA });
    expect((await h.world.store.query({ pk })).items.filter(row => /^(PEOPLE|PERSON#|PERSON_SUBJECT#)/u.test(row.sk))).toEqual([]);
  });

  it.each([false, true])("starts without creation proof (rules present=%s)", async rules => {
    const h = await start(rules ? proof() : undefined, true);
    const { task } = await h.result;
    expect(task.status).toBe("STARTING");
    expect(await h.world.store.get({ pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE" })).toBeUndefined();
  });

  it("keeps other adapters on their own path", async () => {
    const h = await start(undefined, false, "local-owner");
    const { task } = await h.result;
    expect(await h.world.store.get({ pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE" })).toBeUndefined();
  });
});
