import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2EArtifactRefSchema, E2EPolicySchema } from "@agentx/contracts";
import { CAPTURE_ARTIFACTS_FILE, CAPTURE_DIR, CAPTURE_GROUP_BUDGET_BYTES, CAPTURE_SCREENSHOT_MAX_BYTES, admittedCapturePolicy, createCaptureRecorder, encodedBytes,
  finalizeCaptureArtifacts, type CaptureEntry } from "../../packages/verifier/src/executor/capture.js";
import { createFileCaseLedger } from "../../packages/verifier/src/executor/case-ledger.js";
import { createCredentialRedactor } from "../../packages/verifier/src/executor/redact.js";
import { snapshotExecutorOutput } from "../../packages/verifier/src/host/executor-readback.js";
import { finishWebCaseCapture, type E2EWebCapturePorts } from "../../packages/verifier/src/web-runtime.js";
import * as webRuntime from "../../packages/verifier/src/web-runtime.js";
import { webApiApplicationLaunchTarget } from "../../packages/verifier/src/web-api-launch-target.js";
import { validateE2EApplicationLaunchTarget } from "../../packages/verifier/src/application-scenarios.js";
import { E2E_EXECUTOR_HOST_MODULE_PATH } from "../../packages/verifier/src/executor/host-registry.js";
import { runE2EExecutor } from "../../packages/verifier/src/executor/run.js";
import { webApiRow, PROFILE } from "../support/e2e-application-plan-fixtures.js";
import { createOrdersExecutorPlan } from "../support/e2e-orders-executor-fixture.js";
import { fakeChromium } from "../support/fake-chromium.js";

// Screenshots of failed cases only (Ruling CJ: traces are deferred past M1.3). Nothing here may accept, declare or store a trace.
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
async function temp(): Promise<string> { const dir = await realpath(await mkdtemp(join(tmpdir(), "capture-test-"))); roots.push(dir); return dir; }
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const PASSWORD = "planted-Password-7f3a91c2d4e8b0aa";
const EMAIL = "rovara-orders-owner-ab12cd@example.test";
const accounts = [{ profileId: "orders-owner", email: EMAIL, password: PASSWORD }];
const caseIds = ["case-a", "case-b", "case-c", "case-d", "case-e", "case-f", "case-g"];
const ON = { screenshots: true };
const OFF = { screenshots: false };
/** A JPEG-looking blob of exactly `size` bytes. */
const jpeg = (size: number, fill = 0x41) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size - 4, fill)]);
const redactor = () => createCredentialRedactor(accounts);
const listing = async (dir: string) => (await readdir(dir, { recursive: true })).sort();
const filesOf = async (root: string) => (await readdir(join(root, CAPTURE_DIR))).filter((name) => name !== "entries").sort();

