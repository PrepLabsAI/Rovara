import { createHash } from "node:crypto";
import { cp, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { e2eModelRouteRevision } from "../../packages/contracts/src/e2e-model-channel.js";
import { createInMemoryE2EDayBudget } from "../../packages/model-runtime/src/e2e-route.js";
import { scriptedE2ERouteDefinition } from "../../packages/model-runtime/src/e2e-route-derive.js";
import { runIsolatedE2EApplication } from "../../packages/verifier/src/application-runtime.js";
import { createScriptedE2EInvoke } from "../../packages/worker/src/e2e-model-scripted.js";
import { createE2EModelEvidenceCollector, openE2EModelChannelSession } from "../../packages/worker/src/e2e-model-channel-session.js";
import { MOCK_UNMOCKED_BODY, MOCK_UNMOCKED_STATUS } from "../../packages/verifier/src/executor/mock-server.js";
import { createDockerApplicationHost, createProcessDockerCli } from "../../packages/verifier/src/host/docker-application-host.js";
import { ORDERS_FIXTURE_ROOT, createOrdersExecutorPlan } from "../support/e2e-orders-executor-fixture.js";
import { assertFirewallInstalled, docker } from "../support/linux-network-walls.js";
import { APP_NODE_IMAGE, EXECUTOR_IMAGE, linuxRunInput } from "../support/linux-runtime.js";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

// Task 4.3a, test case 15. It runs only in CI's `linux-runtime` job (ubuntu-24.04-arm, ROVARA_DOCKER=1, the executor image built there, and the container firewall boot.sh
// installs), with a scripted model route and ROVARA_E2E_SCRIPTED_MODEL=1 in the session's environment. The production Docker host starts the app and an executor container
// from the real executor image; the executor container's command is replaced by a test-only entry (a derived image, so the host, the mount and the walls are the production ones)
// that makes the three calls an agent step makes over the mounted socket: a step marker, a model call, an end marker.
describe.runIf(process.platform === "linux" && process.env.ROVARA_DOCKER === "1")("the model channel on a real Docker host", () => {
  const TEST_IMAGE = "rovara-e2e-executor:model-channel-test";
  const GOAL = "Export the orders as a CSV file";
  const ROUTE = { routeId: "rovara-scripted/v1", routeRevision: e2eModelRouteRevision(scriptedE2ERouteDefinition()) };
  let imageDir: string;
  const scratch: string[] = [];

  /** The executor image with a command of its own: the real image's files and user model, the entry below as CMD (the mock containers pass their own command, so they are unaffected). */
  async function buildTestImage(): Promise<void> {
    imageDir = realpathSync(await mkdtemp(join(tmpdir(), "rovara-model-image-")));
    const entry = `
      import { readFileSync } from "node:fs";
      import { existsSync } from "node:fs";
      const plan = JSON.parse(readFileSync("/run/rovara/plan.json", "utf8"));
      const { createE2EModelChannelClient } = await import("/opt/agentx/packages/verifier/dist/executor/model-channel.js");
      const caseId = plan.admission.groups[0].outerBinding.expectedCases[0].caseId;
      const client = createE2EModelChannelClient({ socketPath: plan.modelChannel.socketPath, runId: plan.runId, sessionSync: { read: async () => [] } });
      const call = { prompt: [{ role: "system", content: "You drive a web application one tool call at a time." },
        { role: "user", content: [{ type: "text", text: "Goal: ${GOAL}\\n#n1 button \\"Download orders\\"" }] }],
        tools: [{ type: "function", name: "tap", inputSchema: { type: "object", properties: { target: { type: "string" } } } },
          { type: "function", name: "complete_step", inputSchema: { type: "object" } }] };
      await client.beginStep({ caseId, stepIndex: 0 });
      const answer = await client.generate({ caseId, stepIndex: 0, callIndex: 0, call });
      await client.endStep({ caseId, stepIndex: 0 });
      console.log("MODEL_CHANNEL_ANSWER " + JSON.stringify({ answer, planSocket: plan.modelChannel.socketPath, mounted: existsSync(plan.modelChannel.socketPath) }));
      // The app's wall probe waits up to 3 s per target before it logs; keep the run up until it has, or the host tears the app down first and its log is empty.
      await new Promise((resolve) => setTimeout(resolve, 8000));
    `;
    await writeFile(join(imageDir, "test-entry.mjs"), entry);
    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
    // The proxy hands the socket to uid 1000 only when the worker is root (as the EC2 worker is); a CI runner's own user owns it, and the entry runs as that user.
    await writeFile(join(imageDir, "Dockerfile"), `FROM ${EXECUTOR_IMAGE}\nARG ENTRY_UID=1000\nCOPY test-entry.mjs /opt/agentx/test-model-channel-entry.mjs\nUSER \${ENTRY_UID}\nCMD ["node", "/opt/agentx/test-model-channel-entry.mjs"]\n`);
    const built = await docker("build", "--quiet", "--build-arg", `ENTRY_UID=${uid === 0 ? 1000 : uid}`, "-t", TEST_IMAGE, imageDir);
    if (built.code !== 0) throw new Error(`could not build the test executor image: ${built.stderr}`);
  }

  beforeAll(async () => { await assertFirewallInstalled(); await buildTestImage(); }, 600_000);
  afterAll(async () => {
    await docker("rmi", "-f", TEST_IMAGE);
    for (const dir of [imageDir, ...scratch]) if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }, 120_000);

  /**
   * Node run by the app container as its start command, then the app: it says what the app container can see and reach, to its own log, and then starts the fixture server.
   * The server starts only from `startOrdersServer()`: `server.mjs` starts itself only when it is node's main script, which it is not under `node -e`, and an app that only
   * imports it has nothing left to do and exits (the host then reports `app-exited` and stops the executor).
   * `model-proxy` is not a name of the run, so the app's resolver (the run's sinkhole, named in its resolv.conf) answers it with the sinkhole's own address, and the sinkhole
   * serves 8080 too: the probe resolves the name, compares the address with the sinkhole's (from the hosts file the host wrote), and asks it over HTTP for its fingerprint.
   */
  const appProbe = [
    "const fs=require('fs'),net=require('net'),dns=require('dns');",
    "const rows=fs.readFileSync('/proc/net/route','utf8').split('\\n').slice(1).map(l=>l.split('\\t'));",
    // An --internal network has no default route; the bridge's own address (the subnet's first host) is then the host side to probe.
    "const ip=(h)=>{const v=parseInt(h,16);return [v&255,v>>8&255,v>>16&255,(v>>>24)]};const rt=rows.filter(f=>f.length>2&&/^[0-9A-F]{8}$/.test(f[1]));",
    "const def=rt.find(f=>f[1]==='00000000');const net0=rt.find(f=>f[1]!=='00000000');",
    "const gateway=def?ip(def[2]).join('.'):net0?ip(net0[1]).map((o,i)=>i===3?o+1:o).join('.'):'127.0.0.1';const hasDefaultRoute=def!==undefined;",
    "const reach=(h,p)=>new Promise(o=>{const s=net.connect({host:h,port:p,timeout:3000});s.on('connect',()=>{s.destroy();o('open')}).on('timeout',()=>{s.destroy();o('timeout')}).on('error',e=>o(e.code))});",
    "const lookup=(h)=>new Promise(o=>dns.lookup(h,{family:4},(e,a)=>o(e?'error:'+e.code:a)));",
    "const ask=(u)=>fetch(u,{signal:AbortSignal.timeout(3000),redirect:'manual'}).then(async r=>({status:r.status,body:(await r.text()).slice(0,200)}),e=>({status:0,body:String(e&&e.cause&&e.cause.code||e&&e.name)}));",
    // The host writes every run name into the app's hosts file; the sinkhole's alias is `mock-unbound`, and its address is also the app's nameserver.
    "const hostLine=fs.readFileSync('/etc/hosts','utf8').split('\\n').map(l=>l.trim().split(/\\s+/)).find(f=>f.slice(1).includes('mock-unbound'));",
    "const sinkhole=hostLine?hostLine[0]:null;const nameserver=(fs.readFileSync('/etc/resolv.conf','utf8').match(/^nameserver\\s+(\\S+)/m)||[])[1]||null;",
    "Promise.all([lookup('model-proxy'),reach('model-proxy',8080),ask('http://model-proxy:8080/'),reach(gateway,8080)]).then(([proxyAddress,proxy,proxyAnswer,gate])=>{",
    "console.log('MODEL_WALL '+JSON.stringify({socket:fs.existsSync('/run/rovara/model.sock'),runRovara:fs.existsSync('/run/rovara'),proxyAddress,proxy,proxyAnswer,sinkhole,nameserver,gatewayAddress:gateway,gateway:gate,hasDefaultRoute}));",
    "return import('/app/server.mjs').then(m=>m.startOrdersServer())})",
  ].join("");

  it("serves a scripted call from the executor client over the mounted socket and writes the receipt; the app container cannot see or reach the proxy; no socket is left", async () => {
    const fixture = createOrdersExecutorPlan({ probe: "web-csv-positive-v1", modelRoute: ROUTE, recipeStart: { args: ["-e", appProbe] },
      accountScenarios: [{ accountProfileId: "orders-owner", scenario: (targetId: string) => ({ scenarioId: "agent-export", requirementId: "orders-export", requestedTargetIds: [targetId], required: true,
        accountProfileId: "orders-owner", minimumEvidence: "runtime" as const, requiredRealComponentIds: [], steps: [{ kind: "agent" as const, goal: GOAL, maxActions: 4 }],
        assertions: [{ kind: "csv" as const, downloadName: "orders.csv", columns: ["id", "total"], rows: [["1", "10"]] }] }) }] });
    const evidence = createE2EModelEvidenceCollector();
    const closes: unknown[] = [];
    let socketAtOpen = "";
    const dir = realpathSync(await mkdtemp(join(tmpdir(), "rovara-model-host-")));
    scratch.push(dir);
    const candidateSourceDir = join(dir, "candidate");
    await cp(ORDERS_FIXTURE_ROOT, candidateSourceDir, { recursive: true });
    // A short run root: the model socket path (<runRoot>/<runId>/model/model.sock) must fit a unix socket's 103 bytes, and a CI runner's tmpdir is far deeper than the worker's.
    // The production root is bounded by tests/unit/worker-e2e-application-runtime.test.ts.
    const runRoot = realpathSync(await mkdtemp("/tmp/rvm-"));
    scratch.push(runRoot);
    // The production host over the derived image: the mount, the walls, the cleanup and the plan are the host's own.
    const host = createDockerApplicationHost({ docker: createProcessDockerCli(), executorImage: TEST_IMAGE, buildImage: APP_NODE_IMAGE, runRoot, now: () => Date.now(),
      admission: fixture.plan.admission, groupId: fixture.plan.groupId, candidateSourceDir, modelChannel: { async open(input) {
        socketAtOpen = input.socketPath;
        const session = await openE2EModelChannelSession({ runId: fixture.plan.runId, modelRoute: ROUTE, policyScope: "standard", socketPath: input.socketPath,
          allowedSteps: [{ caseId: fixture.compiled.expectedCases[0]!.caseId, stepIndex: 0 }], credentialSet: { ...input.credentialSet, cookieValues: [] }, deadlineAt: input.deadlineAt,
          dayBudget: createInMemoryE2EDayBudget(), evidence, signal: input.signal, environment: { ROVARA_E2E_SCRIPTED_MODEL: "1" },
          invoke: createScriptedE2EInvoke({ scripts: { [sha256(GOAL)]: [{ kind: "tap", name: /Download orders/ }] } }) });
        return { close: async () => { const summary = await session.close(); closes.push(summary); return { ...summary, transcripts: evidence.transcripts(), valueKey: input.valueKey, definition: session.definition }; } };
      } } });
    const run = await runIsolatedE2EApplication({ input: linuxRunInput(fixture) as never, compiled: fixture.compiled, ports: host, signal: AbortSignal.timeout(280_000) });
    const diagnostics = host.readDiagnostics(fixture.plan.runId);

    // The entry is not a real executor, so no result file comes back; what the run did is in its logs.
    expect(run.unavailableReason, JSON.stringify(diagnostics)).toBe("executor-result-mismatch");
    const answerLine = diagnostics.executorLogTail.split("\n").find((line) => line.startsWith("MODEL_CHANNEL_ANSWER "));
    expect(answerLine, diagnostics.executorLogTail).toBeDefined();
    const seen = JSON.parse(answerLine!.slice("MODEL_CHANNEL_ANSWER ".length)) as { answer: { result: { status: string; content: Array<{ type: string; toolName: string }> } }; planSocket: string; mounted: boolean };
    expect(seen.planSocket).toBe("/run/rovara/model.sock");
    expect(seen.mounted).toBe(true);
    expect(seen.answer.result.status).toBe("ok");
    expect(seen.answer.result.content[0]).toMatchObject({ type: "tool-call", toolName: "tap" });

    // One receipt, written by the worker's proxy from its own state.
    expect(evidence.receipts()).toHaveLength(1);
    expect(evidence.receipts()[0]).toMatchObject({ runId: fixture.plan.runId, stepIndex: 0, callIndex: 0, outcome: "ok", routeId: "rovara-scripted/v1" });
    expect(closes).toHaveLength(1);

    // The app container saw no socket and no /run/rovara, and reached neither the worker's proxy by name nor the gateway on the proxy's port.
    const wallLine = diagnostics.appLogTail.split("\n").find((line) => line.startsWith("MODEL_WALL "));
    expect(wallLine, JSON.stringify(diagnostics)).toBeDefined();
    const wall = JSON.parse(wallLine!.slice("MODEL_WALL ".length)) as { socket: boolean; runRovara: boolean; proxyAddress: string; proxy: string;
      proxyAnswer: { status: number; body: string }; sinkhole: string | null; nameserver: string | null; gatewayAddress: string; gateway: string; hasDefaultRoute: boolean };
    expect(wall.socket).toBe(false);
    expect(wall.runRovara).toBe(false);
    // `model-proxy` is no name of the run: the run's own resolver answers it with the sinkhole's address, and what answers there on 8080 is the sinkhole (its fixed
    // unmocked answer), never the worker's proxy (which listens on a unix socket only) and never the host side of the bridge.
    expect(wall.sinkhole, wallLine).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(wall.nameserver, wallLine).toBe(wall.sinkhole);
    expect(wall.proxyAddress, wallLine).toBe(wall.sinkhole);
    expect(wall.proxyAddress, wallLine).not.toBe(wall.gatewayAddress);
    expect(wall.proxyAnswer, wallLine).toEqual({ status: MOCK_UNMOCKED_STATUS, body: MOCK_UNMOCKED_BODY });
    // The run network is --internal: no way out, and the host side of the bridge never answers on the proxy's port.
    expect(wall.hasDefaultRoute).toBe(false);
    expect(wall.gateway).not.toBe("open");

    // Nothing is left: the socket is unlinked on close, the run directory is gone, and no container or network of the run remains.
    await expect(stat(socketAtOpen)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(runRoot, fixture.plan.runId))).rejects.toMatchObject({ code: "ENOENT" });
    const label = `label=rovara.run=${fixture.plan.runId}`;
    expect((await docker("ps", "-a", "--filter", label, "--format", "{{.Names}}")).stdout.trim()).toBe("");
    expect((await docker("network", "ls", "--filter", label, "--format", "{{.Name}}")).stdout.trim()).toBe("");
  }, 400_000);
});
