// L4-EVH (DEC 254zzz20 D5): the broker's side of the opt-in eval health run. A yes starts one claimed run; everything the yes rested on is read again first (age, the asker's live role, the approval, main); the grant a
// worker holds with comes from the request's own approved item and the install's bound adapter, never from the request's estimate; the result is kept as the baseline only after it matches the broker's own plan, once.
// Every guard has a named mutant in briefs/lead4/L4-EVH-MUTANTS-20261118.md, each broken by hand and seen to fail one of these tests.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EVAL_HEALTH_MAX_AGE_MS, EVAL_HEALTH_RUN_MAX_MS, createDocumentBaseScoreCache, evalHealthNotRunWords, type EvalBaseCacheKeyParts, type EvalBaseRecord, type EvalReservationAdapter, type Principal } from "@agentx/contracts";
import { deliverEvalHealthPlan, recordEvalHealthResult, startEvalHealthRun, type EvalHealthRunDeps } from "../../packages/broker/src/core/setup-agent/eval-health-run.js";
import { evalHealthKeyOf } from "../../packages/broker/src/core/setup-agent/eval-health-run.js";
import { evalHealthRequestKey, readEvalHealthRow, readEvalHealthView, requestEvalHealthCheck } from "../../packages/broker/src/core/setup-agent/eval-health-request.js";
import { readEvalCard } from "../../packages/broker/src/core/setup-agent/eval-card.js";
import { createEvalPlanSources } from "../../packages/broker/src/core/setup-agent/eval-plan-source.js";
import { A, B, CAP, NOW, ROLES, filesOf, company, person, project, reportOf, type Role } from "../support/eval-card-world.js";

const HEAD = "a".repeat(40);
type Audit = Parameters<EvalHealthRunDeps["audit"]>[0];

async function world(options: { roles?: Record<string, Role>; adapter?: boolean } = {}) {
  const w = company(A, options.roles ?? { ...ROLES });
  const r = await w.run(filesOf(2), reportOf(2));
  await r.approve();
  const clock = { now: NOW };
  const launched: Array<{ project: string; requestId: string; claimId: string; bases: ReadonlyArray<{ repositoryId: string; baseCommitSha: string }> }> = [];
  const audits: Audit[] = [];
  const control = { launch: true as boolean | "throw", audit: true, heads: [{ repositoryId: "web", baseCommitSha: HEAD }] as ReadonlyArray<{ repositoryId: string; baseCommitSha: string }> | undefined };
  const adapter: EvalReservationAdapter = {
    async authority(request) { return { company: request.company, project: request.project, principal: { companyId: request.company, personId: request.approver.personId, provider: request.approver.provider, displayName: "", roles: [] }, provider: "customer", connected: true }; },
    async reserve() { return undefined; },
  };
  const registry = { names: (point: string) => point === "eval-reservation" && options.adapter !== false ? ["test"] : [], get: () => adapter } as never;
  const deps = (over: Partial<EvalHealthRunDeps> = {}): EvalHealthRunDeps => ({
    store: w.store, companyId: A, now: () => clock.now, members: w.members, registry, monthlyCap: async () => CAP,
    mainHeads: async () => control.heads,
    launch: async (job) => { if (control.launch === "throw") throw new Error("boom"); launched.push(job); return control.launch; },
    audit: async (event) => { if (!control.audit) throw new Error("audit down"); audits.push(event); }, ...over,
  });
  const ask = (as: Principal = person(A, "maintainer"), body: Record<string, unknown> = {}) =>
    requestEvalHealthCheck({ store: w.store, companyId: A, now: () => clock.now, members: w.members }, project, { requestId: randomUUID(), seenCostMicros: 600_000, ...body }, as);
  const row = () => readEvalHealthRow({ store: w.store, companyId: A }, project);
  const cache = () => createDocumentBaseScoreCache(w.store, { companyId: A, now: () => clock.now });
  return { w, r, clock, launched, audits, control, adapter, deps, ask, row, cache, registry };
}
type World = Awaited<ReturnType<typeof world>>;

