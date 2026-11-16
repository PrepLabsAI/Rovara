// M7 after-merge watcher, first slice (TE-H2 core). Every collaborator here is a Rovara-made fake: a green run proves the watcher's own logic only (its records, its windows, its
// isolation, its presses), never that a real code host, alarm source, chat or revert path behaves this way.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DocumentStoreError, INDEX_EXPIRY_ATTRIBUTE, when, type AuditEvent, type AuditSink, type OrgId, type TransactItem, type TriggerEvent } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { openKey } from "../../packages/broker/src/core/after-merge/records.js";
import { mergeCommitIndexStep } from "../../packages/broker/src/core/proof/revert/merge-commit-index.js";
import {
  afterMergeSettingsOf, closeDueWatches, markExpected, observeDeployment, observeSignal, pressRevert, signalKeyOf,
  type AfterMergeActionDeps, type AfterMergeReport, type RevertRequest,
} from "../../packages/broker/src/core/after-merge/index.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const PROJECT = "shared-project";
const REPO = "acme/payments";
const SHA = "1".repeat(40);
const SHA2 = "2".repeat(40);
const URL7 = "https://github.com/acme/payments/pull/7";
const URL8 = "https://github.com/acme/payments/pull/8";
const T0 = Date.parse("2026-11-15T12:00:00.000Z");
const minutes = (count: number): number => count * 60_000;
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

interface WorldOptions { settingsFor?: (project: string) => unknown; settings?: Record<string, unknown> | "absent" | "throws" | undefined; people?: string[]; startFails?: number; reportFailures?: number }

/** One store for every company (so a key that forgets its company shows), and one set of seams for each. */
function createWorld() {
  const clock = { ms: T0 };
  const store = new MemoryDocumentStore({ ttlAttribute: INDEX_EXPIRY_ATTRIBUTE, nowSeconds: () => Math.floor(clock.ms / 1_000) });
  const audit: { events: AuditEvent[]; sink: AuditSink } = {
    events: [],
    sink: {
      stage(event) {
        audit.events.push(event);
        // As the real document sink: the row is new, or it is the same event (same digest). The same id with another time, person or reason loses.
        const digest = createHash("sha256").update(JSON.stringify(event)).digest("hex");
        return [{ kind: "put", item: { pk: `AUDIT_FAKE#${event.companyId}`, sk: event.eventId, action: event.action, digest }, condition: when.or(when.absent(), when.eq("digest", digest)) }] satisfies TransactItem[];
      },
      async record(event) { audit.events.push(event); },
    },
  };
  const tasks = new Map<string, { project: string }>();
  const reports: { orgId: OrgId; report: AfterMergeReport }[] = [];
  const starts: RevertRequest[] = [];
  const attempts: RevertRequest[] = [];
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const settingsByCompany = new Map<OrgId, WorldOptions>();
  const state = { reportFailures: 0, startFails: 0 };

  function depsFor(orgId: OrgId): AfterMergeActionDeps {
    const options = settingsByCompany.get(orgId) ?? {};
    const settingsValue = options.settings === undefined ? { enabled: true, windowMinutes: 30, environments: ["staging"], revert: "offer_revert" } : options.settings;
    return {
      store, audit: audit.sink,
      tasks: { read: async (org, taskId) => { const task = tasks.get(`${org}/${taskId}`); return task === undefined ? undefined : { taskId, orgId: org, project: task.project }; } },
      settings: settingsValue === "absent" ? undefined : { read: async (_org, project) => { if (options.settingsFor !== undefined) return options.settingsFor(project); if (settingsValue === "throws") throw new Error("settings canary-secret"); return settingsValue; } },
      reporter: { report: async (org, report) => { if (state.reportFailures > 0) { state.reportFailures -= 1; throw new Error("chat canary-secret"); } reports.push({ orgId: org, report }); } },
      now: () => new Date(clock.ms),
      log: (event, fields) => { logs.push({ event, fields }); },
      authority: { mayAct: async (_org, personId) => (options.people ?? ["person-1"]).includes(personId) },
      starter: { start: async (request) => { attempts.push(request); if (state.startFails > 0) { state.startFails -= 1; throw new Error("start canary-secret"); } starts.push(request); return { taskId: `revert-${request.taskId}` }; } },
    };
  }
  async function seedMerge(orgId: OrgId, input: { taskId: string; number: number; url: string; sha: string; project?: string; repository?: string }): Promise<void> {
    tasks.set(`${orgId}/${input.taskId}`, { project: input.project ?? PROJECT });
    const step = mergeCommitIndexStep({ orgId, repositoryFullName: input.repository ?? REPO, repositoryId: "payments", number: input.number, url: input.url, taskId: input.taskId, mergeCommit: input.sha, now: at(-minutes(5)) }, store.ttlAttribute)!;
    expect(await store.transact([step])).toEqual({ applied: true });
  }
  return {
    store, clock, audit, reports, starts, attempts, logs, tasks, state,
    deps: depsFor,
    configure(orgId: OrgId, options: WorldOptions) { settingsByCompany.set(orgId, options); },
    seedMerge,
    reportsOf: (orgId: OrgId) => reports.filter((entry) => entry.orgId === orgId).map((entry) => entry.report),
  };
}
type World = ReturnType<typeof createWorld>;

const deploy = (over: Record<string, unknown> = {}) => ({ repository: REPO, revision: SHA, environment: "staging", state: "success", source: "code_host", ...over });
const alarm = (over: Record<string, unknown> = {}): TriggerEvent => ({
  source: "cloudwatch", type: "alarm.fired", eventKey: "evt-1", occurredAt: at(minutes(5)), project: PROJECT,
  subject: { kind: "alert", id: "HighLatency", title: "High latency on checkout" }, fields: {}, actor: { kind: "unknown" }, ...over,
});
const KEY = signalKeyOf({ source: "cloudwatch", type: "alarm.fired", subjectId: "HighLatency" });
const person = (personId = "person-1") => ({ type: "person" as const, personId });

async function opened(world: World, orgId: OrgId = A, task = "task-7", number = 7, url = URL7, sha = SHA): Promise<void> {
  await world.seedMerge(orgId, { taskId: task, number, url, sha });
  const result = await observeDeployment(world.deps(orgId), orgId, deploy({ revision: sha }));
  expect(result.kind).toBe("opened");
}
const snapshot = async (world: World): Promise<unknown[]> => {
  const rows: unknown[] = [];
  for (const org of [A, B]) for (const family of ["AFTER_MERGE", "AFTER_MERGE_QUEUE"]) rows.push(...(await world.store.query({ pk: `ORG#${org}#${family}` })).items);
  return rows;
};
const rowCount = async (world: World): Promise<number> => {
  let total = 0;
  for (const org of [A, B]) for (const family of ["AFTER_MERGE", "AFTER_MERGE_QUEUE"]) total += (await world.store.query({ pk: `ORG#${org}#${family}` })).items.length;
  return total;
};

