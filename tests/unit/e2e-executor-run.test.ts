import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E_EXECUTOR_HOST_DESCRIPTOR, E2E_EXECUTOR_HOST_ENTRY_POINT_ID, E2E_EXECUTOR_HOST_ENTRY_SOURCE, E2E_EXECUTOR_HOST_MODULE_PATH, E2E_EXECUTOR_HOST_PROFILE_ID, verifyExecutorHostRegistration } from "../../packages/verifier/src/executor/host-registry.js";
import { spawn } from "node:child_process";
import { startAppForwarder } from "../../packages/verifier/src/executor/app-forward.js";
import { listOutputFiles, runE2EExecutor } from "../../packages/verifier/src/executor/run.js";
import { createOrdersExecutorPlan } from "../support/e2e-orders-executor-fixture.js";
import { fakeChromium } from "../support/fake-chromium.js";
import { createServer } from "node:http";

type Registry = { hosts: { profileId: string; entryPointId: string; entryPointManifestDigest: string; modulePath: string }[] };
const repoRoot = join(import.meta.dirname, "../..");
const verifierRoot = join(repoRoot, "packages/verifier");
const registry = JSON.parse(await readFile(join(verifierRoot, "assets/application-runtime-v1/cli-hosts.json"), "utf8")) as Registry;
const cliHost: { profileId: string; descriptor: { entryPointId: string; entryPointManifestDigest: string } } = { profileId: E2E_EXECUTOR_HOST_PROFILE_ID, descriptor: { entryPointId: E2E_EXECUTOR_HOST_ENTRY_POINT_ID,
  entryPointManifestDigest: registry.hosts[0]!.entryPointManifestDigest } };
const dirs: string[] = [];
async function temp() { const dir = realpathSync(await mkdtemp(join(tmpdir(), "executor-run-test-"))); dirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function unavailableReason(root: string, host = cliHost): Promise<string> {
  const result = await verifyExecutorHostRegistration(host, { packageRoot: root });
  return result.available ? "available" : result.reason;
}
async function allText(dir: string): Promise<string> {
  const parts: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) parts.push((await readFile(join(entry.parentPath, entry.name))).toString("latin1"));
  }
  return parts.join("\n");
}
const built = existsSync(join(verifierRoot, E2E_EXECUTOR_HOST_MODULE_PATH));

describe("executor host registry", () => {
  it("names the one built-in host entry for web and API, pinned to the exact emitted module bytes", async () => {
    expect(registry.hosts).toHaveLength(1);
    expect(registry.hosts[0]).toMatchObject({ profileId: E2E_EXECUTOR_HOST_PROFILE_ID, entryPointId: E2E_EXECUTOR_HOST_ENTRY_POINT_ID,
      modulePath: E2E_EXECUTOR_HOST_MODULE_PATH });
    // The module is one re-export line, so its compiled bytes are the same everywhere and the digest is stable.
    const source = await readFile(join(verifierRoot, "src/executor/host-entry.ts"), "utf8");
    expect(source).toBe('export { createE2EApplicationCliHost } from "./host.js";\n');
    expect(createHash("sha256").update(source).digest("hex")).toBe(registry.hosts[0]!.entryPointManifestDigest);
  });

  it("gives the broker the same host descriptor without reading a file: the registry's row, and the module source itself", async () => {
    expect(E2E_EXECUTOR_HOST_DESCRIPTOR).toEqual({ entryPointId: registry.hosts[0]!.entryPointId, entryPointManifestDigest: registry.hosts[0]!.entryPointManifestDigest });
    expect(E2E_EXECUTOR_HOST_ENTRY_SOURCE).toBe(await readFile(join(verifierRoot, "src/executor/host-entry.ts"), "utf8"));
  });

  it.runIf(built)("reports the built host available", async () => {
    expect(await unavailableReason(verifierRoot)).toBe("available");
  });

  it("reports a missing registry, an unknown host and a changed module as unavailable instead of a file error", async () => {
    expect(await unavailableReason(await temp())).toContain("registry is not installed");
    const root = await temp();
    await mkdir(join(root, "assets/application-runtime-v1"), { recursive: true });
    await writeFile(join(root, "assets/application-runtime-v1/cli-hosts.json"), JSON.stringify({ schemaVersion: "application-cli-host-registry/v1", hosts: registry.hosts }));
    expect(await unavailableReason(root)).toContain("not built");
    await mkdir(join(root, "dist/executor"), { recursive: true });
    await writeFile(join(root, E2E_EXECUTOR_HOST_MODULE_PATH), "export {};\n");
    expect(await unavailableReason(root)).toContain("manifest digest");
    expect(await unavailableReason(root, { ...cliHost, profileId: "other-profile" })).toContain("does not register");
    await writeFile(join(root, "assets/application-runtime-v1/cli-hosts.json"), "not json");
    expect(await unavailableReason(root)).toContain("valid registry");
  });
});

