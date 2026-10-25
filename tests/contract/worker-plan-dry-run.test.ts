// T6 PLANDRYRUN: the planning worker tries a coding plan's proposed (model-written) checks on the unchanged code before anyone approves them, and reports a fixed class per check.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PLAN_DRY_RUN_FEATURE, PlanDryRunReportSchema, WORKER_INVOCATION_FEATURES, builtinFileCheckCommand, planDryRunCommandSha256,
  type PlanDryRunReport,
} from "@agentx/contracts";
import type { DockerCli } from "@agentx/verifier";
import { classifyDryRunExit, grepFileOperands, proposedChecksOfPlan, runPlanDryRun, type ProposedCheckToTry } from "../../packages/worker/src/plan-dry-run.js";
import { materializeBaseSource } from "../../packages/worker/src/baseline-source-export.js";
import { WorkerCancellationController, WorkerOperationCancelledError } from "../../packages/worker/src/cancel.js";
import type { WorkerEvent } from "../../packages/worker/src/events.js";
import type { PiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { createApplicationChecksFeatureMonitor } from "../../packages/worker/src/workflow-e2e-application-runtime.js";
import { planDryRunFindings, planDryRunOriginalResults, planDryRunWarnings, readPlanDryRunOutcome, workerTriesProposedChecks } from "../../packages/broker/src/developer/plan-dry-run-results.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

const PASSWORD = "PLANTED-PASSWORD-7f3a91c2";
const REPO_PATH = "orders";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const roots: string[] = [];
const track = <T extends string>(path: T): T => { roots.push(path); return path; };
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

/** A workspace with one git repository `orders` whose base commit holds `src/app.js` with the token, then an UNCOMMITTED edit that removes it (the workspace is not the base). */
function workspace(): { root: string; repo: string; baseSha: string } {
  const root = track(mkdtempSync(join(tmpdir(), "plan-dry-run-")));
  const repo = join(root, REPO_PATH);
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "src/app.js"), "export function exportCsv() {}\n// BASE-TOKEN\n");
  writeFileSync(join(repo, "keep.txt"), "kept\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const baseSha = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "src/app.js"), "export function exportCsv() {}\n// edited in the workspace after the base\n");
  writeFileSync(join(repo, "untracked.txt"), "not in the base\n");
  return { root, repo, baseSha };
}

type Observed = { calls: string[][]; outputs: string[]; sourceDuringRun: string[] };
/**
 * A stand-in for Docker that really runs the entrypoint and arguments of `docker run` on this machine, in the folder the `-v`/`-w` pair names, with ONLY PATH in its environment,
 * and gives back what Docker gives back: the exit code (124 on timeout, 130 on abort, 127 when the program is missing) and the command's output.
 */
function localDocker(repo: { source: () => string | undefined }, observed: Observed): DockerCli {
  return {
    async run(args, opts) {
      observed.calls.push(args);
      if (args[0] !== "run") return { code: 0, stdout: "", stderr: "" };
      const at = args.indexOf("--entrypoint");
      const executable = args[at + 1]!;
      const commandArgs = args.slice(at + 3);
      const mount = args[args.indexOf("-v") + 1]!;
      const source = mount.slice(0, mount.indexOf(`:/work/${REPO_PATH}`));
      observed.sourceDuringRun.push(source);
      const workdir = args[args.indexOf("-w") + 1]!.replace(`/work/${REPO_PATH}`, source);
      return new Promise((resolve) => {
        let out = "";
        let settled = false;
        const finish = (code: number) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code, stdout: out, stderr: "" }); observed.outputs.push(out); };
        const child = spawn(executable, commandArgs, { cwd: workdir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
        child.stderr.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
        const timer = setTimeout(() => { child.kill("SIGKILL"); finish(124); }, opts.timeoutMs);
        const onAbort = () => { child.kill("SIGKILL"); finish(130); };
        if (opts.signal.aborted) onAbort(); else opts.signal.addEventListener("abort", onAbort, { once: true });
        child.once("error", () => finish(127));
        child.once("close", (code) => finish(code ?? 137));
      });
    },
  };
}

const builtin = (kind: "file-contains" | "file-not-contains", path: string, text: string, cwd = REPO_PATH, timeoutSeconds = 30): ProposedCheckToTry => ({ command: { ...builtinFileCheckCommand({ kind, cwd, path, text }), timeoutSeconds } });
/** A Docker whose containers run until their timeout or the abort, as a slow check would. */
const hangingDocker = (observed: Observed): DockerCli => ({
  async run(args, opts) {
    observed.calls.push(args);
    if (args[0] !== "run") return { code: 0, stdout: "", stderr: "" };
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ code: 124, stdout: "", stderr: "" }), opts.timeoutMs);
      opts.signal.addEventListener("abort", () => { clearTimeout(timer); resolve({ code: 130, stdout: "", stderr: "" }); }, { once: true });
    });
  },
});
/** A check that passes on the base (keep.txt is in it), and one that fails there. */
function OK(): ProposedCheckToTry { return program("test", ["-f", "keep.txt"]); }
const program = (executable: string, args: string[], timeoutSeconds = 30, cwd = REPO_PATH): ProposedCheckToTry => ({ command: { cwd, executable, args, timeoutSeconds } });