describe("the switch: off by default, and nothing runs while it is off", () => {
  it.each([
    ["no settings reader", "absent"],
    ["a reader that throws", "throws"],
    ["settings that say off", { enabled: false }],
    ["settings with no enabled flag", { windowMinutes: 30 }],
    ["enabled as a string", { enabled: "true" }],
    ["an unknown key", { enabled: true, surprise: 1 }],
    ["a window of zero", { enabled: true, windowMinutes: 0 }],
    ["a window of a fraction", { enabled: true, windowMinutes: 1.5 }],
    ["a window over a day", { enabled: true, windowMinutes: 1441 }],
    ["an unknown revert mode", { enabled: true, revert: "auto_open" }],
    ["environments that are not a list", { enabled: true, environments: "staging" }],
    ["an environment that is empty", { enabled: true, environments: [""] }],
    ["an environment with a control character", { enabled: true, environments: ["stag\ning"] }],
    ["too many environments", { enabled: true, environments: Array.from({ length: 21 }, (_, i) => `e${String(i)}`) }],
  ] as const)("is off for %s: every entry point answers off and nothing is written, sent, audited or started", async (_name, settings) => {
    const world = createWorld();
    // A watch and an alarm exist from when the project was on; then the setting changes.
    await opened(world);
    world.clock.ms = T0 + minutes(5);
    await observeSignal(world.deps(A), A, alarm());
    const before = await snapshot(world);
    const reportsBefore = world.reports.length;
    world.configure(A, { settings });
    const deps = world.deps(A);
    world.clock.ms = T0 + minutes(40);
    expect(await observeDeployment(deps, A, deploy())).toEqual({ kind: "off" });
    expect(await observeSignal(deps, A, alarm({ occurredAt: at(minutes(6)), eventKey: "again" }))).toEqual({ kind: "off" });
    expect(await closeDueWatches(deps, A)).toMatchObject({ closed: 0, delivered: 0 });
    expect(await markExpected(deps, A, { actor: person(), repository: REPO, number: 7, signalKey: KEY })).toEqual({ kind: "refused", reason: "off" });
    expect(await pressRevert(deps, A, { actor: person(), repository: REPO, number: 7 })).toEqual({ kind: "refused", reason: "off" });
    expect(await snapshot(world)).toEqual(before);
    expect(world.reports.length).toBe(reportsBefore);
    expect(world.starts).toEqual([]);
    expect(world.audit.events).toEqual([]);
    expect(JSON.stringify(world.logs)).not.toContain("canary-secret");
  });

  it("with no settings reader at all it does not even read the store", async () => {
    const world = createWorld();
    world.configure(A, { settings: "absent" });
    const reads: string[] = [];
    const spy = new Proxy(world.store, { get: (target, name) => { reads.push(String(name)); return Reflect.get(target, name) as unknown; } });
    expect(await observeDeployment({ ...world.deps(A), store: spy }, A, deploy())).toEqual({ kind: "off" });
    expect(reads.filter((name) => ["get", "getMany", "query", "queryIndex", "put", "update", "delete", "transact"].includes(name))).toEqual([]);
  });

  it("reads valid settings with their defaults", async () => {
    const read = (value: unknown) => afterMergeSettingsOf({ read: async () => value }, A, PROJECT);
    expect(await read({ enabled: true })).toEqual({ windowMinutes: 30, environments: [], revert: "report_only" });
    expect(await read({ enabled: true, windowMinutes: 45, environments: ["Staging"], revert: "offer_revert" })).toEqual({ windowMinutes: 45, environments: ["Staging"], revert: "offer_revert" });
    expect(await read({ enabled: false })).toBeUndefined();
  });

  it("is an own setting: the automations switch does not stop it", async () => {
    const world = createWorld();
    await opened(world);
    // The watcher's deps carry no automations switch at all; nothing in this module reads one.
    expect(Object.keys(world.deps(A)).sort()).toEqual(["audit", "authority", "log", "now", "reporter", "settings", "starter", "store", "tasks"]);
  });
});

describe("a deploy of a merge Rovara made opens a watch", () => {
  it("opens one watch for the merge's task and pull request, with the window from the setting", async () => {
    const world = createWorld();
    await world.seedMerge(A, { taskId: "task-7", number: 7, url: URL7, sha: SHA });
    expect(await observeDeployment(world.deps(A), A, deploy())).toEqual({ kind: "opened", windowEndsAt: at(minutes(30)) });
    const watches = (await world.store.query({ pk: `ORG#${A}#AFTER_MERGE`, sk: { op: "beginsWith", prefix: "WATCH#" } })).items;
    expect(watches).toHaveLength(1);
    expect(watches[0]).toMatchObject({ entityType: "AFTER_MERGE_WATCH", orgId: A, taskId: "task-7", repository: REPO, number: 7, url: URL7, revision: SHA, environment: "staging", state: "open", source: "code_host" });
    expect(typeof watches[0]![INDEX_EXPIRY_ATTRIBUTE]).toBe("number");
    expect(world.reports).toEqual([]);
  });

  it("answers the same deploy again with no second watch", async () => {
    const world = createWorld();
    await opened(world);
    expect(await observeDeployment(world.deps(A), A, deploy())).toEqual({ kind: "already_watched" });
    expect((await world.store.query({ pk: `ORG#${A}#AFTER_MERGE`, sk: { op: "beginsWith", prefix: "WATCH#" } })).items).toHaveLength(1);
  });

  it("ignores a revision Rovara did not merge, and says nothing about whether it exists", async () => {
    const world = createWorld();
    await world.seedMerge(A, { taskId: "task-7", number: 7, url: URL7, sha: SHA });
    const before = await rowCount(world);
    expect(await observeDeployment(world.deps(A), A, deploy({ revision: SHA2 }))).toEqual({ kind: "ignored", reason: "not_ours" });
    expect(await observeDeployment(world.deps(A), A, deploy({ repository: "acme/other" }))).toEqual({ kind: "ignored", reason: "not_ours" });
    expect(await rowCount(world)).toBe(before);
  });

  it("ignores an environment the project does not watch, without case", async () => {
    const world = createWorld();
    await world.seedMerge(A, { taskId: "task-7", number: 7, url: URL7, sha: SHA });
    expect(await observeDeployment(world.deps(A), A, deploy({ environment: "production" }))).toEqual({ kind: "ignored", reason: "environment_not_watched" });
    expect((await observeDeployment(world.deps(A), A, deploy({ environment: "STAGING" }))).kind).toBe("opened");
  });

  it("watches every environment when the project names none", async () => {
    const world = createWorld();
    world.configure(A, { settings: { enabled: true } });
    await world.seedMerge(A, { taskId: "task-7", number: 7, url: URL7, sha: SHA });
    expect((await observeDeployment(world.deps(A), A, deploy({ environment: "anything" }))).kind).toBe("opened");
  });

  it("opens no watch for a deploy still in progress", async () => {
    const world = createWorld();
    await world.seedMerge(A, { taskId: "task-7", number: 7, url: URL7, sha: SHA });
    expect(await observeDeployment(world.deps(A), A, deploy({ state: "in_progress" }))).toEqual({ kind: "ignored", reason: "in_progress" });
    expect(await rowCount(world)).toBe(0);
  });

  it("says a failed deploy once, and closes that watch at once", async () => {
    const world = createWorld();
    await world.seedMerge(A, { taskId: "task-7", number: 7, url: URL7, sha: SHA });
    expect(await observeDeployment(world.deps(A), A, deploy({ state: "failure" }))).toEqual({ kind: "deploy_failed" });
    expect(world.reportsOf(A)).toHaveLength(1);
    expect(world.reportsOf(A)[0]).toMatchObject({ kind: "deploy_failed", taskId: "task-7", repository: REPO, number: 7, environment: "staging", actions: { revert: false, expected: false } });
    expect(await observeDeployment(world.deps(A), A, deploy({ state: "failure" }))).toEqual({ kind: "already_watched" });
    expect(world.reportsOf(A)).toHaveLength(1);
  });

  it.each([
    ["a revision that is not a commit id", { revision: "main" }],
    ["a repository that is not owner/name", { repository: "payments" }],
    ["an unknown state", { state: "queued" }],
    ["an unknown source", { source: "carrier_pigeon" }],
    ["an empty environment", { environment: "" }],
    ["an environment with a line break", { environment: "stag\ning" }],
    ["an environment over 64 characters", { environment: "e".repeat(65) }],
    ["an extra field", { surprise: true }],
  ])("refuses %s with the same fixed words, and writes nothing", async (_name, over) => {
    const world = createWorld();
    await world.seedMerge(A, { taskId: "task-7", number: 7, url: URL7, sha: SHA });
    const result = await observeDeployment(world.deps(A), A, deploy(over));
    expect(result).toEqual({ kind: "ignored", reason: "invalid_fact" });
    expect(await rowCount(world)).toBe(0);
  });

  it("refuses a non-object fact and a company id that is not one", async () => {
    const world = createWorld();
    for (const value of [null, undefined, 7, "x", []]) expect(await observeDeployment(world.deps(A), A, value)).toEqual({ kind: "ignored", reason: "invalid_fact" });
    expect(await observeDeployment(world.deps(A), "not-a-company", deploy())).toEqual({ kind: "ignored", reason: "invalid_fact" });
  });

  it("answers `unavailable` (and logs a fixed code) when the store fails, never `not_ours`", async () => {
    const world = createWorld();
    await world.seedMerge(A, { taskId: "task-7", number: 7, url: URL7, sha: SHA });
    world.store.injectFault(new DocumentStoreError("unavailable", "store canary-secret down"));
    expect(await observeDeployment(world.deps(A), A, deploy())).toEqual({ kind: "unavailable" });
    expect(JSON.stringify(world.logs)).not.toContain("canary-secret");
    expect((await observeDeployment(world.deps(A), A, deploy())).kind).toBe("opened");
  });

  it("ignores a merge whose task is not in this company's tasks", async () => {
    const world = createWorld();
    await world.seedMerge(A, { taskId: "task-7", number: 7, url: URL7, sha: SHA });
    world.tasks.delete(`${A}/task-7`);
    expect(await observeDeployment(world.deps(A), A, deploy())).toEqual({ kind: "ignored", reason: "not_ours" });
  });
});

