import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2EPolicySchema } from "@agentx/contracts";
import { CAPTURE_ARTIFACTS_FILE, CAPTURE_DIR, CAPTURE_GROUP_BUDGET_BYTES, CAPTURE_SCREENSHOT_MAX_BYTES, CAPTURE_TRACE_MAX_BYTES,
  createCaptureRecorder, finalizeCaptureArtifacts, type CaptureEntry } from "../../packages/verifier/src/executor/capture.js";
import { createFileCaseLedger } from "../../packages/verifier/src/executor/case-ledger.js";
import { snapshotExecutorOutput } from "../../packages/verifier/src/host/executor-readback.js";
import { createCredentialRedactor } from "../../packages/verifier/src/executor/redact.js";
import { readZip, writeZip } from "../../packages/verifier/src/executor/zip.js";
import { finishWebCaseCapture, startWebCaseTrace, type E2EWebCapturePorts } from "../../packages/verifier/src/web-runtime.js";
import { webApiApplicationLaunchTarget } from "../../packages/verifier/src/web-api-launch-target.js";
import { validateE2EApplicationLaunchTarget } from "../../packages/verifier/src/application-scenarios.js";
import { webApiRow, PROFILE } from "../support/e2e-application-plan-fixtures.js";
import { E2E_EXECUTOR_HOST_MODULE_PATH } from "../../packages/verifier/src/executor/host-registry.js";
import { runE2EExecutor } from "../../packages/verifier/src/executor/run.js";
import { createOrdersExecutorPlan } from "../support/e2e-orders-executor-fixture.js";
import { fakeChromium } from "../support/fake-chromium.js";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
async function temp(): Promise<string> { const dir = await realpath(await mkdtemp(join(tmpdir(), "capture-test-"))); roots.push(dir); return dir; }
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const PASSWORD = "planted-Password-7f3a91c2d4e8b0aa";
const EMAIL = "rovara-orders-owner-ab12cd@example.test";
const accounts = [{ profileId: "orders-owner", email: EMAIL, password: PASSWORD }];
const caseIds = ["case-a", "case-b", "case-c", "case-d", "case-e", "case-f", "case-g"];
const ON = { screenshots: true, traces: true };
/** A JPEG-looking blob of exactly `size` bytes. */
const jpeg = (size: number, fill = 0x41) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size - 4, fill)]);
/** A trace-shaped archive whose entries are deflated, as Playwright's are, so a credential in one is invisible to a scan of the archive's own bytes. */
const trace = (entries: Record<string, string | Buffer>, padTo = 0) => {
  const files = Object.entries(entries).map(([name, data]) => ({ name, data: Buffer.from(data) }));
  const archive = writeZip(files);
  // Incompressible padding as a stored-looking resource keeps the archive near a target size without making the test slow.
  return padTo > archive.byteLength ? writeZip([...files, { name: "resources/pad.bin", data: Buffer.alloc(padTo - archive.byteLength - 200, 0x5a), store: true }]) : archive;
};
const redactor = () => createCredentialRedactor(accounts);
const listing = async (dir: string) => (await readdir(dir, { recursive: true })).sort();

describe("zip reader and writer", () => {
  it("round-trips deflated and stored entries", () => {
    const archive = writeZip([{ name: "trace.trace", data: Buffer.from("{\"a\":1}\n".repeat(50)) }, { name: "resources/x.bin", data: Buffer.from([1, 2, 3]), store: true }]);
    const entries = readZip(archive)!;
    expect(entries.map((entry) => entry.name)).toEqual(["trace.trace", "resources/x.bin"]);
    expect(Buffer.from(entries[0]!.data).toString()).toBe("{\"a\":1}\n".repeat(50));
    expect([...entries[1]!.data]).toEqual([1, 2, 3]);
  });
  it("reads nothing from bytes that are not a whole archive", () => {
    expect(readZip(Buffer.from("not a zip"))).toBeNull();
    const archive = writeZip([{ name: "a", data: Buffer.from("hello") }]);
    expect(readZip(archive.subarray(0, archive.byteLength - 10))).toBeNull();
  });
});

