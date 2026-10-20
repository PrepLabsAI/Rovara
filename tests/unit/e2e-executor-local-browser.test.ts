import { afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runE2EExecutor } from "../../packages/verifier/src/executor/run.js";
import { listChromiumProcesses } from "../../packages/verifier/src/executor/chromium-sandbox.js";
import { launchLocalChromium } from "../../packages/verifier/src/executor/local-browser.js";
import { assembleDockerCollectionInputs, assembleExecutorActualRun, readExecutorResultFile, snapshotExecutorOutput } from "../../packages/verifier/src/host/executor-readback.js";
import { resolveE2EExecutorSuite } from "../../packages/verifier/src/executor/suite.js";
import { collectHostRun, proveActualRun } from "../support/e2e-actual-run-proof.js";
import { readShardReport, blockedHosts, caseStatuses, csvRows, failedAssertionKinds, readReport, resultOf } from "../support/e2e-executor-output.js";
import { standInChromiumSandbox } from "../support/local-executor-docker.js";
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

async function runProbe(probe: OrdersProbeName, options: { defect?: string; appEnv?: Record<string, string>; role?: "owner" | "viewer";
  /** Rewrites the copied app server, e.g. to break the page load while leaving the API alone. */ patchServer?: (source: string) => string } = {}) {
  const fixture = createOrdersExecutorPlan({ probe, ...(options.role ? { role: options.role } : {}) });
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "executor-local-")));
  dirs.push(dir);
  const app = join(dir, "app");
  await cp(ORDERS_FIXTURE_ROOT, app, { recursive: true });
  await mkdir(join(app, ".owned"));
  if (options.patchServer) await writeFile(join(app, "server.mjs"), options.patchServer(await readFile(join(app, "server.mjs"), "utf8")));
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
  const result = await runE2EExecutor({ planPath: join(dir, "plan.json"), outDir, signal: AbortSignal.timeout(240_000), localAppUpstream: `http://127.0.0.1:${port}`,
    // macOS has no /proc to read a sandbox from; on Linux the executor reads the real kernel's facts.
    ...(standInChromiumSandbox ? { inspectChromiumSandbox: standInChromiumSandbox } : {}) });
  server.kill("SIGTERM");
  // On a failure the assertion message carries everything the run left to explain it.
  const files = await readdir(outDir, { withFileTypes: true, recursive: true });
  for (const entry of files.filter((item) => item.isFile() && /(executor\.log|stderr\.txt|report\.json)$/.test(item.name))) {
    stderr += `\n--- ${entry.name}\n${(await readFile(join(entry.parentPath, entry.name), "utf8")).slice(0, 30000)}`;
  }
  return { fixture, outDir, result, stderr };
}

