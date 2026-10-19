import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { E2EExecutorPlanSchema, copyBoundedE2EJsonData, canonicalJson, type E2EExecutorPlan } from "@agentx/contracts";
import { compareE2EApplicationPublicList } from "../application-identity.js";
import { normalizeE2EApplicationPublicList } from "../application-result-adapter.js";
import { parseE2EApplicationReport } from "../application-report-schema.js";
import { createE2EApplicationRuntimeAssets } from "../application-runtime-assets.js";
import type { E2EApplicationCliLaunchContext } from "../application-runtime-bootstrap.js";
import { E2E_EXECUTOR_BLOCKED_LOG, E2E_EXECUTOR_CONTEXT_ENV, E2E_EXECUTOR_OUTPUT_DIR, type ExecutorHostContext } from "./host.js";
import { verifyExecutorHostRegistration } from "./host-registry.js";
import { launchLocalChromium, type LocalChromium } from "./local-browser.js";
import { createCredentialRedactor, type CredentialRedactor } from "./redact.js";
import { createLaunchContexts, resolveE2EExecutorSuite, type ResolvedExecutorSuite } from "./suite.js";

const MAX_PLAN_BYTES = 20 * 1024 * 1024;
const MAX_CLI_OUTPUT = 4 * 1024 * 1024;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const HEALTH_POLL_MS = 250;
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export type E2EExecutorExitCode = 0 | 1 | 2;
export type E2EExecutorRunInput = Readonly<{
  planPath: string; outDir: string; signal: AbortSignal;
  /**
   * Test seam, never part of a plan: where the plan's app origin really answers (a fixture app on loopback). Chromium maps
   * `app:4317` there and the executor's own requests go there; the compiled suite and the ledger still see `http://app:4317`.
   */
  localAppUpstream?: string;
  /** Test seam for a Chromium binary other than the pinned Playwright one. */
  chromiumExecutable?: string;
}>;

type ProcessResult = { status: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: Buffer; startedAt: string; finishedAt: string;
  timedOut: boolean; aborted: boolean; outputExceeded: boolean };

function runProcess(executable: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; deadlineAt: number; signal: AbortSignal }): Promise<ProcessResult> {
  return new Promise((resolveProcess, rejectProcess) => {
    if (options.signal.aborted) { rejectProcess(new Error("executor was cancelled before a CLI process started")); return; }
    if (Date.now() >= options.deadlineAt) { rejectProcess(new Error("the run deadline elapsed before a CLI process started")); return; }
    const startedAt = new Date().toISOString();
    const child = spawn(executable, [...args], { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], shell: false });
    const out: Buffer[] = []; const err: Buffer[] = []; let outBytes = 0; let errBytes = 0;
    let timedOut = false; let aborted = false; let outputExceeded = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { if (child.kill("SIGTERM")) killTimer ??= setTimeout(() => { child.kill("SIGKILL"); }, 2_000); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, options.deadlineAt - Date.now()));
    const onAbort = () => { aborted = true; stop(); };
    options.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { outBytes += chunk.byteLength; if (outBytes <= MAX_CLI_OUTPUT) out.push(Buffer.from(chunk)); else { outputExceeded = true; stop(); } });
    child.stderr.on("data", (chunk: Buffer) => { errBytes += chunk.byteLength; if (errBytes <= MAX_CLI_OUTPUT) err.push(Buffer.from(chunk)); else { outputExceeded = true; stop(); } });
    const settle = () => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); options.signal.removeEventListener("abort", onAbort); };
    child.once("error", (error) => { settle(); rejectProcess(error); });
    child.once("close", (status, signal) => { settle();
      resolveProcess({ status, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err), startedAt, finishedAt: new Date().toISOString(), timedOut, aborted, outputExceeded }); });
  });
}

const processRecord = (result: ProcessResult) => ({ status: result.status, signal: result.signal, startedAt: result.startedAt, finishedAt: result.finishedAt,
  timedOut: result.timedOut, aborted: result.aborted, outputExceeded: result.outputExceeded, stdoutSha256: sha(result.stdout), stderrSha256: sha(result.stderr),
  stdoutBytes: result.stdout.byteLength, stderrBytes: result.stderr.byteLength });