describe("runE2EExecutor unavailable outcomes", () => {
  const signal = new AbortController().signal;
  it("exits 2 for an invalid plan and says why in its log", async () => {
    const dir = await temp(); const out = join(dir, "out");
    await writeFile(join(dir, "plan.json"), JSON.stringify({ schemaVersion: "e2e-executor-plan/v1", app: { origin: "http://example.com" } }));
    const result = await runE2EExecutor({ planPath: join(dir, "plan.json"), outDir: out, signal });
    expect(result).toEqual({ exitCode: 2, reason: "plan-invalid" });
    expect(await readFile(join(out, "executor.log"), "utf8")).toContain("plan-invalid");
    expect(JSON.parse(await readFile(join(out, "executor-result.json"), "utf8"))).toMatchObject({ exitCode: 2, reason: "plan-invalid" });
    // The blocked-requests file names the run it belongs to; a run that never resolved a plan has none to name.
    expect(JSON.parse(await readFile(join(out, "blocked-requests.json"), "utf8"))).toEqual({ schemaVersion: "e2e-executor-blocked-requests/v1", runId: null, groupId: null, shards: [], blocked: [] });
  });

  it.runIf(built)("exits 2 with app-unhealthy and leaves no credential in any output file", async () => {
    const fixture = createOrdersExecutorPlan({ probe: "api-state-positive-v1", healthTimeoutMs: 1_000 });
    const dir = await temp(); const out = join(dir, "out");
    await writeFile(join(dir, "plan.json"), JSON.stringify(fixture.plan));
    const result = await runE2EExecutor({ planPath: join(dir, "plan.json"), outDir: out, signal, localAppUpstream: "http://127.0.0.1:9" });
    expect(result).toEqual({ exitCode: 2, reason: "app-unhealthy" });
    expect(await readFile(join(out, "executor.log"), "utf8")).toContain("app-unhealthy");
    const blocked = JSON.parse(await readFile(join(out, "blocked-requests.json"), "utf8")) as { blocked: unknown[] };
    expect(blocked.blocked).toEqual([]);
    const everything = await allText(out);
    expect(everything).not.toContain(fixture.account.password);
    expect(everything).not.toContain(fixture.account.email);
  });
});

describe("executor failure handling", () => {
  it("reports an incomplete output scan when the tree is deeper than the scan bound", async () => {
    const dir = await temp();
    let deep = dir;
    for (let level = 0; level < 14; level += 1) { deep = join(deep, `d${level}`); await mkdir(deep); }
    await writeFile(join(deep, "file.txt"), "x");
    await writeFile(join(dir, "top.txt"), "x");
    const listing = await listOutputFiles(dir);
    expect(listing.complete).toBe(false);
    expect(listing.files).toContain(join(dir, "top.txt"));
    const shallow = await temp();
    await writeFile(join(shallow, "a.txt"), "x");
    expect((await listOutputFiles(shallow)).complete).toBe(true);
  });

  it("turns a listener failure after startup into a callback instead of an unhandled error event", async () => {
    const errors: Error[] = [];
    const forwarder = await startAppForwarder({ listen: { host: "127.0.0.1", port: 0 }, upstream: { host: "127.0.0.1", port: 9 }, onError: (error) => errors.push(error) });
    forwarder.server.emit("error", new Error("listener died"));
    expect(errors.map((error) => error.message)).toEqual(["listener died"]);
    await forwarder.close();
  });

  it.runIf(built)("exits 2, never 1, when the process crashes outside the run", async () => {
    const fixture = createOrdersExecutorPlan({ probe: "api-state-positive-v1", healthTimeoutMs: 5_000 });
    const dir = await temp();
    await writeFile(join(dir, "plan.json"), JSON.stringify(fixture.plan));
    const entry = join(verifierRoot, "dist/executor/entry.js");
    const child = spawn(process.execPath, ["--import", "data:text/javascript,setTimeout(() => Promise.reject(new Error('preload boom')), 400)",
      entry, join(dir, "plan.json"), join(dir, "out")], { stdio: ["ignore", "ignore", "pipe"], env: { PATH: process.env.PATH ?? "" } });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    expect(code).toBe(2);
    expect(stderr).toContain("executor crashed");
  }, 60_000);
});

