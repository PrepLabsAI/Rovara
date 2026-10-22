import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:net";
import { webApiAppStartGuardArgs } from "../../packages/verifier/src/host/web-api-probe-plan.js";
import { e2eRunNetworks } from "../../packages/verifier/src/host/docker-application-host.js";
import { createOrdersExecutorPlan } from "../support/e2e-orders-executor-fixture.js";
import { WEB_API_BUILD_IMAGE } from "../../packages/verifier/src/host/web-api-probe-runner.js";
import { ensureLocalImage } from "../support/ci-images.js";
import { APP_NODE_IMAGE, createLinuxHost, linuxRunInput, removeProbeDirs, runProbe } from "../support/linux-runtime.js";
import { runIsolatedE2EApplication } from "../../packages/verifier/src/application-runtime.js";
import { assertFirewallInstalled, docker, listenOnAllAddresses, reachScript, runNodeIn, startRoutedPrivateServer } from "../support/linux-network-walls.js";

// Real Docker, with the container firewall the CI `linux-runtime` job installs from packages/worker/ec2/boot.sh (the very heredoc the EC2 boot runs).
// Each wall is shown against a control: the same connection from a container that is not behind the wall succeeds, so a timeout is the firewall, not a broken test.
describe.runIf(process.platform === "linux" && process.env.ROVARA_DOCKER === "1")("network walls around untrusted containers", () => {
  let host: { port: number; server: Server };
  const networks: string[] = [];
  beforeAll(async () => {
    await assertFirewallInstalled();
    // The CI job already pulled the build image from the GHCR mirror; only a machine without it pulls (with a bounded retry), and the digest is checked either way.
    await ensureLocalImage(APP_NODE_IMAGE, WEB_API_BUILD_IMAGE);
    host = await listenOnAllAddresses();
  }, 300_000);
  afterAll(async () => {
    host?.server.close();
    for (const name of networks.splice(0)) await docker("network", "rm", name);
    await removeProbeDirs();
  }, 120_000);

  const buildStep = (script: string) => [{ program: "node", args: ["-e", script], cwd: ".", timeoutMs: 120_000, env: {} }];
  async function buildWith(script: string) {
    const fixture = createOrdersExecutorPlan({ probe: "web-csv-positive-v1", recipeBuild: buildStep(script) });
    const { host: dockerHost } = await createLinuxHost(fixture);
    const run = await runIsolatedE2EApplication({ input: linuxRunInput(fixture) as never, compiled: fixture.compiled, ports: dockerHost, signal: AbortSignal.timeout(280_000) });
    const label = `label=rovara.run=${fixture.plan.runId}`;
    return { fixture, run, log: dockerHost.readDiagnostics(fixture.plan.runId).buildLogTail,
      leftovers: { containers: (await docker("ps", "-a", "--filter", label, "--format", "{{.Names}}")).stdout.trim(), networks: (await docker("network", "ls", "--filter", label, "--format", "{{.Name}}")).stdout.trim() } };
  }

  it("the build container cannot reach a server the host listens on, though a container on the default bridge can", async () => {
    const script = reachScript([["gateway", host.port]]);
    const control = await runNodeIn("bridge", script);
    expect(control.stdout.trim(), `control: ${control.stderr}`).toBe('["open"]');
    const built = await buildWith(script);
    expect(built.run.unavailableReason, built.log).toBe("build-failed");
    expect(built.log).toMatch(/\["timeout"\]/);
    expect(built.log).toMatch(/exit code 7/);
    expect(built.leftovers).toEqual({ containers: "", networks: "" });
  }, 300_000);

  it("the build container cannot reach a private address that is routed beyond the host, though a container on the default bridge can", async () => {
    const routed = await startRoutedPrivateServer(host.port);
    try {
      const script = reachScript([[routed.address, host.port]]);
      const control = await runNodeIn("bridge", script);
      expect(control.stdout.trim(), `control: ${control.stderr}`).toBe('["open"]');
      const built = await buildWith(script);
      expect(built.run.unavailableReason, built.log).toBe("build-failed");
      expect(built.log).toMatch(/\["timeout"\]/);
      expect(built.log).toMatch(/exit code 7/);
    } finally { await routed.stop(); }
  }, 300_000);

  it("the build container still resolves names and fetches the package registry over the internet", async () => {
    const fetchRegistry = "fetch('https://registry.npmjs.org/').then(r=>{console.log('registry status '+r.status);process.exit(r.status===200?0:1)},e=>{console.log('registry error '+String(e.cause&&e.cause.code||e));process.exit(1)})";
    const built = await buildWith(fetchRegistry);
    // A build that succeeds goes on to run the app and the executor, so the CSV positive passing also shows app and executor still talk on the internal network.
    expect(built.run.unavailableReason, built.log).toBeNull();
    expect(built.log).toContain("registry status 200");
    expect(built.leftovers).toEqual({ containers: "", networks: "" });
  }, 300_000);

  it("the app container cannot reach a server the host listens on, though a container on an ordinary internal network can", async () => {
    // A bridge the firewall does not know by name is the control: same kind of network, same address, no wall.
    const control = `rovara-wall-control-${Date.now()}`;
    networks.push(control);
    expect((await docker("network", "create", "--internal", control)).code).toBe(0);
    const open = await runNodeIn(control, reachScript([["bridge", host.port]]));
    expect(open.stdout.trim(), `control: ${open.stderr}`).toBe('["open"]');
    // The production guard, pointed at this test's port: the app starts only if the connection times out.
    const guard = webApiAppStartGuardArgs().map((arg) => arg.replace("port:8080", `port:${host.port}`));
    expect(guard.join(" ")).toContain(`port:${host.port}`);
    const r = await runProbe("api-state-positive-v1", { defect: null, appArgs: guard });
    expect(r.run.unavailableReason, JSON.stringify(r.host.readDiagnostics(r.fixture.plan.runId))).toBeNull();
    expect(r.exitCode).toBe(0);
    // Direct proof from the run's own bridge name too: it is an rvi bridge, so the wall applies by name.
    expect(e2eRunNetworks(r.fixture.plan.runId).internalBridge).toMatch(/^rvi[0-9a-f]{8}$/);
  }, 300_000);

  it("an internal network's containers reach each other, and not the containers of another internal network", async () => {
    const ids = [`${Date.now()}a`, `${Date.now()}b`].map((value) => ({ value, ...e2eRunNetworks(`wall-${value}`) }));
    for (const net of ids) {
      networks.push(net.internal);
      const created = await docker("network", "create", "--internal", "-o", `com.docker.network.bridge.name=${net.internalBridge}`, net.internal);
      expect(created.code, created.stderr).toBe(0);
    }
    const [first, second] = ids as [typeof ids[number], typeof ids[number]];
    const serve = "require('net').createServer(s=>{s.on('error',()=>{});s.end('app\\n')}).listen(4317,'0.0.0.0')";
    const started = await docker("run", "-d", "--rm", "--pull=never", "--name", `rovara-wall-server-${first.value}`, "--network", first.internal, "--cap-drop=ALL", "--user", "1000:1000", APP_NODE_IMAGE, "node", "-e", serve);
    expect(started.code, started.stderr).toBe(0);
    try {
      const address = (await docker("inspect", "-f", `{{(index .NetworkSettings.Networks "${first.internal}").IPAddress}}`, `rovara-wall-server-${first.value}`)).stdout.trim();
      expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      const same = await runNodeIn(first.internal, reachScript([[address, 4317]]));
      expect(same.stdout.trim(), same.stderr).toBe('["open"]');
      const across = await runNodeIn(second.internal, reachScript([[address, 4317]]));
      // Internal bridges have no route to another bridge's subnet, so this fails at once (ENETUNREACH) or by DROP (timeout); either way it never connects.
      expect(across.stdout.trim()).not.toContain("open");
      expect(across.code).not.toBe(0);
    } finally { await docker("rm", "-f", `rovara-wall-server-${first.value}`); }
  }, 300_000);
});