async function dryRun(checks: ProposedCheckToTry[], options: { signal?: AbortSignal; docker?: (observed: Observed) => DockerCli; totalBudgetMs?: number; config?: boolean; materialize?: Parameters<typeof runPlanDryRun>[0]["materialize"] } = {}) {
  const ws = workspace();
  const observed: Observed = { calls: [], outputs: [], sourceDuringRun: [] };
  const base = track(mkdtempSync(join(tmpdir(), "plan-dry-run-shared-")));
  const config = { executorImage: "executor:test", runRoot: join(base, "candidates", "web-api-runs") };
  const docker = options.docker?.(observed) ?? localDocker({ source: () => undefined }, observed);
  const planText = `a plan ${randomUUID()}`;
  const report = await runPlanDryRun({
    planText, checks, repositoryPath: REPO_PATH, repositories: [{ repositoryId: REPO_PATH, directory: ws.repo, baseCommitSha: ws.baseSha }],
    signal: options.signal ?? new AbortController().signal, docker, ...(options.config === false ? {} : { config }),
    ...(options.totalBudgetMs === undefined ? {} : { totalBudgetMs: options.totalBudgetMs }),
    ...(options.materialize === undefined ? {} : { materialize: options.materialize }),
    ...(options.config === false ? { environment: {} } : {}),
  });
  return { report, observed, ws, planText, base };
}
const classes = (report: PlanDryRunReport) => (report.status === "COMPLETE" ? report.checks.map((entry) => entry.class) : []);

describe("the exit code and the program say what a check result is; the output never does", () => {
  it.each([
    ["grep", 0, "passed"], ["grep", 1, "failed"], ["grep", 2, "broken"], ["sh", 2, "broken"], ["sh", 1, "failed"], ["test", 2, "broken"], ["node", 2, "failed"],
    ["npm", 1, "failed"], ["anything", 126, "broken"], ["anything", 127, "broken"], ["anything", 137, "broken"], ["anything", 139, "broken"], ["anything", 125, "not-run"],
  ] as const)("%s exiting %i is %s", (executable, code, expected) => { expect(classifyDryRunExit(executable, code)).toBe(expected); });
  it("looks at the program's name, not its path", () => { expect(classifyDryRunExit("./tools/grep", 2)).toBe("broken"); });
  it("a built-in file check that exits 2 (its file is not there) failed; it did not break", () => {
    expect(classifyDryRunExit("sh", 2, { builtinFileCheck: true })).toBe("failed");
    expect(classifyDryRunExit("sh", 127, { builtinFileCheck: true })).toBe("broken");
  });
});

