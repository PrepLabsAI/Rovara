import { execFile, spawn } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ORDERS_FIXTURE_ROOT, createOrdersExecutorPlan, type OrdersExecutorFixture, type OrdersProbeName } from "./e2e-orders-executor-fixture.js";

const execFileAsync = promisify(execFile);
/** The same pinned base the executor image is built from; the fixture app needs nothing but Node. */
export const APP_NODE_IMAGE = "public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5";
export const EXECUTOR_IMAGE = process.env.ROVARA_EXECUTOR_IMAGE ?? "rovara-e2e-executor:ci";

async function docker(args: string[], options: { allowFailure?: boolean; timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("docker", args, { timeout: options.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    if (!options.allowFailure) throw new Error(`docker ${args.slice(0, 3).join(" ")} failed: ${failure.stderr ?? String(error)}`, { cause: error });
    return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

function runForeground(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout = `${stdout}${chunk.toString()}`.slice(-65_536); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-65_536); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("executor container exceeded the test timeout")); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}

export type ProbeOptions = Readonly<{
  /** A defect file name under tests/fixtures/e2e-web-api-app/defects, mounted as ORDERS_TEST_DEFECT_FILE. */
  defect: string | null;
  appEnv?: Record<string, string>;
  /** Replaces the app container's command, e.g. to make it exit at once. */
  appCommand?: string[];
  healthTimeoutMs?: number;
}>;
export type ProbeRun = Readonly<{ exitCode: number; outDir: string; fixture: OrdersExecutorFixture; executorLogTail: string; appLogTail: string }>;

const probeDirs: string[] = [];
/**
 * The executor writes the out directory as its own unprivileged user, so the runner user cannot unlink those files. A
 * throwaway root container removes them (no network, nothing else mounted), then the leftover empty directory goes.
 */
export async function removeProbeDirs(): Promise<void> {
  for (const dir of probeDirs.splice(0)) {
    await docker(["run", "--rm", "--network", "none", "--user", "0:0", "--entrypoint", "rm", "-v", `${dir}:/d`, EXECUTOR_IMAGE, "-rf", "/d/out"], { allowFailure: true });
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Runs one compiled probe the way the worker will: a per-run `--internal` network, the fixture app on it with the alias
 * `app`, and the executor image with the plan mounted read-only and an empty writable out directory. Everything carries the
 * label `rovara.run=<runId>` and is removed by that label when the run ends.
 */
export async function runProbe(probe: OrdersProbeName, options: ProbeOptions): Promise<ProbeRun> {
  const fixture = createOrdersExecutorPlan({ probe, ...(options.healthTimeoutMs ? { healthTimeoutMs: options.healthTimeoutMs } : {}) });
  const runId = fixture.plan.runId;
  const label = `rovara.run=${runId}`;
  const network = `rovara-e2e-${runId}`;
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "rovara-linux-probe-")));
  probeDirs.push(dir);
  const app = join(dir, "app"); const owned = join(dir, "owned"); const outDir = join(dir, "out");
  // A copy keeps the repository clean and gives the nested read-only mounts a mount point that already exists.
  await cp(ORDERS_FIXTURE_ROOT, app, { recursive: true });
  await mkdir(join(app, ".owned"));
  await mkdir(owned); await mkdir(outDir);
  await writeFile(join(owned, "seed.json"), JSON.stringify(fixture.seed));
  if (options.defect) await cp(join(ORDERS_FIXTURE_ROOT, "defects", options.defect), join(owned, "defect.json"));
  await writeFile(join(dir, "plan.json"), JSON.stringify(fixture.plan));
  await chmod(outDir, 0o777); await chmod(join(dir, "plan.json"), 0o644);
  const appName = `rovara-app-${runId}`; const executorName = `rovara-executor-${runId}`;
  const hardening = ["--cap-drop=ALL", "--security-opt", "no-new-privileges", "--label", label, "--network", network];
  try {
    await docker(["network", "create", "--internal", "--label", label, network]);
    await docker(["run", "-d", "--name", appName, ...hardening, "--network-alias", "app", "--read-only", "--tmpfs", "/tmp:rw,size=64m", "--user", "1000:1000",
      "-v", `${app}:/app:ro`, "-v", `${owned}:/app/.owned:ro`, "-w", "/app",
      "-e", "APP_PORT=4317", "-e", "ORDERS_TEST_SEED_FILE=/app/.owned/seed.json",
      ...(options.defect ? ["-e", "ORDERS_TEST_DEFECT_FILE=/app/.owned/defect.json"] : []),
      ...Object.entries(options.appEnv ?? {}).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
      APP_NODE_IMAGE, ...(options.appCommand ?? ["node", "server.mjs"])]);
    const executor = await runForeground(["run", "--name", executorName, ...hardening, "--init", "--read-only", "--shm-size", "1g", "--tmpfs", "/tmp:rw,exec,size=512m",
      "-v", `${join(dir, "plan.json")}:/run/rovara/plan.json:ro`, "-v", `${outDir}:/out`, EXECUTOR_IMAGE], 280_000);
    const appLogTail = (await docker(["logs", "--tail", "100", appName], { allowFailure: true })).stderr.slice(-8192);
    const executorLogTail = `${executor.stdout}${executor.stderr}`.slice(-8192);
    return { exitCode: executor.code, outDir, fixture, executorLogTail, appLogTail };
  } finally {
    const owned = (await docker(["ps", "-aq", "--filter", `label=${label}`], { allowFailure: true })).stdout.split("\n").filter(Boolean);
    if (owned.length > 0) await docker(["rm", "-f", ...owned], { allowFailure: true });
    await docker(["network", "rm", network], { allowFailure: true });
    await rm(join(dir, "app"), { recursive: true, force: true }).catch(() => undefined);
  }
}
