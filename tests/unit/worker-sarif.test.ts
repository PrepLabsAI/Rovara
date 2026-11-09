// Proof and evidence P4, findings: the SARIF a project's own scanner writes is read (the command is never changed) and compared with the same scan on the code the task started from, so the evidence says how
// many findings are NEW. No baseline, no finding is reported. A finding's text is data: redacted, one plain line, and quoted text removed for rules about secrets.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvidenceRawSchema, type CheckEntry, type ProjectCommand } from "../../packages/contracts/src/index.js";
import { collectEvidenceRaw, saveEvidenceRaw } from "../../packages/worker/src/verification/evidence-raw.js";
import { SARIF_MAX_RESULTS, SARIF_REPORT_MAX_BYTES, findingsPart, newFindings, parseSarif, plainMessage, readsPrebuiltState, repositoryPathOf, sameFindings, sarifPathOf } from "../../packages/worker/src/verification/sarif.js";
import { BASELINE_CAP_MS, MIN_BASELINE_BUDGET_MS, runBaselineScans, type BaselineScan } from "../../packages/worker/src/verification/sarif-baseline.js";
import { AgentFilesRestoreError, type OriginalCode } from "../../packages/worker/src/verification/original-code.js";
import type { CheckRunners } from "../../packages/worker/src/verification/checks.js";

const execGit = promisify(execFile);
const DIGEST = "d".repeat(64);
const command = (executable: string, args: string[], cwd = "."): ProjectCommand => ({ executable, args, cwd, timeoutSeconds: 60 });
const entry = (index: number, over: Partial<CheckEntry> = {}): CheckEntry => ({ id: `readiness:${String(index)}`, label: "scan", source: "project", before: "passed", after: "failed", class: "regression", output: "", durationMs: 100, exitCode: 1, ...over });

interface FakeResult { ruleId: string; level?: string; message?: string; uri?: string; line?: number; fingerprint?: string; score?: number }
const sarif = (results: FakeResult[], tool = "Bandit") => JSON.stringify({
  version: "2.1.0",
  runs: [{
    tool: { driver: { name: tool, rules: [{ id: "B105", defaultConfiguration: { level: "note" } }, { id: "B608", properties: { "security-severity": "8.1" } }] } },
    results: results.map((result) => ({
      ruleId: result.ruleId, ...(result.level === undefined ? {} : { level: result.level }),
      message: { text: result.message ?? "a finding" },
      locations: [{ physicalLocation: { artifactLocation: { uri: result.uri ?? "src/app.py" }, region: { startLine: result.line ?? 1 } } }],
      ...(result.fingerprint === undefined ? {} : { partialFingerprints: { primaryLocationLineHash: result.fingerprint } }),
      ...(result.score === undefined ? {} : { properties: { "security-severity": String(result.score) } }),
    })),
  }],
});

