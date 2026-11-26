// L4-U5c: one Slack thread, one core task. The core's start writes the thread's guard row (`SHARED_TASK`, the row the old start writes) in the start's OWN transaction, absent-only, so a second prefixed mention, or a second start
// racing the first, commits no second task; a Slack retry of the SAME event (same request id) gets the first task back from the core's own idempotency, never a second. These tests run the real core start
// (`createCoreRuntime` over the fake world) with the fence `startSlackWorkflowOnCore` sets, so a mutant in the fence, the row, the condition or the company check is caught by what the store holds afterwards.
// Mutants are listed in briefs/lead4/L4-U5c-MUTANTS-20261118.md with the test that kills each.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AgentXError, errorStatus, orgProjectCatalogKey, projectRevisionKey, sharedTaskKey, type JsonValue, type OrgId, type Principal, type ProjectDefinition, type SlackThread } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { startIdempotencyKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import type { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { buildCoreRegistry, createCoreRuntime, type CoreRuntime } from "../../packages/broker/src/core-host/index.js";
import type { CoreEntryCaller, CoreTaskEntry } from "../../packages/broker/src/aws/engine-boundary.js";
import { isOwnSlackStart, slackThreadGuardItem, startSlackWorkflowOnCore, type SlackCoreStartInput } from "../../packages/broker/src/aws/slack-core-start.js";
import { FAKE_COMPANY, createFakeWorld } from "../support/core-host-fakes.js";

const A = FAKE_COMPANY as OrgId;
const B = "org_corehost00000000000b" as OrgId;
const PERSON_A = "a".repeat(64);
const PERSON_B = "b".repeat(64);
const TEAM_A = "T0AAAAAAAAA";
const CHANNEL = "C0123456789";
const TS = "1700000000.000100";
const USER = "U0123456789";
const THREAD: SlackThread = { teamId: TEAM_A, channelId: CHANNEL, threadTs: TS };
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const json = (statusCode: number, value: unknown) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });

/** The core entry as the deployment composes it, over one company's real runtime: a start is the core's own `flow.start` as that person; an error is the route's own answer. */
const entryOf = (runtime: CoreRuntime, principal: Principal): CoreTaskEntry => ({
  async route(request) {
    if (request.method !== "POST" || request.path !== "/v1/dev/tasks") return undefined;
    try {
      const started = await runtime.flow.start({ principal, client: "slack", origin: "app" }, JSON.parse(request.body ?? "{}") as never);
      return json(200, { task: { taskId: started.task.taskId } });
    } catch (error) {
      if (error instanceof AgentXError) return json(errorStatus(error.code), { error: { code: error.code, message: error.message } });
      throw error;
    }
  },
});

async function world() {
  const fake = createFakeWorld();
  const registry = await buildCoreRegistry({ modules: fake.modules, context: fake.context(), areas: ["flow", "build", "merge"] });
  const companies: Record<string, { runtime: CoreRuntime; principal: Principal; entry: CoreTaskEntry }> = {};
  for (const [companyId, personId] of [[A, PERSON_A], [B, PERSON_B]] as const) {
    await fake.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
    await fake.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
    const runtime = createCoreRuntime({
      registry, companyId, callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5),
      repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(fake.clock.now), log: () => undefined,
    });
    const principal = localOwnerPrincipal({ companyId, personId });
    companies[companyId] = { runtime, principal, entry: entryOf(runtime, principal) };
  }
  const caller = (personId: string): CoreEntryCaller => ({ developerId: personId, sessionId: "s-slack", name: "Rovara member" });
  const start = (company: OrgId, overrides: Partial<SlackCoreStartInput> = {}) => startSlackWorkflowOnCore(companies[company]!.entry, {
    caller: caller(companies[company]!.principal.personId), companyId: company, thread: THREAD, userId: USER, requestId: randomUUID(), project: "payments", instructions: "Add a retry", workflowPath: "QUICK", ...overrides,
  });
  const taskCount = async (): Promise<number> => {
    const memory = fake.store as MemoryDocumentStore;
    let count = 0;
    let cursor: string | undefined;
    do {
      const page = await memory.scanPage({ ...(cursor === undefined ? {} : { cursor }) });
      count += page.items.filter((item) => item["entityType"] === "DEVELOPER_TASK").length;
      cursor = page.cursor;
    } while (cursor !== undefined);
    return count;
  };
  return { fake, store: fake.store, companies, start, taskCount, caller };
}

describe("the thread's guard row is written with the core start", () => {

  it("a second prefixed mention in the same thread (another request) starts NO second task: the start commits nothing and the guard still names the first", async () => {
    const w = await world();
    const first = await w.start(A);
    const guardBefore = await w.store.get(sharedTaskKey(THREAD));
    const secondRequest = randomUUID();
    await expect(w.start(A, { requestId: secondRequest })).rejects.toThrow();
    expect(await w.taskCount()).toBe(1);
    expect(await w.store.get(sharedTaskKey(THREAD))).toEqual(guardBefore);
    expect((await w.store.get(sharedTaskKey(THREAD)))!["taskId"]).toBe(first!.taskId);
    // Nothing of the refused start stays: not its request's idempotency row, not a charge for it.
    expect(await w.store.get(startIdempotencyKey(PERSON_A, secondRequest))).toBeUndefined();
  });

});

