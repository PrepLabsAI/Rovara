// The hourly resume of unfinished lesson deletions and the nightly re-reflection of reverted tasks, from the record's `rovara.reverted_by` link rows of the last 72 hours.
import { describe, expect, it, vi } from "vitest";
import type { CounterDeps } from "../../../packages/broker/src/lessons/counters.js";
import { REVERT_WINDOW_MS, lessonsExpireJob, lessonsNightlyJob, lessonsPromoteJob, lessonsResumeJob, lessonsRevertJob, lessonsTrialRepairJob, MAX_TRIAL_REPAIR_CHECKS, type LessonsJobDeps } from "../../../packages/broker/src/lessons/jobs.js";
import { PENDING_GRACE_MS, projectHash, documentNightlyState, type NightlyPass, type NightlyPassState, type NightlyStateStore } from "../../../packages/broker/src/lessons/nightly-state.js";
import { sweepExpired } from "../../../packages/broker/src/lessons/expiry.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { TRIAL_APPROVER, TRIAL_STABLE_AFTER_DAYS } from "../../../packages/broker/src/lessons/trial.js";
import type { Lesson } from "../../../packages/broker/src/lessons/types.js";
import type { RevertedTasksReader } from "../../../packages/broker/src/lessons/task-outcome-rows.js";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import { Audit, settings, lessonRecord, seed, REFUSING_JUDGE } from "./lesson-helpers.js";

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa";
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb";
const NOW = Date.parse("2026-11-08T03:17:00.000Z");
/** An in-memory nightly state, with the given projects already "seen" last night (so no grace window is open for them). */
function memoryState(seen: readonly string[] = [], org: string = ORG_A): NightlyStateStore & { saved: Map<NightlyPass, NightlyPassState> } {
  const saved = new Map<NightlyPass, NightlyPassState>();
  const fresh = (): NightlyPassState => ({ next: 0, projects: Object.fromEntries(seen.map((project) => [projectHash(org, project), { seenAt: NOW - 3_600_000 }])) });
  return { saved, read: async (_org, pass) => structuredClone(saved.get(pass) ?? fresh()), write: async (_org, pass, state) => { saved.set(pass, structuredClone(state)); } };
}
const hoursAgo = (hours: number): string => new Date(NOW - hours * 3_600_000).toISOString();
/** The world the jobs run in: a document store, and a reader of the tasks reverted lately (the order of its answer is the reader's own). */
interface World { store: MemoryDocumentStore; reverts: RevertedTasksReader; revert(taskId: string, at: string, project?: string, org?: string): void }
async function setup(): Promise<World> {
  const rows: Array<{ org: string; project: string; taskId: string; at: number }> = [];
  return {
    store: new MemoryDocumentStore(),
    revert(taskId, at, project = "web", org = ORG_A) { rows.push({ org, project, taskId, at: Date.parse(at) }); },
    reverts: { async since(org, project, sinceMs) { return { taskIds: rows.filter((row) => row.org === org && row.project === project && row.at >= sinceMs).sort((a, b) => a.at - b.at).map((row) => row.taskId), truncated: false }; } },
  };
}

function jobDeps(w: World, over: Partial<LessonsJobDeps> = {}) {
  const sent: unknown[] = [];
  const logs: string[] = [];
  const deps: LessonsJobDeps = {
    store: w.store, reverts: w.reverts, settings: settings({ mode: "On" }), queue: { send: async (m) => { sent.push(m); } }, resume: async () => ({ finished: 0, failed: 0 }),
    now: () => NOW, newRequestId: () => "nightly-1", log: (event) => logs.push(event), ...over,
  };
  return { deps, sent, logs };
}

describe("the nightly re-reflection", () => {
  it("sends {outcome: reverted} per reverted task of the window to the same queue as a task's end: ids only, and the company is the job's, never a row's claim", async () => {
    const w = await setup();
    w.revert("task-a", hoursAgo(3));
    w.revert("task-b", hoursAgo(20));
    const { deps, sent } = jobDeps(w);
    expect(await lessonsRevertJob(deps, ORG_A, ["web"], 10_000)).toMatchObject({ revertsEnqueued: 2, revertFailures: 0 });
    expect((sent as Array<{ taskId: string }>).slice().sort((a, b) => a.taskId.localeCompare(b.taskId))).toEqual([
      { orgId: ORG_A, taskId: "task-a", outcome: "reverted", requestId: "nightly-1" },
      { orgId: ORG_A, taskId: "task-b", outcome: "reverted", requestId: "nightly-1" },
    ]);
  });
  it("the window is 72 hours (a row ingested late, up to GitHub's three days of redelivery, is still found; the worker's once-claim makes a repeat free), so a 60-hour-old revert is sent and an 80-hour-old one is not", async () => {
    expect(REVERT_WINDOW_MS).toBe(72 * 3_600_000);
    const w = await setup();
    w.revert("task-late", hoursAgo(60));
    w.revert("task-stale", hoursAgo(80));
    const { deps, sent } = jobDeps(w);
    expect(await lessonsRevertJob(deps, ORG_A, ["web"], 10_000)).toMatchObject({ revertsEnqueued: 1 });
    expect((sent as Array<{ taskId: string }>).map((m) => m.taskId)).toEqual(["task-late"]);
  });
  it("more reverts than one project may send in a night is said in one fixed line (the project as a hash) and counted, and the first 100 still go", async () => {
    const w = await setup();
    for (let i = 0; i < 103; i += 1) w.revert(`task-${String(i).padStart(3, "0")}`, hoursAgo(1 + i / 100));
    const logs: Array<[string, Record<string, string | number>]> = [];
    const { deps, sent } = jobDeps(w, { log: (event, fields) => logs.push([event, fields]) });
    expect(await lessonsRevertJob(deps, ORG_A, ["web"], 10_000)).toMatchObject({ revertsEnqueued: 100, revertsCapped: 1 });
    expect(sent).toHaveLength(100);
    // the cap cuts the middle of the window, not one end: the newest and the oldest revert both go
        expect(logs).toHaveLength(1);
    expect(logs[0]![0]).toBe("lessons_job.reverts_capped");
    expect(JSON.stringify(logs)).not.toMatch(/web|org_|task-/u);
    expect(logs[0]![1]["project"]).toMatch(/^[0-9a-f]{12}$/u);
  });
  it("a project whose learning is Off or Collect sends nothing; no queue sends nothing; one enqueue failure is counted and the rest go on", async () => {
    const w = await setup();
    w.revert("task-a", hoursAgo(3));
    w.revert("task-b", hoursAgo(4));
    for (const mode of ["Off", "Collect"] as const) {
      const off = jobDeps(w, { settings: settings({ mode }) });
      expect(await lessonsRevertJob(off.deps, ORG_A, ["web"], 10_000)).toMatchObject({ revertsEnqueued: 0 });
      expect(off.sent).toEqual([]);
    }
    expect(await lessonsRevertJob(jobDeps(w, { queue: undefined }).deps, ORG_A, ["web"], 10_000)).toEqual({ revertsEnqueued: 0 });
    let first = true;
    const flaky = jobDeps(w, { queue: { send: async (m) => { if (first) { first = false; throw new Error("secret"); } flaky.sent.push(m); } } });
    const result = await lessonsRevertJob(flaky.deps, ORG_A, ["web"], 10_000);
    expect(result).toMatchObject({ revertsEnqueued: 1, revertFailures: 1 });
    expect(flaky.logs).toEqual(["lessons_job.enqueue_failed"]);
  });
  it("says in one fixed line (the project as a hash) when a project's window was cut off by the reader's limit", async () => {
    const w = await setup();
    w.revert("task-a", hoursAgo(3));
    const logs: Array<[string, Record<string, string | number>]> = [];
    const limited = jobDeps(w, { log: (event, fields) => logs.push([event, fields]), reverts: { async since() { return { taskIds: [], truncated: true }; } } });
    expect(await lessonsRevertJob(limited.deps, ORG_A, ["web"], 10_000)).toMatchObject({ revertWindowsTruncated: 1 });
    expect(logs).toHaveLength(1);
    expect(logs[0]![0]).toBe("lessons_job.revert_window_truncated");
    expect(JSON.stringify(logs)).not.toMatch(/web|org_/u);
    expect(logs[0]![1]["project"]).toMatch(/^[0-9a-f]{12}$/u);
  });
  it("asks the reader for the 72-hour window of the job's own company and project, and sends nothing where there is no reader", async () => {
    const w = await setup();
    const asked: Array<[string, string, number]> = [];
    const { deps } = jobDeps(w, { reverts: { async since(org, project, sinceMs) { asked.push([org, project, sinceMs]); return { taskIds: [], truncated: false }; } } });
    await lessonsRevertJob(deps, ORG_A, ["web"], 10_000);
    expect(asked).toEqual([[ORG_A, "web", NOW - REVERT_WINDOW_MS]]);
    expect(await lessonsRevertJob(jobDeps(w, { reverts: undefined }).deps, ORG_A, ["web"], 10_000)).toEqual({ revertsEnqueued: 0 });
  });
  it("is bounded in time: with no time left no project is looked at", async () => {
    const w = await setup();
    w.revert("task-a", hoursAgo(3));
    let clock = NOW;
    const late = jobDeps(w, { now: () => (clock += 20_000) });
    expect(await lessonsRevertJob(late.deps, ORG_A, ["web"], 10_000)).toMatchObject({ revertsEnqueued: 0 });
  });
});

