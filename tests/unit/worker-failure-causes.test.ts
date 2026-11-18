// TE-A6 Parts B and C (DEC 254zt), the worker's half: a failed check's failing tests are joined to the change that most likely broke them, written as `failure-causes.json`. Real files, a real git repository, and goldens that
// show a run with no failing test, or with no usable change, writes exactly what it always wrote.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EVIDENCE_RAW_ARTIFACT, FAILURE_ATTRIBUTION_LIMITS, FAILURE_CAUSES_ARTIFACT, FailureCausesFileSchema, EvidenceRawSchema, createCandidateManifest, type CheckEntry, type ProjectCommand,
} from "../../packages/contracts/src/index.js";
import { collectEvidenceRaw, saveEvidenceRaw } from "../../packages/worker/src/verification/evidence-raw.js";
import { commitsOfChanges, failureCausesAcrossRepositories, failureCausesOf } from "../../packages/worker/src/verification/failure-causes.js";
import { evidenceTests, parseJsonReport, parseJunit, parseTestReport } from "../../packages/worker/src/verification/test-report.js";

const run = promisify(execFile);
const DIGEST = "d".repeat(64);
const command = (args: string[]): ProjectCommand => ({ executable: "vitest", args, cwd: ".", timeoutSeconds: 60 });
const entry = (over: Partial<CheckEntry> = {}): CheckEntry => ({ id: "readiness:0", label: "vitest", source: "project", before: "passed", after: "failed", class: "regression", output: "", durationMs: 100, ...over });
const canary = ["sk", "live", "canary", "7"].join("-");

const vitestReport = (messages: string[], file = "/work/repo/tests/cart.test.ts") => JSON.stringify({ testResults: [{ name: file, status: "failed", assertionResults: [
  { fullName: "applies discount", status: "failed", duration: 3, failureMessages: messages },
  { fullName: "keeps total", status: "passed", duration: 1, failureMessages: [] },
] }] });

describe("the failure text a report gives", () => {
  it("is read for a failed or errored test only, from vitest/jest failureMessages and from a JUnit failure body, and is cut", () => {
    const json = parseJsonReport(vitestReport(["AssertionError: x\n    at f (/work/repo/src/cart.ts:12:5)"]))!;
    expect(json.tests.map((test) => [test.name, test.failureText === undefined])).toEqual([["applies discount", false], ["keeps total", true]]);
    expect(json.tests[0]!.failureText).toContain("src/cart.ts:12:5");
    const long = parseJsonReport(vitestReport(["y".repeat(FAILURE_ATTRIBUTION_LIMITS.textMax * 3)]))!;
    expect(long.tests[0]!.failureText!.length).toBeLessThanOrEqual(FAILURE_ATTRIBUTION_LIMITS.textMax);
    const junit = parseJunit('<testsuite><testcase classname="tests.t" name="a" file="tests/t.py"><failure message="m">File "/app/src/cart.py", line 4, in f&lt;x&gt;</failure></testcase><testcase classname="tests.t" name="b"/></testsuite>')!;
    expect(junit.tests[0]!.failureText).toContain('File "/app/src/cart.py", line 4, in f<x>');
    expect(junit.tests[1]).not.toHaveProperty("failureText");
  });

  it("reads only the failure element's own text, never the case's console output", () => {
    const xml = '<testsuite><testcase classname="tests.t" name="a" file="tests/t.py"><failure message="m">boom in src/cart.py</failure><system-out>noise src/other.py:3</system-out><system-err>err src/third.py:1</system-err></testcase>'
      + '<testcase classname="tests.t" name="b" file="tests/t.py"><failure message="only attribute src/x.py"/><system-out>src/other.py:3</system-out></testcase></testsuite>';
    const [first, second] = parseJunit(xml)!.tests;
    expect(first!.failureText).toBe("boom in src/cart.py");
    expect(second!.failureText).toBeUndefined();
    const errored = parseJunit('<testsuite><testcase name="e"><error>E1 src/err.py</error></testcase></testsuite>')!.tests[0]!;
    expect(errored.failureText).toBe("E1 src/err.py");
  });

  it("never reaches the evidence: the names the pack keeps are byte-identical with and without a text", () => {
    const withText = evidenceTests(parseJsonReport(vitestReport(["boom at /work/repo/src/cart.ts:1:1"]))!);
    const without = evidenceTests(parseJsonReport(vitestReport([]))!);
    expect(JSON.stringify(withText)).toBe(JSON.stringify(without));
    expect(JSON.stringify(withText)).not.toContain("boom");
  });
});

