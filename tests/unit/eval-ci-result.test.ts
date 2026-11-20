// L4-EVCI (owner decision D7): the customer's own eval result on Rovara's pull request. One check of the customer's CI is named at setup; when it completes, the description says
// "Eval (reported by your CI): passed / failed / not run, <link>" as a sub-line under the verdict's "Proven" line, next to Rovara's own eval label (two verdicts, never one), and the ready line carries the
// same line. ADVISORY: nothing about readiness, fixing, comments or the Check changes. A check that is not the named one is ignored. Company scoping of the reads is the marked checks'.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CI_EVIDENCE_SETTINGS, EVAL_CI_LABEL, GITHUB_ACTIONS_APP_ID, IMPLICIT_COMPANY_ID, createCandidateManifest, evalCiLine,
  type Check, type CheckRunner, type CiEvidenceSettings,
} from "@agentx/contracts";
import { parsePipelineReport } from "../../packages/worker/src/verification/pipeline-report-parser.js";
import { readyEvalLine, registerMergeActionDecider, trackTask, type MergeTrackingDependencies } from "../../packages/broker/src/core/merge/merge-tracking.js";
import { installCiFixDecider, uninstallCiFixDecider } from "../../packages/broker/src/core/ci-fix/ci-fix.js";
import { writeEvalDescription } from "../../packages/broker/src/core/ci-evidence/eval-ci.js";
import { ROVARA_STATUS_END, ROVARA_STATUS_START } from "../../packages/broker/src/core/proof/pull-request-body.js";
import { fixedCodeSettings } from "../../packages/broker/src/core/merge/index.js";
import { createMergeTrackingService, createMilestoneService } from "../../packages/broker/src/services/index.js";
import { ORG as SERVICE_ORG, host as serviceHost } from "../support/service-host.js";
import { CLOCK, TASK_ID, mergeWorld, type MergeWorld } from "../support/merge-world.js";

const MIN = 60_000;
const ACTIONS = String(GITHUB_ACTIONS_APP_ID);
const EVAL_URL = "https://github.com/acme/app/actions/runs/5/job/77";
const settings = (over: Partial<CiEvidenceSettings> = {}): CiEvidenceSettings => ({ ...DEFAULT_CI_EVIDENCE_SETTINGS, evalCheck: { name: "evals", source: ACTIONS }, ...over });
const unit: Check = { name: "unit", state: "completed", conclusion: "success", required: false, url: "", runId: "11" };
const evals = (over: Partial<Check> = {}): Check => ({ name: "evals", state: "completed", conclusion: "success", required: false, url: EVAL_URL, runId: "77", source: ACTIONS, ...over });
const PROVEN = "**Proven** 2 of 2 requirements proven. Improved on eval.";
const bodyOf = (...extra: string[]): string => ["Add a.", "", ROVARA_STATUS_START, "## Verified · Low risk · nothing extra to check", "", "**Changed** 1 file, +1 -0.", PROVEN, "**Tested against** Rovara has no record of which services the checks used.", "**Risk** Low.", "**Needs you** The normal code review. Nothing else.", ...extra, ROVARA_STATUS_END, "", "Opened by Rovara."].join("\n");
const junit = (cases: Array<{ name: string; failure?: string }>) => `<?xml version="1.0"?><testsuite name="s" tests="${String(cases.length)}">${cases.map((test) => `<testcase classname="evals" name="${test.name}">${test.failure === undefined ? "" : `<failure message="${test.failure}">trace</failure>`}</testcase>`).join("")}</testsuite>`;

