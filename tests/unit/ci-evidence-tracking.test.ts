// TE-E0 option A, slice A3: the customer's marked checks in a real tracking pass. With nothing marked the pass is today's, byte for byte. A marked check is waited for on its own clock (no machine
// held: the pass names when to look again), never called "failed" when it timed out, and its landed result is told once on the pull request as "Real: reported by your pipeline ... on run N, commit".
// A red marked check is the customer's environment (failed before tests, or red on main), a question for a person (no detail, rounds used, timeout), or a fix within its cap; logs stay off unless turned on.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CI_EVIDENCE_ASK_PREFIX, CI_EVIDENCE_ENVIRONMENT_PREFIX, createCandidateManifest, DEFAULT_CI_EVIDENCE_SETTINGS, GITHUB_ACTIONS_APP_ID, IMPLICIT_COMPANY_ID, isCiFixBlockReason,
  type ChangeRequestStatus, type Check, type CheckRunner, type CiEvidenceSettings, type LatestCheck,
} from "@agentx/contracts";
import { readCi, registerMergeActionDecider, trackTask, type MergeTrackingDependencies } from "../../packages/broker/src/core/merge/merge-tracking.js";
import { installCiFixDecider, readCiEvidence, uninstallCiFixDecider } from "../../packages/broker/src/core/ci-fix/ci-fix.js";
import { LANDED_LINE_MAX, landedLine } from "../../packages/broker/src/core/ci-evidence/tracking.js";
import { checkTimesKey, readCheckTimes } from "../../packages/broker/src/core/ci-evidence/history.js";
import { CLOCK, TASK_ID, mergeWorld, type MergeWorld } from "../support/merge-world.js";

const MIN = 60_000;
const ACTIONS = String(GITHUB_ACTIONS_APP_ID);
const MARKED = { name: "e2e-real", calledAs: "real model in our account", longOrPaid: true };
const settings = (over: Partial<CiEvidenceSettings> = {}): CiEvidenceSettings => ({ ...DEFAULT_CI_EVIDENCE_SETTINGS, markedChecks: [MARKED], ...over });
const unit: Check = { name: "unit", state: "completed", conclusion: "success", required: false, url: "", runId: "11" };
const e2e = (over: Partial<Check> = {}): Check => ({ name: "e2e-real", state: "completed", conclusion: "success", required: false, url: "https://github.com/acme/app/actions/runs/5/job/77", runId: "77", source: ACTIONS, logReadable: true, ...over });

interface Runner { facts: number; main?: LatestCheck | undefined; attempt?: number }
/** The world with a fake check runner (attempt and times for a run, the main branch's latest run), the CI slot filled, and the marked-check settings the port answers. */
async function world(answer: unknown, runner: Runner = { facts: 0 }): Promise<{ w: MergeWorld; deps: MergeTrackingDependencies; logs: string[] }> {
  const w = await mergeWorld();
  // The world's workflow, completed to the full snapshot the CI slot's moves validate.
  const at = new Date(CLOCK).toISOString();
  const candidate = createCandidateManifest([{ repositoryId: "app", commitSha: w.prs[0]!.head, treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
  const current = (await w.task()).workflow;
  await w.setWorkflow({
    ownerId: "a".repeat(64), createdAt: at, artifacts: [], decisions: [], candidate,
    verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: "test", recordedAt: at, results: [{ checkId: "unit", status: "PASS" }] },
    reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: "11111111-1111-4111-8111-111111111111", candidateDigest: candidate.digest, role, provider: "scripted", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: at })),
    pullRequests: (current.pullRequests ?? []).map((pr) => ({ ...pr, candidateDigest: candidate.digest })),
  });
  const logs: string[] = [];
  const checkRunner: Partial<CheckRunner> = {
    kind: "github-actions", capabilities: { listByChangeRequest: true, listByRevision: false, logTail: true, start: false, rerun: false },
    listChecks: async () => [], logTail: async () => "AssertionError: expected 1 to be 2",
    runFacts: async () => { runner.facts += 1; return { attempt: runner.attempt ?? 2, startedAt: new Date(CLOCK).toISOString(), completedAt: new Date(CLOCK + 40 * MIN).toISOString() }; },
    latestCheck: async () => runner.main,
  };
  const deps: MergeTrackingDependencies = {
    ...w.tracking,
    repository: async (...args) => { const home = await w.tracking.repository(...args); return home === undefined ? undefined : { ...home, checkRunner: checkRunner as CheckRunner }; },
    ciEvidence: () => answer, autonomy: () => "run", log: (event) => { logs.push(event); },
  };
  return { w, deps, logs };
}
const setChecks = (w: MergeWorld, checks: Check[]) => w.prs[0]!.model.setChecks(w.prs[0]!.head, checks);
const item = async (w: MergeWorld) => (await w.trackingOf(w.prs[0]!)) as Record<string, unknown> & { ci: string; ciMarked?: Array<Record<string, unknown>> };
const comments = (w: MergeWorld) => w.prs[0]!.model.changeRequests[0]!.comments.map((comment) => comment.body.split("\n")[0]);