describe("credential redactor scans", () => {
  const embedded = (secret: string, prefix: number, suffix: number) => Buffer.concat([Buffer.alloc(prefix, 0x58), Buffer.from(secret), Buffer.alloc(suffix, 0x59)]);
  it("finds a secret inside a longer base64 string at any alignment, standard or url-safe", () => {
    const r = redactor();
    for (const secret of [PASSWORD, EMAIL]) {
      for (let prefix = 0; prefix < 6; prefix += 1) {
        for (const suffix of [0, 1, 2]) {
          const standard = embedded(secret, prefix, suffix).toString("base64");
          expect(r.contains(Buffer.from(`x=${standard}`)), `${secret} prefix ${prefix} suffix ${suffix}`).toBe(true);
          expect(r.contains(Buffer.from(standard.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""))), `url ${secret} prefix ${prefix} suffix ${suffix}`).toBe(true);
        }
      }
    }
  });
  it("finds the credentials in a Basic authorization header and in a JWT payload, whatever the email's length", () => {
    const r = redactor();
    for (const email of ["a@b.test", "ab@b.test", "abc@b.test", EMAIL, `${EMAIL}x`]) {
      const one = createCredentialRedactor([{ profileId: "p", email, password: PASSWORD }]);
      expect(one.contains(Buffer.from(`authorization: Basic ${Buffer.from(`${email}:${PASSWORD}`).toString("base64")}`))).toBe(true);
      const payload = Buffer.from(JSON.stringify({ sub: "s", email })).toString("base64url");
      expect(one.contains(Buffer.from(`eyJhbGciOiJub25lIn0.${payload}.sig`))).toBe(true);
    }
    expect(r.contains(Buffer.from("nothing secret here, just a Basic dXNlcjpwYXNz header"))).toBe(false);
  });
  it("finds a credential in base64 that is wrapped into lines (MIME style), whatever the column and line ending", () => {
    const wrap = (text: string, columns: number, eol: string) => text.match(new RegExp(`.{1,${columns}}`, "g"))!.join(eol);
    for (const email of ["a@b.test", "ab@b.test", EMAIL, `${EMAIL}x`]) {
      const one = createCredentialRedactor([{ profileId: "p", email, password: PASSWORD }]);
      const basic = Buffer.from(`${email}:${PASSWORD}`).toString("base64");
      const payload = Buffer.from(JSON.stringify({ sub: "s", email, pw: PASSWORD })).toString("base64url");
      for (const columns of [20, 64, 76]) {
        for (const eol of ["\n", "\r\n", "\r\n "]) {
          expect(one.contains(Buffer.from(`Authorization: Basic ${wrap(basic, columns, eol)}\n`)), `basic ${email} ${columns} ${JSON.stringify(eol)}`).toBe(true);
          expect(one.contains(Buffer.from(`eyJhbGciOiJub25lIn0.${wrap(payload, columns, eol)}.sig`)), `jwt ${email} ${columns} ${JSON.stringify(eol)}`).toBe(true);
        }
      }
    }
    expect(redactor().contains(Buffer.from("a perfectly\nordinary\r\nwrapped text with no secret in it"))).toBe(false);
  });

  it("finds a credential that a line break splits, and does not mistake two words for one", () => {
    const r = redactor();
    expect(r.contains(Buffer.from(`${PASSWORD.slice(0, 10)}\n${PASSWORD.slice(10)}`))).toBe(true);
    expect(r.contains(Buffer.from(`${PASSWORD.slice(0, 10)} and then ${PASSWORD.slice(10)}`))).toBe(false);
  });

  it("keeps the exact spellings it always had", () => {
    const r = redactor();
    for (const form of [PASSWORD, encodeURIComponent(PASSWORD), Buffer.from(PASSWORD).toString("base64")]) expect(r.contains(Buffer.from(`a${form}b`))).toBe(true);
  });
  it("redacts a session secret of any length in text and never throws for a short one", () => {
    const r = redactor();
    expect(() => r.addSessionSecret("abc")).not.toThrow();
    expect(() => r.addSessionSecret("")).not.toThrow();
    r.addSessionSecret("sess-token-0123456789abcdef");
    expect(r.text("cookie abc sess-token-0123456789abcdef end")).toBe("cookie <session> <session> end");
  });
  it("lets a long session secret mark bytes, and a short one only redact text", () => {
    const r = redactor();
    r.addSessionSecret("ab");
    expect(r.contains(Buffer.from("plain ab bytes"))).toBe(false);
    r.addSessionSecret("sess-token-0123456789abcdef");
    expect(r.contains(Buffer.from("x sess-token-0123456789abcdef"))).toBe(true);
    expect(r.contains(Buffer.from("x sess-token-0123456789abcdef"), "accounts")).toBe(false);
    expect(r.contains(Buffer.from(PASSWORD), "accounts")).toBe(true);
  });
});