const record = (ids: string[] = ["q1", "q2"], over: Partial<EvalBaseRecord> = {}): EvalBaseRecord => ({
  schemaVersion: 1, runnerSchemaVersion: 1, roundKind: "check_unsealed", recordedOn: "2026-11-18", caseCount: ids.length,
  measures: [{ name: "pass", unit: "fraction", value: 0.5, direction: "up_good" }],
  questions: ids.map((id, i) => ({ id, samples: [{ pass: true, answer: "same" }, { pass: i === 0, answer: i === 0 ? "same" : "other" }, { pass: i === 0, answer: i === 0 ? "same" : "third" }] })), ...over,
});
const body = (requestId: string, claimId: string, result: unknown) => ({ requestId, claimId, result });
async function started(w: World) {
  await w.ask();
  const r = await w.row(); const outcome = await startEvalHealthRun(w.deps(), project);
  if (outcome.outcome !== "started") throw new Error(`not started: ${JSON.stringify(outcome)}`);
  return { requestId: r!.requestId, claimId: outcome.claimId };
}
const partsOf = async (w: World) => (await w.row())!.claim!.parts as unknown as EvalBaseCacheKeyParts;

describe("a health run starts only from a yes, once", () => {
  it("nothing happens without a yes: no request, an approval alone, a call again and again", async () => {
    const w = await world();
    expect(await startEvalHealthRun(w.deps(), project)).toEqual({ outcome: "nothing" });
    expect(w.launched).toEqual([]); expect(w.audits).toEqual([]); expect(await w.row()).toBeUndefined();
    expect((await readEvalHealthView({ store: w.w.store, companyId: A, members: w.w.members, now: () => w.clock.now }, project)).state).toBe("none");
  });
  it("a yes is claimed once with the broker's own claim, the main head it read and the key it will keep the result under, and handed to a worker once", async () => {
    const w = await world();
    const { requestId, claimId } = await started(w);
    expect(w.launched).toEqual([{ project, requestId, claimId, bases: [{ repositoryId: "web", baseCommitSha: HEAD }] }]);
    const row = (await w.row())!;
    expect(row).toMatchObject({ state: "running", requestId, claim: { claimId, bases: [{ repositoryId: "web", baseCommitSha: HEAD }], parts: { company: A, project, baseCommit: HEAD, hiddenSetHash: "none" } } });
    expect(evalHealthKeyOf(row)).toMatch(/^[a-f0-9]{64}$/u);
    expect(w.audits.map(a => a.action)).toEqual(["eval.health_claimed"]);
    // A repeat of the call (a timer, a retry) does nothing more.
    expect(await startEvalHealthRun(w.deps(), project)).toEqual({ outcome: "nothing" });
    expect(w.launched).toHaveLength(1);
    // The baseline's measuring mark is held while it runs, so a task that arrives meanwhile reads "measuring".
    expect(await w.cache().readMeasurement!(await partsOf(w))).toBe("measuring");
    expect((await readEvalHealthView({ store: w.w.store, companyId: A, members: w.w.members, now: () => w.clock.now }, project)).state).toBe("running");
    // Another yes while it runs is refused (one check at a time).
    await expect(w.ask()).rejects.toMatchObject({ code: "CHANGE_STALE" });
  });
  it("a yes older than a day is not run: the row says why, nothing is claimed, held or sent", async () => {
    const w = await world();
    await w.ask(); w.clock.now += EVAL_HEALTH_MAX_AGE_MS + 1;
    expect(await startEvalHealthRun(w.deps(), project)).toMatchObject({ outcome: "not_run", reason: "expired" });
    expect(w.launched).toEqual([]);
    expect(await w.row()).toMatchObject({ state: "not_run", notRun: { reason: "expired" } });
    expect((await readEvalHealthView({ store: w.w.store, companyId: A, members: w.w.members, now: () => w.clock.now }, project)).reason).toBe("expired");
    expect(evalHealthNotRunWords("expired")).toMatch(/more than a day old/u);
  });
  it("a yes one tick inside the day still runs", async () => {
    const w = await world();
    await w.ask(); w.clock.now += EVAL_HEALTH_MAX_AGE_MS;
    expect(await startEvalHealthRun(w.deps(), project)).toMatchObject({ outcome: "started" });
  });
  it("the person who asked must still be allowed to approve eval spend: their live role is read, not the one the request kept", async () => {
    const roles: Record<string, Role> = { ...ROLES, ada: { company: "admin" }, bob: { company: "member", grant: "administrator" } };
    for (const who of ["ada", "bob"]) {
      const w = await world({ roles: { ...roles } });
      await w.ask(person(A, who));
      expect((await w.row())!.requestedBy.role).toMatch(/admin|maintainer/u);
      w.w.roles[who] = who === "ada" ? { company: "member" } : undefined;
      expect(await startEvalHealthRun(w.deps(), project)).toMatchObject({ outcome: "not_run", reason: "requester_not_allowed" });
      expect(w.launched).toEqual([]); expect(await w.row()).toMatchObject({ state: "not_run" });
    }
  });
  it("the approval it was made under must still stand: an approval replaced, or its approver gone, is not a yes to spend", async () => {
    const a = await world();
    await a.ask();
    const bigger = await a.w.run(filesOf(3), reportOf(3)); await bigger.confirmOnly();
    expect(await startEvalHealthRun(a.deps(), project)).toMatchObject({ outcome: "not_run", reason: "approval_changed" });
    expect(a.launched).toEqual([]);
    const roles: Record<string, Role> = { ...ROLES, ada: { company: "admin" } };
    const b = company(A, roles); const r = await b.run(filesOf(2), reportOf(2)); await r.approve(person(A, "ada"));
    await requestEvalHealthCheck({ store: b.store, companyId: A, now: () => NOW, members: b.members }, project, { requestId: randomUUID(), seenCostMicros: 600_000 }, person(A, "admin"));
    roles["ada"] = undefined;
    const deps: EvalHealthRunDeps = { store: b.store, companyId: A, now: () => NOW, members: b.members, registry: { names: () => [], get: () => undefined } as never, mainHeads: async () => [{ repositoryId: "web", baseCommitSha: HEAD }], launch: async () => true, audit: async () => undefined };
    expect(await startEvalHealthRun(deps, project)).toMatchObject({ outcome: "not_run", reason: "approval_changed" });
  });
  it("a project whose main cannot be read is not run", async () => {
    for (const heads of [undefined, [], [{ repositoryId: "web", baseCommitSha: "nothex" }]]) {
      const w = await world(); await w.ask(); w.control.heads = heads;
      expect(await startEvalHealthRun(w.deps(), project)).toMatchObject({ outcome: "not_run", reason: "main_unreadable" });
      expect(w.launched).toEqual([]);
    }
    const w = await world(); await w.ask();
    expect(await startEvalHealthRun(w.deps({ mainHeads: async () => { throw new Error("x"); } }), project)).toMatchObject({ outcome: "not_run", reason: "main_unreadable" });
  });
  it("a main head for a repository the plan does not name is not the plan's base", async () => {
    const w = await world(); await w.ask(); w.control.heads = [{ repositoryId: "other", baseCommitSha: HEAD }, { repositoryId: "third", baseCommitSha: "b".repeat(40) }];
    expect(await startEvalHealthRun(w.deps(), project)).toMatchObject({ outcome: "not_run", reason: "main_unreadable" });
  });
  it("a baseline already being measured (a task's, or another check) is not measured twice", async () => {
    const w = await world(); await w.ask();
    // A first claim shows the key parts; its launch fails, so the mark is released. Then someone else (a task) starts measuring the same baseline.
    expect(await startEvalHealthRun(w.deps({ launch: async () => false }), project)).toMatchObject({ outcome: "not_run", reason: "could_not_start" });
    const parts = await partsOf(w);
    await w.ask();
    const held = await w.cache().startMeasurement!(parts);
    expect(held.status).toBe("started");
    expect(await startEvalHealthRun(w.deps(), project)).toMatchObject({ outcome: "not_run", reason: "already_measuring" });
    expect(w.launched).toEqual([]);
  });
  it("a baseline the project already has is shown, not measured again: nothing is run or spent", async () => {
    const w = await world();
    // Learn the key parts from a first claim, finish it with a saved baseline, then ask again.
    const first = await started(w);
    expect((await recordEvalHealthResult(w.deps(), project, body(first.requestId, first.claimId, { status: "measured", record: record() }))).outcome).toBe("finished");
    w.launched.length = 0;
    await w.ask();
    expect(await startEvalHealthRun(w.deps(), project)).toMatchObject({ outcome: "reused" });
    expect(w.launched).toEqual([]);
    expect(await w.row()).toMatchObject({ state: "finished", result: { reused: true, saved: true, questionCount: 2 } });
    expect(w.audits.map(a => a.action)).toContain("eval.health_reused");
  });
  it("a worker that could not be started: the claim ends as not run, the mark is released, nothing was spent", async () => {
    for (const mode of [false, "throw"] as const) {
      const w = await world(); await w.ask(); w.control.launch = mode;
      expect(await startEvalHealthRun(w.deps(), project)).toMatchObject({ outcome: "not_run", reason: "could_not_start" });
      expect(await w.row()).toMatchObject({ state: "not_run", notRun: { reason: "could_not_start" } });
      const parts = (await w.row())!.claim!.parts as unknown as EvalBaseCacheKeyParts;
      expect(await w.cache().readMeasurement!(parts)).toBe("idle");
    }
  });
  it("a failed audit stops the move: nothing is claimed, sent or held", async () => {
    const w = await world(); await w.ask(); w.control.audit = false;
    expect(await startEvalHealthRun(w.deps(), project)).toEqual({ outcome: "nothing" });
    expect(w.launched).toEqual([]); expect((await w.row())!.state).toBe("requested");
  });
  it("two calls at once claim once", async () => {
    const w = await world(); await w.ask();
    const results = await Promise.all([startEvalHealthRun(w.deps(), project), startEvalHealthRun(w.deps(), project), startEvalHealthRun(w.deps(), project)]);
    expect(results.filter(r => r.outcome === "started")).toHaveLength(1);
    expect(w.launched).toHaveLength(1);
  });
});