describe("an alarm inside the window is reported once", () => {
  it("records the alarm, reports it with the two offers, and does not report it twice", async () => {
    const world = createWorld();
    await opened(world);
    world.clock.ms = T0 + minutes(5);
    expect(await observeSignal(world.deps(A), A, alarm())).toEqual({ kind: "recorded", watches: 1, reported: 1, silenced: 0 });
    expect(await observeSignal(world.deps(A), A, alarm({ eventKey: "evt-2" }))).toEqual({ kind: "recorded", watches: 1, reported: 0, silenced: 0 });
    const reports = world.reportsOf(A);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ kind: "alarm", taskId: "task-7", repository: REPO, number: 7, url: URL7, environment: "staging", signalKey: KEY, actions: { revert: true, expected: true } });
    expect(reports[0]!.text).toMatch(/alarm after deploy/iu);
    expect(reports[0]!.text).toContain("High latency on checkout");
  });

  it("offers only the expected press when the project's revert mode is report_only", async () => {
    const world = createWorld();
    world.configure(A, { settings: { enabled: true, environments: ["staging"], revert: "report_only" } });
    await opened(world);
    world.clock.ms = T0 + minutes(5);
    await observeSignal(world.deps(A), A, alarm());
    expect(world.reportsOf(A)[0]!.actions).toEqual({ revert: false, expected: true });
  });

  it("reports a second, different alarm too, once each", async () => {
    const world = createWorld();
    await opened(world);
    world.clock.ms = T0 + minutes(6);
    await observeSignal(world.deps(A), A, alarm());
    await observeSignal(world.deps(A), A, alarm({ eventKey: "evt-9", subject: { kind: "alert", id: "ErrorRate", title: "Errors" } }));
    expect(world.reportsOf(A).map((report) => report.signalKey)).toEqual([KEY, signalKeyOf({ source: "cloudwatch", type: "alarm.fired", subjectId: "ErrorRate" })]);
  });

  it.each([
    ["before the deploy", -minutes(1)],
    ["after the window", minutes(31)],
  ])("ignores an alarm that happened %s", async (_name, offset) => {
    const world = createWorld();
    await opened(world);
    world.clock.ms = T0 + minutes(35);
    expect(await observeSignal(world.deps(A), A, alarm({ occurredAt: at(offset) }))).toEqual({ kind: "ignored", reason: "no_open_watch" });
    expect(world.reports).toEqual([]);
  });

  it("ignores an alarm dated in the future", async () => {
    const world = createWorld();
    await opened(world);
    world.clock.ms = T0 + minutes(5);
    expect(await observeSignal(world.deps(A), A, alarm({ occurredAt: at(minutes(25)) }))).toEqual({ kind: "ignored", reason: "no_open_watch" });
  });

  it("ignores an alarm of another project and an event that is not an alarm", async () => {
    const world = createWorld();
    await opened(world);
    world.clock.ms = T0 + minutes(5);
    expect(await observeSignal(world.deps(A), A, alarm({ project: "other-project" }))).toEqual({ kind: "ignored", reason: "no_open_watch" });
    const notAlarm = { source: "github", type: "pull_request.opened", eventKey: "e", occurredAt: at(minutes(5)), project: PROJECT, subject: { kind: "pull_request", id: "1", title: "x" }, fields: {}, actor: { kind: "external" } };
    expect(await observeSignal(world.deps(A), A, notAlarm)).toEqual({ kind: "ignored", reason: "not_an_alarm" });
    expect(await observeSignal(world.deps(A), A, { nonsense: true })).toEqual({ kind: "ignored", reason: "invalid_event" });
    expect(world.reports).toEqual([]);
  });

  it.each([
    ["cloudwatch", "alarm.fired"], ["datadog", "monitor.triggered"], ["sentry", "alert.triggered"], ["grafana", "alert.firing"], ["pagerduty", "incident.triggered"], ["vercel", "deployment.error"],
  ])("counts a %s %s event as an alarm", async (source, type) => {
    const world = createWorld();
    await opened(world);
    world.clock.ms = T0 + minutes(5);
    const result = await observeSignal(world.deps(A), A, alarm({ source, type }));
    expect(result).toMatchObject({ kind: "recorded", reported: 1 });
  });

  it("does not start a revert on its own, however many alarms there are (O13), and the offer is there to prove the path ran", async () => {
    const world = createWorld();
    await opened(world);
    world.clock.ms = T0 + minutes(5);
    await observeSignal(world.deps(A), A, alarm());
    expect(world.reportsOf(A)[0]!.actions.revert).toBe(true);
    expect(world.starts).toEqual([]);
  });

  it("neutralises an alarm's own words and an environment name in the report", async () => {
    const world = createWorld();
    world.configure(A, { settings: { enabled: true } });
    await world.seedMerge(A, { taskId: "task-7", number: 7, url: URL7, sha: SHA });
    await observeDeployment(world.deps(A), A, deploy({ environment: "stag[x](http://evil.example)@all" }));
    world.clock.ms = T0 + minutes(5);
    await observeSignal(world.deps(A), A, alarm({ subject: { kind: "alert", id: "a", title: "@everyone [click](https://evil.example) ![i](https://evil.example/x.png) #123 <!-- hide --> # heading" } }));
    const text = world.reportsOf(A)[0]!.text;
    expect(text).not.toMatch(/\]\(/u);
    expect(text).not.toMatch(/@(?!‍)/u);
    expect(text).not.toContain("<!--");
    expect(text).not.toMatch(/\n/u);
    expect(text).not.toMatch(/#\d/u);
  });

  it("takes a megabyte alarm title in bounded time (refused as not an event), and the longest allowed title in bounded words", async () => {
    const world = createWorld();
    await opened(world);
    world.clock.ms = T0 + minutes(5);
    const started = performance.now();
    expect(await observeSignal(world.deps(A), A, alarm({ subject: { kind: "alert", id: "big", title: "x".repeat(1_000_000) } }))).toEqual({ kind: "ignored", reason: "invalid_event" });
    expect(await observeSignal(world.deps(A), A, alarm({ subject: { kind: "alert", id: "big", title: "x ".repeat(150) } }))).toMatchObject({ kind: "recorded", reported: 1 });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(world.reportsOf(A)[0]!.text.length).toBeLessThan(400);
  });

  it("keeps at most ten alarms for a watch and says so once", async () => {
    const world = createWorld();
    await opened(world);
    world.clock.ms = T0 + minutes(5);
    const outcomes = [];
    for (let i = 0; i < 12; i += 1) outcomes.push(await observeSignal(world.deps(A), A, alarm({ eventKey: `e${String(i)}`, subject: { kind: "alert", id: `alarm-${String(i)}`, title: `A${String(i)}` } })));
    expect(world.reportsOf(A).filter((report) => report.kind === "alarm")).toHaveLength(10);
    expect(outcomes[11]).toMatchObject({ kind: "recorded", reported: 0, dropped: 1 });
    expect(world.logs.filter((entry) => entry.event === "after_merge.alarm_cap")).toHaveLength(1);
  });
});