interface Fake { facts: number; scopes: unknown[]; reports: Record<string, string[]>; reads: string[]; attempt?: number }
/** The world with a fake runner (run facts, per-test report files), the settings the port answers, and a description that says Rovara's own eval label already. */
async function world(answer: unknown, options: { parser?: boolean; body?: string; repositoryId?: string } = {}): Promise<{ w: MergeWorld; deps: MergeTrackingDependencies; fake: Fake; logs: string[]; asked: unknown[] }> {
  const repositoryId = options.repositoryId ?? "app";
  const w = await mergeWorld(options.repositoryId === undefined ? {} : { pullRequests: [{ repositoryId, number: 1 }] });
  const at = new Date(CLOCK).toISOString();
  const candidate = createCandidateManifest([{ repositoryId, commitSha: w.prs[0]!.head, treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
  const current = (await w.task()).workflow;
  await w.setWorkflow({
    ownerId: "a".repeat(64), createdAt: at, artifacts: [], decisions: [], candidate,
    verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: "test", recordedAt: at, results: [{ checkId: "unit", status: "PASS" }] },
    reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: "11111111-1111-4111-8111-111111111111", candidateDigest: candidate.digest, role, provider: "scripted", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: at })),
    pullRequests: (current.pullRequests ?? []).map((pr) => ({ ...pr, candidateDigest: candidate.digest })),
  });
  w.prs[0]!.model.update(w.prs[0]!.model.changeRequests[0]!.id, { body: options.body ?? bodyOf() });
  const fake: Fake = { facts: 0, scopes: [], reports: {}, reads: [] };
  const logs: string[] = [];
  const asked: unknown[] = [];
  const runner: Partial<CheckRunner> = {
    kind: "github-actions", capabilities: { listByChangeRequest: true, listByRevision: false, logTail: true, start: false, rerun: false },
    listChecks: async () => [], logTail: async () => "a log that must never be read",
    runFacts: async (_target, check, scope) => { fake.facts += 1; fake.scopes.push(scope); return { attempt: fake.attempt ?? 1, workflowRunId: `${check.runId ?? "0"}00`, startedAt: new Date(CLOCK).toISOString(), completedAt: new Date(CLOCK + 20 * MIN).toISOString() }; },
    latestCheck: async () => undefined,
    reportFiles: async (_repository, runId, scope) => { fake.reads.push(runId); fake.scopes.push(scope); const texts = fake.reports[runId]; return texts === undefined ? { kind: "none" } : { kind: "read", files: texts.map((text, index) => ({ name: `r${String(index)}.xml`, text })) }; },
  };
  const deps: MergeTrackingDependencies = {
    ...w.tracking, autonomy: () => "run", log: (event) => { logs.push(event); },
    ciEvidence: (task) => { asked.push(task); return answer; },
    ...(options.parser === true ? { reportParser: parsePipelineReport } : {}),
    repository: async (...args) => { const home = await w.tracking.repository(...args); return home === undefined ? undefined : { ...home, checkRunner: runner as CheckRunner }; },
  };
  return { w, deps, fake, logs, asked };
}
const setChecks = (w: MergeWorld, checks: Check[]) => w.prs[0]!.model.setChecks(w.prs[0]!.head, checks);
const item = async (w: MergeWorld) => (await w.trackingOf(w.prs[0]!)) as Record<string, unknown> & { ci: string; ciEval?: Record<string, unknown> };
const body = (w: MergeWorld): string => w.prs[0]!.model.changeRequests[0]!.body ?? "";
const evalLines = (text: string): string[] => text.split("\n").filter((line) => line.includes(EVAL_CI_LABEL));

beforeEach(() => installCiFixDecider(registerMergeActionDecider));
afterEach(() => uninstallCiFixDecider());

describe("nothing named is today's pass", () => {
  it.each([["no port", undefined], ["nothing named", DEFAULT_CI_EVIDENCE_SETTINGS]])("writes the same item and leaves the description alone with %s", async (_label, answer) => {
    const today = await mergeWorld();
    await trackTask({ ...today.tracking, autonomy: () => "run" }, TASK_ID);
    const { w, deps } = await world(answer);
    if (answer === undefined) delete (deps as { ciEvidence?: unknown }).ciEvidence;
    setChecks(w, [unit, evals()]);
    today.prs[0]!.model.setChecks(today.prs[0]!.head, [unit, evals()]);
    await trackTask(deps, TASK_ID);
    const stored = await item(w);
    expect(stored.ciEval).toBeUndefined();
    expect(stored.ciEvalSince).toBeUndefined();
    expect(body(w)).toBe(bodyOf());
  });
  it("treats settings that name nothing valid as nothing named, and never echoes them", async () => {
    const { w, deps, logs } = await world({ ...settings(), evalCheck: { name: "", secret: "do-not-echo" } });
    setChecks(w, [unit, evals()]);
    await trackTask(deps, TASK_ID);
    expect((await item(w)).ciEval).toBeUndefined();
    expect(logs).toContain("ci_evidence.settings_unreadable");
    expect(JSON.stringify(logs)).not.toContain("do-not-echo");
  });
});

