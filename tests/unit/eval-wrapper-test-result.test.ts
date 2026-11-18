// L4-EVW5 (DEC 254zzz43: "then confirm it's readable"): the approved test run of a wrapper file is the eval health run (L4-EVH). When the run for that request ends, the wrapper's file record takes the answer:
// readable (the results were read in full: a measured result, or a baseline the project already held), unreadable (the run said it could not read them), and nothing for any other end (it stays "test approved").
// Every guard has a named mutant in briefs/lead4/L4-EVW5-MUTANTS-20261118.md, each broken by hand and seen to fail one of these tests.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { evalWrapperCommandOf, type EvalBaseRecord, type EvalOutputShape, type EvalReservationAdapter } from "@agentx/contracts";
import { FakeCodeHost, FakeHostModel } from "@agentx/broker/fakes";
import { recordEvalHealthResult, startEvalHealthRun, type EvalHealthRunDeps } from "../../packages/broker/src/core/setup-agent/eval-health-run.js";
import { readEvalHealthRow, requestEvalHealthCheck } from "../../packages/broker/src/core/setup-agent/eval-health-request.js";
import { detectEvalWrappers, listEvalWrapperFiles, needsOf, recordEvalWrapperTest, settleEvalWrapperTest, type EvalWrapperDeps } from "../../packages/broker/src/core/setup-agent/eval-wrapper.js";
import { evalWrapperLine, readEvalWrapperCards } from "../../packages/broker/src/core/setup-agent/eval-wrapper-card.js";
import { A, B, CAP, NOW, ROLES, company, filesOf, person, project, reportOf } from "../support/eval-card-world.js";

const HEAD = "a".repeat(40);
const ROWS: EvalOutputShape = { kind: "rows", format: "jsonl", language: "python", idField: "case_id", pass: { field: "passed", equals: true } };
const URL = "https://github.com/acme/web";
const report = () => reportOf(2, { output: ROWS, wrapperDryRun: "passed" });

const record = (ids: string[] = ["q1", "q2"]): EvalBaseRecord => ({
  schemaVersion: 1, runnerSchemaVersion: 1, roundKind: "check_unsealed", recordedOn: "2026-11-18", caseCount: ids.length,
  measures: [{ name: "pass", unit: "fraction", value: 1, direction: "up_good" }],
  questions: ids.map(id => ({ id, samples: [{ pass: true, answer: "a" }, { pass: true, answer: "a" }, { pass: true, answer: "a" }] })),
});
const body = (requestId: string, claimId: string, result: unknown) => ({ requestId, claimId, result });