describe("the window closes", () => {
  it("says healthy once when the window ends with no alarm", async () => {
    const world = createWorld();
    await opened(world);
    world.clock.ms = T0 + minutes(29);
    expect(await closeDueWatches(world.deps(A), A)).toMatchObject({ closed: 0 });
    world.clock.ms = T0 + minutes(31);
    expect(await closeDueWatches(world.deps(A), A)).toMatchObject({ closed: 1 });
    expect(await closeDueWatches(world.deps(A), A)).toMatchObject({ closed: 0 });
    expect(world.reportsOf(A)).toHaveLength(1);
    expect(world.reportsOf(A)[0]).toMatchObject({ kind: "healthy", environment: "staging", actions: { revert: false, expected: false } });
    expect(world.reportsOf(A)[0]!.text).toContain("healthy for 30 min");
    const watch = (await world.store.query({ pk: `ORG#${A}#AFTER_MERGE`, sk: { op: "beginsWith", prefix: "WATCH#" } })).items[0]!;
    expect(watch).toMatchObject({ state: "closed", outcome: "healthy" });
  });

  it("an alarm in the window means no healthy line, and the alarm is not reported again", async () => {
    const world = createWorld();
    await opened(world);
    world.clock.ms = T0 + minutes(5);
    await observeSignal(world.deps(A), A, alarm());
    world.clock.ms = T0 + minutes(31);
    await closeDueWatches(world.deps(A), A);
    expect(world.reportsOf(A).map((report) => report.kind)).toEqual(["alarm"]);
    const watch = (await world.store.query({ pk: `ORG#${A}#AFTER_MERGE`, sk: { op: "beginsWith", prefix: "WATCH#" } })).items[0]!;
    expect(watch).toMatchObject({ state: "closed", outcome: "alarm" });
  });

  it("an alarm after the window closed it is not recorded (the watch is closed)", async () => {
    const world = createWorld();
    await opened(world);
    world.clock.ms = T0 + minutes(31);
    await closeDueWatches(world.deps(A), A);
    expect(await observeSignal(world.deps(A), A, alarm({ occurredAt: at(minutes(20)) }))).toEqual({ kind: "ignored", reason: "no_open_watch" });
  });

  it("an alarm the person marked expected leaves the watch healthy", async () => {
    const world = createWorld();
    await opened(world);
    world.clock.ms = T0 + minutes(5);
    await observeSignal(world.deps(A), A, alarm());
    expect(await markExpected(world.deps(A), A, { actor: person(), repository: REPO, number: 7, signalKey: KEY })).toEqual({ kind: "recorded" });
    world.clock.ms = T0 + minutes(31);
    await closeDueWatches(world.deps(A), A);
    expect(world.reportsOf(A).map((report) => report.kind)).toEqual(["alarm", "healthy"]);
  });

  it("does nothing for a project that has since been switched off", async () => {
    const world = createWorld();
    await opened(world);
    world.configure(A, { settings: { enabled: false } });
    world.clock.ms = T0 + minutes(31);
    expect(await closeDueWatches(world.deps(A), A)).toMatchObject({ closed: 0 });
    expect(world.reports).toEqual([]);
  });

  it("sends a report that failed on the next sweep, and then not again", async () => {
    const world = createWorld();
    await opened(world);
    world.clock.ms = T0 + minutes(5);
    world.state.reportFailures = 1;
    expect(await observeSignal(world.deps(A), A, alarm())).toMatchObject({ kind: "recorded", reported: 0 });
    expect(world.reportsOf(A)).toHaveLength(0);
    expect(JSON.stringify(world.logs)).not.toContain("canary-secret");
    world.clock.ms = T0 + minutes(6);
    expect(await closeDueWatches(world.deps(A), A)).toMatchObject({ delivered: 1 });
    expect(world.reportsOf(A)).toHaveLength(1);
    expect(await closeDueWatches(world.deps(A), A)).toMatchObject({ delivered: 0 });
    expect(world.reportsOf(A)).toHaveLength(1);
  });

  it("does not send a retried alarm report once the person has marked it expected", async () => {
    const world = createWorld();
    await opened(world);
    world.clock.ms = T0 + minutes(5);
    world.state.reportFailures = 1;
    await observeSignal(world.deps(A), A, alarm());
    await markExpected(world.deps(A), A, { actor: person(), repository: REPO, number: 7, signalKey: KEY });
    await closeDueWatches(world.deps(A), A);
    expect(world.reportsOf(A)).toEqual([]);
  });

  it("gives every row an expiry so nothing stays for ever", async () => {
    const world = createWorld();
    await opened(world);
    world.clock.ms = T0 + minutes(5);
    await observeSignal(world.deps(A), A, alarm());
    await markExpected(world.deps(A), A, { actor: person(), repository: REPO, number: 7, signalKey: KEY });
    for (const family of ["AFTER_MERGE", "AFTER_MERGE_QUEUE"]) {
      for (const row of (await world.store.query({ pk: `ORG#${A}#${family}` })).items) expect(typeof row[INDEX_EXPIRY_ATTRIBUTE], row.sk).toBe("number");
    }
  });
});