describe("credential redactor, deep scan", () => {
  it("finds a password that only exists inside a deflated archive entry, which a scan of the archive's bytes misses", () => {
    const archive = trace({ "trace.network": `{"url":"http://app/login","body":"password=${PASSWORD}"}`.repeat(3) });
    const r = redactor();
    expect(r.contains(archive)).toBe(false);
    expect(r.containsDeep(archive)).toBe(true);
  });
  it("finds the email, and every spelling, inside an entry", () => {
    const r = redactor();
    for (const secret of [EMAIL, encodeURIComponent(PASSWORD), Buffer.from(PASSWORD).toString("base64")]) {
      expect(r.containsDeep(trace({ "trace.trace": `x${secret}y` }))).toBe(true);
    }
  });
  it("treats an archive it cannot read in full as a match, never as clean", () => {
    const archive = writeZip([{ name: "a", data: Buffer.from("clean") }]);
    expect(redactor().containsDeep(archive)).toBe(false);
    // Cut off before its directory, it still starts like an archive but cannot be read, so it cannot be shown clean.
    expect(redactor().containsDeep(archive.subarray(0, archive.byteLength - 30))).toBe(true);
    expect(redactor().containsDeep(Buffer.from("plain bytes"))).toBe(false);
  });
  it("scrubs a session secret out of archive entries and leaves a readable archive", () => {
    const r = redactor();
    r.addSessionSecret("sess-token-0123456789abcdef");
    const archive = trace({ "trace.network": '{"headers":[{"name":"cookie","value":"orders_session=sess-token-0123456789abcdef"}]}', "trace.trace": "no secret here" });
    expect(r.containsDeep(archive)).toBe(true);
    const scrubbed = r.scrubSession(archive);
    expect(r.containsDeep(scrubbed)).toBe(false);
    const entries = readZip(scrubbed)!;
    expect(Buffer.from(entries.find((entry) => entry.name === "trace.network")!.data).toString()).toContain("orders_session=<session>");
    expect(Buffer.from(entries.find((entry) => entry.name === "trace.trace")!.data).toString()).toBe("no secret here");
  });
  it("does not let a session secret hide an account credential from the account-only scan", () => {
    const r = redactor();
    r.addSessionSecret("sess-token-0123456789abcdef");
    expect(r.containsDeep(trace({ "trace.trace": "sess-token-0123456789abcdef" }), "accounts")).toBe(false);
    expect(r.containsDeep(trace({ "trace.trace": PASSWORD }), "accounts")).toBe(true);
  });
});

