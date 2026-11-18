// The one read of a task's own chat thread for the lessons' Slack source (lane L4-SRC-SL), and the capture it feeds, end to end over in-memory stores and a fake chat adapter: the thread is the one the task started in,
// its space must be bound to the task's own project and its tenant to the asking company, the adapter is asked ONCE through the `thread_messages` command (only an adapter that declares `history`), writers are
// people only through a chat link they made themselves, and two companies never read each other's threads, people or switches.
import { OrgIdSchema, type ChannelCommand, type JsonValue, type OrgId } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { bindChannelSpace, issueChannelLinkCode, recordTaskThread, redeemChannelLinkCode } from "../../packages/broker/src/core/channel/index.js";
import { recordEndedTask } from "../../packages/broker/src/team-record/capture.js";
import { createSlackThreadReader } from "../../packages/broker/src/core/channel/thread-replies.js";
import { taskSessionId } from "../../packages/broker/src/core/sessions/create.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { erasePersonLessons } from "../../packages/broker/src/core-host/lessons.js";
import type { HostedLessonPeople } from "../../packages/broker/src/lessons/hosted-people.js";
import { slackThreadSource } from "../../packages/broker/src/lessons/slack-wiring.js";
import { readSlackOptOut, writeSlackOptOut } from "../../packages/broker/src/lessons/slack-switch.js";
import { SLACK_PAUSE_KEY } from "../../packages/broker/src/lessons/slack-source.js";
import { InMemoryLessonStore } from "../../packages/broker/src/lessons/store.js";
import { createLocalLessonSources } from "../../packages/broker/src/local/app/lessons-sources.js";
import type { LessonRepositories } from "../../packages/broker/src/local/app/lessons-repos.js";
import { FAKE_CHANNEL_CAPABILITIES, FakeChannelAdapter } from "../../packages/broker/src/ports/fake-channel-adapter.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";

const A = OrgIdSchema.parse("org_aaaaaaaaaaaaaaaaaaaa");
const B = OrgIdSchema.parse("org_bbbbbbbbbbbbbbbbbbbb");
const TEAM_A = "T0123456789";
const TEAM_B = "T0999999999";
const teamOf = (org: string): string => (org === A ? TEAM_A : TEAM_B);
const SPACE = "C0123456789";
const THREAD = "1700000000.000100";
const U_ANN = "U0000000001";
const U_BOT = "U0000000002";
const U_GUEST = "U0000000003";
const SAY = "Use the shared retry helper instead of writing a new retry loop by hand.";
const now = (): number => Date.parse("2026-11-18T08:00:00.000Z");
const companyOf = ({ tenant }: { channel: string; tenant: string }): OrgId | undefined => (tenant === TEAM_A ? A : tenant === TEAM_B ? B : undefined);

interface Message { id: string; userId?: string; bot?: boolean; external?: boolean; plain?: boolean; text?: string }
interface WorldOptions { history?: boolean; space?: { private?: boolean; shared?: boolean; direct?: boolean }; messages?: Message[]; boundTo?: string; roster?: Record<string, string[]>; erased?: string[] }

function people(roster: Record<string, string[]>, erased: string[] = []): HostedLessonPeople {
  return {
    async approvers() { return { complete: true, membershipVersion: 1, ownerIds: [], eligibleIds: [], lastEligibleLossAtMs: null }; },
    async onProjectRoster(c, project, person) { return (roster[`${c}/${project}`] ?? []).includes(person); },
    async linkedAccounts() { return []; },
    async displayName() { return undefined; },
    async isErased(_c, person) { return erased.includes(person); },
  };
}