describe("failureCausesOf", () => {
  const changes = [{ path: "src/cart.ts", status: "MODIFIED" as const, hunks: [] }, { path: "src/other.ts", status: "MODIFIED" as const, hunks: [] }];
  const reportOf = (messages: string[]) => parseJsonReport(vitestReport(messages))!;

  it("names the changed file the failing test's own stack points at, with the commit when one is known", () => {
    const report = reportOf(["at f (/work/repo/src/cart.ts:12:5)"]);
    const sha = "a".repeat(40);
    expect(failureCausesOf({ report, names: evidenceTests(report).names, changes, commits: new Map([["src/cart.ts", sha]]) })).toEqual([
      { testId: "/work/repo/tests/cart.test.ts::applies discount", cause: { kind: "change", paths: ["src/cart.ts"], pathsCount: 1, commit: sha, basis: ["named_in_failure"] } },
    ]);
  });

  it("says unknown when the stack names no changed file, and gives nothing when no test failed", () => {
    const report = reportOf(["expected 1 to be 2"]);
    expect(failureCausesOf({ report, names: evidenceTests(report).names, changes })).toEqual([{ testId: "/work/repo/tests/cart.test.ts::applies discount", cause: { kind: "unknown", reason: "no_changed_file_named" } }]);
    const passed = parseJsonReport(JSON.stringify({ testResults: [{ name: "/w/a.test.ts", status: "passed", assertionResults: [{ fullName: "a", status: "passed" }] }] }))!;
    expect(failureCausesOf({ report: passed, names: evidenceTests(passed).names, changes })).toBeUndefined();
  });

  it("says unknown, with no failure details, for a report format that carries no failure text (go test)", () => {
    const go = [{ Action: "run", Package: "p", Test: "TestA" }, { Action: "fail", Package: "p", Test: "TestA", Elapsed: 0.1 }, { Action: "fail", Package: "p", Elapsed: 0.2 }].map((event) => JSON.stringify(event)).join("\n");
    const report = parseTestReport(go)!;
    expect(report.format).toBe("gotest");
    const result = failureCausesOf({ report, names: evidenceTests(report).names, changes });
    expect(result).toBeDefined();
    expect(result!.every((row) => row.cause.kind === "unknown" && row.cause.reason === "no_failure_details")).toBe(true);
  });

  it("gives nothing, never a partial answer, for more failing tests than the limit", () => {
    const many = JSON.stringify({ testResults: [{ name: "/w/a.test.ts", status: "failed", assertionResults: Array.from({ length: FAILURE_ATTRIBUTION_LIMITS.failuresMax + 1 }, (_, index) => ({ fullName: `t${String(index)}`, status: "failed", failureMessages: ["at x (/w/src/cart.ts:1:1)"] })) }] });
    const report = parseJsonReport(many)!;
    expect(failureCausesOf({ report, names: evidenceTests(report).names, changes })).toBeUndefined();
  });

  it("never carries a word of the failure text into the result", () => {
    const report = reportOf([`${canary} at f (/work/repo/src/cart.ts:12:5)`]);
    expect(JSON.stringify(failureCausesOf({ report, names: evidenceTests(report).names, changes }))).not.toContain(canary);
  });
});

