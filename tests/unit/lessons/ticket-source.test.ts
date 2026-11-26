// Ticket comments as a (weak) lessons source (L4-SRC-TK): the wiring at a task's end. Held: only the ticket intake STARTED this task from is read (a ticket linked by hand, a raced start, a task with no ticket, never);
// only a task that ENDED; a paused source is not read at all (no tracker call); only comments inside the task's window by project members; company and project scoped; a tracker that cannot read, fails, hangs or has more
// comments than one read reaches gives no spans and never stops the task's other learning.
import { randomUUID } from "node:crypto";
import { OrgIdSchema, intakeItemIdOf, type OrgId, type Principal, type SubjectComment, type Tracker } from "@agentx/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ticketSessionStartExtras } from "../../../packages/broker/src/aws/hosted-intake.js";
import { claimIntakeItem, markIntakeStarted } from "../../../packages/broker/src/core/intake/store.js";
import { bindSessionSurface } from "../../../packages/broker/src/core/sessions/bindings.js";
import { taskKey } from "../../../packages/broker/src/core/task-flow/keys.js";
import type { HostedLessonPeople } from "../../../packages/broker/src/lessons/hosted-people.js";
import type { LessonRepositories } from "../../../packages/broker/src/core-host/app/lessons-repos.js";
import { createLocalLessonSources, type LessonTicketWiring } from "../../../packages/broker/src/core-host/app/lessons-sources.js";
import { createSessionStartExtras } from "../../../packages/broker/src/core-host/app/session-start.js";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const STARTED = "2026-11-17T10:00:00.000Z";
const ENDED = "2026-11-17T12:00:00.000Z";
const NOW = Date.parse("2026-11-17T13:00:00.000Z");
const RULE = "Error messages shown to customers must come from copy/errors.ts, not inline strings.";
const ANN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KEY = "ENG-12";

afterEach(() => { vi.useRealTimers(); });

const comment = (id: string, over: { account?: string | undefined; isBot?: boolean; body?: string; at?: string; updated?: string; item?: string } = {}): SubjectComment => ({
  id, subject: { kind: "item", ref: { tracker: "linear", id: over.item ?? KEY } }, author: { login: "someone", ...(over.account === undefined && "account" in over ? {} : { hostUserId: over.account ?? ANN }), isBot: over.isBot ?? false },
  body: over.body ?? RULE, createdAt: over.at ?? "2026-11-17T11:00:00.000Z", updatedAt: over.updated ?? over.at ?? "2026-11-17T11:00:00.000Z",
});

function fakeTracker(script: (call: number, options: { since?: string; page?: number }) => Promise<{ comments: SubjectComment[]; nextPage?: number }>) {
  const calls: Array<{ ref: unknown; options: { since?: string; page?: number }; scope: unknown }> = [];
  const tracker = { kind: "linear", capabilities: {}, readItem: async () => { throw new Error("no"); },
    comments: async (ref: unknown, options: { since?: string; page?: number }, scope: unknown) => { calls.push({ ref, options, scope }); return script(calls.length, options); },
  } as unknown as Tracker;
  return { tracker, calls };
}
const onePage = (...comments: SubjectComment[]) => fakeTracker(async () => ({ comments }));

function people(roster: Record<string, string[]>): HostedLessonPeople {
  return {
    async approvers() { return { complete: true, membershipVersion: 1, ownerIds: [], eligibleIds: [], lastEligibleLossAtMs: null }; },
    async onProjectRoster(c, project, person) { return (roster[`${c}/${project}`] ?? []).includes(person); },
    async linkedAccounts() { return []; }, async displayName() { return undefined; }, async isErased(_c, person) { return person === "gone"; },
  };
}

