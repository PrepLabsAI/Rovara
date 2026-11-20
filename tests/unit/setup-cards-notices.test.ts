// L4-U5: the people-facing words for system runs and setup upkeep, on Code's side: the evidence line of a task, the one message in the task's chat thread and on the ticket when the task pauses at Build, the evidence line
// on the pull request message and the pull request body, the admins' "Setup needs repair" notice, and the "Setup needs repair" card the web page reads. "One experience rule": silent when fine, one message when
// someone must act, one evidence line when trust changes; Slack, Linear and the web say the SAME words; no cost figure in a chat. Mutants are listed in the PR body with the test that kills each.
import { describe, expect, it } from "vitest";
import { intakeItemIdOf, type ChannelEvent, type CodeMilestone, type ConversationRef, type DocumentStore, type OrgId, type StoredDocument } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { FakeChannelAdapter } from "../../packages/broker/src/ports/fake-channel-adapter.js";
import { PENDING_PK, deliverAttention, queueSetupBroken, queueUpkeepPaused, writeNotifyPrefs } from "../../packages/broker/src/core/notify/index.js";
import { attentionEmail } from "../../packages/broker/src/core/notify/email-text.js";
import { sendTicketUpdate } from "../../packages/broker/src/core/ticket-updates/index.js";
import { createLocalIntake } from "../../packages/broker/src/local/app/intake.js";
import { createLocalMilestones } from "../../packages/broker/src/local/app/tracking.js";
import { createSessionStartExtras } from "../../packages/broker/src/local/app/session-start.js";
import { readIntakeItem } from "../../packages/broker/src/core/intake/store.js";
import { createLocalOwnerIdentity, localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { FAKE_TRACKER_KIND, FakeTracker } from "../../packages/broker/src/plugins/fake/tracker.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { SETUP_REPAIR_WORDS, driftTaskKey, plainSetupLink, recheckRowKey, setupAdminNoticeWords, setupBrokenTaskWords, setupEvidenceOf, setupMayBeOutOfDateWords, setupNotRecheckedWords, setupPausedMessage, setupPullRequestLineOf, setupStillWorksWords, setupTrustLineOf, type RecheckRow, type RecheckState } from "../../packages/broker/src/core/setup-agent/recheck-rows.js";
import { repairToldKey } from "../../packages/broker/src/core/setup-agent/broken-notice.js";
import { COMPANY, createHarness, newRequestId } from "../support/task-flow-harness.js";
import { ThreadWorld } from "./support/setup-cards-thread-world.js";

const OTHER = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const KEY_A = "a".repeat(48);
const KEY_B = "b".repeat(48);
const STEP = "setup: npm ci - setup step 0 (npm ci) failed: exit 1";
const ADMIN_1 = "a1".repeat(32);
const ADMIN_2 = "a2".repeat(32);
const NOT_ADMIN = "c3".repeat(32);
const CONVERSATION: ConversationRef = { channel: "examplechat", tenant: "team1", space: "room1", thread: "main" };
const clock = { ms: Date.parse("2026-11-17T10:00:00.000Z") };
const iso = (): string => new Date(clock.ms).toISOString();
/** A cost figure or the words for AI spend: never in a chat. */
const COST = /\$|\bAI\b|dollar|USD|cost/iu;

const recheckRow = (orgId: OrgId, project: string, key: string, state: RecheckState, extra: Partial<RecheckRow> = {}): StoredDocument => JSON.parse(JSON.stringify({
  ...recheckRowKey(orgId, project, key), entityType: "SETUP_RECHECK", orgId, project, key, setupRevision: 1, commits: { demo: "c1" }, classes: ["lockfile"], state, attempt: 1,
  check: { workspaceId: "ws-1", revision: 1, startedAt: iso(), startedBy: "system" }, startedAt: iso(), ...(state === "broken" ? { failedStep: STEP } : {}), ...extra,
})) as StoredDocument;
const link = (orgId: OrgId, project: string, taskId: string, recheckKey: string, extra: Record<string, unknown> = {}): StoredDocument => JSON.parse(JSON.stringify({
  ...driftTaskKey(orgId, project, taskId), entityType: "SETUP_DRIFT_TASK", orgId, project, taskId, recheckKey, state: "pending", at: iso(), ...extra,
})) as StoredDocument;

async function seed(store: DocumentStore, input: { orgId?: OrgId; project?: string; taskId: string; key?: string; state: RecheckState }): Promise<void> {
  const orgId = input.orgId ?? COMPANY, project = input.project ?? "payments", key = input.key ?? KEY_A;
  await store.put({ item: recheckRow(orgId, project, key, input.state) });
  await store.put({ item: link(orgId, project, input.taskId, key) });
}

describe("the evidence line of a task", () => {
  const reader = (store: MemoryDocumentStore, companyId: OrgId = COMPANY) => ({ store, companyId });

  it("each state has one fixed line; only 'could not be checked' lowers trust, and the pull request carries every finished state", async () => {
    const cases: Array<[RecheckState, string, boolean, boolean]> = [
      ["running", "Checking setup again. Your code changed since setup was approved.", false, false],
      ["passed", setupStillWorksWords(["lockfile"]), false, true],
      ["tests_failing", "Setup re-checked after dependency files changed: the setup works; some tests were already failing.", false, true],
      ["unclear", setupNotRecheckedWords(["lockfile"]), true, true],
      ["broken", setupBrokenTaskWords(STEP), false, false],
    ];
    for (const [state, line, trust, onPullRequest] of cases) {
      const store = new MemoryDocumentStore();
      await seed(store, { taskId: "t1", state });
      expect((await setupEvidenceOf(reader(store), "payments", "t1"))?.line, state).toBe(line);
      expect(await setupTrustLineOf(reader(store), "payments", "t1"), state).toBe(trust ? line : undefined);
      expect(await setupPullRequestLineOf(reader(store), "payments", "t1"), state).toBe(onPullRequest ? line : undefined);
    }
  });

  it("never reads another company's or another project's row, and a fault is no line", async () => {
    const store = new MemoryDocumentStore();
    // A row of company B at company A's key (a corrupted or planted row) reads as nothing.
    await store.put({ item: { ...recheckRow(OTHER, "payments", KEY_A, "broken"), ...recheckRowKey(COMPANY, "payments", KEY_A) } });
    await store.put({ item: link(COMPANY, "payments", "t1", KEY_A) });
    expect(await setupEvidenceOf(reader(store), "payments", "t1")).toBeUndefined();
    // Company B's link and rows are not seen from company A, nor project "billing" from "payments".
    await seed(store, { orgId: OTHER, taskId: "t2", state: "passed" });
    expect(await setupEvidenceOf(reader(store, COMPANY), "payments", "t2")).toBeUndefined();
    expect(await setupEvidenceOf(reader(store, COMPANY), "billing", "t1")).toBeUndefined();
    expect(await setupEvidenceOf({ store: { get: async () => { throw new Error("down"); } }, companyId: COMPANY }, "payments", "t1")).toBeUndefined();
  });
});

describe("the words are one set, safe for a chat, with no cost in them", () => {
  it("the requester's message is the task page's own sentence plus where to go; the admins' notice names the one action that fits", () => {
    expect(setupPausedMessage(STEP)).toBe(`I can't build this yet. This project's setup stopped working after recent code changes (${STEP}). I've asked the project's admins to approve a fix. Retry this step once the setup is fixed.\nOpen the project's setup page in Rovara.`);
    expect(setupPausedMessage(STEP, "https://app.example.test/p/payments/setup")).toMatch(/\nSetup page: https:\/\/app\.example\.test\/p\/payments\/setup$/u);
    expect(setupAdminNoticeWords(STEP)).toBe(`Setup needs repair. The project's setup stopped working after recent code changes (${STEP}). Rovara cannot build on this project until it is fixed. Fix setup on the setup page.`);
    expect(setupAdminNoticeWords(STEP, true)).toMatch(/Approve new setup on the setup page\.$/u);
    for (const text of [setupPausedMessage(STEP), setupAdminNoticeWords(STEP), setupAdminNoticeWords(STEP, true), setupStillWorksWords(["lockfile"]), setupNotRecheckedWords(["compose"]), setupMayBeOutOfDateWords(["version"])]) expect(text, text).not.toMatch(COST);
    expect(Object.values(SETUP_REPAIR_WORDS).join(" ")).not.toMatch(COST);
  });

  it("a link goes into a chat only as a plain https address (no sign-in data, no spaces, no markup)", () => {
    expect(plainSetupLink("https://app.example.test/p/payments/setup")).toBe("https://app.example.test/p/payments/setup");
    for (const bad of ["http://app.example.test/x", "https://user:pw@app.example.test/x", "javascript:alert(1)", "https://app.example.test/a b", "https://app.example.test/<x>", "not a link", undefined]) expect(plainSetupLink(bad as never), String(bad)).toBeUndefined();
    expect(setupPausedMessage(STEP, "http://insecure.test/x")).toContain("Open the project's setup page in Rovara.");
  });

});

describe("the chat thread: one message when the task pauses at Build", () => {
  const paused = (extra: Partial<CodeMilestone> = {}, org: OrgId = COMPANY): CodeMilestone => ({ kind: "setup_paused", orgId: org, taskId: ThreadWorld.TASK, at: iso(), text: "x", ...extra });
  const prReady = (): CodeMilestone => ({ kind: "pr_ready", orgId: COMPANY, taskId: ThreadWorld.TASK, at: iso(), text: "ready", pullRequests: [{ repository: "demo", number: 7, url: "https://github.com/example/demo/pull/7" }] });

  it("sends the page's own words once, to the task's own thread, with no buttons, and says it once for the same break however often it is told", async () => {
    const w = await ThreadWorld.make();
    await seed(w.store, { taskId: ThreadWorld.TASK, state: "broken" });
    await w.handler.on(paused());
    await w.handler.on(paused());
    await w.handler.on(paused({ at: new Date(clock.ms + 1000).toISOString() }));
    expect(w.attempts).toHaveLength(1);
    const event = w.attempts[0]!;
    expect(event.type).toBe("progress");
    expect((event as { conversation?: unknown }).conversation).toEqual(CONVERSATION);
    expect((event as ChannelEvent & { data: { text: string } }).data.text).toBe(setupPausedMessage(STEP));
    expect((event as { data: Record<string, unknown> }).data["actions"]).toBeUndefined();
    expect(JSON.stringify(event)).not.toMatch(COST);
  });

  it("carries the setup page's link when the host has one, as the last line, and the words that say where to go when it has none", async () => {
    const w = await ThreadWorld.make({ setupUrl: (project) => `https://app.example.test/p/${project}/setup` });
    await seed(w.store, { taskId: ThreadWorld.TASK, state: "broken" });
    await w.handler.on(paused());
    expect((w.attempts[0] as { data: { text: string } }).data.text).toBe(setupPausedMessage(STEP, "https://app.example.test/p/payments/setup"));
  });

  it("never tells another company's thread, a closed task, or a task of another company's record", async () => {
    const foreign = await ThreadWorld.make({ companyOf: async () => OTHER });
    await seed(foreign.store, { taskId: ThreadWorld.TASK, state: "broken" });
    await foreign.handler.on(paused());
    expect(foreign.attempts).toHaveLength(0);
    const closed = await ThreadWorld.make({ closed: true });
    await seed(closed.store, { taskId: ThreadWorld.TASK, state: "broken" });
    await closed.handler.on(paused());
    expect(closed.attempts).toHaveLength(0);
    const w = await ThreadWorld.make();
    await seed(w.store, { taskId: ThreadWorld.TASK, state: "broken" });
    await w.handler.on(paused({}, OTHER));
    expect(w.attempts).toHaveLength(0);
    // Company B's break, planted under company B's partition, is not read for company A's task.
    const planted = await ThreadWorld.make();
    await seed(planted.store, { orgId: OTHER, taskId: ThreadWorld.TASK, state: "broken" });
    await planted.handler.on(paused());
    expect(planted.attempts).toHaveLength(0);
  });

  it("the pull request message carries the evidence line only when the setup could not be re-checked; a pass keeps the plain pull request card", async () => {
    const unclear = await ThreadWorld.make();
    await seed(unclear.store, { taskId: ThreadWorld.TASK, state: "unclear" });
    await unclear.handler.on(prReady());
    expect(unclear.attempts).toHaveLength(1);
    expect(unclear.attempts[0]!.type).toBe("progress");
    expect((unclear.attempts[0] as { data: { text: string } }).data.text).toContain(`\n${setupNotRecheckedWords(["lockfile"])}`);
    expect((unclear.attempts[0] as { data: { text: string } }).data.text).toContain("https://github.com/example/demo/pull/7");
    const passed = await ThreadWorld.make();
    await seed(passed.store, { taskId: ThreadWorld.TASK, state: "passed" });
    await passed.handler.on(prReady());
    expect(passed.attempts).toHaveLength(1);
    expect(passed.attempts[0]!.type).toBe("pr");
    const plain = await ThreadWorld.make();
    await plain.handler.on(prReady());
    expect(plain.attempts[0]!.type).toBe("pr");
  });
});

// ---- the ticket (Linear on a hosted install, any tracker on a laptop): the same words as the thread

async function intakeWorld() {
  const h = createHarness({ understandFirst: true });
  h.deps.startExtras = createSessionStartExtras(COMPANY);
  await h.registerProject();
  const owner = localOwnerPrincipal({ companyId: COMPANY });
  const registry = createAdapterRegistry();
  registry.register("identity", "local-owner", createLocalOwnerIdentity({ linkedAccounts: [{ provider: FAKE_TRACKER_KIND, tenant: "", accountId: "u-owner" }] }));
  const tracker = new FakeTracker();
  registry.register("tracker", FAKE_TRACKER_KIND, tracker);
  const milestones = createLocalMilestones({ store: h.store, now: () => h.clock.now });
  h.deps.milestones = milestones;
  const intake = createLocalIntake({ registry, flow: h.flow, companyId: COMPANY, owner, milestones, now: () => h.clock.now, fenceKey: Buffer.alloc(32, 7) });
  const call = async (method: string, path: string, body?: unknown) => { const answer = await intake.routes({ method, path, headers: {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, h.owner); return { status: answer?.statusCode ?? 0 }; };
  await call("PUT", "/v1/app/projects/payments/intake/sources", { sources: [{ channel: "tracker", system: FAKE_TRACKER_KIND, when: { label: "rovara" } }] });
  tracker.addItem("T-1", { title: "Refunds fail", body: "x" });
  tracker.asked = [{ ref: { tracker: FAKE_TRACKER_KIND, id: "T-1", url: "https://host.example.test/items/T-1" }, title: "Refunds fail", body: "Refunds over 100 fail.", reporter: "Dana", actor: { kind: "person" as const, account: { provider: FAKE_TRACKER_KIND, tenant: "", accountId: "u-owner" } } }];
  await intake.poll();
  const item = (await readIntakeItem({ store: h.store, now: () => h.clock.now }, COMPANY, "payments", intakeItemIdOf(FAKE_TRACKER_KIND, "T-1")))!;
  const deps = (over: Record<string, unknown> = {}) => ({ store: h.store, now: () => h.clock.now, trackerFor: () => tracker, scope: { orgId: COMPANY }, ...over });
  const milestone = (kind: CodeMilestone["kind"]): CodeMilestone => ({ kind, orgId: COMPANY, taskId: item.taskId!, sessionId: item.sessionId, at: iso(), text: "x", ...(kind === "pr_ready" ? { pullRequests: [{ repository: "demo", number: 7, url: "https://github.com/example/demo/pull/7" }] } : {}) });
  const setupComments = () => tracker.writes.filter((write) => write.kind === "comment" && /setup/iu.test(write.value));
  return { h, tracker, item, deps, milestone, setupComments, call };
}

describe("the ticket the task came from: the same message, once", () => {
  it("comments the page's own words once, never moves the ticket's status even when the project moves statuses, and a repeat says already sent", async () => {
    const w = await intakeWorld();
    await seed(w.h.store, { project: "payments", taskId: w.item.taskId!, state: "broken" });
    await w.call("PUT", "/v1/app/projects/payments/intake/updates", { requestId: newRequestId(), settings: { comments: true, changeStatus: true, statuses: { started: "In Progress", pr_opened: "In Review", merged: "Done" } } });
    const before = w.tracker.writes.length;
    expect(await sendTicketUpdate(w.deps(), w.milestone("setup_paused"))).toBe("posted");
    expect(await sendTicketUpdate(w.deps(), w.milestone("setup_paused"))).toBe("already_sent");
    const added = w.tracker.writes.slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ kind: "comment", item: "T-1", value: setupPausedMessage(STEP), requirePrivate: true });
    expect(added.some((write) => write.kind === "status")).toBe(false);
    expect(added[0]!.value).not.toMatch(COST);
  });

  it("is the same sentence the chat thread says (one experience on every surface)", async () => {
    const w = await intakeWorld();
    await seed(w.h.store, { project: "payments", taskId: w.item.taskId!, state: "broken" });
    await sendTicketUpdate(w.deps({ setupUrl: () => "https://app.example.test/p/payments/setup" }), w.milestone("setup_paused"));
    const thread = await ThreadWorld.make();
    await seed(thread.store, { taskId: ThreadWorld.TASK, state: "broken" });
    await thread.handler.on({ kind: "setup_paused", orgId: COMPANY, taskId: ThreadWorld.TASK, at: iso(), text: "x" });
    const ticketText = w.setupComments().at(-1)!.value;
    const threadText = (thread.attempts[0] as { data: { text: string } }).data.text;
    expect(ticketText).toBe(setupPausedMessage(STEP, "https://app.example.test/p/payments/setup"));
    expect(threadText).toBe(setupPausedMessage(STEP));
    expect(ticketText.split("\n")[0]).toBe(threadText.split("\n")[0]);
  });

  it("says nothing when the break does not hold, when comments are off, or when the task did not come from a ticket", async () => {
    const quiet = await intakeWorld();
    await seed(quiet.h.store, { project: "payments", taskId: quiet.item.taskId!, state: "passed" });
    const before = quiet.tracker.writes.length;
    expect(await sendTicketUpdate(quiet.deps(), quiet.milestone("setup_paused"))).toBe("not_broken");
    expect(quiet.tracker.writes).toHaveLength(before);
    const off = await intakeWorld();
    await seed(off.h.store, { project: "payments", taskId: off.item.taskId!, state: "broken" });
    await off.call("PUT", "/v1/app/projects/payments/intake/updates", { requestId: newRequestId(), settings: { comments: false, changeStatus: false, statuses: {} } });
    const offBefore = off.tracker.writes.length;
    expect(await sendTicketUpdate(off.deps(), off.milestone("setup_paused"))).toBe("off");
    expect(off.tracker.writes).toHaveLength(offBefore);
    const noTicket = await intakeWorld();
    const started = await noTicket.h.flow.start(noTicket.h.owner, { requestId: newRequestId(), project: "payments", instructions: "Add a retry", workflow: true });
    await seed(noTicket.h.store, { project: "payments", taskId: started.task.taskId, state: "broken" });
    const nBefore = noTicket.tracker.writes.length;
    expect(await sendTicketUpdate(noTicket.deps(), { kind: "setup_paused", orgId: COMPANY, taskId: started.task.taskId, at: iso(), text: "x" })).toBe("no_ticket");
    expect(noTicket.tracker.writes).toHaveLength(nBefore);
    expect((await noTicket.h.store.get(taskKey(started.task.taskId)))?.["ticket"]).toBeUndefined();
  });

  it("the pull request comment carries the evidence line only when the setup could not be re-checked", async () => {
    const unclear = await intakeWorld();
    await seed(unclear.h.store, { project: "payments", taskId: unclear.item.taskId!, state: "unclear" });
    await sendTicketUpdate(unclear.deps(), unclear.milestone("pr_ready"));
    const text = unclear.tracker.writes.filter((write) => write.kind === "comment").at(-1)!.value;
    expect(text).toContain("pull request");
    expect(text.split("\n").at(-1)).toBe(setupNotRecheckedWords(["lockfile"]));
    const passed = await intakeWorld();
    await seed(passed.h.store, { project: "payments", taskId: passed.item.taskId!, state: "passed" });
    await sendTicketUpdate(passed.deps(), passed.milestone("pr_ready"));
    expect(passed.tracker.writes.filter((write) => write.kind === "comment").at(-1)!.value).not.toMatch(/Setup (re-checked|may be)|Couldn't re-check/u);
  });
});

// ---- the admins' notice

const quiet = (): void => undefined;
function adminWorld(recipients: (orgId: OrgId, project: string) => Promise<readonly string[]> = async () => [ADMIN_1, ADMIN_2]) {
  const store = new MemoryDocumentStore();
  const registry = createAdapterRegistry();
  const adapter = new FakeChannelAdapter();
  const sends: ChannelEvent[] = [];
  const realDeliver = adapter.deliver.bind(adapter);
  adapter.deliver = async (event) => { sends.push(event); await realDeliver(event); };
  registry.register("channel", "examplechat", adapter);
  const logs: Array<Record<string, unknown>> = [];
  const queue = (orgId: OrgId, project: string, recheckKey: string) => queueSetupBroken({ store, now: () => new Date(clock.ms), log: (entry) => logs.push(entry), recipients }, { orgId, project, recheckKey });
  const prefs = async (orgId: OrgId, person: string) => { await writeNotifyPrefs({ store, now: () => new Date(clock.ms) }, orgId, person, { targets: [{ channel: CONVERSATION.channel, conversation: CONVERSATION }], muted: false }); };
  type Upkeep = NonNullable<Parameters<typeof deliverAttention>[0]["upkeep"]>;
  const deliver = (upkeep: Upkeep | undefined) => deliverAttention({ store, registry, now: () => clock.ms, log: quiet, ...(upkeep === undefined ? {} : { upkeep }) });
  const pending = async () => (await store.query({ pk: PENDING_PK })).items;
  return { store, adapter, sends, queue, prefs, deliver, pending, logs };
}
const OPEN = (over: Partial<{ key: string; failedStep: string; fixReady: boolean }> = {}) => async () => ({ key: KEY_A, failedStep: STEP, fixReady: false, ...over });
const ADMINS = (over: Record<string, unknown> = {}) => ({ administers: async (_org: OrgId, person: string) => person !== NOT_ADMIN, setupRead: OPEN(), ...over });

describe("the admins' notice: one message for the project, not one per task", () => {

  it("keeps only person ids, gives the marker back when nobody could be told or the read failed, and never throws on a bad identity", async () => {
    const none = adminWorld(async () => ["not-a-person", "", "ADMIN"]);
    expect(await none.queue(COMPANY, "payments", KEY_A)).toEqual({ queued: 0, deduped: false });
    expect(await none.store.get(repairToldKey(COMPANY, "payments", KEY_A))).toBeUndefined();
    let attempts = 0;
    const flaky = adminWorld(async () => { attempts += 1; if (attempts === 1) throw new Error("directory down"); return [ADMIN_1]; });
    expect(await flaky.queue(COMPANY, "payments", KEY_A)).toEqual({ queued: 0, deduped: false });
    expect(flaky.logs.map((entry) => entry["event"])).toContain("setup_broken.notice_recipients_failed");
    expect(await flaky.queue(COMPANY, "payments", KEY_A)).toEqual({ queued: 1, deduped: false });
    const bad = adminWorld();
    expect(await bad.queue(COMPANY, "Bad#Name", KEY_A)).toEqual({ queued: 0, deduped: false });
    expect(await bad.queue(COMPANY, "payments", "not-hex")).toEqual({ queued: 0, deduped: false });
    expect(await bad.pending()).toHaveLength(0);
    const many = adminWorld(async () => Array.from({ length: 80 }, (_, index) => index.toString(16).padStart(64, "0")));
    expect((await many.queue(COMPANY, "payments", KEY_A)).queued).toBe(50);
  });

  it("a failed write of the rows leaves no marker and no partial notice: a later read writes it", async () => {
    const w = adminWorld();
    let fail = true;
    const transact = w.store.transact.bind(w.store);
    w.store.transact = async (items) => { if (fail) { fail = false; throw new Error("store down"); } return transact(items); };
    expect(await w.queue(COMPANY, "payments", KEY_A)).toEqual({ queued: 0, deduped: false });
    expect(await w.pending()).toHaveLength(0);
    expect(await w.queue(COMPANY, "payments", KEY_A)).toEqual({ queued: 2, deduped: false });
  });

  it("is delivered to the Slack target an admin chose in the same words as the web card, with the one action that fits and no cost", async () => {
    const w = adminWorld();
    await w.prefs(COMPANY, ADMIN_1);
    await w.queue(COMPANY, "payments", KEY_A);
    expect((await w.deliver(ADMINS({ setupLink: (project: string) => `https://app.example.test/p/${project}/setup` }))).sent).toBe(1);
    const text = (w.sends[0] as { data: { text: string } }).data.text;
    expect(text).toContain("A project's setup needs your attention in Rovara:");
    expect(text).toContain(`payments: ${setupAdminNoticeWords(STEP)} https://app.example.test/p/payments/setup`);
    expect(text).not.toMatch(COST);
    expect(text).not.toContain("task");
    // Delivered once: the row is gone (the other admin chose no chat and has no email: nowhere to tell, so theirs goes too) and the same break is not queued again.
    expect(await w.pending()).toHaveLength(0);
    expect((await w.queue(COMPANY, "payments", KEY_A)).deduped).toBe(true);
  });

  it("goes only to a person who still administers the project, and is dropped silently for anyone else", async () => {
    const w = adminWorld(async () => [ADMIN_1, NOT_ADMIN]);
    await w.prefs(COMPANY, ADMIN_1);
    await w.prefs(COMPANY, NOT_ADMIN);
    await w.queue(COMPANY, "payments", KEY_A);
    const outcome = await w.deliver(ADMINS());
    expect(outcome.sent).toBe(1);
    expect(outcome.dropped).toBe(1);
    expect(w.sends).toHaveLength(1);
    expect((await w.pending()).filter((row) => row["developerId"] === NOT_ADMIN)).toHaveLength(0);
    // An `administers` that throws is "no".
    const broken = adminWorld();
    await broken.prefs(COMPANY, ADMIN_1);
    await broken.queue(COMPANY, "payments", KEY_A);
    expect((await broken.deliver(ADMINS({ administers: async () => { throw new Error("down"); } }))).sent).toBe(0);
    expect(broken.sends).toHaveLength(0);
  });

  it("is dropped without a word when the setup is no longer broken (fixed, or a newer break), and waits when the host cannot read it", async () => {
    const fixed = adminWorld();
    await fixed.prefs(COMPANY, ADMIN_1);
    await fixed.queue(COMPANY, "payments", KEY_A);
    expect((await fixed.deliver(ADMINS({ setupRead: async () => undefined }))).sent).toBe(0);
    expect(fixed.sends).toHaveLength(0);
    const newer = adminWorld();
    await newer.prefs(COMPANY, ADMIN_1);
    await newer.queue(COMPANY, "payments", KEY_A);
    expect((await newer.deliver(ADMINS({ setupRead: OPEN({ key: KEY_B }) }))).sent).toBe(0);
    const thrown = adminWorld();
    await thrown.prefs(COMPANY, ADMIN_1);
    await thrown.queue(COMPANY, "payments", KEY_A);
    expect((await thrown.deliver(ADMINS({ setupRead: async () => { throw new Error("down"); } }))).sent).toBe(0);
    // No setup wiring on this host: the row waits instead of being dropped, and a later host with the wiring delivers it.
    const waiting = adminWorld();
    await waiting.prefs(COMPANY, ADMIN_1);
    await waiting.queue(COMPANY, "payments", KEY_A);
    expect((await waiting.deliver({ administers: async () => true })).sent).toBe(0);
    expect(await waiting.pending()).toHaveLength(2);
    expect((await waiting.deliver(ADMINS())).sent).toBe(1);
  });

  it("the email carries the same words: its own subject and no cost", () => {
    const line = { title: "payments", status: setupAdminNoticeWords(STEP), kind: "setup_broken" };
    const mail = attentionEmail([line], 0, "attention");
    expect(mail.subject).toBe("Rovara: a project's setup needs your attention");
    expect(mail.text).toContain(`- payments: ${setupAdminNoticeWords(STEP)}`);
    expect(mail.text).toContain("A project's setup needs your attention in Rovara:");
    expect(`${mail.subject}\n${mail.text}`).not.toMatch(COST);
    expect(attentionEmail([line, { title: "beacon", status: "x", kind: "upkeep_paused" }], 0, "attention").subject).toBe("Rovara: 2 items need your attention");
  });
});


// ---- the pull request description

import { greenScenario } from "../support/pr-body-scenarios.js";

describe("the pull request description carries the setup's one line (L4-U5)", () => {
  const drawer = (body: string): string => body.slice(body.indexOf("<summary>Test setup"), body.indexOf("</details>", body.indexOf("<summary>Test setup")));

  it("says the note when the check could not be made, in the same words as the task page and the chat", () => {
    const line = setupNotRecheckedWords(["compose"]);
    expect(drawer(greenScenario("clean", { setupLine: line }).body)).toContain(`- ${line}`);
    expect(drawer(greenScenario("clean", { setupLine: setupMayBeOutOfDateWords(["version"]) }).body)).toContain(`- ${setupMayBeOutOfDateWords(["version"])}`);
  });

});

// ---- the task page's read

import { DeveloperTaskViewSchema } from "@agentx/contracts";
import { developerTaskView } from "../../packages/broker/src/local/app/task-view.js";

describe("the task view carries the evidence line to the web (L4-U5)", () => {
  const task = { taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", title: "Add a retry", project: "payments", startingRevision: 1, client: "cloud", createdAt: iso(), updatedAt: iso() } as never;
  const view = (setupRecheck?: string) => ({ status: "RUNNING", closing: false, ...(setupRecheck === undefined ? {} : { setupRecheck }) }) as never;

  it("passes the line through word for word, leaves the field out when there is none, and the contract reads it", async () => {
    const line = setupStillWorksWords(["lockfile"]);
    const withLine = await developerTaskView(task, view(line), {} as never);
    expect(withLine["setupRecheck"]).toBe(line);
    expect(DeveloperTaskViewSchema.safeParse(withLine).success).toBe(true);
    const without = await developerTaskView(task, view(), {} as never);
    expect("setupRecheck" in without).toBe(false);
    expect(DeveloperTaskViewSchema.safeParse(without).success).toBe(true);
    expect(DeveloperTaskViewSchema.safeParse({ ...withLine, setupRecheck: "x".repeat(601) }).success).toBe(false);
    expect(DeveloperTaskViewSchema.safeParse({ ...withLine, setupRecheck: "" }).success).toBe(false);
  });
});

// ---- the upkeep switch's read tells the admins' page that nightly upkeep is paused

import { UpkeepViewSchema } from "@agentx/contracts";
import { upkeepView } from "../../packages/broker/src/core/upkeep/settings.js";
import { upkeepNightKey } from "../../packages/broker/src/core/upkeep/keys.js";

describe("nightly upkeep's read says why it is paused, to the people who manage it (L4-U5)", () => {
  async function pausedWorld(access: "manage" | "view" = "manage") {
    const store = new MemoryDocumentStore();
    const deps = { store, companyId: COMPANY, now: () => clock.ms, standing: async () => ({ access, companyAdmin: access === "manage" }), available: () => true, noConsentNeeded: true as const };
    const night = async (day: string, outcome: string, org: OrgId = COMPANY, project = "payments") => store.put({ item: { ...upkeepNightKey({ orgId: org, project }, day), entityType: "UPKEEP_NIGHT", orgId: org, project, day, outcome, wiki: "skipped", at: iso() } });
    const notice = (reason: "no_budget" | "monthly_limit" | "cost_too_high", month?: string) => queueUpkeepPaused({ store, now: () => new Date(clock.ms), recipients: async () => [ADMIN_1] }, { orgId: COMPANY, project: "payments", reason, ...(month === undefined ? {} : { month }) });
    return { store, deps, night, notice };
  }

  it("is absent for a person who may only read, once a later night ran, with no notice this month, and for another project or company's rows", async () => {
    const reader = await pausedWorld("view");
    await reader.night("2026-11-17", "paused"); await reader.notice("no_budget");
    expect((await upkeepView(reader.deps as never, ADMIN_1, "payments")).paused).toBeUndefined();
    const resumed = await pausedWorld();
    await resumed.night("2026-11-16", "paused"); await resumed.notice("no_budget"); await resumed.night("2026-11-17", "ran");
    expect((await upkeepView(resumed.deps as never, ADMIN_1, "payments")).paused).toBeUndefined();
    const noNotice = await pausedWorld();
    await noNotice.night("2026-11-17", "paused");
    expect((await upkeepView(noNotice.deps as never, ADMIN_1, "payments")).paused).toBeUndefined();
    const lastMonth = await pausedWorld();
    await lastMonth.night("2026-11-17", "paused"); await lastMonth.notice("no_budget", "2026-10");
    expect((await upkeepView(lastMonth.deps as never, ADMIN_1, "payments")).paused).toBeUndefined();
    const theirs = await pausedWorld();
    await theirs.night("2026-11-17", "paused", OTHER); await theirs.night("2026-11-17", "paused", COMPANY, "billing"); await theirs.notice("no_budget");
    expect((await upkeepView(theirs.deps as never, ADMIN_1, "payments")).paused).toBeUndefined();
    expect(UpkeepViewSchema.safeParse(await upkeepView(theirs.deps as never, ADMIN_1, "payments")).success).toBe(true);
  });

  it("takes the newest of this month's notices when more than one reason was told, and a store that fails reads as not paused", async () => {
    const w = await pausedWorld();
    await w.night("2026-11-17", "paused");
    await w.notice("no_budget");
    clock.ms += 60_000;
    await w.notice("cost_too_high");
    expect((await upkeepView(w.deps as never, ADMIN_1, "payments")).paused?.reason).toBe("cost_too_high");
    const broken = { ...w.deps, store: { ...w.store, query: async () => { throw new Error("down"); }, get: w.store.get.bind(w.store) } };
    expect((await upkeepView(broken as never, ADMIN_1, "payments")).paused).toBeUndefined();
    clock.ms -= 60_000;
  });
});


// ---- the once-only marker holds against a race, the requester hears once, and the wiring that carries all this is in place

import { readFileSync } from "node:fs";
import { setupPausedPosted } from "../../packages/broker/src/core/channel/thread-notices.js";
import { taskSessionId } from "../../packages/broker/src/core/sessions/create.js";

describe("the admins' notice holds when two readers of one break meet", () => {
  it("a reader that read the marker as absent just before the other wrote it still writes nothing (the marker's own write is conditional)", async () => {
    const w = adminWorld();
    expect(await w.queue(COMPANY, "payments", KEY_A)).toEqual({ queued: 2, deduped: false });
    const key = repairToldKey(COMPANY, "payments", KEY_A);
    const realGet = w.store.get.bind(w.store);
    w.store.get = async (request) => (request.pk === key.pk && request.sk === key.sk ? undefined : realGet(request));
    expect(await w.queue(COMPANY, "payments", KEY_A)).toEqual({ queued: 0, deduped: true });
    expect(await w.pending()).toHaveLength(2);
  });
});

describe("the requester hears the pause once: the needs-you reminder knows the thread was told", () => {
  const session = { orgId: COMPANY, sessionId: taskSessionId(ThreadWorld.TASK), subject: { kind: "task", taskId: ThreadWorld.TASK } } as never;
  const blocked = async (w: ThreadWorld) => { await w.store.update({ key: taskKey(ThreadWorld.TASK), ops: [{ op: "set", path: ["workflow"], value: { state: "BLOCKED", stage: "IMPLEMENT", revision: 3 } }] }); };

  it("is true only after the pause message was sent for the break that holds the task now", async () => {
    const w = await ThreadWorld.make();
    const told = setupPausedPosted({ store: w.store });
    await seed(w.store, { taskId: ThreadWorld.TASK, state: "broken", key: KEY_A });
    await blocked(w);
    expect(await told(session)).toBe(false);
    await w.handler.on({ kind: "setup_paused", orgId: COMPANY, taskId: ThreadWorld.TASK, at: iso(), text: "x" });
    expect(await told(session)).toBe(true);
    // A newer break has not been told yet.
    await seed(w.store, { taskId: ThreadWorld.TASK, state: "broken", key: KEY_B });
    expect(await told(session)).toBe(false);
  });

  it("is false for a task that is not blocked, another company's session and a store that fails", async () => {
    const w = await ThreadWorld.make();
    const told = setupPausedPosted({ store: w.store });
    await seed(w.store, { taskId: ThreadWorld.TASK, state: "broken" });
    await w.handler.on({ kind: "setup_paused", orgId: COMPANY, taskId: ThreadWorld.TASK, at: iso(), text: "x" });
    expect(await told(session)).toBe(false);
    await blocked(w);
    expect(await told({ ...(session as object), orgId: OTHER } as never)).toBe(false);
    await expect(setupPausedPosted({ store: { get: async () => { throw new Error("down"); } } })(session)).rejects.toThrow();
  });
});

describe("the wiring that carries the lines is in place (a guard on the source: removing a line must fail a test)", () => {
  const source = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  it("both pull request descriptions (the first and the rewrite) are given the setup line", () => {
    for (const path of ["packages/broker/src/core/build-step/publish.ts", "packages/broker/src/core/build-step/changed-files.ts"]) {
      const text = source(path);
      expect(text, path).toContain("setupPullRequestLineOf(deps, task.project, task.taskId)");
      expect(text, path).toMatch(/\.\.\.\(setupLine === undefined \? \{\} : \{ setupLine \}\)/u);
    }
  });
  it("the hosted engine tells the admins of a break and reads the card for ITS company only, and the local app knows when the thread was told", () => {
    const root = source("packages/broker/src/aws/core-engine-root.ts");
    expect(root).toContain("flow.deps.setupBroken = async (input) => { await upkeep.setupBroken(input); };");
    expect(root).toContain("setupRead: (orgId, project) => (orgId === companyId ? readSetupBrokenNotice(");
    expect(source("packages/broker/src/local/app/app.ts")).toContain("setupPausedTold: setupPausedPosted({ store }),");
  });
  it("pausing at Build stores fixed words, never the failing step, in the milestone and the session's timeline", () => {
    const start = source("packages/broker/src/core/build-step/start.ts");
    expect(start).toContain("text: SETUP_PAUSED_TIMELINE,");
    expect(start).not.toMatch(/kind: "setup_paused"[^]{0,200}text: setupGate/u);
  });
});
