// TE-B1 on real Docker (CI's linux-runtime job, with the container firewall it installs from packages/worker/ec2/boot.sh): the fresh eval check sandbox, the model helper and the bridge, end to end.
//   TS-L1  the sandbox (.4) reaches the helper (.9) on the round's `rvi` network, a real model call goes sandbox -> helper -> the worker's bridge socket -> the stage's egress and back, and the helper itself reaches
//          neither the internet nor the host.
//   TS-L2  the sandbox is on the round network ONLY (the daemon's view and its own interfaces): a container on the default bridge (where a working sandbox would be) is not reachable from it, and nothing of the round is
//          reachable from a container outside it.
//   TS-L3  from the sandbox an IP literal on the internet, the metadata address, the round's gateway and the host fail; a public name does not resolve; a model host's name resolves to the helper.
//   TE-F1C-SOCKET-ACCESS  `docker inspect` while the eval runs: no container but the helper mounts the bridge folder, and the helper's mount is read-only; the sandbox mounts only the checkout (and its tmpfs).
//   Join  after `run` returns (and after a stop) no container or network of the round is left.
// The image is the CI node image plus the helper program (bundled from the built worker) and a stand-in for the worker image's init: the production worker image carries both. The worker side runs here as the CI user,
// not uid 1000 as on a worker, so this test makes the bridge folder and socket readable for the helper's uid itself (production needs no mode change: TE-F1C-SOCKET-ACCESS, the worker and the helper share uid 1000).
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
import { EVAL_BRIDGE_SOCKET_NAME, EVAL_HELPER_DIR_NAME, FRESH_EVAL_WORKSPACE, createFreshEvalSandbox, type FreshEvalSandboxConfig } from "../../packages/worker/src/verification/eval-bridged-exec.js";
import { ensureLocalImage } from "../support/ci-images.js";
import { APP_NODE_IMAGE } from "../support/linux-runtime.js";
import { assertFirewallInstalled, docker, listenOnAllAddresses } from "../support/linux-network-walls.js";

const ROOT = resolve(import.meta.dirname, "../..");
const FACTS = JSON.stringify({ metadataBlocked: true, runWalls: true, ipv6Drops: true, prepull: "off", prepulled: 0, loggedOut: true, dockerVersion: "27.3.1" });
const WORKSPACE = randomBytes(8).toString("hex");
const REPORT = "eval-report.json";
const enc = (text: string) => new TextEncoder().encode(text);

/** The eval the sandbox runs: it waits for the test's go (so the test can inspect the running containers), makes one model call through its base URL, probes the walls, and writes everything to the report. */
const EVAL_SCRIPT = `
const net = require("node:net"), dns = require("node:dns").promises, fs = require("node:fs"), os = require("node:os");
const reach = (host, port) => new Promise((done) => { const s = net.connect({ host, port, timeout: 3000 }); s.on("connect", () => { s.destroy(); done("open"); }).on("timeout", () => { s.destroy(); done("timeout"); }).on("error", (e) => done(e.code || "error")); });
const lookup = (name) => dns.lookup(name, { family: 4 }).then((r) => r.address, (e) => "error:" + (e.code || "x"));
(async () => {
  for (let i = 0; i < 600 && !fs.existsSync("/workspace/go"); i += 1) await new Promise((r) => setTimeout(r, 100));
  const targets = JSON.parse(fs.readFileSync("/workspace/targets.json", "utf8"));
  const out = { env: { side: process.env.ROVARA_EVAL_SIDE, runs: process.env.ROVARA_EVAL_RUNS, ids: process.env.ROVARA_EVAL_IDS, hasBase: typeof process.env.GOOGLE_GEMINI_BASE_URL === "string" } };
  try {
    const answer = await fetch(process.env.GOOGLE_GEMINI_BASE_URL + "/v1beta/models/gemini-test:generateContent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] }) });
    out.call = { status: answer.status, body: await answer.text() };
  } catch (e) { out.call = { error: String(e && e.code || e) }; }
  out.reach = {};
  for (const [name, host, port] of targets) out.reach[name] = await reach(host, port);
  out.lookup = { publicName: await lookup("example.com"), modelHost: await lookup("generativelanguage.googleapis.com"), helper: await lookup("rovara-models") };
  out.interfaces = Object.entries(os.networkInterfaces()).flatMap(([name, list]) => list.filter((a) => a.family === "IPv4" && !a.internal).map((a) => a.address));
  out.uid = process.getuid();
  fs.writeFileSync("/workspace/${REPORT}", JSON.stringify(out));
})();
`;