const cleanCompletion = (result: ProcessResult) => !result.signal && !result.timedOut && !result.aborted && !result.outputExceeded;

function packageRootDir(): string { return fileURLToPath(new URL("../../../../", import.meta.url)); }

async function writeExclusive(path: string, data: Uint8Array | string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(data); } finally { await handle.close(); }
}

async function waitForHealthy(plan: E2EExecutorPlan, upstream: string, deadlineAtMs: number, signal: AbortSignal): Promise<"healthy" | "app-unhealthy" | "deadline-exceeded"> {
  const health = plan.app.health;
  const giveUpAt = Date.now() + health.timeoutMs;
  for (;;) {
    if (signal.aborted) throw new Error("executor was cancelled while waiting for the application");
    try {
      const response = await fetch(new URL(health.path, upstream), { redirect: "manual", signal: AbortSignal.timeout(2_000) });
      await response.body?.cancel().catch(() => undefined);
      if (response.status === health.expectedStatus) return "healthy";
    } catch { /* the application is not listening yet */ }
    if (Date.now() >= deadlineAtMs) return "deadline-exceeded";
    if (Date.now() >= giveUpAt) return "app-unhealthy";
    await new Promise((done) => setTimeout(done, Math.min(HEALTH_POLL_MS, Math.max(1, Math.min(giveUpAt, deadlineAtMs) - Date.now()))));
  }
}

async function listFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6 || found.length > 20_000) return;
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile()) found.push(full);
    }
  };
  await walk(root, 0);
  return found;
}

type ShardOutcome = { shardId: string; launchId: string; targetKind: string; list: ReturnType<typeof processRecord>; run: ReturnType<typeof processRecord> | null;
  upstreamRunId: string | null; reportBytes: Buffer | null; failed: boolean; completed: boolean; reason: string | null };

/**
 * Runs one compiled shard through the pinned `e2e` CLI exactly as the compiler laid it out: the generated config loads the
 * registered executor host, which drives the case adapters against the live application.
 */
