// Lead 4 L4-HW8 (1): the hosted dispatcher's lessons reader gets a company-scoped, read-only people port (worker-machines/dispatcher-people.ts), so a worker step receives the company's lessons
// learned from other people's tasks while the person running the task is on the project's roster. The Dynamo client below plays the dispatcher ROLE: GetItem only, and on the sign-in table only the two keys with the projected attributes that
// infra/lib/task-person-proof.ts `DispatcherPolicy` grants.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GetCommand, QueryCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { LEARNED_CONTEXT_FEATURE, orgProjectCatalogKey, projectRevisionKey, type JsonValue, type ProjectDefinition } from "@agentx/contracts";
import { createDispatcherLearned } from "../../packages/broker/src/aws/worker-machines/dispatcher-lessons.js";
import { createDispatcherLessonsPeople, dispatcherPeopleClient } from "../../packages/broker/src/aws/worker-machines/dispatcher-people.js";
import { hostedDispatcherFlow, NO_PEOPLE_HERE } from "../../packages/broker/src/aws/worker-machines/dispatcher-core.js";
import { TASK_PERSON_COMPANY_MEMBER_ATTRIBUTES, TASK_PERSON_DEVELOPER_RECORD_ATTRIBUTES } from "../../packages/broker/src/aws/task-person-runtime.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { DocumentLessonStore } from "../../packages/broker/src/lessons/document-store.js";
import { setLearnedLessonsGate } from "../../packages/broker/src/lessons/policy.js";
import { taskKey, taskPointerKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { lessonRecord } from "./lessons/lesson-helpers.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const STATE = "state-table";
const SIGN_IN = "signin-table";
const now = 1_800_000_000_000;
const iso = new Date(now - 86_400_000).toISOString();
const definition: ProjectDefinition = { name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [{ name: "demo", url: "https://example.test/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }] };
// Person ids are the sign-in table's: 64 lowercase hex.
const person = (n: number) => n.toString(16).padStart(64, "0");
const WORLD = {
  [A]: { ws: "11111111-1111-4111-8111-11111111111a", task: "22222222-2222-4222-8222-22222222222a", source: "33333333-3333-4333-8333-33333333333a", lesson: "les_aaaa1111", title: "A advice", runner: person(1), author: person(2) },
  [B]: { ws: "11111111-1111-4111-8111-11111111111b", task: "22222222-2222-4222-8222-22222222222b", source: "33333333-3333-4333-8333-33333333333b", lesson: "les_bbbb1111", title: "B private advice", runner: person(3), author: person(4) },
} as const;
const request = (company: typeof A | typeof B) => ({ workspaceId: WORLD[company].ws, operationId: WORLD[company].task, workflowMode: "PLAN", features: [LEARNED_CONTEXT_FEATURE] });
afterEach(() => { setLearnedLessonsGate(undefined); });

/** What the dispatcher role may read of the sign-in table, as the infra says it (so the runtime's lists cannot drift from the grant). */
function infraList(name: string): string[] {
  const text = readFileSync("infra/lib/task-person-proof.ts", "utf8");
  const match = new RegExp(`const ${name} = \\[([^\\]]*)\\]`, "u").exec(text);
  return [...(match?.[1] ?? "").matchAll(/"([^"]+)"/gu)].map((found) => found[1]!);
}

async function world() {
  setLearnedLessonsGate(() => true);
  const store = new MemoryDocumentStore();
  const signIn = new Map<string, Record<string, unknown>>();
  for (const company of [A, B] as const) {
    const w = WORLD[company];
    await store.put({ item: { ...projectRevisionKey(company, "payments", 1), definition: definition as unknown as JsonValue } });
    await store.put({ item: { ...orgProjectCatalogKey(company, "payments"), latestRevision: 1 } });
    await store.put({ item: { ...workspaceKey(company, w.ws), entityType: "WORKSPACE", companyId: company } });
    await store.put({ item: { pk: `WORKSPACE#${w.ws}`, sk: "META", entityType: "WORKSPACE_COMPANY_POINTER", companyId: company, workspaceId: w.ws } });
    await store.put({ item: { ...taskPointerKey(company, w.ws), taskId: w.task } });
    const base = { entityType: "TASK", workspaceId: w.ws, companyId: company, project: "payments", title: "Retry network calls", startingRevision: 1, workflow: { revision: 1 } };
    await store.put({ item: { ...taskKey(w.task), ...base, taskId: w.task, developerId: w.runner } });
    await store.put({ item: { ...taskKey(w.source), ...base, taskId: w.source, developerId: w.author } });
    const lessons = new DocumentLessonStore(store, () => now);
    // Batch b18 (rule F): #998's one absolute fit floor loads a lesson for a step only when it fits the task ("Retry network calls") by its own words.
    const lesson = lessonRecord({ id: w.lesson, workspaceId: company, project: "payments", title: w.title, tier: 1, description: "Retry network calls with the shared helper.", body: "Retry network calls with the shared helper, not a hand-written loop.", approvals: [{ approvalId: "approved", by: "person-1", at: 1, mode: "one" }], citations: [], citationChecks: [], scope: {}, stages: ["PLAN"], provenance: { ...lessonRecord().provenance, supportTasks: [w.source] } });
    expect((await lessons.commit({ workspaceId: company, project: "payments" }, 0, [lesson], now)).ok).toBe(true);
    // Sign-in table: the person running the task is a live member of their own company holding a developer grant on the project (State table). Every person who can see the running task must be able to
    // see each source task, so it is the RUNNING person's standing on the roster that is read, live, for a lesson learned from another person's task (the source author has no row here at all).
    for (const id of [w.runner]) {
      signIn.set(`COMPANY_MEMBER#${id}|COMPANY`, { pk: `COMPANY_MEMBER#${id}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: id, companyId: company, role: "member", joinedAt: iso, joinedVia: "preapproval" });
      await store.put({ item: { pk: `MEMBER#${id}`, sk: "PROJECT#payments", projectName: "payments", role: "developer" } });
    }
  }
  const sent: Array<{ table: string; kind: string; key: { pk: string; sk: string }; projection: string[] | undefined }> = [];
  /** The dispatcher role: GetItem only; the sign-in table only by the two granted keys and their projected attributes; the State table by GetItem. */
  const documentClient = {
    send: vi.fn(async (command: unknown) => {
      if (!(command instanceof GetCommand)) throw new Error(`AccessDeniedException: ${(command as { constructor: { name: string } }).constructor.name}`);
      const { TableName, Key, ConsistentRead, ProjectionExpression, ExpressionAttributeNames } = command.input as { TableName: string; Key: { pk: string; sk: string }; ConsistentRead?: boolean; ProjectionExpression?: string; ExpressionAttributeNames?: Record<string, string> };
      const projection = ProjectionExpression === undefined ? undefined : ProjectionExpression.split(",").map((name) => ExpressionAttributeNames![name.trim()]!);
      sent.push({ table: TableName, kind: "get", key: Key, projection });
      if (ConsistentRead !== true) throw new Error("not consistent");
      if (TableName === SIGN_IN) {
        const allowed = Key.pk.startsWith("COMPANY_MEMBER#") ? infraList("COMPANY_MEMBER_ATTRIBUTES") : Key.pk.startsWith("DEVELOPER#") ? infraList("DEVELOPER_ATTRIBUTES") : undefined;
        if (allowed === undefined || projection === undefined || projection.some((attribute) => !allowed.includes(attribute))) throw new Error("AccessDeniedException: sign-in table");
        const row = signIn.get(`${Key.pk}|${Key.sk}`);
        return { Item: row === undefined ? undefined : Object.fromEntries(projection.filter((attribute) => attribute in row).map((attribute) => [attribute, row[attribute]])) };
      }
      if (TableName === STATE) return { Item: await store.get(Key) };
      throw new Error("unknown table");
    }),
  };
  // ONE factory per sign-in setting, as the deployment has: every company's port comes from it.
  const factories = new Map<string | null | undefined, ReturnType<typeof createDispatcherLessonsPeople>>();
  const peopleFor = (company: string, signInTableName: string | undefined | null = SIGN_IN) => {
    if (!factories.has(signInTableName)) factories.set(signInTableName, createDispatcherLessonsPeople({ documentClient, stateTableName: STATE, signInTableName: signInTableName === null ? undefined : signInTableName, now: () => now }));
    return factories.get(signInTableName)!(company, { store: async () => store });
  };
  const flowFor = (company: typeof A | typeof B, signInTableName: string | undefined | null = SIGN_IN) => hostedDispatcherFlow({ ROVARA_CORE_LESSONS: `on:${A}:${B}` }, { companyId: company, documentClient: documentClient as never, tableName: STATE, store, people: peopleFor(company, signInTableName), now: () => now })!;
  const writes = [vi.spyOn(store, "put"), vi.spyOn(store, "update"), vi.spyOn(store, "delete"), vi.spyOn(store, "transact")];
  return { store, signIn, sent, documentClient, peopleFor, flowFor, writes };
}

describe("the dispatcher's company-scoped lessons people port", () => {
  it("gives each company's step its own lessons, the running person's roster standing read live, and writes nothing", async () => {
    const w = await world();
    for (const write of w.writes) write.mockClear();
    const a = await w.flowFor(A).learned!(request(A));
    const b = await w.flowFor(B).learned!(request(B));
    expect(a.learnedContext?.lessons.map((lesson) => lesson.id)).toEqual(["les_aaaa1111"]);
    expect(b.learnedContext?.lessons.map((lesson) => lesson.id)).toEqual(["les_bbbb1111"]);
    expect(JSON.stringify(a)).not.toContain("B private advice");
    expect(JSON.stringify(b)).not.toContain("A advice");
    // The running person's standing was read for each company's own person (membership projected, then the project grant); the source authors were never looked up.
    expect(w.sent.some((read) => read.key.pk === `COMPANY_MEMBER#${WORLD[A].runner}` && read.table === SIGN_IN && read.projection !== undefined)).toBe(true);
    expect(w.sent.some((read) => read.key.pk === `MEMBER#${WORLD[B].runner}` && read.table === STATE)).toBe(true);
    expect(w.sent.some((read) => read.key.pk.includes(WORLD[A].author) || read.key.pk.includes(WORLD[B].author))).toBe(false);
    for (const write of w.writes) expect(write).not.toHaveBeenCalled();
  });

  it("every read the port makes is one the dispatcher role is granted (GetItem, the two sign-in keys, their projected attributes)", async () => {
    const w = await world();
    await w.flowFor(A).learned!(request(A));
    await w.peopleFor(A).displayName(A, WORLD[A].runner);
    await w.peopleFor(A).isErased(A, WORLD[A].runner);
    expect(w.sent.length).toBeGreaterThan(0);
    for (const read of w.sent.filter((entry) => entry.table === SIGN_IN)) {
      expect(read.projection).toBeDefined();
      expect(read.key.pk.startsWith("COMPANY_MEMBER#") || read.key.pk.startsWith("DEVELOPER#")).toBe(true);
    }
    expect([...TASK_PERSON_COMPANY_MEMBER_ATTRIBUTES]).toEqual(infraList("COMPANY_MEMBER_ATTRIBUTES"));
    expect([...TASK_PERSON_DEVELOPER_RECORD_ATTRIBUTES]).toEqual(infraList("DEVELOPER_ATTRIBUTES"));
    expect(infraList("DEVELOPER_ATTRIBUTES")).not.toContain("mergedInto");
  });

  it("withholds the lessons learned from other people's tasks when the person running the task is no longer on the company (removed), is another company's member, or has no grant, and does not fail the step", async () => {
    for (const change of ["removed", "other-company", "no-grant"] as const) {
      const w = await world();
      const key = `COMPANY_MEMBER#${WORLD[A].runner}|COMPANY`;
      if (change === "removed") w.signIn.set(key, { ...w.signIn.get(key)!, revokedAt: iso });
      if (change === "other-company") w.signIn.set(key, { ...w.signIn.get(key)!, companyId: B });
      if (change === "no-grant") await w.store.delete({ key: { pk: `MEMBER#${WORLD[A].runner}`, sk: "PROJECT#payments" } });
      expect(await w.flowFor(A).learned!(request(A)), change).toEqual({});
      // The other company is unaffected.
      expect((await w.flowFor(B).learned!(request(B))).learnedContext?.lessons.map((lesson) => lesson.id)).toEqual(["les_bbbb1111"]);
    }
  });

  it("an owner or admin is on every roster of the company; a member of another company is on none of this one's", async () => {
    const w = await world();
    const admin = person(9);
    w.signIn.set(`COMPANY_MEMBER#${admin}|COMPANY`, { pk: `COMPANY_MEMBER#${admin}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: admin, companyId: A, role: "admin", joinedAt: iso });
    expect(await w.peopleFor(A).onProjectRoster(A, "payments", admin)).toBe(true);
    expect(await w.peopleFor(B).onProjectRoster(B, "payments", admin)).toBe(false);
    expect(await w.peopleFor(B).onProjectRoster(B, "payments", WORLD[A].runner)).toBe(false);
  });

  it("a port built for one company throws for another company's question and reads nothing for it", async () => {
    const w = await world();
    w.sent.length = 0;
    await expect(w.peopleFor(A).onProjectRoster(B, "payments", WORLD[B].runner)).rejects.toThrow();
    await expect(w.peopleFor(A).displayName(B, WORLD[B].runner)).rejects.toThrow();
    await expect(w.peopleFor(A).isErased(B, WORLD[B].runner)).rejects.toThrow();
    expect(w.sent).toEqual([]);
  });

  it("refuses the member list (approvers) in fixed words, offers no member list or merge resolver, and sends nothing", async () => {
    const w = await world();
    const port = w.peopleFor(A);
    w.sent.length = 0;
    await expect(port.approvers(A, "payments")).rejects.toMatchObject({ message: `RUNTIME_UNAVAILABLE: ${NO_PEOPLE_HERE}` });
    await expect(port.approvers(A, undefined)).rejects.toMatchObject({ message: `RUNTIME_UNAVAILABLE: ${NO_PEOPLE_HERE}` });
    expect(Object.hasOwn(port, "projectMembers")).toBe(false);
    expect(Object.hasOwn(port, "resolveMember")).toBe(false);
    expect(w.sent).toEqual([]);
    expect(w.documentClient.send.mock.calls.every(([command]) => !(command instanceof QueryCommand))).toBe(true);
  });

  it("without the sign-in table every roster question throws and the step refuses in fixed words (nothing partial); nothing is read from it", async () => {
    for (const table of [null, ""]) {
      const w = await world();
      w.sent.length = 0;
      await expect(w.peopleFor(A, table).onProjectRoster(A, "payments", WORLD[A].runner)).rejects.toThrow();
      await expect(w.flowFor(A, table).learned!(request(A))).rejects.toThrow(/RUNTIME_UNAVAILABLE/u);
      expect(w.sent.filter((read) => read.table === SIGN_IN)).toEqual([]);
    }
  });

  it("the placeholder is gone: the dispatcher flow's reader is built over the port, not over refusals (the same lesson loads, then is withheld when the roster says no)", async () => {
    const w = await world();
    const reader = createDispatcherLearned({ companyId: A, lessonsSwitch: { mode: "on" }, documentClient: w.documentClient as never, tableName: STATE, store: w.store, people: w.peopleFor(A), now: () => now });
    expect((await reader(request(A))).learnedContext?.lessons.length).toBe(1);
    w.signIn.delete(`COMPANY_MEMBER#${WORLD[A].runner}|COMPANY`);
    expect(await reader(request(A))).toEqual({});
  });
});

describe("the client the port reads through", () => {
  const inner = { send: vi.fn(async () => ({ Item: { ok: true } })) };
  const client = dispatcherPeopleClient({ documentClient: inner, stateTableName: STATE, signInTableName: SIGN_IN });
  const get = (TableName: string, pk: string, sk: string, extra: Record<string, unknown> = { ConsistentRead: true }) => new GetCommand({ TableName, Key: { pk, sk }, ...extra });
  it("sends only the granted reads, projected, and refuses everything else before it is sent", async () => {
    inner.send.mockClear();
    await client.send(get(SIGN_IN, "COMPANY_MEMBER#x", "COMPANY"));
    await client.send(get(SIGN_IN, "DEVELOPER#x", "META"));
    await client.send(get(STATE, "MEMBER#x", "PROJECT#payments"));
    expect(inner.send).toHaveBeenCalledTimes(3);
    const sentSignIn = inner.send.mock.calls.slice(0, 2).map((call) => ((call as unknown[])[0] as GetCommand).input);
    for (const input of sentSignIn) expect(input.ProjectionExpression).toBeDefined();
    inner.send.mockClear();
    for (const command of [
      new QueryCommand({ TableName: SIGN_IN, KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": "COMPANY_MEMBER#x" } }),
      new PutCommand({ TableName: STATE, Item: { pk: "MEMBER#x", sk: "PROJECT#payments" } }),
      get(SIGN_IN, "COMPANY_MEMBER#x", "COMPANY", {}),
      get(SIGN_IN, "COMPANY_MEMBER#x", "OTHER"),
      get(SIGN_IN, "DEVELOPER#x", "OTHER"),
      get(SIGN_IN, "COMPANY#x", "META"),
      get(STATE, "TASK#x", "META"),
      get(STATE, "MEMBER#x", "OTHER#payments"),
      get("other-table", "MEMBER#x", "PROJECT#payments"),
      get("other-table", "COMPANY_MEMBER#x", "COMPANY"),
      get("other-table", "DEVELOPER#x", "META"),
    ]) await expect(client.send(command)).rejects.toMatchObject({ message: `RUNTIME_UNAVAILABLE: ${NO_PEOPLE_HERE}` });
    expect(inner.send).not.toHaveBeenCalled();
  });
  it("has no sign-in table to read when none is named", async () => {
    const none = dispatcherPeopleClient({ documentClient: inner, stateTableName: STATE, signInTableName: undefined });
    inner.send.mockClear();
    await expect(none.send(get(SIGN_IN, "COMPANY_MEMBER#x", "COMPANY"))).rejects.toThrow();
    await expect(dispatcherPeopleClient({ documentClient: inner, stateTableName: STATE, signInTableName: "" }).send(get("", "COMPANY_MEMBER#x", "COMPANY"))).rejects.toThrow();
    expect(inner.send).not.toHaveBeenCalled();
  });
});
