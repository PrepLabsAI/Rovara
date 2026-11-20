// L4-EVW4 (DEC 254zzz43): a PERSON's click opens a small wrapper file as a PULL REQUEST on the customer's repository when Rovara cannot read the eval's output. This WRITES TO A CUSTOMER'S REPOSITORY, so every rule is a test
// here, against the fake code host (which refuses what the real adapter refuses): a Rovara branch only, never the default branch, never merged by Rovara, template files only (custom is copy-only), only a file the dry-run
// passed, once per file, never over a file (the file there is found and checked), audited before the write naming the person, fails closed, and one company never sees or touches another's.
import { describe, expect, it, vi } from "vitest";
import { EVAL_WRAPPER_NODE_PATH, EVAL_WRAPPER_PYTHON_PATH, change, evalCommandFingerprintOf, evalWrapperFor, type CodeHost, type EvalOutputShape, type SetupEvalDiscoveryReport } from "@agentx/contracts";
import { FakeCodeHost, FakeHostModel } from "@agentx/broker/fakes";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { setupPartition } from "../../packages/broker/src/core/setup-agent/keys.js";
import {
  EVAL_WRAPPER_SK_PREFIX, OPENING_STALE_MS, detectEvalWrappers, dismissEvalWrapper, listEvalWrapperFiles, listEvalWrappers, needsOf, openEvalWrapperPullRequest, readEvalWrapperDismissed, recordEvalWrapperTest, refreshEvalWrappers, reopenEvalWrapper, wrapperFileFor,
  type EvalWrapperDeps,
} from "../../packages/broker/src/core/setup-agent/eval-wrapper.js";
import { readEvalWrapperCards } from "../../packages/broker/src/core/setup-agent/eval-wrapper-card.js";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import type { EvalWrapperTarget as RepoFileTarget } from "../../packages/broker/src/core/setup-agent/eval-wrapper-host.js";

const A = COMPANY_A.orgId; const B = COMPANY_B.orgId;
const PROJECT = "demo";
const URL_A = "https://github.com/acme/api";
const IMAGE = `registry.example/worker@sha256:${"e".repeat(64)}`;
const command = { executable: "python3", args: ["evals/run.py"], cwd: "." };
const reportPath = { cwd: ".", argument: "evals/out/results.jsonl" };
const ROWS: EvalOutputShape = { kind: "rows", format: "jsonl", language: "python", idField: "case_id", pass: { field: "passed", equals: true } };

const suiteOf = (output: EvalOutputShape | undefined, over: Record<string, unknown> = {}) => ({
  selection: "evals/agent", repository: "api",
  questions: [{ id: "q1", category: "ordinary", path: "evals/agent/q1.json" }, { id: "q2", category: "safety", path: "evals/agent/q2.json" }],
  command, report: reportPath, ...(output === undefined ? {} : { output }), commandFingerprint: evalCommandFingerprintOf(command, reportPath),
  judge: { kind: "rule", scoringPath: "evals/agent/score.py" }, subsetSupported: false, catalogRowId: "gemini", model: "gemini-2.5-pro", modelVersion: "gemini-2.5-pro-001",
  image: IMAGE, route: "gateway", maxCallsPerQuestion: 2, maxCostMicrosPerQuestion: 100_000, ...(output === undefined ? {} : { wrapperDryRun: "passed" }), ...over,
});
const reportOf = (...suites: Array<ReturnType<typeof suiteOf>>): SetupEvalDiscoveryReport => ({ schemaVersion: 1, suites }) as unknown as SetupEvalDiscoveryReport;

