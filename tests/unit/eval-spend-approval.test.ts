import { describe, expect, it } from "vitest";
import { attestRovaraOnlyBaseCheckout, type Approvers, type Principal, type EvalReservationAdapter, type EvalSpendPlan, type EvalSpendApprovalRecord } from "@agentx/contracts";
import { createDocumentBaseScoreCache, evalCommandFingerprint } from "../../packages/contracts/src/eval-base-cache.js";
import { evalSpendInputsDigest, evalSpendDigest, EVAL_DEFAULT_CALL_BUDGET, EVAL_DEFAULT_COST_BUDGET_MICROS } from "../../packages/contracts/src/eval-spend.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createNoopAuditSink } from "../../packages/broker/src/ports/policy-defaults.js";
import { createDecisionGate, type DecisionAttempt } from "../../packages/broker/src/core/decisions/approval-gate.js";
import { createSetupProposalSubject, setupApplyDigest } from "../../packages/broker/src/core/setup-agent/apply.js";
import { createEvalSpendSubject, proposeEvalSpendApproval, readEvalSpendItem, evalSpendKey, createEvalSpendCapabilities, EVAL_SPEND_KIND } from "../../packages/broker/src/core/setup-agent/eval-spend.js";
import { runEvalHealth, type EvalHealthInput } from "../../packages/worker/src/verification/eval-health.js";
import { createEvalBaselines } from "../../packages/worker/src/verification/eval-baseline-refresh.js";
import { evalSettingsFingerprint } from "../../packages/worker/src/verification/eval-round.js";
import { renderSetupPage } from "../../packages/broker/src/core/local-pages/setup-page.js";
import type { SessionMembers } from "../../packages/broker/src/core/sessions/access.js";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import type { ModelEgressFrame } from "../../packages/contracts/src/model-egress/frame.js";

const company = "org_aaaaaaaaaaaaaaaaaaaa";
const other = "org_bbbbbbbbbbbbbbbbbbbb";
const project = "demo";
const now = "2026-11-14T05:00:00.000Z";
const settings = { imageDigest: "image", route: "customer" };
const inputs = { evalSetHash: "a".repeat(64), judgePin: "b".repeat(64), modelVersion: "version-1", model: "model", catalogRowId: "model", commandFingerprint: evalCommandFingerprint("eval"), settingsFingerprint: evalSettingsFingerprint(settings, "b".repeat(64)) };
const plan = (): EvalSpendPlan => ({ selection: "evals/demo", inputs: { ...inputs }, estimate: { calls: 6, costMicros: 60 }, budget: { usual: { calls: 6, costMicros: 60 }, maximum: { calls: 400, costMicros: 4_000_000 } } });
const person = (role = "maintainer", companyId = company): Principal => ({ companyId, personId: "person", roles: [role === "maintainer" ? "member" : role], provider: "test-identity", displayName: "Test" });

