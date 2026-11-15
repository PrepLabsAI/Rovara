// The weekly lessons summary in the chats (lessons holistic review fix 7): off by default, behind the mode, to the people who decide, through their chosen chat places on this company's tenant,
// once per person and week, with expiry and fade warnings, and only the lessons each person may see. Two companies with the same project name never see each other's summary.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { companyScoped, orgProjectCatalogKey, projectRevisionKey, type ChannelAdapter, type ChannelEvent, type JsonValue, type OrgId, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../../packages/broker/src/core/task-flow/access.js";
import { localOwnerPrincipal } from "../../../packages/broker/src/ports/policy-defaults.js";
import { prefsKey } from "../../../packages/broker/src/core/notify/prefs.js";
import { buildCoreRegistry, createCoreRuntime, readCoreEngineFlags } from "../../../packages/broker/src/core-host/index.js";
import { createCoreLessons, erasePersonLessons, readCoreLessonsSwitch, setCoreLessonsGate, CORE_LESSONS_VARIABLE, type CoreLessons } from "../../../packages/broker/src/core-host/lessons.js";
import { DIGEST_PEOPLE_MAX, digestNoticeText, readDigestSetting, sendLessonDigests, writeDigestSetting, type DigestNoticeDeps } from "../../../packages/broker/src/lessons/digest-notice.js";
import { writeLearningMode } from "../../../packages/broker/src/lessons/document-settings.js";
import type { HostedLessonPeople } from "../../../packages/broker/src/lessons/hosted-people.js";
import { setLearnedLessonsGate } from "../../../packages/broker/src/lessons/policy.js";
import { createFakeWorld, FAKE_COMPANY, type FakeWorld } from "../../support/core-host-fakes.js";
import { draft, lessonRecord } from "./lesson-helpers.js";

afterEach(() => setLearnedLessonsGate(undefined));

const A = FAKE_COMPANY as OrgId;
const B = "org_corehost00000000000b" as OrgId;
const DAY = 86_400_000;
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const DECIDERS: Record<string, string[]> = { [A]: ["a-admin", "a-maint"], [B]: ["b-admin"] };

function people(): HostedLessonPeople {
  return {
    async approvers(companyId) { const ids = DECIDERS[companyId]; if (ids === undefined) throw new Error("another company"); return { complete: true, membershipVersion: 1, ownerIds: [ids[0]!], eligibleIds: [...ids], lastEligibleLossAtMs: null }; },
    async onProjectRoster(companyId, _project, personId) { return (DECIDERS[companyId] ?? []).includes(personId); },
    async linkedAccounts() { return []; },
    async displayName() { return undefined; },
    async isErased() { return false; },
  };
}

interface World { world: FakeWorld; lessons: Map<OrgId, CoreLessons> }
async function setUp(): Promise<World> {
  const world = createFakeWorld();
  const env = { [CORE_LESSONS_VARIABLE]: "on" };
  setCoreLessonsGate(env);
  const registry = await buildCoreRegistry({ modules: world.modules, context: world.context(), areas: ["flow", "build", "merge"] });
  const lessons = new Map<OrgId, CoreLessons>();
  for (const companyId of [A, B]) {
    await world.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
    await world.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
    const runtime = createCoreRuntime({
      registry, companyId, flags: readCoreEngineFlags({ ROVARA_CORE_ENGINE: "on" }), callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5),
      repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined,
    });
    const built = createCoreLessons({ flow: runtime.flow, registry, companyId, lessonsSwitch: readCoreLessonsSwitch(env).value, people: people(), hostFor: async (id) => lessons.get(id)?.host, now: () => world.clock.now });
    lessons.set(companyId, built!);
    await runtime.flow.start({ principal: localOwnerPrincipal({ companyId }), client: "test", origin: "app" as const }, { requestId: randomUUID(), project: "payments", instructions: "x", workflow: true, workflowPath: "QUICK" });
  }
  return { world, lessons };
}

/** A chat adapter that records what it was given; `proactive` false is one that may not message first. */
function adapter(over: { proactive?: boolean; fail?: boolean } = {}): ChannelAdapter & { events: ChannelEvent[] } {
  const events: ChannelEvent[] = [];
  return {
    events, projects: [], stepUp: [],
    capabilities: { threads: true, buttons: 0, edits: false, maxTextLength: 4_000, proactive: over.proactive ?? true, ephemeral: false, direct: false, documents: false, directory: false, forms: false },
    async deliver(event) { if (over.fail === true) throw new Error("down"); events.push(event); },
  };
}
const conversation = (tenant: string, space: string) => ({ channel: "chat", tenant, space, thread: "none" });
async function chooseSlack(w: World, companyId: OrgId, personId: string, tenant = companyId === A ? "TA" : "TB", extra: Record<string, unknown> = {}): Promise<void> {
  await w.world.store.put({ item: { ...prefsKey(companyId, personId), orgId: companyId, targets: [{ channel: "chat", conversation: conversation(tenant, `D-${personId}`) }], ...extra } });
}