describe("capture recorder", () => {
  it("stores a screenshot and a trace as case-<index>-<kind>.<ext>, never under scenario text or account names", async () => {
    const root = await temp();
    const recorder = createCaptureRecorder({ root, policy: ON, caseIds, redactor: redactor() });
    const shot = jpeg(1000); const archive = trace({ "trace.trace": "steps" });
    await expect(recorder.record({ caseId: "case-c", kind: "screenshot", bytes: shot })).resolves.toEqual({ caseId: "case-c", kind: "screenshot", sha256: sha(shot), bytes: 1000 });
    const stored = await recorder.record({ caseId: "case-c", kind: "trace", bytes: archive });
    expect(stored).toMatchObject({ caseId: "case-c", kind: "trace", bytes: archive.byteLength });
    expect(stored).not.toHaveProperty("omitted");
    expect((await readdir(join(root, CAPTURE_DIR))).filter((name) => name !== "entries").sort()).toEqual(["case-2-screenshot.jpg", "case-2-trace.zip"]);
    expect(await readFile(join(root, CAPTURE_DIR, "case-2-screenshot.jpg"))).toEqual(shot);
    expect(JSON.stringify(await listing(root))).not.toMatch(/orders-owner|case-c/);
  });

  it("writes nothing at all when capture is off, whatever it is asked", async () => {
    const root = await temp();
    const recorder = createCaptureRecorder({ root, policy: { screenshots: false, traces: false }, caseIds, redactor: redactor() });
    expect(recorder.enabled("screenshot")).toBe(false);
    expect(recorder.enabled("trace")).toBe(false);
    await expect(recorder.record({ caseId: "case-a", kind: "screenshot", bytes: jpeg(100) })).resolves.toBeNull();
    await expect(recorder.record({ caseId: "case-a", kind: "trace", bytes: trace({ a: "b" }) })).resolves.toBeNull();
    expect(await readdir(root)).toEqual([]);
  });

  it("records only the admitted kind", async () => {
    const root = await temp();
    const recorder = createCaptureRecorder({ root, policy: { screenshots: true, traces: false }, caseIds, redactor: redactor() });
    await expect(recorder.record({ caseId: "case-a", kind: "trace", bytes: trace({ a: "b" }) })).resolves.toBeNull();
    await expect(recorder.record({ caseId: "case-a", kind: "screenshot", bytes: jpeg(100) })).resolves.toMatchObject({ kind: "screenshot" });
    expect((await readdir(join(root, CAPTURE_DIR))).filter((name) => /trace/.test(name))).toEqual([]);
  });

  it("holds a screenshot to 524288 bytes and a trace to 4194304, recording the drop as budget and writing no file", async () => {
    const root = await temp();
    const recorder = createCaptureRecorder({ root, policy: ON, caseIds, redactor: redactor() });
    expect(CAPTURE_SCREENSHOT_MAX_BYTES).toBe(524_288);
    expect(CAPTURE_TRACE_MAX_BYTES).toBe(4_194_304);
    const exact = jpeg(CAPTURE_SCREENSHOT_MAX_BYTES);
    await expect(recorder.record({ caseId: "case-a", kind: "screenshot", bytes: exact })).resolves.not.toHaveProperty("omitted");
    const tooBig = jpeg(CAPTURE_SCREENSHOT_MAX_BYTES + 1);
    await expect(recorder.record({ caseId: "case-b", kind: "screenshot", bytes: tooBig })).resolves.toEqual({ caseId: "case-b", kind: "screenshot", sha256: sha(tooBig), bytes: tooBig.byteLength, omitted: "budget" });
    const hugeTrace = trace({ "trace.trace": "x" }, CAPTURE_TRACE_MAX_BYTES + 1024);
    await expect(recorder.record({ caseId: "case-b", kind: "trace", bytes: hugeTrace })).resolves.toMatchObject({ omitted: "budget", bytes: hugeTrace.byteLength });
    expect((await readdir(join(root, CAPTURE_DIR))).filter((name) => name !== "entries")).toEqual(["case-0-screenshot.jpg"]);
  });

  it("drops a trace that carries a seeded password, found inside the deflated archive, and stores no byte of it", async () => {
    const root = await temp();
    const recorder = createCaptureRecorder({ root, policy: ON, caseIds, redactor: redactor() });
    const planted = trace({ "trace.network": `{"postData":"email=${EMAIL}&password=${PASSWORD}"}`, "trace.trace": "ok" });
    const entry = await recorder.record({ caseId: "case-a", kind: "trace", bytes: planted });
    expect(entry).toMatchObject({ caseId: "case-a", kind: "trace", omitted: "credential-match" });
    const everything = (await Promise.all((await listing(root)).map(async (name) => {
      const path = join(root, name);
      return (await stat(path)).isFile() ? (await readFile(path)).toString("latin1") : "";
    }))).join("\n");
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain(EMAIL);
    expect((await readdir(join(root, CAPTURE_DIR))).filter((name) => name.endsWith(".zip"))).toEqual([]);
  });

  it("drops a screenshot whose bytes carry a credential", async () => {
    const root = await temp();
    const recorder = createCaptureRecorder({ root, policy: ON, caseIds, redactor: redactor() });
    const entry = await recorder.record({ caseId: "case-a", kind: "screenshot", bytes: Buffer.concat([jpeg(200), Buffer.from(PASSWORD)]) });
    expect(entry).toMatchObject({ omitted: "credential-match" });
    expect((await readdir(join(root, CAPTURE_DIR))).filter((name) => name.endsWith(".jpg"))).toEqual([]);
  });

  it("scrubs the run's session cookie from a trace and stores the rest", async () => {
    const root = await temp();
    const r = redactor();
    r.addSessionSecret("sess-token-0123456789abcdef");
    const recorder = createCaptureRecorder({ root, policy: ON, caseIds, redactor: r });
    const entry = await recorder.record({ caseId: "case-a", kind: "trace", bytes: trace({ "trace.network": '{"cookie":"orders_session=sess-token-0123456789abcdef"}' }) });
    expect(entry).not.toHaveProperty("omitted");
    const stored = await readFile(join(root, CAPTURE_DIR, "case-0-trace.zip"));
    expect(r.containsDeep(stored)).toBe(false);
    expect(Buffer.from(readZip(stored)![0]!.data).toString()).toContain("orders_session=<session>");
    expect(entry!.sha256).toBe(sha(stored));
    expect(entry!.bytes).toBe(stored.byteLength);
  });

  it("refuses a case that is not in the plan", async () => {
    const recorder = createCaptureRecorder({ root: await temp(), policy: ON, caseIds, redactor: redactor() });
    await expect(recorder.record({ caseId: "unknown", kind: "screenshot", bytes: jpeg(100) })).rejects.toThrow(/unknown case/);
  });
});

