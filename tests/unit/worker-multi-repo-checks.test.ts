import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import * as fileSystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectCommand } from "@agentx/contracts";
import { isolatedGitEnvironment } from "../../packages/worker/src/git.js";
import { withMultiRepoChecks, type MultiRepoChecks } from "../../packages/worker/src/multi-repo-checks.js";
import { createCheckRunners, runChecks } from "../../packages/worker/src/verification/checks.js";
import { readCandidateRepositories } from "../../packages/worker/src/verification/candidate.js";
import { runTestProof } from "../../packages/worker/src/verification/test-proof.js";
import { runTaskInvocation, type TaskInvocationDependencies } from "../../packages/worker/src/run-task.js";
import { FAUX_MODEL } from "../support/faux-model.js";
import { randomUUID } from "node:crypto";
import { collectEvidenceRaw, saveEvidenceRaw } from "../../packages/worker/src/verification/evidence-raw.js";
import { readChangedCoverage } from "../../packages/worker/src/verification/cobertura-lcov-coverage.js";
import { runBaselineScans } from "../../packages/worker/src/verification/sarif-baseline.js";
import { temporaryIndexTree } from "../../packages/worker/src/publish.js";
import { snapshotTree, withIsolatedGit } from "../../packages/worker/src/isolated-git.js";
import * as isolatedCopies from "../../packages/worker/src/isolated-git.js";
import * as partCopies from "../../packages/worker/src/parallel-parts-git.js";
import { RunnerKillUnconfirmedError } from "../../packages/worker/src/collected-process.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fileSystem>();
  return { ...actual, opendir: vi.fn(actual.opendir) };
});

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const git = (directory: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Codex", "-c", "user.email=noreply@openai.com", ...args], { cwd: directory, env: { ...isolatedGitEnvironment(directory), GIT_ALLOW_PROTOCOL: "file" }, encoding: "utf8" }).trim();
const put = async (root: string, path: string, text: string) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); };
const command = (script: string, cwd = "app"): ProjectCommand => ({ executable: process.execPath, args: ["-e", script], cwd, timeoutSeconds: 20 });

async function fixture(files: Record<string, string> = {}) {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "te-r1-check-")));
  roots.push(root);
  const repositories: MultiRepoChecks["repositories"][number][] = [];
  for (const name of ["app", "lib"]) {
    const seed = join(root, `seed-${name}`);
    await mkdir(seed);
    git(seed, "init", "-q", "-b", "main");
    await put(seed, "code.cjs", "module.exports = 'base';\n");
    await put(seed, ".gitignore", "node_modules/\nreport.json\nscan.sarif\n");
    for (const [path, text] of Object.entries(files)) await put(seed, path, text.replaceAll("$NAME", name));
    git(seed, "add", "-A"); git(seed, "commit", "-qm", "base");
    const baseCommit = git(seed, "rev-parse", "HEAD");
    git(root, "clone", "-q", "--bare", seed, `remote-${name}.git`);
    git(root, "clone", "-q", `remote-${name}.git`, name);
    if (name === "app") {
      git(join(root, name), "checkout", "-qb", "task/r1");
      await put(root, `${name}/code.cjs`, "module.exports = 'task';\n");
      git(join(root, name), "add", "-A"); git(join(root, name), "commit", "-qm", "task");
      await put(root, `${name}/code.cjs`, "module.exports = 'dirty candidate';\n");
    }
    repositories.push({ repositoryId: name, path: name, baseCommit, ...(name === "app" ? { taskBranch: "refs/heads/task/r1" } : {}) });
  }
  const input: MultiRepoChecks = { rootPath: root, repositories, dependencies: [], setup: [] };
  const wrapped = withMultiRepoChecks(input, createCheckRunners({ rootPath: root, local: true }));
  const runners = () => wrapped;
  const reports = () => wrapped.reportRoot?.() ?? root;
  const run = (commands: ProjectCommand[], signal = new AbortController().signal) => runChecks({ source: "project", readiness: commands }, runners(), { signal, budgetMs: 30_000 });
  const identity = () => readCandidateRepositories(repositories.map((repo) => ({ repositoryId: repo.repositoryId, directory: join(root, repo.path), baseCommitSha: repo.baseCommit })));
  return { root, input, runners, run, identity, reports };
}