describe("capture recorder", () => {
  it("stores a screenshot as case-<index>-screenshot.jpg, never under scenario text or account names", async () => {
    const root = await temp();
    const recorder = createCaptureRecorder({ root, policy: ON, caseIds, redactor: redactor() });
    const shot = jpeg(1000);
    await expect(recorder.record({ caseId: "case-c", kind: "screenshot", bytes: shot })).resolves.toEqual({ caseId: "case-c", kind: "screenshot", sha256: sha(shot), bytes: 1000 });
    expect(await filesOf(root)).toEqual(["case-2-screenshot.jpg"]);
    expect(await readFile(join(root, CAPTURE_DIR, "case-2-screenshot.jpg"))).toEqual(shot);
    expect(JSON.stringify(await listing(root))).not.toMatch(/orders-owner|case-c/);
  });

  it("writes nothing at all when capture is off, whatever it is asked", async () => {
    const root = await temp();
    const recorder = createCaptureRecorder({ root, policy: OFF, caseIds, redactor: redactor() });
    expect(recorder.enabled("screenshot")).toBe(false);
    await expect(recorder.record({ caseId: "case-a", kind: "screenshot", bytes: jpeg(100) })).resolves.toBeNull();
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses a trace: there is no such capture, whatever the policy says", async () => {
    const root = await temp();
    const recorder = createCaptureRecorder({ root, policy: ON, caseIds, redactor: redactor() });
    expect(recorder.enabled("trace" as never)).toBe(false);
    await expect(recorder.record({ caseId: "case-a", kind: "trace" as never, bytes: Buffer.from("PK\u0003\u0004") })).rejects.toThrow(/trace/);
    expect(await readdir(root)).toEqual([]);
  });

  it("holds a screenshot to 524288 bytes, recording the drop as budget and writing no file", async () => {
    const root = await temp();
    const recorder = createCaptureRecorder({ root, policy: ON, caseIds, redactor: redactor() });
    expect(CAPTURE_SCREENSHOT_MAX_BYTES).toBe(524_288);
    await expect(recorder.record({ caseId: "case-a", kind: "screenshot", bytes: jpeg(CAPTURE_SCREENSHOT_MAX_BYTES) })).resolves.not.toHaveProperty("omitted");
    const tooBig = jpeg(CAPTURE_SCREENSHOT_MAX_BYTES + 1);
    await expect(recorder.record({ caseId: "case-b", kind: "screenshot", bytes: tooBig })).resolves.toEqual({ caseId: "case-b", kind: "screenshot", sha256: sha(tooBig), bytes: tooBig.byteLength, omitted: "budget" });
    expect(await filesOf(root)).toEqual(["case-0-screenshot.jpg"]);
  });

  it("drops a screenshot whose bytes carry a credential, in any spelling, and stores no byte of it", async () => {
    const root = await temp();
    const recorder = createCaptureRecorder({ root, policy: ON, caseIds, redactor: redactor() });
    const dirty = [Buffer.from(PASSWORD), Buffer.from(EMAIL), Buffer.from(`xx${Buffer.from(`Y${PASSWORD}`).toString("base64")}`)];
    for (const [index, secret] of dirty.entries()) {
      const entry = await recorder.record({ caseId: caseIds[index]!, kind: "screenshot", bytes: Buffer.concat([jpeg(200), secret]) });
      expect(entry).toMatchObject({ omitted: "credential-match" });
    }
    expect(await filesOf(root)).toEqual([]);
    const everything = (await Promise.all((await listing(root)).map(async (name) => ((await stat(join(root, name))).isFile() ? (await readFile(join(root, name))).toString("latin1") : "")))).join("\n");
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain(EMAIL);
  });

  it("refuses a case that is not in the plan", async () => {
    const recorder = createCaptureRecorder({ root: await temp(), policy: ON, caseIds, redactor: redactor() });
    await expect(recorder.record({ caseId: "unknown", kind: "screenshot", bytes: jpeg(100) })).rejects.toThrow(/unknown case/);
  });
});

