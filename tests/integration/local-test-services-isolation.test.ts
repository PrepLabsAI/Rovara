// Test services on the local Docker worker (a security release gate, like local-sandbox-isolation.test.ts): what a worker may do through the Docker socket guard once test services are on, proved against a real daemon
// with the worker's OWN functions (the run network, the check sandbox plan, the resolver guard, the DNS helper) and its real docker CLI. It runs only when ROVARA_LOCAL_DOCKER_IMAGE names a worker image that is already on
// this machine and Docker answers; the image must hold node, the docker CLI and iptables (environments/base does). The list of images the guard lets start is the one image `ROVARA_TEST_SERVICES_IMAGE` names (a small
// database image that is already on this machine, `postgres:16` by default); the test needs it only for the positive control and skips that part when it is not there. Everything it makes is removed at the end.
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDockerRunner } from "../../packages/broker/src/local/docker-runner.js";
import { DockerWorkerMachines } from "../../packages/broker/src/local/docker-worker-machines.js";
import { createEphemeralInvokeSigner } from "../../packages/broker/src/local/invoke-signer.js";
import { OWNER_LABEL, isolationNames, type IsolationNames } from "../../packages/broker/src/local/isolation/stack.js";
import { runCollected, type CollectedProcess } from "../../packages/worker/src/collected-process.js";
import { checkSandboxPlan, waitForSealedDnsHelper, withDetachedWorking, writeCheckSandboxFiles } from "../../packages/worker/src/check-sandbox.js";
import { startServicesNetwork, type ServicesNetwork } from "../../packages/worker/src/run-network.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import { taskSandboxRunArgs } from "../../packages/worker/src/task-sandbox.js";