describe("a Slack retry of the same event (the same request id) is one task", () => {

  it("two deliveries of the same event at once: both answer the same task, one task exists", async () => {
    const w = await world();
    const requestId = randomUUID();
    const [one, two] = await Promise.all([w.start(A, { requestId }), w.start(A, { requestId })]);
    expect(one!.taskId).toBe(two!.taskId);
    expect(await w.taskCount()).toBe(1);
  });

  it("the same request id with other words is the core's refusal (never a task with the first one's id)", async () => {
    const w = await world();
    const requestId = randomUUID();
    await w.start(A, { requestId });
    await expect(w.start(A, { requestId, instructions: "Something else entirely" })).rejects.toThrow(/request_id/u);
    expect(await w.taskCount()).toBe(1);
  });
});

describe("other threads and other companies are not touched", () => {

  it("a person of company B starting in company A's workspace thread writes no row and starts no task (the row's company is the workspace's company)", async () => {
    const w = await world();
    await expect(w.start(B, { companyId: A })).rejects.toThrow(/another company/u);
    expect(await w.taskCount()).toBe(0);
    expect(await w.store.get(sharedTaskKey(THREAD))).toBeUndefined();
    // Company A's own person still starts it afterwards.
    expect(await w.start(A)).toBeDefined();
    expect(await w.taskCount()).toBe(1);
  });

  it("a person the readers could not read (an id that is not a 64-character hex id) is refused in fixed words: no row they would fail closed on, no task", async () => {
    const w = await world();
    const odd = localOwnerPrincipal({ companyId: A, personId: "local-owner" });
    const entry = entryOf(w.companies[A]!.runtime, odd);
    await expect(startSlackWorkflowOnCore(entry, { caller: w.caller("local-owner"), companyId: A, thread: THREAD, userId: USER, requestId: randomUUID(), project: "payments", instructions: "x", workflowPath: "QUICK" }))
      .rejects.toThrow(/could not be recorded/u);
    expect(await w.taskCount()).toBe(0);
    expect(await w.store.get(sharedTaskKey(THREAD))).toBeUndefined();
  });
});

describe("the guard's own rules", () => {
  const extras = (principal: Principal) => ({ taskId: randomUUID(), workspaceId: randomUUID(), project: "payments", title: "t", principal, client: "slack", receivedAt: "2026-11-18T07:00:00.000Z" });
  const input = { thread: THREAD, companyId: A, requestId: randomUUID() };

  it("the person's name is capped and never empty (the readers' own limits)", () => {
    const long = slackThreadGuardItem(input, extras({ ...localOwnerPrincipal({ companyId: A, personId: PERSON_A }), displayName: `  ${"n".repeat(500)}  ` }));
    expect((long as unknown as { item: { developerName: string } }).item.developerName).toHaveLength(200);
    const blank = slackThreadGuardItem(input, extras({ ...localOwnerPrincipal({ companyId: A, personId: PERSON_A }), displayName: "   " }));
    expect((blank as unknown as { item: { developerName: string } }).item.developerName).toBe("Rovara member");
  });

  it("a retry is only the same company's row for the same request id that a start of this kind wrote", () => {
    const row = { companyId: A, startRequestId: "r1", workflowThread: true };
    expect(isOwnSlackStart(row, { companyId: A, requestId: "r1" })).toBe(true);
    expect(isOwnSlackStart(row, { companyId: B, requestId: "r1" })).toBe(false);
    expect(isOwnSlackStart(row, { companyId: A, requestId: "r2" })).toBe(false);
    expect(isOwnSlackStart(row, { companyId: undefined, requestId: "r1" })).toBe(false);
    expect(isOwnSlackStart(undefined, { companyId: A, requestId: "r1" })).toBe(false);
    expect(isOwnSlackStart({ companyId: A, startRequestId: "r1" }, { companyId: A, requestId: "r1" })).toBe(false);
    expect(isOwnSlackStart({ startRequestId: "r1", workflowThread: true }, { companyId: A, requestId: "r1" })).toBe(false);
  });
});

describe("the wiring (guards on the source, beside the behaviour above)", () => {
  const source = (path: string) => readFileSync(new URL(`../../packages/broker/src/${path}`, import.meta.url), "utf8");

  it("the hosted core's start adds the call's fence, asked with the start's own ids, to its transaction", () => {
    expect(source("core-host/core-runtime.ts")).toMatch(/\.\.\.startFenceItems\(input\), coreTaskMarkItem\(/u);
    expect(source("core/task-flow/start.ts")).toMatch(/deps\.startExtras\?\.\(\{ taskId, workspaceId, project: request\.project,/u);
  });

  it("the Slack start runs the core start inside the guard's fence", () => {
    expect(source("aws/slack-core-start.ts")).toMatch(/withStartFence\(\(extras\) => \[slackThreadGuardItem\(input, extras\)\], \(\) => startOnCore\(/u);
  });
});