it("joins multi-repository failures by the test path prefix when repositories share a changed basename", () => {
  const report = parseTestReport(JSON.stringify({ reportFormat: "CTRF", results: { tests: [
    { name: "api fails", filepath: "packages/api/tests/shared.test.ts", status: "failed", failureMessage: "at packages/api/src/api/shared.ts:8" },
    { name: "web fails", filepath: "packages/web/tests/shared.test.ts", status: "failed", failureMessage: "at packages/web/src/web/shared.ts:9" },
    { name: "rooted fails", filepath: "/work/packages/api/tests/rooted.test.ts", status: "failed", failureMessage: "at /work/packages/api/src/api/shared.ts:10" },
  ] } }))!;
  const result = failureCausesAcrossRepositories({
    report,
    names: evidenceTests(report).names,
    workspaceRoot: "/work",
    checkDirectory: "/work",
    repositories: [
      { directory: "/work/packages/api", changes: [{ path: "src/api/shared.ts", status: "MODIFIED", hunks: [] }] },
      { directory: "/work/packages/web", changes: [{ path: "src/web/shared.ts", status: "MODIFIED", hunks: [] }] },
    ],
  });
  expect(result).toEqual([
    { testId: "packages/api/tests/shared.test.ts::api fails", cause: { kind: "change", paths: ["src/api/shared.ts"], pathsCount: 1, basis: ["named_in_failure"] } },
    { testId: "packages/web/tests/shared.test.ts::web fails", cause: { kind: "change", paths: ["src/web/shared.ts"], pathsCount: 1, basis: ["named_in_failure"] } },
    { testId: "/work/packages/api/tests/rooted.test.ts::rooted fails", cause: { kind: "change", paths: ["src/api/shared.ts"], pathsCount: 1, basis: ["named_in_failure"] } },
  ]);
});

it("routes prefix collisions, absolute paths, nested repositories, and check-relative files by resolved containment", () => {
  const make = (filepath: string, message: string) => {
    const report = parseTestReport(JSON.stringify({ reportFormat: "CTRF", results: { tests: [{ name: "fails", filepath, status: "failed", failureMessage: message }] } }))!;
    return { report, names: evidenceTests(report).names };
  };
  const repo = (directory: string, path: string) => ({ directory, changes: [{ path, status: "MODIFIED" as const, hunks: [] }] });

  const collision = make("api-gateway/tests/x.test.ts", "at api-gateway/src/gateway.ts:1");
  expect(failureCausesAcrossRepositories({ report: collision.report, names: collision.names, workspaceRoot: "/work", checkDirectory: "/work", repositories: [repo("/work/api", "src/api.ts"), repo("/work/api-gateway", "src/gateway.ts")] })?.[0]?.cause).toMatchObject({ kind: "change", paths: ["src/gateway.ts"] });

  const prefixOnly = make("api-gateway/tests/x.test.ts", "at src/api.ts:1");
  expect(failureCausesAcrossRepositories({ report: prefixOnly.report, names: prefixOnly.names, workspaceRoot: "/work", checkDirectory: "/work", repositories: [repo("/work/api", "src/api.ts")] })).toEqual([
    { testId: "api-gateway/tests/x.test.ts::fails", cause: { kind: "unknown", reason: "no_changed_file_named" } },
  ]);

  const absolute = make("/work/api/tests/x.test.ts", "at /work/api/src/api.ts:1");
  expect(failureCausesAcrossRepositories({ report: absolute.report, names: absolute.names, workspaceRoot: "/work", checkDirectory: "/work", repositories: [repo("/work/api", "src/api.ts"), repo("/work/web", "src/web.ts")] })?.[0]?.cause).toMatchObject({ kind: "change", paths: ["src/api.ts"] });

  const nested = make("packages/web/tests/x.test.ts", "at packages/web/src/web.ts:1");
  expect(failureCausesAcrossRepositories({ report: nested.report, names: nested.names, workspaceRoot: "/work", checkDirectory: "/work/api", repositories: [repo("/work/api", "src/api.ts"), repo("/work/api/packages/web", "src/web.ts")] })?.[0]?.cause).toMatchObject({ kind: "change", paths: ["src/web.ts"] });

  const checkRelative = make("web/x.test.ts", "at web/src/x.ts:1");
  expect(failureCausesAcrossRepositories({ report: checkRelative.report, names: checkRelative.names, workspaceRoot: "/work", checkDirectory: "/work/api", repositories: [repo("/work/api", "web/src/x.ts"), repo("/work/web", "src/x.ts")] })?.[0]?.cause).toMatchObject({ kind: "change", paths: ["web/src/x.ts"] });

  const escaped = make("../web/tests/x.test.ts", "at ../web/src/x.ts:1");
  expect(failureCausesAcrossRepositories({ report: escaped.report, names: escaped.names, workspaceRoot: "/work", checkDirectory: "/work/api", repositories: [repo("/work/api", "src/api.ts")] })?.[0]?.cause).toEqual({ kind: "unknown", reason: "no_changed_file_named" });

  const escapedWithCheckRepoChange = make("../web/tests/x.test.ts", "at src/api.ts:1");
  expect(failureCausesAcrossRepositories({ report: escapedWithCheckRepoChange.report, names: escapedWithCheckRepoChange.names, workspaceRoot: "/work", checkDirectory: "/work/api", repositories: [repo("/work/api", "src/api.ts")] })).toEqual([
    { testId: "../web/tests/x.test.ts::fails", cause: { kind: "unknown", reason: "no_changed_file_named" } },
  ]);
});

