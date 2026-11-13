// Automatic runs and the one door unattended work goes through. The rules that matter:
//   1. while automation is off nothing starts, and nothing is counted or asked of Admission;
//   2. every start asks Admission first, with the request's own id as its key; a refusal starts nothing and takes no place of the cap;
//   3. a project's monthly cap holds: at the cap the run is skipped, never started; a place is given back when the run did not start, and kept when it may have;
//   4. a repeat of a request is one run and counts once;
//   5. an unattended start carries no approval of anything.
import { describe, expect, it } from "vitest";
import { startUnattendedRun, sweepUnattendedRuns, type AutomatedRunRequest } from "../../packages/core/src/core/automation/run-seam.js";
import { claimAutomaticRun, readAutomaticRunsUse, setAutomaticRunsCap } from "../../packages/core/src/core/automatic-runs/cap.js";
import { startAutomaticRun, type AutomaticRunInput } from "../../packages/core/src/core/automatic-runs/start.js";
import { putAutomaticRunWatch, sweepAutomaticRuns } from "../../packages/core/src/core/automatic-runs/end.js";
import { automaticRunsView } from "../../packages/core/src/core/automatic-runs/view.js";
import { COMPANY, OWNER, PROJECT, START, createAutomationWorld, type AutomationWorld } from "../support/automation-world.js";

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const deps = (world: AutomationWorld) => ({ store: world.store, now: () => world.clock.now, companyId: COMPANY, audit: { stage: (e: never) => { world.audit.push(e); return []; }, record: async () => undefined }, run: world.unattended });
const rebuild = (n: number, extra: Partial<AutomaticRunInput> = {}): AutomaticRunInput => ({
  orgId: COMPANY, project: PROJECT, job: "scheduled_check", requestId: uuid(n), agent: { agentId: "rovara-code" }, input: { text: "Check the project." }, origin: "automatic", purpose: "saved_env_rebuild", ...extra,
});
const request = (n: number): AutomatedRunRequest => ({ requestId: uuid(n), project: PROJECT, agent: { agentId: "rovara-code" }, input: { text: "Go." }, origin: "automatic", limits: { maxMinutes: 5 } });

describe("the unattended door", () => {
  it("starts nothing, asks nothing and counts nothing while automation is off", async () => {
    const world = createAutomationWorld({ on: false });
    await expect(startUnattendedRun(world.unattended, request(1))).rejects.toThrow(/not switched on/u);
    await expect(startAutomaticRun(deps(world), rebuild(2))).rejects.toThrow(/not switched on/u);
    expect(world.admissions).toHaveLength(0);
    expect(world.starts).toHaveLength(0);
    // The failed start gave its place back: the month's count is zero.
    expect((await readAutomaticRunsUse(deps(world), COMPANY, PROJECT)).used).toBe(0);
  });

  it("asks Admission first, with the request id as its key, and starts nothing when it refuses", async () => {
    const world = createAutomationWorld();
    world.refuseAdmission = { code: "budget_exhausted", message: "The budget is used up." };
    await expect(startUnattendedRun(world.unattended, request(3))).rejects.toThrow(/budget is used up/u);
    expect(world.admissions.map((entry) => [entry.action, entry.idempotencyKey])).toEqual([["automation.run", `automation.run#${uuid(3)}`]]);
    expect(world.starts).toHaveLength(0);
  });

  it("gives the reservation back when the starter refuses or fails with no run made, and keeps it when the run exists", async () => {
    const world = createAutomationWorld();
    world.starter.failWith = Object.assign(new Error("PROJECT_ARCHIVED: archived"), { code: "PROJECT_ARCHIVED" });
    await expect(startUnattendedRun(world.unattended, request(4))).rejects.toThrow(/archived/u);
    expect(world.releases).toEqual(["res-1"]);
    // A fault with nothing made: the request id finds no run, so the reservation goes back too.
    world.starter.failWith = new Error("socket hang up");
    await expect(startUnattendedRun(world.unattended, request(5))).rejects.toThrow(/socket/u);
    expect(world.releases).toEqual(["res-1", "res-2"]);
    // A fault AFTER the run was made: the run exists, so its reservation is kept (and recorded to be settled).
    world.starter.failAfterCommit = true;
    await expect(startUnattendedRun(world.unattended, request(6))).rejects.toThrow(/socket/u);
    expect(world.releases).toEqual(["res-1", "res-2"]);
    expect(await sweepUnattendedRuns(world.unattended)).toMatchObject({ open: 1, settled: 0 });
  });


  it("is one run for one request id, and carries no approval, no model key and no starter", async () => {
    const world = createAutomationWorld();
    const first = await startUnattendedRun(world.unattended, request(6));
    const again = await startUnattendedRun(world.unattended, request(6));
    expect(again).toEqual({ taskId: first.taskId, duplicate: true });
    expect(world.starts).toHaveLength(1);
    expect(Object.keys(world.starts[0]!).sort()).toEqual(["agent", "input", "limits", "origin", "project", "requestId"]);
  });
});