const lesson = (companyId: OrgId, id: string, over: Parameters<typeof lessonRecord>[0] = {}) => lessonRecord({
  id, workspaceId: companyId, project: "payments", tier: 1, tierReasons: [], approvals: [], scope: {}, citations: [], citationChecks: [], stages: ["PLAN"],
  provenance: { ...draft().provenance, supportTasks: [], authors: ["ann"] }, title: `Lesson ${id}`, description: "d", body: "Body text that is never sent.", ...over,
});
async function put(w: World, companyId: OrgId, ...lessons: ReturnType<typeof lessonRecord>[]): Promise<void> {
  const store = w.lessons.get(companyId)!.runtime.store;
  const key = { workspaceId: companyId, project: "payments" };
  for (const one of lessons) await store.commit(key, await store.setVersion(key), [one], 1);
}

function deps(w: World, companyId: OrgId, slack: ChannelAdapter | undefined, over: Partial<DigestNoticeDeps> = {}): DigestNoticeDeps {
  const runtime = w.lessons.get(companyId)!.runtime;
  return {
    companyId, documents: runtime.documents, store: runtime.store, directory: runtime.directory, access: runtime.access, settings: runtime.settings,
    registry: { get: ((kind: string, id: string) => (kind === "channel" && id === "chat" ? slack : undefined)) as DigestNoticeDeps["registry"]["get"] },
    companyOf: async ({ tenant }) => (tenant === "TA" ? A : tenant === "TB" ? B : undefined), now: () => w.world.clock.now, ...over,
  };
}
const run = (d: DigestNoticeDeps) => sendLessonDigests(d, ["payments"], { deadlineAt: Date.now() + 10_000 });

/** A world where A's project has the summary on, one lesson waiting that expires tomorrow, one live lesson that fades in a week and one waiting for longer. */
async function busyWorld(): Promise<World> {
  const w = await setUp();
  const now = w.world.clock.now;
  await put(w, A,
    lesson(A, "les_expiring", { status: "pending", pendingExpiresAt: now + DAY, title: "Expiring soon" }),
    lesson(A, "les_waiting1", { status: "pending", pendingExpiresAt: now + 6 * DAY, title: "Waiting a while" }),
    lesson(A, "les_fading01", { status: "active", expiresAt: now + 7 * DAY, title: "Fading soon" }),
    lesson(A, "les_healthy1", { status: "active", expiresAt: now + 60 * DAY, title: "Healthy" }));
  await writeDigestSetting(w.lessons.get(A)!.runtime.documents, A, "payments", true, now);
  return w;
}

