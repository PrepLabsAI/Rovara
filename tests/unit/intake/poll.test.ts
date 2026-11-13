// the generic poll over a tracker's search. It decides WHEN to ask (2 minutes by default, at most 60 reads an hour, both settings), never starts a ticket twice,
// backs off when asking fails and tells the maintainers after an hour; the intake engine decides what each ticket becomes. No tracker is named here: the adapter is the test's own.
import { describe, expect, it } from "vitest";
import { agentXError, change, intakeSourceKey, type IntakeChannelRef, type OrgId } from "@rovara-code/contracts";
import type { IntakePorts } from "../../../packages/core/src/core/intake/engine.js";
import { listWaitingIntakeItems } from "../../../packages/core/src/core/intake/store.js";
import { listIntakeSources, replaceIntakeSources } from "../../../packages/core/src/core/intake/sources.js";
import {
  INTAKE_BACKOFF_MAX_MS, INTAKE_NOTICE_AFTER_MS, INTAKE_TICK_BUDGET_MS, INTAKE_NOTICE_EVERY_MS, pollIntakeSource, runIntakePoll, type IntakeNotice, type IntakePollDependencies, type IntakeSearch, type IntakeSearchItem,
} from "../../../packages/core/src/core/intake/poll.js";
import { RecordingStore } from "../../support/intake-world.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
/** The tracker account of a person, in the neutral outside-account shape. */
const acct = (accountId: string) => ({ provider: "sim", tenant: "", accountId });
const OTHER_ORG = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const MEMBER = "a".repeat(64);
const MINUTE = 60_000;
const SOURCE: IntakeChannelRef = { channel: "tracker", system: "sim", when: { label: "rovara" } };

const item = (id: string, over: Partial<IntakeSearchItem> = {}): IntakeSearchItem => ({
  externalRef: { system: "sim", id, url: `https://sim.example.test/${id}` }, title: `Ticket ${id}`, body: "Details", reporter: { display: "Dana" }, ...over,
});

function world() {
  const db = new RecordingStore();
  const clock = { now: Date.parse("2026-10-31T10:00:00.000Z") };
  const started: string[] = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const notices: IntakeNotice[] = [];
  const calls: Array<{ orgId: string; project: string; limit: number }> = [];
  const state: { search: IntakeSearch; notifyFails: boolean } = { search: async () => [], notifyFails: false };
  const ports: IntakePorts = {
    table: { store: db, now: () => clock.now },
    log: (event, fields) => { logs.push({ event, fields }); },
    memberOfAccount: async (_org, account) => (account.accountId === "u-member" ? MEMBER : undefined),
    mayStart: async () => true,
    start: async (_org, developerId, request) => { started.push(`${developerId}:${request.binding?.kind === "tracker_item" ? request.binding.id : ""}`); return { task: { taskId: `task-${String(started.length)}` }, sessionId: `ses_${String(started.length).padStart(20, "0")}` }; },
    sessionOfTicket: async () => undefined,
  };
  const deps: IntakePollDependencies = {
    ports,
    searchFor: (system) => (system === "sim" ? (input) => { calls.push({ orgId: input.orgId, project: input.project, limit: input.limit }); return state.search(input); } : undefined),
    notify: async (notice) => { if (state.notifyFails) throw new Error("notice store away"); notices.push(notice); },
    searchTimeoutMs: 50,
  };
  const addSource = async (ref: IntakeChannelRef = SOURCE, project = "web", orgId: OrgId = ORG) => (await replaceIntakeSources(ports.table, { orgId, project, refs: [ref], setBy: MEMBER }))[0]!;
  const record = async (project = "web", orgId: OrgId = ORG) => (await listIntakeSources(ports.table, orgId, project))[0]!;
  return { db, clock, ports, deps, started, logs, notices, calls, state, addSource, record };
}

