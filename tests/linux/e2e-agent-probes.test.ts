import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WEB_API_AGENT_PROBE_IDS, evaluateWebApiProbeObservation, type WebApiProbeObservation } from "../../packages/contracts/src/index.js";
import { e2eRunNetworks } from "../../packages/verifier/src/host/docker-application-host.js";
import { webApiAgentIsolationGuardArgs } from "../../packages/verifier/src/host/web-api-probe-plan.js";
import { verifyWebApiProbeRecord } from "../../packages/verifier/src/web-api-probe-evidence.js";
import { substituteGuard } from "../support/agent-probe-guard.js";
import { createLinuxProbeRunner, linuxProbeScratch, removeWebApiProbeScratch } from "../support/linux-web-api-probes.js";
import { APP_NODE_IMAGE, removeProbeDirs } from "../support/linux-runtime.js";
import { assertFirewallInstalled, docker, listenOnAllAddresses } from "../support/linux-network-walls.js";
import { webApiChallenge } from "../support/web-api-qualification.js";

// M1.4 Task 4.5 on a real Docker host: the three agent qualification probes through the production probe runner, the Docker host and the real collector, with the worker's real model
// proxy answering from the scripted double (route `rovara-scripted/v1`: no provider, no spend); and the isolation guard itself, run in the container network a run gives its app.
// It runs only in the CI `linux-runtime` job (ubuntu-24.04-arm, ROVARA_DOCKER=1, ROVARA_EXECUTOR_IMAGE, with the container firewall from boot.sh applied); elsewhere it skips.
const [SCRIPTED, WRONG_ACTION, ISOLATION] = WEB_API_AGENT_PROBE_IDS as readonly [string, string, string];

