// Lead 4 L4-JA56 (B5 + B6): on a deployed install the weekly lessons summary reaches the chat, and a company the lessons flag names has its scheduled jobs before its first core task. The root, registry, runtime, lessons and the
// digest are real; only the deployment's adapters (the fake world) and the company's chat seam (`ChatThreads`, a fake with one adapter per company) are stand-ins.
//   B5  `ROVARA_CORE_ENGINE=on` lists the install's own company and the companies holding an in-use mark. A company that `ROVARA_CORE_LESSONS=on:<id>` or `ROVARA_CORE_SYSTEM_RUNS=on:<id>` names (and no other) is listed too.
//   B6  the summary asks the company's own chat seam for the adapter (the registry the notices read), not the raw core registry (which has no `channel` point on a deployed install). A summary that was not delivered is not marked done.
import { afterEach, describe, expect, it, vi } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { companyScoped, orgProjectCatalogKey, projectRevisionKey, type ChannelAdapter, type ChannelEvent, type JsonValue, type OrgId, type ProjectDefinition } from "@agentx/contracts";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { prefsKey } from "../../packages/broker/src/core/notify/prefs.js";
import type { ChatThreads } from "../../packages/broker/src/core-host/chat-threads.js";
import * as lessonsModule from "../../packages/broker/src/core-host/lessons.js";
import type { HostedLessonPeople } from "../../packages/broker/src/lessons/hosted-people.js";
import { setLearnedLessonsGate } from "../../packages/broker/src/lessons/policy.js";
import { createFakeWorld, FAKE_COMPANY } from "../support/core-host-fakes.js";
import { draft, lessonRecord } from "./lessons/lesson-helpers.js";

afterEach(() => setLearnedLessonsGate(undefined));

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
const DAY = 86_400_000;
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const DECIDERS: Record<string, string[]> = { [A]: ["a-admin"], [B]: ["b-admin"] };
const people = (): HostedLessonPeople => ({
  async approvers(companyId) { const ids = DECIDERS[companyId]; if (ids === undefined) throw new Error("another company"); return { complete: true, membershipVersion: 1, ownerIds: [ids[0]!], eligibleIds: [...ids], lastEligibleLossAtMs: null }; },
  async onProjectRoster(companyId, _project, personId) { return (DECIDERS[companyId] ?? []).includes(personId); },
  async linkedAccounts() { return []; }, async displayName() { return undefined; }, async isErased() { return false; },
});

function chatAdapter(over: { fail?: boolean } = {}): ChannelAdapter & { events: ChannelEvent[] } {
  const events: ChannelEvent[] = [];
  return {
    events, projects: [], stepUp: [],
    capabilities: { threads: true, buttons: 0, edits: false, maxTextLength: 4_000, proactive: true, ephemeral: false, direct: false, documents: false, directory: false, forms: false },
    async deliver(event) { if (over.fail === true) throw new Error("down"); events.push(event); },
  };
}