describe("the hourly resume of unfinished lesson deletions", () => {
  it("resumes every project of the company whatever its learning mode (an erase must finish), counting what it finished", async () => {
    const w = await setup();
    const resume = vi.fn(async (_org: string, project: string) => ({ finished: project === "web" ? 2 : 0, failed: 0 }));
    const { deps } = jobDeps(w, { resume, settings: settings({ mode: "Off" }) });
    expect(await lessonsResumeJob(deps, ORG_A, ["web", "api"], 10_000)).toEqual({ lessonDeletionsResumed: 2, lessonResumeFailures: 0, lessonResumeSkipped: 0 });
    expect(resume.mock.calls).toEqual([[ORG_A, "web"], [ORG_A, "api"]]);
  });
  it("one project failing is a fixed log line and the others still run", async () => {
    const w = await setup();
    const logs: string[] = [];
    const { deps } = jobDeps(w, { resume: async (_org, project) => { if (project === "web") throw new Error("secret"); return { finished: 1, failed: 0 }; }, log: (event) => logs.push(event) });
    expect(await lessonsResumeJob(deps, ORG_A, ["web", "api"], 10_000)).toEqual({ lessonDeletionsResumed: 1, lessonResumeFailures: 1, lessonResumeSkipped: 0 });
    expect(logs).toEqual(["lessons_job.resume_failed"]);
  });
  it("an intent that fails is counted, and the rest of that project's intents were still tried (the counts come from the port, not from a throw)", async () => {
    const w = await setup();
    const logs: Array<[string, Record<string, string | number>]> = [];
    const { deps } = jobDeps(w, { resume: async () => ({ finished: 2, failed: 1 }), log: (event, fields) => logs.push([event, fields]) });
    expect(await lessonsResumeJob(deps, ORG_A, ["web"], 10_000)).toEqual({ lessonDeletionsResumed: 2, lessonResumeFailures: 1, lessonResumeSkipped: 0 });
    expect(logs).toEqual([["lessons_job.resume_failed", { intents: 1 }]]);
  });
});

describe("The hourly job lists stuck rollback intents (count only)", () => {
  it("counts the projects whose staged rollback did not finish, says so in one fixed line without any id, and reports the count for the Health page", async () => {
    const w = await setup();
    const logs: Array<[string, Record<string, string | number>]> = [];
    const reported: Array<[string, number]> = [];
    const { deps } = jobDeps(w, { log: (event, fields) => logs.push([event, fields]) });
    const asked: string[] = [];
    const answer = await lessonsResumeJob({ ...deps, stuckRollbacks: async (org, project) => { asked.push(`${org}/${project}`); return project !== "api"; }, reportStuck: async (org, count) => { reported.push([org, count]); } }, ORG_A, ["web", "api", "docs"], 10_000);
    expect(answer).toMatchObject({ lessonRollbacksStuck: 2, lessonStuckCheckFailures: 0 });
    expect(asked).toEqual([`${ORG_A}/web`, `${ORG_A}/api`, `${ORG_A}/docs`]);
    expect(reported).toEqual([[ORG_A, 2]]);
    expect(logs).toEqual([["lessons_job.rollbacks_stuck", { projects: 2 }]]);
  });
  it("nothing stuck is reported as zero (so a mended one clears the Health line); the deletion resume is unaffected", async () => {
    const w = await setup();
    const reported: number[] = [];
    const { deps } = jobDeps(w, { resume: async () => ({ finished: 1, failed: 0 }) });
    const answer = await lessonsResumeJob({ ...deps, stuckRollbacks: async () => false, reportStuck: async (_org, count) => { reported.push(count); } }, ORG_A, ["web"], 10_000);
    expect(answer).toMatchObject({ lessonDeletionsResumed: 1, lessonRollbacksStuck: 0 });
    expect(reported).toEqual([0]);
  });
  it("a look that fails is counted and keeps the project's state unknown: a zero is NOT reported (it could hide a stuck one), but a positive count still is", async () => {
    const w = await setup();
    const reported: number[] = [];
    const { deps } = jobDeps(w);
    const failing = await lessonsResumeJob({ ...deps, stuckRollbacks: async () => { throw new Error("secret"); }, reportStuck: async (_org, count) => { reported.push(count); } }, ORG_A, ["web"], 10_000);
    expect(failing).toMatchObject({ lessonRollbacksStuck: 0, lessonStuckCheckFailures: 1 });
    expect(reported).toEqual([]);
    const mixed = await lessonsResumeJob({ ...deps, stuckRollbacks: async (_org, project) => { if (project === "web") throw new Error("secret"); return true; }, reportStuck: async (_org, count) => { reported.push(count); } }, ORG_A, ["web", "api"], 10_000);
    expect(mixed).toMatchObject({ lessonRollbacksStuck: 1, lessonStuckCheckFailures: 1 });
    expect(reported).toEqual([1]);
  });
  it("projects the budget cut off are not looked at, so a zero is not reported either", async () => {
    const w = await setup();
    const reported: number[] = [];
    let clock = NOW;
    const { deps } = jobDeps(w, { now: () => (clock += 20_000) });
    const answer = await lessonsResumeJob({ ...deps, stuckRollbacks: async () => false, reportStuck: async (_org, count) => { reported.push(count); } }, ORG_A, ["web"], 10_000);
    expect(answer).toMatchObject({ lessonResumeSkipped: 1, lessonRollbacksStuck: 0 });
    expect(reported).toEqual([]);
  });
  it("without the look (a harness) the job's answer is what it was", async () => {
    const w = await setup();
    const { deps } = jobDeps(w);
    expect(await lessonsResumeJob(deps, ORG_A, ["web"], 10_000)).toEqual({ lessonDeletionsResumed: 0, lessonResumeFailures: 0, lessonResumeSkipped: 0 });
  });
});