describe("the monthly cap of automatic runs", () => {
  it("counts a retried claim once and stops at the cap, recording the pause once", async () => {
    const world = createAutomationWorld();
    await setAutomaticRunsCap(deps(world), { orgId: COMPANY, project: PROJECT, changedBy: OWNER.personId, cap: 2, requestId: "cap-request-1" });
    const claim = (n: number) => claimAutomaticRun(deps(world), { orgId: COMPANY, project: PROJECT, requestId: uuid(n), job: "nightly" });
    expect((await claim(1)).claimed).toBe(true);
    expect(await claim(1)).toMatchObject({ claimed: true, replay: true, used: 1 });
    expect((await claim(2)).claimed).toBe(true);
    expect(await claim(3)).toMatchObject({ claimed: false, used: 2, cap: 2 });
    expect(await claim(4)).toMatchObject({ claimed: false });
    expect(world.audit.filter((event) => event.action === "automatic_runs.paused")).toHaveLength(2);
    // A new month starts again.
    world.clock.now = Date.parse("2026-12-01T00:00:00.000Z");
    expect((await claim(5)).claimed).toBe(true);
  });

  it("answers a retried start as claimed even after the cap was lowered to 0, because its run exists", async () => {
    const world = createAutomationWorld();
    const started = await startAutomaticRun(deps(world), rebuild(20));
    expect(started).toMatchObject({ started: { duplicate: false } });
    await setAutomaticRunsCap(deps(world), { orgId: COMPANY, project: PROJECT, changedBy: OWNER.personId, cap: 0, requestId: "cap-request-9" });
    // The same request again is the same run (claimed once), not "skipped"; a new request is skipped.
    expect(await claimAutomaticRun(deps(world), { orgId: COMPANY, project: PROJECT, requestId: uuid(20), job: "scheduled_check" })).toMatchObject({ claimed: true, replay: true });
    expect(await startAutomaticRun(deps(world), rebuild(21))).toEqual({ skipped: "automatic_cap" });
  });

  it("skips a run at the cap without starting it or asking Admission", async () => {
    const world = createAutomationWorld();
    await setAutomaticRunsCap(deps(world), { orgId: COMPANY, project: PROJECT, changedBy: OWNER.personId, cap: 0, requestId: "cap-request-2" });
    expect(await startAutomaticRun(deps(world), rebuild(7))).toEqual({ skipped: "automatic_cap" });
    expect(world.admissions).toHaveLength(0);
    expect(world.starts).toHaveLength(0);
  });

  it("gives the place back when Admission refuses, and keeps it when the run exists", async () => {
    const world = createAutomationWorld();
    world.refuseAdmission = { code: "budget_exhausted", message: "No budget." };
    await expect(startAutomaticRun(deps(world), rebuild(8))).rejects.toThrow(/No budget/u);
    expect((await readAutomaticRunsUse(deps(world), COMPANY, PROJECT)).used).toBe(0);
    world.refuseAdmission = undefined;
    const started = await startAutomaticRun(deps(world), rebuild(9));
    expect(started).toMatchObject({ started: { duplicate: false } });
    // The run's answer was lost after it committed: its retry finds the run and counts once.
    world.starter.failWith = new Error("lost the answer");
    world.starter.failAfterCommit = true;
    await expect(startAutomaticRun(deps(world), rebuild(10))).rejects.toThrow(/lost the answer/u);
    expect((await readAutomaticRunsUse(deps(world), COMPANY, PROJECT)).used).toBe(2);
  });

  it("applies a cap change once per request id and refuses a cap out of range", async () => {
    const world = createAutomationWorld();
    const set = (cap: number, requestId: string) => setAutomaticRunsCap(deps(world), { orgId: COMPANY, project: PROJECT, changedBy: OWNER.personId, cap, requestId });
    expect((await set(5, "request-aaaa")).cap).toBe(5);
    expect((await set(9, "request-aaaa")).cap).toBe(5);
    await expect(set(100_000, "request-bbbb")).rejects.toThrow(/whole number from 0 to/u);
    await expect(set(3, "x")).rejects.toThrow(/request id of 8 to 64/u);
  });

  it("requires a model-free purpose that matches its facts", async () => {
    const world = createAutomationWorld();
    await expect(startAutomaticRun(deps(world), rebuild(11, { purpose: "nightly_run" }))).rejects.toThrow(/purpose/u);
    expect(world.starts).toHaveLength(0);
  });
});