interface Over {
  origin?: "intake" | "hand_linked" | "raced" | "none"; tracker?: Tracker | undefined; company?: OrgId; project?: string; ended?: boolean; closedAt?: string | undefined; releasedAt?: string | undefined;
  roster?: Record<string, string[]>; paused?: () => Promise<boolean>; wiring?: boolean; developerId?: string;
  accounts?: Record<string, string>; emptyUrl?: boolean;
}
async function world(over: Over = {}) {
  const store = new MemoryDocumentStore();
  const company = over.company ?? A;
  const project = over.project ?? "payments";
  const origin = over.origin ?? "intake";
  const taskId = randomUUID();
  const principal: Principal = { companyId: company, personId: "owner", displayName: "Owner", roles: ["member"], provider: "hosted" };
  const url = `https://linear.app/acme/issue/${KEY}/x`;
  const table = { store, now: () => NOW };
  let sessionId: string;
  if (origin === "intake" || origin === "raced") {
    const extras = ticketSessionStartExtras(company)({ taskId, workspaceId: `ws-${taskId}`, project, title: "Refunds fail", principal, client: "tracker", receivedAt: STARTED, ticket: { system: "linear", id: KEY, url } });
    await store.transact([...extras.items]);
    sessionId = extras.sessionId!;
  } else {
    const extras = createSessionStartExtras(company)({ taskId, workspaceId: `ws-${taskId}`, project, title: "Refunds fail", principal, client: "web", receivedAt: STARTED });
    await store.transact([...extras.items]);
    sessionId = extras.sessionId!;
    if (origin === "hand_linked") await bindSessionSurface(table, { orgId: company, sessionId, binding: { kind: "tracker_item", system: "linear", id: KEY, url } });
  }
  const ended = over.ended !== false;
  await store.put({ item: { ...taskKey(taskId), entityType: "DEVTASK", taskId, companyId: company, project, sessionId, developerId: over.developerId ?? "ann", startingRevision: 1, title: "Refunds fail", requestText: "Fix refunds",
    createdAt: STARTED, updatedAt: STARTED, ...(over.closedAt === undefined && !ended ? {} : { closedAt: over.closedAt ?? ENDED }), ...(over.releasedAt === undefined ? {} : { releasedAt: over.releasedAt }),
    workflow: { revision: 3, artifacts: [], reviews: [], pullRequests: [], decisions: [], ...(ended ? { outcome: "MERGED" } : {}) } } });
  if (origin === "intake" || origin === "raced") {
    const itemId = intakeItemIdOf("linear", KEY);
    await claimIntakeItem(table, { orgId: company, project, itemId, channel: "tracker", system: "linear", id: KEY, url: over.emptyUrl === true ? "" : url, title: "Refunds fail", requester: { display: "Dana", standing: "outsider" }, state: "starting", startedBy: "holder" });
    await markIntakeStarted(table, company, project, itemId, { holder: "holder", taskId: origin === "raced" ? randomUUID() : taskId, sessionId, requester: { display: "Dana", standing: "outsider" } });
  }
  const fake = over.tracker === undefined ? onePage(comment("c1")) : undefined;
  const tracker = over.tracker ?? fake!.tracker;
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const accounts = over.accounts ?? { [ANN]: "ann", [BOB]: "bob" };
  const tickets: LessonTicketWiring = {
    trackerFor: (system) => (system === "linear" ? tracker : undefined), scope: { orgId: company },
    personOfAccount: async (_t, _tenant, account) => accounts[account], paused: over.paused ?? (async () => false),
  };
  const repos = { ofProject: async () => [], ofTask: async () => undefined } as unknown as LessonRepositories;
  const sources = createLocalLessonSources({
    flow: { store, projects: undefined as never }, companyId: OrgIdSchema.parse(company), ownerId: "local-owner", repos, now: () => NOW, log: (event, fields) => { logs.push({ event, fields }); },
    hosted: { people: people(over.roster ?? { [`${A}/payments`]: ["ann", "bob"], [`${B}/payments`]: ["ann", "bob"] }) }, ...(over.wiring === false ? {} : { tickets }),
  });
  const read = async (workspaceId: string = company, context?: "human_edit") => sources.source.read({ workspaceId, taskId, ...(context === undefined ? {} : { context }) });
  const spans = async (workspaceId: string = company, context?: "human_edit") => ((await read(workspaceId, context))?.facts.rest.spans ?? []).filter((s) => s.kind === "ticket_comment");
  return { store, taskId, sessionId, tracker, calls: fake?.calls ?? [], logs, read, spans };
}