describe("a dry run on the unchanged code", () => {
  it("runs on the base commit, not the workspace: a text that is only in the base passes, and a file only in the workspace is not there", async () => {
    const { report, ws } = await dryRun([
      builtin("file-contains", "src/app.js", "BASE-TOKEN"),
      builtin("file-contains", "src/app.js", "edited in the workspace"),
      builtin("file-contains", "untracked.txt", "not in the base"),
      builtin("file-not-contains", "src/app.js", "BASE-TOKEN"),
    ]);
    expect(classes(report)).toEqual(["passed", "failed", "failed", "failed"]);
    // The workspace itself was not touched.
    expect(readFileSync(join(ws.repo, "src/app.js"), "utf8")).toContain("edited in the workspace");
    expect(existsSync(join(ws.repo, "untracked.txt"))).toBe(true);
  });

  it("attributes each result to its own check by the digest of its command, in plan order", async () => {
    const checks = [builtin("file-contains", "src/app.js", "BASE-TOKEN"), builtin("file-not-contains", "src/app.js", "BASE-TOKEN"), program("grep", ["-q", "-E", "(", "keep.txt"])];
    const { report } = await dryRun(checks);
    expect(report.status).toBe("COMPLETE");
    if (report.status !== "COMPLETE") return;
    expect(report.checks.map((entry) => entry.commandSha256)).toEqual(checks.map((check) => planDryRunCommandSha256(check.command)));
    expect(report.checks.map((entry) => entry.class)).toEqual(["passed", "failed", "broken"]);
    expect(PlanDryRunReportSchema.parse(report)).toEqual(report);
  });

  it("calls a command that cannot run broken, not failed: a grep or test usage error", async () => {
    const { report } = await dryRun([program("grep", ["-q", "-E", "(", "keep.txt"]), program("grep", ["-q", "-E", "[", "src/app.js"]), program("test", ["1", "-eq", "x"])]);
    expect(classes(report)).toEqual(["broken", "broken", "broken"]);
  });

  it("a grep on a file the change will create fails on the base (the file is not there yet), without a container; a real usage error on an existing file is still broken", async () => {
    const { report, observed } = await dryRun([
      program("grep", ["-q", "newSymbol", "src/new-file.js"]), program("grep", ["-rq", "-e", "x", "--", "src/app.js", "src/other-new.js"]), program("fgrep", ["-q", "x", "keep.txt", "also-missing.txt"]),
      program("grep", ["-q", "-E", "(", "keep.txt"]), program("grep", ["-q", "BASE-TOKEN", "src/app.js"]),
    ]);
    expect(classes(report)).toEqual(["failed", "failed", "failed", "broken", "passed"]);
    // Only the last two reached a container.
    expect(observed.calls.filter((call) => call[0] === "run")).toHaveLength(2);
    // The built-in file checks say the same for a file that is not there yet: failed, not broken.
    expect(classes((await dryRun([builtin("file-contains", "src/new-file.js", "x"), builtin("file-not-contains", "src/new-file.js", "x")])).report)).toEqual(["failed", "failed"]);
  });

  it("reads a grep's file operands: not the pattern, not the values of options, not stdin", () => {
    expect(grepFileOperands(["-q", "pat", "a.js", "b.js"])).toEqual(["a.js", "b.js"]);
    expect(grepFileOperands(["-e", "pat", "a.js"])).toEqual(["a.js"]);
    expect(grepFileOperands(["-qe", "pat", "a.js"])).toEqual(["a.js"]);
    expect(grepFileOperands(["--regexp=pat", "a.js"])).toEqual(["a.js"]);
    expect(grepFileOperands(["--regexp", "pat", "a.js"])).toEqual(["a.js"]);
    expect(grepFileOperands(["-m", "3", "-A", "2", "pat", "a.js"])).toEqual(["a.js"]);
    expect(grepFileOperands(["-m3", "pat", "a.js"])).toEqual(["a.js"]);
    expect(grepFileOperands(["-q", "--", "-pat", "a.js"])).toEqual(["a.js"]);
    expect(grepFileOperands(["-q", "pat", "-", "a.js"])).toEqual(["a.js"]);
    expect(grepFileOperands(["-q", "pat"])).toEqual([]);
    expect(grepFileOperands(["--include", "*.js", "-r", "pat", "src"])).toEqual(["src"]);
  });

  it("a folder that is not on the unchanged code is a failed check without starting anything", async () => {
    const { report, observed } = await dryRun([program("test", ["-e", "x"], 30, `${REPO_PATH}/new-folder`), OK()]);
    expect(classes(report)).toEqual(["failed", "passed"]);
    expect(observed.calls.filter((call) => call[0] === "run")).toHaveLength(1);
  });

  it("a check that outlives its own timeout is broken within its timeout, and the container is removed by name", async () => {
    const started = Date.now();
    const { report, observed } = await dryRun([program("grep", ["-q", "x", "keep.txt"], 1)], { docker: hangingDocker });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(classes(report)).toEqual(["broken"]);
    const run = observed.calls.find((call) => call[0] === "run")!;
    const name = run[run.indexOf("--name") + 1]!;
    expect(observed.calls).toContainEqual(["rm", "-f", name]);
  });

  it("holds the whole dry run to its total budget: the check the budget stops and every later one is not-run", async () => {
    const started = Date.now();
    const { report } = await dryRun([program("grep", ["-q", "x", "keep.txt"], 600), builtin("file-contains", "src/app.js", "BASE-TOKEN")], { totalBudgetMs: 2_000, docker: hangingDocker });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(classes(report)).toEqual(["not-run", "not-run"]);
  });

  it("never lets what a command prints reach the report (the command did print it)", async () => {
    const handedBack: string[] = [];
    const chatty: DockerCli = { async run(args) { if (args[0] !== "run") return { code: 0, stdout: "", stderr: "" }; handedBack.push(PASSWORD); return { code: 1, stdout: PASSWORD, stderr: PASSWORD }; } };
    const { report } = await dryRun([program("grep", ["-q", "x", "keep.txt"])], { docker: () => chatty });
    // Positive control: Docker did hand the output back to the worker.
    expect(handedBack).toEqual([PASSWORD]);
    expect(classes(report)).toEqual(["failed"]);
    expect(JSON.stringify(report)).not.toContain(PASSWORD);
    expect(JSON.stringify(report)).not.toContain(Buffer.from(PASSWORD).toString("base64"));
    expect(Object.keys((report as { checks: Array<object> }).checks[0]!).sort()).toEqual(["class", "commandSha256", "durationMs"]);
  });

  it("starts every check in a sandbox with no network, no capabilities, a read-only root and source, and none of the worker's environment", async () => {
    process.env.AWS_SECRET_ACCESS_KEY = PASSWORD;
    process.env.AGENTX_CALLBACK_TOKEN = PASSWORD;
    try {
      const { report, observed } = await dryRun([OK()]);
      expect(classes(report)).toEqual(["passed"]);
      const run = observed.calls.find((call) => call[0] === "run")!;
      const flat = run.join("\n");
      expect(flat).not.toContain(PASSWORD);
      expect(run.slice(run.indexOf("--network"), run.indexOf("--network") + 2)).toEqual(["--network", "none"]);
      for (const required of ["--cap-drop=ALL", "--read-only", "--pull=never"]) expect(run).toContain(required);
      expect(run).toContain("no-new-privileges");
      expect(run.slice(run.indexOf("--user"), run.indexOf("--user") + 2)).toEqual(["--user", "1000:1000"]);
      expect(run[run.indexOf("-v") + 1]).toMatch(new RegExp(`:/work/${REPO_PATH}:ro$`));
      expect(run).toEqual(expect.arrayContaining(["--memory", "--pids-limit", "--cpus"]));
      // The only variables set are blanked proxies, HOME and CI.
      const names = run.flatMap((arg, index) => (run[index - 1] === "-e" ? [arg.split("=")[0]!] : []));
      expect(new Set(names)).toEqual(new Set(["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NODE_OPTIONS", "HOME", "CI"]));
      expect(run.some((arg) => arg.startsWith("rovara.run=pdr-"))).toBe(true);
      expect(run).toContain("executor:test");
    } finally {
      delete process.env.AWS_SECRET_ACCESS_KEY;
      delete process.env.AGENTX_CALLBACK_TOKEN;
    }
  });

  it("removes its folder when it is done", async () => {
    const { observed } = await dryRun([OK()]);
    expect(observed.sourceDuringRun).toHaveLength(1);
    expect(existsSync(observed.sourceDuringRun[0]!)).toBe(false);
  });

  it("reports fixed reasons when it cannot try the checks at all", async () => {
    expect((await dryRun([OK()], { config: false })).report).toMatchObject({ status: "UNAVAILABLE", reason: "sandbox-not-configured" });
    expect((await dryRun([OK()], { materialize: async () => ({ status: "UNAVAILABLE" }) })).report).toMatchObject({ status: "UNAVAILABLE", reason: "source-unavailable" });
    const broken: DockerCli = { run: async () => ({ code: 125, stdout: `docker: ${PASSWORD}`, stderr: "" }) };
    const { report } = await dryRun([OK(), OK()], { docker: () => broken });
    expect(report).toMatchObject({ status: "UNAVAILABLE", reason: "sandbox-unavailable" });
    expect(JSON.stringify(report)).not.toContain(PASSWORD);
  });

  it("a missing docker binary (exit 127 from the CLI) is an unavailable sandbox, not broken checks and not a finding", async () => {
    const calls: string[][] = [];
    const noDocker: DockerCli = { async run(args) { calls.push(args); return { code: 127, stdout: "", stderr: "could not run docker" }; } };
    const { report } = await dryRun([OK(), builtin("file-contains", "src/app.js", "BASE-TOKEN")], { docker: () => noDocker });
    expect(report).toMatchObject({ status: "UNAVAILABLE", reason: "sandbox-unavailable" });
    // The image is looked at once, before any check starts.
    expect(calls).toEqual([["image", "inspect", "executor:test"]]);
    expect(planDryRunFindings({ outcome: readPlanDryRunOutcome({ events: [{ type: "progress", payload: { planDryRun: report } }], planText: "x", proposed: [] }) })).toEqual([]);
  });

  it("an executor image the host does not hold is an unavailable sandbox too", async () => {
    const missing: DockerCli = { async run() { return { code: 1, stdout: "", stderr: "no such image" }; } };
    expect((await dryRun([OK()], { docker: () => missing })).report).toMatchObject({ status: "UNAVAILABLE", reason: "sandbox-unavailable" });
  });

  it("tries only built-in file checks and plain grep or test: anything else is not-checked, with no container started and no finding", async () => {
    const others = [
      program("npm", ["test"]), program("npm", ["run", "lint"]), program("rg", ["x", "."]), program("git", ["diff", "--exit-code"]), program("npx", ["vitest", "run"]),
      program("sh", ["-c", "exit 0"]), program("node", ["-e", "process.exit(0)"]), program("./grep", ["x"]),
    ];
    const { report, observed } = await dryRun(others);
    expect(classes(report)).toEqual(others.map(() => "not-checked"));
    expect(observed.calls).toEqual([]);
    // No sandbox is needed to say so: it holds without any configured runtime too.
    expect(classes((await dryRun(others, { config: false })).report)).toEqual(others.map(() => "not-checked"));
  });

  it("a mix tries the eligible checks and leaves the rest not-checked, in plan order, each attributed to its own command", async () => {
    const checks = [program("npm", ["test"]), builtin("file-contains", "src/app.js", "BASE-TOKEN"), program("grep", ["-q", "nope", "keep.txt"]), program("rg", ["x"])];
    const { report, observed } = await dryRun(checks);
    expect(classes(report)).toEqual(["not-checked", "passed", "failed", "not-checked"]);
    if (report.status !== "COMPLETE") throw new Error("expected complete");
    expect(report.checks.map((entry) => entry.commandSha256)).toEqual(checks.map((check) => planDryRunCommandSha256(check.command)));
    expect(observed.calls.filter((call) => call[0] === "run")).toHaveLength(2);
  });

  it("npm test in a repository with a package.json and no node_modules is not-checked, and the broker raises nothing for it", async () => {
    const ws = workspace();
    writeFileSync(join(ws.repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    const check = program("npm", ["test"]);
    const { report, planText } = await dryRun([check]);
    expect(classes(report)).toEqual(["not-checked"]);
    const proposed = [{ id: "proposed-1", command: check.command }];
    const outcome = readPlanDryRunOutcome({ events: [{ type: "progress", payload: { planDryRun: { ...report, planSha256: sha256(planText) } } }], planText, proposed, workerFeatures: [PLAN_DRY_RUN_FEATURE] });
    expect(outcome.status).toBe("TRIED");
    expect(planDryRunFindings({ outcome, expectOnBase: { "proposed-1": "pass" } })).toEqual([]);
    expect(planDryRunOriginalResults(outcome)).toEqual({});
  });

  it("is cancelled with the operation: it throws, removes the container it started, and leaves nothing behind", async () => {
    const controller = new AbortController();
    const calls: string[][] = [];
    const docker: DockerCli = { async run(args, opts) {
      calls.push(args);
      if (args[0] !== "run") return { code: 0, stdout: "", stderr: "" };
      setTimeout(() => controller.abort(new WorkerOperationCancelledError("op")), 20);
      await new Promise<void>((resolve) => opts.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { code: 130, stdout: "", stderr: "" };
    } };
    await expect(dryRun([program("grep", ["-q", "x", "keep.txt"])], { signal: controller.signal, docker: () => docker })).rejects.toBeInstanceOf(WorkerOperationCancelledError);
    expect(calls.some((call) => call[0] === "rm" && call[1] === "-f")).toBe(true);
  });
});

describe("the base source export", () => {
  it("writes the base commit's regular files and refuses more or fewer than one repository", async () => {
    const ws = workspace();
    const destination = join(track(mkdtempSync(join(tmpdir(), "plan-dry-run-dest-"))), "src");
    const input = { repositories: [{ repositoryId: REPO_PATH, directory: ws.repo, baseCommitSha: ws.baseSha }], destination, signal: new AbortController().signal };
    expect(await materializeBaseSource(input)).toEqual({ status: "READY" });
    expect(readFileSync(join(destination, "src/app.js"), "utf8")).toContain("BASE-TOKEN");
    expect(existsSync(join(destination, "untracked.txt"))).toBe(false);
    rmSync(destination, { recursive: true });
    expect(await materializeBaseSource({ ...input, repositories: [] })).toEqual({ status: "UNAVAILABLE" });
    expect(await materializeBaseSource({ ...input, repositories: [{ repositoryId: REPO_PATH, directory: ws.repo }] })).toEqual({ status: "UNAVAILABLE" });
    expect(await materializeBaseSource({ ...input, repositories: [{ repositoryId: REPO_PATH, directory: ws.repo, baseCommitSha: "0".repeat(40) }] })).toEqual({ status: "UNAVAILABLE" });
    expect(existsSync(destination)).toBe(false);
  });
});

const FOLDER = REPO_PATH;
function codingPlanText(checks: unknown[]): string {
  return planAnswer(planDocument(), { checks: { checks } as never });
}

describe("reading the proposed checks of a plan", () => {
  it("reads them as the broker does, and an unreadable block or a folder outside the repository proposes nothing", () => {
    const text = codingPlanText([{ label: "App has the token", kind: "file-contains", cwd: FOLDER, path: "src/app.js", text: "BASE-TOKEN", proves: ["1"], expectOnBase: "pass" }]);
    expect(proposedChecksOfPlan(text, [FOLDER]).map((check) => check.command.cwd)).toEqual([FOLDER]);
    expect(proposedChecksOfPlan(text, ["elsewhere"])).toEqual([]);
    expect(proposedChecksOfPlan("no plan block at all", [FOLDER])).toEqual([]);
  });
});

describe("a planning run reports the dry run and is never failed by it", () => {
  const SECRET_PLAN_CHECK = { label: "App has the token", kind: "file-contains", cwd: FOLDER, path: "src/app.js", text: "BASE-TOKEN", proves: ["1"], expectOnBase: "pass" };

  async function planningRun(options: { answer: string; planDryRun?: typeof runPlanDryRun; cancel?: boolean; structured?: boolean }) {
    const ws = workspace();
    const root = ws.root;
    await mkdir(join(root, ".agentx"), { recursive: true });
    await writeFile(join(root, ".agentx/preparation-manifest.json"), JSON.stringify({ schemaVersion: 2, projectName: "x", projectRevision: 1,
      repositories: [{ name: REPO_PATH, path: REPO_PATH, defaultBranch: "main", resolvedCommit: ws.baseSha, resolvedAt: new Date().toISOString() }],
      completedSetupSteps: [], readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: new Date().toISOString() }));
    const adapter: PiSessionAdapter = { async create({ sessionDirectory }) {
      const sessionFile = join(sessionDirectory, "fixture.jsonl");
      await writeFile(sessionFile, "");
      let listener: (event: unknown) => void = () => undefined;
      return {
        sessionFile, conversationId: "fixture",
        prompt: async () => { listener({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: options.answer }] } }); },
        abort: async () => undefined, getModel: () => ({ provider: "fixture", modelId: "fixture" }),
        getSessionStats: () => ({ sessionFile, sessionId: "fixture", userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 }),
        subscribe: (next) => { listener = next; return () => undefined; }, dispose: () => undefined,
      };
    } };
    const sent: WorkerEvent[] = [];
    const artifacts: Array<{ name: string; content: string }> = [];
    const controller = new WorkerCancellationController();
    const operationId = randomUUID();
    const result = await runTaskInvocation({
      protocolVersion: 1, kind: "task", operationId, workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
      payload: { conversationId: randomUUID(), prompt: "Plan", workflowMode: "PLAN", workflowPhase: "IMPLEMENTATION_PLAN", ...(options.structured === false ? {} : { planFormat: "structured" }) },
    } as never, {
      rootPath: root, model: { provider: "fixture", modelId: "fixture" }, piAdapter: adapter, cancellationController: controller,
      eventSink: async (batch) => { sent.push(...batch); }, artifactSink: async (artifact) => { artifacts.push(artifact); },
      log: () => undefined, ...(options.planDryRun === undefined ? {} : { planDryRun: options.planDryRun }),
    }).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
    return { result, sent, artifacts, ws };
  }

  it("tries the saved plan's proposed checks and sends the fixed report before the result; the plan is uploaded as it was", async () => {
    const answer = codingPlanText([SECRET_PLAN_CHECK]);
    const received: Array<Parameters<typeof runPlanDryRun>[0]> = [];
    const fake: typeof runPlanDryRun = async (input) => {
      received.push(input);
      return { schemaVersion: "workflow-plan-dry-run/v1", status: "COMPLETE", planSha256: sha256(input.planText),
        checks: input.checks.map((check) => ({ commandSha256: planDryRunCommandSha256(check.command), class: "passed" as const, durationMs: 5 })), totalMs: 5 };
    };
    const { result, sent, artifacts } = await planningRun({ answer, planDryRun: fake });
    expect(result.ok).toBe(true);
    const plan = artifacts.find((artifact) => artifact.name === "plan.md")!;
    expect(received).toHaveLength(1);
    expect(received[0]!.planText).toBe(plan.content);
    expect(received[0]!.repositoryPath).toBe(REPO_PATH);
    expect(received[0]!.checks.map((check) => check.command.cwd)).toEqual([REPO_PATH]);
    const reportAt = sent.findIndex((event) => event.type === "progress" && Object.hasOwn(event.payload as object, "planDryRun"));
    const resultAt = sent.findIndex((event) => event.type === "result");
    expect(reportAt).toBeGreaterThan(-1);
    expect(resultAt).toBeGreaterThan(reportAt);
    // The report survives the event path byte for byte (its digests are not mistaken for secrets) and is what the broker reads.
    const outcome = readPlanDryRunOutcome({ events: sent, planText: plan.content, workerFeatures: [PLAN_DRY_RUN_FEATURE],
      proposed: proposedChecksOfPlan(plan.content, [FOLDER]).map((check, index) => ({ id: `proposed-${index + 1}`, command: check.command })) });
    expect(outcome).toEqual({ status: "TRIED", results: [{ checkId: "proposed-1", class: "passed" }] });
  });

  it("does not fail or delay the plan when the dry run throws, and sends no report", async () => {
    const { result, sent } = await planningRun({ answer: codingPlanText([SECRET_PLAN_CHECK]), planDryRun: async () => { throw new Error(`boom ${PASSWORD}`); } });
    expect(result.ok).toBe(true);
    expect(sent.some((event) => Object.hasOwn(event.payload ?? {}, "planDryRun"))).toBe(false);
    expect(JSON.stringify(sent)).not.toContain(PASSWORD);
    expect(sent.some((event) => event.type === "result")).toBe(true);
  });

  it("does not try anything for a plan with no proposed checks, or a plan that is not structured", async () => {
    let calls = 0;
    const fake: typeof runPlanDryRun = async () => { calls += 1; throw new Error("not expected"); };
    await planningRun({ answer: codingPlanText([]), planDryRun: fake });
    await planningRun({ answer: codingPlanText([SECRET_PLAN_CHECK]), planDryRun: fake, structured: false });
    expect(calls).toBe(0);
  });

  it("really runs the proposed checks on the base commit through the sandbox", async () => {
    const answer = codingPlanText([SECRET_PLAN_CHECK, { label: "Workspace edit", kind: "file-contains", cwd: FOLDER, path: "src/app.js", text: "edited in the workspace", proves: ["1"], expectOnBase: "fail" }]);
    const base = track(mkdtempSync(join(tmpdir(), "plan-dry-run-shared-")));
    const observed: Observed = { calls: [], outputs: [], sourceDuringRun: [] };
    const real: typeof runPlanDryRun = (input) => runPlanDryRun({ ...input, docker: localDocker({ source: () => undefined }, observed), config: { executorImage: "executor:test", runRoot: join(base, "candidates", "web-api-runs") } });
    const { result, sent, artifacts } = await planningRun({ answer, planDryRun: real });
    expect(result.ok).toBe(true);
    const plan = artifacts.find((artifact) => artifact.name === "plan.md")!;
    const outcome = readPlanDryRunOutcome({ events: sent, planText: plan.content, workerFeatures: [PLAN_DRY_RUN_FEATURE],
      proposed: proposedChecksOfPlan(plan.content, [FOLDER]).map((check, index) => ({ id: `proposed-${index + 1}`, command: check.command })) });
    expect(outcome.status).toBe("TRIED");
    if (outcome.status !== "TRIED") return;
    expect(outcome.results.map((entry) => entry.class)).toEqual(["passed", "failed"]);
    // Both match what the plan predicted, so there is no finding.
    expect(planDryRunFindings({ outcome, expectOnBase: { "proposed-1": "pass", "proposed-2": "fail" } })).toEqual([]);
  });
});

