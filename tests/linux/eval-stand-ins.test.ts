// L4-EINT, on real Docker (CI's linux-runtime job, with the container firewall it installs from packages/worker/ec2/boot.sh). The first real proof of the eval stand-ins, written beside the eval sandbox's own check
// (eval-fresh-sandbox.test.ts). Closes DEFERRED L4-E56 "NEVER RUN AGAINST DOCKER" and the stand-in half of L4-E12-LINUX:
//   SI-1  the sealed eval box reaches an https vendor NAME through the run's certificate authority (Node `fetch` via NODE_EXTRA_CA_CERTS, and curl when the image has it) and is answered by the stand-in helper at the
//         sinkhole address (.47): a RECORDED answer for a planned name, a made-up one (labelled `madeByRovara`) for a name nobody planned, and `OK` for a host of the FIXED telemetry list;
//   SI-2  the box reaches NOTHING else: not an IP literal on the internet, not the metadata address, not the round's gateway; a public name resolves only to the sinkhole;
//   SI-3  the authority's KEY is not in the box: not in its environment, its checkout or its arguments (only the public certificate is);
//   SI-4  both sides of a comparison get the SAME bytes for the same request (the round's one answer book), and the counts say what was recorded, made up and answered as telemetry;
//   Join  after `run` returns no container or network of the round is left (the stand-in helper included).
// Postgres on the eval network (E12's services) needs the mirrored starter images and is checked with the test-services Linux checks, not here: this file needs only the CI node image.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelEgress, ModelEgressEvent } from "@agentx/contracts";
import { WEB_API_BUILD_IMAGE } from "../../packages/verifier/src/host/docker-application-host.js";
import { createModelBridge } from "../../packages/worker/src/model-bridge.js";
import { createModelBridgeLedger } from "../../packages/worker/src/model-bridge-ledger.js";
import { createDockerCli } from "../../packages/worker/src/swebench/containers.js";
import { EvalStandInRound } from "../../packages/worker/src/eval-standin-round.js";
import { EVAL_BRIDGE_SOCKET_NAME, EVAL_HELPER_DIR_NAME, createFreshEvalSandbox, type FreshEvalSandboxConfig } from "../../packages/worker/src/verification/eval-bridged-exec.js";
import { ensureLocalImage } from "../support/ci-images.js";
import { APP_NODE_IMAGE } from "../support/linux-runtime.js";
import { assertFirewallInstalled, docker } from "../support/linux-network-walls.js";

const ROOT = resolve(import.meta.dirname, "../..");
const FACTS = JSON.stringify({ metadataBlocked: true, runWalls: true, ipv6Drops: true, prepull: "off", prepulled: 0, loggedOut: true, dockerVersion: "27.3.1" });
const WORKSPACE = randomBytes(8).toString("hex");
const REPORT = "eval-report.json";
const WORKSPACE_ID = "0b9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c11";
const OPERATION_ID = "7c1f0d3a-2b8e-4a55-8f3b-9a1c2d3e4f50";

/** The eval: calls a planned vendor (recorded), an unplanned one, a telemetry host, then probes what else it can reach, and writes it all to the report. */
const EVAL_SCRIPT = `
const net = require("node:net"), fs = require("node:fs"), dns = require("node:dns").promises, cp = require("node:child_process");
const reach = (host, port) => new Promise((done) => { const s = net.connect({ host, port, timeout: 3000 }); s.on("connect", () => { s.destroy(); done("open"); }).on("timeout", () => { s.destroy(); done("timeout"); }).on("error", (e) => done("error:" + (e.code || "x"))); });
const call = async (url, init) => { try { const r = await fetch(url, init); return { status: r.status, label: r.headers.get("x-rovara-label"), cls: r.headers.get("x-rovara-standin"), body: await r.text() }; } catch (e) { return { error: String((e && e.cause && e.cause.code) || (e && e.code) || e) }; } };
(async () => {
  const out = { env: { hasCa: typeof process.env.NODE_EXTRA_CA_CERTS === "string", caPath: process.env.NODE_EXTRA_CA_CERTS || "" }, calls: {} };
  out.calls.recorded = await call("https://api.vendor.test/v1/recorded");
  out.calls.madeUp = await call("https://api.vendor.test/v1/never-recorded");
  out.calls.unplanned = await call("https://who-knows.example.test/anything");
  out.calls.telemetry = await call("https://o42.ingest.sentry.io/api/42/envelope/", { method: "POST", body: "{}" });
  out.calls.plainHttp = await call("http://api.vendor.test/v1/recorded");
  try { out.curl = cp.execFileSync("curl", ["--silent", "--max-time", "5", "https://api.vendor.test/v1/recorded"], { encoding: "utf8", env: { ...process.env, SSL_CERT_FILE: process.env.NODE_EXTRA_CA_CERTS || "" } }); } catch (e) { out.curl = "unavailable:" + String(e && e.code || "x"); }
  out.reach = { internet: await reach("1.1.1.1", 443), metadata: await reach("169.254.169.254", 80) };
  out.lookup = { vendor: await dns.lookup("api.vendor.test", { family: 4 }).then((r) => r.address, () => "error"), publicName: await dns.lookup("example.com", { family: 4 }).then((r) => r.address, () => "error") };
  out.keyInCheckout = fs.readdirSync("/workspace", { recursive: true }).filter((f) => typeof f === "string" && /key|\\.pem$/i.test(f) && !/ca\\.pem$|ca\\.crt$|ca-cert/i.test(f));
  out.keyText = fs.readdirSync("/workspace", { recursive: true }).filter((f) => typeof f === "string" && f.endsWith(".pem")).map((f) => fs.readFileSync("/workspace/" + f, "utf8")).join("\\n");
  fs.writeFileSync("/workspace/${REPORT}", JSON.stringify(out));
})();
`;