describe("It's expected", () => {
  it("records the press with an optional reason, audits it in the same transaction, and silences that signal for that PR only", async () => {
    const world = createWorld();
    world.configure(A, { settings: { enabled: true } });
    await world.seedMerge(A, { taskId: "task-7", number: 7, url: URL7, sha: SHA });
    await world.seedMerge(A, { taskId: "task-8", number: 8, url: URL8, sha: SHA2 });
    for (const [sha, environment] of [[SHA, "staging"], [SHA2, "staging"]] as const) await observeDeployment(world.deps(A), A, deploy({ revision: sha, environment }));
    world.clock.ms = T0 + minutes(5);
    expect(await observeSignal(world.deps(A), A, alarm())).toMatchObject({ watches: 2, reported: 2 });
    expect(await markExpected(world.deps(A), A, { actor: person(), repository: REPO, number: 7, signalKey: KEY, reason: "Planned cache warm-up" })).toEqual({ kind: "recorded" });
    expect(world.audit.events).toHaveLength(1);
    expect(world.audit.events[0]).toMatchObject({ companyId: A, action: "after_merge.expected", actor: { type: "person", id: "person-1" }, subject: { type: "change_request", id: `${REPO}#7` } });
    expect(JSON.stringify(world.audit.events[0]!.details)).toContain("Planned cache warm-up");
    expect((await world.store.query({ pk: `AUDIT_FAKE#${A}` })).items).toHaveLength(1);
    // Both pull requests are then deployed to production. The same alarm there is silenced for PR 7 and still heard for PR 8.
    for (const sha of [SHA, SHA2]) await observeDeployment(world.deps(A), A, deploy({ revision: sha, environment: "prod" }));
    world.reports.length = 0;
    world.clock.ms = T0 + minutes(7);
    expect(await observeSignal(world.deps(A), A, alarm({ eventKey: "evt-again", occurredAt: at(minutes(7)) }))).toMatchObject({ kind: "recorded", watches: 4, reported: 1, silenced: 2 });
    expect(world.reportsOf(A).map((report) => `${String(report.number)}/${report.environment}`)).toEqual(["8/prod"]);
    // Another signal on PR 7 still alerts, in both of its environments.
    world.reports.length = 0;
    await observeSignal(world.deps(A), A, alarm({ eventKey: "evt-x", occurredAt: at(minutes(8)), subject: { kind: "alert", id: "ErrorRate", title: "Errors" } }));
    expect(world.reportsOf(A).filter((report) => report.number === 7).map((report) => report.environment).sort()).toEqual(["prod", "staging"]);
  });

  it("needs no reason", async () => {
    const world = createWorld();
    await opened(world);
    world.clock.ms = T0 + minutes(5);
    await observeSignal(world.deps(A), A, alarm());
    expect(await markExpected(world.deps(A), A, { actor: person(), repository: REPO, number: 7, signalKey: KEY })).toEqual({ kind: "recorded" });
    expect(world.audit.events[0]!.details).not.toHaveProperty("reason");
  });

  it("a second press is recorded once and audited once", async () => {
    const world = createWorld();
    await opened(world);
    world.clock.ms = T0 + minutes(5);
    await observeSignal(world.deps(A), A, alarm());
    await markExpected(world.deps(A), A, { actor: person(), repository: REPO, number: 7, signalKey: KEY, reason: "one" });
    expect(await markExpected(world.deps(A), A, { actor: person(), repository: REPO, number: 7, signalKey: KEY, reason: "two" })).toEqual({ kind: "already" });
    // The second press staged the same audit event (same id), which the failed transaction never wrote.
    expect(new Set(world.audit.events.map((event) => event.eventId)).size).toBe(1);
    expect((await world.store.query({ pk: `AUDIT_FAKE#${A}` })).items).toHaveLength(1);
    const rows = (await world.store.query({ pk: `ORG#${A}#AFTER_MERGE`, sk: { op: "beginsWith", prefix: "EXPECTED#" } })).items;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "one", personId: "person-1" });
  });

  it("refuses a person without standing, an agent, a missing pull request and a signal key that is not one", async () => {
    const world = createWorld();
    world.configure(A, { people: ["person-1"] });
    await opened(world);
    const deps = world.deps(A);
    expect(await markExpected(deps, A, { actor: person("stranger"), repository: REPO, number: 7, signalKey: KEY })).toEqual({ kind: "refused", reason: "not_allowed" });
    expect(await markExpected(deps, A, { actor: { type: "agent", personId: "person-1" }, repository: REPO, number: 7, signalKey: KEY })).toEqual({ kind: "refused", reason: "not_allowed" });
    expect(await markExpected(deps, A, { actor: person(), repository: REPO, number: 99, signalKey: KEY })).toEqual({ kind: "refused", reason: "not_found" });
    expect(await markExpected(deps, A, { actor: person(), repository: REPO, number: 7, signalKey: "nope" })).toEqual({ kind: "refused", reason: "invalid_request" });
    expect(await markExpected(deps, A, { actor: person(), repository: "payments", number: 7, signalKey: KEY })).toEqual({ kind: "refused", reason: "invalid_request" });
    expect(await markExpected(deps, A, { actor: person(), repository: REPO, number: 7.5, signalKey: KEY })).toEqual({ kind: "refused", reason: "invalid_request" });
    expect(world.audit.events).toEqual([]);
    expect(await rowCount(world)).toBe(2);
  });

  it("refuses a reason with a control character, or over 500 characters, and stores nothing", async () => {
    const world = createWorld();
    await opened(world);
    const deps = world.deps(A);
    for (const reason of ["line\nbreak", "bell\u0007", "x".repeat(501), 7 as never]) {
      expect(await markExpected(deps, A, { actor: person(), repository: REPO, number: 7, signalKey: KEY, reason })).toEqual({ kind: "refused", reason: "invalid_reason" });
    }
    expect(world.audit.events).toEqual([]);
  });

  it("the authority's failure is a no, never a pass", async () => {
    const world = createWorld();
    await opened(world);
    const deps = { ...world.deps(A), authority: { mayAct: async () => { throw new Error("canary-secret"); } } };
    expect(await markExpected(deps, A, { actor: person(), repository: REPO, number: 7, signalKey: KEY })).toEqual({ kind: "refused", reason: "not_allowed" });
  });

  it("the press and its audit commit together or not at all", async () => {
    const world = createWorld();
    await opened(world);
    world.clock.ms = T0 + minutes(5);
    await observeSignal(world.deps(A), A, alarm());
    const deps = world.deps(A);
    const failing = { ...deps, audit: { stage: () => [{ kind: "check", key: { pk: "NO", sk: "SUCH" }, condition: { op: "exists", path: ["pk"] } }] as TransactItem[], record: async () => undefined } };
    expect(await markExpected(failing, A, { actor: person(), repository: REPO, number: 7, signalKey: KEY })).toEqual({ kind: "unavailable" });
    expect((await world.store.query({ pk: `ORG#${A}#AFTER_MERGE`, sk: { op: "beginsWith", prefix: "EXPECTED#" } })).items).toEqual([]);
  });
});