function world(role = "maintainer") {
  const store = new MemoryDocumentStore();
  const state = { principal: person(role), current: plan(), connected: true, provider: "customer", authorityCompany: company, authorityProject: project, remainingCalls: 100, remainingCost: 1000, denied: false, grants: new Set(role === "maintainer" ? [project] : []) };
  const logs: string[] = [];
  const members: SessionMembers = {
    companyRole: p => p.companyId === state.principal.companyId && p.developerId === developerIdOf(state.principal) ? state.principal.roles[0] as "owner" | "admin" | "member" | "auditor" : undefined,
    projectGrant: (p, name) => p.companyId === state.principal.companyId && p.developerId === developerIdOf(state.principal) && state.grants.has(name) ? "maintainer" : undefined,
  };
  const deps = { store, companyId: company, members, monthlyCapMicros: 50_000_000, log: (event: string) => { logs.push(event); } };
  const ledger: Array<{ company: string; project: string; provider: string }> = [];
  const holds: Array<{ calls: number; costMicros: number; approval: EvalSpendApprovalRecord }> = [];
  const approvers: Approvers = { requirement: async () => ({ methods: ["local-session"], minApprovers: 1, selfApprovalAllowed: true }), verify: async (_request, proof) => ({ approved: true, approver: state.principal, method: proof.method, proofId: proof.proofId }) };
  const subject = createEvalSpendSubject(deps);
  const gate = createDecisionGate({ store, approvers, audit: createNoopAuditSink(), subjects: [subject], now: () => new Date(now) });
  // The fake adapter owns the payer and atomic monthly hold. No product meter or provider is used.
  const adapter: EvalReservationAdapter = {
    async authority(request) { if (request.company !== company || request.project !== project) return undefined; return { company: state.authorityCompany, project: state.authorityProject, principal: state.principal, provider: state.provider, connected: state.connected }; },
    async reserve(request) {
      if (!await request.revalidate() || state.denied || request.calls > state.remainingCalls || request.costMicros > state.remainingCost) return undefined;
      state.remainingCalls -= request.calls; state.remainingCost -= request.costMicros;
      holds.push({ calls: request.calls, costMicros: request.costMicros, approval: request.approval });
      return { call: async () => {
        if (!await request.revalidate()) throw new Error("refused");
        ledger.push({ company: request.approval.company, project: request.approval.project, provider: "customer" });
        return { class: "ok", calls: 1, costMicros: 10 };
      }, close: async () => {} };
    },
  };
  const capabilities = (bound: EvalReservationAdapter | undefined = adapter) => createEvalSpendCapabilities({ ...deps, project, current: async () => state.current, ...(bound === undefined ? {} : { adapter: bound }) });
  const input = (caps = capabilities()): EvalHealthInput => ({ key: { company, project, ...inputs, baseCommit: "c".repeat(40), codeHash: "d".repeat(64), hiddenSetHash: "none" }, settings, selection: state.current.selection, questionIds: ["one", "two"], maxCallsPerQuestion: 1, maxCostMicrosPerQuestion: 10, ...caps, cache: createDocumentBaseScoreCache(store, { companyId: company }), run: async ({ call }) => {
    await call({} as ModelEgressFrame); await call({} as ModelEgressFrame);
    return { attestation: attestRovaraOnlyBaseCheckout({ baseCommit: "c".repeat(40) }), seconds: 1, measures: { schemaVersion: 1, source: "project_runner", eval_set_hash: inputs.evalSetHash, measures: [{ name: "pass", value: 0, direction: "up_good", unit: "fraction" }], questions: ["one", "two"].map(id => ({ id, samples: [{ pass: false, answer: "failed" }] })) } };
  } });
  const propose = () => proposeEvalSpendApproval(deps, project, state.current);
  const attempt = (row: EvalSpendApprovalRecord): DecisionAttempt => ({ companyId: company, kind: EVAL_SPEND_KIND, subjectId: project, requestId: `eval-decision-${row.revision}`, outcome: "approve", seen: { revision: row.revision, artifactDigest: row.digest }, credentials: [{ method: "local-session", token: ["fake", "session"].join("-") }] });
  const approve = async () => { const row = await propose(); expect((await gate.decide(attempt(row))).status).toBe("decided"); return row; };
  return { store, deps, state, logs, members, ledger, holds, subject, gate, adapter, capabilities, input, propose, attempt, approve };
}

async function refused(w: ReturnType<typeof world>, input = w.input()) {
  const result = await runEvalHealth(input);
  expect(result.status).toBe("not_run");
  if (result.status === "not_run") expect(result.message).toContain("Not run:");
  expect(w.ledger).toEqual([]); expect(w.holds).toEqual([]);
}

it.each(["owner", "admin", "maintainer"])("reconciles %s approval with cross-host measuring and a later task", async role => {
  const w = world(role);
  expect(await createEvalBaselines().forTask(w.input())).toBe("awaiting_confirmation");
  expect(w.holds).toEqual([]); expect(w.ledger).toEqual([]);
  await w.approve();
  const input = w.input(); const run = input.run.bind(input);
  let entered!: () => void; let release!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  input.run = async request => { entered(); await gate; return run(request); };
  const setup = createEvalBaselines().afterMerge(input);
  try {
    await Promise.race([began, setup.then(() => { throw new Error("measurement never started"); })]);
    expect(await createEvalBaselines().forTask(w.input())).toBe("measuring");
    expect(await createEvalBaselines().afterMerge(w.input())).toEqual({ status: "measuring" });
    expect(w.holds).toHaveLength(1); expect(w.ledger).toEqual([]);
  } finally { release(); await setup; }
  expect(await setup).toMatchObject({ status: "measured", baseline: "stored" });
  expect(await createEvalBaselines().forTask(w.input())).toBe("ready");
  expect(w.holds).toHaveLength(1); expect(w.ledger).toHaveLength(6);
});

