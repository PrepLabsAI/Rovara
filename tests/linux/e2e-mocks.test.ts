import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { UNMOCKED_EXTERNAL_CALL_REASON } from "../../packages/verifier/src/application-result-adapter.js";
import { collectHostRun } from "../support/e2e-actual-run-proof.js";
import { EXECUTOR_IMAGE, removeProbeDirs, runProbe, type ProbeRun } from "../support/linux-runtime.js";

const execFileAsync = promisify(execFile);
const docker = async (...args: string[]) => (await execFileAsync("docker", args)).stdout.trim();

// External-origin mocks on a real Docker host: the production host starts the approved mock and the sinkhole from the executor image on the run's internal network, the app talks to them
// by name, and the real collector turns what they recorded into the verdict. Runs only where Docker and the executor image are provided (the CI `linux-runtime` job); elsewhere it skips.
describe.runIf(process.env.ROVARA_DOCKER === "1")("external-origin mocks and unmocked-call detection on a real Docker host", () => {
  afterAll(removeProbeDirs, 120_000);

  /** The worker's own join after close. The executor reports the Linux Node of its image; on a Linux runner only the path differs, on another host the platform does too. */
  async function collectLikeTheWorker(r: ProbeRun) {
    const actual = r.run.actualRun!;
    const inputs = await r.host.readCollectionInputs(new AbortController().signal);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const original = process.execPath;
    process.execPath = actual.runnerToolchain.execPath;
    if (process.platform !== "linux") Object.defineProperty(process, "platform", { ...platform, value: actual.runnerToolchain.platform });
    try { return collectHostRun(actual, inputs, r.fixture.plan); } finally { process.execPath = original; Object.defineProperty(process, "platform", platform); }
  }
  const leftovers = async (r: ProbeRun) => {
    const label = `label=rovara.run=${r.fixture.plan.runId}`;
    return { containers: await docker("ps", "-a", "--filter", label, "--format", "{{.Names}}"), networks: await docker("network", "ls", "--filter", label, "--format", "{{.Name}}") };
  };

  it("serves the inventory origin from its approved mock: the owner's CSV shows in-stock for a1 and unavailable for a2, and the run passes", async () => {
    const r = await runProbe("web-inventory-csv-v1", { defect: null, mock: true });
    expect(r.run.unavailableReason, JSON.stringify(r.host.readDiagnostics(r.fixture.plan.runId))).toBeNull();
    const collected = await collectLikeTheWorker(r);
    expect(collected.unavailableReason, collected.unavailableReason ?? "").toBeNull();
    const verdict = collected.qualification!;
    expect(verdict.status, verdict.reason).toBe("PASS");
    // One order the mock answered with its success variant and one it refused: both calls are the app's own, both verified against the approved fixture.
    expect(verdict.mockSummary).toEqual({ consumptions: { success: 1, refusal: 1, invalidData: 0 }, unmockedCalls: { sinkhole: 0, mocked: 0 }, mockedOrigins: ["inventory-v1"] });
    expect(verdict.result?.mockedOrigins).toEqual(["inventory-v1"]);
    expect(verdict.result?.cases.map((item) => item.mockedOrigins)).toEqual([["inventory-v1"]]);
    expect(await leftovers(r)).toEqual({ containers: "", networks: "" });
  }, 300_000);

  it("shows the page's stock status once, from the success variant", async () => {
    const r = await runProbe("web-inventory-status-v1", { defect: null, mock: true });
    expect(r.run.unavailableReason, JSON.stringify(r.host.readDiagnostics(r.fixture.plan.runId))).toBeNull();
    const verdict = (await collectLikeTheWorker(r)).qualification!;
    expect(verdict.status, verdict.reason).toBe("PASS");
    expect(verdict.mockSummary?.consumptions).toEqual({ success: 1, refusal: 0, invalidData: 0 });
  }, 300_000);

  it("is UNKNOWN for unmocked-external-call when the app asks the mock for a path it does not serve (the dependency-route defect calls /internal/admin)", async () => {
    const r = await runProbe("web-inventory-status-v1", { defect: "dependency-route.json", mock: true });
    expect(r.run.unavailableReason, JSON.stringify(r.host.readDiagnostics(r.fixture.plan.runId))).toBeNull();
    const collected = await collectLikeTheWorker(r);
    expect(collected.unavailableReason).toBe(UNMOCKED_EXTERNAL_CALL_REASON);
    const verdict = collected.qualification!;
    expect(verdict.status).toBe("UNKNOWN");
    expect(verdict.result?.cases[0]).toMatchObject({ status: "unavailable", reason: UNMOCKED_EXTERNAL_CALL_REASON });
    // The mock answered 599 and recorded it; it is never a failure of the feature and never a pass.
    expect(verdict.mockSummary?.unmockedCalls).toEqual({ sinkhole: 0, mocked: 1 });
    expect(verdict.mockSummary?.consumptions).toEqual({ success: 0, refusal: 0, invalidData: 0 });
  }, 300_000);

  it("is UNKNOWN for unmocked-external-call when the origin has no approved mock, although the app hid the failed call and every assertion held", async () => {
    const r = await runProbe("web-inventory-status-v1", { defect: "swallow-dependency.json" });
    expect(r.run.unavailableReason, JSON.stringify(r.host.readDiagnostics(r.fixture.plan.runId))).toBeNull();
    const collected = await collectLikeTheWorker(r);
    const verdict = collected.qualification!;
    expect(verdict.status).toBe("UNKNOWN");
    expect(verdict.reason).toBe(UNMOCKED_EXTERNAL_CALL_REASON);
    expect(verdict.result?.cases[0]?.assertionReceipts.map((receipt) => receipt.status)).toEqual(["passed"]);
    expect(verdict.mockSummary?.unmockedCalls).toEqual({ sinkhole: 1, mocked: 0 });
    expect(verdict.result?.mockedOrigins).toBeUndefined();
  }, 300_000);

  it("permits a declared origin the case never calls (MOCKUNUSED): the run passes on its assertions and says the mock was declared and not observed", async () => {
    // The default qualification app calls its inventory origin only when the page asks; this scenario never asks, so an approved mock goes unused. No request step names it, so it is
    // permitted, not required; a call to it would still be judged, and an unmocked call would still be UNKNOWN.
    const r = await runProbe("web-csv-positive-v1", { defect: null, mock: true });
    expect(r.run.unavailableReason, JSON.stringify(r.host.readDiagnostics(r.fixture.plan.runId))).toBeNull();
    const verdict = (await collectLikeTheWorker(r)).qualification!;
    expect(verdict.status).toBe("PASS");
    expect(verdict.result?.cases[0]).toMatchObject({ status: "passed", reason: "structural-application-observations-complete" });
    expect(verdict.result?.cases[0]?.coverage.observedMockedComponentIds).toEqual([]);
    expect(verdict.result?.cases[0]?.coverage.mockedComponentIds).toHaveLength(1);
    expect(verdict.mockSummary?.consumptions).toEqual({ success: 0, refusal: 0, invalidData: 0 });
  }, 300_000);

  it("runs the mock mode of the executor image under the host's own flags and answers by variant, recording every request", async () => {
    // The image's second mode, started exactly as the host starts it, on a throwaway internal network, and asked from another container by its network alias.
    const root = await realpath(await mkdtemp(join(tmpdir(), "rovara-mock-mode-")));
    const name = `rovara-mock-mode-${Date.now()}`;
    const network = `${name}-net`;
    try {
      await mkdir(join(root, "mock"), { recursive: true }); await mkdir(join(root, "out"), { recursive: true, mode: 0o777 });
      await chmod(join(root, "out"), 0o777);
      await writeFile(join(root, "mock", "fixture.json"), await readFile(join(import.meta.dirname, "../fixtures/e2e-web-api-app/e2e/mocks/inventory-v1.json")));
      await docker("network", "create", "--internal", network);
      await docker("run", "-d", "--name", name, "--pull=never", "--network", network, "--network-alias", "mock-inventory-v1", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--read-only", "--init",
        "--memory", "128m", "--memory-swap", "128m", "--pids-limit", "64", "--cpus", "0.5", "--user", "node", "-v", `${join(root, "mock")}:/mock:ro`, "-v", `${join(root, "out")}:/out/mock`,
        "-e", "ROVARA_MOCK_FIXTURE=/mock/fixture.json", EXECUTOR_IMAGE, "node", "/opt/agentx/packages/verifier/dist/executor/entry.js", "--mock", "/mock/fixture.json", "--origin", "inventory-v1");
      const ask = "const ask = async (q) => { const r = await fetch('http://mock-inventory-v1:8080' + q); return r.status + ' ' + await r.text(); };"
        + "(async () => { for (let i = 0; i < 60; i += 1) { try { await ask('/v1/stock?orderId=a1'); break; } catch { await new Promise((done) => setTimeout(done, 500)); } }"
        + "console.log(await ask('/v1/stock?orderId=a2')); console.log(await ask('/v1/stock?orderId=b1')); console.log(await ask('/v1/stock')); console.log(await ask('/health'));"
        // HTTPS to the plain HTTP mock, and a malformed request: neither parses as a request, both are recorded.
        + "await new Promise((done) => { require('https').get('https://mock-inventory-v1:8080/v1/stock?orderId=a1', { rejectUnauthorized: false }, done).on('error', done); });"
        + "await new Promise((done) => { const s = require('net').connect(8080, 'mock-inventory-v1', () => s.write('GET\\r\\n\\r\\n')); s.on('close', done); s.on('error', done); setTimeout(done, 3000); }); })();";
      const answers = (await docker("run", "--rm", "--pull=never", "--network", network, "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--entrypoint", "node", EXECUTOR_IMAGE, "-e", ask)).split("\n");
      expect(answers).toEqual(['404 {"error":"unknown order"}', '200 {"status":7}', '599 {"error":"rovara-unmocked"}', '599 {"error":"rovara-unmocked"}']);
      const lines = (await readFile(join(root, "out", "inventory-v1.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { variantId: string | null; status: number; method: string });
      expect(lines.map((line) => [line.variantId, line.status])).toEqual([["success", 200], ["refusal", 404], ["invalid-data", 200], [null, 599], [null, 599], [null, 599], [null, 599]]);
      expect(lines.slice(5).map((line) => line.method)).toEqual(["UNPARSED", "UNPARSED"]);
      // Every line says who called, and it is never the mock's own loopback.
      expect(lines.every((line) => /^\d+\.\d+\.\d+\.\d+$/.test((line as { remoteAddress?: string }).remoteAddress ?? "") && (line as { remoteAddress?: string }).remoteAddress !== "127.0.0.1")).toBe(true);
      // A hardened mock: no capability, no write outside its ledger directory.
      expect(await docker("inspect", "-f", "{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.Config.User}}", name)).toBe("true [ALL] node");
    } finally {
      await docker("rm", "-f", name).catch(() => undefined);
      await docker("network", "rm", network).catch(() => undefined);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 180_000);
  it("is UNKNOWN for unmocked-external-call when the app calls a host nobody declared: the name resolves to the sinkhole, over HTTP and over HTTPS", async () => {
    // The app hides the failed call behind the answer the page expects, so before names resolved to the sinkhole this run passed.
    for (const origin of ["http://payments.undeclared.example.org", "https://payments.undeclared.example.org"]) {
      const r = await runProbe("web-inventory-status-v1", { defect: "swallow-dependency.json", appEnv: { FIXTURE_INVENTORY_ORIGIN: origin } });
      expect(r.run.unavailableReason, JSON.stringify(r.host.readDiagnostics(r.fixture.plan.runId))).toBeNull();
      const collected = await collectLikeTheWorker(r);
      expect(collected.unavailableReason ?? collected.qualification?.reason, origin).toBe(UNMOCKED_EXTERNAL_CALL_REASON);
      const verdict = collected.qualification!;
      expect(verdict.status, origin).toBe("UNKNOWN");
      expect(verdict.reason).toBe(UNMOCKED_EXTERNAL_CALL_REASON);
      expect(verdict.result?.cases[0]?.assertionReceipts.map((receipt) => receipt.status)).toEqual(["passed"]);
      expect(verdict.mockSummary?.unmockedCalls.sinkhole, origin).toBeGreaterThanOrEqual(1);
    }
  }, 600_000);

  it("blocks a WebSocket the candidate's page opens to a mock: it is neither a consumption nor a call, and the executor records it as blocked", async () => {
    // The approved mock is not called by the app in this scenario, and the page tries to fake the call over a WebSocket Upgrade that matches the fixture exactly.
    const r = await runProbe("web-csv-positive-v1", { defect: null, mock: true, appEnv: { FIXTURE_WS_PROBE_URL: "ws://mock-inventory-v1:8080/v1/stock?orderId=a1" } });
    expect(r.run.unavailableReason, JSON.stringify(r.host.readDiagnostics(r.fixture.plan.runId))).toBeNull();
    const verdict = (await collectLikeTheWorker(r)).qualification!;
    // The mock is permitted and unused (MOCKUNUSED), so the case rests on its own assertions; the attempt is no consumption, no call, and the executor still records it as blocked.
    expect(verdict.status).toBe("PASS");
    expect(verdict.result?.cases[0]).toMatchObject({ status: "passed", reason: "structural-application-observations-complete" });
    expect(verdict.result?.cases[0]?.coverage.observedMockedComponentIds).toEqual([]);
    expect(verdict.mockSummary?.consumptions).toEqual({ success: 0, refusal: 0, invalidData: 0 });
    expect(verdict.mockSummary?.unmockedCalls).toEqual({ sinkhole: 0, mocked: 0 });
    const blocked = JSON.parse(await readFile(join(r.outDir!, "blocked-requests.json"), "utf8")) as { blocked: { host: string; resourceType: string }[] };
    expect(blocked.blocked).toEqual(expect.arrayContaining([expect.objectContaining({ host: "mock-inventory-v1:8080", resourceType: "websocket" })]));
  }, 300_000);

  it("resolves a name nothing in the run serves to the sinkhole, which records the call from the caller's own address, and answers on 443 as well", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rovara-sinkhole-")));
    const name = `rovara-sinkhole-${Date.now()}`;
    const network = `${name}-net`;
    try {
      await mkdir(join(root, "out"), { recursive: true });
      await chmod(join(root, "out"), 0o777);
      await docker("network", "create", "--internal", network);
      // Exactly the flags the host starts the sinkhole with, the low-port sysctl included.
      await docker("run", "-d", "--name", name, "--pull=never", "--network", network, "--network-alias", "mock-unbound", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--read-only", "--init",
        "--memory", "128m", "--memory-swap", "128m", "--pids-limit", "64", "--cpus", "0.5", "--user", "node", "--sysctl", "net.ipv4.ip_unprivileged_port_start=0", "-v", `${join(root, "out")}:/out/mock`,
        EXECUTOR_IMAGE, "node", "/opt/agentx/packages/verifier/dist/executor/entry.js", "--mock", "--origin", "unbound");
      for (let index = 0; index < 120 && !existsSync(join(root, "out", "unbound.ready")); index += 1) await new Promise((done) => setTimeout(done, 250));
      expect(existsSync(join(root, "out", "unbound.ready"))).toBe(true);
      const address = await docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", name);
      const script = "(async () => { const get = async (url) => { try { const r = await fetch(url); return r.status + ' ' + await r.text(); } catch (e) { return 'error ' + (e.cause?.code ?? e.code ?? e.message); } };"
        + "console.log(await get('http://payments.undeclared.example.org/charge')); console.log(await get('https://payments.undeclared.example.org/charge')); console.log(await get('http://app:4317/')); })();";
      // Exactly how the host points the app at the sinkhole: a read-only resolv.conf of its own naming the sinkhole, not `--dns` (which a Docker 25 daemon does not forward to for a container that
      // is only on internal networks), and a hosts entry for the sinkhole's own alias, which the embedded resolver no longer answers.
      await writeFile(join(root, "resolv.conf"), `nameserver ${address}\noptions ndots:0 timeout:2 attempts:2\n`, { mode: 0o644 });
      const answers = (await docker("run", "--rm", "--pull=never", "--network", network, "--read-only", "-v", `${join(root, "resolv.conf")}:/etc/resolv.conf:ro`, "--add-host", `mock-unbound:${address}`,
        "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--entrypoint", "node", EXECUTOR_IMAGE, "-e", script)).split("\n");
      expect(answers[0]).toBe('599 {"error":"rovara-unmocked"}');
      expect(answers[1]).toMatch(/^error /);
      const lines = (await readFile(join(root, "out", "unbound.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { variantId: string | null; status: number; remoteAddress: string; method: string; path: string });
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(lines.every((line) => line.variantId === null && line.status === 599)).toBe(true);
      expect(lines.map((line) => line.method)).toContain("GET");
      expect(lines.some((line) => line.method === "UNPARSED")).toBe(true);
      // The caller is the asking container, never the loopback address of the sinkhole itself.
      expect(lines.every((line) => /^172\.|^10\.|^192\.168\./.test(line.remoteAddress) && line.remoteAddress !== address)).toBe(true);
    } finally {
      await docker("rm", "-f", name).catch(() => undefined);
      await docker("network", "rm", network).catch(() => undefined);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 180_000);
});