describe("the admitted policy never admits a trace", () => {
  const capture = (overrides: object) => E2EPolicySchema.shape.capture.parse({ screenshots: true, traces: false, video: false, downloads: true, ...overrides });
  it("reads screenshots from an admitted policy and refuses one that asks for traces", () => {
    expect(admittedCapturePolicy(capture({}))).toEqual({ screenshots: true });
    expect(admittedCapturePolicy(capture({ screenshots: false }))).toEqual({ screenshots: false });
    expect(() => admittedCapturePolicy(capture({ traces: true }))).toThrow(/trace/);
  });
  it("makes no launch descriptor for a policy that asks for traces, and refuses to validate one", () => {
    const row = webApiRow("web");
    const target = { targetId: "t", kind: "web" as const, applicationId: "app", runtimeProfileId: PROFILE };
    expect(() => webApiApplicationLaunchTarget({ target, runtime: row, capture: capture({ traces: true }) })).toThrow(/trace/);
    const declared = webApiApplicationLaunchTarget({ target, runtime: row, capture: capture({}) });
    expect(() => validateE2EApplicationLaunchTarget({ targetId: "t", kind: "web", applicationId: "app", runtimeProfileId: PROFILE, browser: "chromium" } as never, declared, row, capture({ traces: true }))).toThrow(/trace/);
  });
  it("has no trace kind left in the contract's artifact reference", () => {
    const ref = { artifactId: "a", sha256: "a".repeat(64), bytes: 1, mediaType: "image/jpeg", kind: "screenshot", captureQualification: "synthetic" };
    expect(E2EArtifactRefSchema.safeParse(ref).success).toBe(true);
    expect(E2EArtifactRefSchema.safeParse({ ...ref, kind: "trace" }).success).toBe(false);
  });
  it("has no trace function left in the web case adapter", () => {
    expect(Object.keys(webRuntime)).not.toContain("startWebCaseTrace");
  });
});