/** A company whose eval is read through a wrapper file found on main, its test run approved with the spend approval, and a health run asked for. */
async function world(options: { wrapped?: boolean } = {}) {
  const wrapped = options.wrapped !== false;
  const w = company(A, { ...ROLES });
  const model = new FakeHostModel({ url: URL, id: "4242", fullName: "acme/web", webBase: "https://github.com" });
  const target = { name: "web", place: "fake:repo/4242", repository: { url: URL }, scope: { orgId: A }, host: new FakeCodeHost(model) };
  const clock = { now: NOW };
  const wrapperDeps = (companyId: typeof A = A, over: Partial<EvalWrapperDeps> = {}): EvalWrapperDeps => ({ store: w.store, companyId, now: () => clock.now, targets: async () => [target], audit: async () => undefined, ...over });
  const rep = wrapped ? report() : reportOf(2);
  const need = needsOf(rep)[0];
  if (wrapped) { model.commit("main", { [need!.file.path]: need!.file.content }); await detectEvalWrappers(wrapperDeps(), project, rep, { force: true }); }
  const r = await w.run(filesOf(2), rep);
  await r.approve();
  const launched: unknown[] = [];
  const adapter: EvalReservationAdapter = {
    async authority(request) { return { company: request.company, project: request.project, principal: { companyId: request.company, personId: request.approver.personId, provider: request.approver.provider, displayName: "", roles: [] }, provider: "customer", connected: true }; },
    async reserve() { return undefined; },
  };
  const registry = { names: (point: string) => point === "eval-reservation" ? ["test"] : [], get: () => adapter } as never;
  const deps = (over: Partial<EvalHealthRunDeps> = {}): EvalHealthRunDeps => ({
    store: w.store, companyId: A, now: () => clock.now, members: w.members, registry, monthlyCap: async () => CAP,
    mainHeads: async () => [{ repositoryId: "web", baseCommitSha: HEAD }], launch: async (job) => { launched.push(job); return true; }, audit: async () => undefined, ...over,
  });
  const ask = () => requestEvalHealthCheck({ store: w.store, companyId: A, now: () => clock.now, members: w.members }, project, { requestId: randomUUID(), seenCostMicros: 600_000 }, person(A, "maintainer"));
  const row = () => readEvalHealthRow({ store: w.store, companyId: A }, project);
  /** Asks, starts, and returns the ids the worker would post under. */
  const start = async () => {
    await ask(); const requestId = (await row())!.requestId;
    const outcome = await startEvalHealthRun(deps(), project);
    if (outcome.outcome !== "started") throw new Error(`not started: ${JSON.stringify(outcome)}`);
    return { requestId, claimId: outcome.claimId };
  };
  const cards = (companyId: typeof A = A) => readEvalWrapperCards(wrapperDeps(companyId), project, { reportDigest: "d".repeat(64), report: rep }, true);
  const files = (companyId: typeof A = A, p: string = project) => listEvalWrapperFiles(wrapperDeps(companyId), p);
  return { w, r, model, target, clock, deps, ask, row, start, cards, files, wrapperDeps, launched, rep, need: need! };
}