describe.runIf(process.platform === "linux" && process.env.ROVARA_DOCKER === "1")("the agent qualification probes on a real Docker host", () => {
  const networks: string[] = [];
  const cleanups: Array<() => Promise<unknown>> = [];
  let workerStandIn: Awaited<ReturnType<typeof listenOnAllAddresses>> | null = null;
  beforeAll(async () => {
    await assertFirewallInstalled();
    // Where the Rovara worker listens on a runner: the isolation probe's guard tries this port on the gateway, so it must be open for a missing wall to show.
    workerStandIn = await listenOnAllAddresses(8080).catch(() => null);
  }, 120_000);
  afterAll(async () => {
    workerStandIn?.server.close();
    for (const name of networks.splice(0)) await docker("network", "rm", name);
    for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
    await removeProbeDirs();
    await removeWebApiProbeScratch();
  }, 120_000);

  async function runProbe(probeId: string) {
    const { runRoot, evidenceRoot } = await linuxProbeScratch();
    const challenge = webApiChallenge(Date.now());
    const runner = createLinuxProbeRunner({ executorImage: process.env.ROVARA_EXECUTOR_IMAGE ?? "rovara-e2e-executor:ci", buildImage: APP_NODE_IMAGE, runRoot, evidenceRoot, challenge });
    const run = await runner(probeId);
    return { challenge, run };
  }
  const explain = (observation: WebApiProbeObservation, evidence: { kind: string; reason?: string }) => `${JSON.stringify(observation)} ${evidence.kind === "unavailable" ? String(evidence.reason) : ""}`;

  it.each([[SCRIPTED, { receipts: 2, verifiedReceipts: 2, downloads: 1, caseReasons: [] as string[], collectorStatus: "PASS" }],
    [WRONG_ACTION, { receipts: 1, verifiedReceipts: 0, downloads: 0, caseReasons: ["agent-no-download"], collectorStatus: "UNKNOWN" }],
    [ISOLATION, { receipts: 2, verifiedReceipts: 2, downloads: 1, caseReasons: [] as string[], collectorStatus: "PASS" }]] as const)(
    "%s runs to the outcome the qualification pins and derives from its own retained evidence", async (probeId, expected) => {
      const { challenge, run } = await runProbe(probeId);
      const why = explain(run.observation, run.evidence);
      expect(run.evidence.kind, why).toBe("collected");
      expect(run.observation, why).toMatchObject({ collectorStatus: expected.collectorStatus, runUnavailableReason: null, failedAssertionKinds: [], attempts: 1, skipped: 0, flaky: 0,
        agent: { routeId: "rovara-scripted/v1", receipts: expected.receipts, okReceipts: expected.receipts, verifiedReceipts: expected.verifiedReceipts, downloads: expected.downloads,
          caseReasons: expected.caseReasons, unmockedCalls: { sinkhole: 0, mocked: 0 } } });
      expect(evaluateWebApiProbeObservation(probeId, run.observation), why).toEqual({ ok: true });
      expect(verifyWebApiProbeRecord({ challenge, probeId, observation: run.observation, evidence: run.evidence })).toEqual({ ok: true });
    }, 600_000);

  describe("the isolation guard, run as the app container runs it", () => {
    const script = webApiAgentIsolationGuardArgs()[2]!;
    /** The pinned guard, with the port it tries replaced by the stand-in's; the app it starts is a one-line server beside it that logs STARTED. */
    const guardArgs = (port: number) => ["--input-type=module", "-e", substituteGuard(script, [["port:8080", `port:${String(port)}`]])];
    const fakeApp = "import{createServer}from'node:http';export function startOrdersServer(){const s=createServer((q,r)=>r.end('app'));s.listen(4317,'0.0.0.0',()=>console.log('STARTED'));return s}\n";
    const names: string[] = [];
    afterAll(async () => { for (const name of names.splice(0)) await docker("rm", "-f", name); });
    async function network(kind: "walled" | "plain"): Promise<string> {
      const nets = e2eRunNetworks(`guard-${String(Date.now())}-${kind}`);
      networks.push(nets.internal);
      // A walled network is named as a run's internal bridge is, so the firewall's rule for the app's side applies; a plain internal network is the control.
      const args = kind === "walled" ? ["network", "create", "--internal", "-o", `com.docker.network.bridge.name=${nets.internalBridge}`, nets.internal] : ["network", "create", "--internal", nets.internal];
      const created = await docker(...args);
      expect(created.code, created.stderr).toBe(0);
      return nets.internal;
    }
    /** Starts the guard as the app container's command, detached, and returns its name. */
    async function startContainer(net: string, socket: string | null, port: number): Promise<string> {
      const dir = await mkdtemp("/tmp/rvgd-");
      cleanups.push(() => rm(dir, { recursive: true, force: true }));
      writeFileSync(join(dir, "server.mjs"), fakeApp);
      chmodSync(dir, 0o755); chmodSync(join(dir, "server.mjs"), 0o644);
      const name = `rovara-guard-${String(Date.now())}-${String(names.length)}`;
      names.push(name);
      const mount = socket === null ? [] : ["-v", `${socket}:/run/rovara/model.sock:ro`];
      const started = await docker("run", "-d", "--pull=never", "--name", name, "--network", net, "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000", "-v", `${dir}:/g:ro`, "-w", "/g", ...mount,
        APP_NODE_IMAGE, "node", ...guardArgs(port));
      expect(started.code, started.stderr).toBe(0);
      return name;
    }
    const state = async (name: string) => {
      const inspect = (await docker("inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", name)).stdout.trim().split(" ");
      return { status: inspect[0] ?? "", exitCode: Number(inspect[1] ?? "-1"), started: (await docker("logs", name)).stdout.includes("STARTED") };
    };
    /** Polls until the container has exited, or until `ms` have passed. */
    async function settle(name: string, ms: number, until: (s: Awaited<ReturnType<typeof state>>) => boolean = (s) => s.status === "exited") {
      const deadline = Date.now() + ms;
      let current = await state(name);
      while (!until(current) && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 400)); current = await state(name); }
      return current;
    }

    it("starts the app behind the wall when no socket is visible and keeps it up, and does not start it when the model socket is visible from the start", async () => {
      const dir = await mkdtemp("/tmp/rvgs-");
      cleanups.push(() => rm(dir, { recursive: true, force: true }));
      const socket = join(dir, "model.sock");
      writeFileSync(socket, "");
      chmodSync(socket, 0o666);
      const walled = await network("walled");
      const port = workerStandIn?.port ?? 8080;
      const clear = await startContainer(walled, null, port);
      const up = await settle(clear, 60_000, (s) => s.started || s.status === "exited");
      expect({ status: up.status, started: up.started }).toEqual({ status: "running", started: true });
      // The checks that repeat do not end an app that nothing reaches the model from.
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      expect((await state(clear)).status).toBe("running");
      const visible = await startContainer(walled, socket, port);
      const refused = await settle(visible, 60_000);
      expect({ status: refused.status, exitCode: refused.exitCode, started: refused.started }).toEqual({ status: "exited", exitCode: 3, started: false });
    }, 300_000);

    it("ends the app when the model socket appears after the app started (the host opens the channel after it starts the app)", async () => {
      const walled = await network("walled");
      const name = await startContainer(walled, null, workerStandIn?.port ?? 8080);
      const up = await settle(name, 60_000, (s) => s.started || s.status === "exited");
      expect({ status: up.status, started: up.started }).toEqual({ status: "running", started: true });
      // As root in the app's own container (no capability needed in a directory it owns), the late mount: the socket appears where the guard looks.
      const mounted = await docker("exec", "--user", "0", name, "sh", "-c", "mkdir -p /run/rovara && touch /run/rovara/model.sock");
      expect(mounted.code, mounted.stderr).toBe(0);
      const ended = await settle(name, 30_000);
      expect({ status: ended.status, exitCode: ended.exitCode }).toEqual({ status: "exited", exitCode: 3 });
    }, 300_000);

    it("does not start the app when the gateway on the port answers, which is what a missing wall looks like (control: the same network kind without the wall)", async () => {
      const server = await listenOnAllAddresses();
      try {
        const plain = await network("plain");
        const open = await settle(await startContainer(plain, null, server.port), 60_000);
        expect({ status: open.status, exitCode: open.exitCode, started: open.started }).toEqual({ status: "exited", exitCode: 3, started: false });
        // Behind the wall the same listener is unreachable, so the guard lets the app start.
        const walled = await network("walled");
        const closed = await settle(await startContainer(walled, null, server.port), 60_000, (s) => s.started || s.status === "exited");
        expect({ status: closed.status, started: closed.started }).toEqual({ status: "running", started: true });
      } finally { server.server.close(); }
    }, 300_000);
  });
});