describe("finalizing a group's captures", () => {
  async function seed(root: string, items: Array<{ caseId: string; kind: "screenshot" | "trace"; size: number }>) {
    const recorder = createCaptureRecorder({ root, policy: ON, caseIds, redactor: redactor() });
    for (const item of items) {
      await recorder.record({ caseId: item.caseId, kind: item.kind, bytes: item.kind === "screenshot" ? jpeg(item.size) : trace({ "trace.trace": item.caseId }, item.size) });
    }
  }
  const artifactsOf = async (root: string) => (JSON.parse(await readFile(join(root, CAPTURE_ARTIFACTS_FILE), "utf8")) as { schemaVersion: string; artifacts: CaptureEntry[] });

  it("lists every artifact as { caseId, kind, sha256, bytes, omitted? } in artifacts.json", async () => {
    const root = await temp();
    await seed(root, [{ caseId: "case-a", kind: "screenshot", size: 4096 }, { caseId: "case-a", kind: "trace", size: 8192 }]);
    await finalizeCaptureArtifacts({ outDir: root, policy: ON, caseIds, redactor: redactor() });
    const { schemaVersion, artifacts } = await artifactsOf(root);
    expect(schemaVersion).toBe("e2e-executor-artifacts/v1");
    expect(artifacts).toHaveLength(2);
    for (const artifact of artifacts) {
      expect(Object.keys(artifact).sort()).toEqual(["bytes", "caseId", "kind", "sha256"]);
      const file = await readFile(join(root, CAPTURE_DIR, `case-0-${artifact.kind}.${artifact.kind === "trace" ? "zip" : "jpg"}`));
      expect(artifact).toMatchObject({ caseId: "case-a", sha256: sha(file), bytes: file.byteLength });
    }
    // The recorder's working files are not left behind.
    expect(await readdir(join(root, CAPTURE_DIR))).not.toContain("entries");
  });

  it("drops the trace first when the set is 7 MiB, records budget, and touches no verdict file", async () => {
    const root = await temp();
    const resultBytes = JSON.stringify({ schemaVersion: "e2e-executor-result/v1", exitCode: 1, reason: null });
    await writeFile(join(root, "executor-result.json"), resultBytes);
    await seed(root, [{ caseId: "case-a", kind: "trace", size: CAPTURE_TRACE_MAX_BYTES },
      ...caseIds.slice(0, 6).map((caseId) => ({ caseId, kind: "screenshot" as const, size: CAPTURE_SCREENSHOT_MAX_BYTES }))]);
    const before = (await Promise.all((await readdir(join(root, CAPTURE_DIR))).filter((n) => n !== "entries").map(async (n) => (await stat(join(root, CAPTURE_DIR, n))).size))).reduce((a, b) => a + b, 0);
    expect(before).toBeGreaterThan(7 * 1024 * 1024 - 64 * 1024);
    const entries = await finalizeCaptureArtifacts({ outDir: root, policy: ON, caseIds, redactor: redactor() });
    expect(entries.find((entry) => entry.kind === "trace")).toMatchObject({ caseId: "case-a", omitted: "budget" });
    expect(entries.filter((entry) => entry.kind === "screenshot").every((entry) => entry.omitted === undefined)).toBe(true);
    const names = (await readdir(join(root, CAPTURE_DIR)));
    expect(names.some((name) => name.endsWith(".zip"))).toBe(false);
    expect(names.filter((name) => name.endsWith(".jpg"))).toHaveLength(6);
    expect((await artifactsOf(root)).artifacts).toEqual(entries);
    expect(await readFile(join(root, "executor-result.json"), "utf8")).toBe(resultBytes);
  });

  it("then drops screenshots from the last case back, only until the set fits", async () => {
    const root = await temp();
    // 13 screenshots of 512 KiB would be 6.5 MiB; the budget is 6 MiB, so exactly one goes: the last case's.
    const many = Array.from({ length: 13 }, (_, index) => `case-${index}`);
    const recorder = createCaptureRecorder({ root, policy: ON, caseIds: many, redactor: redactor() });
    for (const caseId of many) await recorder.record({ caseId, kind: "screenshot", bytes: jpeg(CAPTURE_SCREENSHOT_MAX_BYTES, caseId.length) });
    expect(CAPTURE_GROUP_BUDGET_BYTES).toBe(6 * 1024 * 1024);
    const entries = await finalizeCaptureArtifacts({ outDir: root, policy: ON, caseIds: many, redactor: redactor() });
    expect(entries.filter((entry) => entry.omitted !== undefined)).toEqual([expect.objectContaining({ caseId: "case-12", omitted: "budget" })]);
  });

  it("keeps at most one trace per group", async () => {
    const root = await temp();
    await seed(root, [{ caseId: "case-b", kind: "trace", size: 2000 }, { caseId: "case-a", kind: "trace", size: 2000 }]);
    const entries = await finalizeCaptureArtifacts({ outDir: root, policy: ON, caseIds, redactor: redactor() });
    expect(entries.filter((entry) => entry.omitted === undefined)).toEqual([expect.objectContaining({ caseId: "case-a", kind: "trace" })]);
    expect(entries.filter((entry) => entry.omitted === "budget")).toEqual([expect.objectContaining({ caseId: "case-b", kind: "trace" })]);
    expect((await readdir(join(root, CAPTURE_DIR))).filter((name) => name.endsWith(".zip"))).toEqual(["case-0-trace.zip"]);
  });

  it("drops a stored capture that turns out to carry a credential, instead of failing the run", async () => {
    const root = await temp();
    await seed(root, [{ caseId: "case-a", kind: "screenshot", size: 1024 }]);
    // Something wrote a credential into the file after the recorder checked it.
    await writeFile(join(root, CAPTURE_DIR, "case-0-screenshot.jpg"), Buffer.concat([jpeg(100), Buffer.from(PASSWORD)]));
    const entries = await finalizeCaptureArtifacts({ outDir: root, policy: ON, caseIds, redactor: redactor() });
    expect(entries).toEqual([expect.objectContaining({ caseId: "case-a", omitted: "credential-match" })]);
    expect((await readdir(join(root, CAPTURE_DIR))).filter((name) => name.endsWith(".jpg"))).toEqual([]);
  });

  it("writes nothing when capture is off", async () => {
    const root = await temp();
    await expect(finalizeCaptureArtifacts({ outDir: root, policy: { screenshots: false, traces: false }, caseIds, redactor: redactor() })).resolves.toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  it("removes a kind that was not admitted, should a file of it ever appear", async () => {
    const root = await temp();
    await seed(root, [{ caseId: "case-a", kind: "screenshot", size: 1024 }, { caseId: "case-a", kind: "trace", size: 2048 }]);
    const entries = await finalizeCaptureArtifacts({ outDir: root, policy: { screenshots: true, traces: false }, caseIds, redactor: redactor() });
    expect(entries.map((entry) => entry.kind)).toEqual(["screenshot"]);
    expect((await readdir(join(root, CAPTURE_DIR))).filter((name) => name.endsWith(".zip"))).toEqual([]);
  });

  it("lists an empty set when capture is on and nothing failed", async () => {
    const root = await temp();
    await expect(finalizeCaptureArtifacts({ outDir: root, policy: ON, caseIds, redactor: redactor() })).resolves.toEqual([]);
    expect((await artifactsOf(root)).artifacts).toEqual([]);
  });
});

describe("the admitted capture policy reaches the executor's ledger", () => {
  it("records nothing for an admission whose capture policy is off (Ruling BZ regression)", async () => {
    const { plan, caseId } = createOrdersExecutorPlan({ probe: "api-state-positive-v1" });
    const root = await temp();
    const ledger = createFileCaseLedger(root, plan);
    expect(ledger.capture.enabled("screenshot")).toBe(false);
    expect(ledger.capture.enabled("trace")).toBe(false);
    await expect(ledger.capture.record({ caseId, kind: "screenshot", bytes: jpeg(100) })).resolves.toBeNull();
    expect(await readdir(root)).toEqual([]);
  });

  it("takes screenshots, and not traces, for the qualification probes' own policy, which is unchanged", async () => {
    const { plan, caseId } = createOrdersExecutorPlan({ probe: "web-csv-positive-v1" });
    const ledger = createFileCaseLedger(await temp(), plan);
    expect(ledger.capture.enabled("screenshot")).toBe(true);
    expect(ledger.capture.enabled("trace")).toBe(false);
    await expect(ledger.capture.record({ caseId, kind: "trace", bytes: trace({ a: "b" }) })).resolves.toBeNull();
  });

  it("takes traces too when the admission approves them, and keeps the qualification probes' own policy when it does not say", async () => {
    const approved = createOrdersExecutorPlan({ probe: "web-csv-positive-v1", capture: { traces: true } });
    const ledger = createFileCaseLedger(await temp(), approved.plan);
    expect(ledger.capture.enabled("screenshot")).toBe(true);
    expect(ledger.capture.enabled("trace")).toBe(true);
    // The probes' policy is unchanged by the option existing: screenshots for a web probe, never traces, nothing for an API probe.
    const capturePolicyOf = (plan: ReturnType<typeof createOrdersExecutorPlan>) => plan.compiled.runtimeAdmissionContext.selectionInput.policy.capture;
    expect(capturePolicyOf(createOrdersExecutorPlan({ probe: "web-csv-positive-v1" }))).toEqual({ screenshots: true, traces: false, video: true, downloads: false });
    expect(capturePolicyOf(createOrdersExecutorPlan({ probe: "api-state-positive-v1" }))).toEqual({ screenshots: false, traces: false, video: false, downloads: false });
  });

  it("scrubs the session cookie the host registers, and refuses plain evidence that carries it", async () => {
    const { plan, caseId } = createOrdersExecutorPlan({ probe: "web-csv-positive-v1" });
    const root = await temp();
    const ledger = createFileCaseLedger(root, plan);
    ledger.registerSessionSecret("sess-token-0123456789abcdef");
    await expect(ledger.evidence.recordCaseEvidence({ caseId, kind: "case-capture", bytes: Buffer.from('{"c":"sess-token-0123456789abcdef"}'), mediaType: "application/json" }, new AbortController().signal))
      .rejects.toThrow(/credential/);
  });
});

describe.runIf(existsSync(join(import.meta.dirname, "../../packages/verifier", E2E_EXECUTOR_HOST_MODULE_PATH)))("the executor run and captures", () => {
  const signal = new AbortController().signal;
  const attest = async (request: { runId: string; groupId: string }) => ({ schemaVersion: "e2e-executor-chromium-sandbox/v1" as const, runId: request.runId, groupId: request.groupId,
    browser: { pid: 40, nsPidDepth: 1, seccompFilters: 1, uidMap: "0 0 4294967295" }, renderers: [{ pid: 41, nsPidDepth: 2, seccompFilters: 2, uidMap: "0 1000 1" }] });

  async function runWeb(seed?: (out: string, password: string) => Promise<void>) {
    const fixture = createOrdersExecutorPlan({ probe: "web-csv-positive-v1", healthTimeoutMs: 5_000 });
    const dir = await temp(); const out = join(dir, "out");
    await writeFile(join(dir, "plan.json"), JSON.stringify(fixture.plan));
    if (seed) await seed(out, fixture.plan.accounts[0]!.password);
    const app = createServer((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); });
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    const chromium = await fakeChromium("listen"); roots.push(chromium.directory);
    try {
      const result = await runE2EExecutor({ planPath: join(dir, "plan.json"), outDir: out, signal, localAppUpstream: `http://127.0.0.1:${(app.address() as { port: number }).port}`,
        chromiumExecutable: chromium.executable, inspectChromiumSandbox: attest as never, chromiumSandboxSettleMs: 0 });
      return { out, result };
    } finally { await new Promise<void>((resolve) => app.close(() => resolve())); }
  }

  it("writes no capture file and no artifacts.json when the admission approves no capture (an API run)", async () => {
    const fixture = createOrdersExecutorPlan({ probe: "api-state-positive-v1", healthTimeoutMs: 500 });
    const dir = await temp(); const out = join(dir, "out");
    await writeFile(join(dir, "plan.json"), JSON.stringify(fixture.plan));
    await runE2EExecutor({ planPath: join(dir, "plan.json"), outDir: out, signal, localAppUpstream: "http://127.0.0.1:9" });
    expect((await readdir(out)).sort()).toEqual(["blocked-requests.json", "executor-result.json", "executor.log"]);
  });

  it("lists an empty artifacts.json when screenshots are approved and no case failed, and leaves the run's own result alone", async () => {
    const { out, result } = await runWeb();
    expect(JSON.parse(await readFile(join(out, "artifacts.json"), "utf8"))).toEqual({ schemaVersion: "e2e-executor-artifacts/v1", artifacts: [] });
    expect(JSON.parse(await readFile(join(out, "executor-result.json"), "utf8"))).toMatchObject({ exitCode: result.exitCode, reason: result.reason });
  });

  it("drops a stored capture that carries the run's password, records it, and does not turn that into a different result", async () => {
    const clean = await runWeb();
    const dirty = await runWeb(async (out, password) => {
      await mkdir(join(out, CAPTURE_DIR), { recursive: true });
      await writeFile(join(out, CAPTURE_DIR, "case-0-screenshot.jpg"), Buffer.concat([jpeg(100), Buffer.from(password)]));
    });
    expect(dirty.result).toEqual(clean.result);
    expect((await readdir(join(dirty.out, CAPTURE_DIR))).filter((name) => name.endsWith(".jpg"))).toEqual([]);
    expect(JSON.parse(await readFile(join(dirty.out, "artifacts.json"), "utf8")).artifacts).toEqual([expect.objectContaining({ kind: "screenshot", omitted: "credential-match" })]);
    const everything = (await Promise.all((await readdir(dirty.out, { recursive: true })).map(async (name) => {
      const path = join(dirty.out, name);
      return (await stat(path)).isFile() ? (await readFile(path)).toString("latin1") : "";
    }))).join("\n");
    expect(everything).not.toContain(createOrdersExecutorPlan({ probe: "web-csv-positive-v1" }).plan.accounts[0]!.password);
  });
});

describe("what a web case captures", () => {
  const caseId = "case-a";
  function fakes() {
    const record = vi.fn(async (_input: { caseId: string; kind: "screenshot" | "trace"; bytes: Uint8Array }): Promise<unknown> => undefined);
    const writes: string[] = [];
    const archive = trace({ "trace.trace": "steps" });
    const context = { tracing: {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async (options?: { path?: string }) => { if (options?.path) { writes.push(options.path); await writeFile(options.path, archive); } }),
    } };
    const shot = jpeg(3000);
    const page = { screenshot: vi.fn(async () => shot) };
    return { record, writes, archive, context, page, shot };
  }
  const portsFor = async (record: E2EWebCapturePorts["record"], policy = ON): Promise<E2EWebCapturePorts> => ({ ...policy, record, scratchDirectory: await temp() });

  it("takes one 70-quality JPEG screenshot and one trace for a FAILED case", async () => {
    const f = fakes(); const capture = await portsFor(f.record);
    const tracing = await startWebCaseTrace(capture, f.context as never);
    expect(tracing).toBe(true);
    await finishWebCaseCapture({ capture, caseId, outcome: "failed", page: f.page as never, context: f.context as never, tracing });
    expect(f.page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ type: "jpeg", quality: 70 }));
    const stored = f.record.mock.calls.map(([call]) => call);
    expect(stored.map((item) => [item.caseId, item.kind, Buffer.from(item.bytes).equals(item.kind === "trace" ? f.archive : f.shot)])).toEqual([[caseId, "screenshot", true], [caseId, "trace", true]]);
    expect(f.record).toHaveBeenCalledTimes(2);
    // The trace file was scratch: it is gone.
    expect(await readdir(capture.scratchDirectory)).toEqual([]);
  });

  it("takes a screenshot but no trace for an UNKNOWN case, and stops the trace without keeping it", async () => {
    const f = fakes(); const capture = await portsFor(f.record);
    const tracing = await startWebCaseTrace(capture, f.context as never);
    await finishWebCaseCapture({ capture, caseId, outcome: "unknown", page: f.page as never, context: f.context as never, tracing });
    expect(f.record.mock.calls.map(([call]) => call.kind)).toEqual(["screenshot"]);
    expect(f.context.tracing.stop).toHaveBeenCalledWith();
    expect(f.writes).toEqual([]);
  });

  it("captures nothing for a PASS case, and discards its trace", async () => {
    const f = fakes(); const capture = await portsFor(f.record);
    const tracing = await startWebCaseTrace(capture, f.context as never);
    await finishWebCaseCapture({ capture, caseId, outcome: "passed", page: f.page as never, context: f.context as never, tracing });
    expect(f.record).not.toHaveBeenCalled();
    expect(f.page.screenshot).not.toHaveBeenCalled();
    expect(f.context.tracing.stop).toHaveBeenCalledWith();
    expect(f.writes).toEqual([]);
  });

  it("does not start tracing, take a screenshot or write anything when capture is off", async () => {
    const f = fakes(); const capture = await portsFor(f.record, { screenshots: false, traces: false });
    expect(await startWebCaseTrace(capture, f.context as never)).toBe(false);
    expect(await startWebCaseTrace(undefined, f.context as never)).toBe(false);
    await finishWebCaseCapture({ capture, caseId, outcome: "failed", page: f.page as never, context: f.context as never, tracing: false });
    await finishWebCaseCapture({ capture: undefined, caseId, outcome: "failed", page: f.page as never, context: f.context as never, tracing: false });
    expect(f.context.tracing.start).not.toHaveBeenCalled();
    expect(f.page.screenshot).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
    expect(await readdir(capture.scratchDirectory)).toEqual([]);
  });

  it("starts tracing only for the admitted kind", async () => {
    const f = fakes(); const capture = await portsFor(f.record, { screenshots: true, traces: false });
    expect(await startWebCaseTrace(capture, f.context as never)).toBe(false);
    await finishWebCaseCapture({ capture, caseId, outcome: "failed", page: f.page as never, context: f.context as never, tracing: false });
    expect(f.record.mock.calls.map(([call]) => call.kind)).toEqual(["screenshot"]);
  });

  it("never lets a capture failure change the case: tracing that will not start, a screenshot that throws and a recorder that throws are all absorbed", async () => {
    const f = fakes(); const capture = await portsFor(async () => { throw new Error("recorder refused"); });
    f.context.tracing.start.mockRejectedValueOnce(new Error("tracing unsupported"));
    expect(await startWebCaseTrace(capture, f.context as never)).toBe(false);
    f.page.screenshot.mockRejectedValueOnce(new Error("page crashed"));
    await expect(finishWebCaseCapture({ capture, caseId, outcome: "failed", page: f.page as never, context: f.context as never, tracing: false })).resolves.toBeUndefined();
    await expect(finishWebCaseCapture({ capture, caseId, outcome: "failed", page: f.page as never, context: f.context as never, tracing: true })).resolves.toBeUndefined();
    expect(await readdir(capture.scratchDirectory)).toEqual([]);
  });
});