async function world(options: WorldOptions = {}) {
  const store = new MemoryDocumentStore();
  const lessonStore = new InMemoryLessonStore();
  const adapter = new FakeChannelAdapter({ ...FAKE_CHANNEL_CAPABILITIES, ...(options.history === false ? {} : { history: true }) });
  const asked: ChannelCommand[] = [];
  Object.assign(adapter, {
    async command(command: ChannelCommand) {
      asked.push(command);
      if (command.kind !== "thread_messages") return { ok: false, error: { code: "unsupported", message: "no" } };
      return { ok: true, result: { space: { private: false, shared: false, direct: false, ...options.space }, truncated: false, messages: (options.messages ?? [{ id: "1700000001.000100", userId: U_ANN, text: SAY }]).map((m) => ({ bot: false, external: false, plain: true, text: SAY, ...m })) } };
    },
  });
  const registry = { get: (_point: string, name: string) => (name === "slack" ? adapter : undefined) } as never;
  const taskId = "task-sl";
  const roster = options.roster ?? { [`${A}/payments`]: ["ann", "bob"], [`${B}/payments`]: ["ann", "bob"] };
  const deps = (org: OrgId) => ({ store, orgId: org, now });
  for (const org of [A, B]) {
    await store.put({ item: { ...taskKey(`${taskId}-${org}`), entityType: "DEVTASK", taskId: `${taskId}-${org}`, companyId: org, project: "payments", developerId: "ann", startingRevision: 1, title: "t", requestText: "Add a retry to the sync",
      workflow: { revision: 3, artifacts: [], reviews: [], pullRequests: [], outcome: "MERGED", decisions: [] as JsonValue[] } } });
    await recordTaskThread({ store, orgId: org, now }, { sessionId: taskSessionId(`${taskId}-${org}`), conversation: { channel: "slack", tenant: teamOf(org), space: SPACE, thread: THREAD }, personId: "ann" });
    await bindChannelSpace(deps(org), { channel: "slack", tenant: teamOf(org), space: SPACE }, options.boundTo ?? "payments");
    // The same Slack account id is linked to a different person in each company: only the company keeps them apart.
    for (const [user, person] of [[U_ANN, "ann"], [U_GUEST, "gus"]] as const) {
      const { code } = await issueChannelLinkCode(deps(org), { channel: "slack", tenant: teamOf(org), userId: user });
      await redeemChannelLinkCode(deps(org), person, code);
    }
  }
  const wiring = (org: OrgId) => slackThreadSource({ store, companyId: org, registry, companyOf, now, lessonStore: () => lessonStore });
  const sourcesOf = (org: OrgId) => createLocalLessonSources({
    flow: { store, projects: undefined as never }, companyId: org, ownerId: "local-owner", repos: { ofProject: async () => [], ofTask: async () => undefined } as unknown as LessonRepositories, now,
    hosted: { people: people(roster, options.erased ?? []) }, slack: wiring(org),
  });
  const spansOf = async (org: OrgId) => ((await sourcesOf(org).source.read({ workspaceId: org, taskId: `${taskId}-${org}` }))?.facts.rest.spans ?? []).filter((s) => s.kind === "slack_reply");
  return { store, lessonStore, adapter, asked, registry, wiring, sourcesOf, spansOf, taskIdOf: (org: OrgId) => `${taskId}-${org}`, deps };
}