it.each(["stale approver", "corrupt row", "changed inputs", "monthly denial"])("finishes a refused baseline with F3e's %s guard intact", async mode => {
  const w = world(); await w.approve(); const input = w.input();
  if (mode === "stale approver") w.state.grants.clear();
  if (mode === "corrupt row") {
    const key = evalSpendKey(company, project); const row = (await w.store.get(key))!;
    await w.store.put({ item: { ...row, extra: "private-corrupt-detail" } });
  }
  if (mode === "changed inputs") input.key = { ...input.key, evalSetHash: "e".repeat(64) };
  if (mode === "monthly denial") w.state.remainingCost = 59;
  const result = await createEvalBaselines().afterMerge(input);
  expect(result).toEqual({ status: "not_run", reason: mode === "monthly denial" ? "monthly_cap" : "not_confirmed",
    message: mode === "monthly denial" ? "Not run: the monthly cap cannot fit these runs." : "Not run: an owner, maintainer or admin must confirm the connected customer's call estimate." });
  expect(await createEvalBaselines().forTask(input)).toBe(mode === "monthly denial" ? "unavailable" : "awaiting_confirmation");
  const marks = (await w.store.query({ pk: `ORG#${company}#EVALBASE` })).items.filter(row => row.sk.startsWith("M#"));
  expect(marks).toHaveLength(1); expect(marks[0]).toMatchObject({ state: "finished" });
  expect(w.holds).toEqual([]); expect(w.ledger).toEqual([]);
});