describe.runIf(process.platform === "linux" && process.env.ROVARA_DOCKER === "1")("TE-B1: the fresh eval check sandbox on Docker (TS-L1..L3, TE-F1C-SOCKET-ACCESS)", () => {
  let image = "";
  let work = "";
  let host: Awaited<ReturnType<typeof listenOnAllAddresses>> | undefined;
  let outsider = "";
  let outsiderIp = "";
  const tag = `rovara-te-b1-eval:${randomBytes(4).toString("hex")}`;

  beforeAll(async () => {
    await assertFirewallInstalled();
    await ensureLocalImage(APP_NODE_IMAGE, WEB_API_BUILD_IMAGE);
    work = await mkdtemp(join(tmpdir(), "teb1-"));
    // The helper program as one file (the built worker's dist bundled with its dependencies), and an init stand-in: `tini -- cmd args` -> exec cmd args.
    const context = join(work, "image");
    await mkdir(context, { recursive: true });
    const { build } = await import("esbuild");
    await build({ entryPoints: [join(ROOT, "packages/worker/dist/model-helper.js")], absWorkingDir: ROOT, bundle: true, platform: "node", format: "esm", target: "node22", outfile: join(context, "model-helper.js"), logLevel: "error",
      banner: { js: 'import { createRequire as __rovaraRequire } from "node:module"; const require = __rovaraRequire(import.meta.url);' } });
    await writeFile(join(context, "tini"), '#!/bin/sh\n[ "$1" = "--" ] && shift\nexec "$@"\n', { mode: 0o755 });
    await writeFile(join(context, "Dockerfile"), `FROM ${APP_NODE_IMAGE}\nCOPY model-helper.js /opt/agentx/packages/worker/dist/model-helper.js\nCOPY tini /usr/bin/tini\n`);
    const built = await docker("build", "--pull=false", "-t", tag, context);
    expect(built.code, built.stderr).toBe(0);
    image = (await docker("image", "inspect", "--format", "{{.Id}}", tag)).stdout.trim();
    expect(image).toMatch(/^sha256:[a-f0-9]{64}$/u);
    host = await listenOnAllAddresses();
    // Where a working sandbox would be: a container on the default bridge with a listener.
    outsider = `teb1-outsider-${randomBytes(4).toString("hex")}`;
    expect((await docker("run", "--detach", "--pull=never", "--name", outsider, "--user", "1000:1000", APP_NODE_IMAGE, "node", "-e", "require('net').createServer((s)=>s.end('x')).listen(9000)")).code).toBe(0);
    outsiderIp = (await docker("inspect", "--format", "{{.NetworkSettings.Networks.bridge.IPAddress}}", outsider)).stdout.trim();
    expect(outsiderIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/u);
  }, 600_000);
  afterAll(async () => {
    host?.server.close();
    if (outsider !== "") await docker("rm", "--force", outsider);
    await docker("image", "rm", "--force", tag);
    if (work !== "") await rm(work, { recursive: true, force: true });
  }, 120_000);

  /** One world: a bridge folder and a real bridge (whose egress is a stub the test sees), and a fresh sandbox whose checkout is the eval script. */
  async function world(evalScript = EVAL_SCRIPT) {
    const root = await mkdtemp(join(work, "w-"));
    const bridgeDir = join(root, "e1", EVAL_HELPER_DIR_NAME);
    await mkdir(bridgeDir, { recursive: true });
    await chmod(join(root, "e1"), 0o755); await chmod(bridgeDir, 0o755);
    const frames: unknown[] = [];
    const egress: ModelEgress = { capabilities: { schemes: [] }, async *forward(_scope, frame): AsyncGenerator<ModelEgressEvent> {
      frames.push(frame);
      yield { kind: "head", status: 200, headers: [["content-type", "application/json"]] };
      yield { kind: "chunk", bytes: enc('{"candidates":[{"content":{"parts":[{"text":"from the stage"}]}}]}') };
      yield { kind: "settle", status: 200, class: "ok", costMicros: 3, estimated: false };
    } };
    const logs: Record<string, unknown>[] = [];
    const bridge = createModelBridge({ egress, egressScope: {} as never, roundKind: "check_unsealed", familyOf: () => "gemini", ledger: createModelBridgeLedger({ now: Date.now }), now: Date.now, log: (fields) => logs.push({ ...fields }) });
    const socketPath = join(bridgeDir, EVAL_BRIDGE_SOCKET_NAME);
    await bridge.listen(socketPath);
    await chmod(socketPath, 0o666);
    const token = bridge.issueToken("run-1", "check_unsealed", ["real"]);
    let checkout = "";
    const config: FreshEvalSandboxConfig = {
      docker: createDockerCli(), image, workspace: WORKSPACE, taskId: `teb1-${randomBytes(4).toString("hex")}`, roundBudgetMs: 300_000,
      repository: { directory: root, baseCommit: "b".repeat(40), candidateCommit: "c".repeat(40) },
      command: { executable: "node", args: ["eval.js"], cwd: "." }, report: { cwd: ".", argument: REPORT }, rowId: "gemini", scratchDir: join(root, "scratch"), workingSandbox: null,
      environment: { AGENTX_TEST_SERVICES_BOOT_FACTS: FACTS },
      materialize: async (_repo, _commit, destination) => {
        checkout = destination;
        await writeFile(join(destination, "eval.js"), evalScript);
        await writeFile(join(destination, "targets.json"), "[]");
        // the sandbox's uid writes the report into its checkout
        await chmod(destination, 0o777);
      },
    };
    return { root, bridgeDir, bridge, token, frames, logs, config, sandbox: createFreshEvalSandbox(config), socketPath, checkoutOf: () => checkout };
  }
  const roundObjects = async () => ({
    containers: (await docker("ps", "-a", "--filter", `label=rovara.run-network.workspace=${WORKSPACE}`, "--format", "{{.Names}}")).stdout.trim(),
    networks: (await docker("network", "ls", "--filter", `label=rovara.run-network.workspace=${WORKSPACE}`, "--format", "{{.Name}}")).stdout.trim(),
  });
  const runningSandbox = async (): Promise<string | undefined> => (await docker("ps", "--filter", `label=rovara.run-network.workspace=${WORKSPACE}`, "--format", "{{.Names}}")).stdout.trim().split("\n").find((name) => name.endsWith("-eval"));
  const waitFor = async <T>(look: () => Promise<T | undefined>, ms = 120_000): Promise<T> => {
    for (let waited = 0; waited < ms; waited += 250) { const found = await look(); if (found !== undefined) return found; await new Promise((r) => setTimeout(r, 250)); }
    throw new Error("timed out waiting");
  };
  const reachFrom = (container: string, user: string, host: string, port: number) => docker("exec", "--user", user, container, "node", "-e",
    `const s=require('net').connect({host:${JSON.stringify(host)},port:${String(port)},timeout:3000});s.on('connect',()=>{console.log('open');process.exit(0)}).on('timeout',()=>{console.log('timeout');process.exit(0)}).on('error',(e)=>{console.log(e.code||'error');process.exit(0)})`);

  it("runs one side end to end and holds every wall; nothing of the round is left after", async () => {
    expect(host).toBeDefined();
    const w = await world();
    expect(w.sandbox.available()).toBe(true);
    const running = w.sandbox.run({ side: "old", ids: ["q1", "q2"], runs: 2, signal: new AbortController().signal, model: { socketPath: w.socketPath, token: w.token } });
    const sandboxName = await waitFor(runningSandbox);
    const helperName = sandboxName.replace(/-eval$/u, "-models");
    const net = sandboxName.replace(/-eval$/u, "");
    const sandboxIp = (await docker("inspect", "--format", `{{(index .NetworkSettings.Networks "${net}").IPAddress}}`, sandboxName)).stdout.trim();
    expect(sandboxIp).toMatch(/^172\.30\.\d+\.4$/u);
    const slotBase = sandboxIp.replace(/\.4$/u, "");

    // TE-F1C-SOCKET-ACCESS: the daemon's own view of every running container's mounts. Only the helper mounts the bridge folder, read-only; the sandbox mounts the checkout and nothing else.
    const all = (await docker("ps", "--format", "{{.Names}}")).stdout.trim().split("\n").filter(Boolean);
    for (const name of all) {
      const mounts = JSON.parse((await docker("inspect", "--format", "{{json .Mounts}}", name)).stdout) as { Source: string; Destination: string; RW: boolean; Type: string }[];
      const onBridge = mounts.filter((m) => m.Source === w.bridgeDir || m.Source.startsWith(`${w.bridgeDir}/`) || w.bridgeDir.startsWith(`${m.Source}/`));
      if (name === helperName) expect(mounts.filter((m) => m.Type === "bind")).toEqual([expect.objectContaining({ Source: w.bridgeDir, Destination: "/rovara/models", RW: false })]);
      else expect(onBridge, name).toEqual([]);
      if (name === sandboxName) expect(mounts.filter((m) => m.Type !== "tmpfs").map((m) => [m.Destination, m.RW])).toEqual([[FRESH_EVAL_WORKSPACE, true]]);
    }
    // TS-L2: the sandbox and the helper are each on the round network and nothing else, at .4 and .9.
    expect(JSON.parse((await docker("inspect", "--format", "{{json .NetworkSettings.Networks}}", sandboxName)).stdout) as Record<string, { IPAddress: string }>).toEqual({ [net]: expect.objectContaining({ IPAddress: `${slotBase}.4` }) });
    expect(Object.keys(JSON.parse((await docker("inspect", "--format", "{{json .NetworkSettings.Networks}}", helperName)).stdout) as object)).toEqual([net]);
    expect((await docker("network", "inspect", "--format", "{{.Internal}}", net)).stdout.trim()).toBe("true");
    // TS-L1 (second half): the helper reaches neither the internet nor the host; TS-L2: a container outside the round cannot reach the helper.
    expect((await reachFrom(helperName, "1000:1000", "1.1.1.1", 443)).stdout.trim()).not.toBe("open");
    expect((await reachFrom(helperName, "1000:1000", `${slotBase}.1`, host!.port)).stdout.trim()).not.toBe("open");
    expect((await reachFrom(outsider, "1000:1000", `${slotBase}.9`, 8080)).stdout.trim()).not.toBe("open");
    // Controls: the host listener and the outsider's listener ARE reachable from the default bridge, so a failure above is the wall, not a dead target.
    expect((await reachFrom(outsider, "1000:1000", outsiderIp, 9000)).stdout.trim()).toBe("open");

    // The eval's own probes (TS-L1, TS-L3), then the go.
    await writeFile(join(w.checkoutOf(), "targets.json"), JSON.stringify([
      ["helper", `${slotBase}.9`, 8080], ["internet", "1.1.1.1", 443], ["metadata", "169.254.169.254", 80], ["gateway", `${slotBase}.1`, host!.port], ["outsider", outsiderIp, 9000], ["helperTls", `${slotBase}.9`, 443],
    ]));
    await writeFile(join(w.checkoutOf(), "go"), "");
    const result = await running;
    const report = JSON.parse(await readFile(join(result.report.root, REPORT), "utf8")) as {
      env: Record<string, unknown>; call: { status?: number; body?: string; error?: string }; reach: Record<string, string>; lookup: Record<string, string>; interfaces: string[]; uid: number;
    };
    expect(report.env).toEqual({ side: "old", runs: "2", ids: "q1,q2", hasBase: true });
    // TS-L1: a real call, sandbox -> helper -> bridge -> the stage's egress, once, and its answer back.
    expect(report.call).toMatchObject({ status: 200 });
    expect(report.call.body).toContain("from the stage");
    expect(w.frames).toHaveLength(1);
    expect(w.logs.filter((line) => line["event"] === "dropped" || line["event"] === "refused")).toEqual([]);
    expect(report.reach["helper"]).toBe("open");
    // TS-L3
    for (const target of ["internet", "metadata", "gateway", "outsider", "helperTls"]) expect(report.reach[target], target).not.toBe("open");
    expect(report.lookup["publicName"]).toMatch(/^error:/u);
    expect(report.lookup["modelHost"]).toBe(`${slotBase}.9`);
    expect(report.lookup["helper"]).toBe(`${slotBase}.9`);
    // TS-L2 from inside: one interface, the round's .4; not root.
    expect(report.interfaces).toEqual([`${slotBase}.4`]);
    expect(report.uid).toBe(1000);
    expect(result.attestation?.baseCommit).toBe("b".repeat(40));
    // Join: nothing of the round is left.
    expect(await roundObjects()).toEqual({ containers: "", networks: "" });
    await w.bridge.close();
  }, 600_000);

  it("a stop while the eval runs: the sandbox is killed, and run rejects only after the helper and the network are gone", async () => {
    const w = await world("setInterval(() => undefined, 1000);");
    const stop = new AbortController();
    const running = w.sandbox.run({ side: "new", ids: ["q1"], runs: 1, signal: stop.signal, model: { socketPath: w.socketPath, token: w.token } });
    await waitFor(runningSandbox);
    stop.abort();
    await expect(running).rejects.toThrow("eval stage stopped");
    expect(await roundObjects()).toEqual({ containers: "", networks: "" });
    await w.bridge.close();
  }, 600_000);
});
