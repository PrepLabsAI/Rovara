// Port lane L4b (a security release gate): what a local worker and its task sandboxes can and cannot reach, proved from INSIDE them
// against a real Docker daemon. It runs only when ROVARA_LOCAL_DOCKER_IMAGE names a worker image that is already on this machine and
// Docker answers (the image must hold node, curl and the docker CLI, as environments/base does). Colima and Docker Desktop share the home
// folder with the VM only, so the state folder is made under the home folder.
//
// The test plays a malicious repository: it runs its commands in a sandbox that the worker started through the socket guard, and tries
// to reach the owner's loopback services, the broker, another worker, the local network, the cloud metadata address and the Docker
// socket. Every container, network and folder it makes is removed at the end.
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDockerRunner } from "../../packages/broker/src/local/docker-runner.js";
import { DockerWorkerMachines, workspaceIdFor } from "../../packages/broker/src/local/docker-worker-machines.js";
import { startCallbackServer, type CallbackServer } from "../../packages/broker/src/local/callback-server.js";
import { createLocalPagesServer, type LocalPagesServer } from "../../packages/broker/src/core/local-pages/index.js";
import { startLocalHttpServer, type LocalHttpServer } from "../../packages/broker/src/local/http-server.js";
import { createEphemeralInvokeSigner } from "../../packages/broker/src/local/invoke-signer.js";
import { OWNER_LABEL, isolationNames, type IsolationNames } from "../../packages/broker/src/local/isolation/stack.js";
import { fakeWorld } from "../support/local-pages-fakes.js";
import { taskSandboxRunArgs } from "../../packages/worker/src/task-sandbox.js";

