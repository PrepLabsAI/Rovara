// Proof and evidence (wire-proof), the worker's half: a CHECKS run that was asked for evidence reads the test reports its own project checks already write (never changing a command) and saves
// `evidence-raw.json`. Real files in a real workspace: a JUnit report, a vitest JSON report, a failing check's output tail, a report path that leaves the workspace, a symlink, a malformed file.
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVIDENCE_RAW_ARTIFACT, EvidenceRawSchema, createCandidateManifest, type CheckEntry, type ProjectCommand } from "../../packages/contracts/src/index.js";
import { collectEvidenceRaw, outputTailOf, saveEvidenceRaw } from "../../packages/worker/src/verification/evidence-raw.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";
import { EVIDENCE_CAPTURE_FEATURE, WORKER_INVOCATION_FEATURES } from "../../packages/contracts/src/index.js";

const DIGEST = "d".repeat(64);
const CANDIDATE = [{ repositoryId: "api", commitSha: "a".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "c".repeat(40) }];
const JUNIT = `<?xml version="1.0"?><testsuites><testsuite name="pytest" tests="3">
<testcase classname="tests.test_match" name="test_no_region" file="tests/test_match.py" time="0.01"/>
<testcase classname="tests.test_match" name="test_scores" file="tests/test_match.py" time="0.02"/>
<testcase classname="tests.test_old" name="test_old" file="tests/test_old.py" time="0.01"><skipped message="slow"/></testcase>
</testsuite></testsuites>`;
const command = (args: string[], cwd = "."): ProjectCommand => ({ executable: "pytest", args, cwd, timeoutSeconds: 60 });
const entry = (index: number, over: Partial<CheckEntry> = {}): CheckEntry => ({ id: `readiness:${String(index)}`, label: "pytest", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 100, exitCode: 0, ...over });

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "evidence-raw-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("the test report a check already writes", () => {
  it("becomes totals and names, and the digest and a full-run selection come with it; the command is never altered", async () => {
    await writeFile(join(root, "report.xml"), JUNIT);
    const commands = [command(["--junitxml=report.xml"])];
    const raw = await collectEvidenceRaw({ rootPath: root, commands, entries: [entry(0)], candidateDigest: DIGEST, repositories: [] });
    expect(raw?.candidateDigest).toBe(DIGEST);
    expect(raw?.checks).toHaveLength(1);
    expect(raw?.checks[0]).toMatchObject({ checkId: "readiness:0", tests: { total: 3, passed: 2, skipped: 1, failed: 0, errored: 0 } });
    expect(raw?.checks[0]?.tests?.names.map((name) => name.name)).toContain("tests/test_match.py::test_no_region");
    expect(raw?.selection).toEqual({ method: "full", selected: 3, total: 3 });
    expect(commands[0]?.args).toEqual(["--junitxml=report.xml"]);
    expect(EvidenceRawSchema.safeParse(raw).success).toBe(true);
  });

  it("reads a vitest JSON report too, and only the check that names one", async () => {
    await writeFile(join(root, "out.json"), JSON.stringify({ testResults: [{ name: "/w/src/a.test.ts", status: "passed", assertionResults: [{ fullName: "a works", status: "passed", duration: 3 }] }] }));
    const raw = await collectEvidenceRaw({ rootPath: root, commands: [command(["run", "--reporter=json", "--outputFile=out.json"]), command(["lint"])], entries: [entry(0), entry(1, { label: "lint" })], candidateDigest: DIGEST, repositories: [] });
    expect(raw?.checks.map((check) => check.checkId)).toEqual(["readiness:0"]);
    expect(raw?.checks[0]?.tests).toMatchObject({ total: 1, passed: 1 });
  });

  it("says nothing for a check with no report and no failure: nothing is measured, so nothing is claimed", async () => {
    expect(await collectEvidenceRaw({ rootPath: root, commands: [command(["-q"])], entries: [entry(0)], candidateDigest: DIGEST, repositories: [] })).toBeUndefined();
  });

  it("keeps only the end of a failed check's output, redacted, and none for a passing check", async () => {
    const secret = `ghp_${"Ab1Cd2Ef3Gh4".repeat(3)}`;
    const failed = entry(0, { after: "failed", exitCode: 1, output: `${"x".repeat(40_000)}\nAssertionError: boom ${secret}\n` });
    const raw = await collectEvidenceRaw({ rootPath: root, commands: [command(["-q"])], entries: [failed], candidateDigest: DIGEST, repositories: [] });
    const tail = raw?.checks[0]?.outputTail ?? "";
    expect(tail).toContain("AssertionError: boom");
    expect(tail).not.toContain(secret);
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(await collectEvidenceRaw({ rootPath: root, commands: [command(["-q"])], entries: [entry(0, { output: "all fine" })], candidateDigest: DIGEST, repositories: [] })).toBeUndefined();
  });
});