describe("the weekly lessons summary", () => {
  it("control: off by default, nothing is sent and nothing is written", async () => {
    const w = await setUp();
    await put(w, A, lesson(A, "les_waiting1", { status: "pending", pendingExpiresAt: w.world.clock.now + DAY }));
    await chooseSlack(w, A, "a-admin");
    const slack = adapter();
    expect(await readDigestSetting(w.world.store, A, "payments")).toBe(false);
    expect(await run(deps(w, A, slack))).toEqual({ projects: 0, sent: 0, held: 0, failed: 0 });
    expect(slack.events).toEqual([]);
    expect(await w.world.store.get({ pk: companyScoped(A, "LESSON_DIGEST#payments"), sk: "SENT#a-admin" })).toBeUndefined();
  });

  it("on: each person who decides gets one message on their chosen place, with counts, the expiry and fade warnings, titles only; once a week", async () => {
    const w = await busyWorld();
    await chooseSlack(w, A, "a-admin");
    await chooseSlack(w, A, "a-maint");
    const slack = adapter();
    expect(await run(deps(w, A, slack))).toMatchObject({ projects: 1, sent: 2, failed: 0 });
    expect(slack.events.map((e) => (e as { conversation: { space: string } }).conversation.space).sort()).toEqual(["D-a-admin", "D-a-maint"]);
    const text = (slack.events[0] as { data: { text: string } }).data.text;
    expect(text).toContain("Lessons this week in payments:");
    expect(text).toContain("- 2 waiting for a decision");
    expect(text).toContain('Expiring in the next 2 days unless someone decides: "Expiring soon"');
    expect(text).toContain('Fading in the next 14 days because they have not helped lately: "Fading soon"');
    expect(text).not.toContain("Waiting a while\"");
    expect(text).not.toContain("Healthy");
    expect(text).not.toContain("never sent");
    expect(slack.events.every((e) => e.type === "progress" && /^evt_[A-Za-z0-9_-]{32}$/u.test(e.id))).toBe(true);
    // Once a week: the next passes of the week send nothing; the next week sends again with new ids.
    expect(await run(deps(w, A, slack))).toMatchObject({ sent: 0 });
    expect(slack.events).toHaveLength(2);
    const firstIds = slack.events.map((e) => e.id);
    w.world.clock.now += 7 * DAY;
    await put(w, A, lesson(A, "les_newone01", { status: "pending", pendingExpiresAt: w.world.clock.now + DAY }));
    expect(await run(deps(w, A, slack))).toMatchObject({ sent: 2 });
    expect(slack.events.slice(2).every((e) => !firstIds.includes(e.id))).toBe(true);
  });

  it("two companies, one project name: B's summary is B's own lessons to B's people on B's tenant; A's switch does not turn B's on", async () => {
    const w = await busyWorld();
    await chooseSlack(w, A, "a-admin");
    await chooseSlack(w, B, "b-admin");
    const slack = adapter();
    expect(await run(deps(w, B, slack))).toMatchObject({ projects: 0, sent: 0 });
    await put(w, B, lesson(B, "les_bwait001", { status: "pending", pendingExpiresAt: w.world.clock.now + DAY, title: "B only" }));
    await writeDigestSetting(w.world.store, B, "payments", true, w.world.clock.now);
    expect(await run(deps(w, B, slack))).toMatchObject({ projects: 1, sent: 1 });
    const text = (slack.events[0] as { data: { text: string } }).data.text;
    expect(text).toContain('"B only"');
    expect(text).not.toContain("Expiring soon");
    expect((slack.events[0] as { conversation: { tenant: string } }).conversation.tenant).toBe("TB");
  });

  it("a place on another company's tenant, an adapter that may not message first, a muted person or one with no place gets nothing", async () => {
    const w = await busyWorld();
    await chooseSlack(w, A, "a-admin", "TB");
    await chooseSlack(w, A, "a-maint", "TA", { muted: true });
    const slack = adapter();
    expect(await run(deps(w, A, slack))).toMatchObject({ sent: 0 });
    expect(slack.events).toEqual([]);
    const quiet = await busyWorld();
    await chooseSlack(quiet, A, "a-admin");
    const shy = adapter({ proactive: false });
    expect(await run(deps(quiet, A, shy))).toMatchObject({ sent: 0 });
    expect(shy.events).toEqual([]);
  });

  it("quiet hours hold the summary to a later pass; it is not lost", async () => {
    const w = await busyWorld();
    const hour = new Date(w.world.clock.now).getUTCHours();
    const at = (h: number) => `${String((h + 24) % 24).padStart(2, "0")}:00`;
    await chooseSlack(w, A, "a-admin", "TA", { quietHours: { start: at(hour - 1), end: at(hour + 1) } });
    const slack = adapter();
    expect(await run(deps(w, A, slack))).toMatchObject({ sent: 0, held: 1 });
    w.world.clock.now += 3 * 3_600_000;
    expect(await run(deps(w, A, slack))).toMatchObject({ sent: 1 });
  });

  it("behind the mode: Off and Collect send nothing", async () => {
    for (const mode of ["Off", "Collect"] as const) {
      const w = await busyWorld();
      await chooseSlack(w, A, "a-admin");
      await writeLearningMode(w.world.store, { workspaceId: A, project: "payments" }, mode, 1);
      const slack = adapter();
      expect(await run(deps(w, A, slack))).toMatchObject({ projects: 0, sent: 0 });
    }
  });

  it("an empty week sends nothing; a failed send is not repeated in the week (at most once) and never throws", async () => {
    const w = await setUp();
    await writeDigestSetting(w.world.store, A, "payments", true, w.world.clock.now);
    await chooseSlack(w, A, "a-admin");
    const slack = adapter();
    expect(await run(deps(w, A, slack))).toMatchObject({ projects: 1, sent: 0 });
    expect(slack.events).toEqual([]);
    const busy = await busyWorld();
    await chooseSlack(busy, A, "a-admin");
    const broken = adapter({ fail: true });
    expect(await run(deps(busy, A, broken))).toMatchObject({ sent: 0, failed: 1 });
    expect(await run(deps(busy, A, adapter()))).toMatchObject({ sent: 0 });
  });

  it("a person whose records cannot be read is held alone; the others are still told", async () => {
    const w = await busyWorld();
    await chooseSlack(w, A, "a-admin");
    await chooseSlack(w, A, "a-maint");
    const slack = adapter();
    const base = deps(w, A, slack);
    const identity = base.directory.identity.bind(base.directory);
    const directory = { ...base.directory, eligibility: base.directory.eligibility.bind(base.directory), identity: async (companyId: string, personId: string) => { if (personId === "a-admin") throw new Error("down"); return await identity(companyId, personId); } };
    expect(await run({ ...base, directory })).toMatchObject({ sent: 1, failed: 1 });
    expect(await run(base)).toMatchObject({ sent: 1 });
  });

  it("the person erase removes their sent row; others' rows stay", async () => {
    const w = await busyWorld();
    await chooseSlack(w, A, "a-admin");
    await chooseSlack(w, A, "a-maint");
    await run(deps(w, A, adapter()));
    await erasePersonLessons({ store: w.world.store, audit: { stage: () => [], record: async () => undefined }, companyId: A, personId: "a-admin", now: () => w.world.clock.now });
    expect(await w.world.store.get({ pk: companyScoped(A, "LESSON_DIGEST#payments"), sk: "SENT#a-admin" })).toBeUndefined();
    expect(await w.world.store.get({ pk: companyScoped(A, "LESSON_DIGEST#payments"), sk: "SENT#a-maint" })).toBeDefined();
    expect(await readDigestSetting(w.world.store, A, "payments")).toBe(true);
  });

  it("the text: fixed words, titles cut and capped, the whole message within the place's limit", () => {
    expect(digestNoticeText("payments", { waiting: 0, wentLive: 0, retired: 0, expiring: [], fading: [] }, 4_000)).toBeUndefined();
    const many = Array.from({ length: 8 }, (_, i) => ({ title: `T${String(i)} ${"x".repeat(200)}\u0000` }));
    const text = digestNoticeText("payments", { waiting: 1, wentLive: 2, retired: 3, expiring: many, fading: [] }, 4_000)!;
    expect(text).toContain("and 3 more");
    expect(text).not.toContain("\u0000");
    expect(text).not.toContain("x".repeat(100));
    expect([...digestNoticeText("payments", { waiting: 1, wentLive: 0, retired: 0, expiring: many, fading: many }, 300)!].length).toBeLessThanOrEqual(300);
    expect(DIGEST_PEOPLE_MAX).toBe(50);
  });
  it("a setting that cannot be read is off; a list of deciders that is not complete is nobody (retried later)", async () => {
    const w = await busyWorld();
    await chooseSlack(w, A, "a-admin");
    const slack = adapter();
    const base = deps(w, A, slack);
    const get = base.documents.get.bind(base.documents);
    const broken = Object.assign(Object.create(Object.getPrototypeOf(base.documents) as object) as typeof base.documents, base.documents, {
      get: async (key: Parameters<typeof get>[0]) => { if (key.sk === "SETTING") throw new Error("down"); return await get(key); },
    });
    expect(await run({ ...base, documents: broken })).toMatchObject({ projects: 0, sent: 0 });
    const eligibility = base.directory.eligibility.bind(base.directory);
    const partial = { ...base.directory, identity: base.directory.identity.bind(base.directory), eligibility: async (companyId: string, project: string) => ({ ...(await eligibility(companyId, project)), complete: false }) };
    expect(await run({ ...base, directory: partial })).toMatchObject({ projects: 0, sent: 0 });
    expect(slack.events).toEqual([]);
    expect(await run(base)).toMatchObject({ sent: 1 });
  });

  it("a warned lesson from a source the person may not read is never named to them", async () => {
    const w = await busyWorld();
    const restricted = { ...draft().provenance, supportTasks: [], authors: ["ann"], audience: { kind: "restricted" as const, acl: { source: "slack" as const, scope: "slack:T/C9", principals: ["U1"], capturedAt: "x", liveCheck: "none" as const } } };
    await put(w, A, lesson(A, "les_secret01", { status: "active", expiresAt: w.world.clock.now + 3 * DAY, title: "Secret fading", provenance: restricted }));
    await chooseSlack(w, A, "a-admin");
    const slack = adapter();
    const base = deps(w, A, slack);
    const access = { taskVisibility: base.access.taskVisibility, mayRead: async (_orgId: string, _viewer: unknown, places: ReadonlyArray<{ restrictedScopes: readonly string[] }>) => places.map((place) => place.restrictedScopes.length === 0) };
    expect(await run({ ...base, access: access })).toMatchObject({ sent: 1 });
    const text = (slack.events[0] as { data: { text: string } }).data.text;
    expect(text).toContain('"Fading soon"');
    expect(text).not.toContain("Secret fading");
  });

  it("two passes at once tell each person once (the week's row is claimed before the send)", async () => {
    const w = await busyWorld();
    await chooseSlack(w, A, "a-admin");
    await chooseSlack(w, A, "a-maint");
    const slack = adapter();
    const [one, two] = await Promise.all([run(deps(w, A, slack)), run(deps(w, A, slack))]);
    expect(one.sent + two.sent).toBe(2);
    expect(slack.events).toHaveLength(2);
  });
});