let root: string;
/** A repository under the workspace with a base commit, a changed app.py and a candidate SARIF in the workspace root. */
async function world() {
  const directory = join(root, "api");
  const git = async (...args: string[]) => (await execGit("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: directory })).stdout.trim();
  await mkdir(directory, { recursive: true });
  await git("init", "-q");
  await writeFile(join(directory, "app.py"), "1\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "base");
  const base = await git("rev-parse", "HEAD");
  await writeFile(join(directory, "app.py"), "2\n");
  await git("add", "-A");
  const tree = await git("write-tree");
  await writeFile(join(root, "bandit.sarif"), sarif([{ ruleId: "B608", message: "new one", uri: "src/db.py", line: 7 }, { ruleId: "B105", level: "note", message: "old", uri: "src/a.py", line: 3 }]));
  return { directory, base, tree };
}

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "sarif-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("which file a command's scanner writes", () => {
  const path = (executable: string, ...args: string[]) => sarifPathOf(command(executable, args));
  it("reads a .sarif path, alone or as an option's value, and the output file of a command that asks for the SARIF format", () => {
    expect(path("bandit", "-r", ".", "-f", "sarif", "-o", "out/bandit.sarif")).toBe("out/bandit.sarif");
    expect(path("semgrep", "--sarif", "--output=semgrep.json")).toBe("semgrep.json");
    expect(path("semgrep", "scan", "--sarif-output", "s.sarif.json")).toBe("s.sarif.json");
    expect(path("codeql", "database", "analyze", "--format=sarif-latest", "--output=r.sarif")).toBe("r.sarif");
    expect(path("eslint", ".", "-f", "@microsoft/eslint-formatter-sarif", "-o", "eslint.sarif")).toBe("eslint.sarif");
    expect(path("scan", "results.sarif")).toBe("results.sarif");
  });
  it("names nothing for a command that does not ask for SARIF or names no file; the command is not altered", () => {
    const original = command("bandit", ["-r", ".", "-o", "out.txt"]);
    expect(sarifPathOf(original)).toBeUndefined();
    expect(original.args).toEqual(["-r", ".", "-o", "out.txt"]);
    expect(path("bandit", "-f", "sarif")).toBeUndefined();
    expect(path("pytest", "-q")).toBeUndefined();
  });
});

describe("reading SARIF", () => {
  it("reads results with their rule, severity, file, line and message", () => {
    const parsed = parseSarif(sarif([{ ruleId: "B608", message: "SQL built from user input", uri: "src/db.py", line: 12 }, { ruleId: "B105", level: "error", uri: "src/a.py", line: 3 }, { ruleId: "X1", level: "warning" }, { ruleId: "X2", level: "none" }, { ruleId: "X3", score: 9.8 }, { ruleId: "X4", score: 0 }]))!;
    expect(parsed.tool).toBe("Bandit");
    expect(parsed.findings.map((finding) => [finding.ruleId, finding.severity, finding.path, finding.line])).toEqual([
      ["B608", "high", "src/db.py", 12],            // the rule's security-severity 8.1
      ["B105", "high", "src/a.py", 3],              // an explicit error level
      ["X1", "medium", "src/app.py", 1],
      ["X2", "info", "src/app.py", 1],
      ["X3", "critical", "src/app.py", 1],          // the result's own score wins
      ["X4", "info", "src/app.py", 1],
    ]);
    // The score's boundaries: 9 and 7 and 4 start their bands, anything above 0 is at least low.
    expect(parseSarif(sarif([{ ruleId: "S", score: 9 }, { ruleId: "S", score: 8.9 }, { ruleId: "S", score: 7 }, { ruleId: "S", score: 6.9 }, { ruleId: "S", score: 4 }, { ruleId: "S", score: 3.9 }, { ruleId: "S", score: 0.1 }]))!.findings.map((finding) => finding.severity)).toEqual(["critical", "high", "high", "medium", "medium", "low", "low"]);
    // A rule with no level anywhere is a warning (SARIF's default); the rule's default level counts when the result has none.
    expect(parseSarif(sarif([{ ruleId: "B105" }]))!.findings[0]?.severity).toBe("low");
  });

  it("refuses text that is not SARIF, malformed JSON, and a file with more results than its limit", () => {
    expect(parseSarif("{ nope")).toBeUndefined();
    expect(parseSarif(JSON.stringify({ hello: 1 }))).toBeUndefined();
    expect(parseSarif(JSON.stringify({ runs: "x" }))).toBeUndefined();
    expect(parseSarif(JSON.stringify({ runs: [] }))?.findings).toEqual([]);
    const three = sarif([{ ruleId: "A" }, { ruleId: "B" }, { ruleId: "C" }]);
    expect(parseSarif(three, [], 3)?.findings).toHaveLength(3);
    expect(parseSarif(three, [], 2)).toBeUndefined();
    expect(SARIF_MAX_RESULTS).toBe(100_000);
  });

  it("makes a tool's address a repository-relative path: a file:// address, a percent-encoded name, a Windows path and an absolute path under a root", () => {
    expect(repositoryPathOf("file:///w/api/src/a.py", ["/w/api"])).toBe("src/a.py");
    expect(repositoryPathOf("src/my%20file.py", [])).toBe("src/my file.py");
    expect(repositoryPathOf("src\\win\\a.py", [])).toBe("src/win/a.py");
    expect(repositoryPathOf("./src/a.py", [])).toBe("src/a.py");
    expect(repositoryPathOf("/elsewhere/a.py", ["/w/api"])).toBe("elsewhere/a.py");
    expect(repositoryPathOf("file:///C:/proj/a.py", [])).toBe("C:/proj/a.py");
  });

  it("makes a message one plain redacted line, and removes quoted text for a rule about secrets (it may be the secret)", () => {
    expect(plainMessage("line one\nline\u202etwo \u0007 bell")).toBe("line one line two bell");
    expect(plainMessage("Possible hardcoded password: 'hunter2-is-not-key-shaped'", "B105")).toMatch(/^Possible hardcoded password: '(?:…|\[REDACTED\])'$/u);
    expect(plainMessage('The token "abc def ghi" is used', "")).toMatch(/^The token "(?:…|\[REDACTED\])" is used$/u);
    expect(plainMessage("Use of eval('x') detected", "B307")).toBe("Use of eval('x') detected");
    const secret = `ghp_${"Ab1Cd2Ef3Gh4".repeat(3)}`;
    expect(plainMessage(`uses ${secret} directly`)).not.toContain(secret);
    expect(Array.from(plainMessage("x".repeat(1000))).length).toBe(200);
    const parsed = parseSarif(sarif([{ ruleId: "B105", message: "Possible hardcoded password: 'S3cr3t!'" }]))!;
    expect(JSON.stringify(parsed)).not.toContain("S3cr3t");
  });
});

describe("what is new", () => {
  const make = (results: FakeResult[]) => parseSarif(sarif(results))!.findings;
  it("is what the candidate has beyond the baseline's count of the same finding; code that only moved is not new", () => {
    const baseline = make([{ ruleId: "B608", uri: "a.py", line: 10, message: "sql" }, { ruleId: "B105", uri: "a.py", line: 20, message: "pw" }]);
    const candidate = make([{ ruleId: "B608", uri: "a.py", line: 40, message: "sql" }, { ruleId: "B105", uri: "a.py", line: 41, message: "pw" }, { ruleId: "B105", uri: "b.py", line: 1, message: "pw" }, { ruleId: "B999", uri: "a.py", line: 2, message: "new rule" }]);
    expect(newFindings(candidate, baseline).map((finding) => `${finding.ruleId}@${finding.path}`)).toEqual(["B105@b.py", "B999@a.py"]);
    // The same finding twice now and once before: one is new.
    expect(newFindings(make([{ ruleId: "R", line: 1 }, { ruleId: "R", line: 9 }]), make([{ ruleId: "R", line: 5 }]))).toHaveLength(1);
    // Fewer now than before: nothing is new.
    expect(newFindings(make([{ ruleId: "R" }]), make([{ ruleId: "R" }, { ruleId: "R" }]))).toEqual([]);
    expect(newFindings(make([{ ruleId: "R" }]), [])).toHaveLength(1);
  });
  it("tells findings apart by the tool's own fingerprint when it gives one, and by message when it does not", () => {
    expect(newFindings(make([{ ruleId: "R", fingerprint: "f2", message: "same" }]), make([{ ruleId: "R", fingerprint: "f1", message: "same" }]))).toHaveLength(1);
    expect(newFindings(make([{ ruleId: "R", fingerprint: "f1", message: "changed words" }]), make([{ ruleId: "R", fingerprint: "f1", message: "same" }]))).toEqual([]);
    expect(newFindings(make([{ ruleId: "R", message: "other" }]), make([{ ruleId: "R", message: "same" }]))).toHaveLength(1);
  });
  it("counts every new finding by severity and lists the 100 most severe", () => {
    const many = Array.from({ length: 130 }, (_, index) => ({ ruleId: `R${String(index)}`, level: index < 5 ? "error" : "note", uri: `f${String(index)}.py`, line: index + 1 }));
    const part = findingsPart("Bandit", newFindings(make(many), []));
    expect(part.newCount).toBe(130);
    expect(part.bySeverity).toEqual({ critical: 0, high: 5, medium: 0, low: 125, info: 0 });
    expect(part.items).toHaveLength(100);
    expect(part.items.slice(0, 5).every((item) => item.severity === "high")).toBe(true);
    expect(EvidenceRawSchema.safeParse({ schemaVersion: 1, candidateDigest: DIGEST, checks: [{ checkId: "readiness:0", findings: part }] }).success).toBe(true);
  });
});

describe("the evidence a CHECKS run saves for a scanner", () => {
  const scanner = command("bandit", ["-r", ".", "-f", "sarif", "-o", "bandit.sarif"]);
  const input = (over: Record<string, unknown> = {}) => ({ rootPath: root, commands: [scanner], entries: [entry(0)], candidateDigest: DIGEST, repositories: [], roundStartedAtMs: Date.now() - 5_000, ...over });
  const baseline = (text: string | undefined) => async () => new Map<number, string>(text === undefined ? [] : [[0, text]]);

  it("reports the findings the candidate has and the baseline did not, with the tool, severities and a plain message; the command is untouched", async () => {
    await writeFile(join(root, "bandit.sarif"), sarif([{ ruleId: "B608", message: "SQL built from input", uri: "src/db.py", line: 7 }, { ruleId: "B105", level: "note", uri: "src/a.py", line: 3, message: "old" }]));
    const raw = await collectEvidenceRaw(input({ baselineScans: baseline(sarif([{ ruleId: "B105", level: "note", uri: "src/a.py", line: 30, message: "old" }])) }));
    expect(raw?.checks[0]?.findings).toMatchObject({ tool: "Bandit", newCount: 1, bySeverity: { high: 1, critical: 0 }, items: [{ ruleId: "B608", severity: "high", path: "src/db.py", line: 7, message: "SQL built from input" }] });
    expect(scanner.args).toEqual(["-r", ".", "-f", "sarif", "-o", "bandit.sarif"]);
    expect(EvidenceRawSchema.safeParse(raw).success).toBe(true);
  });

  it("does not run a baseline for a scan that found nothing: nothing is new, and the answer is certain", async () => {
    await writeFile(join(root, "bandit.sarif"), sarif([]));
    let asked = 0;
    const raw = await collectEvidenceRaw(input({ entries: [entry(0, { after: "passed", class: "passing", exitCode: 0 })], baselineScans: async (scans: readonly BaselineScan[]) => { asked += scans.length; return new Map<number, string>(); } }));
    expect(asked).toBe(0);
    expect(raw?.checks[0]?.findings).toMatchObject({ tool: "Bandit", newCount: 0, items: [] });
    // With a finding the baseline is asked for, and only for that scan.
    await writeFile(join(root, "bandit.sarif"), sarif([{ ruleId: "B608" }]));
    await collectEvidenceRaw(input({ baselineScans: async (scans: readonly BaselineScan[]) => { asked += scans.length; return new Map<number, string>(); } }));
    expect(asked).toBe(1);
  });

  it("calls nothing new without a baseline, but counts the high findings as not compared (never a clean scan, never silent): no baseline function, one that did not run, one that is not SARIF", async () => {
    await writeFile(join(root, "bandit.sarif"), sarif([{ ruleId: "B608" }, { ruleId: "B105", level: "note" }]));
    const unverified = { tool: "Bandit", newCount: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, items: [], unverified: 1 };
    expect((await collectEvidenceRaw(input()))?.checks[0]?.findings).toEqual(unverified);
    expect((await collectEvidenceRaw(input({ baselineScans: baseline(undefined) })))?.checks[0]?.findings).toEqual(unverified);
    expect((await collectEvidenceRaw(input({ baselineScans: baseline("not sarif") })))?.checks[0]?.findings).toEqual(unverified);
    expect((await collectEvidenceRaw(input({ baselineScans: async () => { throw new Error("boom"); } })))?.checks[0]?.findings).toEqual(unverified);
    // Nothing high in the scan: nothing is hidden, so nothing is said.
    await writeFile(join(root, "bandit.sarif"), sarif([{ ruleId: "B105", level: "note" }]));
    expect(await collectEvidenceRaw(input())).toBeUndefined();
  });

  it("does not compare a scan that reads state an earlier step built (CodeQL's database, SpotBugs' classes): no baseline is run for it, and its high findings are not compared", async () => {
    await writeFile(join(root, "out.sarif"), sarif([{ ruleId: "B608" }], "CodeQL"));
    let asked = 0;
    const codeql = command("codeql", ["database", "analyze", "db", "--format=sarif-latest", "--output=out.sarif"]);
    const raw = await collectEvidenceRaw(input({ commands: [codeql], baselineScans: async (scans: readonly BaselineScan[]) => { asked += scans.length; return new Map<number, string>([[0, sarif([], "CodeQL")]]); } }));
    expect(asked).toBe(0);
    expect(raw?.checks[0]?.findings).toMatchObject({ tool: "CodeQL", newCount: 0, unverified: 1 });
    expect(readsPrebuiltState(codeql)).toBe(true);
    expect(readsPrebuiltState(command("spotbugs", ["-sarif", "-output", "o.sarif", "classes"]))).toBe(true);
    expect(readsPrebuiltState(command("bandit", ["-f", "sarif", "-o", "o.sarif"]))).toBe(false);
  });

  it("does not trust a baseline that equals the candidate's scan, line for line, in files the change touched; it does when the change touched none of them", async () => {
    const box = await world();
    const same = sarif([{ ruleId: "B608", message: "same", uri: "app.py", line: 7 }]);
    await writeFile(join(root, "bandit.sarif"), same);
    const repositories = [{ repositoryId: "api", directory: box.directory, startCommit: box.base, candidateTreeSha: box.tree }];
    // app.py changed in this task, and the scan reports on it: the same result on the "original" code is the candidate's own.
    const touched = await collectEvidenceRaw(input({ repositories, baselineScans: baseline(same) }));
    expect(touched?.checks[0]?.findings).toMatchObject({ newCount: 0, unverified: 1 });
    // Unrelated file: a genuine comparison, nothing new.
    const other = sarif([{ ruleId: "B608", message: "same", uri: "other.py", line: 7 }]);
    await writeFile(join(root, "bandit.sarif"), other);
    expect((await collectEvidenceRaw(input({ repositories, baselineScans: baseline(other) })))?.checks[0]?.findings).toMatchObject({ newCount: 0 });
    expect((await collectEvidenceRaw(input({ repositories, baselineScans: baseline(other) })))?.checks[0]?.findings).not.toHaveProperty("unverified");
    // The diff cannot be read: it cannot be told, so the identical result is not trusted.
    await writeFile(join(root, "bandit.sarif"), other);
    expect((await collectEvidenceRaw(input({ repositories: [], baselineScans: baseline(other) })))?.checks[0]?.findings).toMatchObject({ unverified: 1 });
    expect(sameFindings(parseSarif(same)!.findings, parseSarif(same)!.findings)).toBe(true);
    expect(sameFindings(parseSarif(same)!.findings, parseSarif(other)!.findings)).toBe(false);
  });

  it("asks the baseline only for scans whose own file was read in this round: a stale, missing, unsafe or oversized file, or a check that did not end, is not asked for", async () => {
    let asked = 0;
    const counting = async (scans: readonly BaselineScan[]) => { asked += scans.length; return new Map<number, string>(); };
    expect(await collectEvidenceRaw(input({ baselineScans: counting }))).toBeUndefined();
    await writeFile(join(root, "bandit.sarif"), sarif([{ ruleId: "B608" }]));
    await collectEvidenceRaw(input({ entries: [entry(0, { after: "timed_out" })], baselineScans: counting }));
    await collectEvidenceRaw(input({ roundStartedAtMs: undefined, baselineScans: counting }));
    const old = new Date(Date.now() - 3_600_000);
    await utimes(join(root, "bandit.sarif"), old, old);
    await collectEvidenceRaw(input({ baselineScans: counting }));
    expect(asked).toBe(0);
    const outside = await mkdtemp(join(tmpdir(), "outside-"));
    try {
      await writeFile(join(outside, "x.sarif"), sarif([{ ruleId: "B608" }]));
      await symlink(join(outside, "x.sarif"), join(root, "link.sarif"));
      await collectEvidenceRaw(input({ commands: [command("bandit", ["-o", "link.sarif"])], baselineScans: counting }));
      await collectEvidenceRaw(input({ commands: [command("bandit", ["-o", `../${outside.split("/").at(-1)!}/x.sarif`])], baselineScans: counting }));
      expect(asked).toBe(0);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("does not read a SARIF file over the size cap, and reads one exactly at it", async () => {
    let asked = 0;
    const counting = async (scans: readonly BaselineScan[]) => { asked += scans.length; return new Map<number, string>(); };
    const header = sarif([{ ruleId: "B608" }]);
    const padded = (size: number) => Buffer.concat([Buffer.from(header), Buffer.alloc(size - header.length, 0x20)]);
    await writeFile(join(root, "bandit.sarif"), padded(SARIF_REPORT_MAX_BYTES + 1));
    await collectEvidenceRaw(input({ baselineScans: counting }));
    expect(asked).toBe(0);
    await writeFile(join(root, "bandit.sarif"), padded(SARIF_REPORT_MAX_BYTES));
    await collectEvidenceRaw(input({ baselineScans: counting }));
    expect(asked).toBe(1);
  });

  it("does not take an empty SARIF file planted with a future date for a scan that found nothing", async () => {
    await writeFile(join(root, "bandit.sarif"), sarif([]));
    const future = new Date(Date.now() + 365 * 86_400_000);
    await utimes(join(root, "bandit.sarif"), future, future);
    let asked = 0;
    expect(await collectEvidenceRaw(input({ baselineScans: async (scans: readonly BaselineScan[]) => { asked += scans.length; return new Map<number, string>(); } }))).toBeUndefined();
    expect(asked).toBe(0);
  });

  it("an unreadable SARIF file is never a clean scan: a scan whose file does not parse is not reported", async () => {
    await writeFile(join(root, "bandit.sarif"), "{ not sarif");
    expect(await collectEvidenceRaw(input({ baselineScans: baseline(sarif([])) }))).toBeUndefined();
  });
});

describe("the baseline run on the original code", () => {
  const CANDIDATE = Buffer.from("candidate sarif\n");
  const scanner = command("bandit", ["-o", "bandit.sarif", "-f", "sarif"]);
  async function scan(): Promise<BaselineScan> {
    await writeFile(join(root, "bandit.sarif"), CANDIDATE);
    return { index: 0, command: scanner, argument: "bandit.sarif", path: await realFile("bandit.sarif"), candidateBytes: CANDIDATE };
  }
  const realFile = async (name: string) => (await import("node:fs/promises")).realpath(join(root, name));
  const passthrough: (events: string[]) => (repositories: unknown) => OriginalCode = (events) => () => ({ async run(work) { events.push("original shown"); try { return await work(); } finally { events.push("agent files back"); } } });
  const runnersWriting = (text: string | undefined, over: Partial<{ exitCode: number | null; timedOut: boolean }> = {}): CheckRunners => ({
    async runProjectCommand() { if (text !== undefined) await writeFile(join(root, "bandit.sarif"), text); return { exitCode: over.exitCode ?? 1, timedOut: over.timedOut ?? false, stdout: "", stderr: "" }; },
    async runAgentCommand() { throw new Error("not used"); },
  });
  const run = (over: Record<string, unknown> = {}) => ({ rootPath: root, runners: runnersWriting("baseline sarif"), signal: new AbortController().signal, budgetMs: 10 * 60_000, repositories: [{ directory: root, commit: "a".repeat(40) }], ...over });

  it("runs the same command with the original code shown, reads what it wrote (a scanner that found something exits non-zero), and puts the candidate's file back byte for byte", async () => {
    const events: string[] = [];
    const found = await runBaselineScans([await scan()], run({ originalCode: passthrough(events) }));
    expect([...found]).toEqual([[0, "baseline sarif"]]);
    expect(events).toEqual(["original shown", "agent files back"]);
    expect(Buffer.compare(await readFile(join(root, "bandit.sarif")), CANDIDATE)).toBe(0);
  });

  it("does not read a file the baseline run did not write (the candidate's file is removed first), a run that timed out, or one that never ran", async () => {
    expect((await runBaselineScans([await scan()], run({ runners: runnersWriting(undefined), originalCode: passthrough([]) }))).size).toBe(0);
    expect(Buffer.compare(await readFile(join(root, "bandit.sarif")), CANDIDATE)).toBe(0);
    expect((await runBaselineScans([await scan()], run({ runners: runnersWriting("late", { timedOut: true }), originalCode: passthrough([]) }))).size).toBe(0);
    expect(Buffer.compare(await readFile(join(root, "bandit.sarif")), CANDIDATE)).toBe(0);
  });

  it("does not start with too little budget left, once stopped, or with no repository; it runs with the minimum budget", async () => {
    let ran = 0;
    const counting: CheckRunners = { async runProjectCommand() { ran += 1; await writeFile(join(root, "bandit.sarif"), "b"); return { exitCode: 0, timedOut: false, stdout: "", stderr: "" }; }, async runAgentCommand() { throw new Error("x"); } };
    const stopped = new AbortController();
    stopped.abort();
    await runBaselineScans([await scan()], run({ runners: counting, budgetMs: MIN_BASELINE_BUDGET_MS - 1, originalCode: passthrough([]) }));
    await runBaselineScans([await scan()], run({ runners: counting, signal: stopped.signal, originalCode: passthrough([]) }));
    await runBaselineScans([await scan()], run({ runners: counting, repositories: [], originalCode: passthrough([]) }));
    expect(ran).toBe(0);
    await runBaselineScans([await scan()], run({ runners: counting, budgetMs: MIN_BASELINE_BUDGET_MS, originalCode: passthrough([]) }));
    expect(ran).toBe(1);
    expect(BASELINE_CAP_MS).toBe(10 * 60_000);
  });

  it("is only no baseline when the original code cannot be shown, but a failure to put the agent's files back is never swallowed; the candidate's file is put back either way", async () => {
    const cannot = () => ({ async run(): Promise<never> { throw new Error("no start commit"); } });
    expect((await runBaselineScans([await scan()], run({ originalCode: cannot }))).size).toBe(0);
    expect(Buffer.compare(await readFile(join(root, "bandit.sarif")), CANDIDATE)).toBe(0);
    const stuck = () => ({ async run(): Promise<never> { throw new AgentFilesRestoreError("kept under the ref"); } });
    await expect(runBaselineScans([await scan()], run({ originalCode: stuck }))).rejects.toBeInstanceOf(AgentFilesRestoreError);
    expect(Buffer.compare(await readFile(join(root, "bandit.sarif")), CANDIDATE)).toBe(0);
  });

  it("does not follow a link the baseline run left in place of the file, and replaces it with the candidate's file", async () => {
    const outside = await mkdtemp(join(tmpdir(), "outside-"));
    try {
      await writeFile(join(outside, "secret.sarif"), "outside content");
      const planting: CheckRunners = { async runProjectCommand() { await symlink(join(outside, "secret.sarif"), join(root, "bandit.sarif")); return { exitCode: 1, timedOut: false, stdout: "", stderr: "" }; }, async runAgentCommand() { throw new Error("x"); } };
      expect((await runBaselineScans([await scan()], run({ runners: planting, originalCode: passthrough([]) }))).size).toBe(0);
      expect(Buffer.compare(await readFile(join(root, "bandit.sarif")), CANDIDATE)).toBe(0);
      expect(await readFile(join(outside, "secret.sarif"), "utf8")).toBe("outside content");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("finds the file in a sub-directory check (cwd) too", async () => {
    await mkdir(join(root, "svc"));
    await writeFile(join(root, "svc/bandit.sarif"), CANDIDATE);
    const sub: BaselineScan = { index: 3, command: command("bandit", ["-o", "bandit.sarif", "-f", "sarif"], "svc"), argument: "bandit.sarif", path: await realFile("svc/bandit.sarif"), candidateBytes: CANDIDATE };
    const writing: CheckRunners = { async runProjectCommand() { await writeFile(join(root, "svc/bandit.sarif"), "from svc"); return { exitCode: 0, timedOut: false, stdout: "", stderr: "" }; }, async runAgentCommand() { throw new Error("x"); } };
    expect([...(await runBaselineScans([sub], run({ runners: writing, originalCode: passthrough([]) })))]).toEqual([[3, "from svc"]]);
  });
});

describe("saving the evidence with a baseline", () => {
  const scanner = command("bandit", ["-r", ".", "-f", "sarif", "-o", "bandit.sarif"]);
  const baselineRunner = (): CheckRunners => ({
    async runProjectCommand() { await writeFile(join(root, "bandit.sarif"), sarif([{ ruleId: "B105", level: "note", message: "old", uri: "src/a.py", line: 30 }])); return { exitCode: 1, timedOut: false, stdout: "", stderr: "" }; },
    async runAgentCommand() { throw new Error("not used"); },
  });
  const original: (events: string[]) => (repositories: unknown) => OriginalCode = (events) => () => ({ async run(work) { events.push("shown"); try { return await work(); } finally { events.push("back"); } } });
  const save = async (box: Awaited<ReturnType<typeof world>>, over: Record<string, unknown> = {}) => {
    const saved: Array<{ name: string; content: string }> = [];
    const done = await saveEvidenceRaw({
      sink: async (artifact) => { saved.push({ name: artifact.name, content: String(artifact.content) }); },
      rootPath: root, plan: { source: "project", readiness: [scanner] }, entries: [entry(0)],
      repositories: [{ repositoryId: "api", directory: box.directory, baseCommitSha: box.base }],
      candidateBefore: [{ repositoryId: "api", commitSha: box.base, treeSha: box.tree, baseCommitSha: box.base }],
      roundStartedAtMs: Date.now() - 5_000,
      baseline: { runners: baselineRunner(), signal: new AbortController().signal, budgetMs: 10 * 60_000, ...over },
    });
    return { done, saved };
  };

  it("runs the scanner on the original code and saves only the findings the baseline did not have; the candidate's file is back", async () => {
    const box = await world();
    const events: string[] = [];
    const { done, saved } = await save(box, { originalCode: original(events) });
    expect(done).toBe(true);
    expect(events).toEqual(["shown", "back"]);
    const raw = JSON.parse(saved[0]!.content) as { checks: Array<{ findings: { newCount: number; items: Array<{ ruleId: string }> } }> };
    expect(raw.checks[0]?.findings.newCount).toBe(1);
    expect(raw.checks[0]?.findings.items.map((item) => item.ruleId)).toEqual(["B608"]);
    expect(await readFile(join(root, "bandit.sarif"), "utf8")).toContain("new one");
  });

  it("saves nothing for the scan when no baseline can run (none asked for, no time left, or an original code that cannot be shown)", async () => {
    const box = await world();
    const none = await saveEvidenceRaw({ sink: async () => undefined, rootPath: root, plan: { source: "project", readiness: [scanner] }, entries: [entry(0)], repositories: [{ repositoryId: "api", directory: box.directory, baseCommitSha: box.base }], candidateBefore: [{ repositoryId: "api", commitSha: box.base, treeSha: box.tree, baseCommitSha: box.base }], roundStartedAtMs: Date.now() - 5_000 });
    expect(none).toBe(true);
    const notCompared = async (saved: Promise<{ done: boolean; saved: Array<{ content: string }> }>) => (JSON.parse((await saved).saved[0]!.content) as { checks: Array<{ findings: { newCount: number; unverified?: number } }> }).checks[0]?.findings;
    expect(await notCompared(save(box, { budgetMs: 1_000, originalCode: original([]) }))).toMatchObject({ newCount: 0, unverified: 1 });
    expect(await notCompared(save(box, { originalCode: () => ({ async run(): Promise<never> { throw new Error("no"); } }) }))).toMatchObject({ newCount: 0, unverified: 1 });
  });

  it("does not run the baseline when a repository of the task has no start commit (it would show the original code in only some)", async () => {
    const box = await world();
    const events: string[] = [];
    const saved = await saveEvidenceRaw({
      sink: async () => undefined, rootPath: root, plan: { source: "project", readiness: [scanner] }, entries: [entry(0)],
      repositories: [{ repositoryId: "api", directory: box.directory, baseCommitSha: box.base }, { repositoryId: "web", directory: join(root, "web") }],
      candidateBefore: [{ repositoryId: "api", commitSha: box.base, treeSha: box.tree, baseCommitSha: box.base }],
      roundStartedAtMs: Date.now() - 5_000, baseline: { runners: baselineRunner(), signal: new AbortController().signal, budgetMs: 10 * 60_000, originalCode: original(events) },
    });
    expect(saved).toBe(true);
    expect(events).toEqual([]);
  });

  it("never swallows a failure to put the agent's files back", async () => {
    const box = await world();
    await expect(save(box, { originalCode: () => ({ async run(): Promise<never> { throw new AgentFilesRestoreError("kept under the ref"); } }) })).rejects.toBeInstanceOf(AgentFilesRestoreError);
    expect(await readFile(join(root, "bandit.sarif"), "utf8")).toContain("new one");
  });
});