describe("persisted eval spend approval", () => {
  it("shows a separate estimate and usual/maximum budget before approval; refreshes use one approval", async () => {
    const w = world(); const row = await w.propose();
    expect(await readEvalSpendItem(w.deps, project)).toMatchObject({ label: "Run the eval health check: about 6 calls, about $0.00", budget: "Usually about 6 calls (about $0.00), at most 400 calls (about $4.00), within the monthly cap.", approval: { artifactDigest: row.digest } });
    await refused(w);
    expect((await w.gate.decide(w.attempt(row))).status).toBe("decided");
    expect(await w.store.get(evalSpendKey(company, project))).toMatchObject({ state: "approved", inputsDigest: evalSpendInputsDigest(inputs), plan: plan(), approvedBy: { personId: "person", provider: "test-identity", role: "maintainer", at: now } });
    expect((await runEvalHealth(w.input())).status).toBe("measured");
    expect((await runEvalHealth(w.input())).status).toBe("measured");
    expect(w.ledger).toEqual(Array.from({ length: 12 }, () => ({ company, project, provider: "customer" })));
    expect(w.holds.map(x => [x.calls, x.costMicros])).toEqual([[6, 60], [6, 60]]);
    expect((await w.propose()).revision).toBe(row.revision);
    expect((await w.gate.decide(w.attempt(row))).status).toBe("replayed");
  });
  it.each(["owner", "admin", "maintainer"])("allows %s for eval", async role => { const w = world(role); await w.approve(); expect((await runEvalHealth(w.input())).status).toBe("measured"); });
  it.each(["member", "auditor"])("refuses %s", async role => { const w = world(role); const row = await w.propose(); expect((await w.gate.decide(w.attempt(row))).status).toBe("refused"); await refused(w); });
  it("refuses another company's person and another company's subject", async () => {
    const w = world(); const row = await w.propose(); w.state.principal = person("maintainer", other);
    expect((await w.gate.decide(w.attempt(row))).status).toBe("refused");
    expect(await w.subject.load(other, project)).toBeUndefined(); await refused(w);
  });
  it("a maintainer can approve eval but cannot approve setup, whose command digest stays golden", async () => {
    const w = world(); await w.approve();
    const setup = createSetupProposalSubject({ flow: { store: w.store, companyId: company } });
    await expect(setup.apply({ key: { pk: "unused", sk: "unused" }, guard: { op: "notExists", path: ["pk"] }, waiting: true, request: { kind: "setup", subject: { type: "setup_proposal", id: project }, revision: 1, artifactDigest: "a".repeat(64) }, state: { row: {} } }, w.attempt(await w.propose()), [person()], now)).rejects.toThrow("Only the owner");
    const a = { executable: "npm", args: ["ci"], cwd: "repo/demo", timeoutSeconds: 1000 };
    const b = { executable: "npm", args: ["test"], cwd: "repo/demo", timeoutSeconds: 2000 };
    expect(setupApplyDigest([a], [b])).toBe("0f50f1e1a4c964c9280a9a60f3e12f9b6082bda85807c5603c20cd3dbc389a09");
    expect(setupApplyDigest([b], [a])).not.toBe(setupApplyDigest([a], [b]));
  });
  it("defaults the suggested maximum to the eval's 400 calls/$4", async () => {
    expect([EVAL_DEFAULT_CALL_BUDGET, EVAL_DEFAULT_COST_BUDGET_MICROS]).toEqual([400, 4_000_000]);
    const w = world(); const { budget, ...without } = plan(); void budget;
    const row = await proposeEvalSpendApproval(w.deps, project, without);
    expect(row.plan.budget).toEqual({ usual: without.estimate, maximum: { calls: EVAL_DEFAULT_CALL_BUDGET, costMicros: EVAL_DEFAULT_COST_BUDGET_MICROS } });
  });
  it("requires re-approval after a higher call or cost estimate", async () => {
    for (const field of ["calls", "costMicros"] as const) {
      const w = world(); await w.approve(); w.state.current.estimate[field] += 1; await refused(w);
      await w.approve(); expect((await w.capabilities().approval.read())?.maxCalls).toBe(w.state.current.estimate.calls);
    }
  });
  it.each(Object.keys(inputs) as Array<keyof typeof inputs>)("requires re-approval after changed eval inputs: %s", async field => {
    const w = world(); await w.approve(); w.state.current.inputs[field] = field.endsWith("Hash") || field.endsWith("Pin") || field.endsWith("Fingerprint") ? "f".repeat(64) : "changed";
    await refused(w); await w.approve(); expect(await w.capabilities().approval.read()).toBeDefined();
  });
  it("requires the actual worker inputs to match the approval", async () => {
    const w = world(); await w.approve(); const input = w.input(); input.key = { ...input.key, evalSetHash: "e".repeat(64) }; await refused(w, input);
  });
  it.each(["selection", "budget"])("requires re-approval after %s changes", async field => {
    const w = world(); await w.approve(); if (field === "selection") w.state.current.selection = "evals/other"; else w.state.current.budget.maximum.calls++;
    expect(await w.capabilities().approval.read()).toBeUndefined();
    await refused(w);
  });
  it("accepts a lower estimate, but binds every estimate and budget field in its own digest", async () => {
    const w = world(); const row = await w.approve(); w.state.current.estimate = { calls: 3, costMicros: 30 };
    expect(await w.capabilities().approval.read()).toBeDefined();
    expect(evalSpendDigest(company, project, w.state.current)).not.toBe(row.digest);
    for (const field of ["calls", "costMicros"] as const) for (const level of ["usual", "maximum"] as const) { const p = plan(); p.budget[level][field]++; expect(evalSpendDigest(company, project, p)).not.toBe(row.digest); }
  });
  it.each(["missing", "stale digest", "bad inputs digest", "wrong company", "wrong project", "malformed", "store failure"])("refuses %s stored approval", async mode => {
    const w = world(); await w.approve(); const key = evalSpendKey(company, project); const row = (await w.store.get(key))!;
    if (mode === "missing") await w.store.delete({ key });
    else if (mode === "store failure") w.store.get = async () => { throw new Error("private storage detail"); };
    else await w.store.put({ item: { ...row, ...({ "stale digest": { digest: "f".repeat(64) }, "bad inputs digest": { inputsDigest: "f".repeat(64) }, "wrong company": { company: other, digest: evalSpendDigest(other, project, plan()) }, "wrong project": { project: "other", digest: evalSpendDigest(company, "other", plan()) }, malformed: { approvedBy: null } }[mode]) } });
    expect(await readEvalSpendItem(w.deps, project)).toBeUndefined();
    await refused(w);
  });
  it.each(["role", "company", "project", "person", "provider", "disconnected", "authority failure", "reservation failure", "cap calls", "cap cost", "reservation denied"])("refuses current %s before spend", async mode => {
    const w = world(); await w.approve();
    if (mode === "role") { w.state.principal = person("member"); w.state.grants.clear(); }
    if (mode === "company") w.state.authorityCompany = other;
    if (mode === "project") w.state.authorityProject = "other";
    if (mode === "person") w.state.principal = { ...person(), personId: "other" };
    if (mode === "provider") w.state.provider = "rovara";
    if (mode === "disconnected") w.state.connected = false;
    if (mode === "authority failure") w.adapter.authority = async () => { throw new Error("private authority detail"); };
    if (mode === "reservation failure") w.adapter.reserve = async () => { throw new Error("private meter detail"); };
    if (mode === "cap calls") w.state.remainingCalls = 5;
    if (mode === "cap cost") w.state.remainingCost = 59;
    if (mode === "reservation denied") w.state.denied = true;
    if (mode === "role") expect(await w.capabilities().approval.read()).toBeUndefined();
    await refused(w);
  });
  it("with no adapter bound, both producers refuse and the health check makes zero calls", async () => {
    const w = world(); await w.approve(); const caps = createEvalSpendCapabilities({ ...w.deps, project, current: async () => plan() });
    expect(await caps.approval.read()).toBeUndefined();
    const grant = (await w.capabilities().approval.read())!;
    expect(await caps.meter.reserve({ approval: grant, calls: 6, costMicros: 60 })).toBeUndefined();
    await refused(w, w.input(caps));
  });
  it("revalidates after read and before a hold, rejecting forged grants and over-estimate reservations", async () => {
    const w = world(); await w.approve(); const caps = w.capabilities(); const grant = (await caps.approval.read())!;
    for (const request of [{ approval: { ...grant }, calls: 6, costMicros: 60 }, { approval: grant, calls: 7, costMicros: 60 }, { approval: grant, calls: 6, costMicros: 61 }, { approval: grant, calls: NaN, costMicros: 60 }]) expect(await caps.meter.reserve(request)).toBeUndefined();
    let adapterReservations = 0; const reserve = w.adapter.reserve.bind(w.adapter);
    w.adapter.reserve = async request => { adapterReservations++; return reserve(request); };
    w.state.connected = false; expect(await caps.meter.reserve({ approval: grant, calls: 6, costMicros: 60 })).toBeUndefined(); expect(w.holds).toEqual([]); expect(adapterReservations).toBe(0);
  });
  it("the adapter revalidates a changed approval immediately before dispatch", async () => {
    const w = world(); await w.approve(); const caps = w.capabilities(); const grant = (await caps.approval.read())!;
    const held = (await caps.meter.reserve({ approval: grant, calls: 6, costMicros: 60 }))!;
    w.state.current.inputs.modelVersion = "new-version";
    await expect(held.call({} as ModelEgressFrame)).rejects.toThrow("refused"); await held.close(); expect(w.ledger).toEqual([]);
  });
  it("isolates two companies even with the same project and decision id", async () => {
    const w = world(); await w.approve(); const caps = createEvalSpendCapabilities({ store: w.store, companyId: other, project, current: async () => plan(), adapter: w.adapter });
    expect(await caps.approval.read()).toBeUndefined(); expect(await readEvalSpendItem({ store: w.store, companyId: other }, project)).toBeUndefined();
    expect((await runEvalHealth(w.input())).status).toBe("measured"); expect(w.ledger.every(x => x.company === company)).toBe(true);
  });
  it.each([NaN, Infinity, -1, 0, Number.MAX_SAFE_INTEGER + 1])("refuses invalid numeric estimates %s", async calls => { const w = world(); w.state.current.estimate.calls = calls; await expect(w.propose()).rejects.toThrow(); expect(w.holds).toEqual([]); });
  it.each(["usual calls", "usual cost", "estimate calls", "estimate cost"])("refuses a budget smaller than %s", async field => { const w = world(); if (field.startsWith("usual")) w.state.current.budget.usual[field.endsWith("calls") ? "calls" : "costMicros"] = 5_000_000; else w.state.current.estimate[field.endsWith("calls") ? "calls" : "costMicros"] = 5_000_000; await expect(w.propose()).rejects.toThrow(); });
  it("fits the exact approved maximum within the monthly hold", async () => { const w = world(); w.state.current.estimate = { calls: 400, costMicros: 4_000_000 }; w.state.remainingCalls = 400; w.state.remainingCost = 4_000_000; await w.approve(); const caps = w.capabilities(); const grant = (await caps.approval.read())!; const hold = await caps.meter.reserve({ approval: grant, calls: 400, costMicros: 4_000_000 }); expect(hold).toBeDefined(); await hold!.close(); expect(w.state.remainingCalls).toBe(0); expect(w.state.remainingCost).toBe(0); });
});