describe("a trial lesson a member's card contradicts is retired by the nightly repair", () => {
  const KEYW = { workspaceId: ORG_A, project: "web" };
  const trialOld = (over: Partial<Lesson> = {}): Lesson => lessonRecord({
    id: "les_old1", workspaceId: ORG_A, project: "web", tier: 1, status: "active", approvals: [{ approvalId: "t1", by: TRIAL_APPROVER, at: 1, mode: "trial" }], trial: { state: "trial", startedAt: NOW - DAY }, ...over,
  });
  const card = (over: Partial<Lesson> = {}, member = true): Lesson => lessonRecord({
    id: "les_card1", workspaceId: ORG_A, project: "web", status: "pending", contradictsWith: "les_old1", tierReasons: ["contradiction"],
    provenance: { ...lessonRecord().provenance, memberCorrection: member }, ...over,
  });
  async function repair(lessons: Lesson[], over: Partial<LessonsJobDeps> = {}) {
    const w = await setup();
    const store = new InMemoryLessonStore();
    await seed(store, ...lessons);
    const audit = new Audit();
    const { deps, logs } = jobDeps(w, { settings: settings({ mode: "On", preset: "standard" }), queue: undefined, maintain: { store, audit, now: () => NOW }, ...over });
    return { deps, store, audit, logs };
  }
  const DAY = 86_400_000;

  it("retires the live trial lesson (audited as the contradicted trial retire) and leaves the card for the person; a second night changes nothing", async () => {
    const { deps, store, audit } = await repair([trialOld(), card()]);
    expect(await lessonsTrialRepairJob(deps, ORG_A, ["web"], 10_000)).toMatchObject({ trialsRetiredByCard: 1, trialRepairFailures: 0 });
    expect((await store.get(KEYW, "les_old1"))!.status).toBe("retired");
    expect((await store.get(KEYW, "les_card1"))!.status).toBe("pending");
    expect(audit.events.find((event) => event.action === "lesson.trial_retired")).toMatchObject({ lessonId: "les_old1", facts: { reason: "contradicted" } });
    expect(await lessonsTrialRepairJob(deps, ORG_A, ["web"], 10_000)).toMatchObject({ trialsRetiredByCard: 0 });
    expect(audit.events.filter((event) => event.action === "lesson.trial_retired")).toHaveLength(1);
  });
  it("a card across the repo-only line (a repo-only card against a lesson that is not, or the reverse) is for a person: the nightly repair retires nothing, as curate does not; a card on the same side still retires", async () => {
    const only = { ...lessonRecord().provenance, memberCorrection: true, repoOnly: { place: "github:repo/1001" } };
    const across = await repair([trialOld(), card({ provenance: only })]);
    expect(await lessonsTrialRepairJob(across.deps, ORG_A, ["web"], 10_000)).toMatchObject({ trialsRetiredByCard: 0 });
    expect((await across.store.get(KEYW, "les_old1"))!.status).toBe("active");
    const reverse = await repair([trialOld({ provenance: { ...lessonRecord().provenance, repoOnly: { place: "github:repo/1001" } } }), card()]);
    expect(await lessonsTrialRepairJob(reverse.deps, ORG_A, ["web"], 10_000)).toMatchObject({ trialsRetiredByCard: 0 });
    expect((await reverse.store.get(KEYW, "les_old1"))!.status).toBe("active");
    const same = await repair([trialOld({ provenance: { ...lessonRecord().provenance, repoOnly: { place: "github:repo/1001" } } }), card({ provenance: only })]);
    expect(await lessonsTrialRepairJob(same.deps, ORG_A, ["web"], 10_000)).toMatchObject({ trialsRetiredByCard: 1 });
  });
  it("only the rule curate applies: a card that is not from a member's correction, a lesson that is not live on trial, a card that is not pending, or a card naming nothing leaves everything as it was", async () => {
    for (const lessons of [
      [trialOld(), card({}, false)],
      [trialOld({ status: "retired" }), card()],
      [trialOld({ trial: undefined, approvals: [{ approvalId: "p1", by: "ann", at: 1, mode: "one" }] }), card()],
      [trialOld(), card({ status: "rejected" })],
      [trialOld(), card({ contradictsWith: undefined })],
    ] as Lesson[][]) {
      const { deps, store, audit } = await repair(lessons);
      expect(await lessonsTrialRepairJob(deps, ORG_A, ["web"], 10_000)).toMatchObject({ trialsRetiredByCard: 0 });
      expect((await store.get(KEYW, "les_old1"))!.status).toBe(lessons[0]!.status);
      expect(audit.events.filter((event) => event.action === "lesson.trial_retired")).toEqual([]);
    }
  });
  it("runs only where learning is on, runs before the promotion in the nightly run (a contradicted lesson is not made stable first), and is bounded per project", async () => {
    const off = await repair([trialOld(), card()], { settings: settings({ mode: "Off" }) });
    expect(await lessonsTrialRepairJob(off.deps, ORG_A, ["web"], 10_000)).toMatchObject({ trialsRetiredByCard: 0 });
    expect((await off.store.get(KEYW, "les_old1"))!.status).toBe("active");
    // ripe for stable (14 days, 3 loads) AND contradicted by a card: the nightly run retires it, it is not promoted
    const ripe = await repair([trialOld({ trial: { state: "trial", startedAt: NOW - 15 * DAY }, counters: { loaded: 5, helpful: 0, harmful: 0, citationStale: 0 } }), card()]);
    expect(await lessonsNightlyJob(ripe.deps, ORG_A, ["web"], 10_000)).toMatchObject({ trialsRetiredByCard: 1, trialsPromoted: 0 });
    expect((await ripe.store.get(KEYW, "les_old1"))!.status).toBe("retired");
    const many = await repair([...Array.from({ length: 25 }, (_, i) => trialOld({ id: `les_t${String(i).padStart(2, "0")}` })), ...Array.from({ length: 25 }, (_, i) => card({ id: `les_c${String(i).padStart(2, "0")}`, contradictsWith: `les_t${String(i).padStart(2, "0")}` }))]);
    const first = await lessonsTrialRepairJob(many.deps, ORG_A, ["web"], 10_000);
    expect(first.trialsRetiredByCard).toBeGreaterThan(0);
    expect(first.trialsRetiredByCard).toBeLessThan(25);
    // the rest go on the next nights
    let total = first.trialsRetiredByCard!;
    for (let night = 0; night < 5 && total < 25; night += 1) total += (await lessonsTrialRepairJob(many.deps, ORG_A, ["web"], 10_000)).trialsRetiredByCard!;
    expect(total).toBe(25);
  });
  it("the cap of 20 counts only retires that happened: 20 permanently refused retires and one real one -> the real one is retired the same night", async () => {
    const refusedIds = Array.from({ length: 20 }, (_, i) => `les_a${String(i).padStart(2, "0")}`);
    const lessons = [...refusedIds.map((id) => trialOld({ id })), trialOld({ id: "les_z00" }), ...refusedIds.map((id, i) => card({ id: `les_ca${String(i).padStart(2, "0")}`, contradictsWith: id })), card({ id: "les_cz00", contradictsWith: "les_z00" })];
    const w = await repair(lessons);
    const real = w.deps.maintain!.store.commit.bind(w.deps.maintain!.store);
    // the store refuses these writes for ever (for example its erasure fence)
    w.deps.maintain!.store.commit = async (...args: Parameters<typeof real>) => (args[2].some((lesson) => refusedIds.includes(lesson.id)) ? { ok: false, reason: "fenced" } : real(...args));
    const result = await lessonsTrialRepairJob(w.deps, ORG_A, ["web"], 10_000);
    expect(result).toMatchObject({ trialsRetiredByCard: 1, trialRepairRefused: 20 });
    expect((await w.store.get(KEYW, "les_z00"))!.status).toBe("retired");
    expect((await w.store.get(KEYW, "les_a00"))!.status).toBe("active");
  });
  it("the pass is bounded by its own hard limit of checks, and a refusal that never ends does not starve the rest for ever: the start moves from night to night", async () => {
    const refusedIds = Array.from({ length: 250 }, (_, i) => `les_a${String(i).padStart(3, "0")}`);
    const lessons = [...refusedIds.map((id) => trialOld({ id })), trialOld({ id: "les_z000" }), ...refusedIds.map((id, i) => card({ id: `les_ca${String(i).padStart(3, "0")}`, contradictsWith: id })), card({ id: "les_cz000", contradictsWith: "les_z000" })];
    let now = NOW;
    const w = await repair(lessons, { now: () => now });
    const store = w.deps.maintain!.store;
    const real = store.commit.bind(store);
    let commitsTried = 0;
    store.commit = async (...args: Parameters<typeof real>) => { if (args[2].some((lesson) => refusedIds.includes(lesson.id))) { commitsTried += 1; return { ok: false, reason: "fenced" }; } return real(...args); };
    const first = await lessonsTrialRepairJob(w.deps, ORG_A, ["web"], 10_000);
    // a night looks at no more than the hard limit of cards (each refused retire is a few tries of the store)
    expect(first.trialRepairRefused! + first.trialsRetiredByCard!).toBeLessThanOrEqual(MAX_TRIAL_REPAIR_CHECKS);
    expect(commitsTried).toBeLessThanOrEqual(MAX_TRIAL_REPAIR_CHECKS * 3);
    let nights = 1;
    while ((await store.get(KEYW, "les_z000"))!.status !== "retired" && nights < 12) { now += DAY; await lessonsTrialRepairJob(w.deps, ORG_A, ["web"], 10_000); nights += 1; }
    expect((await store.get(KEYW, "les_z000"))!.status).toBe("retired");
  });
  it("the walk resumes where the last night stopped (saved per project, by how many cards were looked at): 450 pending cards are all reached within ceil(450/200) = 3 nights", async () => {
    // 449 cards that need nothing (the lesson they name is not live on trial) and, last in the order, one that does
    const noops = Array.from({ length: 449 }, (_, i) => card({ id: `les_c${String(i).padStart(3, "0")}`, contradictsWith: "les_none" }));
    const w = await repair([trialOld({ id: "les_z000" }), ...noops, card({ id: "les_cz999", contradictsWith: "les_z000" })]);
    const nights: string[] = [];
    let now = NOW;
    w.deps.now = () => now;
    for (let night = 1; night <= 3; night += 1) {
      await lessonsTrialRepairJob(w.deps, ORG_A, ["web"], 10_000);
      nights.push((await w.store.get(KEYW, "les_z000"))!.status);
      now += DAY;
    }
    expect(nights).toEqual(["active", "active", "retired"]);
  });
  it("promotion skips a lesson a pending member card contradicts (the repair may not have reached it yet), and promotes the others", async () => {
    const ripe = (id: string): Lesson => trialOld({ id, trial: { state: "trial", startedAt: NOW - 15 * DAY }, counters: { loaded: 5, helpful: 0, harmful: 0, citationStale: 0 } });
    const w = await repair([ripe("les_old1"), ripe("les_old2"), ripe("les_old3"), card(), card({ id: "les_card3", contradictsWith: "les_old3" }, false)]);
    expect(await lessonsPromoteJob(w.deps, ORG_A, ["web"], 10_000)).toMatchObject({ trialsPromoted: 2 });
    expect((await w.store.get(KEYW, "les_old1"))!.trial?.state).toBe("trial");
    expect((await w.store.get(KEYW, "les_old2"))!.trial?.state).toBe("stable");
    // a card that is not from a member's correction does not hold the lesson back
    expect((await w.store.get(KEYW, "les_old3"))!.trial?.state).toBe("stable");
  });
  it("more contradicted lessons than one night's cap: the ones past the cap stay on trial that night and none is promoted", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `les_t${String(i).padStart(2, "0")}`);
    const w = await repair([...ids.map((id) => trialOld({ id, trial: { state: "trial", startedAt: NOW - 15 * DAY }, counters: { loaded: 5, helpful: 0, harmful: 0, citationStale: 0 } })), ...ids.map((id, i) => card({ id: `les_c${String(i).padStart(2, "0")}`, contradictsWith: id }))]);
    expect(await lessonsNightlyJob(w.deps, ORG_A, ["web"], 10_000)).toMatchObject({ trialsRetiredByCard: 20, trialsPromoted: 0 });
    const states = await Promise.all(ids.map(async (id) => (await w.store.get(KEYW, id))!));
    expect(states.filter((lesson) => lesson.status === "retired")).toHaveLength(20);
    expect(states.filter((lesson) => lesson.status === "active" && lesson.trial?.state === "trial")).toHaveLength(5);
  });
  it("a retire that fails is counted and the rest go on; nothing a person wrote or an id leaves the job", async () => {
    const w = await repair([trialOld(), trialOld({ id: "les_old2" }), card(), card({ id: "les_card2", contradictsWith: "les_old2" })]);
    const real = w.deps.maintain!.store.commit.bind(w.deps.maintain!.store);
    let failed = false;
    w.deps.maintain!.store.commit = async (...args: Parameters<typeof real>) => { if (!failed) { failed = true; throw new Error("table text"); } return real(...args); };
    const result = await lessonsTrialRepairJob(w.deps, ORG_A, ["web"], 10_000);
    expect(result).toMatchObject({ trialsRetiredByCard: 1, trialRepairFailures: 1 });
    expect(w.logs).toEqual(["lessons_job.trial_repair_failed"]);
  });
});