async function setup(options: { lessons?: string; systemRuns?: string; chat?: boolean; adapters?: Partial<Record<OrgId, ChannelAdapter | undefined>> } = {}) {
  const world = createFakeWorld();
  adapters.modules = world.modules;
  const client = { async send(command: unknown) {
    if (command instanceof GetCommand) return { Item: await world.store.get((command.input as unknown as { Key: { pk: string; sk: string } }).Key) };
    throw new Error("unexpected");
  } };
  const own: Record<string, ChannelAdapter | undefined> = options.adapters ?? { [A]: chatAdapter(), [B]: chatAdapter() };
  const asked: Array<{ company: string; channel: string }> = [];
  const threads: ChatThreads = {
    companyOf: async ({ tenant }) => (tenant === "TA" ? A : tenant === "TB" ? B : undefined),
    adapterFor: (company, channel) => { asked.push({ company, channel }); return channel === "chat" ? own[company] : undefined; },
    channels: ["chat"],
  };
  const logs: Array<Record<string, unknown>> = [];
  const root = createBrokerCoreRoot({
    env: { ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: "all", ...(options.lessons === undefined ? {} : { ROVARA_CORE_LESSONS: options.lessons }), ...(options.systemRuns === undefined ? {} : { ROVARA_CORE_SYSTEM_RUNS: options.systemRuns }) },
    documentClient: client, stateTableName: "state", signInTableName: "signin", callbackSigningKey: secret.toString(), repositoryGrantKey: secret,
    codeModules: () => ({}) as never, repositoryCredential: async () => { throw new Error("unused"); }, origin: () => "https://api.example", log: (entry) => { logs.push(entry); },
    now: () => new Date(world.clock.now), ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
    services: () => Object.fromEntries(["merge-tracking", "session-sweep", "notify-deliver", "admission-hold-sweep"].map((name) => [name, { pass: async () => ({}) }])),
    lessonsPeople: () => people(),
    ...(options.chat === false ? {} : { chatThreads: threads }),
  });
  return { root, world, own, asked, logs };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const job = (s: Setup, name: string) => s.root.app.handleScheduledJob({ source: "agentx.core-job", job: name }) as Promise<{ job: string; companies: Array<{ companyId: string; outcome: string }> }>;

async function lessonsOf(s: Setup, companyId: OrgId): Promise<lessonsModule.CoreLessons> {
  await s.root.app.runtimeFor(companyId);
  const found = vi.mocked(lessonsModule.createCoreLessons).mock.results.map((entry) => entry.value as lessonsModule.CoreLessons | undefined).find((entry) => entry?.companyId === companyId);
  if (found === undefined) throw new Error("no lessons built");
  return found;
}

/** The company's project, one lesson waiting for a decision that expires tomorrow, and its admin's chat place. */
async function ready(s: Setup, companyId: OrgId, tenant: string): Promise<void> {
  await s.world.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
  await s.world.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
  const lessons = await lessonsOf(s, companyId);
  const key = { workspaceId: companyId, project: "payments" };
  const one = lessonRecord({
    id: `les_${companyId.slice(-4)}waiting`, workspaceId: companyId, project: "payments", tier: 1, tierReasons: [], approvals: [], scope: {}, citations: [], citationChecks: [], stages: ["PLAN"],
    provenance: { ...draft().provenance, supportTasks: [], authors: ["ann"] }, title: `Waiting in ${companyId.slice(-1)}`, description: "d", body: "Body never sent.", status: "pending", pendingExpiresAt: s.world.clock.now + DAY,
  });
  await lessons.runtime.store.commit(key, await lessons.runtime.store.setVersion(key), [one], 1);
  const who = DECIDERS[companyId]![0]!;
  await s.world.store.put({ item: { ...prefsKey(companyId, who), orgId: companyId, targets: [{ channel: "chat", conversation: { channel: "chat", tenant, space: `D-${who}`, thread: "none" } }] } });
}
const weekRow = (s: Setup, companyId: OrgId) => s.world.store.get({ pk: companyScoped(companyId, "LESSON_DIGEST#payments"), sk: "WEEK" });
const sentRow = (s: Setup, companyId: OrgId) => s.world.store.get({ pk: companyScoped(companyId, "LESSON_DIGEST#payments"), sk: `SENT#${DECIDERS[companyId]![0]!}` });
const eventsOf = (s: Setup, companyId: OrgId) => (s.own[companyId] as ReturnType<typeof chatAdapter>).events;

describe("B5: a company a lessons or system-runs flag names has its scheduled jobs before its first core task", () => {

  it("ROVARA_CORE_LESSONS=on:<id> lists that company (and only it) for every job, with no mark and no task", async () => {
    const s = await setup({ lessons: `on:${A}` });
    for (const name of ["dispatch-sweep", "run-watch", "notify-deliver", "merge-tracking", "lessons"]) {
      const result = await job(s, name);
      expect(result.companies.filter((entry) => entry.companyId === A), name).toEqual([expect.objectContaining({ companyId: A, outcome: "ran" })]);
      expect(result.companies.map((entry) => entry.companyId), name).not.toContain(B);
    }
  });

  it("ROVARA_CORE_SYSTEM_RUNS=on:<id> does the same, and the two flags naming two companies list both", async () => {
    const one = await setup({ systemRuns: `on:${B}` });
    expect((await job(one, "dispatch-sweep")).companies.map((entry) => entry.companyId)).toContain(B);
    expect((await job(one, "dispatch-sweep")).companies.map((entry) => entry.companyId)).not.toContain(A);
    const both = await setup({ lessons: `on:${A}`, systemRuns: `on:${B}` });
    const listed = (await job(both, "dispatch-sweep")).companies.map((entry) => entry.companyId);
    expect(listed).toEqual(expect.arrayContaining([A, B]));
  });

  it("a flag cannot widen the engine: with the engine on for only company A, a company B the lessons flag names is not run", async () => {
    const world = createFakeWorld();
    adapters.modules = world.modules;
    const client = { async send() { throw new Error("unused"); } };
    const root = createBrokerCoreRoot({
      env: { ROVARA_CORE_ENGINE: `on:${A}`, ROVARA_CORE_LESSONS: `on:${A}:${B}` }, documentClient: client, stateTableName: "state", signInTableName: "signin", callbackSigningKey: secret.toString(), repositoryGrantKey: secret,
      codeModules: () => ({}) as never, repositoryCredential: async () => { throw new Error("unused"); }, origin: () => "https://api.example", log: () => undefined, now: () => new Date(world.clock.now),
      ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const }, services: () => Object.fromEntries(["merge-tracking", "session-sweep", "notify-deliver", "admission-hold-sweep"].map((name) => [name, { pass: async () => ({}) }])),
      lessonsPeople: () => people(),
    });
    const result = (await root.app.handleScheduledJob({ source: "agentx.core-job", job: "dispatch-sweep" })) as { companies: Array<{ companyId: string }> };
    expect(result.companies.map((entry) => entry.companyId)).toEqual([A]);
  });
});