async function runShard(input: { resolved: ResolvedExecutorSuite; launch: E2EApplicationCliLaunchContext; workDir: string; planPath: string; outDir: string;
  browser: LocalChromium | null; appUpstream: string | null; redactor: CredentialRedactor; signal: AbortSignal; log: (line: string) => Promise<void> }): Promise<ShardOutcome> {
  const { resolved, launch } = input;
  const shard = resolved.suite.shards.find((candidate) => candidate.shardId === launch.shardId)!;
  const shardKey = sha(launch.shardId).slice(0, 16);
  const project = join(input.workDir, `application-${shardKey}`);
  const assets = await createE2EApplicationRuntimeAssets({ compiled: resolved.suite, shardId: shard.shardId, launchId: launch.launchId, ownedDirectory: project });
  const privateRoot = join(project, ".agentx", "e2e");
  await writeExclusive(join(privateRoot, "application-cli-launch.json"), `${JSON.stringify(launch)}\n`);
  await writeExclusive(join(privateRoot, "application-cli-inventory.json"), `${JSON.stringify({ schemaVersion: "e2e-application-cli-inventory/v1",
    compiledInventoryDigest: shard.inventory.digest, shardId: shard.shardId, inventory: shard.inventory, selection: shard.selection,
    expectedCases: shard.expectedCases })}\n`);
  const runtimeRoot = packageRootDir();
  const dependencyRoot = join(runtimeRoot, "node_modules");
  if (!(await lstat(dependencyRoot)).isDirectory() || await realpath(dependencyRoot) !== dependencyRoot) throw new Error("installed e2e dependencies are unavailable from the fixed runtime root");
  await symlink(dependencyRoot, join(project, "node_modules"), "dir");
  const home = join(project, ".home"); const tmp = join(project, ".tmp");
  await mkdir(home, { mode: 0o700 }); await mkdir(tmp, { mode: 0o700 });
  const context: ExecutorHostContext = { schemaVersion: "e2e-executor-host-context/v1", planPath: input.planPath, outDir: input.outDir, projectDir: project,
    cdpEndpoint: input.browser?.cdpEndpoint ?? null, browserPid: input.browser?.pid ?? null, appUpstream: input.appUpstream };
  const contextPath = join(input.workDir, `host-context-${shardKey}.json`);
  await writeExclusive(contextPath, `${JSON.stringify(context)}\n`);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp, CI: "1",
    E2E_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1", [E2E_EXECUTOR_CONTEXT_ENV]: contextPath };
  const e2eRoot = join(runtimeRoot, "node_modules", "e2e");
  const cliPath = join(e2eRoot, "dist", "cli", "bin.js");
  const pkg = JSON.parse(await readFile(join(e2eRoot, "package.json"), "utf8")) as { version?: unknown };
  if (pkg.version !== "0.20.0") throw new Error("installed application runner is not pinned e2e 0.20.0");
  const configPath = join(project, "e2e.config.mjs");
  const base: Pick<ShardOutcome, "shardId" | "launchId" | "targetKind"> = { shardId: shard.shardId, launchId: assets.launchId, targetKind: launch.selectedTarget.kind };

  await input.log(`shard ${shard.shardId} (${launch.selectedTarget.kind}): listing`);
  const list = await runProcess(process.execPath, [cliPath, "list", "--config", configPath, "--reporter", "json"],
    { cwd: project, env, deadlineAt: resolved.deadlineAtMs, signal: input.signal });
  const shardDir = join(input.outDir, "shards", shardKey);
  await mkdir(shardDir, { recursive: true, mode: 0o755 });
  const writeText = (name: string, bytes: Uint8Array) => writeFile(join(shardDir, name), input.redactor.text(Buffer.from(bytes).toString("utf8")));
  await writeText("list.stdout.json", list.stdout); await writeText("list.stderr.txt", list.stderr);
  if (list.status !== 0 || !cleanCompletion(list)) {
    return { ...base, list: processRecord(list), run: null, upstreamRunId: null, reportBytes: null, failed: false, completed: false, reason: "cli-list-failed" };
  }
  try {
    const listed = compareE2EApplicationPublicList(shard.selection, normalizeE2EApplicationPublicList(
      JSON.parse(canonicalJson(copyBoundedE2EJsonData(JSON.parse(list.stdout.toString("utf8")), { maxBytes: MAX_CLI_OUTPUT, maxDepth: 32, maxNodes: 65_536 }))) as unknown, shard.selection.targetId));
    if (listed.filtered.length !== 0 || listed.selected.length !== shard.selection.tuples.length) throw new Error("the public list filtered or dropped compiled cases");
  } catch (error) {
    await input.log(`shard ${shard.shardId}: public list differs from the compiled selection: ${error instanceof Error ? error.message : "unreadable"}`);
    return { ...base, list: processRecord(list), run: null, upstreamRunId: null, reportBytes: null, failed: false, completed: false, reason: "selection-mismatch" };
  }

  await input.log(`shard ${shard.shardId}: running ${shard.selection.tuples.length} case(s)`);
  const run = await runProcess(process.execPath, [cliPath, "run", "--config", configPath, "--reporter", "json", "--output", E2E_EXECUTOR_OUTPUT_DIR,
    "--no-cache", "--workers", "1", "--retries", "0"], { cwd: project, env, deadlineAt: resolved.deadlineAtMs, signal: input.signal });
  await writeText("report.json", run.stdout); await writeText("run.stderr.txt", run.stderr);
  let upstreamRunId: string | null = null;
  try {
    const startBytes = await readFile(assets.capturePath);
    await writeText("run-start.jsonl", startBytes);
    upstreamRunId = (JSON.parse(startBytes.toString("utf8").trim()) as { runId?: string }).runId ?? null;
  } catch { /* a run that never started leaves no capture */ }
  const record = processRecord(run);
  if (!cleanCompletion(run)) {
    return { ...base, list: processRecord(list), run: record, upstreamRunId, reportBytes: null, failed: false, completed: false, reason: run.timedOut ? "deadline-exceeded" : run.aborted ? "cancelled" : "cli-run-interrupted" };
  }
  const parsed = parseE2EApplicationReport(run.stdout);
  if (parsed.kind !== "parsed") return { ...base, list: processRecord(list), run: record, upstreamRunId, reportBytes: null, failed: false, completed: false, reason: "report-unreadable" };
  const summary = parsed.report.run.summary;
  // Skipped, flaky, filtered or missing results never count as a clean run.
  const clean = run.status === 0 && summary.failed === 0 && summary.skipped === 0 && summary.flaky === 0 && summary.interrupted === 0
    && summary.executed === summary.selected && summary.selected === shard.selection.tuples.length;
  if (!clean && run.status !== 0 && run.status !== 1) {
    return { ...base, list: processRecord(list), run: record, upstreamRunId, reportBytes: run.stdout, failed: false, completed: false, reason: `cli-run-exit-${run.status}` };
  }
  return { ...base, list: processRecord(list), run: record, upstreamRunId, reportBytes: run.stdout, failed: !clean, completed: true, reason: null };
}