describe("the named check landed", () => {
  it("failed with a per-test report: the count of failing cases", async () => {
    const { w, deps, fake } = await world(settings(), { parser: true });
    fake.reports["7700"] = [junit([{ name: "a" }, { name: "b", failure: "wrong" }, { name: "c", failure: "wrong" }, { name: "d" }])];
    setChecks(w, [unit, evals({ conclusion: "failure" })]);
    await trackTask(deps, TASK_ID);
    expect(evalLines(body(w))).toEqual([`  - Eval (reported by your CI): failed, 2 of 4 cases failing, ${EVAL_URL}`]);
    expect((await item(w)).ciEval).toMatchObject({ state: "failed", report: "read", counts: { passed: 2, failed: 2, skipped: 0 } });
    // Only counts are kept on the item: no failed test's name or text.
    expect((await item(w)).ciEval).not.toHaveProperty("failedTests");
    expect(JSON.stringify((await item(w)).ciEval)).not.toContain("wrong");
  });
  it("gives up on a report that never comes and says the result without counts, once", async () => {
    const { w, deps } = await world(settings(), { parser: true });
    setChecks(w, [unit, evals()]);
    for (let pass = 0; pass < 6; pass += 1) { await trackTask(deps, TASK_ID); w.now.value += 2 * MIN; }
    expect(evalLines(body(w))).toEqual([`  - Eval (reported by your CI): passed, ${EVAL_URL}`]);
  });
});

describe("the named check did not run", () => {
  it("says nothing while it is still expected, then \"not run\" after the wait, and never failed", async () => {
    const { w, deps } = await world(settings());
    setChecks(w, [unit]);
    await trackTask(deps, TASK_ID);
    expect((await item(w)).ciEval).toMatchObject({ state: "waiting" });
    expect(evalLines(body(w))).toEqual([]);
    w.now.value = CLOCK + 121 * MIN;
    await trackTask(deps, TASK_ID);
    expect((await item(w)).ciEval).toMatchObject({ state: "not_run", reason: "timed_out", afterMs: 120 * MIN, announced: true });
    expect(evalLines(body(w))).toEqual(["  - Eval (reported by your CI): not run (no result after 2 h)"]);
    expect((await item(w)).ci).not.toBe("failing");
    expect((await w.task()).workflow.state).toBe("WAITING");
  });
  it("says \"not run\" when the CI skipped it", async () => {
    const { w, deps } = await world(settings());
    setChecks(w, [unit, evals({ conclusion: "skipped" })]);
    await trackTask(deps, TASK_ID);
    expect(evalLines(body(w))).toEqual([`  - Eval (reported by your CI): not run (your CI skipped it), ${EVAL_URL}`]);
  });
});

describe("the ready line fits the milestone", () => {
  it("leaves the address off before the text would pass the milestone's limit, and says nothing rather than overflow", () => {
    const result = { outcome: "failed", counts: { passed: 1, failed: 1, skipped: 0 }, url: `https://github.com/${"a".repeat(250)}` } as const;
    const full = evalCiLine(result);
    expect(readyEvalLine(result, "x".repeat(10))).toBe(full);
    const short = evalCiLine({ ...result, url: undefined });
    expect(readyEvalLine(result, "x".repeat(500 - short.length - 1))).toBe(short);
    expect(readyEvalLine(result, "x".repeat(500 - short.length))).toBeUndefined();
    expect(readyEvalLine(undefined, "x")).toBeUndefined();
  });
});

