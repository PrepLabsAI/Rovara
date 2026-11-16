// DEC 253j(1): the TRUSTED eval plan source. The EVAL_PLAN record sits next to EVAL_SPEND in the company's setup partition; only the broker writes it, when setup proposes the eval
// spend item, and the item's own digest (the one approved) covers it. A plan not bound to an approved digest, another company's, or edited after approval is refused. End to end, the
// signed `eval-plan` callback delivers it to one CHECKS run, and the worker completes it from the pinned candidate. Every trust check has a test that fails without it.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EVAL_PLAN_DELIVERY_ACTION, EvalPlanDeliverySchema, createDocumentBaseScoreCache, evalBaseCacheKey, evalCodeHash, evalCommandFingerprint, evalPlanDigest, evalQuestionHash, evalSpendDigest, evalSpendInputsDigest,
  type Approvers, type EvalBaseRecord, type EvalPlanBody, type EvalReservationAdapter, type EvalSpendApprovalRecord, type EvalSpendPlan, type Principal,
} from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createNoopAuditSink } from "../../packages/broker/src/ports/policy-defaults.js";
import { createDecisionGate, type DecisionAttempt } from "../../packages/broker/src/core/decisions/approval-gate.js";
import { EVAL_SPEND_KIND, createEvalSpendSubject, evalPlanKey, evalSpendKey, proposeEvalSpendApproval, readApprovedEvalPlan } from "../../packages/broker/src/core/setup-agent/eval-spend.js";
import { createEvalPlanSources } from "../../packages/broker/src/core/setup-agent/eval-plan-source.js";
import { setupPartition } from "../../packages/broker/src/core/setup-agent/keys.js";
import type { SessionMembers } from "../../packages/broker/src/core/sessions/access.js";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import { createCallbackHandler } from "../../packages/broker/src/services/callbacks.js";
import { CallbackCapabilities } from "../../packages/broker/src/callbacks.js";
import { operationKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { EVAL_PLAN_ASK_TIMEOUT_MS, evalPlanSourcesFor } from "../../packages/worker/src/verification/eval-wiring.js";
import { withEvalPinnedCandidate } from "../../packages/worker/src/verification/eval-plan-source.js";
import { runFinalCheckEval } from "../../packages/worker/src/verification/eval-final-check.js";
import { evalSettingsFingerprint } from "../../packages/worker/src/verification/eval-round.js";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";

const A = COMPANY_A.orgId;
const B = COMPANY_B.orgId;
const project = "demo";
const now = "2026-11-16T05:00:00.000Z";
const settings = { imageDigest: "sha256:" + "e".repeat(64), route: "gateway" };
const judgePin = "b".repeat(64);
const inputs = { evalSetHash: "a".repeat(64), judgePin, modelVersion: "version-1", model: "model", catalogRowId: "model", commandFingerprint: evalCommandFingerprint("npm run eval"), settingsFingerprint: evalSettingsFingerprint(settings, judgePin) };
const Q1 = "question one\n"; const Q2 = "question two\n";
const spendPlan = (): Omit<EvalSpendPlan, "evalPlanDigest"> => ({ selection: "evals/demo", inputs: { ...inputs }, estimate: { calls: 6, costMicros: 60 }, budget: { usual: { calls: 6, costMicros: 60 }, maximum: { calls: 400, costMicros: 4_000_000 } } });
const evalPlan = (over: Partial<EvalPlanBody> = {}): EvalPlanBody => ({
  selection: "evals/demo", inputs: { ...inputs }, key: { commandFingerprint: inputs.commandFingerprint, catalogRowId: "model", model: "model", modelVersion: "version-1" }, settings,
  evalSetHash: inputs.evalSetHash, evalConfigured: true, judgePin, baselineJudgePin: judgePin, subsetSupported: true,
  questions: [{ id: "q1", category: "ordinary", path: "evals/demo/q1.txt", hash: evalQuestionHash(Buffer.from(Q1)) }, { id: "q2", category: "safety", path: "evals/demo/q2.txt", hash: evalQuestionHash(Buffer.from(Q2)) }],
  maxCallsPerQuestion: 2, maxCostMicrosPerQuestion: 10, ...over,
});
const BASE = "c".repeat(40);
/** A registry with `adapter` (or nothing) bound at the `eval-reservation` plug-in point. */
const registryWith = (adapter?: EvalReservationAdapter) => ({ names: (point: string) => point === "eval-reservation" && adapter !== undefined ? ["test"] : [], get: () => adapter }) as never;
const run = (bases: Array<{ repositoryId: string; baseCommitSha: string }> | undefined = [{ repositoryId: "web", baseCommitSha: BASE }]) => ({ bases });

/** One company's setup table, decision gate and spend approvals, over a store that may be shared with another company. */
function company(companyId: string, store = new MemoryDocumentStore()) {
  const principal: Principal = { companyId, personId: "person", roles: ["owner"], provider: "test-identity", displayName: "Test" };
  const members: SessionMembers = {
    companyRole: p => p.companyId === companyId && p.developerId === developerIdOf(principal) ? "owner" : undefined,
    projectGrant: () => undefined,
  };
  const logs: string[] = [];
  const deps = { store, companyId, members, monthlyCapMicros: 50_000_000, log: (event: string) => { logs.push(event); } };
  const approvers: Approvers = { requirement: async () => ({ methods: ["local-session"], minApprovers: 1, selfApprovalAllowed: true }), verify: async (_request, proof) => ({ approved: true, approver: principal, method: proof.method, proofId: proof.proofId }) };
  const gate = createDecisionGate({ store, approvers, audit: createNoopAuditSink(), subjects: [createEvalSpendSubject(deps)], now: () => new Date(now) });
  const attempt = (row: EvalSpendApprovalRecord, outcome: "approve" | "reject" = "approve"): DecisionAttempt => ({ companyId, kind: EVAL_SPEND_KIND, subjectId: project, requestId: `eval-decision-${row.revision}-${outcome}`, outcome, seen: { revision: row.revision, artifactDigest: row.digest }, credentials: [{ method: "local-session", token: ["fake", "session"].join("-") }] });
  /** `null` proposes the item with no plan (today's callers). */
  const propose = (plan: EvalPlanBody | null = evalPlan()) => proposeEvalSpendApproval(deps, project, spendPlan(), plan ?? undefined);
  const decide = async (row: EvalSpendApprovalRecord, outcome: "approve" | "reject" = "approve") => { expect((await gate.decide(attempt(row, outcome))).status).toBe("decided"); };
  const approve = async (plan: EvalPlanBody | null = evalPlan()) => { const row = await propose(plan); await decide(row); return row; };
  const adapter: EvalReservationAdapter = {
    async authority(request) { return request.company === companyId ? { company: companyId, project: request.project, principal, provider: "customer", connected: true } : undefined; },
    async reserve() { return undefined; },
  };
  const read = () => readApprovedEvalPlan(deps, project);
  return { store, deps, members, logs, principal, propose, decide, approve, read, adapter };
}
const stored = async (store: MemoryDocumentStore, companyId: string) => store.get(evalPlanKey(companyId, project));
const rewrite = async (store: MemoryDocumentStore, companyId: string, edit: (row: Record<string, unknown>) => Record<string, unknown>) => {
  const row = (await stored(store, companyId))!;
  await store.put({ item: { ...edit(structuredClone(row)), pk: row.pk, sk: row.sk } });
};

describe("the EVAL_PLAN writer", () => {
  it("writes the plan next to EVAL_SPEND in the company's setup partition and binds it by the item's digest (the approval covers the plan)", async () => {
    const a = company(A);
    const row = await a.propose();
    const plan = evalPlan();
    const digest = evalPlanDigest(A, project, plan);
    expect(row.plan.evalPlanDigest).toBe(digest);
    expect(row.digest).toBe(evalSpendDigest(A, project, { ...spendPlan(), evalPlanDigest: digest }));
    // The approved digest differs from an item with no plan: approving it approves this plan.
    expect(row.digest).not.toBe(evalSpendDigest(A, project, spendPlan()));
    const record = await stored(a.store, A);
    expect(evalPlanKey(A, project)).toEqual({ pk: setupPartition(A, project), sk: "EVAL_PLAN" });
    expect(evalPlanKey(A, project).pk).toBe(evalSpendKey(A, project).pk);
    expect(evalPlanKey(A, project).pk).toContain(A);
    expect(record).toEqual({ ...evalPlanKey(A, project), entityType: "EVAL_PLAN", schemaVersion: 1, company: A, project, planDigest: digest, spendDigest: row.digest, plan });
  });

  it("never takes a caller's plan digest, and refuses a plan that does not match the item (mutants: the digest is the broker's, the selection and inputs match)", async () => {
    const a = company(A);
    const row = await proposeEvalSpendApproval(a.deps, project, { ...spendPlan(), evalPlanDigest: "9".repeat(64) } as never, evalPlan());
    expect(row.plan.evalPlanDigest).toBe(evalPlanDigest(A, project, evalPlan()));
    // With no plan, a caller's digest would make the item claim a plan it does not have: it is dropped.
    const none = company(A);
    expect((await proposeEvalSpendApproval(none.deps, project, { ...spendPlan(), evalPlanDigest: "9".repeat(64) } as never)).plan.evalPlanDigest).toBeUndefined();
    const b = company(A);
    await expect(b.propose(evalPlan({ selection: "evals/other" }))).rejects.toThrow("does not match");
    await expect(b.propose(evalPlan({ inputs: { ...inputs, model: "other-model" } }))).rejects.toThrow("does not match");
    expect(await stored(b.store, A)).toBeUndefined();
    expect(await b.store.get(evalSpendKey(A, project))).toBeUndefined();
  });

  it("an item proposed without a plan writes no plan (today's callers), and a stale plan of an older item is not its plan", async () => {
    const a = company(A);
    await a.approve();
    expect(await a.read()).toBeDefined();
    const legacy = await a.propose(null);
    expect(legacy.plan.evalPlanDigest).toBeUndefined();
    await a.decide(legacy);
    expect(await a.read()).toBeUndefined();
  });

  it("re-proposing the same item rewrites a lost plan row with exactly the approved content; a changed plan asks again", async () => {
    const a = company(A);
    const row = await a.approve();
    await a.store.transact([{ kind: "delete", key: evalPlanKey(A, project) }]);
    expect(await a.read()).toBeUndefined();
    expect((await a.propose()).digest).toBe(row.digest);
    expect((await a.read())?.plan).toEqual(evalPlan());
    // A changed plan is a changed item: waiting again, and the old approval covers nothing.
    const changed = await a.propose(evalPlan({ maxCostMicrosPerQuestion: 11 }));
    expect(changed.digest).not.toBe(row.digest);
    expect(changed.state).toBe("waiting");
    expect(await a.read()).toBeUndefined();
    await a.decide(changed);
    expect((await a.read())?.plan.maxCostMicrosPerQuestion).toBe(11);
  });
  it("the lost-row rewrite happens only while the item is still the same one: a newer proposal in between stops it (mutant: the transact check)", async () => {
    const a = company(A);
    await a.approve();
    await a.store.transact([{ kind: "delete", key: evalPlanKey(A, project) }]);
    // Between the short-circuit's read of the plan row and its write, another proposal replaces the item.
    const get = a.store.get.bind(a.store);
    let raced = false;
    a.store.get = async (key) => {
      const found = await get(key);
      if (!raced && key.sk === "EVAL_PLAN") {
        raced = true;
        const item = (await get(evalSpendKey(A, project)))!;
        await a.store.put({ item: { ...item, revision: (item["revision"] as number) + 1 } });
      }
      return found;
    };
    await expect(a.propose()).rejects.toThrow("changed");
    expect(await stored(a.store, A)).toBeUndefined();
  });
});

describe("the EVAL_PLAN reader refuses what is not bound to an approved digest", () => {
  it("only an approved item's plan is read: none while waiting or after a rejection (mutant: the approved-state check)", async () => {
    const a = company(A);
    const row = await a.propose();
    expect(await a.read()).toBeUndefined();
    await a.decide(row, "reject");
    expect(await a.read()).toBeUndefined();
    const b = company(A);
    await b.approve();
    const found = await b.read();
    expect(found?.plan).toEqual(evalPlan());
    expect(found?.spend.state).toBe("approved");
    expect(found?.spend.digest).toBe((await b.store.get(evalSpendKey(A, project)))!["digest"]);
  });

  it("a forged plan is refused: no item, an item that names another plan, a wrong item digest, an item with no plan (mutants: each binding)", async () => {
    // No item at all: a plan row written directly is nothing.
    const lone = company(A);
    const body = evalPlan();
    await lone.store.put({ item: { ...evalPlanKey(A, project), entityType: "EVAL_PLAN", schemaVersion: 1, company: A, project, planDigest: evalPlanDigest(A, project, body), spendDigest: "1".repeat(64), plan: body } as never });
    expect(await lone.read()).toBeUndefined();
    // An approved item, then a forged plan with a correct digest of its own body: the item names another plan.
    const a = company(A);
    await a.approve();
    const forged = evalPlan({ maxCallsPerQuestion: 50 });
    await rewrite(a.store, A, row => ({ ...row, plan: forged, planDigest: evalPlanDigest(A, project, forged) }));
    expect(await a.read()).toBeUndefined();
    expect(a.logs).toContain("eval_plan_invalid");
    // The right plan but a wrong item digest.
    const c = company(A);
    await c.approve();
    await rewrite(c.store, A, row => ({ ...row, spendDigest: "2".repeat(64) }));
    expect(await c.read()).toBeUndefined();
    // An item approved with no plan, and a plan row beside it: the item covers no plan.
    const d = company(A);
    await d.approve(null);
    await d.store.put({ item: { ...evalPlanKey(A, project), entityType: "EVAL_PLAN", schemaVersion: 1, company: A, project, planDigest: evalPlanDigest(A, project, body), spendDigest: (await d.store.get(evalSpendKey(A, project)))!["digest"], plan: body } as never });
    expect(await d.read()).toBeUndefined();
  });

  it("a plan edited after approval is refused: a field changed under its old digest, or with a recomputed digest (mutants: the recomputed digest, the item's plan digest, selection, inputs)", async () => {
    for (const edit of [
      (row: Record<string, unknown>) => ({ ...row, plan: { ...(row["plan"] as EvalPlanBody), maxCostMicrosPerQuestion: 9_999 } }),
      (row: Record<string, unknown>) => ({ ...row, plan: { ...(row["plan"] as EvalPlanBody), questions: [] } }),
      (row: Record<string, unknown>) => ({ ...row, plan: { ...(row["plan"] as EvalPlanBody), evalConfigured: false } }),
      (row: Record<string, unknown>) => { const plan = { ...(row["plan"] as EvalPlanBody), baselineJudgePin: "d".repeat(64) }; return { ...row, plan, planDigest: evalPlanDigest(A, project, plan) }; },
      (row: Record<string, unknown>) => { const plan = { ...(row["plan"] as EvalPlanBody), selection: "evals/other" }; return { ...row, plan, planDigest: evalPlanDigest(A, project, plan) }; },
      (row: Record<string, unknown>) => { const plan = { ...(row["plan"] as EvalPlanBody), inputs: { ...inputs, modelVersion: "version-2" } }; return { ...row, plan, planDigest: evalPlanDigest(A, project, plan) }; },
    ]) {
      const a = company(A);
      await a.approve();
      await rewrite(a.store, A, edit);
      expect(await a.read()).toBeUndefined();
    }
  });

  it("a valid item of this company next to a plan row that names another company is refused (mutants: the row's company and project checks, with the digest binding)", async () => {
    for (const [company_, project_] of [[B, project], [A, "other"]] as const) {
      const a = company(A);
      await a.approve();
      await rewrite(a.store, A, row => ({ ...row, company: company_, project: project_, planDigest: evalPlanDigest(company_, project_, row["plan"] as EvalPlanBody) }));
      expect(await a.read()).toBeUndefined();
    }
  });

  it("an edited ITEM is refused too: its plan digest changed after approval breaks its own digest", async () => {
    const a = company(A);
    await a.approve();
    const item = (await a.store.get(evalSpendKey(A, project)))!;
    await a.store.put({ item: { ...item, plan: { ...(item["plan"] as Record<string, unknown>), evalPlanDigest: "3".repeat(64) } } });
    expect(await a.read()).toBeUndefined();
  });

  it("cross-company: B never reads A's plan; A's rows copied into B's partition are refused; each source answers only its own company (mutants: the company checks)", async () => {
    const store = new MemoryDocumentStore();
    const a = company(A, store); const b = company(B, store);
    await a.approve();
    expect(await a.read()).toBeDefined();
    expect(await b.read()).toBeUndefined();
    // A's item and plan copied verbatim into B's partition still name A.
    for (const key of [evalSpendKey, evalPlanKey]) {
      const row = (await store.get(key(A, project)))!;
      await store.put({ item: { ...row, ...key(B, project) } });
    }
    expect(await b.read()).toBeUndefined();
    // Re-labelled for B, the digests (bound to A) no longer match.
    await rewrite(store, B, row => ({ ...row, company: B }));
    const item = (await store.get(evalSpendKey(B, project)))!;
    await store.put({ item: { ...item, company: B } });
    expect(await b.read()).toBeUndefined();
    const sourcesA = createEvalPlanSources({ store, companyId: A, registry: registryWith(a.adapter) });
    expect(await sourcesA.plan({ companyId: B, project }, run())).toBeUndefined();
    expect(sourcesA.approval({ companyId: B, project })).toBeUndefined();
    expect(sourcesA.cache(B)).toBeUndefined();
    expect(await createEvalPlanSources({ store, companyId: B, registry: registryWith(b.adapter) }).plan({ companyId: B, project }, run())).toBeUndefined();
    expect(JSON.stringify(await sourcesA.plan({ companyId: A, project }, run()))).not.toContain(B);
  });
});

describe("the broker's eval plan source", () => {
  it("answers the approved plan with the run's own base in the key, only for a base it can name (mutants: the base choice)", async () => {
    const a = company(A);
    await a.approve();
    const sources = createEvalPlanSources({ store: a.store, companyId: A, registry: registryWith() });
    expect(await sources.plan({ companyId: A, project }, run())).toEqual({
      company: A, project, ...(({ key, ...rest }) => { void key; return rest; })(evalPlan()), planDigest: evalPlanDigest(A, project, evalPlan()),
      key: { company: A, project, baseCommit: BASE, codeHash: evalCodeHash(BASE), judgePin, commandFingerprint: inputs.commandFingerprint, catalogRowId: "model", model: "model", modelVersion: "version-1" },
    });
    expect(await sources.plan({ companyId: A, project }, { bases: undefined })).toBeUndefined();
    expect(await sources.plan({ companyId: A, project }, run([{ repositoryId: "web", baseCommitSha: "not-a-commit" }]))).toBeUndefined();
    expect(await sources.plan({ companyId: A, project }, run([{ repositoryId: "web", baseCommitSha: BASE }, { repositoryId: "api", baseCommitSha: "d".repeat(40) }]))).toBeUndefined();
    const named = company(A);
    await named.approve(evalPlan({ repository: "api" }));
    const namedSources = createEvalPlanSources({ store: named.store, companyId: A, registry: registryWith() });
    expect(((await namedSources.plan({ companyId: A, project }, run([{ repositoryId: "web", baseCommitSha: BASE }, { repositoryId: "api", baseCommitSha: "d".repeat(40) }]))) as { key: { baseCommit: string } }).key.baseCommit).toBe("d".repeat(40));
    expect(await namedSources.plan({ companyId: A, project }, run())).toBeUndefined();
  });

  it("spend authority comes only from the registry's bound eval-reservation adapter: Code (none) answers no approval; a bound adapter answers the grant for this plan (mutant: the adapter check)", async () => {
    const a = company(A);
    await a.approve();
    expect(await createEvalPlanSources({ store: a.store, companyId: A, members: a.members, registry: registryWith() }).approval({ companyId: A, project })!.read()).toBeUndefined();
    const grant = await createEvalPlanSources({ store: a.store, companyId: A, members: a.members, registry: registryWith(a.adapter) }).approval({ companyId: A, project })!.read();
    expect(grant).toMatchObject({ company: A, project, selection: "evals/demo", inputsDigest: evalSpendInputsDigest(inputs), provider: "customer", connected: true, maxCalls: 6, maxCostMicros: 60 });
    // The approval follows the plan's binding: an edited plan withdraws it.
    await rewrite(a.store, A, row => ({ ...row, plan: { ...(row["plan"] as EvalPlanBody), maxCallsPerQuestion: 99 } }));
    expect(await createEvalPlanSources({ store: a.store, companyId: A, members: a.members, registry: registryWith(a.adapter) }).approval({ companyId: A, project })!.read()).toBeUndefined();
  });
});

// ---- End to end: the broker's callback, the worker's ask, the pinned candidate, the final-check eval ----

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))); });
const g = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
async function candidate(base: Record<string, string>, head: Record<string, string>) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "eps-e2e-"))); roots.push(dir);
  g(dir, "init", "-q");
  for (const [p, c] of Object.entries(base)) { await mkdir(dirname(join(dir, p)), { recursive: true }); await writeFile(join(dir, p), c); }
  g(dir, "add", "-A"); g(dir, "commit", "-qm", "base"); const baseSha = g(dir, "rev-parse", "HEAD");
  for (const [p, c] of Object.entries(head)) { await mkdir(dirname(join(dir, p)), { recursive: true }); await writeFile(join(dir, p), c); }
  g(dir, "add", "-A"); g(dir, "commit", "-qm", "head", "--allow-empty");
  return { baseSha, repositories: [{ repositoryId: "web", directory: dir, baseCommitSha: baseSha }], candidates: [{ repositoryId: "web", commitSha: g(dir, "rev-parse", "HEAD"), treeSha: g(dir, "rev-parse", "HEAD^{tree}"), baseCommitSha: baseSha }] };
}
const KEY = Buffer.alloc(32, 9);
const EVAL_REQUEST = { aiChange: true, reason: "eval_hint", evalPass: 1, callsAlreadyUsed: 0, costAlreadyUsedMicros: 0 } as const;
const RECORD: EvalBaseRecord = { schemaVersion: 1, measures: [{ name: "accuracy", unit: "fraction", value: 0.8, direction: "up_good", spread: 0.04, count: 2 }], questions: [{ id: "q1", samples: [{ pass: true, answer: "a" }, { pass: true, answer: "a" }, { pass: true, answer: "a" }] }, { id: "q2", samples: [{ pass: true, answer: "b" }, { pass: true, answer: "b" }, { pass: true, answer: "b" }] }], caseCount: 2, recordedOn: "2026-11-16", roundKind: "check_unsealed", runnerSchemaVersion: 1 };