describe("the nightly trial-to-stable pass (lessons connect)", () => {
  const DAY = 86_400_000;
  const STANDARD_ON = settings({ mode: "On", preset: "standard" });
  const trialLesson = (over: Partial<Lesson> = {}, days = TRIAL_STABLE_AFTER_DAYS + 1, loads = 3): Lesson => lessonRecord({
    id: "les_trial1", workspaceId: ORG_A, project: "web", tier: 1, status: "active", approvals: [{ approvalId: "t1", by: TRIAL_APPROVER, at: 1, mode: "trial" }],
    trial: { state: "trial", startedAt: NOW - days * DAY }, counters: { loaded: loads, helpful: 0, harmful: 0, citationStale: 0 }, ...over,
  });
  async function nightly(lessons: Lesson[], over: Partial<LessonsJobDeps> = {}) {
    const w = await setup();
    const store = new InMemoryLessonStore();
    await seed(store, ...lessons);
    const audit = new Audit();
    const { deps, sent, logs } = jobDeps(w, { settings: STANDARD_ON, queue: undefined, maintain: { store, audit, now: () => NOW }, ...over });
    return { deps, store, audit, sent, logs };
  }
  const stateOf = async (store: InMemoryLessonStore, id = "les_trial1") => (await store.get({ workspaceId: ORG_A, project: "web" }, id))!.trial?.state;

  it("a trial lesson at 14 days and 3 loads with no thumbs-down becomes stable in the nightly run, audited", async () => {
    const { deps, store, audit } = await nightly([trialLesson()]);
    expect(await lessonsNightlyJob(deps, ORG_A, ["web"], 10_000)).toMatchObject({ trialsPromoted: 1, promoteFailures: 0 });
    expect(await stateOf(store)).toBe("stable");
    expect((await store.get({ workspaceId: ORG_A, project: "web" }, "les_trial1"))!.trial).toMatchObject({ state: "stable", stableAt: NOW });
    expect(audit.events.find((e) => e.action === "lesson.trial_stable")).toMatchObject({ lessonId: "les_trial1", project: "web" });
  });
  it("not before: 13 days, 2 loads, a thumbs-down mark or a retire proposal each keep the lesson on trial", async () => {
    const { deps, store } = await nightly([
      trialLesson({ id: "les_young" }, TRIAL_STABLE_AFTER_DAYS - 1), trialLesson({ id: "les_unloaded" }, undefined, 2),
      trialLesson({ id: "les_harmful", counters: { loaded: 3, helpful: 0, harmful: 1, citationStale: 0 } }), trialLesson({ id: "les_retire", retireProposedAt: NOW - DAY }),
    ]);
    expect(await lessonsPromoteJob(deps, ORG_A, ["web"], 10_000)).toMatchObject({ trialsPromoted: 0 });
    for (const id of ["les_young", "les_unloaded", "les_harmful", "les_retire"]) expect(await stateOf(store, id), id).toBe("trial");
  });
  it("only where trial lessons are allowed: Off, Collect, Suggest and the Regulated preset change nothing", async () => {
    for (const config of [settings({ mode: "Off", preset: "standard" }), settings({ mode: "Collect", preset: "standard" }), settings({ mode: "Suggest", preset: "standard" }), settings({ mode: "On", preset: "regulated" })]) {
      const { deps, store, audit } = await nightly([trialLesson()], { settings: config });
      expect(await lessonsNightlyJob(deps, ORG_A, ["web"], 10_000)).toMatchObject({ trialsPromoted: 0 });
      expect(await stateOf(store)).toBe("trial");
      expect(audit.events).toEqual([]);
    }
    // Positive control: the same lesson under Standard and On is promoted.
    const { deps, store } = await nightly([trialLesson()]);
    await lessonsPromoteJob(deps, ORG_A, ["web"], 10_000);
    expect(await stateOf(store)).toBe("stable");
  });
  it("no promotion store, or an invalid company id, does nothing; a person-approved lesson (no trial record) is left alone", async () => {
    const without = await nightly([trialLesson()], { maintain: undefined });
    expect(await lessonsPromoteJob(without.deps, ORG_A, ["web"], 10_000)).toEqual({ trialsPromoted: 0 });
    expect(await stateOf(without.store)).toBe("trial");
    const bad = await nightly([trialLesson()]);
    expect(await lessonsPromoteJob(bad.deps, "not a company", ["web"], 10_000)).toEqual({ trialsPromoted: 0 });
    const person = await nightly([lessonRecord({ id: "les_person", workspaceId: ORG_A, project: "web", tier: 1 })]);
    expect(await lessonsPromoteJob(person.deps, ORG_A, ["web"], 10_000)).toMatchObject({ trialsPromoted: 0 });
  });
  it("respects the time budget: with no time left no project is looked at, and the lessons wait for the next night", async () => {
    let clock = NOW;
    const { deps, store } = await nightly([trialLesson()], { now: () => (clock += 20_000) });
    expect(await lessonsPromoteJob(deps, ORG_A, ["web"], 10_000)).toMatchObject({ trialsPromoted: 0 });
    expect(await stateOf(store)).toBe("trial");
    // Positive control: with the budget intact (a clock that stands still) the same lesson moves.
    const fresh = await nightly([trialLesson()]);
    expect(await lessonsPromoteJob(fresh.deps, ORG_A, ["web"], 10_000)).toMatchObject({ trialsPromoted: 1 });
  });
  it("stops between lessons when the budget runs out mid-project: the first lesson moved, the budget is then gone, the second waits", async () => {
    let late = false;
    const store = new InMemoryLessonStore();
    await seed(store, trialLesson({ id: "les_a" }), trialLesson({ id: "les_b" }));
    const audit = new Audit();
    const emit = audit.emit.bind(audit);
    audit.emit = async (event, options) => { await emit(event, options); late = true; };
    const w = await setup();
    const { deps } = jobDeps(w, { settings: STANDARD_ON, now: () => (late ? NOW + 1_000_000 : NOW), maintain: { store, audit, now: () => NOW } });
    expect(await lessonsPromoteJob(deps, ORG_A, ["web"], 10_000)).toMatchObject({ trialsPromoted: 1 });
    expect([await stateOf(store, "les_a"), await stateOf(store, "les_b")].sort()).toEqual(["stable", "trial"]);
  });
  it("is erasure-safe: a lesson that names an erased (fenced) person stays on trial, and the other lessons still move", async () => {
    const { deps, store } = await nightly([trialLesson({ id: "les_erased", provenance: { ...lessonRecord().provenance, authors: ["dev-gone"] } }), trialLesson({ id: "les_fine" })]);
    await store.fence({ workspaceId: ORG_A, project: "web" }, { people: ["dev-gone"] });
    expect(await lessonsPromoteJob(deps, ORG_A, ["web"], 10_000)).toMatchObject({ trialsPromoted: 1 });
    expect(await stateOf(store, "les_erased")).toBe("trial");
    expect(await stateOf(store, "les_fine")).toBe("stable");
  });
  it("a project whose settings cannot be read is skipped (fail closed) and the others still run; a repeat night moves nothing twice", async () => {
    const { deps, store } = await nightly([trialLesson()]);
    const flaky: LessonsJobDeps = { ...deps, settings: { read: async (org, project) => { if (project === "api") throw new Error("secret"); return STANDARD_ON.read(org, project); } } };
    expect(await lessonsPromoteJob(flaky, ORG_A, ["api", "web"], 10_000)).toMatchObject({ trialsPromoted: 1 });
    expect(await stateOf(store)).toBe("stable");
    expect(await lessonsPromoteJob(deps, ORG_A, ["web"], 10_000)).toMatchObject({ trialsPromoted: 0 });
  });
});