describe("the approved test run's answer reaches the wrapper's card", () => {
  it("the spend approval leaves the file at 'test approved'; a measured result read in full makes it readable", async () => {
    const x = await world();
    expect((await x.cards())[0]).toMatchObject({ step: "test_approved" });
    const { requestId, claimId } = await x.start();
    // Running is not an answer.
    expect((await x.cards())[0]).toMatchObject({ step: "test_approved" });
    expect(await recordEvalHealthResult(x.deps(), project, body(requestId, claimId, { status: "measured", record: record() }))).toEqual({ outcome: "finished" });
    expect((await x.cards())[0]).toMatchObject({ step: "readable", line: evalWrapperLine("readable") });
    expect((await x.files())[0]).toMatchObject({ test: "readable", testAt: new Date(NOW).toISOString() });
  });

  it("a run that says it could not read the results makes it 'not readable yet' with the fixed words, whatever the worker wrote", async () => {
    for (const reason of ["invalid_results", "incomplete_questions"] as const) {
      const x = await world();
      const { requestId, claimId } = await x.start();
      expect(await recordEvalHealthResult(x.deps(), project, body(requestId, claimId, { status: "not_run", reason }))).toEqual({ outcome: "not_run" });
      expect((await x.cards())[0]).toMatchObject({ step: "unreadable", line: evalWrapperLine("unreadable") });
      expect(evalWrapperLine("unreadable")).toBe("The test run could not read this eval's results through the file. Check the file, then check again.");
    }
  });

  it("a measured result that does not match the approved plan's questions is not readable either", async () => {
    const x = await world();
    const { requestId, claimId } = await x.start();
    expect(await recordEvalHealthResult(x.deps(), project, body(requestId, claimId, { status: "measured", record: record(["q1"]) }))).toEqual({ outcome: "not_run" });
    expect((await x.cards())[0]).toMatchObject({ step: "unreadable" });
  });

  it("an unreadable answer is not final: the next approved run that reads it makes it readable", async () => {
    const x = await world();
    const first = await x.start();
    await recordEvalHealthResult(x.deps(), project, body(first.requestId, first.claimId, { status: "not_run", reason: "invalid_results" }));
    expect((await x.cards())[0]).toMatchObject({ step: "unreadable" });
    const second = await x.start();
    await recordEvalHealthResult(x.deps(), project, body(second.requestId, second.claimId, { status: "measured", record: record() }));
    expect((await x.cards())[0]).toMatchObject({ step: "readable" });
  });

  it("a baseline the project already holds (nothing run, nothing spent) is the same answer: readable", async () => {
    const x = await world();
    const first = await x.start();
    await recordEvalHealthResult(x.deps(), project, body(first.requestId, first.claimId, { status: "measured", record: record() }));
    // The file's test starts over (as for an approval carried to a new check), the same baseline is still held, and a new yes reuses it.
    await recordEvalWrapperTest(x.wrapperDeps(), project, { repository: "web", selection: x.need.selection, language: "python" }, "approved");
    expect((await x.cards())[0]).toMatchObject({ step: "test_approved" });
    await x.ask();
    expect(await startEvalHealthRun(x.deps(), project)).toMatchObject({ outcome: "reused" });
    expect((await x.cards())[0]).toMatchObject({ step: "readable" });
  });

  it("an end that is not about reading (stopped, the monthly limit, a provider that did not answer, a run that never reported) records nothing: the file stays 'test approved'", async () => {
    for (const reason of ["stopped", "monthly_cap", "provider_incomplete", "not_connected", "unavailable", "over_cap", "questions_changed"] as const) {
      const x = await world();
      const { requestId, claimId } = await x.start();
      expect(await recordEvalHealthResult(x.deps(), project, body(requestId, claimId, { status: "not_run", reason }))).toEqual({ outcome: "not_run" });
      expect((await x.cards())[0]).toMatchObject({ step: "test_approved" });
      expect((await x.files())[0]).toMatchObject({ test: "approved" });
    }
    const x = await world();
    await x.start();
    x.clock.now += 60 * 60 * 1000 * 24;
    expect(await startEvalHealthRun(x.deps(), project)).toEqual({ outcome: "nothing" });
    expect((await x.cards())[0]).toMatchObject({ step: "test_approved" });
  });

  it("a request that never started (its yes was too old, the approval changed) records nothing", async () => {
    const x = await world();
    await x.ask();
    // A bigger eval needs a new approval: the yes is void, and the run is not started.
    const bigger = await x.w.run(filesOf(3), reportOf(3, { output: ROWS, wrapperDryRun: "passed" })); await bigger.confirmOnly();
    expect(await startEvalHealthRun(x.deps(), project)).toMatchObject({ outcome: "not_run", reason: "approval_changed" });
    expect((await x.files())[0]).toMatchObject({ test: "approved" });
  });
});