async function endToEnd(options: { adapter?: boolean; head?: Record<string, string>; base?: Record<string, string> } = {}) {
  const repo = await candidate(options.base ?? { "evals/demo/q1.txt": Q1, "evals/demo/q2.txt": Q2 }, options.head ?? { "src/app.ts": "changed\n" });
  const a = company(A);
  await a.approve();
  const store = a.store;
  const workspaceId = randomUUID(); const operationId = randomUUID(); const taskId = randomUUID();
  await store.put({ item: { ...workspaceKey(A, workspaceId), entityType: "WORKSPACE", id: workspaceId, companyId: A } });
  await store.put({ item: { ...operationKey(A, workspaceId, operationId), entityType: "OPERATION", id: operationId, workspaceId, kind: "task", workflowMode: "CHECKS", status: "RUNNING", fence: 3, companyId: A,
    dispatch: { kind: "task", payload: { workflowMode: "CHECKS", evalRequest: EVAL_REQUEST, workflowBase: [{ repositoryId: "web", baseCommitSha: repo.baseSha }] } } } });
  await store.put({ item: { ...(await workspaceKeys({ store, companyId: A }, workspaceId)).taskPointerKey(), taskId } });
  await store.put({ item: { ...taskKey(taskId), taskId, workspaceId, project, companyId: A } });
  // The company's base score for this plan's key at this base, as Rovara's own base round saved it.
  const parts = { company: A, project, baseCommit: repo.baseSha, codeHash: evalCodeHash(repo.baseSha), judgePin, commandFingerprint: inputs.commandFingerprint, catalogRowId: "model", model: "model", modelVersion: "version-1", evalSetHash: inputs.evalSetHash, hiddenSetHash: "none", settingsFingerprint: inputs.settingsFingerprint };
  await createDocumentBaseScoreCache(store, { companyId: A }).write(parts, RECORD, { writer: "rovara_base_round", baseCommit: repo.baseSha });
  const handler = createCallbackHandler({ flow: { store, companyId: A, callbackSigningKey: KEY } as never, blobs: {} as never, grants: {} as never,
    evalPlan: createEvalPlanSources({ store, companyId: A, members: a.members, registry: registryWith(options.adapter === true ? a.adapter : undefined) }) });
  const capability = new CallbackCapabilities(KEY).issue({ workspaceId, operationId, fence: 3, actions: [EVAL_PLAN_DELIVERY_ACTION], expiresInSeconds: 60 });
  const asks: string[] = [];
  // The worker's fetch reaches the broker's callback handler directly (no network).
  const fetchToBroker = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname; asks.push(path);
    const reply = await handler({ method: "POST", path, headers: { "x-agentx-callback-capability": String((init?.headers as Record<string, string>)["x-agentx-callback-capability"]) }, body: typeof init?.body === "string" ? init.body : "" });
    return new Response(reply.body ?? "", { status: reply.statusCode, headers: reply.headers });
  }) as typeof fetch;
  const sources = evalPlanSourcesFor({ workspaceId, operationId, callbackCapability: capability }, { controlPlaneUrl: "http://broker.invalid", fetch: fetchToBroker });
  return { repo, sources, asks, parts, handler, capability, workspaceId, operationId, store };
}
const facts = () => ({ status: "verified", candidateDigest: "9".repeat(64), signal: new AbortController().signal });