describe("a report it must not read", () => {
  it("outside the workspace, through a link, malformed, or not there at all gives no tests", async () => {
    await mkdir(join(root, "work"));
    const outside = await mkdtemp(join(tmpdir(), "outside-"));
    await writeFile(join(outside, "secret.xml"), JUNIT);
    await symlink(join(outside, "secret.xml"), join(root, "work", "link.xml"));
    await writeFile(join(root, "work", "bad.xml"), "<testsuite><testcase name=");
    const run = (arg: string) => collectEvidenceRaw({ rootPath: join(root, "work"), commands: [command([arg])], entries: [entry(0)], candidateDigest: DIGEST, repositories: [] });
    expect(await run(`--junitxml=${join(outside, "secret.xml")}`)).toBeUndefined();
    expect(await run("--junitxml=../../../../etc/passwd.xml")).toBeUndefined();
    expect(await run("--junitxml=link.xml")).toBeUndefined();
    expect(await run("--junitxml=bad.xml")).toBeUndefined();
    expect(await run("--junitxml=missing.xml")).toBeUndefined();
    await rm(outside, { recursive: true, force: true });
  });
});

describe("saving it", () => {
  const saved: Array<{ name: string; mediaType: string; content: string }> = [];
  const sink = async (artifact: { name: string; mediaType: string; content: string | Uint8Array }) => { saved.push({ name: artifact.name, mediaType: artifact.mediaType, content: String(artifact.content) }); };

  it("writes evidence-raw.json for a project plan bound to the candidate, and nothing for an agent-commands plan", async () => {
    saved.length = 0;
    await writeFile(join(root, "report.xml"), JUNIT);
    const plan = { source: "project" as const, readiness: [command(["--junitxml=report.xml"])] };
    expect(await saveEvidenceRaw({ sink, rootPath: root, plan, entries: [entry(0)], repositories: [], candidateBefore: CANDIDATE })).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.name).toBe(EVIDENCE_RAW_ARTIFACT);
    const written = JSON.parse(saved[0]!.content) as { candidateDigest: string };
    expect(EvidenceRawSchema.safeParse(written).success).toBe(true);
    expect(written.candidateDigest).toBe(createCandidateManifest(CANDIDATE).digest);
    saved.length = 0;
    expect(await saveEvidenceRaw({ sink, rootPath: root, plan: { source: "agent_commands" }, entries: [entry(0)], repositories: [], candidateBefore: [] })).toBe(false);
    expect(saved).toHaveLength(0);
  });

  it("a sink that throws is only a missing file", async () => {
    await writeFile(join(root, "report.xml"), JUNIT);
    const plan = { source: "project" as const, readiness: [command(["--junitxml=report.xml"])] };
    await expect(saveEvidenceRaw({ sink: async () => { throw new Error("disk full"); }, rootPath: root, plan, entries: [entry(0)], repositories: [], candidateBefore: CANDIDATE })).resolves.toBe(false);
  });
});

describe("the output tail", () => {
  it("is cut from its start, keeps whole characters, and is undefined for nothing", () => {
    expect(outputTailOf("")).toBeUndefined();
    const tail = outputTailOf("é".repeat(10_000), 100)!;
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(100);
    expect(tail).not.toContain("�");
  });
});

describe("the feature the broker asks for", () => {
  it("the worker lists it, and the contracts know it", () => {
    expect(EVIDENCE_CAPTURE_FEATURE).toBe("task.evidenceCapture.v1");
    expect(WORKER_INVOCATION_FEATURES).toContain(EVIDENCE_CAPTURE_FEATURE);
    expect(WORKER_IMPLEMENTED_FEATURES).toContain(EVIDENCE_CAPTURE_FEATURE);
  });
});