describe("when a source is read", () => {
  it("reads a new source at once and then every 2 minutes by default", async () => {
    const w = world();
    await w.addSource();
    expect(await runIntakePoll(w.deps)).toMatchObject({ polled: 1 });
    expect(w.calls).toHaveLength(1);
    w.clock.now += 1 * MINUTE;
    expect(await runIntakePoll(w.deps)).toMatchObject({ polled: 0, skipped: { not_due: 1 } });
    expect(w.calls).toHaveLength(1);
    w.clock.now += 1 * MINUTE;
    expect(await runIntakePoll(w.deps)).toMatchObject({ polled: 1 });
    expect(w.calls).toHaveLength(2);
  });

  it("takes the source's own interval", async () => {
    const w = world();
    await w.addSource({ ...SOURCE, poll: { everyMinutes: 10 } });
    await runIntakePoll(w.deps);
    w.clock.now += 9 * MINUTE;
    await runIntakePoll(w.deps);
    expect(w.calls).toHaveLength(1);
    w.clock.now += 1 * MINUTE;
    await runIntakePoll(w.deps);
    expect(w.calls).toHaveLength(2);
  });

  it("reads at most 60 times an hour even at the fastest interval (one a minute), and begins again when the hour turns", async () => {
    const w = world();
    await w.addSource({ ...SOURCE, poll: { everyMinutes: 1 } });
    for (let tick = 0; tick < 59; tick += 1) {
      await runIntakePoll(w.deps);
      w.clock.now += MINUTE;
    }
    // 59 minutes in: 59 reads so far at one a minute; the hour holds 60.
    expect(w.calls).toHaveLength(59);
    await runIntakePoll(w.deps);
    expect(w.calls).toHaveLength(60);
    // Still in the same hour? 10:00 + 59 minutes = 10:59. The next minute is the next hour, whose count starts again.
    w.clock.now += MINUTE;
    await runIntakePoll(w.deps);
    expect(w.calls).toHaveLength(61);
  });

  it("stops at the source's own cap within the hour", async () => {
    const w = world();
    await w.addSource({ ...SOURCE, poll: { everyMinutes: 1, maxCallsPerHour: 3 } });
    const reports = [];
    for (let tick = 0; tick < 8; tick += 1) {
      reports.push(await runIntakePoll(w.deps));
      w.clock.now += MINUTE;
    }
    expect(w.calls).toHaveLength(3);
    expect(reports.slice(3).every((report) => (report.skipped["call_cap"] ?? 0) === 1)).toBe(true);
    // The hour turns: reads begin again.
    w.clock.now = Date.parse("2026-10-31T11:00:00.000Z");
    await runIntakePoll(w.deps);
    expect(w.calls).toHaveLength(4);
  });

  it("does not read a source that is not polled (Jira or GitHub Issues that are only listened to)", async () => {
    const w = world();
    await w.addSource({ channel: "jira", when: { label: "rovara" } });
    const report = await runIntakePoll(w.deps);
    expect(report).toMatchObject({ considered: 0, polled: 0 });
    expect(w.calls).toEqual([]);
  });

  it("reads a Jira source that names poll", async () => {
    const w = world();
    w.state.search = async () => [{ ...item("PAY-1"), externalRef: { system: "jira", id: "PAY-1", url: "https://acme.atlassian.net/browse/PAY-1" } }];
    await w.addSource({ channel: "jira", when: { label: "rovara" }, poll: {} });
    w.deps.searchFor = () => w.state.search;
    expect(await runIntakePoll(w.deps)).toMatchObject({ polled: 1, waiting: 1 });
  });
});

describe("no double start", () => {
  it("polls a due source once when two ticks overlap", async () => {
    const w = world();
    await w.addSource();
    w.state.search = async () => [item("T-1", { actor: { kind: "person", account: acct("u-member") } })];
    const [first, second] = await Promise.all([runIntakePoll(w.deps), runIntakePoll(w.deps)]);
    expect(w.calls).toHaveLength(1);
    expect(first.polled + second.polled).toBe(1);
    expect(w.started).toHaveLength(1);
  });

  it("starts a ticket once however many times it is seen", async () => {
    const w = world();
    await w.addSource();
    w.state.search = async () => [item("T-1", { actor: { kind: "person", account: acct("u-member") } })];
    for (let tick = 0; tick < 5; tick += 1) {
      await runIntakePoll(w.deps);
      w.clock.now += 2 * MINUTE;
    }
    expect(w.calls).toHaveLength(5);
    expect(w.started).toEqual([`${MEMBER}:T-1`]);
  });

  it("does not start a ticket again that still carries its label after its task ended (a poll has no label event)", async () => {
    const w = world();
    await w.addSource();
    w.ports.freeTicket = async () => undefined;
    w.state.search = async () => [item("T-1", { actor: { kind: "person", account: acct("u-member") } })];
    await runIntakePoll(w.deps);
    expect(w.started).toHaveLength(1);
    // The task ended and its hold on the ticket is gone; the ticket still has its label.
    for (let tick = 0; tick < 4; tick += 1) {
      w.clock.now += 2 * MINUTE;
      await runIntakePoll(w.deps);
    }
    expect(w.started).toHaveLength(1);
  });

  it("keeps a ticket nobody has asked for as one waiting item however many times it is seen", async () => {
    const w = world();
    await w.addSource();
    w.state.search = async () => [item("T-1"), item("T-2")];
    for (let tick = 0; tick < 4; tick += 1) {
      await runIntakePoll(w.deps);
      w.clock.now += 2 * MINUTE;
    }
    expect(await listWaitingIntakeItems(w.ports.table, ORG, "web")).toHaveLength(2);
    expect(w.started).toEqual([]);
  });

  it("does not take a source whose lease another tick holds", async () => {
    const w = world();
    const source = await w.addSource();
    // Another tick moved nextPollAt after this one read the record.
    await w.db.update({ key: intakeSourceKey(ORG, "web", source.sourceId), ops: [change.set("nextPollAt", w.clock.now + 2 * MINUTE)] });
    expect(await pollIntakeSource(w.deps, source)).toEqual({ outcome: "lost_lease" });
    expect(w.calls).toEqual([]);
  });
});