describe("only the ticket that STARTED this task is read", () => {
  it("a task intake started from a ticket: the tracker is asked once for that ticket's comments since the task started, in the company's scope, and a member's correction becomes a ticket_comment span", async () => {
    const w = await world();
    const spans = await w.spans();
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]).toMatchObject({ ref: { tracker: "linear", id: KEY, url: `https://linear.app/acme/issue/${KEY}/x` }, options: { since: STARTED, page: 1 }, scope: { orgId: A } });
    expect(spans.map((s) => [s.kind, s.authorId, s.trust, s.sourceKey, s.text])).toEqual([["ticket_comment", "ann", "member", "linear:payments", RULE]]);
    expect(spans[0]!.eventId).toBe("ticket:linear:ENG-12:c1");
  });
  it("a ticket whose own link was not recorded (the intake item has none) is not read (the workspace cannot be told)", async () => {
    const w = await world({ emptyUrl: true });
    expect(await w.spans()).toEqual([]);
    expect(w.calls).toHaveLength(0);
    expect(w.logs.some((l) => l.fields["code"] === "no_url")).toBe(true);
  });
  it("a ticket someone linked by hand to a task that did not start from it is never read", async () => {
    const w = await world({ origin: "hand_linked" });
    expect(await w.spans()).toEqual([]);
    expect(w.calls).toHaveLength(0);
  });
  it("a duplicate or raced start (the intake item is started for the session but names another task) is never read", async () => {
    const w = await world({ origin: "raced" });
    expect(await w.spans()).toEqual([]);
    expect(w.calls).toHaveLength(0);
  });
  it("a task with no ticket at all is never read", async () => {
    const w = await world({ origin: "none" });
    expect(await w.spans()).toEqual([]);
    expect(w.calls).toHaveLength(0);
  });
  it("a task that has not ended (a send-back's reflection of an open task) reads no ticket, and neither does the human-edit job", async () => {
    const open = await world({ ended: false });
    expect(await open.spans()).toEqual([]);
    expect(open.calls).toHaveLength(0);
    const edit = await world();
    expect(await edit.spans(A, "human_edit")).toEqual([]);
    expect(edit.calls).toHaveLength(0);
  });
  it("an install with no ticket wiring reads nothing and the task's other spans are unchanged", async () => {
    const w = await world({ wiring: false });
    expect((await w.read())?.facts.rest.spans?.map((s) => s.kind)).toEqual(["intent"]);
    expect(w.calls).toHaveLength(0);
  });
});

describe("the project's Pause is a stop: the source is not read at all", () => {
  it("a paused source makes no tracker call and gives no span, and says so in one fixed line", async () => {
    const w = await world({ paused: async () => true });
    expect(await w.spans()).toEqual([]);
    expect(w.calls).toHaveLength(0);
    expect(w.logs.some((l) => l.event === "lessons.ticket_comments_skipped" && l.fields["code"] === "paused")).toBe(true);
  });
  it("a pause that cannot be read counts as paused (fail closed): no tracker call", async () => {
    const w = await world({ paused: async () => { throw new Error("store down"); } });
    expect(await w.spans()).toEqual([]);
    expect(w.calls).toHaveLength(0);
  });
  it("the same task is read once the source is not paused", async () => {
    const w = await world({ paused: async () => false });
    expect(await w.spans()).toHaveLength(1);
  });
});