describe("end to end: the signed eval-plan route, the worker's pinned hashes and the final-check eval", () => {
  it("happy path: the stored, approved plan reaches the run with its baseline; the worker's hashes match; with no adapter Code reads spend not approved, with zero calls", async () => {
    const e = await endToEnd({ head: { "evals/demo/q2.txt": "question two, edited\n" } });
    const plan = await withEvalPinnedCandidate(e.repo.repositories, e.repo.candidates, new AbortController().signal, () => e.sources.plan());
    expect(plan).toMatchObject({ company: A, project, selection: "evals/demo", key: { baseCommit: e.repo.baseSha, codeHash: evalCodeHash(e.repo.baseSha) },
      questions: [{ id: "q1", baseHash: evalQuestionHash(Buffer.from(Q1)), headHash: evalQuestionHash(Buffer.from(Q1)) }, { id: "q2", baseHash: evalQuestionHash(Buffer.from(Q2)), headHash: evalQuestionHash(Buffer.from("question two, edited\n")) }] });
    // One ask per invocation, to this operation's own eval-plan route.
    expect(await e.sources.cache.read(e.parts)).toEqual(RECORD);
    expect(e.asks).toEqual([`/v1/internal/workspaces/${e.workspaceId}/operations/${e.operationId}/${EVAL_PLAN_DELIVERY_ACTION}`]);
    expect(await e.sources.approval.read()).toBeUndefined();
    let calls = 0;
    const ports = { roundKind: "check_unsealed" as const, ...e.sources, meter: { reserve: async () => { calls++; return undefined; } }, runner: async () => { calls++; throw new Error("no run"); } };
    const artifact = await withEvalPinnedCandidate(e.repo.repositories, e.repo.candidates, new AbortController().signal, () => runFinalCheckEval(EVAL_REQUEST, ports, facts()));
    expect(artifact).toMatchObject({ outcome: "not_run", notRunReason: "spend_not_approved", evalConfigured: true });
    expect(calls).toBe(0);
  });

  it("with a trusted adapter the grant covers exactly this plan, and the eval passes the approval gate (the fake meter then holds nothing)", async () => {
    const e = await endToEnd({ adapter: true });
    const grant = await e.sources.approval.read();
    expect(grant).toMatchObject({ company: A, project, selection: "evals/demo", inputsDigest: evalSpendInputsDigest(inputs) });
    const ports = { roundKind: "check_unsealed" as const, ...e.sources, meter: { reserve: async () => undefined }, runner: async () => { throw new Error("no run"); } };
    const artifact = await withEvalPinnedCandidate(e.repo.repositories, e.repo.candidates, new AbortController().signal, () => runFinalCheckEval(EVAL_REQUEST, ports, facts()));
    expect(artifact?.outcome).toBe("not_run");
    expect(["spend_not_approved", "not_connected"]).not.toContain(artifact?.notRunReason);
  });

  it("a base whose question differs from the approved plan is not runnable: no plan, so not connected, zero calls (mutant: the worker's base hash check)", async () => {
    const e = await endToEnd({ adapter: true, base: { "evals/demo/q1.txt": "changed on main\n", "evals/demo/q2.txt": Q2 } });
    const ports = { roundKind: "check_unsealed" as const, ...e.sources, meter: { reserve: async () => { throw new Error("must not hold"); } }, runner: async () => { throw new Error("must not run"); } };
    const artifact = await withEvalPinnedCandidate(e.repo.repositories, e.repo.candidates, new AbortController().signal, () => runFinalCheckEval(EVAL_REQUEST, ports, facts()));
    expect(artifact).toMatchObject({ outcome: "not_run", notRunReason: "not_connected" });
  });

  it("the one ask is bounded: it carries an abort signal, and an aborted (timed-out) ask reads as no plan, no grant and a cache miss", async () => {
    const seen: Array<AbortSignal | null | undefined> = [];
    const hung = (async (_url: string | URL, init?: RequestInit) => {
      seen.push(init?.signal);
      return await new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener("abort", () => { reject(new Error("aborted")); }); });
    }) as typeof fetch;
    const invocation = { workspaceId: randomUUID(), operationId: randomUUID(), callbackCapability: "c".repeat(40) };
    const sources = evalPlanSourcesFor(invocation, { controlPlaneUrl: "http://broker.invalid", fetch: hung });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const read = sources.approval.read();
      await vi.advanceTimersByTimeAsync(EVAL_PLAN_ASK_TIMEOUT_MS + 1);
      expect(await read).toBeUndefined();
    } finally { vi.useRealTimers(); }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });

  it("delivery is EVAL_PLAN-bound: the route answers the approved plan with its baseline, and an edited stored plan is answered not_available", async () => {
    const e = await endToEnd();
    const ask = async () => EvalPlanDeliverySchema.parse(JSON.parse((await e.handler({ method: "POST", path: `/v1/internal/workspaces/${e.workspaceId}/operations/${e.operationId}/${EVAL_PLAN_DELIVERY_ACTION}`, headers: { "x-agentx-callback-capability": e.capability }, body: "{}" })).body ?? "{}"));
    const before = await ask();
    expect(before.status).toBe("ready");
    if (before.status === "ready") { expect(before.baseline).toEqual({ key: evalBaseCacheKey(e.parts), record: RECORD, measurement: "idle" }); expect(before.approval).toBeNull(); }
    await rewrite(e.store, A, row => ({ ...row, plan: { ...(row["plan"] as EvalPlanBody), maxCostMicrosPerQuestion: 1_000_000 } }));
    expect(await ask()).toEqual({ status: "not_available" });
  });
});
