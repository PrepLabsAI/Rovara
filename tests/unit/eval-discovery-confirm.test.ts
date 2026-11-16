// DEC 253n: the setup run's eval discovery report (its existing setup callback), the maintainer/admin confirm route, the broker-built EVAL_PLAN (its own reads and hashes at the setup commit), the
// command and report path stored in the plan under the command hash, and the fresh check sandbox built per check from the pinned candidate. Every trust check has a refusal test here; the
// mutants named in each title were run by hand (break the check, see the test fail, restore).
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EVAL_PLAN_DELIVERY_ACTION, EvalPlanBodySchema, SetupEvalDiscoveryReportSchema, attestRovaraOnlyBaseCheckout, createDocumentBaseScoreCache, evalCodeHash, evalCommandFingerprintOf, evalPlanCommandHolds,
  evalPlanDigest, evalQuestionHash, evalResultFromArtifact, evalSetHashOf, evalSettingsFingerprintOf, evalSpendInputsDigest,
  type Approvers, type EvalBaseRecord, type EvalReservationAdapter, type OrgRole, type Principal, type SetupEvalDiscoveryReport,
} from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createNoopAuditSink } from "../../packages/broker/src/ports/policy-defaults.js";
import { createDecisionGate } from "../../packages/broker/src/core/decisions/approval-gate.js";
import { EVAL_SPEND_KIND, createEvalSpendSubject, evalPlanKey, evalSpendKey, proposeEvalSpendApproval, readApprovedEvalPlan, readEvalSpendItem } from "../../packages/broker/src/core/setup-agent/eval-spend.js";
import { confirmEvalDiscovery, evalDiscoveryKey, readEvalDiscovery, type EvalDiscoveryConfirmDeps } from "../../packages/broker/src/core/setup-agent/eval-discovery.js";
import { handleSetupAgentCallback } from "../../packages/broker/src/core/setup-agent/callback.js";
import { createEvalPlanSources } from "../../packages/broker/src/core/setup-agent/eval-plan-source.js";
import { setupAgentKey } from "../../packages/broker/src/core/setup-agent/keys.js";
import { deployedSessionMembers } from "../../packages/broker/src/core-host/deployed-decisions.js";
import { createCallbackHandler } from "../../packages/broker/src/services/callbacks.js";
import { CallbackCapabilities } from "../../packages/broker/src/callbacks.js";
import { operationKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { evalPlanSourcesFor, plannedFreshEvalSandbox, type EvalFreshHost } from "../../packages/worker/src/verification/eval-wiring.js";
import { pinnedEvalFreshCheck, withEvalPinnedCandidate } from "../../packages/worker/src/verification/eval-plan-source.js";
import { runFinalCheckEval } from "../../packages/worker/src/verification/eval-final-check.js";
import type { FreshEvalSandboxConfig } from "../../packages/worker/src/verification/eval-bridged-exec.js";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";

const A = COMPANY_A.orgId;
const B = COMPANY_B.orgId;
const project = "demo";
const NOW = Date.parse("2026-11-16T05:00:00.000Z");
const Q1 = "question one\n"; const Q2 = "question two\n";
const judgePin = "b".repeat(64);
const IMAGE = `registry.example/worker@sha256:${"e".repeat(64)}`;
const command = { executable: "node", args: ["evals/run.js", "--out", "rovara-measures.json"], cwd: "." };
const report = { cwd: ".", argument: "rovara-measures.json" };

const suite = (over: Record<string, unknown> = {}) => ({
  selection: "evals/demo", repository: "web",
  questions: [{ id: "q1", category: "ordinary", path: "evals/demo/q1.txt" }, { id: "q2", category: "safety", path: "evals/demo/q2.txt" }],
  command, report, commandFingerprint: evalCommandFingerprintOf(command, report), judgePin, baselineJudgePin: judgePin, subsetSupported: true,
  catalogRowId: "model", model: "model", modelVersion: "version-1", image: IMAGE, route: "gateway", maxCallsPerQuestion: 2, maxCostMicrosPerQuestion: 10, ...over,
});
const reportOf = (over: Record<string, unknown> = {}): SetupEvalDiscoveryReport => ({ schemaVersion: 1, suites: [suite(over)] }) as SetupEvalDiscoveryReport;

// ---- a git repository at a recorded setup commit

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))); });
const g = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
async function repository(base: Record<string, string>, head: Record<string, string> = { "src/app.ts": "changed\n" }) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "edc-"))); roots.push(dir);
  g(dir, "init", "-q");
  for (const [p, c] of Object.entries(base)) { await mkdir(dirname(join(dir, p)), { recursive: true }); await writeFile(join(dir, p), c); }
  g(dir, "add", "-A"); g(dir, "commit", "-qm", "base"); const baseSha = g(dir, "rev-parse", "HEAD");
  for (const [p, c] of Object.entries(head)) { await mkdir(dirname(join(dir, p)), { recursive: true }); await writeFile(join(dir, p), c); }
  g(dir, "add", "-A"); g(dir, "commit", "-qm", "head", "--allow-empty");
  const commitSha = g(dir, "rev-parse", "HEAD");
  return { dir, baseSha, repositories: [{ repositoryId: "web", directory: dir, baseCommitSha: baseSha }], candidates: [{ repositoryId: "web", commitSha, treeSha: g(dir, "rev-parse", "HEAD^{tree}"), baseCommitSha: baseSha }] };
}
/** The code host's read: the file's text at the commit (undefined when it is not there). */
const gitReader = (dir: string, reads: string[] = []): NonNullable<EvalDiscoveryConfirmDeps["readFile"]> => async (_repository, path, commit) => {
  reads.push(`${commit}:${path}`);
  try { return execFileSync("git", ["show", `${commit}:${path}`], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return undefined; }
};

// ---- one company: its people (the hosted members reader), its setup run and its confirm deps

const person = (companyId: string, personId: string): Principal => ({ companyId, personId, provider: "test-identity", displayName: personId, roles: [] });
type Role = { company: OrgRole; grant?: "developer" | "administrator" } | undefined;
function people(companyId: string, roles: Record<string, Role>) {
  return { membershipOf: async (personId: string) => { const role = roles[personId]; return role === undefined ? undefined : { companyId, role: role.company }; },
    projectGrantRole: async (personId: string, p: string) => (p === project ? roles[personId]?.grant : undefined) };
}
const ROLES: Record<string, Role> = {
  owner: { company: "owner" }, admin: { company: "admin" }, maintainer: { company: "member", grant: "administrator" }, member: { company: "member" }, contributor: { company: "member", grant: "developer" }, revoked: undefined,
};

async function world(companyId: string, options: { store?: MemoryDocumentStore; base?: Record<string, string>; head?: Record<string, string>; cap?: number | null; adapter?: boolean } = {}) {
  const store = options.store ?? new MemoryDocumentStore();
  const repo = await repository(options.base ?? { "evals/demo/q1.txt": Q1, "evals/demo/q2.txt": Q2 }, options.head);
  const members = deployedSessionMembers(companyId, people(companyId, ROLES));
  const logs: Array<{ event: string; reason?: string }> = [];
  const workspaceId = randomUUID(); const taskId = randomUUID();
  await store.put({ item: { ...workspaceKey(companyId, workspaceId), entityType: "WORKSPACE", id: workspaceId, companyId } });
  await store.put({ item: { ...(await workspaceKeys({ store, companyId }, workspaceId)).taskPointerKey(), taskId } });
  await store.put({ item: { ...taskKey(taskId), taskId, workspaceId, project, companyId, purpose: "setup_agent", preparedBase: [{ repositoryId: "web", baseCommitSha: repo.baseSha }] } });
  await store.put({ item: { ...setupAgentKey(companyId, project), entityType: "SETUP_AGENT", taskId } });
  const operation = { kind: "task", workflowMode: "SETUP_AGENT", status: "RUNNING", workspaceId, companyId };
  const callback = (body: unknown, op: object = operation, as = companyId) => handleSetupAgentCallback({ store, companyId: as, now: () => NOW, log: (e) => logs.push(e) }, op as never, body);
  const reads: string[] = [];
  const deps: EvalDiscoveryConfirmDeps = { store, companyId, now: () => NOW, members, ...(options.cap === null ? {} : { monthlyCapMicros: options.cap ?? 50_000_000 }),
    latest: async (p) => (p === project ? { definition: { repositories: [{ name: "web", url: "https://github.com/acme/web" }] } } : undefined), readFile: gitReader(repo.dir, reads), log: (e) => logs.push(e) };
  const digestOf = async () => (await readEvalDiscovery({ store, companyId }, project))!.reportDigest;
  const confirm = async (as: Principal = person(companyId, "admin"), over: Record<string, unknown> = {}) =>
    confirmEvalDiscovery(deps, project, { taskId, reportDigest: "reportDigest" in over ? over["reportDigest"] : await digestOf(), selection: "evals/demo", paths: ["evals/demo/q1.txt", "evals/demo/q2.txt"], ...over }, as);
  return { store, repo, members, logs, workspaceId, taskId, operation, callback, deps, reads, digestOf, confirm };
}

describe("the contracts: the report and the plan's stored command", () => {
  it("the report is bounded and strict, and its command fingerprint must be the broker's own of the command (mutant: the fingerprint refine)", () => {
    expect(SetupEvalDiscoveryReportSchema.safeParse(reportOf()).success).toBe(true);
    for (const bad of [
      reportOf({ commandFingerprint: "f".repeat(64) }), reportOf({ command: { ...command, args: ["other"] } }), reportOf({ report: { cwd: ".", argument: "../x" } }),
      reportOf({ image: "worker:latest" }), reportOf({ maxCallsPerQuestion: 21 }), reportOf({ questions: [] }), reportOf({ extra: true }),
      reportOf({ questions: [{ id: "q1", category: "ordinary", path: "/etc/passwd" }] }), reportOf({ questions: [{ id: "q1", category: "invented", path: "a.txt" }] }),
      reportOf({ questions: [{ id: "q1", category: "ordinary", path: "a.txt" }, { id: "q1", category: "ordinary", path: "b.txt" }] }),
      { schemaVersion: 1, suites: [suite(), suite()] }, { schemaVersion: 1, suites: Array.from({ length: 5 }, (_, i) => suite({ selection: `s${i}` })) },
      reportOf({ questions: Array.from({ length: 101 }, (_, i) => ({ id: `q${i}`, category: "ordinary", path: `f${i}.txt` })) }),
    ]) expect(SetupEvalDiscoveryReportSchema.safeParse(bad).success).toBe(false);
  });
  it("a stored plan's command and report are both present and match its command hash, or both absent (mutant: evalPlanCommandHolds)", () => {
    const fp = evalCommandFingerprintOf(command, report);
    const key = { commandFingerprint: fp };
    expect(evalPlanCommandHolds({ key })).toBe(true);
    expect(evalPlanCommandHolds({ key, command, report })).toBe(true);
    expect(evalPlanCommandHolds({ key, command })).toBe(false);
    expect(evalPlanCommandHolds({ key, command: { ...command, args: ["--other"] }, report })).toBe(false);
    expect(evalPlanCommandHolds({ key, command, report: { cwd: ".", argument: "other.json" } })).toBe(false);
    expect(evalPlanCommandHolds({ key: { commandFingerprint: "0".repeat(64) }, command, report })).toBe(false);
  });
});

describe("the report through the setup run's existing callback", () => {
  it("keeps the report once, with the commits the BROKER recorded for the run; the same report again is `same`", async () => {
    const w = await world(A);
    expect(await w.callback({ kind: "eval_discovery", report: reportOf() })).toEqual({ recorded: "new" });
    expect(await w.callback({ kind: "eval_discovery", report: reportOf() })).toEqual({ recorded: "same" });
    const row = (await w.store.get(evalDiscoveryKey(A, project, w.taskId)))!;
    expect(row).toMatchObject({ entityType: "EVAL_DISCOVERY", company: A, project, taskId: w.taskId, state: "reported", commits: [{ repository: "web", commit: w.repo.baseSha }] });
    expect(w.logs).toContainEqual({ event: "eval_discovery_recorded" });
  });
  it("refuses an edit: a second, different report for the run (mutant: put-if-absent)", async () => {
    const w = await world(A);
    await w.callback({ kind: "eval_discovery", report: reportOf() });
    await expect(w.callback({ kind: "eval_discovery", report: reportOf({ maxCallsPerQuestion: 3 }) })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect((await readEvalDiscovery({ store: w.store, companyId: A }, project))!.report.suites[0]!.maxCallsPerQuestion).toBe(2);
  });
  it("refuses an unreadable report and a suite in a repository the run did not read, with fixed words (no input echoed)", async () => {
    const w = await world(A);
    for (const bad of [reportOf({ commandFingerprint: "f".repeat(64) }), { canary: "secret-canary" }, reportOf({ repository: "other-repo" })]) {
      const error = await w.callback({ kind: "eval_discovery", report: bad }).catch((e: unknown) => e) as Error;
      expect(error).toMatchObject({ code: "CONFIG_INVALID" });
      expect(error.message).not.toContain("secret-canary"); expect(error.message).not.toContain("other-repo");
    }
    expect(await w.store.get(evalDiscoveryKey(A, project, w.taskId))).toBeUndefined();
  });
  it("refuses a report from a run that is not this company's setup run: another company's task, a non-setup run, a run that ended, another company's install (mutants: the run checks)", async () => {
    const w = await world(A);
    // The task names company B: from A's install, the run is not A's.
    await w.store.put({ item: { ...(await w.store.get(taskKey(w.taskId)))!, companyId: B } });
    await expect(w.callback({ kind: "eval_discovery", report: reportOf() })).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    const v = await world(A);
    await expect(v.callback({ kind: "eval_discovery", report: reportOf() }, { ...v.operation, workflowMode: "CHECKS" })).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    await expect(v.callback({ kind: "eval_discovery", report: reportOf() }, { ...v.operation, status: "SUCCEEDED" })).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    await expect(v.callback({ kind: "eval_discovery", report: reportOf() }, v.operation, B)).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    await expect(v.callback({ kind: "eval_discovery", report: reportOf() }, { ...v.operation, companyId: B })).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    expect(await v.store.get(evalDiscoveryKey(A, project, v.taskId))).toBeUndefined();
  });
  it("refuses a run with no recorded commit: the worker cannot name the commit (mutant: preparedBase is the only source)", async () => {
    const w = await world(A);
    const { preparedBase, ...task } = (await w.store.get(taskKey(w.taskId)))!;
    void preparedBase;
    await w.store.put({ item: task as never });
    await expect(w.callback({ kind: "eval_discovery", report: reportOf(), commits: [{ repository: "web", commit: w.repo.baseSha }] })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(w.callback({ kind: "eval_discovery", report: reportOf() })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("the confirm route: who may confirm what", () => {
  it("an owner, an admin or a project maintainer (live from the members reader) confirms; the spend item then waits for its own approval", async () => {
    for (const who of ["owner", "admin", "maintainer"]) {
      const w = await world(A);
      await w.callback({ kind: "eval_discovery", report: reportOf() });
      const answer = await w.confirm(person(A, who));
      expect(answer.evalSpend).toMatchObject({ state: "waiting" });
      expect((await readEvalDiscovery({ store: w.store, companyId: A }, project))!.state).toBe("confirmed");
    }
  });
  it("refuses a member, a contributor, a viewer-only or revoked person and anyone of another company (mutants: the role check, the company check)", async () => {
    const w = await world(A);
    await w.callback({ kind: "eval_discovery", report: reportOf() });
    for (const who of [person(A, "member"), person(A, "contributor"), person(A, "revoked"), person(A, "nobody"), person(B, "owner")]) {
      await expect(w.confirm(who)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(await w.store.get(evalSpendKey(A, project))).toBeUndefined();
    expect(await w.store.get(evalPlanKey(A, project))).toBeUndefined();
    expect((await readEvalDiscovery({ store: w.store, companyId: A }, project))!.state).toBe("reported");
  });
  it("another company's report: B's confirm of A's run finds nothing at B's own key, and A's row copied into B's partition is refused (mutants: the row's company check and digest)", async () => {
    const store = new MemoryDocumentStore();
    const a = await world(A, { store });
    await a.callback({ kind: "eval_discovery", report: reportOf() });
    const b = await world(B, { store });
    // B names A's run: B's pointer is B's own run, and A's row is never at B's key.
    await expect(confirmEvalDiscovery(b.deps, project, { taskId: a.taskId, reportDigest: await a.digestOf(), selection: "evals/demo", paths: ["evals/demo/q1.txt"] }, person(B, "admin"))).rejects.toMatchObject({ code: "CHANGE_STALE" });
    // A's row copied into B's partition under B's own run id: it names company A and its digest is A's.
    const row = (await store.get(evalDiscoveryKey(A, project, a.taskId)))!;
    const target = evalDiscoveryKey(B, project, b.taskId);
    await store.put({ item: { ...row, ...target, taskId: b.taskId } });
    await expect(confirmEvalDiscovery(b.deps, project, { taskId: b.taskId, reportDigest: row["reportDigest"] as string, selection: "evals/demo", paths: ["evals/demo/q1.txt"] }, person(B, "admin"))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await store.put({ item: { ...row, ...target, taskId: b.taskId, company: B } });
    await expect(confirmEvalDiscovery(b.deps, project, { taskId: b.taskId, reportDigest: row["reportDigest"] as string, selection: "evals/demo", paths: ["evals/demo/q1.txt"] }, person(B, "admin"))).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(b.logs).toContainEqual({ event: "eval_discovery_invalid" });
    expect(await store.get(evalSpendKey(B, project))).toBeUndefined();
    expect(await store.get(evalSpendKey(A, project))).toBeUndefined();
  });
  it("refuses a selection naming a file or a suite that is not in the report (mutants: the path subset check, the suite check)", async () => {
    const w = await world(A, { base: { "evals/demo/q1.txt": Q1, "evals/demo/q2.txt": Q2, "evals/secret.txt": "x\n" } });
    await w.callback({ kind: "eval_discovery", report: reportOf() });
    await expect(w.confirm(undefined, { paths: ["evals/demo/q1.txt", "evals/secret.txt"] })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(w.confirm(undefined, { selection: "evals/other" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(w.confirm(undefined, { paths: ["../escape.txt"] })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(w.reads).toEqual([]);
    expect(await w.store.get(evalSpendKey(A, project))).toBeUndefined();
  });
  it("refuses an edit after confirmation: a second confirm, and a new report from the run (mutants: the state check, the conditional mark)", async () => {
    const w = await world(A);
    await w.callback({ kind: "eval_discovery", report: reportOf() });
    await w.confirm();
    const planBefore = await w.store.get(evalPlanKey(A, project));
    await expect(w.confirm(undefined, { paths: ["evals/demo/q1.txt"] })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    await expect(w.callback({ kind: "eval_discovery", report: reportOf({ maxCallsPerQuestion: 3 }) })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(await w.store.get(evalPlanKey(A, project))).toEqual(planBefore);
  });
  it("refuses a report the person did not see (digest), an older run's report (not the latest), and a row edited in the store (mutants: the digest, pointer and recomputed-digest checks)", async () => {
    const w = await world(A);
    await w.callback({ kind: "eval_discovery", report: reportOf() });
    await expect(w.confirm(undefined, { reportDigest: "0".repeat(64) })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    const row = (await w.store.get(evalDiscoveryKey(A, project, w.taskId)))!;
    await w.store.put({ item: { ...row, report: reportOf({ maxCallsPerQuestion: 20 }) } });
    await expect(w.confirm(undefined, { reportDigest: row["reportDigest"] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await w.store.put({ item: row });
    await w.store.put({ item: { ...setupAgentKey(A, project), entityType: "SETUP_AGENT", taskId: randomUUID() } });
    await expect(w.confirm(undefined, { reportDigest: row["reportDigest"] })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(await w.store.get(evalSpendKey(A, project))).toBeUndefined();
  });
  it("a file missing at the setup commit, or not plain text, is refused; a cap the item does not fit puts the report back (nothing proposed)", async () => {
    const missing = await world(A, { base: { "evals/demo/q1.txt": Q1 } });
    await missing.callback({ kind: "eval_discovery", report: reportOf() });
    await expect(missing.confirm()).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    const binary = await world(A, { base: { "evals/demo/q1.txt": Q1, "evals/demo/q2.txt": "�bad" } });
    await binary.callback({ kind: "eval_discovery", report: reportOf() });
    await expect(binary.confirm()).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    const noCap = await world(A, { cap: null });
    await noCap.callback({ kind: "eval_discovery", report: reportOf() });
    await expect(noCap.confirm()).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect((await readEvalDiscovery({ store: noCap.store, companyId: A }, project))!.state).toBe("reported");
    expect(await noCap.store.get(evalSpendKey(A, project))).toBeUndefined();
  });
});

describe("the broker builds the plan from its own reads", () => {
  it("hashes each selected file at the commit IT recorded (not the run's head, not the report), computes every fingerprint itself, and stores the command and report under the command hash", async () => {
    // The head moved q1 after setup: the plan holds the setup commit's bytes.
    const w = await world(A, { head: { "evals/demo/q1.txt": "edited on the run's branch\n" } });
    await w.callback({ kind: "eval_discovery", report: reportOf() });
    await w.confirm(undefined, { paths: ["evals/demo/q1.txt"] });
    expect(w.reads).toEqual([`${w.repo.baseSha}:evals/demo/q1.txt`]);
    const plan = (await w.store.get(evalPlanKey(A, project)))!["plan"] as Record<string, unknown>;
    const settings = { imageDigest: IMAGE, route: "gateway" };
    const evalSetHash = evalSetHashOf([{ path: "evals/demo/q1.txt", bytes: Buffer.from(Q1) }]);
    expect(plan).toMatchObject({
      selection: "evals/demo", repository: "web", evalSetHash, evalConfigured: true, command, report,
      questions: [{ id: "q1", category: "ordinary", path: "evals/demo/q1.txt", hash: evalQuestionHash(Buffer.from(Q1)) }],
      key: { commandFingerprint: evalCommandFingerprintOf(command, report), catalogRowId: "model", model: "model", modelVersion: "version-1" },
      inputs: { evalSetHash, judgePin, commandFingerprint: evalCommandFingerprintOf(command, report), settingsFingerprint: evalSettingsFingerprintOf(settings, judgePin) },
    });
    expect(EvalPlanBodySchema.safeParse(plan).success).toBe(true);
    // The estimate is three runs of each selected question at its caps.
    const spend = (await w.store.get(evalSpendKey(A, project)))!["plan"] as { estimate: unknown; evalPlanDigest: string };
    expect(spend.estimate).toEqual({ calls: 3 * 1 * 2, costMicros: 3 * 1 * 10 });
    expect(spend.evalPlanDigest).toBe(evalPlanDigest(A, project, plan as never));
  });
  it("a stored plan whose command no longer matches its command hash is no plan (mutant: the EvalPlanBodySchema refine)", async () => {
    const w = await world(A);
    await w.callback({ kind: "eval_discovery", report: reportOf() });
    await w.confirm();
    const gate = createDecisionGate({ store: w.store, approvers: approversOf(person(A, "admin")), audit: createNoopAuditSink(), subjects: [createEvalSpendSubject({ store: w.store, companyId: A, members: w.members })], now: () => new Date(NOW) });
    await approve(gate, w.store);
    expect(await readApprovedEvalPlan({ store: w.store, companyId: A }, project)).toBeDefined();
    const row = (await w.store.get(evalPlanKey(A, project)))!;
    await w.store.put({ item: { ...row, plan: { ...(row["plan"] as object), command: { ...command, args: ["--steal"] } } } });
    expect(await readApprovedEvalPlan({ store: w.store, companyId: A }, project)).toBeUndefined();
  });
});

describe("EVAL-APPROVED-ROLE-NO-PRINCIPAL", () => {
  it("with the hosted members reader an approved item reads approved (not `approval needs renewing`), and loses it when the approver's membership goes (mutant: the principal)", async () => {
    const w = await world(A);
    await w.callback({ kind: "eval_discovery", report: reportOf() });
    await w.confirm();
    const gate = createDecisionGate({ store: w.store, approvers: approversOf(person(A, "admin")), audit: createNoopAuditSink(), subjects: [createEvalSpendSubject({ store: w.store, companyId: A, members: w.members })], now: () => new Date(NOW) });
    await approve(gate, w.store);
    expect(await readEvalSpendItem({ store: w.store, companyId: A, members: w.members }, project)).toMatchObject({ state: "approved" });
    const gone = deployedSessionMembers(A, people(A, { ...ROLES, admin: undefined }));
    expect(await readEvalSpendItem({ store: w.store, companyId: A, members: gone }, project)).toMatchObject({ state: "approval needs renewing" });
    // A same-item re-propose keeps the live approval (it is not asked again).
    const item = (await w.store.get(evalSpendKey(A, project)))!;
    const plan = (await w.store.get(evalPlanKey(A, project)))!["plan"] as never;
    const spend = item["plan"] as { selection: string; inputs: never; estimate: never; budget: never };
    const again = await proposeEvalSpendApproval({ store: w.store, companyId: A, members: w.members, monthlyCapMicros: 50_000_000 }, project, { selection: spend.selection, inputs: spend.inputs, estimate: spend.estimate, budget: spend.budget }, plan);
    expect(again.state).toBe("approved");
  });
});

// ---- the happy path end to end: report -> confirm -> approval -> CHECKS task -> final-check eval, and the fresh sandbox built from the plan

const approversOf = (approver: Principal): Approvers => ({ requirement: async () => ({ methods: ["local-session"], minApprovers: 1, selfApprovalAllowed: true }), verify: async (_request, proof) => ({ approved: true, approver, method: proof.method, proofId: proof.proofId }) });
async function approve(gate: ReturnType<typeof createDecisionGate>, store: MemoryDocumentStore) {
  const item = (await store.get(evalSpendKey(A, project)))!;
  const decided = await gate.decide({ companyId: A, kind: EVAL_SPEND_KIND, subjectId: project, requestId: `eval-decision-${String(item["revision"])}`, outcome: "approve", seen: { revision: item["revision"] as number, artifactDigest: item["digest"] as string }, credentials: [{ method: "local-session", token: ["fake", "session"].join("-") }] });
  expect(decided.status).toBe("decided");
}
const KEY = Buffer.alloc(32, 9);
const EVAL_REQUEST = { aiChange: true, reason: "eval_hint", evalPass: 1, callsAlreadyUsed: 0, costAlreadyUsedMicros: 0 } as const;

async function confirmedToCheck(options: { head?: Record<string, string> } = {}) {
  const w = await world(A, options.head === undefined ? {} : { head: options.head });
  await w.callback({ kind: "eval_discovery", report: reportOf() });
  await w.confirm(person(A, "maintainer"));
  const admin = person(A, "admin");
  const gate = createDecisionGate({ store: w.store, approvers: approversOf(admin), audit: createNoopAuditSink(), subjects: [createEvalSpendSubject({ store: w.store, companyId: A, members: w.members })], now: () => new Date(NOW) });
  await approve(gate, w.store);
  // A later CHECKS run of the project's task, on the setup commit as its base.
  const store = w.store; const workspaceId = randomUUID(); const operationId = randomUUID(); const taskId = randomUUID();
  await store.put({ item: { ...workspaceKey(A, workspaceId), entityType: "WORKSPACE", id: workspaceId, companyId: A } });
  await store.put({ item: { ...operationKey(A, workspaceId, operationId), entityType: "OPERATION", id: operationId, workspaceId, kind: "task", workflowMode: "CHECKS", status: "RUNNING", fence: 3, companyId: A,
    dispatch: { kind: "task", payload: { workflowMode: "CHECKS", evalRequest: EVAL_REQUEST, workflowBase: [{ repositoryId: "web", baseCommitSha: w.repo.baseSha }] } } } });
  await store.put({ item: { ...(await workspaceKeys({ store, companyId: A }, workspaceId)).taskPointerKey(), taskId } });
  await store.put({ item: { ...taskKey(taskId), taskId, workspaceId, project, companyId: A } });
  const plan = (await store.get(evalPlanKey(A, project)))!["plan"] as { inputs: Record<string, string> };
  const parts = { company: A, project, baseCommit: w.repo.baseSha, codeHash: evalCodeHash(w.repo.baseSha), judgePin, commandFingerprint: plan.inputs["commandFingerprint"]!, catalogRowId: "model", model: "model", modelVersion: "version-1", evalSetHash: plan.inputs["evalSetHash"]!, hiddenSetHash: "none", settingsFingerprint: plan.inputs["settingsFingerprint"]! };
  const RECORD: EvalBaseRecord = { schemaVersion: 1, measures: [{ name: "accuracy", unit: "fraction", value: 0.8, direction: "up_good", spread: 0.04, count: 2 }], questions: [{ id: "q1", samples: [{ pass: true, answer: "a" }, { pass: true, answer: "a" }, { pass: true, answer: "a" }] }, { id: "q2", samples: [{ pass: true, answer: "b" }, { pass: true, answer: "b" }, { pass: true, answer: "b" }] }], caseCount: 2, recordedOn: "2026-11-16", roundKind: "check_unsealed", runnerSchemaVersion: 1 };
  await createDocumentBaseScoreCache(store, { companyId: A }).write(parts, RECORD, { writer: "rovara_base_round", baseCommit: w.repo.baseSha });
  const adapter: EvalReservationAdapter = { async authority(request) { return request.company === A ? { company: A, project: request.project, principal: admin, provider: "customer", connected: true } : undefined; }, async reserve() { return undefined; } };
  const handler = createCallbackHandler({ flow: { store, companyId: A, callbackSigningKey: KEY } as never, blobs: {} as never, grants: {} as never,
    evalPlan: createEvalPlanSources({ store, companyId: A, members: w.members, registry: ({ names: (point: string) => point === "eval-reservation" ? ["test"] : [], get: () => adapter }) as never }) });
  const capability = new CallbackCapabilities(KEY).issue({ workspaceId, operationId, fence: 3, actions: [EVAL_PLAN_DELIVERY_ACTION], expiresInSeconds: 60 });
  const fetchToBroker = (async (url: string | URL, init?: RequestInit) => {
    const reply = await handler({ method: "POST", path: new URL(String(url)).pathname, headers: { "x-agentx-callback-capability": String((init?.headers as Record<string, string>)["x-agentx-callback-capability"]) }, body: typeof init?.body === "string" ? init.body : "" });
    return new Response(reply.body ?? "", { status: reply.statusCode, headers: reply.headers });
  }) as typeof fetch;
  const sources = evalPlanSourcesFor({ workspaceId, operationId, callbackCapability: capability }, { controlPlaneUrl: "http://broker.invalid", fetch: fetchToBroker });
  return { w, sources, operationId };
}

describe("happy path: setup report -> confirm -> approval -> task -> final-check eval (fakes)", () => {
  it("the confirmed plan reaches the CHECKS run, its own grant holds, both sides run and the eval compares", async () => {
    const { w, sources } = await confirmedToCheck();
    expect(await sources.approval.read()).toMatchObject({ company: A, project, selection: "evals/demo" });
    const grant = (await sources.approval.read())!;
    const plan = (await w.store.get(evalPlanKey(A, project)))!["plan"] as { inputs: never };
    expect(grant.inputsDigest).toBe(evalSpendInputsDigest(plan.inputs));
    const reports = await realpath(await mkdtemp(join(tmpdir(), "edc-report-"))); roots.push(reports);
    const stages: string[] = [];
    const ports = { roundKind: "check_unsealed" as const, ...sources,
      meter: { reserve: async (r: { approval: { company: string } }) => { expect(r.approval.company).toBe(A); return { call: async () => ({ class: "ok" as const, calls: 1, costMicros: 1 }), close: async () => undefined }; } },
      runner: async (r: { side: "old" | "new"; ids: readonly string[]; runs: 1 | 2 | 3; call: (frame: never) => Promise<unknown> }) => {
        stages.push(r.side);
        for (let i = 0; i < r.ids.length * r.runs; i++) await r.call({} as never);
        const file = `report-${stages.length}.json`;
        await writeFile(join(reports, file), JSON.stringify({ schemaVersion: 1, measures: [{ name: "accuracy", unit: "fraction", direction: "up_good", value: 1 }],
          questions: r.ids.map(id => ({ id, samples: Array.from({ length: r.runs }, () => ({ pass: true, answer: id === "q1" ? "a" : "b" })) })) }));
        return { report: { root: reports, cwd: ".", argument: file, notBeforeMs: Date.now() - 1000 }, facts: { total: r.ids.length * r.runs, run: r.ids.length * r.runs, notRun: 0, byClass: {}, overrunStop: false },
          calls: 0, costMicros: 0, changedPromptCalls: r.side === "new" ? r.ids.length : 0, seconds: 1, attestation: attestRovaraOnlyBaseCheckout({ baseCommit: w.repo.baseSha }) };
      } };
    const facts = { status: "verified", candidateDigest: "9".repeat(64), signal: new AbortController().signal };
    const artifact = await withEvalPinnedCandidate(w.repo.repositories, w.repo.candidates, new AbortController().signal, () => runFinalCheckEval(EVAL_REQUEST, ports as never, facts));
    expect(artifact, JSON.stringify(artifact)).toMatchObject({ outcome: "done", evalConfigured: true, basis: { judgePin, model: "model", modelVersion: "version-1", oldRuns: 3 } });
    expect(evalResultFromArtifact(artifact).label).toBe("No regression measured (eval)");
    expect(stages).toContain("new");
  });

  it("the fresh check sandbox is built per check from the plan's command and the pinned candidate, run by the worker's image, with the model pinned to the plan's (mutants: command hash, image, tree, model pin)", async () => {
    const { w, sources, operationId } = await confirmedToCheck();
    const configs: FreshEvalSandboxConfig[] = [];
    const scratch = await realpath(await mkdtemp(join(tmpdir(), "edc-scratch-"))); roots.push(scratch);
    const host = (over: Partial<EvalFreshHost> = {}): EvalFreshHost => ({ environment: { AGENTX_WORKER_IMAGE: IMAGE }, docker: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } as never,
      workspaceKey: async () => "0123456789abcdef", make: (config) => { configs.push(config); return { available: () => true, run: async () => ({ report: { root: scratch, cwd: ".", argument: "r.json", notBeforeMs: 0 } }) }; }, ...over });
    const round = { workingSandbox: "rovara-task-1", roundBudgetMs: 60_000, scratchDir: scratch };
    const input = { side: "new" as const, ids: ["q1"], runs: 1 as const, signal: new AbortController().signal, model: { socketPath: "/tmp/e/models/m", token: "a".repeat(32) } };
    const pinned = <T>(fn: () => Promise<T>) => withEvalPinnedCandidate(w.repo.repositories, w.repo.candidates, new AbortController().signal, fn, round);
    const planned = plannedFreshEvalSandbox(host(), { operationId }, sources.deliveredPlan);
    // The model pin answers nothing until a run has read its plan.
    expect(planned.modelAllowed({ row: "model", method: "POST", path: "/v1beta/models/model:generateContent", query: "", headers: [], body: new Uint8Array() })).toBe(false);
    await pinned(() => planned.sandbox.run(input));
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({ image: IMAGE, workspace: "0123456789abcdef", taskId: operationId, command, report, rowId: "model", scratchDir: scratch, workingSandbox: "rovara-task-1",
      repository: { directory: w.repo.dir, baseCommit: w.repo.baseSha, candidateCommit: w.repo.candidates[0]!.commitSha } });
    expect(planned.modelAllowed({ row: "model", method: "POST", path: "/v1beta/models/model:generateContent", query: "", headers: [], body: new Uint8Array() })).toBe(true);
    for (const frame of [{ row: "other", path: "/v1beta/models/model:generateContent" }, { row: "model", path: "/v1beta/models/dearer-model:generateContent" }, { row: "model", path: "/v1beta/models/model:generateContentX" }]) {
      expect(planned.modelAllowed({ ...frame, method: "POST", query: "", headers: [], body: new Uint8Array() })).toBe(false);
    }
    // The image the plan was measured with must be the worker's own.
    const other = plannedFreshEvalSandbox(host({ environment: { AGENTX_WORKER_IMAGE: `registry.example/worker@sha256:${"d".repeat(64)}` } }), { operationId }, sources.deliveredPlan);
    await expect(pinned(() => other.sandbox.run(input))).rejects.toThrow("no fresh sandbox");
    expect(plannedFreshEvalSandbox(host({ environment: { AGENTX_WORKER_IMAGE: "worker:latest" } }), { operationId }, async () => undefined).sandbox.available()).toBe(false);
    // The candidate commit's own tree must be the pinned candidate tree.
    const drifted = plannedFreshEvalSandbox(host({ treeOf: async () => "f".repeat(40) }), { operationId }, sources.deliveredPlan);
    await expect(pinned(() => drifted.sandbox.run(input))).rejects.toThrow("no fresh sandbox");
    // No round (the pin without the check's facts), and a delivered plan whose command was changed in transit: no fresh sandbox.
    await expect(withEvalPinnedCandidate(w.repo.repositories, w.repo.candidates, new AbortController().signal, () => planned.sandbox.run(input))).rejects.toThrow("no fresh sandbox");
    const delivered = await sources.deliveredPlan() as Record<string, unknown>;
    expect(await pinned(async () => pinnedEvalFreshCheck(delivered))).toBeDefined();
    expect(await pinned(async () => pinnedEvalFreshCheck({ ...delivered, command: { ...command, args: ["--steal"] } }))).toBeUndefined();
    expect(await pinned(async () => pinnedEvalFreshCheck({ ...delivered, report: { cwd: ".", argument: "elsewhere.json" } }))).toBeUndefined();
    const { command: _c, ...noCommand } = delivered; void _c;
    expect(await pinned(async () => pinnedEvalFreshCheck(noCommand))).toBeUndefined();
    expect(configs).toHaveLength(1);
  });
});