describe("the window and the people, through the source", () => {
  const spansOf = async (comments: SubjectComment[], over: Over = {}) => (await (await world({ ...over, tracker: onePage(...comments).tracker })).spans()).map((s) => s.eventId);
  it("only comments created after the task started and before it ended: the end is the task's release or close, not the time of the read", async () => {
    const comments = [comment("early", { at: "2026-11-17T09:59:59.000Z" }), comment("inside", { at: "2026-11-17T11:00:00.000Z" }), comment("late", { at: "2026-11-17T12:30:00.000Z" })];
    expect(await spansOf(comments)).toEqual(["ticket:linear:ENG-12:inside"]);
    expect(await spansOf(comments, { releasedAt: "2026-11-17T10:30:00.000Z", closedAt: "2026-11-17T12:00:00.000Z" })).toEqual([]);
  });
  it("a bot, a comment with no account, Rovara's own, praise and a non-member are left out; a member's correction stays", async () => {
    const comments = [
      comment("bot", { isBot: true }), comment("noacct", { account: undefined }), comment("own", { body: "Rovara: \"Refunds fail\"\nState: Working on it (since Nov 17 14:10 UTC)" }),
      comment("praise", { body: "Looks good to me, nice work on this one" }), comment("stranger", { account: "99999999-9999-4999-8999-999999999999" }), comment("offroster", { account: BOB }), comment("keep", { account: ANN }),
    ];
    expect(await spansOf(comments, { roster: { [`${A}/payments`]: ["ann"] } })).toEqual(["ticket:linear:ENG-12:keep"]);
  });
  it("a person who is erased is left out", async () => {
    expect(await spansOf([comment("gone")], { accounts: { [ANN]: "gone" }, roster: { [`${A}/payments`]: ["gone"] } })).toEqual([]);
  });
  it("a comment the adapter says is on another item is not this ticket's", async () => {
    expect(await spansOf([comment("other", { item: "ENG-99" })])).toEqual([]);
  });
  it("the roster of the TASK's project decides: a person on another project's roster only is not a member here", async () => {
    expect(await spansOf([comment("c")], { project: "billing", roster: { [`${A}/payments`]: ["ann"], [`${A}/billing`]: ["bob"] } })).toEqual([]);
    expect(await spansOf([comment("c")], { project: "billing", roster: { [`${A}/billing`]: ["ann"] } })).toEqual(["ticket:linear:ENG-12:c"]);
  });
});

describe("two companies", () => {
  it("another company's workspace reads nothing of this company's task and makes no tracker call; a person on company B's roster only is not a member of company A's task", async () => {
    const w = await world();
    expect(await w.read(B)).toBeUndefined();
    expect(w.calls).toHaveLength(0);
    const other = await world({ roster: { [`${B}/payments`]: ["ann"] } });
    expect(await other.spans()).toEqual([]);
  });
  it("a company B task is read in company B's scope with company B's people, and never calls company A's", async () => {
    const w = await world({ company: B });
    expect(await w.spans(B)).toHaveLength(1);
    expect(w.calls[0]).toMatchObject({ scope: { orgId: B } });
  });
});

describe("a tracker that cannot help never stops the task's other learning", () => {
  const intentOnly = async (w: Awaited<ReturnType<typeof world>>) => (await w.read())?.facts.rest.spans?.map((s) => s.kind);
  it("a tracker with no comments read: no spans, one fixed line", async () => {
    const bare = { kind: "linear", capabilities: {}, readItem: async () => { throw new Error("no"); } } as unknown as Tracker;
    const w = await world({ tracker: bare });
    expect(await intentOnly(w)).toEqual(["intent"]);
    expect(w.logs.some((l) => l.fields["code"] === "no_read")).toBe(true);
  });
  it("a read that fails: no spans, the read still answers, and the failure's own words are not logged", async () => {
    const failing = fakeTracker(async () => { throw new Error("secret-token-xyz exploded"); });
    const w = await world({ tracker: failing.tracker });
    expect(await intentOnly(w)).toEqual(["intent"]);
    expect(JSON.stringify(w.logs)).not.toContain("secret-token-xyz");
  });
  it("a read that never answers is given up on after the time limit", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["setTimeout", "clearTimeout"] });
    const hung = fakeTracker(() => new Promise(() => undefined));
    const w = await world({ tracker: hung.tracker });
    const pending = w.read();
    // The limit's timer is set a few steps in: time moves in small steps until the read has given up.
    for (let step = 0; step < 30; step += 1) await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending)?.facts.rest.spans?.map((s) => s.kind)).toEqual(["intent"]);
  });
  it("two pages are read and joined; a ticket with more comments than five pages reach is not read at all (never a partial answer)", async () => {
    const paged = fakeTracker(async (call) => ({ comments: [comment(`p${String(call)}`)], ...(call < 2 ? { nextPage: call + 1 } : {}) }));
    const two = await world({ tracker: paged.tracker });
    expect((await two.spans()).map((s) => s.eventId)).toEqual(["ticket:linear:ENG-12:p1", "ticket:linear:ENG-12:p2"]);
    expect(paged.calls.map((c) => c.options.page)).toEqual([1, 2]);
    const endless = fakeTracker(async (call) => ({ comments: [comment(`e${String(call)}`)], nextPage: call + 1 }));
    const many = await world({ tracker: endless.tracker });
    expect(await many.spans()).toEqual([]);
    expect(endless.calls).toHaveLength(5);
  });
});