interface World {
  store: MemoryDocumentStore; model: FakeHostModel; host: FakeCodeHost; target: RepoFileTarget; audits: Array<{ action: string; details: Record<string, string> }>;
  deps(company?: typeof A, over?: Partial<EvalWrapperDeps>): EvalWrapperDeps; clock: { now: number };
}
function world(options: { files?: Record<string, string>; place?: string; host?: (model: FakeHostModel) => CodeHost } = {}): World {
  const store = new MemoryDocumentStore();
  const model = new FakeHostModel({ url: URL_A, id: "4242", fullName: "acme/api", webBase: "https://github.com", ...(options.files === undefined ? {} : { initialFiles: options.files }) });
  const host = new FakeCodeHost(model);
  const target: RepoFileTarget = { name: "api", place: options.place ?? "fake:repo/4242", repository: { url: URL_A }, scope: { orgId: A }, host: options.host?.(model) ?? host };
  const audits: World["audits"] = [];
  const clock = { now: Date.parse("2026-11-18T08:00:00.000Z") };
  let n = 0;
  return {
    store, model, host, target, audits, clock,
    deps: (company = A, over = {}) => ({ store, companyId: company, now: () => clock.now, targets: async () => [target], audit: async (event) => { audits.push(event); }, randomHex: () => { n += 1; return n.toString(16).padStart(12, "0"); }, ...over }),
  };
}
/** A person's click for every eval of the report that needs a file, in order (the route does one per click; the outcomes are the same). */
const propose = async (w: World, report: SetupEvalDiscoveryReport, over: { deps?: Partial<EvalWrapperDeps>; by?: string } = {}) => {
  const out = [];
  for (const need of needsOf(report)) out.push(await openEvalWrapperPullRequest(w.deps(A, over.deps), PROJECT, { report, selection: need.selection, taskId: "task-1", by: over.by ?? "person-1" }));
  return out;
};
const cards = (w: World, report: SetupEvalDiscoveryReport, canManage = true, company = A) => readEvalWrapperCards(w.deps(company), PROJECT, { reportDigest: "d".repeat(64), report }, canManage);