describe("the revert offer", () => {
  async function alarmed(world: World): Promise<void> {
    await opened(world);
    world.clock.ms = T0 + minutes(5);
    await observeSignal(world.deps(A), A, alarm());
  }

  it("a person's press starts one revert task through the start path, once, with the merge commit", async () => {
    const world = createWorld();
    await alarmed(world);
    expect(await pressRevert(world.deps(A), A, { actor: person(), repository: REPO, number: 7 })).toEqual({ kind: "started", taskId: "revert-task-7" });
    expect(world.starts).toHaveLength(1);
    expect(world.starts[0]).toMatchObject({ orgId: A, taskId: "task-7", repository: REPO, number: 7, url: URL7, mergeCommit: SHA, requestedBy: "person-1" });
    expect(world.audit.events.map((event) => event.action)).toEqual(["after_merge.revert_requested"]);
    expect(await pressRevert(world.deps(A), A, { actor: person(), repository: REPO, number: 7 })).toEqual({ kind: "already_started", taskId: "revert-task-7" });
    expect(world.starts).toHaveLength(1);
    expect(world.audit.events).toHaveLength(1);
  });

  it("a start that failed can be pressed again, with the same request id, and starts one task", async () => {
    const world = createWorld();
    await alarmed(world);
    world.state.startFails = 1;
    expect(await pressRevert(world.deps(A), A, { actor: person(), repository: REPO, number: 7 })).toEqual({ kind: "failed" });
    expect(JSON.stringify(world.logs)).not.toContain("canary-secret");
    expect(await pressRevert(world.deps(A), A, { actor: person(), repository: REPO, number: 7 })).toEqual({ kind: "started", taskId: "revert-task-7" });
    expect(world.starts).toHaveLength(1);
    expect(world.audit.events).toHaveLength(1);
    expect(world.attempts).toHaveLength(2);
    expect(world.attempts[0]!.requestId).toMatch(/^[0-9a-f]{64}$/u);
    expect(world.attempts[1]!.requestId).toBe(world.attempts[0]!.requestId);
  });

  it("is refused while no alarm is unexpected, in report_only mode, and for a person without standing", async () => {
    const world = createWorld();
    await opened(world);
    expect(await pressRevert(world.deps(A), A, { actor: person(), repository: REPO, number: 7 })).toEqual({ kind: "refused", reason: "not_offered" });
    world.clock.ms = T0 + minutes(5);
    await observeSignal(world.deps(A), A, alarm());
    expect(await pressRevert(world.deps(A), A, { actor: person("stranger"), repository: REPO, number: 7 })).toEqual({ kind: "refused", reason: "not_allowed" });
    expect(await pressRevert(world.deps(A), A, { actor: { type: "system", personId: "person-1" }, repository: REPO, number: 7 })).toEqual({ kind: "refused", reason: "not_allowed" });
    world.configure(A, { settings: { enabled: true, environments: ["staging"], revert: "report_only" } });
    expect(await pressRevert(world.deps(A), A, { actor: person(), repository: REPO, number: 7 })).toEqual({ kind: "refused", reason: "not_offered" });
    expect(await pressRevert(world.deps(A), A, { actor: person(), repository: REPO, number: 99 })).toEqual({ kind: "refused", reason: "not_found" });
    expect(world.starts).toEqual([]);
  });

  it("an alarm the person marked expected is no longer a reason to offer the revert", async () => {
    const world = createWorld();
    await alarmed(world);
    await markExpected(world.deps(A), A, { actor: person(), repository: REPO, number: 7, signalKey: KEY });
    expect(await pressRevert(world.deps(A), A, { actor: person(), repository: REPO, number: 7 })).toEqual({ kind: "refused", reason: "not_offered" });
  });

  it("the press cannot be turned into an automatic one: the offer never reaches the starter without a person", async () => {
    const world = createWorld();
    await alarmed(world);
    world.clock.ms = T0 + minutes(40);
    await closeDueWatches(world.deps(A), A);
    expect(world.starts).toEqual([]);
  });
});

describe("two companies never touch each other's watches", () => {
  async function both(): Promise<World> {
    const world = createWorld();
    // The same repository, project, pull request number, commit and environment in both companies.
    await world.seedMerge(A, { taskId: "task-a", number: 7, url: URL7, sha: SHA });
    await world.seedMerge(B, { taskId: "task-b", number: 7, url: URL7, sha: SHA });
    return world;
  }

  it("a deploy for company A opens a watch for A only", async () => {
    const world = await both();
    expect((await observeDeployment(world.deps(A), A, deploy())).kind).toBe("opened");
    expect((await world.store.query({ pk: `ORG#${B}#AFTER_MERGE` })).items).toEqual([]);
    expect((await world.store.query({ pk: `ORG#${A}#AFTER_MERGE` })).items).toHaveLength(1);
    // Positive control: B's own deploy opens B's own, separate watch.
    expect((await observeDeployment(world.deps(B), B, deploy())).kind).toBe("opened");
    expect((await world.store.query({ pk: `ORG#${B}#AFTER_MERGE` })).items[0]).toMatchObject({ orgId: B, taskId: "task-b" });
    expect((await world.store.query({ pk: `ORG#${A}#AFTER_MERGE` })).items[0]).toMatchObject({ orgId: A, taskId: "task-a" });
  });

  it("an alarm for A never opens, extends or reports a watch on B's pull request, and B's alarm never touches A's", async () => {
    const world = await both();
    await observeDeployment(world.deps(A), A, deploy());
    await observeDeployment(world.deps(B), B, deploy());
    world.clock.ms = T0 + minutes(5);
    expect(await observeSignal(world.deps(A), A, alarm())).toMatchObject({ kind: "recorded", watches: 1, reported: 1 });
    expect(world.reportsOf(A)).toHaveLength(1);
    expect(world.reportsOf(B)).toEqual([]);
    expect((await world.store.query({ pk: `ORG#${B}#AFTER_MERGE`, sk: { op: "beginsWith", prefix: "ALARM#" } })).items).toEqual([]);
    expect(await observeSignal(world.deps(B), B, alarm({ eventKey: "b-1" }))).toMatchObject({ kind: "recorded", watches: 1, reported: 1 });
    expect(world.reportsOf(B).map((report) => report.taskId)).toEqual(["task-b"]);
    expect(world.reportsOf(A).map((report) => report.taskId)).toEqual(["task-a"]);
  });

  it("a deploy of a commit only company B merged is not A's", async () => {
    const world = createWorld();
    await world.seedMerge(B, { taskId: "task-b", number: 7, url: URL7, sha: SHA });
    expect(await observeDeployment(world.deps(A), A, deploy())).toEqual({ kind: "ignored", reason: "not_ours" });
  });

  it("B's press cannot silence A's alarm, and cannot start a revert of A's pull request", async () => {
    const world = await both();
    await observeDeployment(world.deps(A), A, deploy());
    world.clock.ms = T0 + minutes(5);
    await observeSignal(world.deps(A), A, alarm());
    // B has no watch at all: both presses find nothing.
    expect(await markExpected(world.deps(B), B, { actor: person(), repository: REPO, number: 7, signalKey: KEY })).toEqual({ kind: "refused", reason: "not_found" });
    expect(await pressRevert(world.deps(B), B, { actor: person(), repository: REPO, number: 7 })).toEqual({ kind: "refused", reason: "not_found" });
    // B has its own watch, and presses there; A's alarm is still not silenced and A's revert still not started.
    await observeDeployment(world.deps(B), B, deploy());
    world.clock.ms = T0 + minutes(6);
    await observeSignal(world.deps(B), B, alarm({ eventKey: "b-1" }));
    expect(await markExpected(world.deps(B), B, { actor: person(), repository: REPO, number: 7, signalKey: KEY })).toEqual({ kind: "recorded" });
    expect((await world.store.query({ pk: `ORG#${A}#AFTER_MERGE`, sk: { op: "beginsWith", prefix: "EXPECTED#" } })).items).toEqual([]);
    expect(await observeSignal(world.deps(A), A, alarm({ eventKey: "a-2", subject: { kind: "alert", id: "HighLatency", title: "again" } }))).toMatchObject({ silenced: 0 });
    expect(await pressRevert(world.deps(A), A, { actor: person(), repository: REPO, number: 7 })).toEqual({ kind: "started", taskId: "revert-task-a" });
    expect(world.starts.map((start) => start.orgId)).toEqual([A]);
  });

  it("the sweep of company A closes only A's watches", async () => {
    const world = await both();
    await observeDeployment(world.deps(A), A, deploy());
    await observeDeployment(world.deps(B), B, deploy());
    world.clock.ms = T0 + minutes(31);
    expect(await closeDueWatches(world.deps(A), A)).toMatchObject({ closed: 1 });
    expect(world.reportsOf(B)).toEqual([]);
    expect((await world.store.query({ pk: `ORG#${B}#AFTER_MERGE`, sk: { op: "beginsWith", prefix: "WATCH#" } })).items[0]).toMatchObject({ state: "open" });
  });

  it("a row stored under one company's key that names another company is not read", async () => {
    const world = await both();
    await observeDeployment(world.deps(A), A, deploy());
    const [row] = (await world.store.query({ pk: `ORG#${A}#AFTER_MERGE`, sk: { op: "beginsWith", prefix: "WATCH#" } })).items;
    await world.store.put({ item: { ...row!, orgId: B } });
    world.clock.ms = T0 + minutes(5);
    expect(await observeSignal(world.deps(A), A, alarm())).toEqual({ kind: "ignored", reason: "no_open_watch" });
    expect(world.reports).toEqual([]);
  });
});