describe("the description is written carefully", () => {
  it("writes nothing when the block is not as Rovara wrote it (no Proven line), and does not fail the pass", async () => {
    const odd = ["Some words.", "", ROVARA_STATUS_START, "A block a person rewrote.", ROVARA_STATUS_END].join("\n");
    const { w, deps } = await world(settings(), { body: odd });
    setChecks(w, [unit, evals()]);
    await trackTask(deps, TASK_ID);
    expect(body(w)).toBe(odd);
    expect((await item(w)).ciEval).toMatchObject({ state: "passed", announced: true });
  });
  it("a host that refuses the write is logged by name, the pass goes on, and the line is not tried again every pass", async () => {
    const { w, deps, logs } = await world(settings());
    const model = w.prs[0]!.model;
    let tries = 0;
    model.update = () => { tries += 1; throw new Error("403 secret detail"); };
    setChecks(w, [unit, evals()]);
    await trackTask(deps, TASK_ID);
    w.now.value += 5 * MIN;
    await trackTask(deps, TASK_ID);
    expect(tries).toBe(1);
    expect(logs).toContain("eval_ci.description_not_written");
    expect(JSON.stringify(logs)).not.toContain("secret detail");
    expect((await item(w)).ciEval).toMatchObject({ state: "passed" });
  });
  it("a host that says slow down during the write goes up as the pass's own limit, and nothing is recorded as told", async () => {
    const { w, deps } = await world(settings());
    setChecks(w, [unit, evals()]);
    w.prs[0]!.model.update = () => { throw Object.assign(new Error("slow down"), { name: "HostRateLimitError", retryAt: CLOCK + MIN }); };
    const outcome = await trackTask(deps, TASK_ID).then((value) => ({ value }), (error: unknown) => ({ error }));
    expect(JSON.stringify(outcome, (_key, value: unknown) => (value instanceof Error ? value.name : value))).toContain("HostRateLimitError");
    expect((await item(w))?.ciEval).toBeUndefined();
  });
});

describe("the line follows the head and the settings", () => {
  it("a new head starts again: the old head's line is taken out and its entry is not carried over", async () => {
    const { w, deps } = await world(settings());
    setChecks(w, [unit, evals()]);
    await trackTask(deps, TASK_ID);
    expect(evalLines(body(w))).toHaveLength(1);
    const model = w.prs[0]!.model;
    const branch = model.changeRequests[0]!.sourceBranch;
    const next = model.commit(branch, { "src/b.ts": "export const b = 2;\n" });
    model.setChecks(next, [unit]);
    w.now.value += 5 * MIN;
    await trackTask(deps, TASK_ID);
    const stored = await item(w);
    expect(stored.headSha).toBe(next);
    expect(stored.ciEval).toMatchObject({ state: "waiting" });
    expect(stored.ciEval?.announced).toBeUndefined();
    expect(evalLines(body(w))).toEqual([]);
  });
  it("is never written to a pull request that is not open", async () => {
    const { w } = await world(settings());
    const model = w.prs[0]!.model;
    model.update(model.changeRequests[0]!.id, { state: "closed" });
    const ref = { repository: { url: "https://github.com/acme/app" }, id: String(w.prs[0]!.number), url: model.crUrl(String(w.prs[0]!.number)) };
    const host = (await w.host.repository("web", 1, "app", IMPLICIT_COMPANY_ID))!.codeHost;
    const sink = { host, store: w.store, companyId: IMPLICIT_COMPANY_ID, workspaceId: "ws-1", repositoryId: "app", number: w.prs[0]!.number, ref, scope: { orgId: IMPLICIT_COMPANY_ID }, now: () => CLOCK };
    expect(await writeEvalDescription(sink, evalCiLine({ outcome: "passed" }))).toBe("not_open");
    expect(body(w)).toBe(bodyOf());
  });
});

describe("the tracking service passes the settings port and the report parser on", () => {
  it("forwards both when given, and neither when not (a host that gives nothing is today's pass)", async () => {
    const w = await serviceHost({ repositories: ["app"] });
    const common = { flow: w.h.deps, registry: w.registry, companyId: SERVICE_ORG, milestones: createMilestoneService({ store: w.h.store, now: () => w.clock.ms }), people: w.people, settings: fixedCodeSettings({ allowSelfApproval: true, mergeMethod: "squash", codeReviewers: [], revision: 1 }), now: () => w.clock.ms };
    const ciEvidence = (): unknown => settings();
    const given = createMergeTrackingService({ ...common, ciEvidence: () => ciEvidence(), reportParser: (text) => parsePipelineReport(text) });
    expect(typeof given.deps.ciEvidence).toBe("function");
    expect(typeof given.deps.reportParser).toBe("function");
    expect(given.deps.ciEvidence?.({} as never)).toMatchObject({ evalCheck: { name: "evals" } });
    expect(given.deps.reportParser?.("not a report")).toEqual({ kind: "not_report" });
    const none = createMergeTrackingService(common);
    expect(Object.hasOwn(none.deps, "ciEvidence")).toBe(false);
    expect(Object.hasOwn(none.deps, "reportParser")).toBe(false);
  });
});