describe("only the right file takes the answer", () => {
  it("a run made under an approval that was replaced since answers for the old plan, never the new one's file", async () => {
    const x = await world();
    const { requestId, claimId } = await x.start();
    // A bigger eval is approved meanwhile (a new plan, a new approval): the worker's late "could not read" belongs to the old one.
    const bigger = await x.w.run(filesOf(3), reportOf(3, { output: ROWS, wrapperDryRun: "passed" })); await bigger.approve();
    expect(await recordEvalHealthResult(x.deps(), project, body(requestId, claimId, { status: "not_run", reason: "invalid_results" }))).toEqual({ outcome: "not_run" });
    expect((await x.files())[0]).toMatchObject({ test: "approved" });
    expect((await x.cards())[0]).toMatchObject({ step: "test_approved" });
  });

  it("an eval that is not read through a wrapper has no file, and a result records nothing for it", async () => {
    const x = await world({ wrapped: false });
    const { requestId, claimId } = await x.start();
    expect(await recordEvalHealthResult(x.deps(), project, body(requestId, claimId, { status: "measured", record: record() }))).toEqual({ outcome: "finished" });
    expect(await x.files()).toEqual([]);
  });

  it("a file that changed since its test was approved starts over and takes no answer for the old text", async () => {
    const x = await world();
    const { requestId, claimId } = await x.start();
    x.model.commit("main", { [x.need.file.path]: `${x.need.file.content}# edited\n` });
    await detectEvalWrappers(x.wrapperDeps(), project, x.rep, { force: true });
    expect((await x.files())[0]).toMatchObject({ test: "none", match: "edited" });
    await recordEvalHealthResult(x.deps(), project, body(requestId, claimId, { status: "measured", record: record() }));
    expect((await x.files())[0]).toMatchObject({ test: "none" });
    expect((await x.cards())[0]).toMatchObject({ step: "file_found" });
  });

  it("a file whose test run was never approved takes no answer", async () => {
    const x = await world();
    const { requestId, claimId } = await x.start();
    // The row is rewritten by a check that found the file gone and back: test none.
    x.model.commit("main", { [x.need.file.path]: `${x.need.file.content}# x\n` });
    await detectEvalWrappers(x.wrapperDeps(), project, x.rep, { force: true });
    x.model.commit("main", { [x.need.file.path]: x.need.file.content });
    x.clock.now += 20_000;
    await detectEvalWrappers(x.wrapperDeps(), project, x.rep, { force: true });
    expect((await x.files())[0]).toMatchObject({ test: "none", match: "same" });
    await recordEvalHealthResult(x.deps(), project, body(requestId, claimId, { status: "measured", record: record() }));
    expect((await x.files())[0]).toMatchObject({ test: "none" });
  });

  it("the plan names the eval: another eval's file, another language's file and a plan that does not run the wrapper are not touched", async () => {
    const x = await world();
    const plan = { selection: x.need.selection, repository: "web", command: evalWrapperCommandOf("python"), report: { cwd: ".", argument: "rovara/eval-wrapper-results.xml" } };
    expect(await settleEvalWrapperTest(x.wrapperDeps(), project, { ...plan, selection: "evals/other" }, "readable")).toBe(false);
    expect(await settleEvalWrapperTest(x.wrapperDeps(), project, { ...plan, repository: "api" }, "readable")).toBe(false);
    expect(await settleEvalWrapperTest(x.wrapperDeps(), project, { ...plan, command: evalWrapperCommandOf("node") }, "readable")).toBe(false);
    expect(await settleEvalWrapperTest(x.wrapperDeps(), project, { ...plan, command: { executable: "node", args: ["evals/run.js"], cwd: "." } }, "readable")).toBe(false);
    expect(await settleEvalWrapperTest(x.wrapperDeps(), project, { ...plan, command: { executable: "python3", args: ["evals/run.py"], cwd: "." } }, "readable")).toBe(false);
    expect(await settleEvalWrapperTest(x.wrapperDeps(), project, { ...plan, report: { cwd: ".", argument: "rovara-measures.json" } }, "readable")).toBe(false);
    expect(await settleEvalWrapperTest(x.wrapperDeps(), project, { selection: plan.selection, repository: "web" }, "readable")).toBe(false);
    expect((await x.files())[0]).toMatchObject({ test: "approved" });
    expect(await settleEvalWrapperTest(x.wrapperDeps(), project, plan, "readable")).toBe(true);
    expect((await x.files())[0]).toMatchObject({ test: "readable" });
  });
});

describe("company and project scope", () => {
  it("a result posted under another project, or read by another company, is never recorded", async () => {
    const x = await world();
    const { requestId, claimId } = await x.start();
    const posted = body(requestId, claimId, { status: "measured", record: record() });
    expect(await recordEvalHealthResult(x.deps(), "other-project", posted)).toEqual({ outcome: "refused" });
    expect(await recordEvalHealthResult(x.deps({ companyId: B }), project, posted)).toEqual({ outcome: "refused" });
    expect((await x.files())[0]).toMatchObject({ test: "approved" });
    expect(await x.files(B)).toEqual([]);
    expect(await settleEvalWrapperTest(x.wrapperDeps(B), project, { selection: x.need.selection, repository: "web", command: evalWrapperCommandOf("python"), report: { cwd: ".", argument: "rovara/eval-wrapper-results.xml" } }, "readable")).toBe(false);
    expect(await settleEvalWrapperTest(x.wrapperDeps(A), "other-project", { selection: x.need.selection, repository: "web", command: evalWrapperCommandOf("python"), report: { cwd: ".", argument: "rovara/eval-wrapper-results.xml" } }, "readable")).toBe(false);
    // The right company and project then takes it.
    expect(await recordEvalHealthResult(x.deps(), project, posted)).toEqual({ outcome: "finished" });
    expect((await x.files())[0]).toMatchObject({ test: "readable" });
  });

  it("a file record planted under this company's key by another company is not a file to answer", async () => {
    const x = await world();
    const [file] = await x.files();
    await x.w.store.put({ item: { pk: `ORG#${B}#SETUP_DRAFT#${project}`, sk: `EVAL_WRAPPER_FILE#${file!.id}`, ...file, company: A } as never });
    expect(await x.files(B)).toEqual([]);
  });
});