describe("the worker lists the feature only while it can try checks", () => {
  it("is on the worker's feature list, and withheld with the executor image when the application checks are not ready", () => {
    expect(WORKER_INVOCATION_FEATURES).toContain(PLAN_DRY_RUN_FEATURE);
    const monitor = createApplicationChecksFeatureMonitor({ environment: {} });
    expect(monitor.executor.withholdableInvocationFeatures).toContain(PLAN_DRY_RUN_FEATURE);
    expect(Object.keys(monitor.executor.withheldInvocationFeatures())).toContain(PLAN_DRY_RUN_FEATURE);
  });
});

describe("the control plane reads the report", () => {
  const checkA = { id: "proposed-1", command: builtinFileCheckCommand({ kind: "file-contains", cwd: FOLDER, path: "a.js", text: "A" }) };
  const checkB = { id: "proposed-2", command: builtinFileCheckCommand({ kind: "file-not-contains", cwd: FOLDER, path: "a.js", text: "B" }) };
  const checkC = { id: "proposed-3", command: { cwd: FOLDER, executable: "grep", args: ["-cL", "x", "a.js"] } };
  const withTimeout = (check: { id: string; command: { cwd: string; executable: string; args: string[] } }) => ({ ...check, command: { ...check.command, timeoutSeconds: 60 } });
  const proposed = [checkA, checkB, checkC].map(withTimeout);
  const PLAN = "the exact plan text";
  const report = (checks: Array<{ command: typeof proposed[number]["command"]; class: "passed" | "failed" | "broken" | "not-run" | "not-checked" }>, planText = PLAN): PlanDryRunReport => ({
    schemaVersion: "workflow-plan-dry-run/v1", status: "COMPLETE", planSha256: sha256(planText), totalMs: 10,
    checks: checks.map((entry) => ({ commandSha256: planDryRunCommandSha256(entry.command), class: entry.class, durationMs: 3 })),
  });
  const eventsOf = (payload: unknown) => [{ type: "progress", payload: { message: "x" } }, { type: "progress", payload: { message: "y", planDryRun: payload } }];
  const read = (payload: unknown, extra: Partial<Parameters<typeof readPlanDryRunOutcome>[0]> = {}) =>
    readPlanDryRunOutcome({ events: eventsOf(payload), planText: PLAN, proposed, workerFeatures: [PLAN_DRY_RUN_FEATURE], ...extra });

  it("keeps the duration out of what the control plane hands on (it is a free-form number the code under test can steer)", () => {
    const outcome = read(report([{ command: proposed[0]!.command, class: "passed" }]));
    expect(JSON.stringify(outcome)).not.toContain("durationMs");
    expect(JSON.stringify([planDryRunFindings({ outcome }), planDryRunWarnings(outcome), planDryRunOriginalResults(outcome)])).not.toMatch(/duration|\b3\b/);
  });

  it("not-checked and not-run raise no finding and leave the original-code result unknown", () => {
    const outcome = read(report([{ command: proposed[0]!.command, class: "not-checked" }, { command: proposed[1]!.command, class: "not-run" }, { command: proposed[2]!.command, class: "passed" }]));
    expect(planDryRunFindings({ outcome, expectOnBase: { "proposed-1": "pass", "proposed-2": "fail" } })).toEqual([]);
    expect(planDryRunOriginalResults(outcome)).toEqual({ "proposed-3": "passed" });
    expect(planDryRunWarnings(outcome)).toEqual(["Some proposed checks were not tried on the current code."]);
  });

  it("a check that was only not-checked still says so in one fixed warning", () => {
    const outcome = read(report([{ command: proposed[0]!.command, class: "passed" }, { command: proposed[1]!.command, class: "passed" }, { command: proposed[2]!.command, class: "not-checked" }]));
    expect(planDryRunWarnings(outcome)).toEqual(["Some proposed checks were not tried on the current code."]);
  });

  it("gives broken and mismatch findings with fixed sentences, from classes and expectations alone", () => {
    const outcome = read(report([{ command: proposed[0]!.command, class: "failed" }, { command: proposed[1]!.command, class: "passed" }, { command: proposed[2]!.command, class: "broken" }]));
    expect(outcome.status).toBe("TRIED");
    const findings = planDryRunFindings({ outcome, expectOnBase: { "proposed-1": "pass", "proposed-2": "fail" } });
    expect(findings.map((finding) => [finding.code, finding.checkIds, finding.revisable])).toEqual([
      ["check-broken-on-base", ["proposed-3"], true], ["check-base-mismatch", ["proposed-1", "proposed-2"], true],
    ]);
    expect(planDryRunWarnings(outcome)).toEqual([]);
    expect(planDryRunOriginalResults(outcome)).toEqual({ "proposed-1": "failed", "proposed-2": "passed", "proposed-3": "cannot-run" });
  });

  it("a check with no prediction is never a mismatch, and a prediction that came true is no finding", () => {
    const outcome = read(report([{ command: proposed[0]!.command, class: "failed" }, { command: proposed[1]!.command, class: "passed" }, { command: proposed[2]!.command, class: "passed" }]));
    expect(planDryRunFindings({ outcome })).toEqual([]);
    expect(planDryRunFindings({ outcome, expectOnBase: { "proposed-1": "fail", "proposed-2": "pass" } })).toEqual([]);
  });

  it("attributes by command, not by position: a different numbering or order lands on the right check", () => {
    const shuffled = report([{ command: proposed[2]!.command, class: "broken" }, { command: proposed[0]!.command, class: "passed" }]);
    const outcome = read(shuffled);
    if (outcome.status !== "TRIED") throw new Error("expected a tried outcome");
    expect(outcome.results.map((entry) => [entry.checkId, entry.class])).toEqual([["proposed-1", "passed"], ["proposed-2", "not-run"], ["proposed-3", "broken"]]);
    // The check the report has no entry for was not tried: a warning, never a pass and never a finding.
    expect(planDryRunWarnings(outcome)).toEqual(["Some proposed checks were not tried on the current code."]);
    expect(planDryRunOriginalResults(outcome)).toEqual({ "proposed-1": "passed", "proposed-3": "cannot-run" });
  });

  it("does not accept a report for another plan, an unreadable or padded report, or one from a worker without the feature", () => {
    const good = report([{ command: proposed[0]!.command, class: "passed" }]);
    expect(read(good, { planText: "another plan version" })).toEqual({ status: "NOT_TRIED", reason: "report-for-another-plan" });
    expect(read({ ...good, extra: PASSWORD })).toEqual({ status: "NOT_TRIED", reason: "report-unreadable" });
    expect(read({ ...good, checks: [{ ...good.status === "COMPLETE" ? good.checks[0] : {}, output: PASSWORD }] })).toEqual({ status: "NOT_TRIED", reason: "report-unreadable" });
    expect(read({ ...good, checks: [{ ...(good as { checks: object[] }).checks[0], class: "weird" }] })).toEqual({ status: "NOT_TRIED", reason: "report-unreadable" });
    expect(read(good, { workerFeatures: ["task.readiness"] })).toEqual({ status: "NOT_TRIED", reason: "worker-cannot" });
    expect(read(good, { workerFeatures: undefined })).toEqual({ status: "NOT_TRIED", reason: "worker-cannot" });
    expect(readPlanDryRunOutcome({ events: [], planText: PLAN, proposed, workerFeatures: [PLAN_DRY_RUN_FEATURE] })).toEqual({ status: "NOT_TRIED", reason: "no-report" });
    expect(readPlanDryRunOutcome({ events: eventsOf(good), planText: PLAN, proposed: [], workerFeatures: [PLAN_DRY_RUN_FEATURE] })).toEqual({ status: "NOT_TRIED", reason: "no-proposed-checks" });
    expect(workerTriesProposedChecks([PLAN_DRY_RUN_FEATURE])).toBe(true);
    expect(workerTriesProposedChecks(undefined)).toBe(false);
  });

  it("an unavailable dry run is a warning with a fixed sentence, never a finding", () => {
    const outcome = read({ schemaVersion: "workflow-plan-dry-run/v1", status: "UNAVAILABLE", planSha256: sha256(PLAN), reason: "sandbox-unavailable" });
    expect(outcome).toEqual({ status: "NOT_TRIED", reason: "worker-unavailable", workerReason: "sandbox-unavailable" });
    expect(planDryRunFindings({ outcome })).toEqual([]);
    expect(planDryRunWarnings(outcome)).toEqual(["Proposed checks were not tried on the current code."]);
    expect(planDryRunOriginalResults(outcome)).toEqual({});
  });
});