beforeEach(() => installCiFixDecider(registerMergeActionDecider));
afterEach(() => uninstallCiFixDecider());

describe("nothing marked is today's pass", () => {
  it.each([["no port", undefined], ["an empty answer", "none"], ["nothing marked", DEFAULT_CI_EVIDENCE_SETTINGS]])("writes the same item with %s", async (_label, answer) => {
    const today = await mergeWorld();
    await trackTask({ ...today.tracking, autonomy: () => "run" }, TASK_ID);
    const { w, deps } = await world(answer === "none" ? undefined : answer);
    if (answer === undefined) delete (deps as { ciEvidence?: unknown }).ciEvidence;
    await trackTask(deps, TASK_ID);
    expect(await item(w)).toEqual(await item(today));
    expect((await item(w)).ciMarked).toBeUndefined();
  });
  it("treats settings that do not parse as none, and logs it without the value", async () => {
    const { w, deps, logs } = await world({ version: 1, markedChecks: "everything", secret: "do-not-echo" });
    await trackTask(deps, TASK_ID);
    expect((await item(w)).ciMarked).toBeUndefined();
    expect(logs).toContain("ci_evidence.settings_unreadable");
    expect(JSON.stringify(logs)).not.toContain("do-not-echo");
  });
});

describe("the marked check's own clock", () => {
  it("keeps CI pending while the marked check has not reported, and names when to look again (no machine held)", async () => {
    const { w, deps } = await world(settings());
    const outcome = await trackTask(deps, TASK_ID);
    const stored = await item(w);
    expect(stored.ci).toBe("pending");
    expect(stored.ciMarked).toEqual([{ name: "e2e-real", state: "waiting", until: new Date(CLOCK + 120 * MIN).toISOString(), expectedMs: 120 * MIN }]);
    expect(outcome.recheckAt).toBeLessThanOrEqual(CLOCK + 120 * MIN);
    expect((await w.task()).workflow.state).toBe("WAITING");
  });
  it("says not run after the wait and asks a person, never failed and never a fix", async () => {
    const { w, deps } = await world(settings());
    await trackTask(deps, TASK_ID);
    w.now.value = CLOCK + 121 * MIN;
    await trackTask(deps, TASK_ID);
    const stored = await item(w);
    expect(stored.ciMarked?.[0]).toMatchObject({ state: "not_run", reason: "timed_out", afterMs: 120 * MIN });
    expect(stored.ci).not.toBe("failing");
    const workflow = (await w.task()).workflow;
    expect(workflow.state).toBe("BLOCKED");
    expect(workflow.blockReason).toBe(`${CI_EVIDENCE_ASK_PREFIX}no result from e2e-real in time. Check your pipeline, then re-run it or retry to let Rovara carry on.`);
    expect(isCiFixBlockReason(workflow.blockReason)).toBe(true);
    expect(w.milestones.written.some((entry) => entry.kind === "stuck")).toBe(true);
  });
  it("never gives a marked required check the 15-minute \"not reported\"", () => {
    const status = { checks: [unit], requiredChecks: [{ name: "e2e-real" }], targetHasRequiredChecks: true, headDefinesChecks: true } as unknown as ChangeRequestStatus;
    const at = { checksEverSeen: true, lastRovaraPushAt: CLOCK, now: CLOCK + 30 * MIN };
    expect(readCi(status, at).ci).toBe("required_missing");
    expect(readCi(status, { ...at, marked: [MARKED] }).ci).toBe("pending");
    const none = { checks: [], requiredChecks: [], targetHasRequiredChecks: false, headDefinesChecks: false } as unknown as ChangeRequestStatus;
    expect(readCi(none, { checksEverSeen: false, lastRovaraPushAt: CLOCK, now: CLOCK + 60 * MIN }).ci).toBe("none");
    expect(readCi(none, { checksEverSeen: false, lastRovaraPushAt: CLOCK, now: CLOCK + 60 * MIN, marked: [MARKED] }).ci).toBe("pending");
  });
  it("counts a marked check that is not required when the base requires others", () => {
    const status = { checks: [{ ...unit, required: true }, e2e({ conclusion: "failure" })], requiredChecks: [{ name: "unit" }], targetHasRequiredChecks: true, headDefinesChecks: true } as unknown as ChangeRequestStatus;
    expect(readCi(status, { checksEverSeen: true, lastRovaraPushAt: CLOCK, now: CLOCK }).ci).toBe("passing");
    expect(readCi(status, { checksEverSeen: true, lastRovaraPushAt: CLOCK, now: CLOCK, marked: [MARKED] }).ci).toBe("failing");
  });
});