describe.runIf(process.platform === "linux" && process.env.ROVARA_DOCKER === "1")("L4-EINT: the eval stand-ins on Docker (SI-1..SI-4)", () => {
  let image = "";
  let work = "";
  const tag = `rovara-eint-eval:${randomBytes(4).toString("hex")}`;

  beforeAll(async () => {
    await assertFirewallInstalled();
    await ensureLocalImage(APP_NODE_IMAGE, WEB_API_BUILD_IMAGE);
    work = await mkdtemp(join(tmpdir(), "eint-"));
    const context = join(work, "image");
    await mkdir(context, { recursive: true });
    const { build } = await import("esbuild");
    // The three programs the round runs from the worker's own image: the model helper, the sealed name server and the stand-in helper (each as one file with its dependencies), and an init stand-in.
    for (const program of ["model-helper", "sealed-dns-helper", "eval-standin-helper"]) {
      await build({ entryPoints: [join(ROOT, `packages/worker/dist/${program}.js`)], absWorkingDir: ROOT, bundle: true, platform: "node", format: "esm", target: "node22", outfile: join(context, `${program}.js`), logLevel: "error",
        banner: { js: 'import { createRequire as __rovaraRequire } from "node:module"; const require = __rovaraRequire(import.meta.url);' } });
    }
    await writeFile(join(context, "tini"), '#!/bin/sh\n[ "$1" = "--" ] && shift\nexec "$@"\n', { mode: 0o755 });
    await writeFile(join(context, "Dockerfile"), `FROM ${APP_NODE_IMAGE}\nCOPY model-helper.js /opt/agentx/packages/worker/dist/model-helper.js\nCOPY sealed-dns-helper.js /opt/agentx/packages/worker/dist/sealed-dns-helper.js\nCOPY eval-standin-helper.js /opt/agentx/packages/worker/dist/eval-standin-helper.js\nCOPY tini /usr/bin/tini\n`);
    const built = await docker("build", "--pull=false", "-t", tag, context);
    expect(built.code, built.stderr).toBe(0);
    image = (await docker("image", "inspect", "--format", "{{.Id}}", tag)).stdout.trim();
    expect(image).toMatch(/^sha256:[a-f0-9]{64}$/u);
  }, 600_000);
  afterAll(async () => {
    await docker("image", "rm", "--force", tag);
    if (work !== "") await rm(work, { recursive: true, force: true });
  }, 120_000);

  async function world(round: EvalStandInRound) {
    const root = await mkdtemp(join(work, "w-"));
    const bridgeDir = join(root, "e1", EVAL_HELPER_DIR_NAME);
    await mkdir(bridgeDir, { recursive: true });
    await chmod(join(root, "e1"), 0o755); await chmod(bridgeDir, 0o755);
    const egress: ModelEgress = { capabilities: { schemes: [] }, async *forward(): AsyncGenerator<ModelEgressEvent> { yield { kind: "head", status: 200, headers: [] }; yield { kind: "settle", status: 200, class: "ok", costMicros: 0, estimated: false }; } };
    const bridge = createModelBridge({ egress, egressScope: {} as never, roundKind: "check_unsealed", familyOf: () => "gemini", ledger: createModelBridgeLedger({ now: Date.now }), now: Date.now, log: () => undefined });
    const socketPath = join(bridgeDir, EVAL_BRIDGE_SOCKET_NAME);
    await bridge.listen(socketPath);
    await chmod(socketPath, 0o666);
    const token = bridge.issueToken("run-1", "check_unsealed", ["real"]);
    const config: FreshEvalSandboxConfig = {
      docker: createDockerCli(), image, workspace: WORKSPACE, taskId: `eint-${randomBytes(4).toString("hex")}`, roundBudgetMs: 300_000,
      repository: { directory: root, baseCommit: "b".repeat(40), candidateCommit: "c".repeat(40) },
      command: { executable: "node", args: ["eval.js"], cwd: "." }, report: { cwd: ".", argument: REPORT }, rowId: "gemini", scratchDir: join(root, "scratch"), workingSandbox: null,
      environment: { AGENTX_TEST_SERVICES_BOOT_FACTS: FACTS, AGENTX_EVAL_STAND_INS: "1" },
      standIns: { round },
      materialize: async (_repo, _commit, destination) => { await writeFile(join(destination, "eval.js"), EVAL_SCRIPT); await chmod(destination, 0o777); },
    };
    return { bridge, token, socketPath, sandbox: createFreshEvalSandbox(config) };
  }
  const roundObjects = async () => ({
    containers: (await docker("ps", "-a", "--filter", `label=rovara.run-network.workspace=${WORKSPACE}`, "--format", "{{.Names}}")).stdout.trim(),
    networks: (await docker("network", "ls", "--filter", `label=rovara.run-network.workspace=${WORKSPACE}`, "--format", "{{.Name}}")).stdout.trim(),
  });
  type Report = { env: { hasCa: boolean; caPath: string }; calls: Record<string, { status?: number; label?: string | null; cls?: string | null; body?: string; error?: string }>; curl: string; reach: Record<string, string>; lookup: Record<string, string>; keyText: string };

  it("answers an https vendor name from the run's authority, names nothing else reachable, keeps the key out of the box, gives both sides the same bytes, and leaves nothing behind", async () => {
    const round = new EvalStandInRound({ workspaceId: WORKSPACE_ID, operationId: OPERATION_ID, plan: [{ host: "api.vendor.test" }],
      recorded: [{ method: "GET", host: "api.vendor.test", path: "/v1/recorded", query: "", status: 200, contentType: "application/json", body: "{\"recorded\":true}" }] });
    const reports: Report[] = [];
    for (const side of ["old", "new"] as const) {
      const w = await world(round);
      expect(w.sandbox.available()).toBe(true);
      const result = await w.sandbox.run({ side, ids: ["q1"], runs: 1, signal: new AbortController().signal, model: { socketPath: w.socketPath, token: w.token } });
      reports.push(JSON.parse(await readFile(join(result.report.root, REPORT), "utf8")) as Report);
      // The run reports what it was stood in for (SI-4's counts come from the helper's own summary).
      expect(result.standIns?.telemetry).toEqual(["sentry.io"]);
      expect(result.standIns?.hosts).toEqual(["api.vendor.test"]);
      await w.bridge.close();
      expect(await roundObjects()).toEqual({ containers: "", networks: "" });
    }
    for (const report of reports) {
      // SI-1: the recorded answer for a planned name, over TLS through the authority (and curl when the image has it); a made-up, labelled one for an unrecorded path and for a name nobody planned; OK for telemetry.
      expect(report.env.hasCa).toBe(true);
      expect(report.calls["recorded"]).toMatchObject({ status: 200, body: "{\"recorded\":true}" });
      expect(report.calls["plainHttp"]).toMatchObject({ status: 200, body: "{\"recorded\":true}" });
      expect(report.calls["madeUp"]).toMatchObject({ status: 200, label: "madeByRovara" });
      expect(report.calls["unplanned"]).toMatchObject({ status: 200, label: "madeByRovara", cls: "new_connection" });
      expect(report.calls["telemetry"]).toMatchObject({ status: 200, body: "OK", cls: "telemetry" });
      if (!report.curl.startsWith("unavailable")) expect(report.curl).toBe("{\"recorded\":true}");
      // SI-2: nothing else is reachable; a public name resolves only to the sinkhole (the stand-in), not to the internet.
      expect(report.reach["internet"]).not.toBe("open");
      expect(report.reach["metadata"]).not.toBe("open");
      expect(report.lookup["vendor"]).toMatch(/^172\.30\.\d+\.47$/u);
      expect(report.lookup["publicName"]).toMatch(/^172\.30\.\d+\.47$/u);
      // SI-3: only the PUBLIC certificate is in the box.
      expect(report.keyText).not.toContain("PRIVATE KEY");
    }
    // SI-4: the same request got the same bytes on both sides, and the book counted one recorded answer and the made-up ones once each.
    expect(reports[1]!.calls["madeUp"]!.body).toBe(reports[0]!.calls["madeUp"]!.body);
    expect(reports[1]!.calls["unplanned"]!.body).toBe(reports[0]!.calls["unplanned"]!.body);
    expect(round.book.counts()).toMatchObject({ recorded: 1, generatedNoContract: 1, newConnections: 1 });
    expect(round.telemetry()).toEqual(["sentry.io"]);
  }, 900_000);
});
