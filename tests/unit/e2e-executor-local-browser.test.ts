import { afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runE2EExecutor } from "../../packages/verifier/src/executor/run.js";
import { blockedHosts, caseStatuses, csvRows, failedAssertionKinds, readReport, resultOf } from "../support/e2e-executor-output.js";
import { ORDERS_FIXTURE_ROOT, createOrdersExecutorPlan, type OrdersProbeName } from "../support/e2e-orders-executor-fixture.js";

// A real Chromium and the real fixture app on loopback, with the app origin mapped to it. It needs the built verifier
// (`npm run build`) and a Playwright Chromium (`npx playwright-core install chromium`), so it only runs on request:
//   ROVARA_LOCAL_BROWSER=1 npx vitest run tests/unit/e2e-executor-local-browser.test.ts
const enabled = process.env.ROVARA_LOCAL_BROWSER === "1";
const children: ChildProcess[] = [];
const dirs: string[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
  });
}

async function runProbe(probe: OrdersProbeName, options: { defect?: string; appEnv?: Record<string, string>; role?: "owner" | "viewer" } = {}) {
  const fixture = createOrdersExecutorPlan({ probe, ...(options.role ? { role: options.role } : {}) });
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "executor-local-")));
  dirs.push(dir);
  const app = join(dir, "app");
  await cp(ORDERS_FIXTURE_ROOT, app, { recursive: true });
  await mkdir(join(app, ".owned"));
  await writeFile(join(app, ".owned", "seed.json"), JSON.stringify(fixture.seed));
  if (options.defect) await cp(join(ORDERS_FIXTURE_ROOT, "defects", options.defect), join(app, ".owned", "defect.json"));
  const port = await freePort();
  const server = spawn(process.execPath, [join(app, "server.mjs")], { cwd: app, stdio: ["ignore", "ignore", "pipe"],
    env: { PATH: process.env.PATH ?? "", APP_PORT: String(port), ORDERS_TEST_SEED_FILE: join(app, ".owned", "seed.json"),
      ...(options.defect ? { ORDERS_TEST_DEFECT_FILE: join(app, ".owned", "defect.json") } : {}), ...options.appEnv } });
  children.push(server);
  let stderr = ""; server.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  await writeFile(join(dir, "plan.json"), JSON.stringify(fixture.plan));
  const outDir = join(dir, "out");
  const result = await runE2EExecutor({ planPath: join(dir, "plan.json"), outDir, signal: AbortSignal.timeout(240_000), localAppUpstream: `http://127.0.0.1:${port}` });
  server.kill("SIGTERM");
  // On a failure the assertion message carries everything the run left to explain it.
  const files = await readdir(outDir, { withFileTypes: true, recursive: true });
  for (const entry of files.filter((item) => item.isFile() && /(executor\.log|stderr\.txt|report\.json)$/.test(item.name))) {
    stderr += `\n--- ${entry.name}\n${(await readFile(join(entry.parentPath, entry.name), "utf8")).slice(0, 30000)}`;
  }
  return { fixture, outDir, result, stderr };
}

async function everything(dir: string): Promise<string> {
  const parts: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) parts.push((await readFile(join(entry.parentPath, entry.name))).toString("latin1"));
  }
  return parts.join("\n");
}

afterAll(async () => {
  for (const child of children) child.kill("SIGKILL");
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.runIf(enabled)("executor against a real Chromium and the fixture app (local, no Docker)", () => {
  it("web-csv-positive: Chromium downloads the exact CSV and nothing leaks", async () => {
    const run = await runProbe("web-csv-positive-v1");
    expect(run.result, run.stderr).toEqual({ exitCode: 0, reason: null });
    expect(caseStatuses(run.outDir, run.fixture)).toEqual({ "web-csv-positive-v1": "passed" });
    expect(csvRows(run.outDir)).toEqual([["id", "customer", "total", "state"], ["a1", "Ada", "12.5", "ready"], ["a2", "Grace", "23", "ready"]]);
    expect(readReport(run.outDir).run.summary).toMatchObject({ selected: 1, executed: 1, passed: 1, failed: 0 });
    const text = await everything(run.outDir);
    expect(text).not.toContain(run.fixture.account.password);
    expect(text).not.toContain(run.fixture.account.email);
  }, 300_000);

  it("web-csv-negative: the extra-order defect fails the csv assertion", async () => {
    const run = await runProbe("web-csv-positive-v1", { defect: "extra-order.json" });
    expect(run.result.exitCode).toBe(1);
    expect(failedAssertionKinds(run.outDir, run.fixture)).toEqual(["csv"]);
    expect(caseStatuses(run.outDir, run.fixture)["web-csv-positive-v1"]).toBe("failed");
  }, 300_000);

  it("web-egress-denial: an outside request is blocked, recorded, and cannot make the case pass", async () => {
    const run = await runProbe("web-egress-denial-v1", { appEnv: { FIXTURE_EGRESS_PROBE_URL: "https://probe.example.com/ping" } });
    expect(run.result.exitCode).toBe(1);
    expect(caseStatuses(run.outDir, run.fixture)["web-egress-denial-v1"]).not.toBe("passed");
    expect(blockedHosts(run.outDir)).toContain("probe.example.com");
  }, 300_000);

  it("third-party assets are blocked and recorded, not fatal", async () => {
    const run = await runProbe("web-csv-positive-v1", { appEnv: { FIXTURE_EXTERNAL_FONT: "https://fonts.example.com/a.css" } });
    expect(run.result.exitCode).toBe(0);
    expect(blockedHosts(run.outDir)).toContain("fonts.example.com");
  }, 300_000);

  it("api-state-positive passes through the owned HTTP client", async () => {
    const run = await runProbe("api-state-positive-v1");
    expect(run.result, run.stderr).toEqual({ exitCode: 0, reason: null });
    expect(caseStatuses(run.outDir, run.fixture)).toEqual({ "api-state-positive-v1": "passed" });
    expect(resultOf(run.outDir).exitCode).toBe(0);
    expect(await everything(run.outDir)).not.toContain(run.fixture.account.password);
  }, 300_000);
});

describe.skipIf(enabled)("executor against a real Chromium (local)", () => {
  it.skip("runs only with ROVARA_LOCAL_BROWSER=1", () => undefined);
});