describe("a result that lands", () => {
  it("is told once on the pull request with the run and the commit, its facts read once, and its time learned", async () => {
    const runner: Runner = { facts: 0 };
    const { w, deps } = await world(settings(), runner);
    setChecks(w, [unit, e2e()]);
    await trackTask(deps, TASK_ID);
    w.now.value += 5 * MIN;
    await trackTask(deps, TASK_ID);
    const stored = await item(w);
    expect(stored.ci).toBe("passing");
    expect(stored.ciMarked?.[0]).toMatchObject({ state: "passed", attempt: 2, runId: "77", announced: true });
    expect(comments(w)).toEqual([`Real: reported by your pipeline: real model in our account (e2e-real) passed on run 2, commit ${w.prs[0]!.head.slice(0, 7)}, no per-test counts reported`]);
    expect(runner.facts).toBe(1);
    // Something else changes on the pull request: the item is written again, and the result is still not told twice.
    setChecks(w, [unit, e2e(), { name: "lint", state: "pending", required: false, url: "", runId: "12" }]);
    w.now.value += 5 * MIN;
    await trackTask(deps, TASK_ID);
    expect((await item(w)).ci).toBe("pending");
    expect(comments(w)).toHaveLength(1);
    const times = await readCheckTimes(w.store, IMPLICIT_COMPANY_ID, "web", "app");
    expect(Object.values(times.durations)).toEqual([[40 * MIN]]);
  });
  it("is told again for a re-run (a new run), not for the same one", async () => {
    const runner: Runner = { facts: 0 };
    const { w, deps } = await world(settings(), runner);
    setChecks(w, [unit, e2e({ conclusion: "failure" })]);
    runner.main = { revision: "c".repeat(40), check: e2e({ conclusion: "failure" }) };
    runner.attempt = 1;
    await trackTask(deps, TASK_ID);
    expect(comments(w)).toHaveLength(1);
    expect(comments(w)[0]).toContain("failed on run 1");
  });
  it("keeps a line within what the host takes, with no mention", () => {
    const line = landedLine({ name: "x", state: "passed", attempt: 3 }, { name: "@team ".repeat(40), calledAs: "@owner ".repeat(20), longOrPaid: false }, "a".repeat(40));
    expect(line.length).toBeLessThanOrEqual(LANDED_LINE_MAX);
    expect(line).not.toMatch(/@/u);
    expect(line).toContain("on run 3, commit aaaaaaa");
  });
});