it("refuses a stale confirm digest, rejection and request-changes without granting spend", async () => {
  const w = world(); const first = await w.propose();
  expect(await w.gate.decide({ ...w.attempt(first), seen: { revision: first.revision, artifactDigest: "f".repeat(64) } })).toMatchObject({ status: "refused", reason: "stale" });
  expect(await w.gate.decide({ ...w.attempt(first), outcome: "request_changes" })).toMatchObject({ status: "refused", reason: "invalid_outcome" });
  expect((await w.gate.decide({ ...w.attempt(first), outcome: "reject" })).status).toBe("decided");
  await refused(w); expect((await readEvalSpendItem(w.deps, project))?.approval).toBeUndefined();
  const next = await w.propose(); expect(next.revision).toBe(first.revision + 1);
  expect((await w.gate.decide(w.attempt(next))).status).toBe("decided");
});
it("a proposal lost race cannot overwrite an intervening approval", async () => {
  const w = world(); const row = await w.propose(); const put = w.store.put.bind(w.store);
  w.state.current.estimate.calls++;
  w.store.put = async request => { expect((await w.gate.decide(w.attempt(row))).status).toBe("decided"); return put(request); };
  await expect(w.propose()).rejects.toThrow("changed");
  expect((await w.store.get(evalSpendKey(company, project)))?.["state"]).toBe("approved");
});
it("the approval transaction refuses if the item changes after the person is verified", async () => {
  const w = world(); const row = await w.propose(); const apply = w.subject.apply.bind(w.subject);
  w.subject.apply = async (...args) => { w.state.current.estimate.calls++; await w.propose(); return apply(...args); };
  expect((await w.gate.decide(w.attempt(row))).status).toBe("refused"); await refused(w);
});
it.each(["authority absent", "wrong identity company", "wrong identity provider", "current missing", "current malformed", "current failure", "approval replaced"])("revalidates %s", async mode => {
  const w = world(); await w.approve(); const caps = w.capabilities(); const grant = (await caps.approval.read())!;
  if (mode === "authority absent") w.adapter.authority = async () => undefined;
  if (mode === "wrong identity company") w.state.principal = person("maintainer", other);
  if (mode === "wrong identity provider") w.state.principal.provider = "other";
  if (mode === "current malformed") w.state.current.estimate.costMicros = Infinity;
  if (mode === "approval replaced") { w.state.current.estimate.calls++; await w.propose(); }
  if (mode === "current missing" || mode === "current failure") {
    const broken = createEvalSpendCapabilities({ ...w.deps, project, adapter: w.adapter, current: async () => { if (mode === "current failure") throw new Error("private detail"); return undefined; } });
    expect(await broken.approval.read()).toBeUndefined();
  } else expect(await caps.meter.reserve({ approval: grant, calls: 6, costMicros: 60 })).toBeUndefined();
  expect(w.holds).toEqual([]); expect(w.ledger).toEqual([]);
});
it("the subject refuses empty and mixed approvers even with a valid loaded item", async () => {
  const w = world(); const row = await w.propose(); const loaded = (await w.subject.load(company, project))!;
  for (const approvers of [[], [person(), { ...person("auditor"), personId: "auditor" }], [person("owner", other)]]) {
    await expect(Promise.resolve().then(() => w.subject.apply(loaded, w.attempt(row), approvers, now))).rejects.toThrow("Only a company owner");
  }
});
it("corrupt rows fail closed, log fixed words, and permit a fresh proposal", async () => {
  const w = world(); await w.approve(); const key = evalSpendKey(company, project); const row = (await w.store.get(key))!;
  await w.store.put({ item: { ...row, extra: "private-corrupt-detail" } });
  expect(await readEvalSpendItem(w.deps, project)).toBeUndefined(); await refused(w);
  expect(w.logs.length).toBeGreaterThan(0);
  expect(new Set(w.logs)).toEqual(new Set(["eval_spend_approval_invalid"]));
  const next = await w.propose(); expect(next.state).toBe("waiting");
  expect((await w.store.get(key))?.["extra"]).toBeUndefined(); await refused(w);
  expect((await w.gate.decide(w.attempt(next))).status).toBe("decided");
  expect((await runEvalHealth(w.input())).status).toBe("measured");
});
it("missing or malformed subjects cannot be offered for approval", async () => {
  const w = world(); expect(await w.subject.load(company, project)).toBeUndefined();
  await w.store.put({ item: { ...evalSpendKey(company, project), entityType: "EVAL_SPEND_APPROVAL" } });
  expect(await w.subject.load(company, project)).toBeUndefined();
});
it("a superseded approval cannot reserve, even when the plan returns to identical inputs", async () => {
  const w = world(); await w.approve(); const caps = w.capabilities(); const grant = (await caps.approval.read())!;
  w.state.current.estimate.calls++; await w.approve(); w.state.current = plan(); await w.approve();
  expect(await caps.meter.reserve({ approval: grant, calls: 6, costMicros: 60 })).toBeUndefined();
  expect(w.holds).toEqual([]);
});
it("unreadable capabilities and item views refuse directly without exposing error text", async () => {
  const w = world(); await w.approve(); const caps = w.capabilities(); const grant = (await caps.approval.read())!;
  w.adapter.reserve = async () => { throw new Error("private meter text"); };
  expect(await caps.meter.reserve({ approval: grant, calls: 6, costMicros: 60 })).toBeUndefined();
  w.store.get = async () => { throw new Error("private store text"); };
  expect(await caps.approval.read()).toBeUndefined(); expect(await readEvalSpendItem(w.deps, project)).toBeUndefined();
});
it("forwards whole estimates to the adapter so concurrent holds fit only one remaining monthly allowance", async () => {
  const w = world(); await w.approve(); w.state.remainingCalls = 6; w.state.remainingCost = 60;
  const caps = w.capabilities(); const grant = (await caps.approval.read())!;
  const results = await Promise.all([caps.meter.reserve({ approval: grant, calls: 6, costMicros: 60 }), caps.meter.reserve({ approval: grant, calls: 6, costMicros: 60 })]);
  expect(results.filter(Boolean)).toHaveLength(1); expect(w.holds).toHaveLength(1); expect(w.ledger).toEqual([]);
  for (const result of results) await result?.close();
});
it("unknown JSON keys cannot become approval policy or object prototypes", async () => {
  const w = world(); const unknown: unknown = JSON.parse(JSON.stringify(plan()).replace('"selection":', '"__proto__":{"polluted":true},"selection":'));
  await expect(proposeEvalSpendApproval(w.deps, project, unknown as EvalSpendPlan)).rejects.toThrow();
  expect(Object.prototype).not.toHaveProperty("polluted"); expect(await w.store.get(evalSpendKey(company, project))).toBeUndefined();
});
it("shows only fixed words and finite amounts, never the stored selection's text", async () => {
  const w = world(); w.state.current.selection = "![nested[image]](https://evil.example) [ref][id] @owner #123 <img> # > --- ``` ~~~";
  await w.propose(); const item = await readEvalSpendItem(w.deps, project);
  expect(JSON.stringify(item)).not.toMatch(/evil|nested|@owner|#123|<img>|```|~~~/u);
  w.state.current.selection = "x".repeat(1_048_576); await expect(w.propose()).rejects.toThrow();
  w.state.current.selection = "eval\u200b\ufe0f"; await expect(w.propose()).rejects.toThrow();
});

it("refuses project B maintainers on project A at approval and read time", async () => {
  const w = world(); const row = await w.propose();
  w.state.grants = new Set(["other-project"]);
  // An adapter returning a union of roles must not turn this into project A access.
  w.state.principal = { ...w.state.principal, roles: [...w.state.principal.roles, "maintainer"] };
  expect((await w.gate.decide(w.attempt(row))).status).toBe("refused"); await refused(w);
  w.state.grants.add(project); await w.approve();
  expect(await w.capabilities().approval.read()).toBeDefined();
  w.state.grants.delete(project);
  expect(await w.capabilities().approval.read()).toBeUndefined(); await refused(w);
});
it.each(["owner", "admin"])("keeps %s company-wide without project grants", async role => {
  const w = world(role); expect(w.state.grants.size).toBe(0); await w.approve();
  expect((await runEvalHealth(w.input())).status).toBe("measured");
});
it.each(["owner", "admin", "maintainer"])("renews a lapsed %s approval with a new decision", async role => {
  const w = world(role); const first = await w.approve();
  w.state.principal = person("member"); w.state.grants.clear();
  const item = (await readEvalSpendItem(w.deps, project))!;
  expect(item.state).toBe("approval needs renewing");
  const html = renderSetupPage({ base: "/local", nonce: "nonce", sessionId: "session", formToken: () => "unused" }, {
    project, revision: 1, status: "none", limits: { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 }, items: [], verified: false, journal: [], hostAsks: [], approvedHosts: [], check: { status: "unchecked" }, evalSpend: item,
  });
  expect(html).toContain("Spend approval: approval needs renewing"); expect(html).not.toContain("Spend approval: approved");
  await refused(w);
  const next = await w.propose(); expect(next).toMatchObject({ state: "waiting", revision: first.revision + 1 });
  expect(next.approvedBy).toBeUndefined();
  expect((await readEvalSpendItem(w.deps, project))?.approval).toBeDefined();
  w.state.grants.add(project);
  expect((await w.gate.decide(w.attempt(next))).status).toBe("decided");
  expect((await runEvalHealth(w.input())).status).toBe("measured");
});
it("refuses a suggested budget above the monthly cap and labels only checked caps", async () => {
  const w = world(); w.deps.monthlyCapMicros = 4_000_000;
  const row = await w.propose(); expect(row.plan.budget.maximum.costMicros).toBe(4_000_000);
  expect((await readEvalSpendItem(w.deps, project))?.budget).toContain("within the monthly cap");
  w.state.current.budget.maximum.costMicros++;
  await expect(w.propose()).rejects.toThrow("The eval budget does not fit the monthly cap.");
  w.deps.monthlyCapMicros--;
  expect((await readEvalSpendItem(w.deps, project))?.budget).not.toContain("within the monthly cap");
  expect((await readEvalSpendItem({ store: w.store, companyId: company }, project))?.budget).not.toContain("within the monthly cap");
  await refused(w);
});
it.each([undefined, NaN, Infinity, -1, "50000000", "private-cap-detail"])("refuses an unreadable monthly cap: %s", async cap => {
  const w = world(); Object.assign(w.deps, { monthlyCapMicros: cap });
  await expect(w.propose()).rejects.toThrow("The eval budget does not fit the monthly cap.");
  expect(await w.store.get(evalSpendKey(company, project))).toBeUndefined(); await refused(w);
});
it.each(["extra", "missing state"])("corrupt-row recovery cannot overwrite an intervening approval: %s", async mode => {
  const w = world(); await w.approve(); const key = evalSpendKey(company, project); const approved = (await w.store.get(key))!;
  const corrupt = { ...approved }; if (mode === "extra") corrupt["extra"] = "private"; else delete corrupt["state"];
  await w.store.put({ item: corrupt }); const put = w.store.put.bind(w.store);
  w.store.put = async request => { await put({ item: approved }); return put(request); };
  await expect(w.propose()).rejects.toThrow("changed");
  expect(await w.store.get(key)).toEqual(approved);
});
it("recovery without a readable revision cannot replay the old approval", async () => {
  const w = world(); const first = await w.approve(); const key = evalSpendKey(company, project);
  const { revision, ...corrupt } = (await w.store.get(key))!; void revision;
  await w.store.put({ item: corrupt }); await refused(w);
  const next = await w.propose(); expect(next.revision).not.toBe(first.revision);
  expect((await w.gate.decide(w.attempt(next))).status).toBe("decided");
  expect((await runEvalHealth(w.input())).status).toBe("measured");
});
it.each(["company lookup", "grant lookup"])("unreadable %s refuses with fixed words and renews approval", async mode => {
  const w = world(); const row = await w.approve();
  const fail = () => { throw new Error("private-membership-detail"); };
  if (mode === "company lookup") w.members.companyRole = fail; else w.members.projectGrant = fail;
  expect(await readEvalSpendItem(w.deps, project)).toMatchObject({ state: "approval needs renewing" });
  await refused(w); const next = await w.propose(); expect(next.revision).toBe(row.revision + 1);
  expect(await w.gate.decide(w.attempt(next))).toMatchObject({ status: "refused", detail: "Only a company owner, admin or project maintainer approves eval spend." });
});
it.each([undefined, "unknown", "auditor"])("refuses an invalid company role even with a maintainer grant: %s", async role => {
  const w = world(); const row = await w.propose(); w.members.companyRole = () => role as "auditor" | undefined;
  expect((await w.gate.decide(w.attempt(row))).status).toBe("refused"); await refused(w);
});
