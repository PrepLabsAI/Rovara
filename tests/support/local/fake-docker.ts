// Port lane L4: a Docker command line and a worker, simulated in memory, so the local Docker adapter runs the worker-machines
// conformance suite without Docker. The simulated worker checks every invocation with the REAL worker's invoke verification
// (packages/worker/src/invoke-auth.ts), using the public key, workspace id and generation the adapter put in the container's
// environment file, so a token the real worker would refuse fails here too.
import { readFileSync } from "node:fs";
import { WorkerInvocationSchema, type WorkerInvocation } from "@agentx/contracts";
import type { DockerResult, DockerRunner } from "../../../packages/broker/src/local/docker-runner.js";
import { invocationMatchesClaims, invokeAuthenticationFromEnvironment, verifyInvokeAuthorization } from "../../../packages/worker/src/invoke-auth.js";

export interface FakeContainer {
  name: string;
  /** `worker`, the two helpers (`gateway`, `guard`), or `other` (a sandbox or anything a test puts there). */
  kind: "worker" | "gateway" | "guard" | "other";
  args: string[];
  labels: Record<string, string>;
  environment: Record<string, string>;
  /** Network name to the address the container has on it (given when it starts). */
  networks: Map<string, string>;
  status: "created" | "running" | "exited";
  exitCode: number;
  oomKilled: boolean;
  createdAt: number;
  startedAt: number;
  /** The host port: only a gateway has one (it publishes the worker's port). */
  hostPort: number;
  accepted: Set<string>;
}

export interface FakeNetwork {
  name: string;
  internal: boolean;
  options: Record<string, string>;
  subnet: string;
  labels: Record<string, string>;
}