describe("what a read hands back", () => {
  it("fixes the org, the project and the channel from the source, whatever the adapter says", async () => {
    const w = world();
    await w.addSource();
    w.state.search = async () => [{ ...item("T-1"), orgId: OTHER_ORG, project: "payments", channel: "jira" } as unknown as IntakeSearchItem];
    await runIntakePoll(w.deps);
    expect(await listWaitingIntakeItems(w.ports.table, ORG, "web")).toHaveLength(1);
    expect(await listWaitingIntakeItems(w.ports.table, OTHER_ORG, "payments")).toEqual([]);
    expect(await listWaitingIntakeItems(w.ports.table, ORG, "payments")).toEqual([]);
  });

  it("drops a result that names another tracker, and cuts a long list to 50", async () => {
    const w = world();
    await w.addSource();
    w.state.search = async () => [
      { ...item("PAY-9"), externalRef: { system: "jira", id: "PAY-9", url: "https://acme.atlassian.net/browse/PAY-9" } },
      ...Array.from({ length: 80 }, (_, index) => item(`T-${String(index)}`)),
    ];
    const report = await runIntakePoll(w.deps);
    expect(report.waiting).toBe(49);
    expect((await listWaitingIntakeItems(w.ports.table, ORG, "web")).every((entry) => entry.system === "sim")).toBe(true);
    // The first (foreign) item was dropped, so 49 of the first 50 were stored.
  });

  it("starts a ticket a member asked for and parks the others, through the engine's rule", async () => {
    const w = world();
    await w.addSource();
    w.state.search = async () => [item("T-1", { actor: { kind: "person", account: acct("u-member") } }), item("T-2", { actor: { kind: "person", account: acct("u-stranger") } }), item("T-3")];
    expect(await runIntakePoll(w.deps)).toMatchObject({ started: 1, waiting: 2 });
  });
});