describe("watching and showing automatic runs", () => {
  it("ends a run that outlives its time once, audits it once and drops the watch when its slot is back", async () => {
    const world = createAutomationWorld();
    await startAutomaticRun(deps(world), rebuild(12));
    const state = { ended: false, released: false, endCalls: 0 };
    const tasks = { async read() { return { ended: state.ended, released: state.released }; }, async end() { state.endCalls += 1; if (state.ended) return false; state.ended = true; return true; } };
    expect(await sweepAutomaticRuns({ ...deps(world), tasks })).toMatchObject({ ended: 0, watching: 1 });
    world.clock.now = START + 3 * 3_600_000;
    expect(await sweepAutomaticRuns({ ...deps(world), tasks })).toMatchObject({ ended: 1, audited: 1, watching: 1 });
    state.released = true;
    expect(await sweepAutomaticRuns({ ...deps(world), tasks })).toMatchObject({ ended: 0, dropped: 1 });
    expect(world.audit.filter((event) => event.action === "automatic_run.ended")).toHaveLength(1);
    await putAutomaticRunWatch(deps(world), { orgId: COMPANY, project: PROJECT, job: "nightly", taskId: "gone", startedAt: new Date(world.clock.now).toISOString() });
    expect(await sweepAutomaticRuns({ ...deps(world), tasks: { read: async () => undefined, end: async () => false } })).toMatchObject({ dropped: 1 });
  });

  it("shows this month's runs against the cap and says when it has paused them", async () => {
    const world = createAutomationWorld();
    await setAutomaticRunsCap(deps(world), { orgId: COMPANY, project: PROJECT, changedBy: OWNER.personId, cap: 1, requestId: "cap-request-3" });
    await startAutomaticRun(deps(world), rebuild(13));
    const view = await automaticRunsView(deps(world), COMPANY, PROJECT, async () => "running");
    expect(view.line.words).toBe("Automatic runs: 1 of 1 this month");
    expect(view.pausedWords).toMatch(/paused for this month/u);
    expect(view.recent).toEqual([{ job: "scheduled_check", words: "Started by Rovara (scheduled check)", startedAt: new Date(START).toISOString(), state: "running" }]);
  });
});