function readExecutorShardRunIds(outDir: string): (string | null)[] {
  return (JSON.parse(readFileSync(join(outDir, "executor-result.json"), "utf8")) as { shards: { upstreamRunId: string | null }[] }).shards.map((shard) => shard.upstreamRunId);
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
    // The file is bound to the run and shard it came from, which is what lets a registrar tie it to the collected evidence.
    const file = JSON.parse(readFileSync(join(run.outDir, "blocked-requests.json"), "utf8")) as { runId: string; groupId: string; shards: { shardId: string; upstreamRunId: string | null }[] };
    expect(file).toMatchObject({ runId: run.fixture.plan.runId, groupId: run.fixture.plan.groupId });
    expect(file.shards.map((shard) => shard.upstreamRunId)).toEqual(readExecutorShardRunIds(run.outDir));
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

/** What the Docker host does after a real run: read the out directory, then assemble the readback and collector inputs. */
async function assembleFrom(run: Awaited<ReturnType<typeof runProbe>>) {
  const snapshot = await snapshotExecutorOutput(run.outDir, await readExecutorResultFile(run.outDir));
  const resolved = resolveE2EExecutorSuite(run.fixture.plan);
  const cleanup = { removedAt: new Date().toISOString(), containers: ["rovara-app"], network: "rovara-e2e" };
  return { actual: assembleExecutorActualRun({ snapshot, compiled: resolved.suite, binding: resolved.binding, cleanup, evidenceDirectory: "/out" }),
    inputs: assembleDockerCollectionInputs({ snapshot, binding: resolved.binding, cleanup }) };
}

type Verdict = "PASS" | "FAILED" | "UNKNOWN";
/** probe, defect, what the real collector must say, and the one assertion kind that is the cause when it says FAILED. */
const verdicts: readonly (readonly [OrdersProbeName, string | undefined, Verdict, string | null])[] = [
  ["web-csv-positive-v1", undefined, "PASS", null],
  ["api-state-positive-v1", undefined, "PASS", null],
  ["web-csv-positive-v1", "extra-order.json", "FAILED", "csv"],
  ["api-status-mismatch-v1", undefined, "FAILED", "http-status"],
  // A state that stays on another value (a well-formed 2xx answer of the approved shape) until the poll times out is a definite mismatch (Ruling W). One that never
  // settles because the app answers non-2xx or malformed JSON is unavailable (UNKNOWN); that case needs an app that does so, and is covered in e2e-api-state-timeout.test.ts.
  ["api-state-positive-v1", "state-contract.json", "FAILED", "state"],
];

describe.runIf(enabled)("host readback of a real executor run (local, no Docker)", () => {
  it.each(verdicts)("%s (%s) collects as %s", async (probe, defect, verdict, cause) => {
    const run = await runProbe(probe, defect ? { defect } : {});
    const { actual, inputs } = await assembleFrom(run);
    const proof = proveActualRun(actual, run.fixture.plan);
    expect(proof.captures.map((capture) => capture.caseId)).toEqual(run.fixture.compiled.expectedCases.map((item) => item.caseId));
    const terminal = verdict === "PASS" ? "completed" : verdict === "FAILED" ? "assertion-failed" : "unavailable";
    expect(proof.captures.map((capture) => capture.terminal.kind)).toEqual([terminal]);
    // The real collector, with the protected inputs the host exposes, judges the run: no result is ever PASS without them.
    const collected = collectHostRun(actual, inputs, run.fixture.plan);
    expect(collected.qualification?.status ?? "UNKNOWN", collected.unavailableReason ?? "").toBe(verdict);
    if (verdict === "UNKNOWN") {
      expect(proof.captures.map((capture) => capture.assertions.map((assertion) => assertion.outcome))).toEqual([["unavailable"]]);
    } else {
      expect(collected.unavailableReason, collected.unavailableReason ?? "").toBeNull();
      const [result] = collected.qualification!.result!.cases;
      expect(result!.status).toBe(verdict === "PASS" ? "passed" : "failed");
      expect(result!.assertionReceipts.map((receipt) => [receipt.assertionIndex, receipt.status])).toEqual([[0, verdict === "PASS" ? "passed" : "failed"]]);
      expect(result!.assertionReceipts[0]!.assertionDigest).toBe(run.fixture.compiled.expectedCases[0]!.assertionDigests[0]);
    }
    if (verdict === "FAILED") {
      // The failing assertion is the cause, and the report's one failed step is its own `assertion` step at its own index.
      const scenario = run.fixture.compiled.bundle.scenarios[0]!;
      expect(scenario.assertions.map((assertion) => assertion.kind)).toEqual([cause]);
      const report = readReport(run.outDir).run.results[0]!.attempts[0]!;
      expect(report.steps.filter((step) => step.status === "failed").map((step) => [step.kind, step.index, step.label])).toEqual([["assertion", 0, "approved assertion 0"]]);
    }
    // The sealed capture is its own artifact and names the executor's original: the original bytes are in the readback and match the executor's file.
    const [sealed] = actual.applicationCaptures;
    const sealedEvidence = actual.supervisorReadback!.evidence.filter((item) => item.ref.artifactId.endsWith("-sealed"));
    expect(sealedEvidence).toHaveLength(1);
    const originalRef = sealed!.artifacts.find((ref) => ref.artifactId === sealedEvidence[0]!.ref.artifactId.replace(/-sealed$/, ""))!;
    expect(originalRef).toBeDefined();
    const original = actual.supervisorReadback!.evidence.find((item) => item.ref.artifactId === originalRef.artifactId)!;
    const onDisk = JSON.parse(readFileSync(join(run.outDir, "observations", `${originalRef.artifactId}.json`), "utf8")) as { sha256: string };
    expect(onDisk.sha256).toBe(originalRef.sha256);
    expect(createHash("sha256").update(original.bytes).digest("hex")).toBe(originalRef.sha256);
    const originalFrame = JSON.parse(Buffer.from(original.bytes).toString("utf8")) as { cleanup: string; coverage: unknown };
    expect(originalFrame.cleanup).toBe("pending");
    expect(sealed!.cleanup).toBe("confirmed");
    expect(actual.selected).toBe(1);
    expect(actual.filtered).toBe(0);
    const text = JSON.stringify([...actual.supervisorReadback!.evidence.map((item) => Buffer.from(item.bytes).toString("latin1")), actual.shards.map((shard) => Buffer.from(shard.rawReportBytes).toString("latin1"))]);
    expect(text).not.toContain(run.fixture.account.password);
    expect(text).not.toContain(run.fixture.account.email);
  }, 300_000);
});

describe.runIf(enabled)("a failure that is not an assertion is never FAILED (local, no Docker)", () => {
  it("a page that cannot be loaded fails no approved assertion step and leaves the run unavailable", async () => {
    // The page load is cut off at the socket while login and the API still work, so the case fails before any approved assertion is observed.
    const run = await runProbe("web-csv-positive-v1", { patchServer: (source) => {
      const patched = source.replace("const result = await app.handle(", 'if (request.url === "/") { request.socket.destroy(); return; }\n        const result = await app.handle(');
      if (patched === source) throw new Error("the fixture server changed shape; update this patch");
      return patched;
    } });
    // The runner classes a page that never loaded as an infrastructure failure: the executor reports no trustworthy result (exit 2),
    // which the host maps to an unavailable run and never reads, so it cannot collect as FAILED.
    expect(run.result.exitCode, run.stderr).toBe(2);
    expect(run.result.reason).toMatch(/^cli-run-exit-/);
    const [shard] = await readdir(join(run.outDir, "shards"));
    const report = readShardReport(join(run.outDir, "shards", shard!, "report.json"));
    const steps = report.run.results[0]!.attempts[0]!.steps;
    expect(steps.some((step) => step.status === "failed")).toBe(true);
    expect(steps.some((step) => step.status === "failed" && step.kind === "assertion")).toBe(false);
  }, 300_000);
});

describe.runIf(enabled)("Chromium's process list over its real DevTools endpoint (local)", () => {
  it("names the browser and at least one renderer, which is what the sandbox inspection reads /proc for", async () => {
    const downloads = join(await mkdtemp(join(tmpdir(), "chromium-list-")), "downloads"); dirs.push(downloads);
    const browser = await launchLocalChromium({ downloadDir: downloads, signal: AbortSignal.timeout(60_000) });
    try {
      const listing = await listChromiumProcesses(browser.cdpEndpoint, AbortSignal.timeout(60_000));
      expect(listing.browserPid).toBe(browser.pid);
      expect(listing.rendererPids.length).toBeGreaterThan(0);
      expect(listing.rendererPids).not.toContain(browser.pid);
    } finally { await browser.close(); }
  }, 120_000);
});

describe.skipIf(enabled)("executor against a real Chromium (local)", () => {
  it.skip("runs only with ROVARA_LOCAL_BROWSER=1", () => undefined);
});