describe("the nightly expiry sweep (lessons connect)", () => {
  const DAY = 86_400_000;
  const live = (over: Partial<Lesson>): Lesson => lessonRecord({ workspaceId: ORG_A, project: "web", tier: 1, status: "active", ...over });
  async function sweep(lessons: Lesson[], over: Partial<LessonsJobDeps> = {}) {
    const w = await setup();
    const store = new InMemoryLessonStore();
    await seed(store, ...lessons);
    const audit = new Audit();
    const { deps } = jobDeps(w, { settings: settings({ mode: "On" }), maintain: { store, audit, now: () => NOW }, state: memoryState(["web"]), ...over });
    return { deps, store, audit };
  }
  const statusOf = async (store: InMemoryLessonStore, id: string) => (await store.get({ workspaceId: ORG_A, project: "web" }, id))!.status;

  it("an active lesson past its expiry and a pending one nobody decided in time become expired, audited; the others stay", async () => {
    const { deps, store, audit } = await sweep([
      live({ id: "les_old", expiresAt: NOW - DAY }), live({ id: "les_new", expiresAt: NOW + DAY }),
      live({ id: "les_pend_old", status: "pending", approvals: [], pendingExpiresAt: NOW - DAY }), live({ id: "les_pend_new", status: "pending", approvals: [], pendingExpiresAt: NOW + DAY }),
    ]);
    expect(await lessonsExpireJob(deps, ORG_A, ["web"], 10_000)).toMatchObject({ lessonsExpired: 2, expireFailures: 0 });
    expect(await Promise.all(["les_old", "les_new", "les_pend_old", "les_pend_new"].map((id) => statusOf(store, id)))).toEqual(["expired", "active", "expired", "pending"]);
    expect(audit.events.filter((e) => e.action === "lesson.expired").map((e) => e.lessonId).sort()).toEqual(["les_old", "les_pend_old"]);
  });
  it("runs before the promotion in the nightly run, so an expired trial lesson is never made stable; a project whose learning is Off is left alone", async () => {
    const trial = live({ id: "les_expired_trial", expiresAt: NOW - DAY, approvals: [{ approvalId: "t1", by: TRIAL_APPROVER, at: 1, mode: "trial" }], trial: { state: "trial", startedAt: NOW - 20 * DAY }, counters: { loaded: 3, helpful: 0, harmful: 0, citationStale: 0 } });
    const { deps, store } = await sweep([trial], { settings: settings({ mode: "On", preset: "standard" }) });
    expect(await lessonsNightlyJob(deps, ORG_A, ["web"], 10_000)).toMatchObject({ lessonsExpired: 1, trialsPromoted: 0 });
    expect(await statusOf(store, "les_expired_trial")).toBe("expired");
    const off = await sweep([live({ id: "les_old", expiresAt: NOW - DAY })], { settings: settings({ mode: "Off" }) });
    expect(await lessonsExpireJob(off.deps, ORG_A, ["web"], 10_000)).toMatchObject({ lessonsExpired: 0 });
    expect(await statusOf(off.store, "les_old")).toBe("active");
  });
  it("does nothing with no store or no time left", async () => {
    const none = await sweep([live({ id: "les_old", expiresAt: NOW - DAY })], { maintain: undefined });
    expect(await lessonsExpireJob(none.deps, ORG_A, ["web"], 10_000)).toEqual({ lessonsExpired: 0 });
    let clock = NOW;
    const late = await sweep([live({ id: "les_old", expiresAt: NOW - DAY })], { now: () => (clock += 20_000) });
    expect(await lessonsExpireJob(late.deps, ORG_A, ["web"], 10_000)).toMatchObject({ lessonsExpired: 0 });
    expect(await statusOf(late.store, "les_old")).toBe("active");
  });
});