describe("an API target declares no screenshots whatever the capture policy says (the D3 default must not break API groups)", () => {
  const apiTarget = { targetId: "t", kind: "api" as const, applicationId: "app", runtimeProfileId: PROFILE };
  const plan = { targetId: "t", kind: "api", applicationId: "app", runtimeProfileId: PROFILE } as never;
  const D3_DEFAULT = E2EPolicySchema.shape.capture.parse({ screenshots: true, traces: true, video: false, downloads: true });

  it("declares artifactCapabilities [] for an API target under the D3 default, and validates", () => {
    const row = webApiRow("api");
    const declared = webApiApplicationLaunchTarget({ target: apiTarget, runtime: row, capture: D3_DEFAULT });
    expect(declared.artifactCapabilities).toEqual([]);
    expect(() => validateE2EApplicationLaunchTarget({ ...(plan as object), kind: "api" } as never, declared, row, D3_DEFAULT)).not.toThrow();
  });

  it("still declares a screenshot for a web target under the D3 default", () => {
    const row = webApiRow("web");
    const declared = webApiApplicationLaunchTarget({ target: { ...apiTarget, kind: "web" }, runtime: row, capture: D3_DEFAULT });
    expect(declared.artifactCapabilities).toEqual(["screenshot"]);
    expect(declared.engine!.capabilities).toContain("artifacts");
  });
});

