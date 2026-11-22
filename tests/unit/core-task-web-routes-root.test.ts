// Core task web routes (Cloud #188): the broker's core root wires them. Over the real root, registry and runtime with fake deployment adapters (as hosted-intake-root.test.ts does):
//   - item 3: the old task routes' dependencies (`taskRules`) reach the core's routes only when the deployment gives them, for the caller's live company and person; another company's caller is refused before
//     they are asked; without them the routes are not the core's (the engine boundary then answers);
//   - item 5: the core entry gives the task list its money read;
//   - item 1: every person's start writes the task's session (hosted-intake-root.test.ts holds the start extras themselves).
import { describe, expect, it, vi } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, orgProjectCatalogKey, projectRevisionKey, type JsonValue, type OrgId, type Principal, type ProjectDefinition } from "@agentx/contracts";
import { createBrokerCoreRoot, type BrokerCoreRootInputs } from "../../packages/broker/src/aws/core-engine-root.js";
import type { DeveloperTaskRouteDependencies } from "../../packages/broker/src/aws/developer-tasks.js";
import { HOSTED_IDENTITY_PROVIDER } from "../../packages/broker/src/core-host/hosted-modules.js";
import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";
import { pagePlan, pageTask } from "../support/page-tasks.js";
import { createFakeWorld, FAKE_COMPANY } from "../support/core-host-fakes.js";

const adapters = vi.hoisted(() => ({ modules: [] as unknown[] }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", () => ({ codeAdapterModules: () => adapters.modules }));
vi.mock("../../packages/broker/src/core-host/hosted-modules.js", async (original) => ({ ...await original<object>(), hostedSecurityModules: () => [] }));

const A = FAKE_COMPANY as OrgId;
const B = "org_corehost00000000000b" as OrgId;
const MAYA = "d".repeat(64);
const OMAR = "e".repeat(64);
const secret = Buffer.alloc(32, 7);

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

async function coreTask(built: ReturnType<typeof root>["root"]): Promise<string> {
  const principal: Principal = { companyId: A, personId: MAYA, displayName: "Maya", roles: ["member"], provider: HOSTED_IDENTITY_PROVIDER };
  const runtime = await built.app.runtimeFor(A);
  const definition: ProjectDefinition = { name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }] };
  await runtime.flow.deps.store.put({ item: { ...projectRevisionKey(A, "payments", 1), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(definition)) as JsonValue } });
  await runtime.flow.deps.store.put({ item: { ...orgProjectCatalogKey(A, "payments"), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
  const { task } = await runtime.flow.start({ principal, client: "web", origin: "app" }, { requestId: crypto.randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
  // Item 1: a web start's task carries its session (written in the same start), so the session controls reach it.
  expect((await runtime.flow.deps.store.get({ pk: `DEVTASK#${task.taskId}`, sk: "META" }))?.["sessionId"]).toMatch(/^ses_/u);
  return task.taskId;
}

describe("the core root wires the core task web routes", () => {
  it("core comment POST reads the current artifact through the real company's runtime reader", async () => {
    const h = pageTask();
    const source = h.addVersion("plan", pagePlan());
    h.deps.actions.readArtifact = async () => { throw new Error("the old task factory has no artifact reader"); };
    const { root: built, world } = root(() => h.deps);
    const taskId = await coreTask(built);
    const key = { pk: `DEVTASK#${taskId}`, sk: "META" };
    const task = (await world.store.get(key))!;
    if (typeof task["ownerKey"] !== "string" || typeof task["workspaceId"] !== "string") throw new Error("task identity missing");
    const artifact = { ...source, objectKey: `private/${task["ownerKey"]}/${task["workspaceId"]}/plan-v1.json` };
    const current = { ...task, workflow: { ...h.workflow(), taskId, ownerId: task["ownerKey"], artifacts: [artifact] } };
    await world.store.put({ item: toDocument(current) });
    h.db.set(current);
    await (await built.app.registry()).require("object-storage").put(artifact.objectKey, Buffer.from(h.objects.get(source.objectKey)!), { contentType: "application/json", metadata: {}, retention: "evidence-std" });
    const response = await built.coreTasks!.route({ method: "POST", path: `/v1/dev/tasks/${taskId}/comments`, headers: {}, body: JSON.stringify({ requestId: "root-reader", document: "plan", text: "Above", anchor: "claim:2.1" }) }, { developerId: MAYA, sessionId: "s", name: "Maya" });
    expect(response?.statusCode).toBe(200);
    expect(JSON.parse(response!.body)).toMatchObject({ comment: { text: "Above", author: { developerId: MAYA } } });
    expect(h.db.find((item) => item["entityType"] === "TASK_COMMENT")).toHaveLength(1);
  });

  it("item 1: a web start by a member writes the task's session in its own start", async () => {
    const { root: built } = root();
    const extras = (await built.app.runtimeFor(A)).flow.deps.startExtras!;
    const added = extras({ taskId: "11111111-1111-4111-8111-111111111111", workspaceId: "ws-1", project: "payments", title: "t", principal: { companyId: A, personId: MAYA, displayName: "Maya", roles: ["member"], provider: HOSTED_IDENTITY_PROVIDER }, client: "web", receivedAt: "2026-11-17T00:00:00.000Z" });
    expect(added.sessionId).toMatch(/^ses_/u);
  });

  it("item 3: asks the deployment's old-route dependencies for the caller's own person and live company only; another company's caller is refused first; absent, the route is not the core's", async () => {
    const depsFor = vi.fn((): DeveloperTaskRouteDependencies => { throw agentXError("RUNTIME_UNAVAILABLE", "rules reached"); });
    const { root: built } = root(depsFor);
    expect(typeof built.coreTasks?.taskMoney).toBe("function");
    expect(typeof built.coreTasks?.taskReadable).toBe("function");
    const taskId = await coreTask(built);
    const ask = (developerId: string, rest: string) => built.coreTasks!.route({ method: "GET", path: `/v1/dev/tasks/${taskId}/${rest}`, headers: {} }, { developerId, sessionId: "s", name: developerId === MAYA ? "Maya" : "Omar" });
    const reached = await ask(MAYA, "people");
    expect(reached?.statusCode).toBe(503);
    expect(JSON.parse(reached!.body)).toEqual({ error: { code: "RUNTIME_UNAVAILABLE", message: "rules reached" } });
    expect(depsFor).toHaveBeenCalledWith({ developerId: MAYA, name: "Maya" }, A);
    depsFor.mockClear();
    const theirs = await ask(OMAR, "readers");
    expect(theirs?.statusCode).toBe(404);
    expect(depsFor).not.toHaveBeenCalled();
    const { root: unwired } = root();
    const id = await coreTask(unwired);
    expect(await unwired.coreTasks!.route({ method: "GET", path: `/v1/dev/tasks/${id}/people`, headers: {} }, { developerId: MAYA, sessionId: "s", name: "Maya" })).toBeUndefined();
  });
});