describe("the thread reader", () => {
  it("reads the task's own thread once through the adapter, maps a writer to the person who linked that account, and says the place is bound", async () => {
    const w = await world({ messages: [{ id: "1700000001.000100", userId: U_ANN }, { id: "1700000001.000200", userId: U_BOT, bot: true }, { id: "1700000001.000300", userId: "U0000000009" }] });
    const read = await w.wiring(A).reader.read({ companyId: A, project: "payments", taskId: w.taskIdOf(A) });
    expect(read).toMatchObject({ place: `slack:${TEAM_A}/${SPACE}`, boundToProject: true, private: false, shared: false, direct: false });
    expect(read!.messages.map((m) => [m.id, m.person])).toEqual([["1700000001.000100", "ann"], ["1700000001.000200", undefined], ["1700000001.000300", undefined]]);
    expect(w.asked).toHaveLength(1);
    expect(w.asked[0]).toMatchObject({ kind: "thread_messages", tenant: TEAM_A, space: SPACE, thread: THREAD });
  });
  it("never looks up a person for a bot, a person of another organisation or a notice", async () => {
    const w = await world({ messages: [{ id: "1700000001.000100", userId: U_ANN, bot: true }, { id: "1700000001.000200", userId: U_ANN, external: true }, { id: "1700000001.000300", userId: U_ANN, plain: false }] });
    const read = await w.wiring(A).reader.read({ companyId: A, project: "payments", taskId: w.taskIdOf(A) });
    expect(read!.messages.every((m) => m.person === undefined)).toBe(true);
  });
  it("asks nothing when the space is bound to another project", async () => {
    const other = await world({ boundTo: "billing" });
    expect(await other.wiring(A).reader.read({ companyId: A, project: "payments", taskId: other.taskIdOf(A) })).toBeUndefined();
    expect(other.asked).toEqual([]);
  });
  it("asks nothing for a task that did not start in a chat thread, or for another company's company id", async () => {
    const w = await world();
    expect(await w.wiring(A).reader.read({ companyId: A, project: "payments", taskId: "task-without-thread" })).toBeUndefined();
    expect(await w.wiring(A).reader.read({ companyId: B, project: "payments", taskId: w.taskIdOf(A) })).toBeUndefined();
    expect(w.asked).toEqual([]);
  });
  it("an adapter that does not declare `history` is never sent the command (and the task goes on with no Slack span)", async () => {
    const w = await world({ history: false });
    await expect(w.wiring(A).reader.read({ companyId: A, project: "payments", taskId: w.taskIdOf(A) })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(w.asked).toEqual([]);
    expect(await w.spansOf(A)).toEqual([]);
  });
  it("a host's member rule can refuse a linked person: they have no person here", async () => {
    const w = await world();
    const reader = createSlackThreadReader({ store: w.store, orgId: A, registry: w.registry, companyOf, isMember: async () => false, now });
    const read = await reader.read({ companyId: A, project: "payments", taskId: w.taskIdOf(A) });
    expect(read!.messages[0]!.person).toBeUndefined();
  });
});

describe("the capture at task end, hosted: the reply becomes a span only when every rule holds", () => {
  it("a linked project member's correction in the bound, public channel is a slack_reply span of that person, with a pointer and the project's audience", async () => {
    const w = await world();
    const spans = await w.spansOf(A);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ kind: "slack_reply", text: SAY, trust: "member", authorId: "ann", eventId: `slack:${TEAM_A}/${SPACE}#1700000001.000100`, audience: { kind: "project" } });
  });
  it("a direct message, a shared space and a thread of a private channel that is not bound: nothing; a private bound channel keeps its audience", async () => {
    expect(await (await world({ space: { direct: true } })).spansOf(A)).toEqual([]);
    expect(await (await world({ space: { shared: true } })).spansOf(A)).toEqual([]);
    expect(await (await world({ boundTo: "billing" })).spansOf(A)).toEqual([]);
    const privateOne = await world({ space: { private: true } });
    expect((await privateOne.spansOf(A))[0]!.audience).toMatchObject({ kind: "restricted", acl: { source: "slack", scope: `slack:${TEAM_A}/${SPACE}` } });
  });
  it("a person with no role on the project, an erased person and a person who opted out are not read", async () => {
    expect(await (await world({ roster: { [`${A}/payments`]: ["bob"] } })).spansOf(A)).toEqual([]);
    expect(await (await world({ erased: ["ann"] })).spansOf(A)).toEqual([]);
    const w = await world();
    await writeSlackOptOut(w.store, A, "ann", true, now());
    expect(await w.spansOf(A)).toEqual([]);
    await writeSlackOptOut(w.store, A, "ann", false, now());
    expect(await w.spansOf(A)).toHaveLength(1);
  });
  it("a guest account linked to a person with no role on the project is dropped, while the member beside them is read", async () => {
    const w = await world({ messages: [{ id: "1700000001.000100", userId: U_GUEST }, { id: "1700000001.000200", userId: U_ANN, text: "Never call the billing API from tests, use the recorded fake instead." }] });
    expect((await w.spansOf(A)).map((s) => s.authorId)).toEqual(["ann"]);
  });
  it("the project's pause stops the read: the adapter is not asked at all; resuming reads again, and a pause on another project does nothing", async () => {
    const w = await world();
    await w.lessonStore.setFlags({ workspaceId: A, project: "payments" }, { pausedSources: { [SLACK_PAUSE_KEY]: { at: 1, reason: "person" } } });
    expect(await w.spansOf(A)).toEqual([]);
    expect(w.asked).toEqual([]);
    await w.lessonStore.setFlags({ workspaceId: A, project: "payments" }, { pausedSources: {} });
    await w.lessonStore.setFlags({ workspaceId: A, project: "billing" }, { pausedSources: { [SLACK_PAUSE_KEY]: { at: 1, reason: "person" } } });
    expect(await w.spansOf(A)).toHaveLength(1);
  });
  it("a flood-guard pause on a Slack channel of the project stops the next read too", async () => {
    const w = await world();
    await w.lessonStore.setFlags({ workspaceId: A, project: "payments" }, { pausedSources: { [`slack:${SPACE}`]: { at: 1, reason: "spike" } } });
    expect(await w.spansOf(A)).toEqual([]);
    expect(w.asked).toEqual([]);
  });
  it("a send-back's reflection, a revert's re-reflection and the repo-only pass never read the thread (it is read once, at the task's end)", async () => {
    const w = await world();
    const sources = w.sourcesOf(A);
    await sources.source.read({ workspaceId: A, taskId: w.taskIdOf(A), withoutSlack: true });
    expect(w.asked).toEqual([]);
    await sources.source.read({ workspaceId: A, taskId: w.taskIdOf(A) });
    expect(w.asked).toHaveLength(1);
  });
  it("a human edit's reflection (the task's own facts only) never reads the thread", async () => {
    const w = await world();
    const sources = createLocalLessonSources({
      flow: { store: w.store, projects: undefined as never }, companyId: A, ownerId: "local-owner", repos: { ofProject: async () => [], ofTask: async () => undefined } as unknown as LessonRepositories, now,
      hosted: { people: people({ [`${A}/payments`]: ["ann"] }) }, slack: w.wiring(A),
    });
    await sources.source.read({ workspaceId: A, taskId: w.taskIdOf(A), context: "human_edit" });
    expect(w.asked).toEqual([]);
  });
  it("a source built with no slack option is exactly what it was: no span, no command", async () => {
    const w = await world();
    const plain = createLocalLessonSources({ flow: { store: w.store, projects: undefined as never }, companyId: A, ownerId: "local-owner", repos: { ofProject: async () => [], ofTask: async () => undefined } as unknown as LessonRepositories, now, hosted: { people: people({ [`${A}/payments`]: ["ann"] }) } });
    const read = await plain.source.read({ workspaceId: A, taskId: w.taskIdOf(A) });
    expect(read!.facts.rest.spans!.filter((s) => s.kind === "slack_reply")).toEqual([]);
    expect(w.asked).toEqual([]);
  });
});