describe("reading a finished run's captures back into the snapshot", () => {
  const result = { schemaVersion: "e2e-executor-result/v1", exitCode: 1, reason: null, startedAt: "2026-10-20T00:00:00.000Z", finishedAt: "2026-10-20T00:01:00.000Z",
    node: { version: "v22.23.2", execPath: "/usr/local/bin/node", platform: "linux", arch: "arm64" }, runId: "r", groupId: "g", shards: [] } as never;
  async function outDirWith(files: Record<string, Buffer | string>): Promise<string> {
    const out = await temp();
    await mkdir(join(out, "observations"), { recursive: true });
    for (const [name, data] of Object.entries(files)) { await mkdir(join(out, name, ".."), { recursive: true }); await writeFile(join(out, name), data); }
    return out;
  }
  const entry = (caseId: string, kind: "screenshot" | "trace", bytes: Buffer): CaptureEntry => ({ caseId, kind, sha256: sha(bytes), bytes: bytes.byteLength });
  const snapshotOf = async (out: string, options?: Parameters<typeof snapshotExecutorOutput>[2]) => snapshotExecutorOutput(out, result, options);

  it("carries the stored captures with their names, and the head of executor.log, never more than 64 KiB of it", async () => {
    const shot = jpeg(2000); const archive = trace({ "trace.trace": "steps" });
    const out = await outDirWith({ "captures/case-1-screenshot.jpg": shot, "captures/case-1-trace.zip": archive, "executor.log": "x".repeat(100_000),
      "artifacts.json": JSON.stringify({ schemaVersion: "e2e-executor-artifacts/v1", artifacts: [entry("case-b", "screenshot", shot), entry("case-b", "trace", archive)] }) });
    const snapshot = await snapshotOf(out);
    expect(snapshot.executorEvidence.executorLogHead.byteLength).toBe(64 * 1024);
    expect(snapshot.executorEvidence.captures!.artifacts.map((item) => item.kind).sort()).toEqual(["screenshot", "trace"]);
    expect(snapshot.executorEvidence.captures!.files.map((file) => file.name).sort()).toEqual(["case-1-screenshot.jpg", "case-1-trace.zip"]);
    expect(Buffer.from(snapshot.executorEvidence.captures!.files.find((file) => file.name === "case-1-screenshot.jpg")!.bytes)).toEqual(shot);
  });

  it("holds back a capture file the host's credential predicate flags, and says so", async () => {
    const shot = jpeg(2000); const dirty = Buffer.concat([jpeg(100), Buffer.from(PASSWORD)]);
    const out = await outDirWith({ "captures/case-0-screenshot.jpg": shot, "captures/case-1-screenshot.jpg": dirty,
      "artifacts.json": JSON.stringify({ schemaVersion: "e2e-executor-artifacts/v1", artifacts: [entry("case-a", "screenshot", shot), entry("case-b", "screenshot", dirty)] }) });
    const snapshot = await snapshotOf(out, { containsCredential: (bytes) => redactor().containsDeep(bytes) });
    const captures = snapshot.executorEvidence.captures!;
    expect(captures.files.map((file) => file.name)).toEqual(["case-0-screenshot.jpg"]);
    expect(captures.artifacts.find((item) => item.caseId === "case-b")).toMatchObject({ omitted: "credential-match" });
    expect(Buffer.concat(captures.files.map((file) => Buffer.from(file.bytes))).toString("latin1")).not.toContain(PASSWORD);
  });

  it("keeps the verdict inputs when the captures are unreadable: no captures, no failure", async () => {
    const out = await outDirWith({ "artifacts.json": "{ not json", "captures/case-0-screenshot.jpg": jpeg(100) });
    const snapshot = await snapshotOf(out);
    expect(snapshot.executorEvidence.captures).toBeNull();
    expect(snapshot.executorEvidence.executorLogHead.byteLength).toBe(0);
  });

  it("has no captures for a run that wrote none (capture off)", async () => {
    expect((await snapshotOf(await outDirWith({}))).executorEvidence.captures).toBeNull();
  });
});