describe("finalizing a group's captures", () => {
  async function seed(root: string, items: Array<{ caseId: string; size: number }>, ids: readonly string[] = caseIds) {
    const recorder = createCaptureRecorder({ root, policy: ON, caseIds: ids, redactor: redactor() });
    for (const item of items) await recorder.record({ caseId: item.caseId, kind: "screenshot", bytes: jpeg(item.size, item.caseId.length) });
  }
  const artifactsOf = async (root: string) => (JSON.parse(await readFile(join(root, CAPTURE_ARTIFACTS_FILE), "utf8")) as { schemaVersion: string; artifacts: CaptureEntry[] });

  it("lists every artifact as { caseId, kind, sha256, bytes, omitted? } in artifacts.json", async () => {
    const root = await temp();
    await seed(root, [{ caseId: "case-a", size: 4096 }]);
    await finalizeCaptureArtifacts({ outDir: root, policy: ON, caseIds, redactor: redactor() });
    const { schemaVersion, artifacts } = await artifactsOf(root);
    expect(schemaVersion).toBe("e2e-executor-artifacts/v1");
    const file = await readFile(join(root, CAPTURE_DIR, "case-0-screenshot.jpg"));
    expect(artifacts).toEqual([{ caseId: "case-a", kind: "screenshot", sha256: sha(file), bytes: file.byteLength }]);
    expect(await readdir(join(root, CAPTURE_DIR))).not.toContain("entries");
  });

  it("counts the budget in encoded (base64) bytes: 6 MiB of them, not 6 MiB of JPEG", async () => {
    const root = await temp();
    const many = Array.from({ length: 9 }, (_, index) => `case-${index}`);
    await seed(root, many.map((caseId) => ({ caseId, size: CAPTURE_SCREENSHOT_MAX_BYTES })), many);
    expect(CAPTURE_GROUP_BUDGET_BYTES).toBe(6 * 1024 * 1024);
    // 9 x 512 KiB is 4.5 MiB of JPEG, which fits 6 MiB, but 6 MiB of base64 holds only 8 of them (8 x 699,052 = 5.33 MiB; 9 x = 6.0 MiB + 1,6 KB over).
    expect(encodedBytes(CAPTURE_SCREENSHOT_MAX_BYTES) * 9).toBeGreaterThan(CAPTURE_GROUP_BUDGET_BYTES);
    const entries = await finalizeCaptureArtifacts({ outDir: root, policy: ON, caseIds: many, redactor: redactor() });
    expect(entries.filter((entry) => entry.omitted === "budget")).toHaveLength(1);
    expect(entries.filter((entry) => entry.omitted === undefined).reduce((sum, entry) => sum + encodedBytes(entry.bytes), 0)).toBeLessThanOrEqual(CAPTURE_GROUP_BUDGET_BYTES);
  });

  it("sheds one file at a time, the largest first, and only until the set fits, touching no verdict file", async () => {
    const root = await temp();
    const resultBytes = JSON.stringify({ schemaVersion: "e2e-executor-result/v1", exitCode: 1, reason: null });
    await writeFile(join(root, "executor-result.json"), resultBytes);
    // Encoded sizes: 6 x 512 KiB = 4.0 MiB, one 400 KiB, one 300 KiB: 5.1 MiB in all is under budget, so add 2 more full ones to pass 6 MiB.
    const sizes = [524_288, 524_288, 524_288, 524_288, 524_288, 524_288, 524_288, 524_288, 300_000, 400_000];
    const ids = sizes.map((_, index) => `case-${index}`);
    await seed(root, sizes.map((size, index) => ({ caseId: ids[index]!, size })), ids);
    const entries = await finalizeCaptureArtifacts({ outDir: root, policy: ON, caseIds: ids, redactor: redactor() });
    const dropped = entries.filter((entry) => entry.omitted === "budget");
    // 8 x 699,052 + 400,000 and 300,000 as base64 is about 7.2 MiB: one full-size file goes (the last of the largest), then it fits.
    expect(dropped.map((entry) => entry.bytes)).toEqual([524_288]);
    expect(dropped[0]!.caseId).toBe("case-7");
    expect(entries.filter((entry) => entry.omitted === undefined).reduce((sum, entry) => sum + encodedBytes(entry.bytes), 0)).toBeLessThanOrEqual(CAPTURE_GROUP_BUDGET_BYTES);
    expect(await readFile(join(root, "executor-result.json"), "utf8")).toBe(resultBytes);
    expect((await artifactsOf(root)).artifacts).toEqual(entries);
    expect((await filesOf(root)).includes("case-7-screenshot.jpg")).toBe(false);
  });

  it("drops a stored capture that turns out to carry a credential, instead of failing the run", async () => {
    const root = await temp();
    await seed(root, [{ caseId: "case-a", size: 1024 }]);
    await writeFile(join(root, CAPTURE_DIR, "case-0-screenshot.jpg"), Buffer.concat([jpeg(100), Buffer.from(PASSWORD)]));
    const entries = await finalizeCaptureArtifacts({ outDir: root, policy: ON, caseIds, redactor: redactor() });
    expect(entries).toEqual([expect.objectContaining({ caseId: "case-a", omitted: "credential-match" })]);
    expect(await filesOf(root)).toEqual([]);
  });

  it("removes a file that is not a screenshot of an admitted case, such as a trace, should one ever appear", async () => {
    const root = await temp();
    await seed(root, [{ caseId: "case-a", size: 1024 }]);
    await writeFile(join(root, CAPTURE_DIR, "case-0-trace.zip"), Buffer.from("PK\u0003\u0004"));
    const entries = await finalizeCaptureArtifacts({ outDir: root, policy: ON, caseIds, redactor: redactor() });
    expect(entries.map((entry) => entry.kind)).toEqual(["screenshot"]);
    expect(await filesOf(root)).toEqual(["case-0-screenshot.jpg"]);
  });

  it("writes nothing when capture is off", async () => {
    const root = await temp();
    await expect(finalizeCaptureArtifacts({ outDir: root, policy: OFF, caseIds, redactor: redactor() })).resolves.toEqual([]);
    expect(await readdir(root)).toEqual([]);
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
    await expect(ledger.capture.record({ caseId, kind: "screenshot", bytes: jpeg(100) })).resolves.toBeNull();
    expect(await readdir(root)).toEqual([]);
  });

  it("takes screenshots for the qualification probes' own policy, which is unchanged: screenshots for a web probe, no traces, nothing for an API probe", async () => {
    const web = createOrdersExecutorPlan({ probe: "web-csv-positive-v1" });
    const ledger = createFileCaseLedger(await temp(), web.plan);
    expect(ledger.capture.enabled("screenshot")).toBe(true);
    const capturePolicyOf = (plan: ReturnType<typeof createOrdersExecutorPlan>) => plan.compiled.runtimeAdmissionContext.selectionInput.policy.capture;
    expect(capturePolicyOf(web)).toEqual({ screenshots: true, traces: false, video: true, downloads: false });
    expect(capturePolicyOf(createOrdersExecutorPlan({ probe: "api-state-positive-v1" }))).toEqual({ screenshots: false, traces: false, video: false, downloads: false });
  });

  it("registers a session secret without throwing, however short, and never refuses verdict-input evidence because of it", async () => {
    const { plan, caseId } = createOrdersExecutorPlan({ probe: "web-csv-positive-v1" });
    const root = await temp();
    const ledger = createFileCaseLedger(root, plan);
    expect(() => ledger.registerSessionSecret("abc")).not.toThrow();
    ledger.registerSessionSecret("sess-token-0123456789abcdef");
    const ref = await ledger.evidence.recordCaseEvidence({ caseId, kind: "case-capture", bytes: Buffer.from('{"c":"sess-token-0123456789abcdef"}'), mediaType: "application/json" }, new AbortController().signal);
    expect(ref).toMatchObject({ byteLength: 35 });
  });

  it("still refuses verdict-input evidence that carries an account credential", async () => {
    const { plan, caseId } = createOrdersExecutorPlan({ probe: "web-csv-positive-v1" });
    const ledger = createFileCaseLedger(await temp(), plan);
    const password = plan.accounts[0]!.password;
    await expect(ledger.evidence.recordCaseEvidence({ caseId, kind: "case-capture", bytes: Buffer.from(`{"p":"${password}"}`), mediaType: "application/json" }, new AbortController().signal))
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
        chromiumExecutable: chromium.executable, inspectChromiumSandbox: attest, chromiumSandboxSettleMs: 0 });
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
    expect(await filesOf(dirty.out)).toEqual([]);
    expect((JSON.parse(await readFile(join(dirty.out, "artifacts.json"), "utf8")) as { artifacts: unknown[] }).artifacts).toEqual([expect.objectContaining({ kind: "screenshot", omitted: "credential-match" })]);
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
    const record = vi.fn<(input: { caseId: string; kind: "screenshot"; bytes: Uint8Array }) => Promise<unknown>>(async () => undefined);
    const shot = jpeg(3000);
    const page = { screenshot: vi.fn(async () => shot) };
    const context = { tracing: { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) } };
    return { record, page, shot, context };
  }
  const portsFor = (record: E2EWebCapturePorts["record"], policy: { screenshots: boolean } = ON): E2EWebCapturePorts => ({ ...policy, record });

  it("takes one 70-quality JPEG screenshot for a FAILED case", async () => {
    const f = fakes(); const capture = portsFor(f.record);
    await finishWebCaseCapture({ capture, caseId, outcome: "failed", page: f.page });
    expect(f.page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ type: "jpeg", quality: 70 }));
    const stored = f.record.mock.calls.map(([call]) => call);
    expect(stored.map((item) => [item.caseId, item.kind, Buffer.from(item.bytes).equals(f.shot)])).toEqual([[caseId, "screenshot", true]]);
  });

  it("takes a screenshot for an UNKNOWN case", async () => {
    const f = fakes();
    await finishWebCaseCapture({ capture: portsFor(f.record), caseId, outcome: "unknown", page: f.page });
    expect(f.record).toHaveBeenCalledTimes(1);
  });

  it("captures nothing for a PASS case", async () => {
    const f = fakes();
    await finishWebCaseCapture({ capture: portsFor(f.record), caseId, outcome: "passed", page: f.page });
    expect(f.record).not.toHaveBeenCalled();
    expect(f.page.screenshot).not.toHaveBeenCalled();
  });

  it("takes nothing, and touches no tracing, when capture is off or absent", async () => {
    const f = fakes();
    await finishWebCaseCapture({ capture: portsFor(f.record, OFF), caseId, outcome: "failed", page: f.page });
    await finishWebCaseCapture({ capture: undefined, caseId, outcome: "failed", page: f.page });
    expect(f.page.screenshot).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
    expect(f.context.tracing.start).not.toHaveBeenCalled();
  });

  it("never lets a capture failure change the case: a screenshot that throws and a recorder that throws are absorbed", async () => {
    const f = fakes();
    f.page.screenshot.mockRejectedValueOnce(new Error("page crashed"));
    await expect(finishWebCaseCapture({ capture: portsFor(f.record), caseId, outcome: "failed", page: f.page })).resolves.toBeUndefined();
    await expect(finishWebCaseCapture({ capture: portsFor(async () => { throw new Error("recorder refused"); }), caseId, outcome: "failed", page: f.page })).resolves.toBeUndefined();
    await expect(finishWebCaseCapture({ capture: portsFor(f.record), caseId, outcome: "failed", page: null })).resolves.toBeUndefined();
  });
});