describe("B6: the weekly lessons summary is delivered through the company's own chat seam", () => {

  it("two companies: each company's summary goes through its own seam adapter only; a place on the other company's tenant gets nothing", async () => {
    const s = await setup({ lessons: `on:${A}:${B}` });
    await ready(s, A, "TA");
    await ready(s, B, "TA");
    await job(s, "lessons");
    expect(eventsOf(s, A)).toHaveLength(1);
    expect(eventsOf(s, B)).toHaveLength(0);
    expect(s.asked.filter((entry) => entry.company === B).length).toBeGreaterThan(0);
  });

  it("a chat adapter the seam does not serve: nothing is delivered, the week and the person stay due, a fixed line is logged, and the next pass delivers once the adapter is there", async () => {
    const mine = chatAdapter();
    const s = await setup({ lessons: `on:${A}`, adapters: { [A]: undefined, [B]: undefined } });
    await ready(s, A, "TA");
    const failed = await job(s, "lessons");
    expect(failed.companies.find((entry) => entry.companyId === A)).toMatchObject({ outcome: "ran" });
    expect(await weekRow(s, A)).toBeUndefined();
    expect(await sentRow(s, A)).toMatchObject({ tries: 1 });
    expect(s.logs.some((entry) => typeof entry["event"] === "string" && (entry["event"].includes("no_adapter") || entry["event"].includes("undelivered")))).toBe(true);
    s.own[A] = mine;
    s.world.clock.now += 3_600_001;
    await job(s, "lessons");
    expect(mine.events).toHaveLength(1);
    expect(await weekRow(s, A)).toBeDefined();
  });

  it("a send that fails is not marked done: the claim is released and the next pass sends it, once", async () => {
    const broken = chatAdapter({ fail: true });
    const s = await setup({ lessons: `on:${A}`, adapters: { [A]: broken } });
    await ready(s, A, "TA");
    await job(s, "lessons");
    expect(broken.events).toHaveLength(0);
    expect(await weekRow(s, A)).toBeUndefined();
    expect(await sentRow(s, A)).toMatchObject({ tries: 1 });
    const fixed = chatAdapter();
    s.own[A] = fixed;
    s.world.clock.now += 3_600_001;
    await job(s, "lessons");
    await job(s, "lessons");
    expect(fixed.events).toHaveLength(1);
    expect(await weekRow(s, A)).toBeDefined();
  });
});