describe("a real repository", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "failure-causes-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const git = async (...args: string[]) => (await run("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: root })).stdout.trim();
  const write = async (path: string, text: string) => { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), text); };
  async function repository() {
    await git("init", "-q");
    await write("src/cart.ts", "export const a = 1;\n"); await write("src/other.ts", "export const b = 1;\n"); await write("tests/cart.test.ts", "// t\n");
    await git("add", "-A"); await git("commit", "-q", "-m", "base");
    const start = await git("rev-parse", "HEAD");
    await write("src/cart.ts", "export const a = 2;\n"); await git("add", "-A"); await git("commit", "-q", "-m", "one");
    const one = await git("rev-parse", "HEAD");
    await write("src/other.ts", "export const b = 2;\n"); await git("add", "-A"); await git("commit", "-q", "-m", "two");
    await write("src/cart.ts", "export const a = 3;\n"); await git("add", "-A"); await git("commit", "-q", "-m", "three");
    const head = await git("rev-parse", "HEAD");
    return { start, one, head, tree: await git("rev-parse", "HEAD^{tree}") };
  }

  it("names the one commit that changed a file, and none for a file two commits changed", async () => {
    const box = await repository();
    const found = await commitsOfChanges({ directory: root, startCommit: box.start, candidateTreeSha: box.tree }, new Set(["src/cart.ts", "src/other.ts"]));
    expect(found.get("src/other.ts")).toMatch(/^[a-f0-9]{40}$/u);
    expect(found.has("src/cart.ts")).toBe(false);
  });

  it("names no commit when the task's range holds more commits than it reads", async () => {
    const box = await repository();
    for (let count = 0; count < 200; count += 1) await git("commit", "-q", "--allow-empty", "-m", `filler ${String(count)}`);
    await write("src/other.ts", "export const b = 7;\n"); await git("add", "-A"); await git("commit", "-q", "-m", "last");
    const tree = await git("rev-parse", "HEAD^{tree}");
    expect((await commitsOfChanges({ directory: root, startCommit: box.start, candidateTreeSha: tree }, new Set(["src/other.ts", "src/cart.ts"]))).size).toBe(0);
  }, 60_000);

  it("names no commit for a start commit that is not a commit id, and never runs a hook the candidate carries", async () => {
    const box = await repository();
    const marker = join(root, "hook-ran");
    await mkdir(join(root, ".git/hooks"), { recursive: true });
    await writeFile(join(root, ".git/hooks/post-checkout"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    await writeFile(join(root, ".git/config"), "[core]\n\thooksPath = .git/hooks\n[alias]\n\tlog = !touch " + marker + "\n", { flag: "a" });
    expect((await commitsOfChanges({ directory: root, startCommit: "--output=/tmp/x", candidateTreeSha: box.tree }, new Set(["src/other.ts"]))).size).toBe(0);
    expect((await commitsOfChanges({ directory: root, startCommit: box.start, candidateTreeSha: box.tree }, new Set(["src/other.ts"]))).get("src/other.ts")).toMatch(/^[a-f0-9]{40}$/u);
    await expect(import("node:fs/promises").then((fs) => fs.stat(marker))).rejects.toThrow();
  });

  it("names no commit when the checked tree is not the head commit's (changes not committed yet)", async () => {
    const box = await repository();
    await write("src/other.ts", "export const b = 99;\n"); await git("add", "-A");
    const dirty = await git("write-tree");
    expect(dirty).not.toBe(box.tree);
    expect((await commitsOfChanges({ directory: root, startCommit: box.start, candidateTreeSha: dirty }, new Set(["src/other.ts"]))).size).toBe(0);
  });

  it("collectEvidenceRaw reports each failing test's cause, and the raw file is byte-identical with or without asking", async () => {
    const box = await repository();
    await write("report.json", vitestReport(["at f (/work/repo/src/other.ts:12:5)"], join(root, "tests/cart.test.ts")));
    const repositories = [{ repositoryId: "api", directory: root, startCommit: box.start, candidateTreeSha: box.tree }];
    const base = { rootPath: root, commands: [command(["run", "--reporter=json", "--outputFile=report.json"])], entries: [entry()], candidateDigest: DIGEST, repositories };
    const seen: Array<[string, unknown]> = [];
    const asked = await collectEvidenceRaw({ ...base, onFailureCauses: (checkId, causes) => seen.push([checkId, causes]) });
    const plain = await collectEvidenceRaw(base);
    expect(JSON.stringify(asked)).toBe(JSON.stringify(plain));
    expect(EvidenceRawSchema.safeParse(asked).success).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBe("readiness:0");
    expect(seen[0]![1]).toMatchObject([{ testId: "tests/cart.test.ts::applies discount", cause: { kind: "change", paths: ["src/other.ts"], basis: ["named_in_failure"] } }]);
    // The checked tree IS the head commit's and exactly one commit changed that file, so its commit is named.
    expect(JSON.stringify(seen[0]![1])).toMatch(/"commit":"[a-f0-9]{40}"/u);
  });

  it("collectEvidenceRaw joins multi-repository failures and leaves raw evidence byte-identical", async () => {
    const workspace = root;
    const api = join(workspace, "api");
    const web = join(workspace, "web");
    const setupRepo = async (directory: string, file: string, baseText: string, changedText: string) => {
      await mkdir(join(directory, file, ".."), { recursive: true });
      const gitAt = async (...args: string[]) => (await run("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: directory })).stdout.trim();
      await gitAt("init", "-q");
      await writeFile(join(directory, file), baseText);
      await gitAt("add", "-A"); await gitAt("commit", "-q", "-m", "base");
      const start = await gitAt("rev-parse", "HEAD");
      await writeFile(join(directory, file), changedText);
      await gitAt("add", "-A"); await gitAt("commit", "-q", "-m", "change");
      return { startCommit: start, candidateTreeSha: await gitAt("rev-parse", "HEAD^{tree}") };
    };
    const apiGit = await setupRepo(api, "src/api.ts", "api0", "api1");
    const webGit = await setupRepo(web, "src/web.ts", "web0", "web1");
    await writeFile(join(api, "report.json"), JSON.stringify({ testResults: [{ name: "tests/x.test.ts", status: "failed", assertionResults: [{ fullName: "fails", status: "failed", failureMessages: ["at src/api.ts:1"] }] }] }));
    const repositories = [
      { repositoryId: "api", directory: api, ...apiGit },
      { repositoryId: "web", directory: web, ...webGit },
    ];
    const apiCommand = { ...command(["run", "--reporter=json", "--outputFile=report.json"]), cwd: "api" };
    const base = { rootPath: workspace, commands: [apiCommand], entries: [entry()], candidateDigest: DIGEST, repositories };
    const causes: unknown[] = [];
    const asked = await collectEvidenceRaw({ ...base, onFailureCauses: (_id, result) => causes.push(result) });
    const plain = await collectEvidenceRaw(base);
    expect(JSON.stringify(asked)).toBe(JSON.stringify(plain));
    expect(causes).toMatchObject([[{ cause: { kind: "change", paths: ["src/api.ts"] } }]]);
  });

  it("keeps raw evidence byte-identical when a failed report has no per-test attribution data", async () => {
    const box = await repository();
    await write("report.json", JSON.stringify({ testResults: [{ name: "tests/cart.test.ts", status: "failed", assertionResults: [{ fullName: "fails", status: "failed" }] }] }));
    const base = { rootPath: root, commands: [command(["run", "--reporter=json", "--outputFile=report.json"])], entries: [entry()], candidateDigest: DIGEST, repositories: [{ repositoryId: "api", directory: root, startCommit: box.start, candidateTreeSha: box.tree }] };
    const withAttribution = await collectEvidenceRaw({ ...base, onFailureCauses: () => { throw new Error("no per-test failure text should be attributed"); } });
    const withoutAttribution = await collectEvidenceRaw(base);
    expect(JSON.stringify(withAttribution)).toBe(JSON.stringify(withoutAttribution));
  });

  it("saveEvidenceRaw writes only evidence-raw.json for a failed check with more failing tests than the limit", async () => {
    const box = await repository();
    const many = JSON.stringify({ testResults: [{ name: join(root, "tests/cart.test.ts"), status: "failed", assertionResults: Array.from({ length: FAILURE_ATTRIBUTION_LIMITS.failuresMax + 1 }, (_, index) => ({ fullName: `t${String(index)}`, status: "failed", failureMessages: ["at x (/w/src/other.ts:1:1)"] })) }] });
    await write("report.json", many);
    const saved: string[] = [];
    const sink = async (artifact: { name: string }) => { saved.push(artifact.name); };
    const plan = { source: "project" as const, readiness: [command(["run", "--reporter=json", "--outputFile=report.json"])] };
    const candidate = [{ repositoryId: "api", commitSha: box.head, treeSha: box.tree, baseCommitSha: box.start }];
    expect(await saveEvidenceRaw({ sink, rootPath: root, plan, entries: [entry()], repositories: [{ repositoryId: "api", directory: root, baseCommitSha: box.start }], candidateBefore: candidate })).toBe(true);
    expect(saved).toEqual([EVIDENCE_RAW_ARTIFACT]);
  });

  it("asks for nothing for a passing check or when there are no change repositories", async () => {
    const box = await repository();
    await write("report.json", vitestReport(["at f (/work/repo/src/other.ts:12:5)"]));
    const calls: string[] = [];
    const onFailureCauses = (checkId: string) => calls.push(checkId);
    const one = { repositoryId: "api", directory: root, startCommit: box.start, candidateTreeSha: box.tree };
    const commands = [command(["run", "--reporter=json", "--outputFile=report.json"])];
    await collectEvidenceRaw({ rootPath: root, commands, entries: [entry({ after: "passed", class: "passing" })], candidateDigest: DIGEST, repositories: [one], onFailureCauses });
    await collectEvidenceRaw({ rootPath: root, commands, entries: [entry()], candidateDigest: DIGEST, repositories: [], onFailureCauses });
    expect(calls).toEqual([]);
  });

  it("saveEvidenceRaw writes failure-causes.json beside evidence-raw.json, bound to the candidate, and nothing extra when no cause was found", async () => {
    const box = await repository();
    await write("report.json", vitestReport([`${canary} at f (/work/repo/src/other.ts:12:5)`], join(root, "tests/cart.test.ts")));
    const saved: Array<{ name: string; content: string }> = [];
    const sink = async (artifact: { name: string; content: string | Uint8Array }) => { saved.push({ name: artifact.name, content: String(artifact.content) }); };
    const candidate = [{ repositoryId: "api", commitSha: box.head, treeSha: box.tree, baseCommitSha: box.start }];
    const plan = { source: "project" as const, readiness: [command(["run", "--reporter=json", "--outputFile=report.json"])] };
    expect(await saveEvidenceRaw({ sink, rootPath: root, plan, entries: [entry()], repositories: [{ repositoryId: "api", directory: root, baseCommitSha: box.start }], candidateBefore: candidate })).toBe(true);
    expect(saved.map((item) => item.name)).toEqual([EVIDENCE_RAW_ARTIFACT, FAILURE_CAUSES_ARTIFACT]);
    const file = FailureCausesFileSchema.parse(JSON.parse(saved[1]!.content));
    expect(file.candidateDigest).toBe(createCandidateManifest(candidate).digest);
    expect(file.checks[0]).toMatchObject({ checkId: "readiness:0", causes: [{ cause: { kind: "change", paths: ["src/other.ts"] } }] });
    for (const item of saved) expect(item.content).not.toContain(canary);

    saved.length = 0;
    await write("report.json", vitestReport(["x"], "/work/repo/tests/cart.test.ts").replace("failed", "passed").replace(/"failed"/g, '"passed"'));
    await saveEvidenceRaw({ sink, rootPath: root, plan, entries: [entry({ after: "passed", class: "passing" })], repositories: [{ repositoryId: "api", directory: root, baseCommitSha: box.start }], candidateBefore: candidate });
    expect(saved.map((item) => item.name)).toEqual([EVIDENCE_RAW_ARTIFACT]);
  });
});