const IMAGE = process.env.ROVARA_LOCAL_DOCKER_IMAGE;
const run = promisify(execFile);
function dockerAnswers(): boolean {
  try {
    execFileSync("docker", ["image", "inspect", IMAGE ?? ""], { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}
const enabled = IMAGE !== undefined && IMAGE !== "" && dockerAnswers();
const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";
vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

interface Result {
  code: number;
  out: string;
}
async function docker(args: string[], timeout = 120_000): Promise<Result> {
  try {
    const { stdout, stderr } = await run("docker", args, { timeout, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === "number" ? failure.code : -1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

/** A TCP connect that reports in one word, run by `node -e` inside a container. */
const CONNECT = "const n=require('net');const s=n.connect({host:process.argv[1],port:+process.argv[2],timeout:3000});s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});s.on('error',e=>{console.log('REFUSED '+e.code);process.exit(1)});s.on('timeout',()=>{console.log('REFUSED TIMEOUT');process.exit(1)})";

/** Runs the probes side by side (each is a `docker exec` through a worker) and fails naming the first target that was not refused. */
async function allRefused(probes: Array<{ label: string; run: Promise<Result> }>): Promise<void> {
  const results = await Promise.all(probes.map(async (probe) => ({ label: probe.label, result: await probe.run })));
  for (const { label, result } of results) expect(result.out, label).toContain("REFUSED");
}

interface Machine {
  name: string;
  names: IsolationNames;
  workspace: string;
  workspaceId: string;
  sandbox: string;
}

describe.skipIf(!enabled)("a local worker and its sandboxes are walled off (real Docker)", () => {
  let stateDirectory = "";
  let machines: DockerWorkerMachines;
  let callback: CallbackServer;
  let mainServer: LocalHttpServer;
  // L8's review pages: a server of their own on 127.0.0.1 whose address carries the owner's session token, and which can approve a plan.
  let pages: LocalPagesServer;
  let pageLink = "";
  let loopbackService: Server;
  let wildcardService: Server;
  let a: Machine;
  let b: Machine;
  const callbacks: Array<{ path: string; host: string | undefined }> = [];
  let loopbackPort = 0;
  let wildcardPort = 0;
  const started = new Set<string>();

  const inWorker = (machine: Machine, command: string[]): Promise<Result> => docker(["exec", machine.name, ...command]);
  const inSandbox = (machine: Machine, command: string[]): Promise<Result> => docker(["exec", machine.name, "docker", "exec", machine.sandbox, ...command]);
  const connect = (where: "worker" | "sandbox", machine: Machine, host: string, port: number): Promise<Result> =>
    (where === "worker" ? inWorker : inSandbox)(machine, ["node", "-e", CONNECT, host, String(port)]);

  async function bring(key: string): Promise<Machine> {
    const handle = await machines.start({ machineKey: key, companyId: COMPANY });
    started.add(handle.machineId);
    const hash = handle.machineId.slice("rovara-worker-".length);
    const names = isolationNames(hash);
    const deadline = Date.now() + 150_000;
    for (;;) {
      const health = await machines.health(handle.machineId);
      if (health.state === "ready") break;
      if (Date.now() > deadline) throw new Error(`the worker ${key} did not become ready: ${health.state} ${health.detail ?? ""}`);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    const workspace = join(stateDirectory, "workspaces", hash);
    // The sandbox is started the way the worker starts it: its own docker CLI, through the guard, with the worker's own arguments.
    const sandbox = `agentx-task-probe-${key}`;
    const args = taskSandboxRunArgs({ name: sandbox, taskId: `probe-${key}`, image: IMAGE!, rootPath: workspace, maskedPaths: [], hostCpus: 2, hostMemoryBytes: 2 * 1024 ** 3, sharedNetwork: names.sandboxNet });
    const result = await docker(["exec", handle.machineId, "docker", ...args]);
    if (result.code !== 0) throw new Error(`the sandbox did not start: ${result.out}`);
    return { name: handle.machineId, names, workspace, workspaceId: workspaceIdFor(COMPANY, key), sandbox };
  }

  beforeAll(async () => {
    stateDirectory = await mkdtemp(join(homedir(), ".rovara-it-iso-"));
    // The owner's things on this computer: a service on loopback, a service on every interface, the broker's main server and the callback listener.
    loopbackService = createServer((_request, response) => response.end("OWNER-LOOPBACK-SECRET")).listen(0, "127.0.0.1");
    wildcardService = createServer((_request, response) => response.end("OWNER-LAN-SECRET")).listen(0, "0.0.0.0");
    await Promise.all([new Promise((resolve) => loopbackService.once("listening", resolve)), new Promise((resolve) => wildcardService.once("listening", resolve))]);
    loopbackPort = (loopbackService.address() as { port: number }).port;
    wildcardPort = (wildcardService.address() as { port: number }).port;
    mainServer = await startLocalHttpServer({ handler: async () => ({ statusCode: 200, headers: {}, body: '{"main":true}' }) });
    const world = fakeWorld();
    pages = await createLocalPagesServer({ data: world.data, actions: world.actions });
    pageLink = pages.link();
    callback = await startCallbackServer({
      stateDirectory,
      unixSocket: false,
      handler: async (request) => {
        callbacks.push({ path: request.path, host: request.headers.host });
        return { statusCode: 200, headers: { "content-type": "application/json" }, body: '{"ok":true}' };
      },
    });
    machines = new DockerWorkerMachines({
      image: IMAGE!,
      stateDirectory,
      callback: () => ({ tcpPort: callback.tcpPort }),
      signer: createEphemeralInvokeSigner(),
      docker: createDockerRunner(),
      startupGraceMs: 150_000,
    });
    a = await bring("iso-a");
    b = await bring("iso-b");
  });

  afterAll(async () => {
    for (const id of started) await machines?.terminate(id).catch(() => undefined);
    await Promise.all([callback?.close(), mainServer?.close(), pages?.close(), new Promise((resolve) => loopbackService?.close(resolve)), new Promise((resolve) => wildcardService?.close(resolve))]);
    if (stateDirectory !== "") await rm(stateDirectory, { recursive: true, force: true });
  });

  // ---- the owner's computer

  const hostAddresses = (): string[] => {
    const found = ["192.168.5.2", "192.168.65.254", "172.17.0.1", "10.0.0.1", "192.168.1.1", "100.64.0.1"];
    for (const entries of Object.values(networkInterfaces())) for (const entry of entries ?? []) if (entry.family === "IPv4" && !entry.internal) found.push(entry.address);
    return found;
  };

  for (const where of ["worker", "sandbox"] as const) {
    describe(`from inside the ${where}`, () => {
      it("cannot reach a service on the owner's loopback, through any name the VM gives the computer", async () => {
        await allRefused(["host.docker.internal", "host.lima.internal", "gateway.docker.internal", "127.0.0.1", ...hostAddresses()].map((host) => ({ label: `${host}:${loopbackPort}`, run: connect(where, a, host, loopbackPort) })));
      });

      it("cannot reach a service the owner bound to every interface, by the computer's LAN address or the VM's gateway", async () => {
        await allRefused(hostAddresses().map((host) => ({ label: `${host}:${wildcardPort}`, run: connect(where, a, host, wildcardPort) })));
      });

      it("cannot reach the broker's main server, the review pages or the callback listener directly", async () => {
        await allRefused([mainServer.port, pages.port, callback.tcpPort].flatMap((port) => ["host.docker.internal", "127.0.0.1", ...hostAddresses()].map((host) => ({ label: `${host}:${port}`, run: connect(where, a, host, port) }))));
      });

      it("cannot open a review page, even holding the owner's session token from its address", async () => {
        const path = new URL(pageLink).pathname;
        expect(path).toMatch(/\/[A-Za-z0-9_-]{16,}/); // the token is in the path: whoever can fetch it can approve
        const hosts = ["127.0.0.1", "localhost", "host.docker.internal", "host.lima.internal", ...hostAddresses()];
        const fetched = await Promise.all(hosts.map(async (host) => ({
          host,
          result: await (where === "worker" ? inWorker : inSandbox)(a, ["curl", "-sS", "--max-time", "5", "-i", `http://${host}:${pages.port}${path}`]),
        })));
        for (const { host, result } of fetched) {
          expect(result.code, host).not.toBe(0);
          expect(result.out, host).not.toContain("Retry failed payments");
          expect(result.out, host).not.toMatch(/HTTP\/1\.1 2\d\d/);
        }
      });

      it("cannot reach the cloud metadata address, a private range or the Docker bridge addresses", async () => {
        await allRefused(["169.254.169.254", "172.17.0.1", "172.17.0.2", "10.1.2.3", "192.168.0.1", "100.100.100.200"].flatMap((host) => [80, 443, 22].map((port) => ({ label: `${host}:${port}`, run: connect(where, a, host, port) }))));
      });

      it("cannot reach the internet by address, only by an allowed name", async () => {
        await allRefused(["1.1.1.1", "8.8.8.8"].map((host) => ({ label: host, run: connect(where, a, host, 443) })));
        const byName = (url: string): Promise<Result> => (where === "worker" ? inWorker : inSandbox)(a, ["curl", "-sS", "--max-time", "20", "-o", "/dev/null", "-w", "%{http_code}", url]);
        expect((await byName("https://example.com/")).code).not.toBe(0); // not on the list: the name does not exist
        expect((await byName("http://example.com/")).code).not.toBe(0);
        expect((await byName("https://example.com:8443/")).code).not.toBe(0);
        expect((await byName("https://evil.github.com.example.com/")).code).not.toBe(0);
      });

      it("reaches an allowed site through the gateway, with the real certificate checked", async () => {
        const fetched = await (where === "worker" ? inWorker : inSandbox)(a, ["curl", "-sS", "--max-time", "30", "-o", "/dev/null", "-w", "%{http_code} %{ssl_verify_result}", "https://registry.npmjs.org/left-pad"]);
        expect(fetched.out).toMatch(/^200 0$/);
        const plain = await (where === "worker" ? inWorker : inSandbox)(a, ["curl", "-sS", "--max-time", "30", "-o", "/dev/null", "-w", "%{http_code}", "http://deb.debian.org/debian/dists/bookworm/InRelease"]);
        expect(plain.out).toMatch(/^(200|301|302)$/);
      });

      it("cannot use an allowed name to reach another site: the server name in the hello is checked", async () => {
        // Resolve an allowed name, then ask that address for a name that is not allowed.
        const gateway = await docker(["exec", a.name, "getent", "hosts", "registry.npmjs.org"]);
        const address = gateway.out.trim().split(/\s+/)[0] ?? "";
        expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
        const forged = await (where === "worker" ? inWorker : inSandbox)(a, ["curl", "-sS", "--max-time", "15", "-o", "/dev/null", "--resolve", `example.com:443:${address}`, "https://example.com/"]);
        expect(forged.code).not.toBe(0);
        const hostHeader = await (where === "worker" ? inWorker : inSandbox)(a, ["curl", "-sS", "--max-time", "15", "-o", "/dev/null", "-w", "%{http_code}", "-H", "Host: example.com", "http://registry.npmjs.org/"]);
        expect(hostHeader.out).not.toMatch(/^(200|301|302)$/);
      });
    });
  }

  it("keeps IP forwarding off in the gateway and answers only the network each of its services was opened for", async () => {
    expect((await docker(["exec", a.names.gateway, "cat", "/proc/sys/net/ipv4/ip_forward"])).out.trim()).toBe("0");
    const inspect = await docker(["inspect", "--format", "{{.HostConfig.CapDrop}} {{.HostConfig.ReadonlyRootfs}} {{.Config.User}} {{.HostConfig.Memory}}", a.names.gateway]);
    expect(inspect.out.trim()).toBe("[ALL] true 1000:1000 536870912");
  });

  // ---- other workers

  it("keeps one worker's sandbox away from another worker, its gateway and its sandbox", async () => {
    const targets: string[] = [];
    for (const container of [b.name, b.names.gateway, b.names.guard, b.sandbox]) {
      const addresses = await docker(["inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", container]);
      targets.push(...addresses.out.trim().split(/\s+/).filter((entry) => /^\d+\.\d+\.\d+\.\d+$/.test(entry)));
    }
    expect(targets.length).toBeGreaterThan(3);
    for (const where of ["worker", "sandbox"] as const) {
      await allRefused(targets.flatMap((host) => [8080, 8081, 2375, 53, 443].map((port) => ({ label: `${where} -> ${host}:${port}`, run: connect(where, a, host, port) }))));
    }
    // And the names of another worker's containers do not resolve.
    for (const where of ["worker", "sandbox"] as const) {
      const lookup = await (where === "worker" ? inWorker : inSandbox)(a, ["getent", "hosts", b.names.gateway]);
      expect(lookup.out.trim()).toBe("");
    }
  });

  it("keeps a sandbox away from its own worker, the socket guard and the callback relay", async () => {
    const own = [a.names.gateway, a.names.guard, a.name];
    for (const container of own) {
      const addresses = await docker(["inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", container]);
      // The gateway's address on the sandbox network answers name and web queries only, never these ports.
      await allRefused(addresses.out.trim().split(/\s+/).flatMap((host) => [2375, 8080, 8081].map((port) => ({ label: `${host}:${port}`, run: connect("sandbox", a, host, port) }))));
    }
    for (const name of ["rovara-sock", "rovara-worker", "rovara-broker"]) expect((await inSandbox(a, ["getent", "hosts", name])).out.trim(), name).toBe("");
  });

  // ---- the broker's callback, the one thing a worker may call

  it("lets the worker call its own workspace's callback routes, and nothing else on the broker", async () => {
    const before = callbacks.length;
    const post = (path: string, method = "POST") => inWorker(a, ["curl", "-sS", "--max-time", "20", "-X", method, "-o", "/dev/null", "-w", "%{http_code}", "-H", "content-type: application/json", "-d", "{}", `http://rovara-broker:8081${path}`]);
    const own = `/v1/internal/workspaces/${a.workspaceId}/operations/op-1/events`;
    expect((await post(own)).out).toBe("200");
    expect(callbacks.length).toBe(before + 1);
    expect(callbacks.at(-1)?.path).toBe(own);
    // The broker saw the name it expects, not the worker's.
    expect(callbacks.at(-1)?.host).toBe(`host.docker.internal:${callback.tcpPort}`);
    const refusals: Array<[string, string, string]> = [
      [`/v1/internal/workspaces/${b.workspaceId}/operations/op-1/events`, "POST", "403"], // another workspace
      ["/v1/local/status", "POST", "404"],
      ["/v1/admin/projects", "POST", "404"],
      ["/healthz", "POST", "404"],
      ["/v1/internal/../local/status", "POST", "404"],
      [own, "GET", "405"],
      [own, "DELETE", "405"],
    ];
    for (const [path, method, status] of refusals) expect((await post(path, method)).out, `${method} ${path}`).toBe(status);
    expect(callbacks.length).toBe(before + 1);
  });

  it("does not let the sandbox call the broker at all", async () => {
    const before = callbacks.length;
    const own = `/v1/internal/workspaces/${a.workspaceId}/operations/op-1/events`;
    const gatewayOnSandboxNet = await docker(["inspect", "--format", `{{(index .NetworkSettings.Networks "${a.names.sandboxNet}").IPAddress}}`, a.names.gateway]);
    const address = gatewayOnSandboxNet.out.trim();
    expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    const attempt = await inSandbox(a, ["curl", "-sS", "--max-time", "8", "-X", "POST", "-d", "{}", `http://${address}:8081${own}`]);
    expect(attempt.code).not.toBe(0);
    expect(callbacks.length).toBe(before);
  });

  // ---- the Docker socket

  describe("the Docker socket guard (what the worker may ask of Docker)", () => {
    const asWorker = (...args: string[]): Promise<Result> => inWorker(a, ["docker", ...args]);
    let decoy = "";

    beforeAll(async () => {
      // A container of the owner's, which the worker must neither see nor touch.
      const made = await docker(["run", "--detach", "--rm", "--label", "owner.decoy=1", "--entrypoint", "sleep", IMAGE!, "300"]);
      decoy = made.out.trim().split("\n").pop() ?? "";
    });
    afterAll(async () => {
      if (decoy !== "") await docker(["rm", "--force", decoy]);
    });

    it("does not hold the raw socket: it is not mounted and the guard's address is the only one", async () => {
      expect((await inWorker(a, ["ls", "/var/run/docker.sock"])).code).not.toBe(0);
      const environment = await inWorker(a, ["printenv", "DOCKER_HOST"]);
      expect(environment.out.trim()).toBe("tcp://rovara-sock:2375");
      const mounts = await docker(["inspect", "--format", "{{range .Mounts}}{{.Source}} {{end}}", a.name]);
      expect(mounts.out.trim()).toBe(a.workspace);
    });

    it("shows the worker only its own sandboxes, and cannot see or touch anything else", async () => {
      const listed = await asWorker("ps", "--all", "--format", "{{.Names}}");
      expect(listed.code).toBe(0);
      expect(listed.out.trim().split("\n").filter(Boolean)).toEqual([a.sandbox]);
      for (const victim of [decoy, b.name, b.sandbox, a.names.gateway, a.names.guard, a.name]) {
        for (const verb of [["rm", "--force"], ["stop"], ["kill"], ["inspect"], ["logs"], ["restart"]]) {
          const attempt = await asWorker(...verb, victim);
          // `docker rm --force` of a container it is told does not exist is a success to the CLI; the state check below is what counts.
          if (verb[0] !== "rm") expect(attempt.code, `${verb.join(" ")} ${victim}`).not.toBe(0);
        }
        expect((await asWorker("exec", victim, "id")).code, `exec ${victim}`).not.toBe(0);
      }
      for (const survivor of [decoy, b.name, b.sandbox, a.names.gateway, a.names.guard, a.name]) {
        expect((await docker(["inspect", "--format", "{{.State.Status}}", survivor])).out.trim(), survivor).toBe("running");
      }
    });

    const base = (): string[] => taskSandboxRunArgs({ name: "agentx-task-attack", taskId: "attack", image: IMAGE!, rootPath: a.workspace, maskedPaths: [], hostCpus: 2, hostMemoryBytes: 2 * 1024 ** 3, sharedNetwork: a.names.sandboxNet }).slice(1);
    const attacks: Array<[string, (args: string[]) => string[]]> = [
      ["a privileged container", (args) => ["--privileged", ...args]],
      ["the host network", (args) => args.flatMap((entry, index) => (args[index - 1] === "--network" ? ["host"] : [entry]))],
      ["the default bridge", (args) => args.flatMap((entry, index) => (args[index - 1] === "--network" ? ["bridge"] : [entry]))],
      ["another worker's network", (args) => args.flatMap((entry, index) => (args[index - 1] === "--network" ? [b.names.sandboxNet] : [entry]))],
      ["the worker's own network", (args) => args.flatMap((entry, index) => (args[index - 1] === "--network" ? [a.names.workerNet] : [entry]))],
      ["the host's root folder", (args) => ["--volume", "/:/host", ...args]],
      ["the state folder", (args) => ["--volume", `${stateDirectory}:/state`, ...args]],
      ["the home folder", (args) => ["--volume", `${homedir()}:/home-folder`, ...args]],
      ["the Docker socket", (args) => ["--volume", "/var/run/docker.sock:/var/run/docker.sock", ...args]],
      ["another worker's workspace", (args) => ["--volume", `${b.workspace}:${b.workspace}`, ...args]],
      ["the workspace's parent folder", (args) => args.map((entry) => (entry === `${a.workspace}:${a.workspace}` ? `${stateDirectory}/workspaces:${stateDirectory}/workspaces` : entry))],
      ["the workspace read from a symlinked name", (args) => args.map((entry) => (entry === `${a.workspace}:${a.workspace}` ? `${a.workspace}/..:${a.workspace}` : entry))],
      ["an added capability", (args) => ["--cap-add", "NET_ADMIN", ...args]],
      ["no capability drop", (args) => args.filter((entry, index) => entry !== "--cap-drop" && args[index - 1] !== "--cap-drop")],
      ["unconfined seccomp", (args) => ["--security-opt", "seccomp=unconfined", ...args]],
      ["unconfined system paths", (args) => ["--security-opt", "systempaths=unconfined", ...args]],
      ["no no-new-privileges", (args) => args.filter((entry, index) => entry !== "--security-opt" && args[index - 1] !== "--security-opt")],
      ["the host pid namespace", (args) => ["--pid", "host", ...args]],
      ["the host ipc namespace", (args) => ["--ipc", "host", ...args]],
      ["the host uts namespace", (args) => ["--uts", "host", ...args]],
      ["a device", (args) => ["--device", "/dev/kmsg", ...args]],
      ["root", (args) => args.flatMap((entry, index) => (args[index - 1] === "--user" ? ["0:0"] : [entry]))],
      ["another image", (args) => args.map((entry) => (entry === IMAGE ? "alpine:3.20" : entry))],
      ["a published port", (args) => ["--publish", "0.0.0.0:9999:9999", ...args]],
      ["extra hosts", (args) => ["--add-host", "evil:10.0.0.1", ...args]],
      ["a sysctl", (args) => ["--sysctl", "net.ipv4.ip_forward=1", ...args]],
      ["a name outside agentx-task-", (args) => args.map((entry) => (entry === "agentx-task-attack" ? "evil" : entry))],
      ["another workspace's label", (args) => args.map((entry) => (entry.startsWith("agentx.workspace=") ? "agentx.workspace=0000000000000000" : entry))],
      ["an overlay mount", (args) => ["--mount", `type=bind,source=${homedir()},target=/h`, ...args]],
      ["volumes from another container", (args) => ["--volumes-from", b.sandbox, ...args]],
      ["a link", (args) => ["--link", `${b.sandbox}:x`, ...args]],
      ["a cgroup parent", (args) => ["--cgroup-parent", "/", ...args]],
      ["host userns", (args) => ["--userns", "host", ...args]],
    ];
    for (const [what, change] of attacks) {
      it(`refuses to start ${what}`, async () => {
        const attempt = await asWorker("run", "--detach", ...change(base()));
        expect(attempt.code, attempt.out).not.toBe(0);
        const listed = await docker(["ps", "--all", "--quiet", "--filter", "name=agentx-task-attack", "--filter", "name=evil"]);
        expect(listed.out.trim(), "nothing was created").toBe("");
      });
    }

    it("replaces the name server and the network settings a worker asks for with the gateway's", async () => {
      const gateway = await docker(["inspect", "--format", `{{(index .NetworkSettings.Networks "${a.names.sandboxNet}").IPAddress}}`, a.names.gateway]);
      const made = await asWorker("run", "--detach", ...[...base().slice(0, base().indexOf("--network")), "--dns", "1.1.1.1", "--dns-search", "evil.dev", ...base().slice(base().indexOf("--network"))].map((entry) => (entry === "agentx-task-attack" ? "agentx-task-dns" : entry)));
      if (made.code === 0) {
        const info = await docker(["inspect", "--format", "{{.HostConfig.Dns}} {{.HostConfig.DnsSearch}}", "agentx-task-dns"]);
        expect(info.out.trim()).toBe(`[${gateway.out.trim()}] []`);
        await asWorker("rm", "--force", "agentx-task-dns");
      }
    });

    it("refuses images, pulls, builds, volumes, networks, events, info and prune", async () => {
      for (const args of [
        ["run", "--rm", "alpine:3.20", "true"], ["pull", "alpine:3.20"], ["images"], ["build", "-t", "x", "."], ["info"], ["events", "--since", "1s", "--until", "2s"],
        ["volume", "ls"], ["volume", "create", "x"], ["network", "ls"], ["network", "create", "x"], ["network", "rm", a.names.workerNet], ["network", "connect", a.names.externalNet, a.sandbox],
        ["network", "disconnect", a.names.sandboxNet, a.sandbox], ["container", "prune", "--force"], ["system", "prune", "--force"], ["commit", a.sandbox, "x"], ["cp", `${a.sandbox}:/etc/passwd`, "/tmp/x"],
        ["inspect", "--type", "network", a.names.workerNet], ["update", "--memory", "9g", a.sandbox], ["attach", a.sandbox], ["top", a.sandbox], ["export", a.sandbox], ["rename", a.sandbox, "x"],
      ]) {
        const attempt = await asWorker(...args);
        expect(attempt.code, args.join(" ")).not.toBe(0);
      }
    });

    it("refuses a command as root or a privileged command in its own sandbox, and lets the sandbox's user run", async () => {
      expect((await asWorker("exec", "--user", "0", a.sandbox, "id")).code).not.toBe(0);
      expect((await asWorker("exec", "--privileged", a.sandbox, "id")).code).not.toBe(0);
      expect((await asWorker("exec", "--user", "root", a.sandbox, "id")).code).not.toBe(0);
      const allowed = await asWorker("exec", "--user", "1000:1000", a.sandbox, "id", "-u");
      expect(allowed.out.trim()).toBe("1000");
    });

    it("lets the worker use its own sandbox: run commands, read the workspace, and remove it", async () => {
      const made = await asWorker("run", "--detach", ...taskSandboxRunArgs({ name: "agentx-task-second", taskId: "second", image: IMAGE!, rootPath: a.workspace, maskedPaths: [`${a.workspace}/.masked`], hostCpus: 2, hostMemoryBytes: 2 * 1024 ** 3, sharedNetwork: a.names.sandboxNet }).slice(1));
      expect(made.code, made.out).toBe(0);
      const shell = await asWorker("exec", "-i", "agentx-task-second", "sh", "-c", "echo hello && cd /tmp && pwd");
      expect(shell.out).toContain("hello");
      const info = await asWorker("inspect", "--format", "{{.HostConfig.NetworkMode}} {{.HostConfig.Dns}} {{.HostConfig.Privileged}} {{.HostConfig.CapDrop}}", "agentx-task-second");
      expect(info.out.trim()).toMatch(new RegExp(`^${a.names.sandboxNet} \\[\\d+\\.\\d+\\.\\d+\\.\\d+\\] false \\[ALL\\]$`));
      expect((await asWorker("rm", "--force", "agentx-task-second")).code).toBe(0);
      expect((await asWorker("ps", "--all", "--quiet", "--filter", "name=agentx-task-second")).out.trim()).toBe("");
    });

    // The two ways a worker got the whole Docker API through an earlier version of the guard (review round 1), run from inside the worker
    // with a script of its own, as a compromised worker would.
    const inWorkerScript = (script: string, ...args: string[]): Promise<Result> => docker(["exec", "-i", a.name, "node", "-e", script, ...args]);

    it("does not let a request pipelined behind an upgraded exec start reach the daemon", async () => {
      const script = String.raw`
        const http = require('http'), net = require('net');
        const [sandbox] = process.argv.slice(1);
        const call = (method, path, body) => new Promise((resolve, reject) => {
          const req = http.request({ host: 'rovara-sock', port: 2375, method, path, headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {} }, (res) => { let t = ''; res.on('data', (c) => t += c); res.on('end', () => resolve({ status: res.statusCode, text: t })); });
          req.on('error', reject); req.end(body);
        });
        (async () => {
          const made = await call('POST', '/containers/' + sandbox + '/exec', JSON.stringify({ AttachStdout: true, Cmd: ['id'] }));
          const id = JSON.parse(made.text).Id;
          const body = '{"Detach":true}';
          const smuggled = 'GET /containers/json?all=1 HTTP/1.1\r\nHost: x\r\n\r\n';
          const socket = net.connect({ host: 'rovara-sock', port: 2375 });
          let out = '';
          socket.on('data', (c) => out += c);
          socket.on('error', () => {});
          socket.write('POST /exec/' + id + '/start HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/json\r\nContent-Length: ' + body.length + '\r\n\r\n' + body + smuggled);
          setTimeout(() => { console.log(JSON.stringify({ head: out.split('\r\n')[0], leaked: /rovara-(worker|sock|gw)-/.test(out) })); process.exit(0); }, 2500);
        })();`;
      const result = await inWorkerScript(script, a.sandbox);
      const seen = JSON.parse(result.out.trim().split("\n").pop()!) as { head: string; leaked: boolean };
      expect(seen.head).toMatch(/^HTTP\/1\.1 400 /);
      expect(seen.leaked).toBe(false);
    });

    it("builds the sandbox from the names it knows, so a lower-case key cannot undo the capability drop or the limits", async () => {
      const script = `
        const http = require('http');
        const [image, workspace, key, network] = process.argv.slice(1);
        const body = JSON.stringify({ User: '1000:1000', Image: image, Cmd: ['sleep', 'infinity'], Labels: { 'agentx.task': 'x', 'agentx.workspace': key },
          HostConfig: { Binds: [workspace + ':' + workspace], NetworkMode: network, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], PidsLimit: 5, Dns: [], capdrop: [], securityopt: [], pidslimit: 0, networkmode: '', dns: [] } });
        const req = http.request({ host: 'rovara-sock', port: 2375, method: 'POST', path: '/containers/create?name=agentx-task-zero', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => { let t = ''; res.on('data', (c) => t += c); res.on('end', () => { console.log(res.statusCode); process.exit(0); }); });
        req.end(body);`;
      const key = createHash("sha256").update(a.workspace).digest("hex").slice(0, 16);
      const result = await inWorkerScript(script, IMAGE!, a.workspace, key, a.names.sandboxNet);
      expect(result.out.trim()).toBe("403");
      expect((await docker(["ps", "--all", "--quiet", "--filter", "name=agentx-task-zero"])).out.trim()).toBe("");
      // And a sandbox that is made carries what the guard forced.
      const info = await docker(["inspect", "--format", "{{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}} {{.HostConfig.Privileged}} {{.HostConfig.PidsLimit}}", a.sandbox]);
      expect(info.out.trim()).toBe("[ALL] [no-new-privileges] false 4096");
    });

    it("cannot be reached by the sandbox at all", async () => {
      for (const target of ["rovara-sock", "rovara-sock.", a.names.guard]) {
        expect((await inSandbox(a, ["curl", "-sS", "--max-time", "5", `http://${target}:2375/version`])).code, target).not.toBe(0);
      }
    });
  });

  // ---- cleanliness

  it("names every container and network after its owner, so a terminate leaves nothing", async () => {
    // Other tests (this suite may share the daemon with another file) may have machines of their own; only these two are counted.
    const hashes = [a.name, b.name].map((name) => name.slice("rovara-worker-".length));
    const ours = async (verb: string[]): Promise<string[]> => (await Promise.all(hashes.map((hash) => docker([...verb, "--filter", `label=${OWNER_LABEL}=${hash}`])))).flatMap((result) => result.out.trim().split("\n").filter(Boolean));
    expect((await ours(["ps", "--all", "--format", "{{.Names}}"])).sort()).toEqual([a.names.gateway, a.names.guard, a.name, a.sandbox, b.names.gateway, b.names.guard, b.name, b.sandbox].sort());
    expect((await ours(["network", "ls", "--format", "{{.Name}}"])).sort()).toEqual([a.names.externalNet, a.names.sandboxNet, a.names.workerNet, b.names.externalNet, b.names.sandboxNet, b.names.workerNet].sort());
    await machines.terminate(a.name);
    await machines.terminate(b.name);
    expect(await ours(["ps", "--all", "--quiet"])).toEqual([]);
    expect(await ours(["network", "ls", "--quiet"])).toEqual([]);
  });
});