describe("a live run keeps its place and its mark", () => {
  it("no yes overwrites a run that is running, whatever approval it holds; a replaced approval does not free its place", async () => {
    const w = await world(); await started(w);
    await (await w.w.run(filesOf(2), reportOf(2, { model: "gemini-2.5-pro", modelVersion: "gemini-2.5-pro-001" }))).approve();
    await expect(w.ask()).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect((await w.row())!.state).toBe("running");
  });
  it("the run's window is shorter than the baseline's measuring mark: a task arriving at the last second of a live run still reads measuring", async () => {
    const w = await world(); await started(w);
    expect(EVAL_HEALTH_RUN_MAX_MS).toBeLessThan(60 * 60_000);
    w.clock.now += EVAL_HEALTH_RUN_MAX_MS - 1000;
    expect((await readEvalHealthView({ store: w.w.store, companyId: A, members: w.w.members, now: () => w.clock.now }, project)).state).toBe("running");
    expect(await w.cache().readMeasurement!(await partsOf(w))).toBe("measuring");
  });
});

describe("the worker's plan and grant", () => {
  it("is the request's own approved item: the grant is the item's approved estimate through the bound adapter, never the request's estimate", async () => {
    const w = await world(); const { requestId, claimId } = await started(w);
    const read = (await deliverEvalHealthPlan(w.deps(), project, { requestId, claimId }))!;
    expect(read).toBeDefined();
    const grant = (await read.approval!.read())!;
    expect(grant).toMatchObject({ company: A, project, provider: "customer", connected: true, maxCalls: 12, maxCostMicros: 600_000 });
    expect((read.plan as { key: { baseCommit: string } }).key.baseCommit).toBe(HEAD);
    // Tamper with the request's own estimate: the request is void and nothing is delivered; and the grant never followed it.
    const key = evalHealthRequestKey(A, project);
    const raw = await w.w.store.get(key);
    await w.w.store.put({ item: { ...raw!, estimateMicros: 999_999_999 } });
    expect(await deliverEvalHealthPlan(w.deps(), project, { requestId, claimId })).toBeUndefined();
  });
  it("gives no grant where no reservation adapter is bound (Code, a laptop): the worker spends nothing", async () => {
    const w = await world({ adapter: false }); const { requestId, claimId } = await started(w);
    const read = (await deliverEvalHealthPlan(w.deps(), project, { requestId, claimId }))!;
    expect(read.plan).toBeDefined();
    expect(await read.approval!.read()).toBeUndefined();
  });
  it("a re-approval between the claim and the read is no grant (the digest of the request's item is held)", async () => {
    const w = await world(); const { requestId, claimId } = await started(w);
    const read = (await deliverEvalHealthPlan(w.deps(), project, { requestId, claimId }))!;
    expect(await read.approval!.read()).toBeDefined();
    const other = await w.w.run(filesOf(2), reportOf(2, { model: "gemini-2.5-pro", modelVersion: "gemini-2.5-pro-001" }));
    await other.approve();
    // The grant read earlier is bound to the old item: it answers nothing now, and a new delivery is refused.
    expect(await read.approval!.read()).toBeUndefined();
    expect(await deliverEvalHealthPlan(w.deps(), project, { requestId, claimId })).toBeUndefined();
  });
  it("the plan source itself answers a run made under one approved item for that item only (defence in depth under the re-checks)", async () => {
    const w = await world(); const { requestId } = await started(w);
    const row = (await w.row())!;
    const sources = createEvalPlanSources({ store: w.w.store, companyId: A, registry: w.registry, members: w.w.members });
    const bases = [{ repositoryId: "web", baseCommitSha: HEAD }];
    expect(await sources.read({ companyId: A, project }, { bases, spendDigest: row.spendDigest })).toBeDefined();
    expect(await sources.read({ companyId: A, project }, { bases, spendDigest: "f".repeat(64) })).toBeUndefined();
    expect(requestId).toBe(row.requestId);
  });
  it("is refused for another request or claim, a claim that is not running, and a person who lost the right", async () => {
    const roles: Record<string, Role> = { ...ROLES, ada: { company: "admin" } };
    const w = await world({ roles });
    await w.ask(person(A, "ada"));
    const row = (await w.row())!;
    expect(await deliverEvalHealthPlan(w.deps(), project, { requestId: row.requestId, claimId: randomUUID() })).toBeUndefined();
    const outcome = await startEvalHealthRun(w.deps(), project);
    if (outcome.outcome !== "started") throw new Error("not started");
    const lease = { requestId: row.requestId, claimId: outcome.claimId };
    expect(await deliverEvalHealthPlan(w.deps(), project, { ...lease, requestId: randomUUID() })).toBeUndefined();
    expect(await deliverEvalHealthPlan(w.deps(), project, { ...lease, claimId: randomUUID() })).toBeUndefined();
    expect(await deliverEvalHealthPlan(w.deps(), project, { requestId: 5, claimId: lease.claimId })).toBeUndefined();
    expect(await deliverEvalHealthPlan(w.deps(), project, lease)).toBeDefined();
    w.w.roles["ada"] = { company: "member" };
    expect(await deliverEvalHealthPlan(w.deps(), project, lease)).toBeUndefined();
    w.w.roles["ada"] = { company: "admin" };
    expect(await deliverEvalHealthPlan(w.deps(), project, lease)).toBeDefined();
    w.clock.now += EVAL_HEALTH_RUN_MAX_MS + 1;
    expect(await deliverEvalHealthPlan(w.deps(), project, lease)).toBeUndefined();
  });
  it("is not delivered once the run ended", async () => {
    const w = await world(); const { requestId, claimId } = await started(w);
    await recordEvalHealthResult(w.deps(), project, body(requestId, claimId, { status: "not_run", reason: "stopped" }));
    expect(await deliverEvalHealthPlan(w.deps(), project, { requestId, claimId })).toBeUndefined();
  });
});