describe("opening the proposal", () => {

  it("uses the Node file for a Node eval", async () => {
    const w = world();
    await propose(w, reportOf(suiteOf({ ...ROWS, language: "node" })));
    expect(w.model.revision(w.model.headOf(w.model.changeRequests[0]!.sourceBranch)).files.has(EVAL_WRAPPER_NODE_PATH)).toBe(true);
  });

  it("REFUSES a custom (AI-written) wrapper on the direct path: nothing is written, no audit, no record; the card is copy-only and still shows the file", async () => {
    const c = world();
    const report = reportOf(suiteOf({ kind: "custom", language: "python", summary: "reads scores.csv", source: "print('hello')\n" }));
    expect(await propose(c, report)).toMatchObject([{ state: "failed", failure: "copy_only" }]);
    expect(c.model.changeRequests).toHaveLength(0);
    expect([...c.model.branches.keys()]).toEqual(["main"]);
    expect(c.audits).toEqual([]);
    expect(await listEvalWrappers(c.deps(), PROJECT)).toEqual([]);
    const [card] = await cards(c, report);
    expect(card).toMatchObject({ kind: "custom", canOpenPullRequest: false, copyOnly: { reason: "custom" }, path: EVAL_WRAPPER_PYTHON_PATH, summary: "reads scores.csv" });
    expect(card!.content).toMatch(/Written by Rovara's setup agent.*reads scores\.csv/u);
  });

  it("opens nothing for a file the setup run's dry-run did not pass (or never ran): the file is not offered, shown or opened", async () => {
    for (const mark of [{ wrapperDryRun: "failed" }, { wrapperDryRun: undefined }]) {
      const w = world();
      const report = reportOf(suiteOf(ROWS, mark));
      expect(await propose(w, report)).toMatchObject([{ state: "failed", failure: "not_offered" }]);
      expect(w.model.changeRequests).toHaveLength(0);
      expect(w.audits).toEqual([]);
      const [card] = await cards(w, report);
      expect(card).toMatchObject({ offered: false, step: "not_offered", canOpenPullRequest: false, content: "" });
    }
  });

  it("opens nothing for an eval that needs no file", async () => {
    const w = world();
    const report = reportOf(suiteOf({ kind: "junit" }));
    expect(await openEvalWrapperPullRequest(w.deps(), PROJECT, { report, selection: "evals/agent", taskId: "t", by: "person-1" })).toMatchObject({ failure: "not_needed" });
    expect(await openEvalWrapperPullRequest(w.deps(), PROJECT, { report, selection: "evals/missing", taskId: "t", by: "person-1" })).toMatchObject({ failure: "not_needed" });
    expect(w.model.changeRequests).toHaveLength(0);
  });

  it("does not open a second pull request for the same file while the first is open (another shape), nor for a second suite in the same run", async () => {
    const w = world();
    await propose(w, reportOf(suiteOf(ROWS)));
    const other = await propose(w, reportOf(suiteOf({ ...ROWS, idField: "name" })));
    expect(other[0]).toMatchObject({ state: "skipped", failure: "another_shape" });
    expect(w.model.changeRequests).toHaveLength(1);
    // A monorepo: one pull request for the FIRST eval, copy for the rest.
    const two = world();
    const both = reportOf(suiteOf(ROWS), suiteOf({ ...ROWS, idField: "name" }, { selection: "evals/zz" }));
    const out = await propose(two, both);
    expect(out.map((o) => o.state)).toEqual(["open", "failed"]);
    expect(out[1]).toMatchObject({ failure: "another_eval" });
    expect(two.model.changeRequests).toHaveLength(1);
    const view = await cards(two, both);
    expect(view.map((card) => card.canOpenPullRequest)).toEqual([false, false]);
    expect(view[1]).toMatchObject({ copyOnly: { reason: "another_eval" } });
    expect(view[1]!.content).toContain('"idField": "name"');
  });

  it("a symbolic link at the path is left alone too", async () => {
    const link = world();
    link.model.commitEntry("main", EVAL_WRAPPER_PYTHON_PATH, "symlink", "target");
    expect((await propose(link, reportOf(suiteOf(ROWS))))[0]).toMatchObject({ state: "failed", failure: "file_exists" });
    expect(link.model.changeRequests).toHaveLength(0);
    expect([...link.model.branches.keys()]).toEqual(["main"]);
  });
});

describe("failing closed", () => {
  it("a failed audit means no write at all", async () => {
    const w = world();
    const commit = vi.spyOn(w.host.evalWrapperPullRequest, "open");
    const [outcome] = await propose(w, reportOf(suiteOf(ROWS)), { deps: { audit: async () => { throw new Error("down"); } } });
    expect(outcome).toMatchObject({ state: "failed", failure: "audit" });
    expect(commit).not.toHaveBeenCalled();
    expect(w.model.changeRequests).toHaveLength(0);
    expect(await listEvalWrappers(w.deps(), PROJECT)).toEqual([]);
  });

  it("a host that cannot take files, a repository that cannot be named and one that is not the pinned one write nothing", async () => {
    const noWrite = world({ host: (model) => { const h = new FakeCodeHost(model); (h as unknown as { evalWrapperPullRequest: undefined }).evalWrapperPullRequest = undefined; return h; } });
    expect((await propose(noWrite, reportOf(suiteOf(ROWS))))[0]).toMatchObject({ failure: "host_cannot" });
    const none = world();
    expect((await propose(none, reportOf(suiteOf(ROWS, { repository: "other" }))))[0]).toMatchObject({ failure: "no_repository" });
    expect((await propose(none, reportOf(suiteOf(ROWS)), { deps: { targets: async () => { throw new Error("no"); } } }))[0]).toMatchObject({ failure: "no_repository" });
    const moved = world({ place: "fake:repo/9999" });
    expect((await propose(moved, reportOf(suiteOf(ROWS))))[0]).toMatchObject({ failure: "unreachable" });
    for (const w of [noWrite, none, moved]) expect(w.model.changeRequests).toHaveLength(0);
    expect(moved.audits).toEqual([]);
  });

  it("a refused pull request (branch protection, no write access) drops the branch it made, falls back to COPY, and a person may ask again", async () => {
    const w = world();
    const report = reportOf(suiteOf(ROWS));
    vi.spyOn(w.model, "reconcile").mockImplementationOnce(() => { throw new Error("refused"); });
    expect((await propose(w, report))[0]).toMatchObject({ state: "failed", failure: "refused" });
    expect([...w.model.branches.keys()]).toEqual(["main"]);
    const [card] = await cards(w, report);
    expect(card).toMatchObject({ step: "needs_file", copyOnly: { reason: "cannot_write" }, canOpenPullRequest: false });
    expect(card!.content).toMatch(/rovara-eval-wrapper-template/u);
    // Each ask is a person's click; the second works.
    expect((await propose(w, report))[0]).toMatchObject({ state: "open", number: "1" });
    expect(w.audits.map((a) => a.action)).toEqual(["eval_wrapper.pull_request_requested", "eval_wrapper.pull_request_requested"]);
  });

  it("a claim left opening by a process that ended is recovered: the pull request is found by its branch, or the proposal is marked interrupted", async () => {
    const w = world();
    await propose(w, reportOf(suiteOf(ROWS)));
    const [row] = await listEvalWrappers(w.deps(), PROJECT);
    const key = { pk: setupPartition(A, PROJECT), sk: `${EVAL_WRAPPER_SK_PREFIX}${row!.id}` };
    // A fresh claim is left alone (another call is mid-way).
    await w.store.update({ key, ops: [change.set("state", "opening")] });
    expect((await propose(w, reportOf(suiteOf(ROWS))))[0]).toMatchObject({ state: "opening", replayed: true });
    // A stale one whose pull request exists is found by its branch.
    w.clock.now += OPENING_STALE_MS + 1_000;
    expect((await propose(w, reportOf(suiteOf(ROWS))))[0]).toMatchObject({ state: "open", replayed: true });
    expect(w.model.changeRequests).toHaveLength(1);
    // A stale one with no pull request is marked interrupted (its branch is left for a person: Rovara no longer knows the head it left).
    const lost = world();
    await propose(lost, reportOf(suiteOf(ROWS)));
    const [made] = await listEvalWrappers(lost.deps(), PROJECT);
    lost.model.changeRequests.length = 0;
    await lost.store.update({ key: { pk: setupPartition(A, PROJECT), sk: `${EVAL_WRAPPER_SK_PREFIX}${made!.id}` }, ops: [change.set("state", "opening")] });
    lost.clock.now += OPENING_STALE_MS + 1_000;
    const after = await propose(lost, reportOf(suiteOf(ROWS)));
    // The interrupted claim is recovered to "failed", and the person's own click then opens a fresh pull request (never over the other branch it left behind).
    expect(after[0]).toMatchObject({ state: "open" });
    expect(lost.model.changeRequests).toHaveLength(1);
  });
});

describe("review fixes (L4-EVW2 REVIEW-1)", () => {
  it("never deletes a branch it did not make: a branch that appears under the chosen name is left exactly as it is", async () => {
    const w = world();
    const base = w.model.headOf("main");
    // Somebody creates the branch between Rovara's check and its write: the write is a conflict, and the other person's branch stays.
    const open = w.host.evalWrapperPullRequest.open.bind(w.host.evalWrapperPullRequest);
    w.host.evalWrapperPullRequest.open = async (input, scope) => { w.model.branches.set(input.branch, base); w.model.commit(input.branch, { "theirs.txt": "x" }); return open(input, scope); };
    const remove = vi.spyOn(w.model, "removeBranch");
    const [outcome] = await propose(w, reportOf(suiteOf(ROWS)));
    expect(outcome).toMatchObject({ state: "failed", failure: "conflict" });
    expect(remove).not.toHaveBeenCalled();
    expect(w.model.branches.size).toBe(2);
  });

  it("a stored branch that is not a wrapper branch name is not a record at all (it can never be recovered into a delete)", async () => {
    const w = world();
    await propose(w, reportOf(suiteOf(ROWS)));
    const [row] = await listEvalWrappers(w.deps(), PROJECT);
    await w.store.update({ key: { pk: setupPartition(A, PROJECT), sk: `${EVAL_WRAPPER_SK_PREFIX}${row!.id}` }, ops: [change.set("branch", "rovara/lessons-0123456789ab"), change.set("state", "opening")] });
    expect(await listEvalWrappers(w.deps(), PROJECT)).toEqual([]);
    const remove = vi.spyOn(w.model, "removeBranch");
    w.clock.now += OPENING_STALE_MS + 1_000;
    await propose(w, reportOf(suiteOf(ROWS)));
    expect(remove).not.toHaveBeenCalledWith("rovara/lessons-0123456789ab");
  });
});

describe("a person's decision on the pull request", () => {
  const open = async (w: World) => { await propose(w, reportOf(suiteOf(ROWS))); return w.model.changeRequests[0]!; };

  it("a merged pull request tells setup to read the eval again; Rovara never made the merge", async () => {
    const w = world();
    const cr = await open(w);
    w.model.merge(cr.id, { revision: w.model.headRevisionOf(cr), method: "squash" });
    await refreshEvalWrappers(w.deps(), PROJECT);
    const merged = (await cards(w, reportOf(suiteOf(ROWS))))[0]!;
    expect(merged).toMatchObject({ step: "pull_request_open", pullRequest: { state: "merged" } });
    expect(merged.line).toContain("looking for the file on your default branch");
    // No "run setup again": once the file is on the default branch, a read finds it and the card moves on by itself.
    await detectEvalWrappers(w.deps(), PROJECT, reportOf(suiteOf(ROWS)), { force: true });
    expect((await cards(w, reportOf(suiteOf(ROWS))))[0]).toMatchObject({ step: "file_found", fileStatus: "same" });
  });

  it("a closed pull request is a 'no': it is not opened again, and a changed wrapper is a new proposal", async () => {
    const w = world();
    const cr = await open(w);
    w.model.update(cr.id, { state: "closed" });
    await refreshEvalWrappers(w.deps(), PROJECT);
    expect((await cards(w, reportOf(suiteOf(ROWS))))[0]).toMatchObject({ pullRequest: { state: "closed" }, copyOnly: { reason: "closed" }, canOpenPullRequest: false });
    expect((await propose(w, reportOf(suiteOf(ROWS))))[0]).toMatchObject({ state: "closed", failure: "closed", replayed: true });
    expect(w.model.changeRequests).toHaveLength(1);
    const changed = await propose(w, reportOf(suiteOf({ ...ROWS, idField: "name" })));
    expect(changed[0]).toMatchObject({ state: "open" });
    expect(w.model.changeRequests).toHaveLength(2);
    expect(w.model.changeRequests[1]!.sourceBranch).not.toBe(cr.sourceBranch);
  });

  it("only the host's answer changes a record: an unreadable host and a pull request that is not Rovara's leave it open", async () => {
    const w = world();
    const cr = await open(w);
    vi.spyOn(w.host, "getChangeRequest").mockRejectedValueOnce(new Error("down"));
    await refreshEvalWrappers(w.deps(), PROJECT);
    expect((await listEvalWrappers(w.deps(), PROJECT))[0]!.state).toBe("open");
    // The record points at a pull request that was made from some other branch (a person's own): it is never taken as Rovara's, whatever happens to it.
    w.model.commit("feature/theirs", { "theirs.txt": "x" });
    const theirs = w.model.reconcile({ sourceBranch: "feature/theirs", targetBranch: "main", title: "theirs" }, "someone-else").cr;
    const [row] = await listEvalWrappers(w.deps(), PROJECT);
    await w.store.update({ key: { pk: setupPartition(A, PROJECT), sk: `${EVAL_WRAPPER_SK_PREFIX}${row!.id}` }, ops: [change.set("number", theirs.id)] });
    w.model.update(theirs.id, { state: "closed" });
    w.model.update(cr.id, { state: "closed" });
    await refreshEvalWrappers(w.deps(), PROJECT);
    expect((await listEvalWrappers(w.deps(), PROJECT))[0]!.state).toBe("open");
  });
});

describe("detecting the file on the DEFAULT branch (no 'run setup again')", () => {
  const report = () => reportOf(suiteOf(ROWS));
  const expected = () => evalWrapperFor({ command, report: reportPath, output: ROWS })!;

  it("a young check is left as it is and Check now looks again; a host that cannot answer changes nothing", async () => {
    const w = world();
    await detectEvalWrappers(w.deps(), PROJECT, report());
    w.model.commit("main", { [EVAL_WRAPPER_PYTHON_PATH]: expected().content });
    await detectEvalWrappers(w.deps(), PROJECT, report());
    expect((await listEvalWrapperFiles(w.deps(), PROJECT))[0]).toMatchObject({ status: "absent" });
    await detectEvalWrappers(w.deps(), PROJECT, report(), { force: true });
    expect((await listEvalWrapperFiles(w.deps(), PROJECT))[0]).toMatchObject({ status: "present" });
    vi.spyOn(w.host, "pathKind").mockRejectedValue(new Error("down"));
    w.model.commit("main", { "x.txt": "y" });
    await detectEvalWrappers(w.deps(), PROJECT, report(), { force: true });
    expect((await listEvalWrapperFiles(w.deps(), PROJECT))[0]).toMatchObject({ status: "present" });
  });

  it("a monorepo's second eval is never read through the first eval's file (review M1): its own row, copy only, and the first's test state survives a check", async () => {
    const w = world();
    const two = reportOf(suiteOf(ROWS), suiteOf({ ...ROWS, idField: "name" }, { selection: "evals/zz" }));
    w.model.commit("main", { [EVAL_WRAPPER_PYTHON_PATH]: expected().content });
    await detectEvalWrappers(w.deps(), PROJECT, two, { force: true });
    const files = await listEvalWrapperFiles(w.deps(), PROJECT);
    expect(files.map((row) => [row.selection, row.match]).sort()).toEqual([["evals/agent", "same"], ["evals/zz", "other"]]);
    expect(wrapperFileFor(files, { repository: "api", selection: "evals/agent", firstOfFile: true }, "python")).toBeDefined();
    expect(wrapperFileFor(files, { repository: "api", selection: "evals/zz", firstOfFile: false }, "python")).toBeUndefined();
    const [first, second] = await cards(w, two);
    expect(first).toMatchObject({ step: "file_found" });
    expect(second).toMatchObject({ step: "needs_file", copyOnly: { reason: "another_eval" }, canOpenPullRequest: false });
    await recordEvalWrapperTest(w.deps(), PROJECT, { repository: "api", selection: "evals/agent", language: "python" }, "approved");
    await detectEvalWrappers(w.deps(), PROJECT, two, { force: true });
    expect((await cards(w, two))[0]).toMatchObject({ step: "test_approved" });
    expect(await recordEvalWrapperTest(w.deps(), PROJECT, { repository: "api", selection: "evals/zz", language: "python" }, "approved")).toBe(true);
    expect((await cards(w, two))[1]).toMatchObject({ step: "needs_file" });
  });

  it("another eval's own file put at the shared path is never this eval's file (re-check M1-mirror): the first eval is not approvable through the second's text", async () => {
    const w = world();
    const two = reportOf(suiteOf(ROWS), suiteOf({ ...ROWS, idField: "name" }, { selection: "evals/zz" }));
    const second = evalWrapperFor({ command, report: reportPath, output: { ...ROWS, idField: "name" } })!;
    w.model.commit("main", { [EVAL_WRAPPER_PYTHON_PATH]: second.content });
    await detectEvalWrappers(w.deps(), PROJECT, two, { force: true });
    const files = await listEvalWrapperFiles(w.deps(), PROJECT);
    expect(files.find((row) => row.selection === "evals/agent")).toMatchObject({ match: "other" });
    expect(wrapperFileFor(files, { repository: "api", selection: "evals/agent", firstOfFile: true }, "python")).toBeUndefined();
    expect((await cards(w, two))[0]).toMatchObject({ step: "needs_file", copyOnly: { reason: "file_exists" }, canOpenPullRequest: false });
    expect((await cards(w, two))[0]!.fileStatus).toBeUndefined();
  });

  it("is read only: nothing is written to the repository, and the repository must be the one the project pins", async () => {
    const w = world();
    const commit = vi.spyOn(w.host.evalWrapperPullRequest, "open");
    await detectEvalWrappers(w.deps(), PROJECT, report(), { force: true });
    expect(commit).not.toHaveBeenCalled();
    const moved = world({ place: "fake:repo/9999" });
    moved.model.commit("main", { [EVAL_WRAPPER_PYTHON_PATH]: expected().content });
    await detectEvalWrappers(moved.deps(), PROJECT, report(), { force: true });
    expect(await listEvalWrapperFiles(moved.deps(), PROJECT)).toEqual([]);
  });
});

describe("Not now: a per-project dismissed state", () => {
  const report = () => reportOf(suiteOf(ROWS));

  it("sets the card aside for this report, with the audit naming the person; a newer report asks again; Set up now undoes it", async () => {
    const w = world();
    await dismissEvalWrapper(w.deps(), PROJECT, { reportDigest: "d".repeat(64), by: "person-1" });
    expect(w.audits[0]).toMatchObject({ action: "eval_wrapper.dismissed", details: { by: "person-1" } });
    expect(await readEvalWrapperDismissed(w.deps(), PROJECT)).toMatchObject({ by: "person-1", reportDigest: "d".repeat(64) });
    expect((await cards(w, report()))[0]).toMatchObject({ step: "dismissed", dismissed: true });
    // Another setup run's report (another digest) asks again.
    expect((await readEvalWrapperCards(w.deps(), PROJECT, { reportDigest: "e".repeat(64), report: report() }, true))[0]).toMatchObject({ step: "needs_file", dismissed: false });
    await reopenEvalWrapper(w.deps(), PROJECT, { by: "person-2" });
    expect(w.audits[1]).toMatchObject({ action: "eval_wrapper.reopened", details: { by: "person-2" } });
    expect(await readEvalWrapperDismissed(w.deps(), PROJECT)).toBeUndefined();
    expect((await cards(w, report()))[0]).toMatchObject({ step: "needs_file", dismissed: false });
  });
});

describe("two companies", () => {
  it("one company's proposal is invisible to another, and another company's planted row is never read", async () => {
    const w = world();
    await propose(w, reportOf(suiteOf(ROWS)));
    expect(await listEvalWrappers(w.deps(B), PROJECT)).toEqual([]);
    const forOther = await cards(w, reportOf(suiteOf(ROWS)), true, B);
    expect(forOther[0]).toMatchObject({ step: "needs_file" });
    expect(forOther[0]!.pullRequest).toBeUndefined();
    await dismissEvalWrapper(w.deps(A), PROJECT, { reportDigest: "d".repeat(64), by: "p" });
    expect(await readEvalWrapperDismissed(w.deps(B), PROJECT)).toBeUndefined();
    w.model.commit("main", { [EVAL_WRAPPER_PYTHON_PATH]: evalWrapperFor({ command, report: reportPath, output: ROWS })!.content });
    await detectEvalWrappers(w.deps(A), PROJECT, reportOf(suiteOf(ROWS)), { force: true });
    expect(await listEvalWrapperFiles(w.deps(B), PROJECT)).toEqual([]);
    expect(await recordEvalWrapperTest(w.deps(B), PROJECT, { repository: "api", selection: "evals/agent", language: "python" }, "approved")).toBe(false);
    // B's same-named project proposes its own, apart from A's.
    const [row] = await listEvalWrappers(w.deps(A), PROJECT);
    await w.store.put({ item: { pk: `ORG#${B}#SETUP_DRAFT#${PROJECT}`, sk: `EVAL_WRAPPER#${row!.id}`, ...row, company: A } as never });
    expect(await listEvalWrappers(w.deps(B), PROJECT)).toEqual([]);
    // The same for what was found on the default branch and for "Not now": another company's row copied under this company's key is not read.
    const [file] = await listEvalWrapperFiles(w.deps(A), PROJECT);
    await w.store.put({ item: { pk: setupPartition(B, PROJECT), sk: `EVAL_WRAPPER_FILE#${file!.id}`, ...file, company: A } as never });
    expect(await listEvalWrapperFiles(w.deps(B), PROJECT)).toEqual([]);
    await w.store.put({ item: { pk: setupPartition(B, PROJECT), sk: "EVAL_WRAPPER_DISMISSED", entityType: "EVAL_WRAPPER_DISMISSED", schemaVersion: 1, company: A, project: PROJECT, reportDigest: "d".repeat(64), by: "x", at: "2026-11-18T08:00:00.000Z" } });
    expect(await readEvalWrapperDismissed(w.deps(B), PROJECT)).toBeUndefined();
    await w.store.put({ item: { pk: setupPartition(A, "other-project"), sk: "EVAL_WRAPPER_DISMISSED", entityType: "EVAL_WRAPPER_DISMISSED", schemaVersion: 1, company: A, project: PROJECT, reportDigest: "d".repeat(64), by: "x", at: "2026-11-18T08:00:00.000Z" } });
    expect(await readEvalWrapperDismissed(w.deps(A), "other-project")).toBeUndefined();
    const forB = world();
    await openEvalWrapperPullRequest(forB.deps(B), PROJECT, { report: reportOf(suiteOf(ROWS)), selection: "evals/agent", taskId: "t", by: "x" });
    expect((await listEvalWrappers(forB.deps(B), PROJECT))).toHaveLength(1);
    expect(await listEvalWrappers(forB.deps(A), PROJECT)).toEqual([]);
  });
});