describe("when a read fails", () => {
  it("backs the source off (twice the interval each time, at most an hour), and starts nothing", async () => {
    const w = world();
    await w.addSource();
    w.state.search = async () => { throw new Error("tracker is down"); };
    const waits: number[] = [];
    for (let tick = 0; tick < 7; tick += 1) {
      const before = w.clock.now;
      await runIntakePoll(w.deps);
      const record = await w.record();
      waits.push((record.nextPollAt - before) / MINUTE);
      w.clock.now = record.nextPollAt;
    }
    expect(waits).toEqual([4, 8, 16, 32, 60, 60, 60]);
    expect(INTAKE_BACKOFF_MAX_MS).toBe(60 * MINUTE);
    expect(w.started).toEqual([]);
  });

  it("records a code, never the tracker's words, in the record and the logs", async () => {
    const w = world();
    await w.addSource();
    w.state.search = async () => { throw new Error("401 from sim: token sk_live_abc123 was refused"); };
    await runIntakePoll(w.deps);
    const record = await w.record();
    expect(record).toMatchObject({ failures: 1, lastError: "SEARCH_FAILED" });
    expect(JSON.stringify(w.logs)).not.toContain("sk_live");
    expect(JSON.stringify(record)).not.toContain("sk_live");
  });

  it("records an error's code when it has one", async () => {
    const w = world();
    await w.addSource();
    w.state.search = async () => { throw agentXError("RUNTIME_UNAVAILABLE", "x"); };
    await runIntakePoll(w.deps);
    expect((await w.record()).lastError).toBe("RUNTIME_UNAVAILABLE");
  });

  it("counts a read that takes too long as a failure", async () => {
    const w = world();
    await w.addSource();
    w.state.search = () => new Promise(() => undefined);
    expect(await runIntakePoll(w.deps)).toMatchObject({ failed: 1 });
    expect((await w.record()).lastError).toBe("TIMEOUT");
  });

  it("asks the adapter to stop when the time runs out", async () => {
    const w = world();
    await w.addSource();
    let aborted = false;
    w.state.search = (input) => new Promise(() => { input.signal.addEventListener("abort", () => { aborted = true; }); });
    await runIntakePoll(w.deps);
    expect(aborted).toBe(true);
  });

  it("counts a result that is not a list, and a source with no adapter, as failures", async () => {
    const w = world();
    await w.addSource();
    w.state.search = (async () => ({ items: [] })) as unknown as IntakeSearch;
    await runIntakePoll(w.deps);
    expect((await w.record()).failures).toBe(1);
    const other = world();
    await other.addSource({ channel: "tracker", system: "other", when: { label: "x" } });
    expect(await runIntakePoll(other.deps)).toMatchObject({ failed: 1 });
    expect((await other.record()).lastError).toBe("NOT_FOUND");
  });

  it("is healthy again after one read that works", async () => {
    const w = world();
    await w.addSource();
    w.state.search = async () => { throw new Error("down"); };
    await runIntakePoll(w.deps);
    expect((await w.record()).failures).toBe(1);
    w.clock.now += 5 * MINUTE;
    w.state.search = async () => [];
    await runIntakePoll(w.deps);
    const record = await w.record();
    expect(record.failures).toBe(0);
    expect(record.failingSince).toBeUndefined();
    expect(record.lastError).toBeUndefined();
  });

  it("goes on with the other sources when one fails", async () => {
    const w = world();
    await w.addSource(SOURCE, "web");
    await w.addSource(SOURCE, "api");
    let call = 0;
    w.state.search = async () => { call += 1; if (call === 1) throw new Error("down"); return [item("T-1")]; };
    expect(await runIntakePoll(w.deps)).toMatchObject({ polled: 1, failed: 1 });
  });
});

describe("the maintainers' notice", () => {
  async function failFor(w: ReturnType<typeof world>, minutes: number) {
    await w.addSource();
    w.state.search = async () => { throw new Error("down"); };
    const end = w.clock.now + minutes * MINUTE;
    while (w.clock.now <= end) {
      await runIntakePoll(w.deps);
      w.clock.now = Math.max((await w.record()).nextPollAt, w.clock.now + MINUTE);
    }
  }

  it("is sent once, after the source has failed for an hour, with ids and a code only", async () => {
    const w = world();
    await failFor(w, 50);
    expect(w.notices).toEqual([]);
    await failFor(w, 130);
    expect(w.notices).toHaveLength(1);
    expect(w.notices[0]).toMatchObject({ code: "source_failing", orgId: ORG, project: "web", system: "sim", lastError: "SEARCH_FAILED" });
    expect(w.notices[0]!.failingMinutes).toBeGreaterThanOrEqual(60);
    expect(INTAKE_NOTICE_AFTER_MS).toBe(60 * MINUTE);
  });

  it("is sent again only after a day", async () => {
    const w = world();
    await failFor(w, 120);
    expect(w.notices).toHaveLength(1);
    await failFor(w, 600);
    expect(w.notices).toHaveLength(1);
    await failFor(w, INTAKE_NOTICE_EVERY_MS / MINUTE);
    expect(w.notices.length).toBeGreaterThanOrEqual(2);
  });

  it("is tried again at the next failure when it could not be sent", async () => {
    const w = world();
    w.state.notifyFails = true;
    await failFor(w, 120);
    expect(w.notices).toEqual([]);
    expect((await w.record()).noticedAt).toBeUndefined();
    w.state.notifyFails = false;
    await failFor(w, 130);
    expect(w.notices).toHaveLength(1);
  });

  it("is not sent for a source that recovered", async () => {
    const w = world();
    await failFor(w, 30);
    w.state.search = async () => [];
    w.clock.now += 5 * MINUTE;
    await runIntakePoll(w.deps);
    w.state.search = async () => { throw new Error("down again"); };
    await failFor(w, 30);
    expect(w.notices).toEqual([]);
  });
});