describe("guards that only a race or a lying neighbour reaches", () => {
  it("a task reader that answers another company's task is not believed", async () => {
    const world = createWorld();
    await world.seedMerge(A, { taskId: "task-7", number: 7, url: URL7, sha: SHA });
    const deps = { ...world.deps(A), tasks: { read: async (_org: OrgId, taskId: string) => ({ taskId, orgId: B, project: PROJECT }) } };
    expect(await observeDeployment(deps, A, deploy())).toEqual({ kind: "ignored", reason: "not_ours" });
    const other = { ...world.deps(A), tasks: { read: async () => ({ taskId: "someone-else", orgId: A, project: PROJECT }) } };
    expect(await observeDeployment(other, A, deploy())).toEqual({ kind: "ignored", reason: "not_ours" });
  });

  it("an open watch whose own row names another project is not given the alarm", async () => {
    const world = createWorld();
    await opened(world);
    const [row] = (await world.store.query({ pk: `ORG#${A}#AFTER_MERGE`, sk: { op: "beginsWith", prefix: "WATCH#" } })).items;
    await world.store.put({ item: { ...row!, project: "another-project" } });
    world.clock.ms = T0 + minutes(5);
    expect(await observeSignal(world.deps(A), A, alarm())).toEqual({ kind: "ignored", reason: "no_open_watch" });
  });

  it("marking an alarm nobody saw is refused", async () => {
    const world = createWorld();
    await opened(world);
    expect(await markExpected(world.deps(A), A, { actor: person(), repository: REPO, number: 7, signalKey: "a".repeat(64) })).toEqual({ kind: "refused", reason: "not_found" });
    expect((await world.store.query({ pk: `ORG#${A}#AFTER_MERGE`, sk: { op: "beginsWith", prefix: "EXPECTED#" } })).items).toEqual([]);
  });

  /** A store whose first read of a key family answers "nothing there" (a read that lost a race with a writer). */
  const staleFirstRead = (world: World, prefix: string): MemoryDocumentStore => {
    let stale = true;
    return new Proxy(world.store, {
      get(target, name) {
        const value = Reflect.get(target, name, target) as unknown;
        if (name !== "get") return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        return async (key: { pk: string; sk: string }) => { if (stale && key.sk.startsWith(prefix)) { stale = false; return undefined; } return target.get(key); };
      },
    });
  };

  it("two presses of It's expected racing: the one that lost the write answers already, and one row and one audit row remain", async () => {
    const world = createWorld();
    await opened(world);
    world.clock.ms = T0 + minutes(5);
    await observeSignal(world.deps(A), A, alarm());
    expect(await markExpected(world.deps(A), A, { actor: person(), repository: REPO, number: 7, signalKey: KEY, reason: "first" })).toEqual({ kind: "recorded" });
    const racing = { ...world.deps(A), store: staleFirstRead(world, "EXPECTED#") };
    expect(await markExpected(racing, A, { actor: person(), repository: REPO, number: 7, signalKey: KEY, reason: "second" })).toEqual({ kind: "already" });
    const rows = (await world.store.query({ pk: `ORG#${A}#AFTER_MERGE`, sk: { op: "beginsWith", prefix: "EXPECTED#" } })).items;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "first" });
    expect((await world.store.query({ pk: `AUDIT_FAKE#${A}` })).items).toHaveLength(1);
  });

  it("two presses of Revert racing: the loser does not overwrite the claim and the starter is asked once under one request id", async () => {
    const world = createWorld();
    world.configure(A, { people: ["person-1", "person-2"] });
    await opened(world);
    world.clock.ms = T0 + minutes(5);
    await observeSignal(world.deps(A), A, alarm());
    world.state.startFails = 1;
    expect(await pressRevert(world.deps(A), A, { actor: person("person-1"), repository: REPO, number: 7 })).toEqual({ kind: "failed" });
    const racing = { ...world.deps(A), store: staleFirstRead(world, "REVERT#") };
    expect(await pressRevert(racing, A, { actor: person("person-2"), repository: REPO, number: 7 })).toEqual({ kind: "started", taskId: "revert-task-7" });
    const [row] = (await world.store.query({ pk: `ORG#${A}#AFTER_MERGE`, sk: { op: "beginsWith", prefix: "REVERT#" } })).items;
    expect(row).toMatchObject({ requestedBy: "person-1", state: "started" });
    expect(new Set(world.attempts.map((attempt) => attempt.requestId)).size).toBe(1);
    expect(world.starts).toHaveLength(1);
  });
});