describe("the nightly upkeep keeps the lessons people use", () => {
  const DAY = 86_400_000;
  const KEY = { workspaceId: ORG_A, project: "web" };
  const convention = (over: Partial<Lesson>): Lesson => lessonRecord({
    workspaceId: ORG_A, project: "web", tier: 1, status: "active", type: "convention", approvals: [{ approvalId: "p1", by: "dev-ann", at: 1, mode: "one" }], ...over,
  });
  async function night(lessons: Lesson[], over: Partial<LessonsJobDeps> = {}) {
    const w = await setup();
    const store = new InMemoryLessonStore();
    await seed(store, ...lessons);
    const audit = new Audit();
    const counters: CounterDeps = { store, audit, now: () => NOW, judge: REFUSING_JUDGE, settings: settings({ mode: "On" }) };
    const { deps } = jobDeps(w, { settings: settings({ mode: "On" }), queue: undefined, maintain: counters, counters, state: memoryState(["web"]), ...over });
    return { deps, store, audit, counters };
  }
  const statusOf = async (store: InMemoryLessonStore, id: string) => (await store.get(KEY, id))!.status;

  it("a convention lesson whose helpful mark fell due survives day 90 (the settle runs BEFORE the sweep); one nobody used expires", async () => {
    // Both lessons are past their expiry tonight (day 90). Task t1 merged cleanly 15 days ago with `les_used` loaded: its helpful mark is due now.
    const { deps, store, audit } = await night([convention({ id: "les_used", expiresAt: NOW - 1_000 }), convention({ id: "les_unused", expiresAt: NOW - 1_000 })]);
    await store.addPending({ key: "helpful:t1:les_used", workspaceId: ORG_A, project: "web", lessonId: "les_used", taskId: "t1", dueAt: NOW - DAY });
    expect(await lessonsNightlyJob(deps, ORG_A, ["web"], 10_000)).toMatchObject({ lessonsExpired: 1, helpfulSettled: 1, expireFailures: 0 });
    expect(await statusOf(store, "les_used")).toBe("active");
    expect(await statusOf(store, "les_unused")).toBe("expired");
    const used = (await store.get(KEY, "les_used"))!;
    expect(used.expiresAt).toBe(NOW + 90 * DAY);
    expect(used.counters.helpful).toBe(1);
    expect(audit.events.filter((e) => e.action === "lesson.expired").map((e) => e.lessonId)).toEqual(["les_unused"]);
  });
  it("a mark that is not due yet renews nothing but holds the lesson (the sweep skips a lesson with a queued mark); once the mark is taken back (a revert) the next night expires it", async () => {
    const { deps, store } = await night([convention({ id: "les_late", expiresAt: NOW - 1_000 })]);
    await store.addPending({ key: "helpful:t1:les_late", workspaceId: ORG_A, project: "web", lessonId: "les_late", taskId: "t1", dueAt: NOW + DAY });
    expect(await lessonsExpireJob(deps, ORG_A, ["web"], 10_000)).toMatchObject({ lessonsExpired: 0, helpfulSettled: 0 });
    expect(await statusOf(store, "les_late")).toBe("active");
    expect((await store.get(KEY, "les_late"))!.counters.helpful).toBe(0);
    await store.removePending(KEY, "helpful:t1:les_late");
    expect(await lessonsExpireJob(deps, ORG_A, ["web"], 10_000)).toMatchObject({ lessonsExpired: 1 });
    expect(await statusOf(store, "les_late")).toBe("expired");
  });
  it("a settle that fails leaves the project unswept tonight (nothing expires on a guess), and the other projects still run", async () => {
    const { deps, store } = await night([convention({ id: "les_used", expiresAt: NOW - 1_000 })]);
    const broken: CounterDeps = { ...deps.counters!, store: Object.assign(Object.create(store) as InMemoryLessonStore, { duePending: async () => { throw new Error("table down"); } }) };
    const logs: string[] = [];
    expect(await lessonsExpireJob({ ...deps, counters: broken, log: (event) => logs.push(event) }, ORG_A, ["web"], 10_000)).toMatchObject({ lessonsExpired: 0, expireFailures: 1 });
    expect(await statusOf(store, "les_used")).toBe("active");
    expect(logs).toEqual(["lessons_job.expire_failed"]);
  });
  it("lessons an eval snapshot pins never expire; a pinned read that fails skips the project", async () => {
    const { deps, store } = await night([convention({ id: "les_pinned", expiresAt: NOW - 1_000 }), convention({ id: "les_other", expiresAt: NOW - 1_000 })]);
    expect(await lessonsExpireJob({ ...deps, pinned: async () => new Set(["les_pinned"]) }, ORG_A, ["web"], 10_000)).toMatchObject({ lessonsExpired: 1 });
    expect([await statusOf(store, "les_pinned"), await statusOf(store, "les_other")]).toEqual(["active", "expired"]);
    const again = await night([convention({ id: "les_pinned", expiresAt: NOW - 1_000 })]);
    expect(await lessonsExpireJob({ ...again.deps, pinned: async () => { throw new Error("eval store down"); } }, ORG_A, ["web"], 10_000)).toMatchObject({ lessonsExpired: 0, expireFailures: 1 });
    expect(await statusOf(again.store, "les_pinned")).toBe("active");
  });
});