/**
 * The executor's whole job inside its container: check the plan, wait for the candidate, start Chromium, run the compiled
 * suite through the pinned CLI, and leave the facts in the out directory. Exit 0 means every compiled case passed, 1 means the
 * run completed with failures, 2 means no trustworthy result exists (bad plan, unhealthy app, deadline, internal error).
 */
export async function runE2EExecutor(input: E2EExecutorRunInput): Promise<{ exitCode: E2EExecutorExitCode; reason: string | null }> {
  if (!isAbsolute(input.outDir) || !isAbsolute(input.planPath)) throw new Error("executor plan and out paths must be absolute");
  await mkdir(input.outDir, { recursive: true, mode: 0o755 });
  const outDir = await realpath(input.outDir);
  const startedAt = new Date().toISOString();
  let redactor: CredentialRedactor = createCredentialRedactor([]);
  const logPath = join(outDir, "executor.log");
  const log = async (line: string) => { await appendFile(logPath, `${new Date().toISOString()} ${redactor.text(line)}\n`); };
  let browser: LocalChromium | null = null;
  let workDir: string | null = null;
  let resolved: ResolvedExecutorSuite | null = null;
  const shards: ShardOutcome[] = [];
  let exitCode: E2EExecutorExitCode = 2;
  let reason: string | null = "internal-error";

  const finish = async (): Promise<void> => {
    await browser?.close().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    let blocked: unknown[] = [];
    try {
      blocked = (await readFile(join(outDir, E2E_EXECUTOR_BLOCKED_LOG), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown);
      await rm(join(outDir, E2E_EXECUTOR_BLOCKED_LOG), { force: true });
    } catch { /* no request was blocked */ }
    await writeFile(join(outDir, "blocked-requests.json"), `${JSON.stringify({ schemaVersion: "e2e-executor-blocked-requests/v1", blocked }, null, 2)}\n`);
    // Last line of defense: nothing under the out directory may carry an account credential.
    for (const file of await listFiles(outDir)) {
      const info = await lstat(file);
      if (info.size > MAX_SCAN_BYTES) continue;
      if (redactor.contains(await readFile(file))) {
        await rm(file, { force: true });
        await appendFile(logPath, `${new Date().toISOString()} removed an output file that carried an account credential\n`);
        if (exitCode !== 2) { exitCode = 2; reason = "credential-leak"; }
      }
    }
    await writeFile(join(outDir, "executor-result.json"), `${JSON.stringify({ schemaVersion: "e2e-executor-result/v1", exitCode, reason,
      startedAt, finishedAt: new Date().toISOString(), node: { version: process.version, execPath: process.execPath, platform: process.platform, arch: process.arch },
      runId: resolved?.binding.runId ?? null, groupId: resolved?.suite.group.groupId ?? null,
      shards: shards.map((item) => ({ shardId: item.shardId, launchId: item.launchId, targetKind: item.targetKind, upstreamRunId: item.upstreamRunId,
        completed: item.completed, failed: item.failed, reason: item.reason, list: item.list, run: item.run })) }, null, 2)}\n`);
  };

  const main = async (): Promise<void> => {
    const planBytes = await readFile(input.planPath);
    if (planBytes.byteLength > MAX_PLAN_BYTES) throw Object.assign(new Error("the executor plan exceeds its fixed bound"), { reason: "plan-invalid" });
    const parsedPlan = E2EExecutorPlanSchema.safeParse((() => { try { return JSON.parse(planBytes.toString("utf8")) as unknown; } catch { return null; } })());
    if (!parsedPlan.success) {
      await log(`unavailable: plan-invalid (${parsedPlan.error.issues.map((issue) => issue.path.join(".")).slice(0, 8).join(", ")})`);
      reason = "plan-invalid";
      return;
    }
    const plan = parsedPlan.data;
    redactor = createCredentialRedactor(plan.accounts);
    try { resolved = resolveE2EExecutorSuite(plan); }
    catch (error) { await log(`unavailable: admission-invalid: ${error instanceof Error ? error.message : "unreadable"}`); reason = "admission-invalid"; return; }
    if (Date.now() >= resolved.deadlineAtMs) { await log("unavailable: deadline-exceeded before the run started"); reason = "deadline-exceeded"; return; }
    const registration = await verifyExecutorHostRegistration(resolved.suite.cliHost);
    if (!registration.available) { await log(`unavailable: host-unavailable: ${registration.reason}`); reason = "host-unavailable"; return; }

    const upstream = input.localAppUpstream ?? plan.app.origin;
    await log(`waiting for ${plan.app.origin}${plan.app.health.path}`);
    const health = await waitForHealthy(plan, upstream, resolved.deadlineAtMs, input.signal);
    if (health !== "healthy") { await log(`unavailable: ${health}`); reason = health; return; }

    const launches = createLaunchContexts(resolved);
    if (launches.some((launch) => launch.selectedTarget.kind === "web")) {
      const mapped = input.localAppUpstream === undefined ? undefined : `MAP app:4317 ${new URL(input.localAppUpstream).host}`;
      browser = await launchLocalChromium({ downloadDir: join(outDir, "downloads"), signal: input.signal,
        ...(mapped === undefined ? {} : { hostResolverRules: mapped }), ...(input.chromiumExecutable === undefined ? {} : { executablePath: input.chromiumExecutable }) });
      await log("chromium is listening on loopback");
    }
    workDir = await mkdtemp(join(await realpath(tmpdir()), "rovara-executor-"));
    for (const launch of launches) {
      shards.push(await runShard({ resolved, launch, workDir, planPath: input.planPath, outDir, browser,
        appUpstream: input.localAppUpstream ?? null, redactor, signal: input.signal, log }));
    }
    const incomplete = shards.find((shard) => !shard.completed);
    if (incomplete) { reason = incomplete.reason ?? "shard-incomplete"; await log(`unavailable: ${reason}`); return; }
    if (shards.length === 1) await writeFile(join(outDir, "report.json"), redactor.text(shards[0]!.reportBytes!.toString("utf8")));
    else await writeFile(join(outDir, "report.json"), `${JSON.stringify({ schemaVersion: "e2e-executor-multi-report/v1", shards: shards.map((shard) => ({
      shardId: shard.shardId, report: JSON.parse(redactor.text(shard.reportBytes!.toString("utf8"))) as unknown })) })}\n`);
    exitCode = shards.some((shard) => shard.failed) ? 1 : 0;
    reason = null;
    await log(`run completed with exit code ${exitCode}`);
    return;
  };
  try {
    await main();
  } catch (error) {
    reason = input.signal.aborted ? "cancelled" : typeof (error as { reason?: unknown })?.reason === "string" ? (error as { reason: string }).reason : "internal-error";
    exitCode = 2;
    await log(`unavailable: ${reason}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`).catch(() => undefined);
  }
  await finish();
  return { exitCode, reason };
}