describe("limits", () => {
  it("reads the open watches of a project within one total bound: exactly the bound works, one more is refused whole and says so", async () => {
    const world = createWorld();
    world.configure(A, { settings: { enabled: true } });
    const deps = { ...world.deps(A), limits: { openWatchesMax: 3 } };
    for (let i = 0; i < 3; i += 1) {
      const sha = i.toString(16).padStart(40, "0");
      await world.seedMerge(A, { taskId: `t${String(i)}`, number: i + 1, url: `https://github.com/acme/payments/pull/${String(i + 1)}`, sha });
      await observeDeployment(deps, A, deploy({ revision: sha, environment: "e" }));
    }
    world.clock.ms = T0 + minutes(5);
    expect(await observeSignal(deps, A, alarm())).toMatchObject({ kind: "recorded", watches: 3, reported: 3 });
    const sha = "f".repeat(40);
    await world.seedMerge(A, { taskId: "t9", number: 9, url: "https://github.com/acme/payments/pull/9", sha });
    await observeDeployment(deps, A, deploy({ revision: sha, environment: "e" }));
    world.reports.length = 0;
    expect(await observeSignal(deps, A, alarm({ eventKey: "again", subject: { kind: "alert", id: "Other", title: "Other" } }))).toEqual({ kind: "unavailable" });
    expect(world.reports).toEqual([]);
    expect(world.logs.map((entry) => entry.event)).toContain("after_merge.too_many_rows");
  });

  it("a sweep pages past due watches of switched-off projects, so they never block an enabled project", async () => {
    const world = createWorld();
    // Two project names whose open rows sort the off project first.
    const names = ["p-a", "p-b", "p-c", "p-d", "p-e", "p-f"];
    const sorted = [...names].sort((x, y) => openKey(A, x, REPO, 1, "e").sk.localeCompare(openKey(A, y, REPO, 1, "e").sk));
    const [off, on] = [sorted[0]!, sorted[sorted.length - 1]!];
    const state = { offActive: false };
    world.configure(A, { settingsFor: (project) => (project === off && state.offActive ? { enabled: false } : { enabled: true }) });
    for (let i = 0; i < 101; i += 1) {
      const sha = (i + 1).toString(16).padStart(40, "0");
      await world.seedMerge(A, { taskId: `off${String(i)}`, number: i + 1, url: `https://github.com/acme/payments/pull/${String(i + 1)}`, sha, project: off });
      await observeDeployment(world.deps(A), A, deploy({ revision: sha, environment: "e" }));
    }
    const shaOn = "a".repeat(40);
    await world.seedMerge(A, { taskId: "on1", number: 500, url: "https://github.com/acme/payments/pull/500", sha: shaOn, project: on });
    await observeDeployment(world.deps(A), A, deploy({ revision: shaOn, environment: "e" }));
    state.offActive = true;
    world.clock.ms = T0 + minutes(31);
    const swept = await closeDueWatches(world.deps(A), A);
    expect(swept.closed).toBe(1);
    expect(world.reportsOf(A).map((report) => report.taskId)).toEqual(["on1"]);
  });

  it("a report skipped while its project was off is sent once the project is on again", async () => {
    const world = createWorld();
    await opened(world);
    world.clock.ms = T0 + minutes(5);
    world.state.reportFailures = 1;
    await observeSignal(world.deps(A), A, alarm());
    world.configure(A, { settings: { enabled: false } });
    expect(await closeDueWatches(world.deps(A), A)).toMatchObject({ delivered: 0 });
    world.configure(A, {});
    world.clock.ms = T0 + minutes(6);
    expect(await closeDueWatches(world.deps(A), A)).toMatchObject({ delivered: 1 });
    expect(world.reportsOf(A)).toHaveLength(1);
  });

  it("a healthy line that could not be sent when the watch closed is sent by the next sweep, once", async () => {
    const world = createWorld();
    await opened(world);
    world.clock.ms = T0 + minutes(31);
    world.state.reportFailures = 2; // the send at close fails, and so does the retry in the same sweep
    expect(await closeDueWatches(world.deps(A), A)).toMatchObject({ closed: 1, delivered: 0 });
    expect(world.reports).toEqual([]);
    expect(await closeDueWatches(world.deps(A), A)).toMatchObject({ closed: 0, delivered: 1 });
    expect(await closeDueWatches(world.deps(A), A)).toMatchObject({ delivered: 0 });
    expect(world.reportsOf(A).map((report) => report.kind)).toEqual(["healthy"]);
  });

  it("an alarm that lands between the sweep's read and its close keeps the watch from closing as healthy", async () => {
    const world = createWorld();
    await opened(world);
    world.clock.ms = T0 + minutes(31);
    const real = world.deps(A);
    let fired = false;
    const store = new Proxy(world.store, {
      get(target, name) {
        if (name !== "query") { const value = Reflect.get(target, name, target) as unknown; return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value; }
        return async (request: { sk?: { prefix?: string } }) => {
          const page = await target.query(request as never);
          if (!fired && request.sk?.prefix?.startsWith("ALARM#") === true) { fired = true; await observeSignal(real, A, alarm({ occurredAt: at(minutes(29)) })); }
          return page;
        };
      },
    });
    // The alarm is recorded at minute 29 (inside the window) but after the sweep read the alarm rows.
    expect(await closeDueWatches({ ...real, store, now: () => new Date(T0 + minutes(31)) }, A)).toMatchObject({ closed: 0 });
    expect(world.reportsOf(A).map((report) => report.kind)).toEqual(["alarm"]);
    expect(await closeDueWatches(world.deps(A), A)).toMatchObject({ closed: 1 });
    expect(world.reportsOf(A).map((report) => report.kind)).toEqual(["alarm"]);
  });

  it("a task reader that throws gives `unavailable` and no text from the failure", async () => {
    const world = createWorld();
    await world.seedMerge(A, { taskId: "task-7", number: 7, url: URL7, sha: SHA });
    const deps = { ...world.deps(A), tasks: { read: async () => { throw new Error("host canary-secret"); } } };
    expect(await observeDeployment(deps, A, deploy())).toEqual({ kind: "unavailable" });
    expect(JSON.stringify(world.logs)).not.toContain("canary-secret");
  });

  it("a row at the right key whose own fields name another key is not read", async () => {
    const world = createWorld();
    await opened(world);
    const [row] = (await world.store.query({ pk: `ORG#${A}#AFTER_MERGE`, sk: { op: "beginsWith", prefix: "WATCH#" } })).items;
    await world.store.put({ item: { ...row!, number: 99 } });
    world.clock.ms = T0 + minutes(5);
    expect(await observeSignal(world.deps(A), A, alarm())).toEqual({ kind: "ignored", reason: "no_open_watch" });
  });

  it("a second person's retry press after a failed start is audited, and the starter keeps the first requester", async () => {
    const world = createWorld();
    world.configure(A, { people: ["person-1", "person-2"] });
    await opened(world);
    world.clock.ms = T0 + minutes(5);
    await observeSignal(world.deps(A), A, alarm());
    world.state.startFails = 1;
    expect(await pressRevert(world.deps(A), A, { actor: person("person-1"), repository: REPO, number: 7 })).toEqual({ kind: "failed" });
    expect(await pressRevert(world.deps(A), A, { actor: person("person-2"), repository: REPO, number: 7 })).toEqual({ kind: "started", taskId: "revert-task-7" });
    expect(world.starts).toHaveLength(1);
    expect(world.starts[0]!.requestedBy).toBe("person-1");
    const committed = (await world.store.query({ pk: `AUDIT_FAKE#${A}` })).items.map((row) => row["action"]).sort();
    expect(committed).toEqual(["after_merge.revert_requested", "after_merge.revert_retried"]);
  });

  it("the starter is called by a person's press and by nothing else (positive control)", async () => {
    const world = createWorld();
    await opened(world);
    world.clock.ms = T0 + minutes(5);
    await observeSignal(world.deps(A), A, alarm());
    await markExpected(world.deps(A), A, { actor: person(), repository: REPO, number: 7, signalKey: KEY });
    world.clock.ms = T0 + minutes(40);
    await closeDueWatches(world.deps(A), A);
    expect(world.starts).toEqual([]);
    await observeSignal(world.deps(A), A, alarm({ eventKey: "z", subject: { kind: "alert", id: "Other", title: "Other" }, occurredAt: at(minutes(5)) }));
    // The watch is closed, so the second alarm finds nothing; reopen a fresh watch for a real, unexpected alarm and press.
    await world.seedMerge(A, { taskId: "task-8", number: 8, url: URL8, sha: SHA2 });
    world.clock.ms = T0 + minutes(41);
    await observeDeployment(world.deps(A), A, deploy({ revision: SHA2 }));
    await observeSignal(world.deps(A), A, alarm({ eventKey: "q", occurredAt: at(minutes(42)) }));
    expect(world.starts).toEqual([]);
    expect(await pressRevert(world.deps(A), A, { actor: person(), repository: REPO, number: 8 })).toMatchObject({ kind: "started" });
    expect(world.starts).toHaveLength(1);
  });
});