describe("candidate-bound multi-repository rounds", () => {
  it("routes the real CHECKS invocation through the worker injection without changing identity shapes", async () => {
    const f = await fixture();
    await put(f.root, ".agentx/preparation-manifest.json", JSON.stringify({ schemaVersion: 2, projectName: "r1", projectRevision: 1,
      repositories: f.input.repositories.map((repo) => ({ name: repo.repositoryId, path: repo.path, defaultBranch: "main", resolvedCommit: repo.baseCommit })),
      completedSetupSteps: [], readinessResults: [], readinessCommandKeys: [], complete: true, updatedAt: new Date().toISOString() }));
    const dependencies: TaskInvocationDependencies & { multiRepoChecks: MultiRepoChecks } = { rootPath: f.root, model: FAUX_MODEL,
      taskShell: { kind: "local" }, stopBeforeReading: { stopWorkspaceProcesses: async () => ({ stopped: 0 }), sweepWorkspaceContainers: async () => ({ removed: 0 }) }, multiRepoChecks: f.input, eventSink: async () => undefined, artifactSink: async () => undefined };
    const invocation: Parameters<typeof runTaskInvocation>[0] = { protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
      payload: { workflowMode: "CHECKS", conversationId: randomUUID(), prompt: "check", readiness: [command("console.log(process.cwd())")] } };
    const result = await runTaskInvocation(invocation, dependencies);
    expect(result.checks?.checks[0]?.output).toContain(".agentx-check-");
    expect(result.workflowCheckCandidateRepositories).toEqual(await f.identity());
    dependencies.multiRepoChecks = { ...f.input, repositories: f.input.repositories.slice(0, 1) };
    await expect(runTaskInvocation(invocation, dependencies)).rejects.toThrow("selection does not cover");
  });

  it("publish and isolated-git capture zero wiring files but retain legitimate manifest edits", async () => {
    const f = await fixture();
    const directory = join(f.root, "app");
    for (const name of ["package.json", "go.mod", "pom.xml"]) {
      await put(directory, `.agentx-check-fixture/app/${name}`, "generated wiring");
      await put(directory, name, "legitimate candidate edit");
    }
    for (const tree of [await temporaryIndexTree({ directory }, f.input.repositories[0]!.baseCommit), await withIsolatedGit(directory, "write", async (git) => snapshotTree(git, await git.headCommit()))]) {
      const files = git(directory, "ls-tree", "-r", "--name-only", tree).split("\n");
      expect(files.filter((path) => path.includes(".agentx-check-"))).toEqual([]);
      expect(files).toEqual(expect.arrayContaining(["package.json", "go.mod", "pom.xml"]));
    }
  });

  it("SARIF baseline reads the old-code report after the copy is removed and restores the candidate report", async () => {
    const f = await fixture();
    const check = command("require('fs').writeFileSync('scan.sarif', JSON.stringify({code:require('./code.cjs'),cwd:process.cwd()}))");
    check.args.push("--", "--output=scan.sarif");
    await f.run([check]);
    const path = join(f.reports(), "app/scan.sarif");
    const candidateBytes = await readFile(path);
    const base = createCheckRunners({ rootPath: f.root, local: true });
    const runners = withMultiRepoChecks(f.input, { ...base, runProjectCommand: async (cmd, signal) => { expect(await readFile(join(f.root, "app/code.cjs"), "utf8")).toContain("dirty candidate"); return base.runProjectCommand(cmd, signal); } });
    const result = await runBaselineScans([{ index: 0, command: check, argument: "scan.sarif", path, candidateBytes }], { rootPath: f.root, runners, signal: new AbortController().signal, budgetMs: 120_000,
      repositories: f.input.repositories.map((repo) => ({ directory: join(f.root, repo.path), commit: repo.baseCommit })) });
    const old = JSON.parse(result.get(0)!) as { code: string; cwd: string };
    expect(old.code).toBe("base"); expect(old.cwd).toContain(".agentx-check-");
    await expect(stat(old.cwd)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path)).toEqual(candidateBytes);
  });
  it("executes dirty task files and unaffected base files in independent copies, then cleans success", async () => {
    const f = await fixture();
    const before = await f.identity();
    const round = await f.run([command("console.log(JSON.stringify({cwd:process.cwd(), own:require('./code.cjs'), other:require('../lib/code.cjs')}))")]);
    expect(round.entries[0]?.after).toBe("passed");
    const result = JSON.parse(round.entries[0]!.output) as { cwd: string; own: string; other: string };
    expect(result.own).toBe("dirty candidate"); expect(result.other).toBe("base");
    expect(result.cwd).not.toBe(join(f.root, "app"));
    expect(result.cwd).toContain(".agentx-check-");
    await expect(stat(result.cwd)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await f.identity()).toEqual(before);
  });

  it("keeps candidate coverage when an old-code round runs only a SARIF subset", async () => {
    const f = await fixture({ ".gitignore": "node_modules/\nreport.json\nscan.sarif\ncoverage.lcov\n" });
    f.input.coveragePaths = ["coverage.lcov", undefined];
    const coverage = command("require('fs').writeFileSync('coverage.lcov','candidate coverage')");
    const scan = command("require('fs').writeFileSync('scan.sarif',JSON.stringify({code:require('./code.cjs')}))");
    scan.args.push("--", "--output=scan.sarif");
    await f.run([coverage, scan]);
    const path = join(f.reports(), "app/scan.sarif");
    const candidateBytes = await readFile(path);
    const result = await runBaselineScans([{ index: 1, command: scan, argument: "scan.sarif", path, candidateBytes }], { rootPath: f.root, runners: f.runners(), signal: new AbortController().signal, budgetMs: 120_000,
      repositories: f.input.repositories.map((repo) => ({ directory: join(f.root, repo.path), commit: repo.baseCommit })) });
    expect(result.get(1)?.toString()).toContain("base");
    expect(await readFile(join(f.reports(), "app/coverage.lcov"), "utf8")).toBe("candidate coverage");
  });

  it("wires Node packages only in the copy and preserves the original identity and index", async () => {
    const f = await fixture({ "package.json": '{"name":"$NAME","version":"1.0.0","main":"code.cjs"}' });
    f.input.dependencies = [{ consumer: "app", provider: "lib", language: "node" }];
    const before = await f.identity();
    const index = await readFile(join(f.root, "app/.git/index"));
    const round = await f.run([command("console.log(require('lib')); console.log(require('./package.json').dependencies)")]);
    expect(round.entries[0]).toMatchObject({ after: "passed", output: "base\nundefined\n" });
    expect(await f.identity()).toEqual(before);
    expect(await readFile(join(f.root, "app/.git/index"))).toEqual(index);
    expect(JSON.parse(await readFile(join(f.root, "app/package.json"), "utf8"))).not.toHaveProperty("dependencies");
  });

  it("uses a local package tarball and local dependency links with npm offline", async () => {
    const f = await fixture({ "package.json": '{"name":"$NAME","version":"1.0.0","main":"code.cjs"}' });
    await put(f.root, "tar-source/package.json", '{"name":"tar-only","version":"1.0.0","main":"index.js"}');
    await put(f.root, "tar-source/index.js", "module.exports='tarball';\n");
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    execFileSync(npm, ["pack", "--offline", "--ignore-scripts", "--pack-destination", join(f.root, "app")], { cwd: join(f.root, "tar-source"), env: { ...process.env, npm_config_cache: join(f.root, "pack-cache") }, stdio: "pipe" });
    f.input.dependencies = [{ consumer: "app", provider: "lib", language: "node" }];
    f.input.setup = [{ executable: npm, args: ["install", "./tar-only-1.0.0.tgz", "--offline", "--ignore-scripts", "--no-save", "--package-lock=false", "--no-audit", "--no-fund"], cwd: "app", timeoutSeconds: 20, env: { npm_config_cache: ".agentx-npm-cache" } }];
    const before = await f.identity();
    const round = await f.run([command("console.log(require('tar-only'),require('lib'))")]);
    expect(round.entries[0]).toMatchObject({ after: "passed", output: "tarball base\n" });
    expect(await f.identity()).toEqual(before);
  });

  it("copies fresh reports out before cleanup and retains check failures", async () => {
    const f = await fixture();
    const report = command("require('fs').writeFileSync('report.json', JSON.stringify({from:process.cwd()})); process.exit(1)");
    report.args.push("--", "--outputFile=report.json", "--reporter=json");
    const round = await f.run([report]);
    expect(round.entries[0]?.after).toBe("failed");
    const saved = JSON.parse(await readFile(join(f.reports(), "app/report.json"), "utf8")) as { from: string };
    expect(saved.from).toContain(".agentx-check-");
    await expect(stat(saved.from)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("joins a killed command before deleting its copy", async () => {
    const f = await fixture();
    const stop = new AbortController();
    const base = createCheckRunners({ rootPath: f.root, local: true });
    let execution = "";
    const runners = withMultiRepoChecks(f.input, { ...base, async runProjectCommand(cmd, signal) {
      execution = join(f.root, cmd.cwd);
      const pending = base.runProjectCommand(cmd, signal);
      const timer = setTimeout(() => stop.abort(), 200);
      try { return await pending; } finally { clearTimeout(timer); }
    } });
    const round = await runChecks({ source: "project", readiness: [command("setInterval(()=>{},1000)")] }, runners, { signal: stop.signal, budgetMs: 30_000 });
    expect(round.stopped).toBe(true);
    expect(execution).toContain(".agentx-check-");
    await expect(stat(execution)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(f.root, "app/code.cjs"), "utf8")).toContain("dirty candidate");
  });

  it("TESTPROOF runs base code plus the new test inside the root and never swaps the original", async () => {
    const f = await fixture();
    await put(f.root, "app/change.test.cjs", "const assert=require('assert'); const passed=require('./code.cjs')==='dirty candidate'; require('fs').writeFileSync('report.json',JSON.stringify({testResults:[{name:'change.test.cjs',assertionResults:[{fullName:'candidate is fixed',status:passed?'passed':'failed',failureMessages:passed?[]:['AssertionError']}]}]})); console.log('change.test.cjs'); assert.ok(passed);\n");
    const before = await f.identity();
    const paths: string[] = [];
    const base = createCheckRunners({ rootPath: f.root, local: true });
    const runners = withMultiRepoChecks(f.input, { ...base, async runProjectCommand(cmd, signal) {
      paths.push(cmd.cwd);
      expect(await readFile(join(f.root, "app/code.cjs"), "utf8")).toContain("dirty candidate");
      return base.runProjectCommand(cmd, signal);
    } });
    const check = command("require('./change.test.cjs')");
    check.args.push("--", "--outputFile=report.json", "--reporter=json");
    const plan = { source: "project" as const, readiness: [check] };
    const signal = new AbortController().signal;
    const round = await runChecks(plan, runners, { signal, budgetMs: 30_000 });
    const candidateReport = await readFile(join(runners.reportRoot!(), "app/report.json"));
    const proof = await runTestProof({ plan, newEntries: round.entries.map((entry) => ({ ...entry, output: `${entry.output}\nchange.test.cjs` })), runners,
      repositories: f.input.repositories.map((repo, i) => ({ repositoryId: repo.repositoryId, directory: join(f.root, repo.path), startCommit: repo.baseCommit, candidateTreeSha: before[i]!.treeSha })),
      candidateDigest: "a".repeat(64), rootPath: f.root, signal, budgetMs: 120_000 });
    expect(round.entries[0]?.after).toBe("passed");
    expect(proof.items[0]?.verdict).toBe("proves_change");
    expect(proof.items[0]?.granularity).toBe("test");
    expect(await readFile(join(runners.reportRoot!(), "app/report.json"))).toEqual(candidateReport);
    expect(paths).toHaveLength(2);
    expect(paths.every((path) => path.includes(".agentx-check-"))).toBe(true);
    expect(await f.identity()).toEqual(before);
  });

  it("runs setup in the copy before checks and cleans a failed setup", async () => {
    const f = await fixture();
    f.input.setup = [command("require('fs').writeFileSync('ready.txt',process.cwd()); process.exit(3)")];
    const round = await f.run([command("throw new Error('must not run')")]);
    expect(round.entries[0]).toMatchObject({ after: "not_run", output: "AgentX did not run this check: multi-repository setup failed." });
    expect(await readdir(f.root)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^\.agentx-check-/u)]));
    await expect(stat(join(f.root, "app/ready.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["wrong branch", "dirty base", "duplicate", "outside"])("refuses %s before any command", async (kind) => {
    const f = await fixture();
    if (kind === "wrong branch") f.input.repositories = f.input.repositories.map((r) => ({ ...r, ...(r.repositoryId === "app" ? { taskBranch: "refs/heads/main" } : {}) }));
    if (kind === "dirty base") await put(f.root, "lib/code.cjs", "changed base");
    if (kind === "duplicate") f.input.repositories = [...f.input.repositories, f.input.repositories[0]!];
    if (kind === "outside") f.input.repositories = [{ ...f.input.repositories[0]!, path: "../outside" }, f.input.repositories[1]!];
    let ran = false;
    const base = createCheckRunners({ rootPath: f.root, local: true });
    await expect(runChecks({ source: "project", readiness: [command("console.log('unexpected')")] }, withMultiRepoChecks(f.input, { ...base, runProjectCommand: async () => { ran = true; return { exitCode: 0, timedOut: false, stdout: "", stderr: "" }; } }), { signal: new AbortController().signal, budgetMs: 30_000 })).rejects.toThrow(kind === "duplicate" ? "paths must be distinct" : undefined);
    expect(ran).toBe(false);
    expect((await readdir(f.root)).filter((name) => name.startsWith(".agentx-check-"))).toEqual([]);
  });

  it("remaps internal absolute symlinks and copies files and indexes without inode aliases", async () => {
    const f = await fixture();
    await symlink(join(f.root, "app/code.cjs"), join(f.root, "app/alias.cjs"));
    const original = await stat(join(f.root, "app/code.cjs"));
    const index = await stat(join(f.root, "app/.git/index"));
    const check = command("const fs=require('fs'); const id=p=>{const s=fs.statSync(p);return [s.dev,s.ino]}; console.log(JSON.stringify({file:id('code.cjs'),index:id('.git/index'),link:fs.realpathSync.native('alias.cjs')}));");
    const round = await f.run([check]);
    expect(round.entries[0]?.after).toBe("passed");
    const found = JSON.parse(round.entries[0]!.output) as { file: number[]; index: number[]; link: string };
    expect(found.file).not.toEqual([original.dev, original.ino]); expect(found.index).not.toEqual([index.dev, index.ino]);
    expect(found.link).toContain(".agentx-check-");
  });

  it("refuses an external symlink before setup and removes the partially created root", async () => {
    const f = await fixture();
    await put(f.root, "outside.txt", "outside");
    await symlink(join(f.root, "outside.txt"), join(f.root, "app/escape"));
    await expect(f.run([command("console.log('must not run')")])).rejects.toThrow(/link/u);
    expect((await readdir(f.root)).filter((name) => name.startsWith(".agentx-check-"))).toEqual([]);
  });

  it("refuses non-wiring source drift in the tested copy", async () => {
    const f = await fixture();
    await expect(f.run([command("require('fs').writeFileSync('code.cjs','modified by check')")])).rejects.toThrow(/changed.*source/u);
    expect(await readFile(join(f.root, "app/code.cjs"), "utf8")).toContain("dirty candidate");
  });

  it("refuses setup that changes the candidate source before the check", async () => {
    const f = await fixture();
    f.input.setup = [command("require('fs').writeFileSync('code.cjs','setup replaced candidate')")];
    await expect(f.run([command("console.log('passed')")])).rejects.toThrow(/changed.*source/u);
  });

  it("prepares after service startup and stops setup failures before executing a check", async () => {
    const f = await fixture();
    f.input.setup = [command("console.log('setup')")];
    const order: string[] = [];
    const base = createCheckRunners({ rootPath: f.root, local: true });
    const runners = withMultiRepoChecks(f.input, { ...base, freshServices: async () => { order.push("services"); }, endRound: async () => { order.push("stop"); }, runProjectCommand: async (cmd, signal) => { order.push(cmd.args[1] === "console.log('setup')" ? "setup" : "check"); return base.runProjectCommand(cmd, signal); } });
    await runChecks({ source: "project", readiness: [command("console.log('check')")] }, runners, { signal: new AbortController().signal, budgetMs: 30_000 });
    expect(order).toEqual(["services", "setup", "check", "stop"]);
  });

  it("rejects malformed wiring and unsafe replay without executing arbitrary code", async () => {
    const f = await fixture({ "package.json": '{"name":"../outside"}' });
    f.input.dependencies = [{ consumer: "app", provider: "lib", language: "node" }];
    await expect(f.run([command("console.log('no')")])).rejects.toThrow(/package name/u);
    f.input.dependencies = [{ consumer: "app", provider: "missing", language: "node" }];
    await expect(f.run([command("console.log('no')")])).rejects.toThrow(/no repository/u);
    f.input.dependencies = [];
    const round = await runChecks({ source: "agent_commands", agentRuns: [{ command: "touch owned", replay: "touch owned", order: 0, exitCode: 0, afterFirstEdit: true, output: "" }] }, f.runners(), { signal: new AbortController().signal, budgetMs: 30_000 });
    expect(round.entries[0]?.after).toBe("not_run");
    await expect(stat(join(f.root, "owned"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a non-branch selection and gives cancellation priority over reading it", async () => {
    const f = await fixture();
    f.input.repositories = f.input.repositories.map((r) => r.repositoryId === "app" ? { ...r, taskBranch: "HEAD" } : r);
    await expect(f.run([command("console.log('no')")])).rejects.toThrow("task branch is invalid");
    const stop = new AbortController(); stop.abort();
    await expect(f.run([command("console.log('no')")], stop.signal)).rejects.toThrow("aborted");
  });

  it("refuses a check cwd outside the copy without touching original files", async () => {
    const f = await fixture();
    const round = await f.run([command("require('fs').writeFileSync('escaped.txt','bad')", "../app")]);
    expect(round.entries[0]?.after).toBe("failed");
    await expect(stat(join(f.root, "app/escaped.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not copy a declared report over Git state", async () => {
    const f = await fixture();
    const check = command("require('fs').writeFileSync('.git/info/report.json','{}')");
    check.args.push("--", "--outputFile=.git/info/report.json", "--reporter=json");
    await expect(f.run([check])).rejects.toThrow("report names worker or Git state");
    await expect(stat(join(f.root, "app/.git/info/report.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves an unconfirmed stop to quarantine instead of deleting beneath a late writer", async () => {
    const f = await fixture();
    let execution = "";
    const base = createCheckRunners({ rootPath: f.root, local: true });
    const runners = withMultiRepoChecks(f.input, { ...base, runProjectCommand: async (cmd) => { execution = join(f.root, cmd.cwd); throw new RunnerKillUnconfirmedError({ kind: "local" }); } });
    await expect(runChecks({ source: "project", readiness: [command("console.log('no')")] }, runners, { signal: new AbortController().signal, budgetMs: 30_000 })).rejects.toBeInstanceOf(RunnerKillUnconfirmedError);
    expect((await stat(execution)).isDirectory()).toBe(true);
    expect((await f.run([command("console.log('next round')")])).entries[0]?.after).toBe("passed");
    expect((await stat(execution)).isDirectory()).toBe(true);
  });

  it("does not discard the copy when the execution target cannot close its round", async () => {
    const f = await fixture();
    let execution = "";
    const base = createCheckRunners({ rootPath: f.root, local: true });
    const runners = withMultiRepoChecks(f.input, { ...base, runProjectCommand: async (cmd, signal) => { execution = join(f.root, cmd.cwd); return base.runProjectCommand(cmd, signal); }, endRound: async () => { throw new Error("container removal failed"); } });
    await expect(runChecks({ source: "project", readiness: [command("console.log('pass')")] }, runners, { signal: new AbortController().signal, budgetMs: 30_000 })).rejects.toBeInstanceOf(RunnerKillUnconfirmedError);
    expect((await stat(execution)).isDirectory()).toBe(true);
  });

  it("makes unsupported-language text inert and bounds a megabyte input", async () => {
    const f = await fixture();
    const bad = ['[a [b]](https://example.test)', '![x](https://example.test/i)', '[x][ref]', '@all #123 <b>hi</b>', '# > --- ``` ~~~\u200b\ufe0f', 'x'.repeat(1_000_000)];
    f.input.dependencies = bad.map((language) => ({ consumer: "app", provider: "lib", language }));
    const round = await f.run([command("console.log('ran')")]);
    const output = round.entries[0]!.output;
    expect(output).not.toMatch(/@all|#123|<b>|\u200b|\ufe0f|!\[|\]\(/u);
    expect(output.length).toBeLessThan(1_500);
    expect(round.entries[0]?.after).toBe("passed");
  });

  it("rejects malformed Go module names and conflicting Maven reactor flags", async () => {
    const f = await fixture({ "go.mod": "module bad=module\n", "pom.xml": "<project/>" });
    f.input.dependencies = [{ consumer: "app", provider: "lib", language: "go" }];
    await expect(f.run([command("console.log('no')")])).rejects.toThrow("Go module is invalid");
    f.input.dependencies = [{ consumer: "app", provider: "lib", language: "maven" }];
    const base = createCheckRunners({ rootPath: f.root, local: true });
    let calls = 0;
    const runners = withMultiRepoChecks(f.input, { ...base, runProjectCommand: async () => { calls++; return { exitCode: 0, timedOut: false, stdout: "", stderr: "" }; } });
    const round = await runChecks({ source: "project", readiness: [{ executable: "mvn", args: ["-f", "own.xml", "test"], cwd: "app", timeoutSeconds: 20 }] }, runners, { signal: new AbortController().signal, budgetMs: 30_000 });
    expect(round.entries[0]?.after).toBe("failed"); expect(calls).toBe(0);
  });

  it("applies Maven and Python wiring to agent command replays as well as project checks", async () => {
    const f = await fixture({ "pom.xml": "<project/>" });
    f.input.dependencies = [{ consumer: "app", provider: "lib", language: "maven" }, { consumer: "app", provider: "lib", language: "python" }];
    const calls: ProjectCommand[] = [];
    const base = createCheckRunners({ rootPath: f.root, local: true });
    const runners = withMultiRepoChecks(f.input, { ...base, runProjectCommand: async (cmd) => { calls.push(cmd); return { exitCode: 0, timedOut: false, stdout: "ran\n", stderr: "" }; }, runAgentCommand: async () => ({ exitCode: 0, timedOut: false, output: "unwired\n" }) });
    const replay = "cd app && mvn test";
    const round = await runChecks({ source: "agent_commands", agentRuns: [{ command: replay, replay, order: 0, exitCode: 0, afterFirstEdit: true, output: "" }] }, runners, { signal: new AbortController().signal, budgetMs: 30_000 });
    expect(round.entries[0]?.output).toBe("ran\n");
    expect(calls.at(-1)).toMatchObject({ executable: "mvn", args: ["-f", "../pom.xml", "--projects", "app", "--also-make", "test"], env: { PYTHONPATH: "../.agentx-python" } });
    expect(calls.at(-1)?.cwd).toContain(".agentx-check-");
    for (const executable of ["/opt/tools/mvn", "mvnw"]) {
      const project = await runChecks({ source: "project", readiness: [{ executable, args: ["test"], cwd: "app", timeoutSeconds: 20 }] }, runners, { signal: new AbortController().signal, budgetMs: 30_000 });
      expect(project.entries[0]?.after).toBe("passed");
      expect(calls.at(-1)).toMatchObject({ executable, args: ["-f", "../pom.xml", "--projects", "app", "--also-make", "test"] });
    }
  });

  it("forwards reports without touching original symlinks", async () => {
    const f = await fixture();
    await put(f.root, "sentinel.txt", "untouched");
    await symlink(join(f.root, "sentinel.txt"), join(f.root, "app/report.json"));
    const check = command("require('fs').writeFileSync('report.json','{}')");
    check.args.push("--", "--outputFile=report.json", "--reporter=json");
    expect((await f.run([check])).entries[0]?.after).toBe("passed");
    expect(await readFile(join(f.reports(), "app/report.json"), "utf8")).toBe("{}");
    expect(await readFile(join(f.root, "sentinel.txt"), "utf8")).toBe("untouched");
  });

  it("copies reports from new output directories before cleanup", async () => {
    const f = await fixture();
    const check = command("require('fs').mkdirSync('out'); require('fs').writeFileSync('out/report.json','{}')");
    check.args.push("--", "--outputFile=out/report.json", "--reporter=json");
    expect((await f.run([check])).entries[0]?.after).toBe("passed");
    expect(await readFile(join(f.reports(), "app/out/report.json"), "utf8")).toBe("{}");
  });

  it("leaves a stale original report and identity unchanged when the round produced none", async () => {
    const f = await fixture();
    await put(f.root, "app/report.json", '{"stale":true}');
    const before = await f.identity();
    const original = await readFile(join(f.root, "app/report.json")).catch(() => undefined);
    const check = command("console.log('no report')");
    check.args.push("--", "--outputFile=report.json", "--reporter=json");
    expect((await f.run([check])).entries[0]?.after).toBe("passed");
    expect(await readFile(join(f.root, "app/report.json")).catch(() => undefined)).toEqual(original);
    expect(await f.identity()).toEqual(before);
  });

  it.each(["tracked", "setup", "failed setup"])("does not forward a %s report that the check did not produce", async (origin) => {
    const f = await fixture();
    if (origin === "tracked") {
      await put(f.root, "app/report.json", '{"stale":true}');
      git(join(f.root, "app"), "add", "-f", "report.json"); git(join(f.root, "app"), "commit", "-qm", "tracked report");
    } else f.input.setup = [command(`require('fs').writeFileSync('report.json','{}'); process.exit(${origin === "failed setup" ? 1 : 0})`)];
    const before = await f.identity();
    const original = await readFile(join(f.root, "app/report.json")).catch(() => undefined);
    const check = command("console.log('no report')");
    check.args.push("--", "--outputFile=report.json", "--reporter=json");
    expect((await f.run([check])).entries[0]?.after).toBe(origin === "failed setup" ? "not_run" : "passed");
    expect(await readFile(join(f.root, "app/report.json")).catch(() => undefined)).toEqual(original);
    expect(await f.identity()).toEqual(before);
  });

  it("does not say tested separately when setup prevented every check", async () => {
    const f = await fixture();
    f.input.dependencies = [{ consumer: "app", provider: "lib", language: "rust" }];
    f.input.setup = [command("process.exit(1)")];
    const round = await f.run([command("console.log('no')")]);
    expect(round.entries[0]?.after).toBe("not_run");
    expect(round.entries[0]?.output).not.toContain("tested separately");
  });

  it("accepts the report byte limit and refuses an oversized report without forwarding it", async () => {
    const f = await fixture();
    const report = (bytes: number) => {
      const check = command(`require('fs').writeFileSync('report.json',' '.repeat(${bytes}))`);
      check.args.push("--", "--outputFile=report.json", "--reporter=json");
      return check;
    };
    expect((await f.run([report(16 * 1024 * 1024)])).entries[0]?.after).toBe("passed");
    expect((await stat(join(f.reports(), "app/report.json"))).size).toBe(16 * 1024 * 1024);
    await expect(f.run([report(16 * 1024 * 1024 + 1)])).rejects.toEqual(new Error("multi-repository reports exceed round limits"));
    await expect(stat(join(f.reports(), "app/report.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses an old-code selection outside the copied repository set", async () => {
    const f = await fixture();
    const runners = f.runners();
    const original = runners.originalCode!([{ directory: join(f.root, "missing"), commit: f.input.repositories[0]!.baseCommit }]);
    await expect(original.run(() => runChecks({ source: "project", readiness: [command("console.log('no')")] }, runners, { signal: new AbortController().signal, budgetMs: 30_000 }))).rejects.toThrow("original-code selection is incomplete");
    expect((await readdir(f.root)).filter((name) => name.startsWith(".agentx-check-"))).toEqual([]);
  });

  it.each(["settings.gradle", "settings.gradle.kts"])("quotes literal paths in %s without Gradle interpolation", async (file) => {
    const f = await fixture({ [file]: "// settings\n" });
    await rename(join(f.root, "lib"), join(f.root, "lib$literal"));
    f.input.repositories = f.input.repositories.map((repo) => repo.repositoryId === "lib" ? { ...repo, path: "lib$literal" } : repo);
    f.input.dependencies = [{ consumer: "app", provider: "lib", language: "gradle" }];
    const round = await f.run([command(`console.log(require('fs').readFileSync(${JSON.stringify(file)},'utf8'))`)]);
    expect(round.entries[0]?.after).toBe("passed");
    expect(round.entries[0]?.output).toContain('includeBuild("../lib\\$literal")');
  });

  it.each(["go", "gradle", "maven", "python", "rust"])("wires %s within the execution root and preserves identity", async (language) => {
    const f = await fixture({ "go.mod": "module example.test/$NAME\n\ngo 1.20\n", "settings.gradle.kts": 'rootProject.name = "$NAME"\n', "pom.xml": '<project><modelVersion>4.0.0</modelVersion><groupId>example.test</groupId><artifactId>$NAME</artifactId><version>1.0</version></project>', "setup.py": 'from setuptools import setup\nsetup(name="$NAME",version="1.0",py_modules=["code"])\n', "code.py": 'value = "$NAME"\n' });
    f.input.dependencies = [{ consumer: "app", provider: "lib", language }];
    const before = await f.identity();
    const base = createCheckRunners({ rootPath: f.root, local: true });
    const setups: ProjectCommand[] = [];
    const runners = withMultiRepoChecks(f.input, { ...base, async runProjectCommand(cmd, signal) {
      // Go and pip are tool seams: no network or installed toolchain is required by this fixture.
      if (cmd.executable === "go" || cmd.executable === "python3") { setups.push(cmd);
        if (cmd.executable === "go") await writeFile(join(f.root, cmd.cwd, "go.mod"), "module example.test/app\nreplace example.test/lib => ../lib\n");
        return { exitCode: 0, timedOut: false, stdout: "", stderr: "" }; }
      return base.runProjectCommand(cmd, signal);
    } });
    const script = language === "go" ? "console.log(require('fs').readFileSync('go.mod','utf8'))" : language === "gradle" ? "console.log(require('fs').readFileSync('settings.gradle.kts','utf8'))"
      : language === "maven" ? "console.log(require('fs').readFileSync('../pom.xml','utf8'))" : "console.log(process.env.PYTHONPATH || 'ran')";
    const round = await runChecks({ source: "project", readiness: [command(script)] }, runners, { signal: new AbortController().signal, budgetMs: 30_000 });
    expect(round.entries[0]?.after).toBe("passed");
    if (language === "go") { expect(setups[0]?.args).toEqual(["mod", "edit", "-replace=example.test/lib=../lib"]); expect(round.entries[0]?.output).toContain("replace example.test/lib => ../lib"); }
    if (language === "gradle") expect(round.entries[0]?.output).toContain('includeBuild("../lib")');
    if (language === "maven") expect(round.entries[0]?.output).toContain("<module>lib</module>");
    if (language === "python") {
      expect(setups[0]?.args).toEqual(["-m", "pip", "install", "--no-index", "--no-deps", "--no-build-isolation", "--target", "../.agentx-python", "../lib"]);
      expect(round.entries[0]?.output).toContain("../.agentx-python");
    }
    if (language === "rust") expect(round.entries[0]?.output).toContain("tested separately: no cross-repo wiring for rust");
    expect(await f.identity()).toEqual(before);
  });
  it.each(["install", "ci"])("supports npm %s with committed locks and links after setup", async (mode) => {
    const f = await fixture({
      "package.json": '{"name":"$NAME","version":"1.0.0","main":"code.cjs"}',
      "package-lock.json": '{"name":"$NAME","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"$NAME","version":"1.0.0"}}}',
    });
    f.input.dependencies = [{ consumer: "app", provider: "lib", language: "node" }];
    f.input.setup = [{ executable: "npm", args: [mode, "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], cwd: "app", timeoutSeconds: 20, env: { npm_config_cache: ".agentx-npm-cache" } }];
    const before = await f.identity();
    expect((await f.run([command("console.log(require('lib'))")])).entries[0]).toMatchObject({ after: "passed", output: "base\n" });
    expect(await f.identity()).toEqual(before);
  });

  it.each(["node", "go"])("allows setup lock and manifest changes for wired %s copies only", async (language) => {
    const f = await fixture({ "package.json": '{"name":"$NAME","main":"code.cjs"}', "go.mod": "module example.test/$NAME\n" });
    f.input.dependencies = [{ consumer: "app", provider: "lib", language }];
    const files = language === "node" ? ["package.json", "package-lock.json"] : ["go.mod", "go.sum"];
    f.input.setup = [command(`for (const p of ${JSON.stringify(files)}) require('fs').appendFileSync(p,' ');`)];
    const before = await f.identity();
    const base = createCheckRunners({ rootPath: f.root, local: true });
    const runners = withMultiRepoChecks(f.input, { ...base, runProjectCommand: (cmd, signal) => cmd.executable === "go" ? Promise.resolve({ exitCode: 0, timedOut: false, stdout: "", stderr: "" }) : base.runProjectCommand(cmd, signal) });
    expect((await runChecks({ source: "project", readiness: [command("console.log('ran')")] }, runners, { signal: new AbortController().signal, budgetMs: 30_000 })).entries[0]?.after).toBe("passed");
    expect(await f.identity()).toEqual(before);
  });

  it("refuses a dangling link with fixed words and no path leak", async () => {
    const f = await fixture();
    await symlink("private-missing-name", join(f.root, "app/dangling"));
    await expect(f.run([command("console.log('no')")])).rejects.toEqual(new Error("multi-repository link target is unavailable"));
  });

  it("charges setup to one total budget and joins its stop", async () => {
    const f = await fixture();
    f.input.setup = [command("setTimeout(()=>{},3000)")];
    const began = Date.now();
    const result = await runChecks({ source: "project", readiness: [command("console.log('no')")] }, f.runners(), { signal: new AbortController().signal, budgetMs: 1_000 });
    expect(Date.now() - began).toBeLessThan(2_800);
    expect(result.entries[0]).toMatchObject({ after: "not_run", output: "AgentX did not run this check: the time budget for checks ran out." });
    expect((await readdir(f.root)).filter((name) => name.startsWith(".agentx-check-"))).toEqual([]);
  });

  it("charges copy time before starting checks", async () => {
    const f = await fixture();
    const copy = partCopies.createPartWorkingCopy;
    vi.spyOn(partCopies, "createPartWorkingCopy").mockImplementation(async (input) => { await new Promise((resolve) => setTimeout(resolve, 1_700)); return copy(input); });
    const result = await runChecks({ source: "project", readiness: [command("console.log('no')")] }, f.runners(), { signal: new AbortController().signal, budgetMs: 1_500 });
    expect(result.entries[0]).toMatchObject({ after: "not_run", output: "AgentX did not run this check: the time budget for checks ran out." });
    expect((await readdir(f.root)).filter((name) => name.startsWith(".agentx-check-"))).toEqual([]);
  });

  it("handles old code without a newly added Node manifest", async () => {
    const f = await fixture();
    await put(f.root, "app/package.json", '{"name":"app"}');
    await put(f.root, "lib/package.json", '{"name":"lib"}');
    f.input.repositories = f.input.repositories.map((repo) => ({ ...repo, taskBranch: repo.repositoryId === "app" ? "refs/heads/task/r1" : "refs/heads/main" }));
    f.input.dependencies = [{ consumer: "app", provider: "lib", language: "node" }];
    const runners = f.runners();
    const result = await runners.originalCode!(f.input.repositories.map((repo) => ({ directory: join(f.root, repo.path), commit: repo.baseCommit }))).run(() => runChecks({ source: "project", readiness: [command("console.log('base')")] }, runners, { signal: new AbortController().signal, budgetMs: 30_000 }));
    expect(result.entries[0]).toMatchObject({ after: "passed", output: "tested separately: dependency manifest unavailable on original code\nbase\n" });
  });

  it("sweeps leftover roots without following root or nested links", async () => {
    const f = await fixture();
    await put(f.root, ".agentx-check-stale/nested/junk", "old");
    await symlink(join(f.root, "app"), join(f.root, ".agentx-check-link"));
    await symlink(join(f.root, "lib"), join(f.root, ".agentx-check-stale/nested/link"));
    const before = await f.identity();
    expect((await f.run([command("console.log('ok')")])).entries[0]?.after).toBe("passed");
    expect((await readdir(f.root)).filter((name) => name.startsWith(".agentx-check-"))).toEqual([]);
    expect(await f.identity()).toEqual(before);
  });

  it("reports Maven subfolder wiring as unsupported before executing it", async () => {
    const f = await fixture({ "pom.xml": "<project/>", "service/pom.xml": "<project/>" });
    f.input.dependencies = [{ consumer: "app", provider: "lib", language: "maven" }];
    let called = false;
    const base = createCheckRunners({ rootPath: f.root, local: true });
    const runners = withMultiRepoChecks(f.input, { ...base, runProjectCommand: async () => { called = true; return { exitCode: 0, timedOut: false, stdout: "ran", stderr: "" }; } });
    const result = await runChecks({ source: "project", readiness: [{ executable: "mvn", args: ["test"], cwd: "app/service", timeoutSeconds: 20 }] }, runners, { signal: new AbortController().signal, budgetMs: 30_000 });
    expect(result.entries[0]).toMatchObject({ after: "not_run", output: "multi-repository Maven subfolder wiring is unsupported" });
    expect(called).toBe(false);
  });

  it("lexical link guard refuses an outside alias that resolves back inside", async () => {
    const f = await fixture();
    const alias = join(f.root, "outside-alias");
    await symlink(alias, join(f.root, "app/escape"));
    const copy = partCopies.createPartWorkingCopy;
    vi.spyOn(partCopies, "createPartWorkingCopy").mockImplementation(async (input) => {
      const made = await copy(input);
      if (input.repositoryId === "repo-0") await symlink(join(input.rootPath, "app/code.cjs"), alias);
      return made;
    });
    await expect(f.run([command("console.log('must not run')")])).rejects.toEqual(new Error("multi-repository link leaves the check root"));
  });

  it("resolved link guard refuses an inside alias through unchecked Git metadata", async () => {
    const f = await fixture();
    await put(f.root, "outside.txt", "private");
    await symlink(".git/escape", join(f.root, "app/escape"));
    const copy = partCopies.createPartWorkingCopy;
    vi.spyOn(partCopies, "createPartWorkingCopy").mockImplementation(async (input) => {
      const made = await copy(input);
      if (input.repositoryId === "repo-0") await symlink(join(f.root, "outside.txt"), join(made.directory, ".git/escape"));
      return made;
    });
    await expect(f.run([command("console.log('must not run')")])).rejects.toEqual(new Error("multi-repository link leaves the check root"));
  });

  it("fresh report copy-out never replaces an original tracked artifact", async () => {
    const f = await fixture();
    await put(f.root, "app/report.json", "customer report");
    git(join(f.root, "app"), "add", "-f", "report.json"); git(join(f.root, "app"), "commit", "-qm", "report");
    const before = await f.identity();
    const original = await stat(join(f.root, "app/report.json"));
    const check = command("require('fs').writeFileSync('report.json','fresh report')");
    check.args.push("--", "--outputFile=report.json", "--reporter=json");
    expect((await f.run([check])).entries[0]?.after).toBe("passed");
    expect(await readFile(join(f.root, "app/report.json"), "utf8")).toBe("customer report");
    expect(await stat(join(f.root, "app/report.json"))).toEqual(original);
    expect(await f.identity()).toEqual(before);
    expect(await readFile(join(f.reports(), "app/report.json"), "utf8")).toBe("fresh report");
  });

  it("accepts 64 setup items and refuses a combined setup and edge overflow", async () => {
    const f = await fixture();
    const base = createCheckRunners({ rootPath: f.root, local: true });
    let calls = 0;
    const runners = withMultiRepoChecks(f.input, { ...base, runProjectCommand: async () => { calls++; return { exitCode: 0, timedOut: false, stdout: "ok", stderr: "" }; } });
    f.input.setup = Array.from({ length: 64 }, () => command("setup"));
    expect((await runChecks({ source: "project", readiness: [command("check")] }, runners, { signal: new AbortController().signal, budgetMs: 30_000 })).entries[0]?.after).toBe("passed");
    expect(calls).toBe(65);
    f.input.dependencies = [{ consumer: "app", provider: "lib", language: "rust" }];
    await expect(runChecks({ source: "project", readiness: [command("check")] }, runners, { signal: new AbortController().signal, budgetMs: 30_000 })).rejects.toEqual(new Error("multi-repository input exceeds round limits"));
    expect(calls).toBe(65);
  });

  it.each([null, {}, { consumer: "app", provider: "lib", language: 42 }])("refuses malformed edge %j with fixed words", async (edge) => {
    const f = await fixture();
    f.input.dependencies = [edge] as unknown as MultiRepoChecks["dependencies"];
    await expect(f.run([command("console.log('no')")])).rejects.toEqual(new Error("multi-repository input is invalid"));
  });

  it("bounds a large leftover sweep with a fixed refusal", async () => {
    const f = await fixture();
    await Promise.all(Array.from({ length: 64 }, (_, i) => mkdir(join(f.root, `.agentx-check-stale-${i}`))));
    expect((await f.run([command("console.log('ok')")])).entries[0]?.after).toBe("passed");
    await Promise.all(Array.from({ length: 65 }, (_, i) => mkdir(join(f.root, `.agentx-check-stale-${i}`))));
    const began = Date.now();
    await expect(f.run([command("console.log('no')")])).rejects.toEqual(new Error("multi-repository leftover sweep limit exceeded"));
    expect(Date.now() - began).toBeLessThan(5_000);
  });

  it("reads worker-owned test and coverage reports without relocating source identities", async () => {
    const f = await fixture();
    const started = Date.now();
    const check = command(`require('fs').writeFileSync('report.json',JSON.stringify({testResults:[{name:'change.test.cjs',assertionResults:[{fullName:'works',status:'passed'}]}]})); require('fs').writeFileSync('coverage.lcov','SF:code.cjs\\nDA:1,1\\nend_of_record\\n');`);
    check.args.push("--", "--outputFile=report.json", "--reporter=json");
    f.input.coveragePaths = ["coverage.lcov"];
    const round = await f.run([check]);
    const raw = await collectEvidenceRaw({ rootPath: f.root, reportRootPath: f.reports(), commands: [check], entries: round.entries, candidateDigest: "a".repeat(64), repositories: [] });
    expect(raw?.checks[0]?.tests).toMatchObject({ total: 1, passed: 1 });
    const artifacts: string[] = [];
    expect(await saveEvidenceRaw({ sink: async (artifact) => { artifacts.push(artifact.content); }, rootPath: f.root, plan: { source: "project", readiness: [check] }, entries: round.entries,
      repositories: f.input.repositories.map((repo) => ({ repositoryId: repo.repositoryId, directory: join(f.root, repo.path), baseCommitSha: repo.baseCommit })), candidateBefore: await f.identity(), roundStartedAtMs: started,
      baseline: { runners: f.runners(), signal: new AbortController().signal, budgetMs: 120_000 } })).toBe(true);
    expect(artifacts.join("")).toContain('"passed":1');
    const coverage = await readChangedCoverage({ rootPath: f.root, reportRootPath: f.reports(), command: check, approvedPath: "coverage.lcov", notBeforeMs: started, used: new Set(), repositories: async () => [] });
    expect(coverage).toHaveProperty("coverage");
    await expect(stat(join(f.root, "app/report.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([".agentx", ".agentx/multi-repo-reports"])("refuses a report storage link at %s without altering original files", async (link) => {
    const f = await fixture();
    if (link !== ".agentx") await mkdir(join(f.root, ".agentx"));
    await symlink(join(f.root, "app"), join(f.root, link));
    const before = await f.identity();
    const check = command("require('fs').writeFileSync('report.json','{}')");
    check.args.push("--", "--outputFile=report.json", "--reporter=json");
    await expect(f.run([check])).rejects.toEqual(new Error("multi-repository report location is unavailable"));
    expect(await f.identity()).toEqual(before);
  });

  it("refuses a setup-created node_modules link with fixed words", async () => {
    const f = await fixture({ "package.json": '{"name":"$NAME","main":"code.cjs"}' });
    f.input.dependencies = [{ consumer: "app", provider: "lib", language: "node" }];
    f.input.setup = [command(`require('fs').symlinkSync(${JSON.stringify(join(f.root, "lib"))},'node_modules','dir')`)];
    const before = await f.identity();
    const round = await f.run([command("console.log(require('lib'))")]);
    expect(round.entries[0]).toMatchObject({ after: "not_run", output: "AgentX did not run this check: multi-repository setup failed." });
    expect(await readdir(join(f.root, "lib"))).not.toContain("lib");
    expect(await f.identity()).toEqual(before);
  });

  it("bounds total checkout bytes across repositories before copying the excess", async () => {
    const f = await fixture();
    const isolated = isolatedCopies.withIsolatedGit;
    let size = 256 * 1024 * 1024;
    vi.spyOn(isolatedCopies, "withIsolatedGit").mockImplementation((directory, mode, work) => isolated(directory, mode, (git) => work({ ...git, text: (args, options) => args[0] === "ls-tree" && args.includes("-l") ? Promise.resolve(`100644 blob ${"a".repeat(40)} ${size}\tcode.cjs\0`) : git.text(args, options) })));
    expect((await f.run([command("console.log('ok')")])).entries[0]?.after).toBe("passed");
    size++;
    await expect(f.run([command("console.log('no')")])).rejects.toEqual(new Error("multi-repository checkout exceeds round limits"));
  });

  it("bounds total report bytes and never forwards a partial batch", async () => {
    const f = await fixture();
    const report = (path: string, size: number) => {
      const check = command(`require('fs').writeFileSync(${JSON.stringify(path)},' '.repeat(${size}))`);
      check.args.push("--", `--outputFile=${path}`, "--reporter=json");
      return check;
    };
    expect((await f.run([report("one.json", 8 * 1024 * 1024), report("two.json", 8 * 1024 * 1024)])).entries.every((entry) => entry.after === "passed")).toBe(true);
    expect((await stat(join(f.reports(), "app/two.json"))).size).toBe(8 * 1024 * 1024);
    await expect(f.run([report("one.json", 8 * 1024 * 1024), report("two.json", 8 * 1024 * 1024 + 1)])).rejects.toEqual(new Error("multi-repository reports exceed round limits"));
    await expect(stat(join(f.reports(), "app/one.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cuts setup command timeouts to the total remaining budget", async () => {
    const f = await fixture();
    f.input.setup = [command("setup")];
    let timeout = 0;
    const base = createCheckRunners({ rootPath: f.root, local: true });
    const runners = withMultiRepoChecks(f.input, { ...base, runProjectCommand: async (cmd) => { if (cmd.args[1] === "setup") timeout = cmd.timeoutSeconds; return { exitCode: 0, timedOut: false, stdout: "", stderr: "" }; } });
    await runChecks({ source: "project", readiness: [command("check")] }, runners, { signal: new AbortController().signal, budgetMs: 2_000 });
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThan(2);
  });

  it("aborts setup at the deadline even when a runner ignores its timeout argument", async () => {
    const f = await fixture();
    f.input.setup = [command("setup")];
    const base = createCheckRunners({ rootPath: f.root, local: true });
    let aborted = false;
    const runners = withMultiRepoChecks(f.input, { ...base, runProjectCommand: async (_cmd, signal) => {
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 2_000); signal.addEventListener("abort", () => { aborted = true; clearTimeout(timer); resolve(); }, { once: true }); });
      return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
    } });
    const began = Date.now();
    const round = await runChecks({ source: "project", readiness: [command("check")] }, runners, { signal: new AbortController().signal, budgetMs: 1_000 });
    expect(aborted).toBe(true);
    expect(Date.now() - began).toBeLessThan(2_500);
    expect(round.entries[0]?.output).toBe("AgentX did not run this check: the time budget for checks ran out.");
  });

  it("refuses an oversized injection before touching repositories", async () => {
    const f = await fixture();
    f.input.dependencies = [{ consumer: "app", provider: "lib", language: "x".repeat(2 * 1024 * 1024 + 1) }];
    await expect(f.run([command("console.log('no')")])).rejects.toEqual(new Error("multi-repository input exceeds round limits"));
  });

  it.each(["malformed", "oversized"])("refuses a %s dependency manifest with fixed words", async (kind) => {
    const manifest = kind === "malformed" ? '{"name":"private-name",bad' : JSON.stringify({ name: "$NAME", extra: "x".repeat(2 * 1024 * 1024) });
    const f = await fixture({ "package.json": manifest });
    f.input.dependencies = [{ consumer: "app", provider: "lib", language: "node" }];
    await expect(f.run([command("console.log('no')")])).rejects.toEqual(new Error("multi-repository dependency manifest is unavailable"));
  });

  it.each([".agentx", ".agentx-check-customer"])("refuses a repository in reserved worker path %s before sweeping it", async (path) => {
    const f = await fixture();
    await rename(join(f.root, "app"), join(f.root, path));
    f.input.repositories = f.input.repositories.map((repo) => repo.repositoryId === "app" ? { ...repo, path } : repo);
    const original = await readFile(join(f.root, path, "code.cjs"));
    await expect(f.run([command("console.log('no')", path)])).rejects.toEqual(new Error("multi-repository repository path uses worker state"));
    expect(await readFile(join(f.root, path, "code.cjs"))).toEqual(original);
  });

  it.each(["entries", "depth"])("bounds leftover %s across the entire sweep", async (kind) => {
    const f = await fixture();
    const root = join(f.root, ".agentx-check-stale");
    await mkdir(root);
    if (kind === "depth") await mkdir(join(root, ...Array.from({ length: 66 }, () => "d")), { recursive: true });
    else for (let offset = 0; offset < 8_448; offset += 256) await Promise.all(Array.from({ length: 256 }, (_, index) => writeFile(join(root, `f-${offset + index}`), "")));
    const began = Date.now();
    await expect(f.run([command("console.log('no')")])).rejects.toEqual(new Error("multi-repository leftover sweep limit exceeded"));
    expect(Date.now() - began).toBeLessThan(5_000);
  });

  it("refuses an unreadable leftover sweep with a fixed reason", async () => {
    const f = await fixture();
    vi.mocked(fileSystem.opendir).mockRejectedValueOnce(new Error("private-customer-path"));
    await expect(f.run([command("console.log('no')")])).rejects.toEqual(new Error("multi-repository leftover sweep is unavailable"));
  });

  it("bounds total checkout file count across repositories", async () => {
    const f = await fixture();
    const isolated = isolatedCopies.withIsolatedGit;
    let count = 25_000;
    vi.spyOn(isolatedCopies, "withIsolatedGit").mockImplementation((directory, mode, work) => isolated(directory, mode, (git) => work({ ...git, text: (args, options) => args[0] === "ls-tree" && args.includes("-l") ? Promise.resolve(Array.from({ length: count }, (_, i) => `100644 blob ${"a".repeat(40)} 0\tf-${i}\0`).join("")) : git.text(args, options) })));
    expect((await f.run([command("console.log('ok')")])).entries[0]?.after).toBe("passed");
    count++;
    await expect(f.run([command("console.log('no')")])).rejects.toEqual(new Error("multi-repository checkout exceeds round limits"));
  });

  it("bounds total manifest bytes across edges and caches shared manifests", async () => {
    const empty = JSON.stringify({ name: "$NAME", main: "code.cjs", pad: "" });
    // $NAME becomes three bytes: each manifest is exactly one MiB.
    const manifest = JSON.stringify({ name: "$NAME", main: "code.cjs", pad: "x".repeat(1024 * 1024 - empty.length + 2) });
    const f = await fixture({ "package.json": manifest });
    f.input.dependencies = Array.from({ length: 63 }, () => ({ consumer: "app", provider: "lib", language: "node" }));
    f.input.dependencies = [...f.input.dependencies, { consumer: "lib", provider: "app", language: "node" }];
    expect((await f.run([command("console.log(require('lib'))")])).entries[0]?.after).toBe("passed");
    await fileSystem.appendFile(join(f.root, "app/package.json"), " ");
    await expect(f.run([command("console.log('no')")])).rejects.toEqual(new Error("multi-repository dependency manifest is unavailable"));
  });

});
