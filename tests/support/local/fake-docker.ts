// Port lane L4: a Docker command line and a worker, simulated in memory, so the local Docker adapter runs the worker-machines
// conformance suite without Docker. The simulated worker checks every invocation with the REAL worker's invoke verification
// (packages/worker/src/invoke-auth.ts), using the public key, workspace id and generation the adapter put in the container's
// environment file, so a token the real worker would refuse fails here too.
import { readFileSync } from "node:fs";
import { WorkerInvocationSchema } from "@agentx/contracts";
import type { DockerResult, DockerRunner } from "../../../packages/broker/src/local/docker-runner.js";
import { invocationMatchesClaims, invokeAuthenticationFromEnvironment, verifyInvokeAuthorization } from "../../../packages/worker/src/invoke-auth.js";

export interface FakeContainer {
  name: string;
  args: string[];
  labels: Record<string, string>;
  environment: Record<string, string>;
  status: "created" | "running" | "exited";
  exitCode: number;
  startedAt: number;
  hostPort: number;
  accepted: Set<string>;
}

export class FakeDocker implements DockerRunner {
  readonly containers = new Map<string, FakeContainer>();
  readonly calls: string[][] = [];
  readonly images = new Set<string>(["worker:test"]);
  reachable = true;
  /** Make the simulated worker not answer /ping (still starting). */
  silent = false;
  #nextPort = 40_000;

  async run(args: readonly string[]): Promise<DockerResult> {
    this.calls.push([...args]);
    const ok = (stdout = ""): DockerResult => ({ exitCode: 0, stdout, stderr: "" });
    const fail = (stderr: string): DockerResult => ({ exitCode: 1, stdout: "", stderr });
    if (!this.reachable) return fail("Cannot connect to the Docker daemon");
    const [command, ...rest] = args;
    switch (command) {
      case "version":
        return ok("29.0.0\n");
      case "image":
        return this.images.has(rest[rest.length - 1]!) ? ok("sha256:abc\n") : fail("Error: No such image");
      case "run":
        return ok("999\n"); // the socket-group probe
      case "create":
        return this.#create(rest);
      case "start": {
        const container = this.containers.get(rest[0]!);
        if (container === undefined) return fail("Error response from daemon: No such container");
        container.status = "running";
        container.startedAt = Date.now();
        container.hostPort = this.#nextPort++;
        return ok();
      }
      case "stop": {
        const container = this.containers.get(rest[rest.length - 1]!);
        if (container?.status === "running") {
          container.status = "exited";
          container.exitCode = 143;
        }
        return ok();
      }
      case "rm": {
        const names = rest.filter((entry) => !entry.startsWith("--"));
        let missing = false;
        for (const name of names) if (!this.containers.delete(name)) missing = true;
        return missing && !rest.includes("--force") ? fail("No such container") : ok();
      }
      case "inspect": {
        const container = this.containers.get(rest[rest.length - 1]!);
        if (container === undefined) return fail("Error response from daemon: No such object: x");
        return ok(`${container.status}|${container.exitCode}|${new Date(container.startedAt || 0).toISOString()}|${container.status === "running" ? container.hostPort : ""}|${container.labels["rovara.local.workspace"] ?? ""}\n`);
      }
      case "ps": {
        const labels = rest.filter((entry, index) => rest[index - 1] === "--filter" && entry.startsWith("label=")).map((entry) => entry.slice(6));
        const wantRunning = rest.includes("status=running");
        const matching = [...this.containers.values()].filter((container) => (!wantRunning || container.status === "running") && labels.every((label) => {
          const [key, value] = label.split("=");
          return container.labels[key!] === value;
        }));
        return ok(matching.map((container) => (rest.includes("--quiet") ? container.name.slice(0, 12) : container.name)).join("\n"));
      }
      default:
        return fail(`unexpected docker command ${String(command)}`);
    }
  }

  #create(args: string[]): DockerResult {
    const valueOf = (flag: string): string[] => args.flatMap((entry, index) => (entry === flag ? [args[index + 1]!] : []));
    const name = valueOf("--name")[0]!;
    if (this.containers.has(name)) return { exitCode: 1, stdout: "", stderr: `Conflict. The container name "${name}" is already in use` };
    const labels = Object.fromEntries(valueOf("--label").map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
    const environment = Object.fromEntries(readFileSync(valueOf("--env-file")[0]!, "utf8").split("\n").filter((line) => line !== "").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    this.containers.set(name, { name, args: [...args], labels, environment, status: "created", exitCode: 0, startedAt: 0, hostPort: 0, accepted: new Set() });
    return { exitCode: 0, stdout: `${name}\n`, stderr: "" };
  }

  /** The fetch the adapter uses to talk to the simulated workers. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const container = [...this.containers.values()].find((entry) => entry.status === "running" && entry.hostPort === Number(url.port));
    if (container === undefined || url.hostname !== "127.0.0.1") throw new TypeError("connection refused");
    if (url.pathname === "/ping") {
      if (this.silent) throw new TypeError("connection refused");
      return Response.json({ status: container.accepted.size === 0 ? "Healthy" : "HealthyBusy", activeOperations: container.accepted.size, invocationFeatures: ["fake-feature"] });
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
      return Response.json({ accepted: true, operationId: parsed.data.operationId, status: "ACCEPTED", duplicate });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  };
}