describe("the Team record never asks for the thread", () => {
  it("its read of a finished task says so (the lessons read the thread once, and the record keeps no chat reply)", async () => {
    const asked: Array<{ withoutSlack?: true | undefined }> = [];
    const source = { read: async (input: { withoutSlack?: true | undefined }) => { asked.push(input); return undefined; } };
    const w = await world();
    await recordEndedTask({ record: { companyId: A } as never, source, rows: {} as never, companyId: A, taskId: w.taskIdOf(A), now, origin: undefined });
    expect(asked).toEqual([expect.objectContaining({ withoutSlack: true })]);
  });
});

describe("on a laptop only the owner is a person", () => {
  it("a linked account of anyone but the owner is not read, even if a link row names them", async () => {
    const w = await world();
    const read = async (owner: string) => (await createLocalLessonSources({ flow: { store: w.store, projects: undefined as never }, companyId: A, ownerId: owner, repos: { ofProject: async () => [], ofTask: async () => undefined } as unknown as LessonRepositories, now, slack: w.wiring(A) }).source.read({ workspaceId: A, taskId: w.taskIdOf(A) }))?.facts.rest.spans?.filter((x) => x.kind === "slack_reply") ?? [];
    expect((await read("ann")).map((x) => x.authorId)).toEqual(["ann"]);
    expect(await read("someone-else")).toEqual([]);
  });
});

describe("two companies stay apart", () => {
  it("each company reads its own thread, with its own person for the same Slack account id, and a company-A reader refuses company B's task", async () => {
    const w = await world({ roster: { [`${A}/payments`]: ["ann"], [`${B}/payments`]: ["bob"] } });
    expect((await w.spansOf(A)).map((s) => s.authorId)).toEqual(["ann"]);
    // Company B's roster has only bob, and the Slack account is linked to ann in B too: not on B's roster, so nothing.
    expect(await w.spansOf(B)).toEqual([]);
    expect(await w.wiring(A).reader.read({ companyId: B, project: "payments", taskId: w.taskIdOf(B) })).toBeUndefined();
  });
  it("a person's switch in company A is not their switch in company B", async () => {
    const w = await world();
    await writeSlackOptOut(w.store, A, "ann", true, now());
    expect(await readSlackOptOut(w.store, A, "ann")).toBe(true);
    expect(await readSlackOptOut(w.store, B, "ann")).toBe(false);
    expect(await w.spansOf(B)).toHaveLength(1);
  });
});

describe("the person's erase removes their switch (and the lessons that name them)", () => {
  it("deletes the person's own row, in their company only, and the erase can be repeated", async () => {
    const store = new MemoryDocumentStore();
    await writeSlackOptOut(store, A, "ann", true, 1);
    await writeSlackOptOut(store, B, "ann", true, 1);
    await writeSlackOptOut(store, A, "bob", true, 1);
    const report = await erasePersonLessons({ store, audit: { stage: () => [], record: async () => undefined }, companyId: A, personId: "ann", now: () => 9 });
    expect(report.rows).toBeGreaterThanOrEqual(1);
    expect(await readSlackOptOut(store, A, "ann")).toBe(false);
    expect(await readSlackOptOut(store, B, "ann")).toBe(true);
    expect(await readSlackOptOut(store, A, "bob")).toBe(true);
    await erasePersonLessons({ store, audit: { stage: () => [], record: async () => undefined }, companyId: A, personId: "ann", now: () => 9 });
  });
});