describe.runIf(built)("executor Chromium sandbox gate", () => {
  const signal = new AbortController().signal;
  const processFacts = { nsPidDepth: 1, seccompFilters: 1, uidMap: "0 0 4294967295" };
  /** What the kernel would show: an ordinary child process of the browser (a --no-sandbox renderer), or one behind its own filter and namespaces. */
  const attestationFor = (kind: "plain" | "sandboxed") => async (request: { runId: string; groupId: string; cdpEndpoint?: string }) => ({ schemaVersion: "e2e-executor-chromium-sandbox/v1" as const,
    runId: request.runId, groupId: request.groupId, browser: { pid: 40, ...processFacts },
    renderers: [kind === "plain" ? { pid: 41, ...processFacts } : { pid: 41, nsPidDepth: 2, seccompFilters: 2, uidMap: "0 1000 1" }] });

  async function runWebExecutor(inspectChromiumSandbox: (request: { runId: string; groupId: string; cdpEndpoint?: string }) => Promise<unknown>, settleMs = 0, deadlineMs?: number) {
    const fixture = createOrdersExecutorPlan({ probe: "web-csv-positive-v1", healthTimeoutMs: 5_000, ...(deadlineMs === undefined ? {} : { deadlineMs }) });
    const dir = await temp(); const out = join(dir, "out");
    await writeFile(join(dir, "plan.json"), JSON.stringify(fixture.plan));
    const app = createServer((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); });
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    const chromium = await fakeChromium("listen"); dirs.push(chromium.directory);
    try {
      const result = await runE2EExecutor({ planPath: join(dir, "plan.json"), outDir: out, signal, localAppUpstream: `http://127.0.0.1:${(app.address() as { port: number }).port}`,
        chromiumExecutable: chromium.executable, inspectChromiumSandbox: inspectChromiumSandbox as never, chromiumSandboxSettleMs: settleMs });
      return { fixture, out, result, launches: await chromium.launches() };
    } finally { await new Promise<void>((resolve) => app.close(() => resolve())); }
  }

  it("exits 2 with chromium-unsandboxed when a renderer shows no sandbox, before any case runs, and keeps the facts it saw", async () => {
    const seen: { runId: string; groupId: string; cdpEndpoint?: string }[] = [];
    const { fixture, out, result, launches } = await runWebExecutor(async (request) => { seen.push(request); return attestationFor("plain")(request); });
    expect(result).toEqual({ exitCode: 2, reason: "chromium-unsandboxed" });
    expect(launches).toHaveLength(1);
    expect(launches[0]!.filter((arg) => /sandbox/i.test(arg))).toEqual([]);
    expect(seen.map((request) => [request.runId, request.groupId, request.cdpEndpoint])).toEqual([[fixture.plan.runId, fixture.plan.groupId, "ws://127.0.0.1:9222/devtools/browser/abc"]]);
    expect(JSON.parse(await readFile(join(out, "chromium-sandbox.json"), "utf8"))).toMatchObject({ schemaVersion: "e2e-executor-chromium-sandbox/v1", runId: fixture.plan.runId, groupId: fixture.plan.groupId });
    expect(await readFile(join(out, "executor.log"), "utf8")).toContain("chromium-unsandboxed: renderer-has-no-extra-seccomp-filter");
    expect(JSON.parse(await readFile(join(out, "executor-result.json"), "utf8"))).toMatchObject({ exitCode: 2, reason: "chromium-unsandboxed", shards: [] });
  });

  it("waits for a renderer that has not yet installed its seccomp filter instead of judging the first look", async () => {
    let looks = 0;
    const { result, out } = await runWebExecutor(async (request) => { looks += 1; return attestationFor(looks < 3 ? "plain" : "sandboxed")(request); }, 5_000);
    expect(looks).toBe(3);
    expect(result.reason).not.toMatch(/^chromium-/);
    expect(JSON.parse(await readFile(join(out, "chromium-sandbox.json"), "utf8"))).toMatchObject({ renderers: [{ nsPidDepth: 2, seccompFilters: 2 }] });
  });

  it("never settles past the run deadline: a long settle time is cut to what the run has left", async () => {
    const started = Date.now();
    const { result } = await runWebExecutor(async (request) => attestationFor("plain")(request), 600_000, 4_000);
    expect(result.exitCode).toBe(2);
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  it("exits 2 with chromium-sandbox-unverifiable when the kernel cannot show it (no procfs, an old kernel), never assuming a sandbox", async () => {
    const { out, result } = await runWebExecutor(async () => { throw new Error("cannot read /proc/40/status"); });
    expect(result).toEqual({ exitCode: 2, reason: "chromium-sandbox-unverifiable" });
    expect(await readFile(join(out, "executor.log"), "utf8")).toContain("cannot read /proc/40/status");
  });

  it("goes on to run the cases when every renderer is sandboxed, and records the attestation next to the run", async () => {
    const { fixture, out, result } = await runWebExecutor(attestationFor("sandboxed"));
    // The stand-in browser cannot run a case, so the run ends for another reason; what matters is that the gate let it past.
    expect(result.reason).not.toMatch(/^chromium-/);
    expect(JSON.parse(await readFile(join(out, "chromium-sandbox.json"), "utf8"))).toMatchObject({ runId: fixture.plan.runId, renderers: [{ nsPidDepth: 2, seccompFilters: 2 }] });
  });

  it("does not look for a sandbox in an API-only run, which launches no browser", async () => {
    const fixture = createOrdersExecutorPlan({ probe: "api-state-positive-v1", healthTimeoutMs: 1_000 });
    const dir = await temp(); const out = join(dir, "out");
    await writeFile(join(dir, "plan.json"), JSON.stringify(fixture.plan));
    let inspected = false;
    await runE2EExecutor({ planPath: join(dir, "plan.json"), outDir: out, signal, localAppUpstream: "http://127.0.0.1:9", inspectChromiumSandbox: async () => { inspected = true; throw new Error("unexpected"); } });
    expect(inspected).toBe(false);
    expect(existsSync(join(out, "chromium-sandbox.json"))).toBe(false);
  });
});
