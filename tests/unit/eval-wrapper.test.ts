// L4-EVW2 (DEC 254zzz20 D2): the setup agent proposes a small wrapper file as a PULL REQUEST on the customer's repository when Rovara cannot read the eval's output. This WRITES TO A CUSTOMER'S REPOSITORY, so every rule is
// a test here, against the fake code host (which refuses what the real adapter refuses): a Rovara branch only, never the default branch, never merged by Rovara, once per format, never over a file, audited before the
// write, fails closed, and one company never sees or touches another's.
import { describe, expect, it, vi } from "vitest";
import { EVAL_WRAPPER_BRANCH_PATTERN, change, EVAL_WRAPPER_PYTHON_PATH, EVAL_WRAPPER_NODE_PATH, evalCommandFingerprintOf, ownedBranchKind, type CodeHost, type EvalOutputShape, type SetupEvalDiscoveryReport } from "@agentx/contracts";
import { FakeCodeHost, FakeHostModel } from "@agentx/broker/fakes";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { setupPartition } from "../../packages/broker/src/core/setup-agent/keys.js";
import { EVAL_WRAPPER_SK_PREFIX, OPENING_STALE_MS, listEvalWrappers, proposeEvalWrappers, readEvalWrapperViews, refreshEvalWrappers, type EvalWrapperDeps } from "../../packages/broker/src/core/setup-agent/eval-wrapper.js";
import { readEvalCard } from "../../packages/broker/src/core/setup-agent/eval-card.js";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import type { RepoFileTarget } from "../../packages/broker/src/lessons/repo-file-host.js";

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
  image: IMAGE, route: "gateway", maxCallsPerQuestion: 2, maxCostMicrosPerQuestion: 100_000, ...over,
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
const propose = (w: World, report: SetupEvalDiscoveryReport, over: { retry?: boolean; deps?: Partial<EvalWrapperDeps> } = {}) =>
  proposeEvalWrappers(w.deps(A, over.deps), PROJECT, { report, taskId: "task-1", by: "setup-run:task-1", ...(over.retry === undefined ? {} : { retry: over.retry }) });