describe("the result", () => {
  it("is kept as the project's baseline under the broker's own key, and the person is told pass or fail per case", async () => {
    const w = await world(); const { requestId, claimId } = await started(w);
    const parts = await partsOf(w);
    expect(await w.cache().read(parts)).toBeUndefined();
    expect(await recordEvalHealthResult(w.deps(), project, body(requestId, claimId, { status: "measured", record: record() }))).toEqual({ outcome: "finished" });
    expect(await w.cache().read(parts)).toMatchObject({ caseCount: 2, questions: [{ id: "q1" }, { id: "q2" }] });
    expect(await w.row()).toMatchObject({ state: "finished", result: { questionCount: 2, passedAnswers: 4, totalAnswers: 6, differing: 1, saved: true, reused: false, cases: [{ id: "q1", passes: 3 }, { id: "q2", passes: 1 }] } });
    expect(await w.cache().readMeasurement!(parts)).toBe("idle");
    expect(w.audits.map(a => a.action)).toEqual(["eval.health_claimed", "eval.health_finished"]);
    // The card shows it.
    const card = await readEvalCard({ store: w.w.store, companyId: A, members: w.w.members, monthlyCap: async () => CAP, healthRuns: true, now: () => w.clock.now }, project, person(A, "admin"));
    expect(card.health).toMatchObject({ state: "finished", result: { questionCount: 2, cases: [{ id: "q1", passes: 3 }, { id: "q2", passes: 1 }] } });
  });
  it("is taken once: the same result again is a duplicate, another after it changes nothing", async () => {
    const w = await world(); const { requestId, claimId } = await started(w);
    const first = body(requestId, claimId, { status: "measured", record: record() });
    expect((await recordEvalHealthResult(w.deps(), project, first)).outcome).toBe("finished");
    const stored = await w.row();
    expect((await recordEvalHealthResult(w.deps(), project, first)).outcome).toBe("duplicate");
    expect((await recordEvalHealthResult(w.deps(), project, body(requestId, claimId, { status: "not_run", reason: "stopped" }))).outcome).toBe("duplicate");
    expect(await w.row()).toEqual(stored);
  });
  it("a claim of another request, or another claim, is refused and keeps nothing", async () => {
    const w = await world(); const { requestId, claimId } = await started(w);
    for (const bad of [body(randomUUID(), claimId, { status: "measured", record: record() }), body(requestId, randomUUID(), { status: "measured", record: record() })]) {
      expect((await recordEvalHealthResult(w.deps(), project, bad)).outcome).toBe("refused");
    }
    expect(await w.cache().read(await partsOf(w))).toBeUndefined(); expect((await w.row())!.state).toBe("running");
  });
  it("is checked against the broker's own plan: wrong, missing, extra or repeated questions, wrong sample counts and a wrong case count keep nothing", async () => {
    const bad: Array<[string, unknown]> = [
      ["other ids", record(["q1", "zz"])], ["missing", record(["q1"])], ["extra", record(["q1", "q2", "q3"])], ["case count", record(["q1", "q2"], { caseCount: 9 })],
      ["no questions", { ...record(), questions: undefined }],
    ];
    for (const [label, rec] of bad) {
      const w = await world(); const { requestId, claimId } = await started(w);
      const outcome = await recordEvalHealthResult(w.deps(), project, body(requestId, claimId, { status: "measured", record: rec }));
      expect(outcome.outcome, label).toBe("not_run");
      expect(await w.row(), label).toMatchObject({ state: "not_run", notRun: { reason: "invalid_results" } });
      expect(await w.cache().read(await partsOf(w)), label).toBeUndefined();
      expect(await w.cache().readMeasurement!(await partsOf(w)), label).toBe("idle");
    }
  });
  it("a result that repeats a question is not even a result the contract reads", async () => {
    const w = await world(); const { requestId, claimId } = await started(w);
    expect((await recordEvalHealthResult(w.deps(), project, body(requestId, claimId, { status: "measured", record: record(["q1", "q1"]) }))).outcome).toBe("refused");
    expect((await w.row())!.state).toBe("running");
  });
  it("cannot carry its own key, company, project, cost or extra fields: the body is exactly the contract", async () => {
    const w = await world(); const { requestId, claimId } = await started(w);
    const parts = await partsOf(w);
    const good = body(requestId, claimId, { status: "measured", record: record() });
    for (const bad of [{ ...good, parts: { ...parts, baseCommit: "b".repeat(40) } }, { ...good, company: B }, { ...good, project: "other" }, { ...good, costMicros: 1 }, { ...good, result: { status: "measured", record: record(), key: "x".repeat(64) } }, { ...good, result: { status: "not_run", reason: "expired" } }, "text", null, []]) {
      expect((await recordEvalHealthResult(w.deps(), project, bad)).outcome).toBe("refused");
    }
    expect(await w.cache().read(parts)).toBeUndefined(); expect((await w.row())!.state).toBe("running");
  });
  it("a worker can say why it did not run (a closed reason) and the run ends; the broker's own reasons are not a worker's to say", async () => {
    const w = await world(); const { requestId, claimId } = await started(w);
    expect((await recordEvalHealthResult(w.deps(), project, body(requestId, claimId, { status: "not_run", reason: "monthly_cap" }))).outcome).toBe("not_run");
    expect(await w.row()).toMatchObject({ state: "not_run", notRun: { reason: "monthly_cap" } });
    expect(await w.cache().readMeasurement!(await partsOf(w))).toBe("idle");
    expect(evalHealthNotRunWords("monthly_cap")).toMatch(/monthly AI spending limit/u);
  });
  it("is not taken after the window, or when the approval changed while it ran (the numbers were for another plan)", async () => {
    const late = await world(); const a = await started(late);
    late.clock.now += EVAL_HEALTH_RUN_MAX_MS + 1;
    expect((await recordEvalHealthResult(late.deps(), project, body(a.requestId, a.claimId, { status: "measured", record: record() }))).outcome).toBe("refused");
    expect(await late.cache().read(await partsOf(late))).toBeUndefined();
    expect((await readEvalHealthView({ store: late.w.store, companyId: A, members: late.w.members, now: () => late.clock.now }, project))).toMatchObject({ state: "not_run", reason: "no_report" });
    // A new yes is allowed after a run that never reported.
    await expect(late.ask()).resolves.toMatchObject({ requested: true, duplicate: false });
    const moved = await world(); const b = await started(moved);
    const other = await moved.w.run(filesOf(3), reportOf(3)); await other.confirmOnly();
    expect((await recordEvalHealthResult(moved.deps(), project, body(b.requestId, b.claimId, { status: "measured", record: record() }))).outcome).toBe("not_run");
    expect(await moved.row()).toMatchObject({ state: "not_run", notRun: { reason: "approval_changed" } });
    expect(await moved.cache().read(await partsOf(moved))).toBeUndefined();
  });
  it("a baseline too large to keep is shown as measured, not saved", async () => {
    const w = await world(); const { requestId, claimId } = await started(w);
    const big = record(["q1", "q2"]); for (const q of big.questions!) q.samples = q.samples.map(s => ({ ...s, answer: "x".repeat(200_000) }));
    expect((await recordEvalHealthResult(w.deps(), project, body(requestId, claimId, { status: "measured", record: big }))).outcome).toBe("finished");
    expect(await w.row()).toMatchObject({ state: "finished", result: { saved: false, reused: false } });
    expect(await w.cache().read(await partsOf(w))).toBeUndefined();
  });
  it("a failed audit keeps nothing (no baseline either) and leaves the run waiting for the result again", async () => {
    const w = await world(); const { requestId, claimId } = await started(w);
    w.control.audit = false;
    expect((await recordEvalHealthResult(w.deps(), project, body(requestId, claimId, { status: "measured", record: record() }))).outcome).toBe("refused");
    expect((await w.row())!.state).toBe("running");
    expect(await w.cache().read(await partsOf(w))).toBeUndefined();
    w.control.audit = true;
    expect((await recordEvalHealthResult(w.deps(), project, body(requestId, claimId, { status: "measured", record: record() }))).outcome).toBe("finished");
  });
  it("tells the person only pass counts and inert case names, never an answer", async () => {
    const w = await world(); const { requestId, claimId } = await started(w);
    const rec = record(["q1", "q2"]); rec.questions![0]!.samples[0]!.answer = "SECRET-ANSWER";
    await recordEvalHealthResult(w.deps(), project, body(requestId, claimId, { status: "measured", record: rec }));
    expect(JSON.stringify((await w.row())!.result)).not.toContain("SECRET-ANSWER");
  });
});

