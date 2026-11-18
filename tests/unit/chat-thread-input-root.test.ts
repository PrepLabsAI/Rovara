// L4-U5d: the hosted wiring. Over the real broker core root (aws/core-engine-root.ts: the deployed membership and project-grant reads, `hostedTaskAccess`, the core runtime and the core entry the Slack paths ask), a Slack
// thread's later message reaches the task as input when the deployment wires its chat threads, and only for the task's owner of the thread's own company. Without chat threads the entry takes no thread input.
// Mutants are listed in briefs/lead4/L4-U5d-MUTANTS-20261118.md with the test that kills each.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { SLACK_CHANNEL, orgProjectCatalogKey, projectRevisionKey, type JsonValue, type OrgId, type ProjectDefinition } from "@agentx/contracts";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { readTaskNotes } from "../../packages/broker/src/core/sessions/notes.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import type { ChatThreadInput } from "../../packages/broker/src/core-host/chat-thread-input.js";
import { createFakeWorld, FAKE_COMPANY, type FakeWorld } from "../support/core-host-fakes.js";

const adapters = vi.hoisted(() => ({ modules: [] as unknown[] }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", () => ({ codeAdapterModules: () => adapters.modules }));
vi.mock("../../packages/broker/src/core-host/hosted-modules.js", async (original) => ({ ...await original<object>(), hostedSecurityModules: () => [] }));

const A = FAKE_COMPANY as OrgId;
const B = "org_corehost00000000000b" as OrgId;
const TEAM_A = "T0AAAAAAAAA";
const TEAM_B = "T0BBBBBBBBB";
const SPACE = "C0123456789";
const THREAD = "1700000000.000100";
const SIGN_IN = "signin-table";
const STATE = "state-table";
const OWNER = "owner-a";
const TEAMMATE = "teammate-a";
const OUTSIDER = "outsider-b";
const secret = Buffer.alloc(32, 7);
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};

const member = (personId: string, companyId: string) => ({ pk: `COMPANY_MEMBER#${personId}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId, companyId, role: "member", joinedAt: "2026-11-01T00:00:00.000Z" });
const grant = (personId: string) => ({ pk: `MEMBER#${personId}`, sk: "PROJECT#payments", projectName: "payments", role: "developer" });

async function registerProject(world: FakeWorld, companyId: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
}

async function world(options: { chatThreads?: boolean } = {}) {
  const fake = createFakeWorld();
  adapters.modules = fake.modules;
  await registerProject(fake, A);
  await registerProject(fake, B);
  const rows = new Map<string, Record<string, unknown>>();
  for (const [table, item] of [[SIGN_IN, member(OWNER, A)], [SIGN_IN, member(TEAMMATE, A)], [SIGN_IN, member(OUTSIDER, B)], [STATE, grant(OWNER)], [STATE, grant(TEAMMATE)], [STATE, grant(OUTSIDER)]] as const) rows.set(`${table}|${item.pk}|${item.sk}`, item);
  const client = { async send(command: unknown) {
    if (!(command instanceof GetCommand)) throw new Error("unexpected write");
    const input = command.input as { TableName: string; Key: { pk: string; sk: string } };
    return { Item: rows.get(`${input.TableName}|${input.Key.pk}|${input.Key.sk}`) };
  } };
  const root = createBrokerCoreRoot({
    env: { ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: "all" }, documentClient: client, stateTableName: STATE, signInTableName: SIGN_IN, callbackSigningKey: secret.toString(), repositoryGrantKey: secret,
    codeModules: () => ({}) as never, repositoryCredential: async () => { throw new Error("unused"); }, origin: () => "https://api.example", log: () => undefined,
    now: () => new Date(fake.clock.now), ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
    services: () => Object.fromEntries(["merge-tracking", "session-sweep", "notify-deliver", "admission-hold-sweep"].map((name) => [name, { pass: async () => ({}) }])),
    ...(options.chatThreads === false ? {} : { chatThreads: { companyOf: ({ channel, tenant }: { channel: string; tenant: string }) => (channel !== SLACK_CHANNEL ? undefined : tenant === TEAM_A ? A : tenant === TEAM_B ? B : undefined), adapterFor: () => undefined } }),
  } as never);
  const caller = (developerId: string) => ({ developerId, sessionId: "s-slack", name: "Rovara member" });
  const start = async () => {
    const answer = await root.coreTasks!.route({ method: "POST", path: "/v1/dev/tasks", headers: {}, body: JSON.stringify({ requestId: randomUUID(), project: "payments", instructions: "Add a retry", client: "slack", workflow: true, workflowPath: "QUICK" }) }, caller(OWNER));
    expect(answer?.statusCode, answer?.body).toBe(200);
    return (JSON.parse(answer!.body) as { task: { taskId: string } }).task.taskId;
  };
  const input = (taskId: string, overrides: Partial<ChatThreadInput> = {}): ChatThreadInput => ({
    taskId, conversation: { channel: SLACK_CHANNEL, tenant: TEAM_A, space: SPACE, thread: THREAD }, actor: { channel: SLACK_CHANNEL, tenant: TEAM_A, userId: "U0123456789" },
    messageId: "1700000001.000001", text: "Also cover the 404 case.", mention: true, smallTalk: false, ...overrides,
  });
  return { fake, root, caller, start, input, rows };
}

describe("the hosted core root takes a Slack thread's later message as the task's input", () => {
  it("is on the core entry when the deployment wires its chat threads, and absent when it does not", async () => {
    const wired = (await world()).root.coreTasks;
    expect(wired !== undefined && "threadInput" in wired).toBe(true);
    // The root's entry wrapper once kept only `route` and the admin stop: a start from a chat never remembered its thread (L4-U5b's `recordThread`), so a later message had no thread to belong to.
    expect(wired !== undefined && "recordThread" in wired).toBe(true);
    const unwired = (await world({ chatThreads: false })).root.coreTasks;
    expect(unwired !== undefined && "threadInput" in unwired).toBe(false);
    expect(unwired !== undefined && "recordThread" in unwired).toBe(false);
  });

  it("the task's owner (live member of the thread's company, with the project grant) adds a note the task keeps, once", async () => {
    const w = await world();
    const taskId = await w.start();
    expect(await w.root.coreTasks!.threadInput!(w.caller(OWNER), w.input(taskId))).toEqual({ outcome: "captured", notice: "note_saved" });
    expect(await w.root.coreTasks!.threadInput!(w.caller(OWNER), w.input(taskId))).toEqual({ outcome: "duplicate" });
    expect((await readTaskNotes(w.fake.store, taskId)).map((note) => note.text)).toEqual(["Also cover the 404 case."]);
    expect((await w.fake.store.get(taskKey(taskId)))?.["threadNoteCount"]).toBe(1);
  });

  it("a start from a Slack thread through the root remembers the thread, and a reply from another thread of the same workspace is refused", async () => {
    const w = await world();
    const taskId = await w.start();
    const recorded = await w.root.coreTasks!.recordThread!(w.caller(OWNER), { taskId, conversation: { channel: SLACK_CHANNEL, tenant: TEAM_A, space: SPACE, thread: THREAD }, actor: { channel: SLACK_CHANNEL, tenant: TEAM_A, userId: "U0123456789" } });
    expect(recorded).toBe(true);
    expect(await w.root.coreTasks!.threadInput!(w.caller(OWNER), w.input(taskId, { conversation: { channel: SLACK_CHANNEL, tenant: TEAM_A, space: SPACE, thread: "1700000000.000999" } }))).toEqual({ outcome: "refused", notice: "not_allowed" });
    expect(await w.root.coreTasks!.threadInput!(w.caller(OWNER), w.input(taskId))).toEqual({ outcome: "captured", notice: "note_saved" });
  });

  it("a teammate of the same company who does not own the task is refused, nothing written", async () => {
    const w = await world();
    const taskId = await w.start();
    expect(await w.root.coreTasks!.threadInput!(w.caller(TEAMMATE), w.input(taskId))).toEqual({ outcome: "refused", notice: "not_allowed" });
    expect(await readTaskNotes(w.fake.store, taskId)).toEqual([]);
  });

  it("two companies: a member of company B is refused from company A's workspace, and the owner from company B's workspace; a person with no membership is refused", async () => {
    const w = await world();
    const taskId = await w.start();
    expect(await w.root.coreTasks!.threadInput!(w.caller(OUTSIDER), w.input(taskId))).toEqual({ outcome: "refused", notice: "not_allowed" });
    const fromB = w.input(taskId, { conversation: { channel: SLACK_CHANNEL, tenant: TEAM_B, space: SPACE, thread: THREAD }, actor: { channel: SLACK_CHANNEL, tenant: TEAM_B, userId: "U0123456789" } });
    expect(await w.root.coreTasks!.threadInput!(w.caller(OWNER), fromB)).toEqual({ outcome: "refused", notice: "not_allowed" });
    expect(await w.root.coreTasks!.threadInput!(w.caller("nobody-at-all"), w.input(taskId))).toEqual({ outcome: "refused", notice: "not_allowed" });
    expect(await readTaskNotes(w.fake.store, taskId)).toEqual([]);
  });

  it("the task's owner, once their membership is gone (read live on every call), is refused", async () => {
    const w = await world();
    const taskId = await w.start();
    w.rows.delete(`${SIGN_IN}|COMPANY_MEMBER#${OWNER}|COMPANY`);
    expect(await w.root.coreTasks!.threadInput!(w.caller(OWNER), w.input(taskId))).toEqual({ outcome: "refused", notice: "not_allowed" });
    expect(await readTaskNotes(w.fake.store, taskId)).toEqual([]);
  });

  it("the task's owner, once the project grant is gone (a role on the project is part of the rule), is refused", async () => {
    const w = await world();
    const taskId = await w.start();
    w.rows.delete(`${STATE}|MEMBER#${OWNER}|PROJECT#payments`);
    expect(await w.root.coreTasks!.threadInput!(w.caller(OWNER), w.input(taskId))).toEqual({ outcome: "refused", notice: "not_allowed" });
    expect(await readTaskNotes(w.fake.store, taskId)).toEqual([]);
  });
});