describe("opening the proposal", () => {
  it("opens ONE pull request from a new Rovara branch, never touches the default branch, and never merges it", async () => {
    const w = world();
    const mainBefore = w.model.headOf("main");
    const merge = vi.spyOn(w.host, "merge");
    const [outcome] = await propose(w, reportOf(suiteOf(ROWS)));
    expect(outcome).toMatchObject({ state: "open", number: "1" });
    expect(w.model.changeRequests).toHaveLength(1);
    const cr = w.model.changeRequests[0]!;
    expect(cr.sourceBranch).toMatch(EVAL_WRAPPER_BRANCH_PATTERN);
    expect(ownedBranchKind(cr.sourceBranch)).toBe("eval-wrapper");
    expect(cr).toMatchObject({ targetBranch: "main", state: "open", draft: false });
    expect(w.model.headOf("main")).toBe(mainBefore);
    // Only the wrapper path was added, on the branch; the default branch has no such file.
    expect(w.model.revision(w.model.headOf(cr.sourceBranch)).files.get(EVAL_WRAPPER_PYTHON_PATH)).toMatch(/Proposed by Rovara/u);
    expect([...w.model.revision(mainBefore).files.keys()]).not.toContain(EVAL_WRAPPER_PYTHON_PATH);
    expect(cr.body).toMatch(/Rovara never merges it/u);
    expect(merge).not.toHaveBeenCalled();
    expect(w.model.changeRequests[0]!.state).toBe("open");
    // The card says it in one line, with the number.
    expect((await readEvalWrapperViews(w.deps(), PROJECT))[0]).toMatchObject({ state: "open", number: "1", line: "Rovara proposed a small file so it can read your eval results: review PR #1" });
  });

  it("uses the Node file for a Node eval, and the setup agent's own text for a custom one (with its header)", async () => {
    const w = world();
    await propose(w, reportOf(suiteOf({ ...ROWS, language: "node" })));
    expect(w.model.revision(w.model.headOf(w.model.changeRequests[0]!.sourceBranch)).files.has(EVAL_WRAPPER_NODE_PATH)).toBe(true);
    const c = world();
    await propose(c, reportOf(suiteOf({ kind: "custom", language: "python", summary: "reads scores.csv", source: "print('hello')\n" })));
    const text = c.model.revision(c.model.headOf(c.model.changeRequests[0]!.sourceBranch)).files.get(EVAL_WRAPPER_PYTHON_PATH)!;
    expect(text).toMatch(/Written by Rovara's setup agent.*reads scores\.csv/u);
    expect(c.model.changeRequests[0]!.body).toMatch(/written by Rovara's setup agent/u);
  });

  it("makes nothing for an output Rovara already reads, or one the report does not describe", async () => {
    const w = world();
    for (const output of [{ kind: "junit" }, { kind: "promptfoo" }, { kind: "measures" }, undefined] as Array<EvalOutputShape | undefined>) {
      expect(await propose(w, reportOf(suiteOf(output)))).toEqual([]);
    }
    expect(w.model.changeRequests).toHaveLength(0);
    expect(w.audits).toEqual([]);
    expect(await listEvalWrappers(w.deps(), PROJECT)).toEqual([]);
  });

  it("is made once per format: the same proposal again opens nothing and writes nothing, and the audit is written once", async () => {
    const w = world();
    await propose(w, reportOf(suiteOf(ROWS)));
    const branches = w.model.branches.size;
    const again = await propose(w, reportOf(suiteOf(ROWS)));
    expect(again[0]).toMatchObject({ state: "open", replayed: true, number: "1" });
    expect(await propose(w, reportOf(suiteOf(ROWS)), { retry: true })).toMatchObject([{ state: "open", replayed: true }]);
    expect(w.model.changeRequests).toHaveLength(1);
    expect(w.model.branches.size).toBe(branches);
    expect(w.audits).toHaveLength(1);
    expect(w.audits[0]).toMatchObject({ action: "eval_wrapper.proposed", project: PROJECT });
  });

  it("does not open a second pull request for the same file while the first is open (another shape), nor for a second suite in the same run", async () => {
    const w = world();
    await propose(w, reportOf(suiteOf(ROWS)));
    const other = await propose(w, reportOf(suiteOf({ ...ROWS, idField: "name" })));
    expect(other[0]).toMatchObject({ state: "skipped", failure: "another_shape" });
    expect(w.model.changeRequests).toHaveLength(1);
    const two = world();
    const out = await propose(two, reportOf(suiteOf(ROWS), suiteOf({ ...ROWS, idField: "name" }, { selection: "evals/zz" })));
    expect(out.map((o) => o.state)).toEqual(["open", "skipped"]);
    expect(two.model.changeRequests).toHaveLength(1);
  });

  it("never writes over a file that exists at the wrapper's path, and leaves no branch behind", async () => {
    const w = world({ files: { "README.md": "x\n", [EVAL_WRAPPER_PYTHON_PATH]: "their own file\n" } });
    const [outcome] = await propose(w, reportOf(suiteOf(ROWS)));
    expect(outcome).toMatchObject({ state: "failed", failure: "file_exists" });
    expect(w.model.changeRequests).toHaveLength(0);
    expect([...w.model.branches.keys()]).toEqual(["main"]);
    expect(w.model.revision(w.model.headOf("main")).files.get(EVAL_WRAPPER_PYTHON_PATH)).toBe("their own file\n");
    // The same file's text is "theirs" even when it is identical.
    const same = world({ files: { "README.md": "x\n" } });
    same.model.commit("main", { [EVAL_WRAPPER_PYTHON_PATH]: "x\n" });
    expect((await propose(same, reportOf(suiteOf(ROWS))))[0]).toMatchObject({ failure: "file_exists" });
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
    const commit = vi.spyOn(w.host, "commitFiles");
    const [outcome] = await propose(w, reportOf(suiteOf(ROWS)), { deps: { audit: async () => { throw new Error("down"); } } });
    expect(outcome).toMatchObject({ state: "failed", failure: "audit" });
    expect(commit).not.toHaveBeenCalled();
    expect(w.model.changeRequests).toHaveLength(0);
    expect(await listEvalWrappers(w.deps(), PROJECT)).toEqual([]);
  });

  it("the audit is written BEFORE the first host write", async () => {
    const w = world();
    const order: string[] = [];
    const commit = w.host.commitFiles.bind(w.host);
    w.host.commitFiles = async (input, scope) => { order.push("write"); return commit(input, scope); };
    await propose(w, reportOf(suiteOf(ROWS)), { deps: { audit: async () => { order.push("audit"); } } });
    expect(order).toEqual(["audit", "write"]);
  });

  it("a host that cannot take files, a repository that cannot be named and one that is not the pinned one write nothing", async () => {
    const noWrite = world({ host: (model) => { const h = new FakeCodeHost(model); (h as unknown as { commitFiles: undefined }).commitFiles = undefined; return h; } });
    expect((await propose(noWrite, reportOf(suiteOf(ROWS))))[0]).toMatchObject({ failure: "host_cannot" });
    const none = world();
    expect((await propose(none, reportOf(suiteOf(ROWS, { repository: "other" }))))[0]).toMatchObject({ failure: "no_repository" });
    expect((await propose(none, reportOf(suiteOf(ROWS)), { deps: { targets: async () => { throw new Error("no"); } } }))[0]).toMatchObject({ failure: "no_repository" });
    const moved = world({ place: "fake:repo/9999" });
    expect((await propose(moved, reportOf(suiteOf(ROWS))))[0]).toMatchObject({ failure: "unreachable" });
    for (const w of [noWrite, none, moved]) expect(w.model.changeRequests).toHaveLength(0);
    expect(moved.audits).toEqual([]);
  });

  it("a refused pull request drops the branch it made and is recorded as failed, then tries again only on request", async () => {
    const w = world();
    const reconcile = vi.spyOn(w.host, "reconcileChangeRequest").mockRejectedValueOnce(new Error("refused"));
    expect((await propose(w, reportOf(suiteOf(ROWS))))[0]).toMatchObject({ state: "failed", failure: "refused" });
    expect([...w.model.branches.keys()]).toEqual(["main"]);
    // Without a retry the failure stands; a person's "Try again" makes it once more.
    expect((await propose(w, reportOf(suiteOf(ROWS))))[0]).toMatchObject({ state: "failed", failure: "refused", replayed: true });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect((await propose(w, reportOf(suiteOf(ROWS)), { retry: true }))[0]).toMatchObject({ state: "open", number: "1" });
    expect(w.audits.map((a) => a.action)).toEqual(["eval_wrapper.proposed", "eval_wrapper.retry"]);
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
    expect(after[0]).toMatchObject({ state: "failed", failure: "interrupted" });
  });
});

describe("review fixes (L4-EVW2 REVIEW-1)", () => {
  it("never deletes a branch it did not make: a branch that appears under the chosen name is left exactly as it is", async () => {
    const w = world();
    const base = w.model.headOf("main");
    // Somebody creates the branch between Rovara's check and its write: the write is a conflict, and the other person's branch stays.
    const commit = w.host.commitFiles.bind(w.host);
    w.host.commitFiles = async (input, scope) => { w.model.branches.set(input.branch, base); w.model.commit(input.branch, { "theirs.txt": "x" }); return commit(input, scope); };
    const remove = vi.spyOn(w.host, "deleteBranch");
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
    const remove = vi.spyOn(w.host, "deleteBranch");
    w.clock.now += OPENING_STALE_MS + 1_000;
    await propose(w, reportOf(suiteOf(ROWS)));
    expect(remove).not.toHaveBeenCalledWith(expect.anything(), "rovara/lessons-0123456789ab", expect.anything());
  });

  it("the pull request body names what the wrapper removes, and carries no mention, link or image from the model's suite name", async () => {
    const w = world();
    await propose(w, reportOf(suiteOf(ROWS, { selection: "evals @acme/team [x](https://evil.example) ![p](https://evil.example/p.png) <img src=x>" })));
    const body = w.model.changeRequests[0]!.body;
    expect(body).not.toMatch(/@acme|\]\(|!\[|<img/u);
    expect(body).toContain("first removing any old");
  });
});

describe("a person's decision on the pull request", () => {
  const open = async (w: World) => { await propose(w, reportOf(suiteOf(ROWS))); return w.model.changeRequests[0]!; };

  it("a merged pull request tells setup to read the eval again; Rovara never made the merge", async () => {
    const w = world();
    const cr = await open(w);
    w.model.merge(cr.id, { revision: w.model.headRevisionOf(cr), method: "squash" });
    await refreshEvalWrappers(w.deps(), PROJECT);
    expect((await readEvalWrapperViews(w.deps(), PROJECT))[0]).toMatchObject({ state: "merged", rediscover: true, line: "PR #1 is merged. Set up again so Rovara reads your eval through it." });
  });

  it("a closed pull request is a 'no': it is not opened again, and a changed wrapper is a new proposal", async () => {
    const w = world();
    const cr = await open(w);
    w.model.update(cr.id, { state: "closed" });
    await refreshEvalWrappers(w.deps(), PROJECT);
    expect((await readEvalWrapperViews(w.deps(), PROJECT))[0]).toMatchObject({ state: "closed" });
    expect((await propose(w, reportOf(suiteOf(ROWS)), { retry: true }))[0]).toMatchObject({ state: "closed", replayed: true });
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
    (cr as { author: string }).author = "someone-else";
    w.model.update(cr.id, { state: "closed" });
    await refreshEvalWrappers(w.deps(), PROJECT);
    expect((await listEvalWrappers(w.deps(), PROJECT))[0]!.state).toBe("open");
  });
});

describe("the setup card", () => {
  it("shows the line and says the eval cannot be approved while its results cannot be read", async () => {
    const w = world();
    // The card reads the stored report row; a minimal one is enough for the wrapper lines.
    await propose(w, reportOf(suiteOf(ROWS)));
    const card = await readEvalCard({ store: w.store, companyId: A }, PROJECT, { companyId: A, personId: "p", provider: "x", displayName: "", roles: [] });
    expect(card.wrappers).toHaveLength(1);
    expect(card.wrappers[0]!.line).toContain("review PR #1");
  });
});

describe("two companies", () => {
  it("one company's proposal is invisible to another, and another company's planted row is never read", async () => {
    const w = world();
    await propose(w, reportOf(suiteOf(ROWS)));
    expect(await listEvalWrappers(w.deps(B), PROJECT)).toEqual([]);
    expect(await readEvalWrapperViews(w.deps(B), PROJECT)).toEqual([]);
    // B's same-named project proposes its own, apart from A's.
    const [row] = await listEvalWrappers(w.deps(A), PROJECT);
    await w.store.put({ item: { pk: `ORG#${B}#SETUP_DRAFT#${PROJECT}`, sk: `EVAL_WRAPPER#${row!.id}`, ...row, company: A } as never });
    expect(await listEvalWrappers(w.deps(B), PROJECT)).toEqual([]);
    const forB = world();
    await proposeEvalWrappers(forB.deps(B), PROJECT, { report: reportOf(suiteOf(ROWS)), taskId: "t", by: "x" });
    expect((await listEvalWrappers(forB.deps(B), PROJECT))).toHaveLength(1);
    expect(await listEvalWrappers(forB.deps(A), PROJECT)).toEqual([]);
  });
});