/** The text of a `docker inspect --format` template, for the few shapes the adapter uses. */
function render(template: string, container: FakeContainer): string {
  return template
    .replace(/\{\{\.State\.Status\}\}/g, container.status)
    .replace(/\{\{\.State\.ExitCode\}\}/g, String(container.exitCode))
    .replace(/\{\{\.State\.OOMKilled\}\}/g, String(container.oomKilled))
    .replace(/\{\{\.State\.StartedAt\}\}/g, new Date(container.startedAt || 0).toISOString())
    .replace(/\{\{\.Created\}\}/g, new Date(container.createdAt).toISOString())
    .replace(/\{\{\.Name\}\}/g, `/${container.name}`)
    .replace(/\{\{index \.Config\.Labels "([^"]+)"\}\}/g, (_match, key: string) => container.labels[key] ?? "")
    .replace(/\{\{json \.NetworkSettings\.Networks\}\}/g, () => JSON.stringify(Object.fromEntries([...container.networks].map(([name, address]) => [name, { IPAddress: address }]))))
    .replace(/\{\{with index \.NetworkSettings\.Ports "[^"]+"\}\}\{\{\(index \. 0\)\.HostPort\}\}\{\{end\}\}/g, container.status === "running" && container.hostPort > 0 ? String(container.hostPort) : "");
}

export class FakeDocker implements DockerRunner {
  readonly containers = new Map<string, FakeContainer>();
  readonly networks = new Map<string, FakeNetwork>();
  readonly calls: string[][] = [];
  readonly images = new Set<string>(["worker:test"]);
  reachable = true;
  /** Make the simulated worker not answer /ping (still starting). */
  silent = false;
  /** The features the simulated worker lists on /ping (the real worker lists `task.workflowMode`). */
  features: string[] = ["fake-feature"];
  /** Every invocation a simulated worker accepted, in order (lane L9-wire: a test answers its callbacks). */
  readonly invocations: WorkerInvocation[] = [];
  /** Removing a container whose name is not one of ours fails, as a stuck sandbox does. */
  failSandboxRemoval = false;
  /** Creating a network fails, as when Docker has run out of address ranges. */
  failNetworkCreate: string | undefined;
  #nextPort = 40_000;
  #nextNetwork = 20;
  #nextHost = 2;

  /** The host port a machine's worker is reached on: its gateway's. */
  portOf(workerName: string): number {
    const hash = workerName.slice("rovara-worker-".length);
    return this.containers.get(`rovara-gw-${hash}`)?.hostPort ?? 0;
  }

  async run(args: readonly string[]): Promise<DockerResult> {
    this.calls.push([...args]);
    const ok = (stdout = ""): DockerResult => ({ exitCode: 0, stdout, stderr: "" });
    const fail = (stderr: string): DockerResult => ({ exitCode: 1, stdout: "", stderr });
    if (!this.reachable) return fail("Cannot connect to the Docker daemon");
    const [command, ...rest] = args;
    const positional = (): string[] => {
      const found: string[] = [];
      const withValue = new Set(["--time", "--format", "--filter", "--type", "--alias", "--driver", "-o", "--label"]);
      for (let index = 0; index < rest.length; index += 1) {
        if (withValue.has(rest[index]!)) index += 1;
        else if (!rest[index]!.startsWith("-")) found.push(rest[index]!);
      }
      return found;
    };
    switch (command) {
      case "version":
        return ok("29.0.0\n");
      case "image":
        return this.images.has(rest[rest.length - 1]!) ? ok("sha256:abc\n") : fail("Error: No such image");
      case "run":
        return ok("999\n"); // the socket-group probe
      case "network":
        return this.#network(rest);
      case "create":
        return this.#create(rest);
      case "start": {
        const names = positional();
        for (const name of names) {
          const container = this.containers.get(name);
          if (container === undefined) return fail("Error response from daemon: No such container");
          container.status = "running";
          container.startedAt = Date.now();
          if (container.kind === "gateway") {
            container.hostPort = this.#nextPort++;
            // An address is kept for the life of the container, as Docker keeps one while the container exists.
            for (const [network, address] of container.networks) if (address === "") container.networks.set(network, `172.${this.#nextNetwork}.${this.#nextHost++}.2`);
          }
        }
        return ok();
      }
      case "stop": {
        for (const name of positional()) {
          const container = this.containers.get(name);
          if (container?.status === "running") {
            container.status = "exited";
            container.exitCode = 143;
          }
        }
        return ok();
      }
      case "rm": {
        const names = positional();
        if (this.failSandboxRemoval && names.some((name) => this.containers.get(name)?.kind === "other" || /^[0-9a-f]{12}$/.test(name))) return fail("removal of container is already in progress");
        let missing = false;
        for (const name of names) {
          const found = [...this.containers.keys()].find((key) => key === name || key.startsWith(name));
          if (found === undefined) missing = true;
          else this.containers.delete(found);
        }
        return missing && !rest.includes("--force") ? fail("No such container") : ok();
      }
      case "inspect": {
        const names = positional();
        const format = rest[rest.indexOf("--format") + 1] ?? "";
        const lines: string[] = [];
        for (const name of names) {
          const container = this.containers.get(name);
          if (container === undefined) return { exitCode: 1, stdout: lines.join("\n"), stderr: `Error response from daemon: No such object: ${name}` };
          lines.push(render(format, container));
        }
        return ok(`${lines.join("\n")}\n`);
      }
      case "ps": {
        const labels = rest.filter((entry, index) => rest[index - 1] === "--filter" && entry.startsWith("label=")).map((entry) => entry.slice(6));
        const wantRunning = rest.includes("status=running");
        const matching = [...this.containers.values()].filter((container) => (!wantRunning || container.status === "running") && labels.every((label) => {
          const [key, value] = label.split("=");
          return value === undefined ? container.labels[key!] !== undefined : container.labels[key!] === value;
        }));
        return ok(matching.map((container) => (rest.includes("--quiet") ? container.name.slice(0, 12) : container.name)).join("\n"));
      }
      default:
        return fail(`unexpected docker command ${String(command)}`);
    }
  }

  #network(args: string[]): DockerResult {
    const [verb, ...rest] = args;
    const fail = (stderr: string): DockerResult => ({ exitCode: 1, stdout: "", stderr });
    const valuesOf = (flag: string): string[] => rest.flatMap((entry, index) => (entry === flag ? [rest[index + 1]!] : []));
    if (verb === "create") {
      const name = rest[rest.length - 1]!;
      if (this.failNetworkCreate !== undefined) return fail(this.failNetworkCreate);
      if (this.networks.has(name)) return fail(`network with name ${name} already exists`);
      const options = Object.fromEntries(valuesOf("-o").map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
      const labels = Object.fromEntries(valuesOf("--label").map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
      this.networks.set(name, { name, internal: rest.includes("--internal"), options, subnet: `172.${this.#nextNetwork++}.0.0/16`, labels });
      return { exitCode: 0, stdout: `${name}\n`, stderr: "" };
    }
    if (verb === "inspect") {
      const network = this.networks.get(rest[rest.length - 1]!);
      if (network === undefined) return fail("Error response from daemon: network not found");
      return { exitCode: 0, stdout: `bridge|${network.internal}|${network.options["com.docker.network.bridge.inhibit_ipv4"] ?? ""}|false|${network.subnet} \n`, stderr: "" };
    }
    if (verb === "rm") {
      const name = rest[rest.length - 1]!;
      if (!this.networks.has(name)) return fail("Error response from daemon: network not found");
      if ([...this.containers.values()].some((container) => container.networks.has(name))) return fail(`network ${name} has active endpoints`);
      this.networks.delete(name);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (verb === "connect") {
      const [network, container] = rest.slice(-2) as [string, string];
      const found = this.containers.get(container);
      if (found === undefined || !this.networks.has(network)) return fail("No such container or network");
      found.networks.set(network, "");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return fail(`unexpected docker network command ${String(verb)}`);
  }

  #create(args: string[]): DockerResult {
    const valueOf = (flag: string): string[] => args.flatMap((entry, index) => (entry === flag ? [args[index + 1]!] : []));
    const name = valueOf("--name")[0]!;
    if (this.containers.has(name)) return { exitCode: 1, stdout: "", stderr: `Conflict. The container name "${name}" is already in use` };
    const labels = Object.fromEntries(valueOf("--label").map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
    const kind = labels["rovara.local.helper"] === "gateway" ? "gateway" : labels["rovara.local.helper"] === "guard" ? "guard" : labels["rovara.local.machine"] === "1" ? "worker" : "other";
    const envFile = valueOf("--env-file")[0];
    const environment = envFile === undefined
      ? Object.fromEntries(valueOf("--env").map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]))
      : Object.fromEntries(readFileSync(envFile, "utf8").split("\n").filter((line) => line !== "").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    const networks = new Map<string, string>();
    for (const network of valueOf("--network")) {
      if (!this.networks.has(network)) return { exitCode: 1, stdout: "", stderr: `Error response from daemon: network ${network} not found` };
      networks.set(network, "");
    }
    this.containers.set(name, { name, kind, args: [...args], labels, environment, networks, status: "created", exitCode: 0, oomKilled: false, createdAt: Date.now(), startedAt: 0, hostPort: 0, accepted: new Set() });
    return { exitCode: 0, stdout: `${name}\n`, stderr: "" };
  }

  /** The fetch the adapter uses to talk to the simulated workers. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const gateway = [...this.containers.values()].find((entry) => entry.kind === "gateway" && entry.status === "running" && entry.hostPort === Number(url.port));
    const container = gateway === undefined ? undefined : this.containers.get(`rovara-worker-${gateway.name.slice("rovara-gw-".length)}`);
    // The gateway only forwards: a worker that is not running does not answer.
    if (container === undefined || container.status !== "running" || url.hostname !== "127.0.0.1") throw new TypeError("connection refused");
    if (url.pathname === "/ping") {
      if (this.silent) throw new TypeError("connection refused");
      return Response.json({ status: container.accepted.size === 0 ? "Healthy" : "HealthyBusy", activeOperations: container.accepted.size, invocationFeatures: this.features });
    }
    if (url.pathname === "/invocations" && init?.method === "POST") {
      const authentication = invokeAuthenticationFromEnvironment(container.environment);
      const headers = new Headers(init.headers);
      const verified = verifyInvokeAuthorization(headers.get("authorization"), authentication);
      if (!verified.ok) return Response.json({ error: "invocation is not authorized", reason: verified.reason }, { status: 401 });
      const parsed = WorkerInvocationSchema.safeParse(JSON.parse(typeof init.body === "string" ? init.body : ""));
      if (!parsed.success) return Response.json({ error: "invalid" }, { status: 400 });
      if (!invocationMatchesClaims(parsed.data, verified.claims)) return Response.json({ error: "invocation is not authorized", reason: "invocation_mismatch" }, { status: 401 });
      const duplicate = container.accepted.has(parsed.data.operationId);
      container.accepted.add(parsed.data.operationId);
      if (!duplicate) this.invocations.push(parsed.data);
      return Response.json({ accepted: true, operationId: parsed.data.operationId, status: "ACCEPTED", duplicate });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  };
}