describe("the sweep is bounded inside a project, rotates its starting project and holds a returning project's backlog", () => {
  const DAY = 86_400_000;
  const due = (id: string, over: Partial<Lesson> = {}): Lesson => lessonRecord({ id, workspaceId: ORG_A, project: "web", tier: 1, status: "active", expiresAt: NOW - 1_000, ...over });
  async function sweepWith(lessons: Lesson[], over: Partial<LessonsJobDeps> = {}) {
    const w = await setup();
    const store = new InMemoryLessonStore();
    await seed(store, ...lessons);
    const audit = new Audit();
    const { deps, logs } = jobDeps(w, { settings: settings({ mode: "On" }), queue: undefined, maintain: { store, audit, now: () => NOW }, ...over });
    return { deps, store, audit, logs, w };
  }
  const statuses = async (store: InMemoryLessonStore, ids: string[], project = "web") => Promise.all(ids.map(async (id) => (await store.get({ workspaceId: ORG_A, project }, id))!.status));

  it("the sweep checks the time before each lesson inside a project: with the budget gone after the first, the rest wait for tomorrow, and the project is tomorrow's first again", async () => {
    let late = false;
    const state = memoryState(["web", "api"]);
    const w = await setup();
    const store = new InMemoryLessonStore();
    await seed(store, due("les_a"), due("les_b"), due("les_c"));
    const audit = new Audit();
    const emit = audit.emit.bind(audit);
    audit.emit = async (event, options) => { await emit(event, options); late = true; };
    const { deps } = jobDeps(w, { settings: settings({ mode: "On" }), queue: undefined, state, now: () => (late ? NOW + 1_000_000 : NOW), maintain: { store, audit, now: () => NOW } });
    expect(await lessonsExpireJob(deps, ORG_A, ["web", "api"], 10_000)).toMatchObject({ lessonsExpired: 1 });
    expect((await statuses(store, ["les_a", "les_b", "les_c"])).filter((s) => s === "expired")).toHaveLength(1);
    // "api" (first in order, nothing to do) was finished and counts; "web" was cut in the middle, so it does not: tomorrow's pass starts at "web" (index 1), not after it.
    expect(state.saved.get("expire")!.next).toBe(1);
  });
  it("both passes rotate: when the budget lets one project through a night, the next night starts at the next project (a saved position)", async () => {
    const w = await setup();
    const store = new InMemoryLessonStore();
    const trials = ["api", "web", "zeta"].map((project) => lessonRecord({
      id: `les_${project}`, workspaceId: ORG_A, project, tier: 1, status: "active", approvals: [{ approvalId: "t1", by: TRIAL_APPROVER, at: 1, mode: "trial" }],
      trial: { state: "trial", startedAt: NOW - 20 * DAY }, counters: { loaded: 3, helpful: 0, harmful: 0, citationStale: 0 }, expiresAt: NOW + DAY,
    }));
    await seed(store, ...trials);
    const audit = new Audit();
    // Each project's settings read moves the clock 6 s; the budget is 10 s, so one project fits a night and the second finds the budget gone.
    let clock = NOW;
    const reader = settings({ mode: "On", preset: "standard" });
    const ticking = { read: async (org: string, project: string) => { clock += 6_000; return reader.read(org, project); } };
    const state = memoryState(["api", "web", "zeta"]);
    const { deps } = jobDeps(w, { settings: ticking, queue: undefined, state, now: () => clock, maintain: { store, audit, now: () => NOW } });
    const nights: string[] = [];
    for (let night = 0; night < 3; night += 1) {
      clock = NOW;
      const before = await Promise.all(["api", "web", "zeta"].map(async (project) => (await store.get({ workspaceId: ORG_A, project }, `les_${project}`))!.trial?.state));
      await lessonsPromoteJob(deps, ORG_A, ["api", "web", "zeta"], 10_000);
      const after = await Promise.all(["api", "web", "zeta"].map(async (project) => (await store.get({ workspaceId: ORG_A, project }, `les_${project}`))!.trial?.state));
      nights.push(["api", "web", "zeta"].filter((_, i) => before[i] !== after[i]).join(","));
    }
    // Without rotation the same first project would be the only one ever promoted; with it, a different project each night.
    expect(nights).toEqual(["api", "web", "zeta"]);
  });
  it("a project not seen for a few nights (learning was Off, or the passes ran out of time) holds its pending lessons for a grace window; a project seen last night does not", async () => {
    const pending = (id: string) => due(id, { status: "pending", approvals: [], pendingExpiresAt: NOW - 2 * DAY, expiresAt: NOW + 90 * DAY });
    const returning = await sweepWith([pending("les_p")], { state: memoryState([]) });
    expect(await lessonsExpireJob(returning.deps, ORG_A, ["web"], 10_000)).toMatchObject({ lessonsExpired: 0 });
    expect(await statuses(returning.store, ["les_p"])).toEqual(["pending"]);
    const kept = (returning.deps.state as ReturnType<typeof memoryState>).saved.get("expire")!.projects[projectHash(ORG_A, "web")]!;
    expect(kept.graceUntil).toBe(NOW + PENDING_GRACE_MS);
    // Every following night (the project is seen each night) still holds them, until the window closes after 7 days.
    const stateAfter = returning.deps.state as ReturnType<typeof memoryState>;
    let expiredOnDay = -1;
    for (let day = 1; day <= 9 && expiredOnDay < 0; day += 1) {
      const at = NOW + day * DAY;
      const result = await lessonsExpireJob({ ...returning.deps, now: () => at, maintain: { ...returning.deps.maintain!, now: () => at } }, ORG_A, ["web"], 10_000);
      if (result["lessonsExpired"] === 1) expiredOnDay = day;
      else expect(stateAfter.saved.get("expire")!.projects[projectHash(ORG_A, "web")]!.graceUntil).toBe(NOW + PENDING_GRACE_MS);
    }
    expect(expiredOnDay).toBe(7);
    // Positive control: a project seen last night expires the same lesson at once.
    const seen = await sweepWith([pending("les_p")], { state: memoryState(["web"]) });
    expect(await lessonsExpireJob(seen.deps, ORG_A, ["web"], 10_000)).toMatchObject({ lessonsExpired: 1 });
    // Active lessons past their expiry are never held by the grace window.
    const active = await sweepWith([due("les_act")], { state: memoryState([]) });
    expect(await lessonsExpireJob(active.deps, ORG_A, ["web"], 10_000)).toMatchObject({ lessonsExpired: 1 });
  });
  it("a night that finds learning Off writes {seenAt, off: true} for the project; the first night it is On opens ONE grace window (the Off marker is dropped), and the nights after it do not open another", async () => {
    const state = memoryState(["web"]);
    const hash = projectHash(ORG_A, "web");
    const pending = due("les_p", { status: "pending", approvals: [], pendingExpiresAt: NOW - 2 * DAY, expiresAt: NOW + 90 * DAY });
    const off = await sweepWith([pending], { settings: settings({ mode: "Off" }), state });
    expect(await lessonsExpireJob(off.deps, ORG_A, ["web"], 10_000)).toMatchObject({ lessonsExpired: 0 });
    expect(state.saved.get("expire")!.projects[hash]).toEqual({ seenAt: NOW, off: true });
    // Back On the next night (well inside the old 3-day gap): the window opens because it was Off, not because of a gap.
    const on = await sweepWith([pending], { state });
    expect(await lessonsExpireJob(on.deps, ORG_A, ["web"], 10_000)).toMatchObject({ lessonsExpired: 0 });
    expect(await statuses(on.store, ["les_p"])).toEqual(["pending"]);
    expect(state.saved.get("expire")!.projects[hash]).toEqual({ seenAt: NOW, graceUntil: NOW + PENDING_GRACE_MS });
    // The night after: seen On, no Off marker, so the same window stays (not moved).
    const later = NOW + DAY;
    const next = await sweepWith([pending], { state, now: () => later, maintain: { store: on.store, audit: new Audit(), now: () => later } });
    await lessonsExpireJob(next.deps, ORG_A, ["web"], 10_000);
    expect(state.saved.get("expire")!.projects[hash]!.graceUntil).toBe(NOW + PENDING_GRACE_MS);
  });
  it("a project the rotation reaches only every 5 nights (budget) with learning On never opens a grace window: its pending lessons expire at their date; a never-seen project opens one", async () => {
    const state = memoryState();
    state.saved.set("expire", { next: 0, projects: { [projectHash(ORG_A, "web")]: { seenAt: NOW - 5 * DAY } } });
    const pending = due("les_p", { status: "pending", approvals: [], pendingExpiresAt: NOW - 2 * DAY, expiresAt: NOW + 90 * DAY });
    const sparse = await sweepWith([pending], { state });
    expect(await lessonsExpireJob(sparse.deps, ORG_A, ["web"], 10_000)).toMatchObject({ lessonsExpired: 1 });
    expect(state.saved.get("expire")!.projects[projectHash(ORG_A, "web")]!.graceUntil).toBeUndefined();
    const fresh = await sweepWith([pending], { state: memoryState([]) });
    expect(await lessonsExpireJob(fresh.deps, ORG_A, ["web"], 10_000)).toMatchObject({ lessonsExpired: 0 });
  });
  it("the Off marker survives a read and write of the Team record table state", async () => {
    const w = await setup();
    const store = documentNightlyState(w.store);
    await store.write(ORG_A, "expire", { next: 0, projects: { [projectHash(ORG_A, "web")]: { seenAt: 5, off: true } } });
    expect(await store.read(ORG_A, "expire")).toEqual({ next: 0, projects: { [projectHash(ORG_A, "web")]: { seenAt: 5, off: true } } });
  });
  it("a state that cannot be read runs the pass from the top, writes nothing and opens no grace-less surprise (one fixed line)", async () => {
    const broken: NightlyStateStore = { read: async () => { throw new Error("table text"); }, write: async () => { throw new Error("must not write"); } };
    const w = await sweepWith([due("les_old")], { state: broken });
    expect(await lessonsExpireJob(w.deps, ORG_A, ["web"], 10_000)).toMatchObject({ lessonsExpired: 1 });
    expect(w.logs).toContain("lessons_job.state_unreadable");
  });
  it("the Team record table keeps the state in the company's own partition, under LESSONSET#NIGHTLY (the company erase wipes it), holding hashes and times only", async () => {
    const w = await setup();
    const store = documentNightlyState(w.store);
    expect(await store.read(ORG_A, "expire")).toEqual({ next: 0, projects: {} });
    await store.write(ORG_A, "expire", { next: 2, projects: { [projectHash(ORG_A, "web")]: { seenAt: 5, graceUntil: 9 } } });
    expect(await store.read(ORG_A, "expire")).toEqual({ next: 2, projects: { [projectHash(ORG_A, "web")]: { seenAt: 5, graceUntil: 9 } } });
    expect(await store.read(ORG_A, "promote")).toEqual({ next: 0, projects: {} });
    expect(await store.read(ORG_B, "expire")).toEqual({ next: 0, projects: {} });
  });
  it("the sweep reads a page at a time and goes on to the later pages (300 due lessons, all expired, none missed at a page edge)", async () => {
    const many = Array.from({ length: 250 }, (_, i) => due(`les_${String(i).padStart(4, "0")}`));
    const w = await sweepWith(many, { state: memoryState(["web"]) });
    const pages: number[] = [];
    const original = w.deps.maintain!.store.listPage.bind(w.deps.maintain!.store);
    w.deps.maintain!.store.listPage = async (key, filter) => { pages.push(filter.limit); return original(key, filter); };
    const store = w.deps.maintain!.store;
    const swept = await sweepExpired(w.deps.maintain!, store, { workspaceId: ORG_A, project: "web" }, { limit: 1000 });
    expect(swept.expired).toHaveLength(250);
    expect(pages.length).toBe(3);
    expect(Math.max(...pages)).toBeLessThanOrEqual(100);
  });
});