describe("two companies", () => {
  it("another company's runner sees none of this company's request, plan or claim, and writes nothing into its cache", async () => {
    const w = await world(); const { requestId, claimId } = await started(w);
    const other = company(B, { ...ROLES }, w.w.store);
    const deps = (over: Partial<EvalHealthRunDeps> = {}): EvalHealthRunDeps => ({ ...w.deps(), companyId: B, members: other.members, ...over });
    expect(await startEvalHealthRun(deps(), project)).toEqual({ outcome: "nothing" });
    expect(await deliverEvalHealthPlan(deps(), project, { requestId, claimId })).toBeUndefined();
    expect((await recordEvalHealthResult(deps(), project, body(requestId, claimId, { status: "measured", record: record() }))).outcome).toBe("refused");
    expect(await createDocumentBaseScoreCache(w.w.store, { companyId: B }).read(await partsOf(w))).toBeUndefined();
    expect(await w.cache().read(await partsOf(w))).toBeUndefined();
    expect((await w.row())!.state).toBe("running");
    // And this company's own run still completes.
    expect((await recordEvalHealthResult(w.deps(), project, body(requestId, claimId, { status: "measured", record: record() }))).outcome).toBe("finished");
    expect(await createDocumentBaseScoreCache(w.w.store, { companyId: B }).read(await partsOf(w))).toBeUndefined();
  });
  it("a request row planted with another company's name is not read", async () => {
    const w = await world(); await w.ask();
    const key = evalHealthRequestKey(A, project); const raw = await w.w.store.get(key);
    await w.w.store.put({ item: { ...raw!, company: B } });
    expect(await w.row()).toBeUndefined();
    expect(await startEvalHealthRun(w.deps(), project)).toEqual({ outcome: "nothing" });
  });
});