describe("one answer, once, and never a failure", () => {
  it("the same result posted again records nothing more", async () => {
    const x = await world();
    const { requestId, claimId } = await x.start();
    const posted = body(requestId, claimId, { status: "measured", record: record() });
    expect(await recordEvalHealthResult(x.deps(), project, posted)).toEqual({ outcome: "finished" });
    const spy = vi.spyOn(x.w.store, "update");
    x.clock.now += 5_000;
    expect(await recordEvalHealthResult(x.deps(), project, posted)).toEqual({ outcome: "duplicate" });
    expect(await recordEvalHealthResult(x.deps(), project, body(requestId, claimId, { status: "not_run", reason: "invalid_results" }))).toEqual({ outcome: "duplicate" });
    expect(spy).not.toHaveBeenCalled();
    expect((await x.files())[0]).toMatchObject({ test: "readable", testAt: new Date(NOW).toISOString() });
    spy.mockRestore();
  });

  it("an answer the file already holds is not written again", async () => {
    const x = await world();
    const plan = { selection: x.need.selection, repository: "web", command: evalWrapperCommandOf("python"), report: { cwd: ".", argument: "rovara/eval-wrapper-results.xml" } };
    expect(await settleEvalWrapperTest(x.wrapperDeps(), project, plan, "unreadable")).toBe(true);
    const spy = vi.spyOn(x.w.store, "update");
    expect(await settleEvalWrapperTest(x.wrapperDeps(), project, plan, "unreadable")).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("a store that fails on the file's row leaves the run's own outcome alone and the card at 'test approved'", async () => {
    const x = await world();
    const { requestId, claimId } = await x.start();
    const real = x.w.store.update.bind(x.w.store);
    const spy = vi.spyOn(x.w.store, "update").mockImplementation(async (request) => { if (String(request.key.sk).startsWith("EVAL_WRAPPER_FILE#")) throw new Error("store down"); return real(request); });
    expect(await recordEvalHealthResult(x.deps(), project, body(requestId, claimId, { status: "measured", record: record() }))).toEqual({ outcome: "finished" });
    spy.mockRestore();
    expect((await x.row())!.state).toBe("finished");
    expect((await x.cards())[0]).toMatchObject({ step: "test_approved" });
  });

  it("a write that loses a race with a newer check of the file changes nothing", async () => {
    const x = await world();
    const { requestId, claimId } = await x.start();
    const real = x.w.store.update.bind(x.w.store);
    // The file is checked again between the read and the write: the conditional write names the check it read, so it is not applied.
    const spy = vi.spyOn(x.w.store, "update").mockImplementation(async (request) => {
      if (String(request.key.sk).startsWith("EVAL_WRAPPER_FILE#")) { x.clock.now += 1_000; await detectEvalWrappers(x.wrapperDeps(), project, x.rep, { force: true }); }
      return real(request);
    });
    expect(await recordEvalHealthResult(x.deps(), project, body(requestId, claimId, { status: "measured", record: record() }))).toEqual({ outcome: "finished" });
    spy.mockRestore();
    expect((await x.files())[0]).toMatchObject({ test: "approved" });
  });
});