describe("a marked check that failed", () => {
  it("is the customer's environment when it is red on main too: no fix, a re-run link", async () => {
    const runner: Runner = { facts: 0, main: { revision: "c".repeat(40), check: e2e({ conclusion: "failure" }) } };
    const { w, deps } = await world(settings(), runner);
    setChecks(w, [unit, e2e({ conclusion: "failure" })]);
    await trackTask(deps, TASK_ID);
    const workflow = (await w.task()).workflow;
    expect(workflow.state).toBe("BLOCKED");
    expect(workflow.blockReason).toBe(`${CI_EVIDENCE_ENVIRONMENT_PREFIX}e2e-real is also failing on main's latest run, so Rovara is not changing the code for it. Re-run it when it is fixed: https://github.com/acme/app/actions/runs/5/job/77`);
  });
  it("asks a person when nothing says which test failed (logs off by default)", async () => {
    const { w, deps } = await world(settings(), { facts: 0, main: { revision: "c".repeat(40), check: e2e() } });
    setChecks(w, [unit, e2e({ conclusion: "failure" })]);
    await trackTask(deps, TASK_ID);
    expect((await w.task()).workflow.blockReason).toMatch(new RegExp(`^${CI_EVIDENCE_ASK_PREFIX}e2e-real failed without saying which test failed`, "u"));
  });
  it("fixes within the long check's cap when the customer shares logs", async () => {
    const { w, deps } = await world(settings({ shareLogs: true }), { facts: 0, main: { revision: "c".repeat(40), check: e2e() } });
    setChecks(w, [unit, e2e({ conclusion: "failure" })]);
    await trackTask(deps, TASK_ID);
    const workflow = (await w.task()).workflow;
    expect(workflow.stage).toBe("IMPLEMENT");
    expect(w.milestones.written.some((entry) => entry.kind === "fixing" && entry.text.includes("round 1 of 2"))).toBe(true);
  });
  it("asks once the long check's two rounds are used", async () => {
    const { w, deps } = await world(settings({ shareLogs: true }), { facts: 0, main: { revision: "c".repeat(40), check: e2e() } });
    await w.setWorkflow({ fixRounds: { ci: 2, conflict: 0, feedbackAuto: 0 } });
    setChecks(w, [unit, e2e({ conclusion: "failure" })]);
    await trackTask(deps, TASK_ID);
    expect((await w.task()).workflow.blockReason).toMatch(new RegExp(`^${CI_EVIDENCE_ASK_PREFIX}e2e-real is still failing after the fixes`, "u"));
  });
  it("lets a person's Retry for this head go to the CI fix as before", async () => {
    const { w, deps } = await world(settings({ shareLogs: true }), { facts: 0, main: { revision: "c".repeat(40), check: e2e({ conclusion: "failure" }) } });
    await w.setWorkflow({ ciFixApproved: [w.prs[0]!.head] });
    setChecks(w, [unit, e2e({ conclusion: "failure" })]);
    await trackTask(deps, TASK_ID);
    expect((await w.task()).workflow.stage).toBe("IMPLEMENT");
  });
});

describe("logs stay off until the customer turns them on", () => {
  it("never hands a marked check's log to a fix round a person asked for", async () => {
    const { w, deps } = await world(settings(), { facts: 0, main: { revision: "c".repeat(40), check: e2e({ conclusion: "failure" }) } });
    await w.setWorkflow({ ciFixApproved: [w.prs[0]!.head] });
    setChecks(w, [unit, e2e({ conclusion: "failure" })]);
    await trackTask(deps, TASK_ID);
    const workflow = (await w.task()).workflow;
    expect(workflow.stage).toBe("IMPLEMENT");
    const block = await readCiEvidence(w.store, TASK_ID, IMPLICIT_COMPANY_ID, workflow.revision);
    expect(block).toContain("This check has no log Rovara can read here.");
    expect(block).not.toContain("AssertionError");
  });
});

describe("learned times are the company's own", () => {
  it("never reads another company's item as this one's", async () => {
    const w = await mergeWorld();
    const other = "22222222-2222-4222-8222-222222222222";
    await w.store.put({ item: { ...checkTimesKey(IMPLICIT_COMPANY_ID, "web", "app"), entityType: "CI_CHECK_TIMES", orgId: other, version: 1, durations: { k: [MIN] } } });
    expect(await readCheckTimes(w.store, IMPLICIT_COMPANY_ID, "web", "app")).toEqual({ version: 0, durations: {} });
    expect(checkTimesKey(IMPLICIT_COMPANY_ID, "web", "app").pk).not.toBe(checkTimesKey(other as never, "web", "app").pk);
  });
});