const IMAGE = process.env.ROVARA_LOCAL_DOCKER_IMAGE;
const SERVICE_IMAGE = process.env.ROVARA_TEST_SERVICES_IMAGE ?? "postgres:16";
const run = promisify(execFile);
function present(image: string | undefined): boolean {
  try {
    execFileSync("docker", ["image", "inspect", image ?? ""], { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}
const enabled = IMAGE !== undefined && IMAGE !== "" && present(IMAGE);
const haveServiceImage = enabled && present(SERVICE_IMAGE);
const COMPANY = "org_bbbbbbbbbbbbbbbbbbbb";
vi.setConfig({ testTimeout: 240_000, hookTimeout: 300_000 });

interface Result { code: number; out: string }
async function docker(args: string[], timeout = 120_000): Promise<Result> {
  try {
    const { stdout, stderr } = await run("docker", args, { timeout, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === "number" ? failure.code : -1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}
const CONNECT = "const n=require('net');const s=n.connect({host:process.argv[1],port:+process.argv[2],timeout:3000});s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});s.on('error',e=>{console.log('REFUSED '+e.code);process.exit(1)});s.on('timeout',()=>{console.log('REFUSED TIMEOUT');process.exit(1)})";
const LOOKUP = "require('dns').lookup(process.argv[1],(e,a)=>{console.log(e?'NOANSWER '+e.code:'ANSWER '+a);process.exit(0)})";
const RESOLVER_DIRECT = "const r=new (require('dns').Resolver)({timeout:2000,tries:1});r.setServers(['127.0.0.11']);r.resolve4(process.argv[1],(e,a)=>{console.log(e?'NOANSWER '+e.code:'ANSWER '+a.join(','));process.exit(0)})";

describe.skipIf(!enabled)("test services on a local worker are walled off (real Docker)", () => {
  let stateDirectory = "";
  let machines: DockerWorkerMachines;
  let machine = "";
  let names: IsolationNames;
  let workspace = "";
  let runDirectory = "";
  let imageId = "";
  let workspaceKey = "";
  const sandbox = "agentx-task-svc-probe";
  let before = "";
  let net: ServicesNetwork | undefined;

  /** The worker's own docker CLI: the very `docker` in the worker's container, which talks to its guard. */
  const workerDocker: DockerCli = {
    run: (args, options) => runCollected("docker", ["exec", machine, "docker", ...args], { ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), ...(options?.signal === undefined ? {} : { signal: options.signal }) }),
  };
  const inWorker = (args: string[]): Promise<CollectedProcess> => workerDocker.run(args, { timeoutMs: 120_000 });
  const containerNames = async (): Promise<string> => (await docker(["ps", "--all", "--format", "{{.Names}}"])).out.split("\n").filter((line) => line !== "").sort().join(",");

  beforeAll(async () => {
    before = await containerNames();
    stateDirectory = await mkdtemp(join(homedir(), ".rovara-it-svc-"));
    machines = new DockerWorkerMachines({
      image: IMAGE!, stateDirectory, callback: () => ({ tcpPort: 9 }), signer: createEphemeralInvokeSigner(), docker: createDockerRunner(), startupGraceMs: 150_000,
      testServices: { registry: "registry.example", catalogEnv: "local", images: [SERVICE_IMAGE], maxMemoryMiB: 1024 },
    });
    const handle = await machines.start({ machineKey: "svc-a", companyId: COMPANY });
    machine = handle.machineId;
    const hash = machine.slice("rovara-worker-".length);
    names = isolationNames(hash);
    const deadline = Date.now() + 150_000;
    for (;;) {
      const health = await machines.health(machine);
      if (health.state === "ready") break;
      if (Date.now() > deadline) throw new Error(`the worker did not become ready: ${health.state} ${health.detail ?? ""}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    }
    workspace = join(stateDirectory, "workspaces", hash);
    runDirectory = join(stateDirectory, "test-services", hash);
    workspaceKey = createHash("sha256").update(resolve(workspace)).digest("hex").slice(0, 16);
    imageId = (await docker(["image", "inspect", "--format", "{{.Id}}", IMAGE!])).out.trim();
    // The working sandbox, started the way the worker starts it.
    const started = await inWorker(taskSandboxRunArgs({ name: sandbox, taskId: "svc-probe", image: IMAGE!, rootPath: workspace, maskedPaths: [], hostCpus: 2, hostMemoryBytes: 2 * 1024 ** 3, sharedNetwork: names.sandboxNet }));
    if (started.exitCode !== 0) throw new Error(`the sandbox did not start: ${started.stdout}${started.stderr}`);
  });

  afterAll(async () => {
    if (process.env.ROVARA_IT_KEEP === "1") return;
    await net?.stop().catch(() => undefined);
    if (machine !== "") await machines?.terminate(machine).catch(() => undefined);
    if (stateDirectory !== "") await rm(stateDirectory, { recursive: true, force: true });
  });

  it("is told its own image as a pinned id and where its run folder is, and the folder is not in any workspace", async () => {
    const environment = (await docker(["exec", machine, "env"])).out;
    expect(environment).toContain(`AGENTX_WORKER_IMAGE=${imageId}`);
    expect(environment).toContain(`AGENTX_TEST_SERVICES_RUN_DIR=${runDirectory}`);
    expect(runDirectory.startsWith(`${workspace}/`)).toBe(false);
    // The sandbox does not see the run folder.
    expect((await docker(["exec", machine, "docker", "exec", sandbox, "ls", runDirectory])).code).not.toBe(0);
  });

  it("makes a run network through the worker's own function: internal, on its slot, labelled and walled", async () => {
    net = await startServicesNetwork(workerDocker, { runId: "svc-run-1", workspace: workspaceKey, roundBudgetMs: 120_000 });
    const info = await docker(["network", "inspect", "--format", "{{.Internal}}|{{.Driver}}|{{.EnableIPv6}}|{{range .IPAM.Config}}{{.Subnet}} {{.Gateway}} {{.IPRange}}{{end}}|{{index .Labels \"rovara.local.owner\"}}|{{index .Options \"com.docker.network.bridge.name\"}}", net.name]);
    expect(info.out.trim()).toBe(`true|bridge|false|${net.subnet} ${net.gateway} ${net.ipRange}|${names.worker.slice("rovara-worker-".length)}|${net.bridge}`);
    // The guard (not the worker) took the bridge's own address away, so a container on the run network has no route to a service of the host or the VM.
    const inhibit = await docker(["network", "inspect", "--format", "{{index .Options \"com.docker.network.bridge.inhibit_ipv4\"}}", net.name]);
    expect(inhibit.out.trim()).toBe("true");
  });

  it("refuses the worker everything beyond that: another network, a network that is not internal, other images, privilege, the host network, a mount of the host, another container's network namespace", async () => {
    const owner = names.worker.slice("rovara-worker-".length);
    expect(owner).toMatch(/^[0-9a-f]{24}$/);
    const labels = net!.labelArgs();
    const refusals: Array<[string, string[]]> = [
      ["a plain network", ["network", "create", "evil"]],
      ["a run-named network that is not internal", ["network", "create", "--driver", "bridge", "--subnet", "172.30.250.0/24", ...labels, "rovara-svc-aaaaaaaaaaaa"]],
      ["a bridge with no labels", ["network", "create", "--driver", "bridge", "--internal", "rovara-svc-bbbbbbbbbbbb"]],
      ["an image that is not on the list", ["run", "--rm", "--pull=never", "--name", `${net!.name}-p0000000001`, ...labels, "--network", net!.name, "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--memory", "64m", "--memory-swap", "64m", "--cpus", "0.25", "--pids-limit", "32", "alpine:3.20", "true"]],
      ["the host network", ["run", "--rm", "--pull=never", "--name", `${net!.name}-p0000000002`, ...labels, "--network", "host", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--memory", "64m", "--memory-swap", "64m", "--cpus", "0.25", "--pids-limit", "32", "--entrypoint", "/usr/local/bin/node", IMAGE!, "/opt/agentx/packages/worker/dist/service-probe.js"]],
      ["privilege", ["run", "--rm", "--pull=never", "--privileged", "--name", `${net!.name}-p0000000003`, ...labels, "--network", net!.name, "--user", "1000:1000", "--read-only", "--memory", "64m", "--memory-swap", "64m", "--cpus", "0.25", "--pids-limit", "32", "--entrypoint", "/usr/local/bin/node", IMAGE!, "/opt/agentx/packages/worker/dist/service-probe.js"]],
      ["a mount of the host", ["run", "--rm", "--pull=never", "--name", `${net!.name}-p0000000004`, ...labels, "--network", net!.name, "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "-v", "/:/host:ro", "--read-only", "--memory", "64m", "--memory-swap", "64m", "--cpus", "0.25", "--pids-limit", "32", "--entrypoint", "/usr/local/bin/node", IMAGE!, "/opt/agentx/packages/worker/dist/service-probe.js"]],
      ["a shell as the worker's program", ["run", "--rm", "--pull=never", "--name", `${net!.name}-p0000000005`, ...labels, "--network", net!.name, "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "64m", "--memory-swap", "64m", "--cpus", "0.25", "--pids-limit", "32", "--read-only", "--entrypoint", "/bin/sh", IMAGE!, "-c", "id"]],
      ["root with NET_ADMIN in a sandbox's network namespace and a shell", ["run", "--rm", "--pull=never", "--name", `${net!.name}-check-guard`, ...labels, "--network", `container:${sandbox}`, "--user", "0:0", "--cap-drop", "ALL", "--cap-add", "NET_ADMIN", "--security-opt", "no-new-privileges", "--read-only", "--entrypoint", "/bin/sh", imageId, "-c", "ip link"]],
      ["connecting the sandbox to the default bridge", ["network", "connect", "bridge", sandbox]],
      ["connecting the sandbox to the worker's own network", ["network", "connect", names.workerNet, sandbox]],
      ["connecting the sandbox to the run network at the gateway's address", ["network", "connect", "--ip", net!.gateway, net!.name, sandbox]],
      ["removing the worker's own network", ["network", "rm", names.workerNet]],
    ];
    // Each is refused for the rule that is meant to refuse it (the guard's own sentence), not for some other reason.
    const reasons = [
      "a run network is named rovara-svc-", "a run network is internal", "a run network has one address range", "only the catalog images", "joins its own run network", "privileged mode is not allowed", "comes from the run's own folder",
      "started by the worker's own node", "the resolver guard's program is fixed", "no such run network of this worker", "no such run network of this worker", "reserved ones, .2 to .47", "no such run network of this worker",
    ];
    expect(reasons).toHaveLength(refusals.length);
    for (const [index, [what, args]] of refusals.entries()) {
      const result = await inWorker(args);
      expect(result.exitCode, `${what}: ${result.stdout}${result.stderr}`).not.toBe(0);
      expect(result.stderr + result.stdout, what).toContain(reasons[index]!);
    }
    expect((await docker(["ps", "--all", "--quiet", "--filter", `name=${net!.name}-p000000`])).out.trim()).toBe("");
    expect((await docker(["network", "ls", "--quiet", "--filter", "name=rovara-svc-aaaaaaaaaaaa", "--filter", "name=rovara-svc-bbbbbbbbbbbb"])).out.trim()).toBe("");
  });

  it.skipIf(!haveServiceImage)("starts a helper from the listed image on the run network at its address, and the helper runs as its own non-root user with no capability", async () => {
    const helper = `${net!.name}-h0123456789`;
    const started = await inWorker(["run", "--detach", "--name", helper, "--pull=never", "--init", ...net!.labelArgs(), "--network", net!.name, "--ip", net!.helperIp(0), "--network-alias", "postgres", "--user", "999:999", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--memory", "512m", "--memory-swap", "512m", "--cpus", "1", "--pids-limit", "256", "--log-driver", "local", "--log-opt", "max-size=1m", "--log-opt", "max-file=1", "--log-opt", "compress=false", "--env", "POSTGRES_PASSWORD=itpassword1", SERVICE_IMAGE]);
    expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
    const info = await docker(["inspect", "--format", "{{.Config.User}}|{{.HostConfig.CapDrop}}|{{.HostConfig.Privileged}}|{{.HostConfig.NetworkMode}}|{{index .NetworkSettings.Networks \"" + net!.name + "\"}}|{{index .Config.Labels \"rovara.local.sandbox\"}}|{{index .Config.Labels \"rovara.local.profile\"}}", helper]);
    expect(info.out).toContain(`999:999|[ALL]|false|${net!.name}|`);
    expect(info.out.trim().endsWith("|service|helper")).toBe(true);
    expect((await docker(["inspect", "--format", `{{(index .NetworkSettings.Networks "${net!.name}").IPAddress}}`, helper])).out.trim()).toBe(net!.helperIp(0));
    // It is ready when the database answers, asked as the helper's own user through the guard.
    const deadline = Date.now() + 90_000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      ready = (await inWorker(["exec", helper, "pg_isready", "-h", "127.0.0.1"])).exitCode === 0;
      if (!ready) await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    }
    expect(ready).toBe(true);
    expect((await docker(["exec", helper, "id", "-u"])).out.trim()).toBe("999");
    // The worker cannot run a command in it as another user.
    const asRoot = await inWorker(["exec", "--user", "0", helper, "id"]);
    expect(asRoot.exitCode).not.toBe(0);
    // And it lists, as the sweep does, only this run's service containers.
    const listed = await inWorker(["ps", "--all", "--filter", "label=rovara.run-network", "--filter", `label=rovara.run-network.workspace=${workspaceKey}`, "--format", "{{.Names}}"]);
    expect(listed.stdout.trim().split("\n")).toContain(helper);
    expect(listed.stdout).not.toContain(sandbox);
  });

  it("runs the sealed round the worker's own way: the check sandbox is on the run network alone, the resolver guard closes 127.0.0.11, and nothing reaches the outside", async () => {
    const filesDir = join(runDirectory, "round1");
    await mkdir(filesDir, { recursive: true, mode: 0o755 });
    const helperIp = net!.helperIp(0);
    const plan = checkSandboxPlan({
      net: net!, taskId: "svc-probe", image: IMAGE!, guardImage: imageId, rootPath: workspace, maskedPaths: [], hostCpus: 2, hostMemoryBytes: 2 * 1024 ** 3, filesDir,
      helpers: haveServiceImage ? [{ alias: "postgres", address: helperIp }] : [], sinkholeIp: net!.helperIp(31), workingSandboxName: sandbox,
    });
    await writeCheckSandboxFiles(plan);
    const dns = await inWorker(plan.dnsHelperRunArgs);
    expect(dns.exitCode, `${dns.stdout}${dns.stderr}`).toBe(0);
    await waitForSealedDnsHelper(workerDocker, plan.dnsHelperName);
    const probes = await withDetachedWorking(workerDocker, plan, async (start) => {
      // On a failure the guard's own log says which rule refused what (a line per refusal, never a body).
      const checkSandbox = await start().catch(async (error: unknown) => { throw new Error(`${error instanceof Error ? error.message : String(error)}\n${(await docker(["logs", "--tail", "20", names.guard])).out}`); });
      expect(checkSandbox).not.toBe("");
      const exec = (command: string[]): Promise<Result> => docker(["exec", machine, "docker", "exec", plan.sandboxName, ...command]);
      // The sandbox is on the run network alone.
      const networks = (await docker(["inspect", "--format", "{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}", plan.sandboxName])).out.trim();
      const sandboxInfo = await docker(["inspect", "--format", "{{.Config.User}}|{{.HostConfig.CapDrop}}|{{.HostConfig.Privileged}}|{{.Config.Hostname}}|{{index .Config.Labels \"rovara.local.profile\"}}", plan.sandboxName]);
      const refused = await Promise.all([
        ["1.1.1.1", 443], ["8.8.8.8", 53], ["169.254.169.254", 80], [net!.gateway, 80], [net!.gateway, 443], ["172.17.0.1", 80], ["host.docker.internal", 80],
      ].map(async ([host, port]) => ({ label: `${String(host)}:${String(port)}`, result: await exec(["node", "-e", CONNECT, String(host), String(port)]) })));
      const lookup = await exec(["node", "-e", LOOKUP, "example.com"]);
      const direct = await exec(["node", "-e", RESOLVER_DIRECT, "example.com"]);
      const directOwn = haveServiceImage ? await exec(["node", "-e", RESOLVER_DIRECT, "postgres"]) : { code: 0, out: "NOANSWER skipped" };
      const toHelper = haveServiceImage ? await exec(["node", "-e", CONNECT, helperIp, "5432"]) : { code: 0, out: "CONNECTED skipped" };
      return { networks, sandboxInfo, refused, lookup, direct, directOwn, toHelper };
    }, { returnTo: "none", pauseWorking: true });
    expect(probes.networks).toBe(plan.network.name);
    expect(probes.sandboxInfo.out.trim()).toBe("1000:1000|[ALL]|false|check|check");
    for (const { label, result } of probes.refused) expect(result.out, label).toContain("REFUSED");
    // An unknown name goes to the sealed name server (the sinkhole's address) or to nothing; never to a public address.
    expect(probes.lookup.out).not.toMatch(/ANSWER (?!172\.30\.)/u);
    // Docker's own resolver is closed by the resolver guard: even the run's own names are not answered through it.
    expect(probes.direct.out).toContain("NOANSWER");
    expect(probes.directOwn.out).toContain("NOANSWER");
    // The positive control: the network works inside itself.
    expect(probes.toHelper.out).toContain("CONNECTED");
    // The round is over: the check sandbox and the resolver guards are gone.
    expect((await docker(["ps", "--all", "--quiet", "--filter", `name=${plan.sandboxName}`])).out.trim()).toBe("");
    expect(await inWorker(["rm", "--force", plan.dnsHelperName]).then((result) => result.exitCode)).toBe(0);
  });

  it("removes everything of the run when the network stops, and everything of the worker when the machine is terminated", async () => {
    await net!.stop();
    net = undefined;
    const owner = names.worker.slice("rovara-worker-".length);
    expect((await docker(["ps", "--all", "--quiet", "--filter", `label=${OWNER_LABEL}=${owner}`, "--filter", "label=rovara.local.sandbox=service"])).out.trim()).toBe("");
    expect((await docker(["network", "ls", "--quiet", "--filter", `label=${OWNER_LABEL}=${owner}`, "--filter", "name=rovara-svc-"])).out.trim()).toBe("");
    // A second network that is left standing is removed by the terminate (and its containers with it).
    const again = await startServicesNetwork(workerDocker, { runId: "svc-run-2", workspace: workspaceKey, roundBudgetMs: 120_000 });
    expect((await docker(["network", "ls", "--quiet", "--filter", `name=${again.name}`])).out.trim()).not.toBe("");
    await machines.terminate(machine);
    machine = "";
    expect((await docker(["network", "ls", "--quiet", "--filter", `name=${again.name}`])).out.trim()).toBe("");
    expect(await containerNames()).toBe(before);
  });
});