describe("how long one tick takes", () => {
  it("has a budget well inside the broker function's 30 second timeout", () => {
    expect(INTAKE_TICK_BUDGET_MS).toBeLessThanOrEqual(15_000);
  });

  it("stops handing tickets over when the budget runs out inside one source's batch, and the rest are seen next tick", async () => {
    const w = world();
    await w.addSource();
    const base = w.ports.start.bind(w.ports);
    // Each start takes a second.
    w.ports.start = async (...args) => { w.clock.now += 1_000; return base(...args); };
    w.state.search = async () => Array.from({ length: 30 }, (_, index) => item(`T-${String(index)}`, { actor: { kind: "person", account: acct("u-member") } }));
    const first = await runIntakePoll(w.deps, { budgetMs: 4_000 });
    expect(first.started).toBeGreaterThanOrEqual(3);
    expect(first.started).toBeLessThan(10);
    const startedFirst = w.started.length;
    // The source is still healthy (not failing), and the next tick goes on with the rest.
    expect((await w.record()).failures).toBe(0);
    w.clock.now += 2 * MINUTE;
    await runIntakePoll(w.deps, { budgetMs: 4_000 });
    expect(w.started.length).toBeGreaterThan(startedFirst);
    expect(new Set(w.started).size).toBe(w.started.length);
  });
});

describe("a fault in a start is not a fault of the source", () => {
  it("keeps the source healthy, stops the batch, tells nobody the tracker is unreadable, and starts the rest next tick", async () => {
    const w = world();
    await w.addSource();
    w.state.search = async () => [item("T-1", { actor: { kind: "person", account: acct("u-member") } }), item("T-2", { actor: { kind: "person", account: acct("u-member") } })];
    const base = w.ports.start.bind(w.ports);
    let fail = true;
    w.ports.start = async (...args) => { if (fail) { fail = false; throw new Error("start service away"); } return base(...args); };
    const report = await runIntakePoll(w.deps);
    expect(report.failed).toBe(0);
    expect((await w.record()).failures).toBe(0);
    w.clock.now += 2 * MINUTE;
    await runIntakePoll(w.deps);
    expect(w.started.sort()).toEqual([`${MEMBER}:T-1`, `${MEMBER}:T-2`]);
  });

  it("clears the notice mark when the source recovers, so a new failure within a day is told", async () => {
    const w = world();
    await w.addSource();
    w.state.search = async () => { throw new Error("down"); };
    const end = w.clock.now + 130 * MINUTE;
    while (w.clock.now <= end) { await runIntakePoll(w.deps); w.clock.now = Math.max((await w.record()).nextPollAt, w.clock.now + MINUTE); }
    expect(w.notices).toHaveLength(1);
    w.state.search = async () => [];
    await runIntakePoll(w.deps);
    w.clock.now = (await w.record()).nextPollAt;
    await runIntakePoll(w.deps);
    expect((await w.record()).noticedAt).toBeUndefined();
    w.state.search = async () => { throw new Error("down again"); };
    const end2 = w.clock.now + 130 * MINUTE;
    while (w.clock.now <= end2) { await runIntakePoll(w.deps); w.clock.now = Math.max((await w.record()).nextPollAt, w.clock.now + MINUTE); }
    expect(w.notices).toHaveLength(2);
  });
});

describe("how much one tick does", () => {
  it("polls at most the number of sources it is given, the longest-waiting first", async () => {
    const w = world();
    for (const project of ["a1", "a2", "a3", "a4"]) await w.addSource(SOURCE, project);
    const report = await runIntakePoll(w.deps, { maxSources: 2 });
    expect(report.polled).toBe(2);
    expect(report.skipped["tick_full"]).toBe(2);
    // The next tick reaches the others (their `nextPollAt` is still due).
    expect((await runIntakePoll(w.deps, { maxSources: 2 })).polled).toBe(2);
  });

  it("keeps every org's sources apart", async () => {
    const w = world();
    await w.addSource(SOURCE, "web", ORG);
    await w.addSource(SOURCE, "web", OTHER_ORG);
    const orgs: string[] = [];
    w.state.search = async (input) => { orgs.push(input.orgId); return [item("T-1")]; };
    await runIntakePoll(w.deps);
    expect(orgs.sort()).toEqual([ORG, OTHER_ORG]);
    expect(await listWaitingIntakeItems(w.ports.table, ORG, "web")).toHaveLength(1);
    expect(await listWaitingIntakeItems(w.ports.table, OTHER_ORG, "web")).toHaveLength(1);
  });
});