describe("an API target declares no screenshots whatever the capture policy says (the D3 default must not break API groups)", () => {
  const apiTarget = { targetId: "t", kind: "api" as const, applicationId: "app", runtimeProfileId: PROFILE };
  const plan = { targetId: "t", kind: "api", applicationId: "app", runtimeProfileId: PROFILE } as never;
  const D3_DEFAULT = E2EPolicySchema.shape.capture.parse({ screenshots: true, traces: false, video: false, downloads: true });

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
  const entry = (caseId: string, bytes: Buffer): CaptureEntry => ({ caseId, kind: "screenshot", sha256: sha(bytes), bytes: bytes.byteLength });
  const snapshotOf = async (out: string, options?: Parameters<typeof snapshotExecutorOutput>[2]) => snapshotExecutorOutput(out, result, options);
  const listingOf = (artifacts: unknown[]) => JSON.stringify({ schemaVersion: "e2e-executor-artifacts/v1", artifacts });

  it("carries the stored captures with their names, and the head of executor.log, never more than 64 KiB of it", async () => {
    const shot = jpeg(2000);
    const out = await outDirWith({ "captures/case-1-screenshot.jpg": shot, "executor.log": "x".repeat(100_000), "artifacts.json": listingOf([entry("case-b", shot)]) });
    const snapshot = await snapshotOf(out);
    expect(snapshot.executorEvidence.executorLogHead.byteLength).toBe(64 * 1024);
    expect(snapshot.executorEvidence.captures!.files.map((file) => file.name)).toEqual(["case-1-screenshot.jpg"]);
    expect(Buffer.from(snapshot.executorEvidence.captures!.files[0]!.bytes)).toEqual(shot);
  });

  it("holds back a capture file the host's credential predicate flags, and says so", async () => {
    const shot = jpeg(2000); const dirty = Buffer.concat([jpeg(100), Buffer.from(PASSWORD)]);
    const out = await outDirWith({ "captures/case-0-screenshot.jpg": shot, "captures/case-1-screenshot.jpg": dirty, "artifacts.json": listingOf([entry("case-a", shot), entry("case-b", dirty)]) });
    const snapshot = await snapshotOf(out, { containsCredential: (bytes) => redactor().contains(bytes) });
    const captures = snapshot.executorEvidence.captures!;
    expect(captures.files.map((file) => file.name)).toEqual(["case-0-screenshot.jpg"]);
    expect(captures.artifacts.find((item) => item.caseId === "case-b")).toMatchObject({ omitted: "credential-match" });
    expect(Buffer.concat(captures.files.map((file) => Buffer.from(file.bytes))).toString("latin1")).not.toContain(PASSWORD);
  });

  it("holds back a capture that carries a credential as misaligned base64 too", async () => {
    const dirty = Buffer.concat([jpeg(100), Buffer.from(`Y${Buffer.from(`ab:${PASSWORD}`).toString("base64")}`)]);
    const out = await outDirWith({ "captures/case-0-screenshot.jpg": dirty, "artifacts.json": listingOf([entry("case-a", dirty)]) });
    const snapshot = await snapshotOf(out, { containsCredential: (bytes) => redactor().contains(bytes) });
    expect(snapshot.executorEvidence.captures!.files).toEqual([]);
    expect(snapshot.executorEvidence.captures!.artifacts[0]).toMatchObject({ omitted: "credential-match" });
  });

  it("refuses a listing that names a trace: no captures, no failure", async () => {
    const out = await outDirWith({ "captures/case-0-trace.zip": Buffer.from("PK\u0003\u0004"),
      "artifacts.json": listingOf([{ caseId: "case-a", kind: "trace", sha256: "a".repeat(64), bytes: 4 }]) });
    expect((await snapshotOf(out)).executorEvidence.captures).toBeNull();
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
