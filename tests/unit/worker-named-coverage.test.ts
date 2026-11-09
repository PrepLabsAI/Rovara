// S-2 (Opus review of proof-fixes): a coverage report counts only when the check's own command names it, OR when the maintainer approved it as the check's `coveragePath` (the test environment / setup the person
// approved, not a guess). So a project whose coverage is set in pytest addopts, a jest or vitest config, or a JaCoCo build keeps its changed-line coverage. A named report in the Go cover profile or JaCoCo
// XML format is read through the same contained, fresh-file rules and placed in the repository (Go modules, Java source roots).
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CheckEntry, ProjectCommand } from "../../packages/contracts/src/index.js";
import { coverageSpecsOf } from "../../packages/worker/src/verification/cobertura-lcov-coverage.js";
import { collectEvidenceRaw } from "../../packages/worker/src/verification/evidence-raw.js";

const run = promisify(execFile);
const DIGEST = "d".repeat(64);
const command = (args: string[], cwd = ".", executable = "pytest"): ProjectCommand => ({ executable, args, cwd, timeoutSeconds: 60 });
const entry = (index: number): CheckEntry => ({ id: `readiness:${String(index)}`, label: "tests", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 100, exitCode: 0 });

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "named-coverage-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function git(directory: string, args: string[]): Promise<string> {
  return (await run("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: directory })).stdout.trim();
}
/** A repository `api` under the workspace root: the base files committed, then `change` applied and staged. */
async function repository(files: Record<string, string>, change: (directory: string) => Promise<void>) {
  const directory = join(root, "api");
  await mkdir(directory, { recursive: true });
  await git(directory, ["init", "-q"]);
  for (const [path, text] of Object.entries(files)) { await mkdir(join(directory, path, ".."), { recursive: true }); await writeFile(join(directory, path), text); }
  await git(directory, ["add", "-A"]);
  await git(directory, ["commit", "-q", "-m", "base"]);
  const base = await git(directory, ["rev-parse", "HEAD"]);
  await change(directory);
  await git(directory, ["add", "-A"]);
  return { repositories: [{ repositoryId: "api", directory, startCommit: base, candidateTreeSha: await git(directory, ["write-tree"]) }] };
}
const lines = (count: number) => Array.from({ length: count }, (_, index) => `x${String(index + 1)}`).join("\n") + "\n";
const collect = (box: Awaited<ReturnType<typeof repository>>, commands: ProjectCommand[], coveragePaths: Array<string | undefined>) =>
  collectEvidenceRaw({ rootPath: root, commands, entries: commands.map((_, index) => entry(index)), candidateDigest: DIGEST, repositories: box.repositories, roundStartedAtMs: Date.now() - 5_000, coveragePaths });

describe("the approved coveragePath is a named report", () => {
  it("coverageSpecsOf adds it after what the command line names, by the format its name says, and never twice", () => {
    expect(coverageSpecsOf(command(["-q"]), "reports/coverage.xml")).toEqual([{ format: "named", argument: "reports/coverage.xml" }]);
    expect(coverageSpecsOf(command(["--cov-report=xml:a.xml"]), "b.info").map((spec) => `${spec.format}:${spec.argument}`)).toEqual(["cobertura:a.xml", "named:b.info"]);
    expect(coverageSpecsOf(command(["--cov-report=xml:a.xml"]), "a.xml")).toHaveLength(1);
    expect(coverageSpecsOf(command(["-q"]))).toEqual([]);
    // A name that is not a plain path argument is not used.
    expect(coverageSpecsOf(command(["-q"]), "--evil")).toEqual([]);
    expect(coverageSpecsOf(command(["-q"]), "x".repeat(2000))).toEqual([]);
  });

  it("a Cobertura report at the approved path is read for a command that names none (pytest addopts, a jest config), relative to the check's directory", async () => {
    const box = await repository({ "src/a.py": lines(4) }, async (directory) => { await writeFile(join(directory, "src/a.py"), "n1\nx2\nn3\nx4\n"); });
    const xml = `<coverage><sources><source>${join(root, "api/src")}</source></sources><packages><package><classes><class filename="a.py"><lines><line number="1" hits="1"/><line number="3" hits="0"/></lines></class></classes></package></packages></coverage>`;
    await mkdir(join(root, "api/reports"), { recursive: true });
    await writeFile(join(root, "api/reports/coverage.xml"), xml);
    const without = await collect(box, [command(["-q"], "api")], [undefined]);
    expect(without?.checks[0]?.coverage).toBeUndefined();
    const named = await collect(box, [command(["-q"], "api")], ["reports/coverage.xml"]);
    expect(named?.checks[0]?.coverage).toMatchObject({ linesChanged: 2, linesCovered: 1 });
  });

  it("an LCOV file at the approved path is read; a stale one is not (the freshness rules apply to it too)", async () => {
    const box = await repository({ "src/a.js": lines(3) }, async (directory) => { await writeFile(join(directory, "src/a.js"), "n1\nx2\nx3\n"); });
    await mkdir(join(root, "api/coverage"), { recursive: true });
    await writeFile(join(root, "api/coverage/lcov.info"), `SF:${join(root, "api/src/a.js")}\nDA:1,1\nend_of_record\n`);
    expect((await collect(box, [command(["test"], "api", "npm")], ["coverage/lcov.info"]))?.checks[0]?.coverage).toMatchObject({ linesChanged: 1, linesCovered: 1 });
    const stale = await collectEvidenceRaw({ rootPath: root, commands: [command(["test"], "api", "npm")], entries: [entry(0)], candidateDigest: DIGEST, repositories: box.repositories, roundStartedAtMs: Date.now() + 3_600_000, coveragePaths: ["coverage/lcov.info"] });
    expect(stale?.checks[0]?.coverage).toBeUndefined();
  });

  it("a JaCoCo XML at the approved path is read and placed in the repository's Java source root", async () => {
    const box = await repository({ "src/main/java/com/acme/A.java": lines(5), "pom.xml": "<project/>\n" }, async (directory) => { await writeFile(join(directory, "src/main/java/com/acme/A.java"), "n1\nx2\nn3\nx4\nx5\n"); });
    const jacoco = '<?xml version="1.0"?><!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd"><report name="m"><package name="com/acme"><sourcefile name="A.java"><line nr="1" mi="0" ci="2" mb="0" cb="0"/><line nr="3" mi="4" ci="0" mb="0" cb="0"/></sourcefile></package></report>';
    await mkdir(join(root, "api/target/site/jacoco"), { recursive: true });
    await writeFile(join(root, "api/target/site/jacoco/jacoco.xml"), jacoco);
    const raw = await collect(box, [command(["-B", "verify"], "api", "mvn")], ["target/site/jacoco/jacoco.xml"]);
    expect(raw?.checks[0]?.coverage).toMatchObject({ linesChanged: 2, linesCovered: 1, files: [{ path: "src/main/java/com/acme/A.java", uncovered: [3] }] });
  });

  it("a Go cover profile at the approved path is read and placed through the module path", async () => {
    const box = await repository({ "go.mod": "module example.com/acme/match\n\ngo 1.22\n", "pkg/a.go": lines(5) }, async (directory) => { await writeFile(join(directory, "pkg/a.go"), "n1\nx2\nn3\nx4\nx5\n"); });
    await writeFile(join(root, "api/coverage.out"), "mode: set\nexample.com/acme/match/pkg/a.go:1.1,1.20 1 1\nexample.com/acme/match/pkg/a.go:3.1,3.20 1 0\n");
    const raw = await collect(box, [command(["test", "-coverprofile=coverage.out", "./..."], "api", "go")], ["coverage.out"]);
    expect(raw?.checks[0]?.coverage).toMatchObject({ linesChanged: 2, linesCovered: 1, files: [{ path: "pkg/a.go", uncovered: [3] }] });
  });

  it("a file in neither format, or a report outside the workspace, claims nothing", async () => {
    const box = await repository({ "src/a.py": lines(2) }, async (directory) => { await writeFile(join(directory, "src/a.py"), "n1\nn2\n"); });
    await writeFile(join(root, "api/notes.txt"), "hello");
    expect((await collect(box, [command(["-q"], "api")], ["notes.txt"]))?.checks[0]?.coverage).toBeUndefined();
    expect((await collect(box, [command(["-q"], "api")], ["../../etc/passwd"]))?.checks[0]?.coverage).toBeUndefined();
  });
});
