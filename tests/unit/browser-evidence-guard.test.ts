/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
   the guard tests build Docker API bodies as free-form objects and change one field at a time; the shape under test is whatever an attacker sends. */
// TE-H1 slice 2 (DEC 241a), the laptop's half: the Docker socket guard lets the worker start ONE kind of new container (the capture container: the executor image, sharing one of the worker's own sandboxes' network namespace and
// nothing else), only when the owner's broker gave it the executor image and the pinned profile. Each rule has a request that must pass and requests that must be refused (one field changed at a time); without the policy none of it is reachable.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer, connect as netConnect, type Server as NetServer } from "node:net";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DOCKER_SOCKET_GUARD_SOURCE } from "../../packages/broker/src/local/isolation/docker-socket-guard-source.js";
import { guardPolicy } from "../../packages/broker/src/local/isolation/stack.js";
import { compactJsonText, executorImageOf } from "../../packages/broker/src/local/isolation/browser-evidence-setting.js";
import { installedExecutorSeccompProfilePath } from "../../packages/verifier/src/host/executor-seccomp.js";
import { executorContainerArgs } from "../../packages/verifier/src/host/executor-container.js";
import { browserEvidenceExecutorArgs } from "../../packages/worker/src/browser-evidence-run.js";

const scratch: string[] = [];
afterAll(async () => { while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true }); });

const OWNER = "a".repeat(24);
const WORKSPACE = "/home/me/.rovara/workspaces/aaaa";
const KEY = createHash("sha256").update("workspace").digest("hex").slice(0, 16);
const WORKER_IMAGE = "worker:test";
const EXECUTOR = `sha256:${"e".repeat(64)}`;
const SECCOMP = compactJsonText(readFileSync(installedExecutorSeccompProfilePath(), "utf8"));
const SANDBOX = "agentx-task-op1-abcd1234";
const SANDBOX_ID = "s".repeat(64);
const SERVICE = "rovara-svc-0123456789ab-check";
const CAPTURE = "rovara-be-0123456789ab";
const CAPTURE_ID = "c".repeat(64);
const PLAN = "eyJwb3J0Ijo0MzIxfQ";
const ENTRY = "/opt/agentx/packages/verifier/dist/executor/browser-evidence-entry.js";
const TMPFS = "rw,exec,nosuid,nodev,size=512m";

const policy = (browser: Record<string, unknown> | undefined) => ({
  upstream: "/var/run/docker.sock", owner: OWNER, image: WORKER_IMAGE, workspaceDir: WORKSPACE, workspaceKey: KEY, network: "rovara-snet-aaaa", dns: ["172.31.0.2"], user: "1000:1000", port: 2375, maxSandboxes: 16,
  ...(browser === undefined ? {} : { browserEvidence: browser }),
});
interface FakeContainer { id: string; name: string; labels: Record<string, string> }
interface Seen { method: string; url: string; body: string }

async function fakeDaemon(state: { containers: FakeContainer[] }) {
  const directory = await mkdtemp(join(tmpdir(), "rg-be-"));
  scratch.push(directory);
  const socketPath = join(directory, "d.sock");
  const seen: Seen[] = [];
  const labelMatches = (labels: Record<string, string>, filter: Record<string, boolean>): boolean => Object.keys(filter).every((entry) => { const [key, value] = entry.split("="); return value === undefined ? key! in labels : labels[key!] === value; });
  const server: NetServer = createNetServer((socket) => {
    let held = Buffer.alloc(0);
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      held = Buffer.concat([held, chunk]);
      for (;;) {
        const end = held.indexOf("\r\n\r\n");
        if (end === -1) return;
        const head = held.subarray(0, end).toString("latin1");
        const length = Number(/content-length: (\d+)/i.exec(head)?.[1] ?? 0);
        if (held.length < end + 4 + length) return;
        const [line = ""] = head.split("\r\n");
        const [method = "", url = ""] = line.split(" ");
        const body = held.subarray(end + 4, end + 4 + length).toString("utf8");
        held = held.subarray(end + 4 + length);
        seen.push({ method, url, body });
        const reply = (status: string, json: unknown): void => {
          const text = JSON.stringify(json);
          socket.write(`HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
        };
        const target = new URL(url, "http://d");
        let m: RegExpExecArray | null;
        if (method === "GET" && (m = /^\/containers\/([^/]+)\/json$/.exec(target.pathname)) !== null) {
          const found = state.containers.find((entry) => entry.id === m![1] || entry.name === decodeURIComponent(m![1]!));
          if (found === undefined) reply("404 Not Found", { message: "no such container" });
          else reply("200 OK", { Id: found.id, Name: `/${found.name}`, Config: { User: "", Labels: found.labels } });
        } else if (method === "GET" && target.pathname === "/containers/json") {
          const filters = JSON.parse(target.searchParams.get("filters") ?? "{}") as { label?: Record<string, boolean> };
          reply("200 OK", state.containers.filter((entry) => labelMatches(entry.labels, filters.label ?? {})).map((entry) => ({ Id: entry.id, Names: [`/${entry.name}`], Labels: entry.labels })));
        } else if (method === "POST" && target.pathname === "/containers/create") reply("201 Created", { Id: CAPTURE_ID });
        else if (method === "POST" && /^\/containers\/[^/]+\/attach$/.test(target.pathname)) { socket.write("HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n"); socket.write("hello"); }
        else reply("200 OK", {});
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { socketPath, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const sandboxContainer = (): FakeContainer => ({ id: SANDBOX_ID, name: SANDBOX, labels: { "rovara.local.owner": OWNER, "rovara.local.sandbox": "1" } });
const captureContainer = (name = CAPTURE, id = CAPTURE_ID): FakeContainer => ({ id, name, labels: { "rovara.local.owner": OWNER, "rovara.local.sandbox": "browser-evidence", "rovara.browser-evidence": "1" } });

async function world(browser: Record<string, unknown> | null = { image: EXECUTOR, seccomp: SECCOMP }, containers: FakeContainer[] = [sandboxContainer()]) {
  const state = { containers };
  const daemon = await fakeDaemon(state);
  const directory = await mkdtemp(join(tmpdir(), "rg-be-prog-"));
  scratch.push(directory);
  const file = join(directory, "guard.cjs");
  await writeFile(file, DOCKER_SOCKET_GUARD_SOURCE);
  const saved = { ...process.env };
  Object.assign(process.env, { ROVARA_SOCK_POLICY: JSON.stringify({ ...policy(browser ?? undefined), upstream: daemon.socketPath }), ROVARA_SOCK_LIBRARY: "1" });
  let guard: { createServer(): Server };
  try { guard = createRequire(import.meta.url)(file) as typeof guard; } finally { for (const key of ["ROVARA_SOCK_POLICY", "ROVARA_SOCK_LIBRARY"]) delete process.env[key]; Object.assign(process.env, saved); }
  const server = guard.createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  const call = (method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> => new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const outgoing = httpRequest({ host: "127.0.0.1", port, method, path, headers: text === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(text) } }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, text: Buffer.concat(chunks).toString() }));
    });
    outgoing.on("error", reject);
    outgoing.end(text);
  });
  const upgrade = (path: string): Promise<string> => new Promise((resolve) => {
    const socket = netConnect({ host: "127.0.0.1", port }, () => { socket.write(`POST ${path} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n`); });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", () => undefined);
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
    setTimeout(() => socket.destroy(), 500);
  });
  return { daemon, state, call, upgrade, forwarded: (prefix: string): Seen[] => daemon.seen.filter((entry) => entry.method !== "GET" && entry.url.startsWith(prefix)), close: async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await daemon.close(); } };
}
type World = Awaited<ReturnType<typeof world>>;
async function using<T>(browser: Record<string, unknown> | null, body: (w: World) => Promise<T>, containers?: FakeContainer[]): Promise<T> {
  const w = await world(browser, containers);
  try { return await body(w); } finally { await w.close(); }
}

/** `docker run ... <executor image> node <entry> <plan>` as the worker's own arguments make the docker CLI send it. */
const hostZero = (): Record<string, any> => ({
  ContainerIDFile: "", PortBindings: {}, VolumeDriver: "", VolumesFrom: null, ConsoleSize: [0, 0], CapAdd: null, Dns: null, DnsOptions: [], DnsSearch: [], ExtraHosts: null, GroupAdd: null, IpcMode: "", Cgroup: "", Links: null,
  OomScoreAdj: 0, PidMode: "", PublishAllPorts: false, UTSMode: "", UsernsMode: "", CgroupParent: "", BlkioWeight: 0, BlkioWeightDevice: [], BlkioDeviceReadBps: [], BlkioDeviceWriteBps: [], BlkioDeviceReadIOps: [],
  BlkioDeviceWriteIOps: [], CpuPeriod: 0, CpuQuota: 0, CpuRealtimePeriod: 0, CpuRealtimeRuntime: 0, CpusetMems: "", Devices: [], DeviceCgroupRules: null, DeviceRequests: null, CpuCount: 0, CpuPercent: 0, IOMaximumIOps: 0,
  IOMaximumBandwidth: 0, Runtime: "", MaskedPaths: null, ReadonlyPaths: null, CgroupnsMode: "", Isolation: "", MemorySwappiness: -1, OomKillDisable: false, Ulimits: null, CpusetCpus: "", CpuShares: 0, MemoryReservation: 0,
  Privileged: false, RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
});
const captureBody = (): Record<string, any> => ({
  Hostname: "", Domainname: "", Volumes: null, ExposedPorts: null, Env: null, WorkingDir: "", User: "", Image: EXECUTOR, Cmd: ["node", ENTRY, PLAN], Entrypoint: null,
  Labels: { "rovara.browser-evidence": "1" }, AttachStdin: false, AttachStdout: true, AttachStderr: true, Tty: false, OpenStdin: false, StdinOnce: false,
  HostConfig: { ...hostZero(), NetworkMode: `container:${SANDBOX}`, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges", `seccomp=${SECCOMP}`], ReadonlyRootfs: true, Init: true, AutoRemove: true, ShmSize: 1073741824,
    Tmpfs: { "/tmp": TMPFS }, Memory: 2147483648, MemorySwap: 2147483648, PidsLimit: 1024, NanoCpus: 2000000000, Binds: null, LogConfig: { Type: "", Config: {} } },
  NetworkingConfig: { EndpointsConfig: {} },
});
const mutated = (change: (value: Record<string, any>) => void): Record<string, any> => { const value = captureBody(); change(value); return value; };
const create = (w: World, name: string, body: unknown, query = "") => w.call("POST", `/v1.54/containers/create?name=${encodeURIComponent(name)}${query}`, body);

describe("the arguments the worker passes are the shape the guard accepts", () => {
  it("is exactly what the guard compares: the executor's own flags (limits, seccomp, tmpfs), and the command", () => {
    const args = browserEvidenceExecutorArgs({ image: EXECUTOR, sandbox: SANDBOX, name: CAPTURE, seccompProfile: installedExecutorSeccompProfilePath(), plan: PLAN });
    expect(args).toEqual(expect.arrayContaining(executorContainerArgs(installedExecutorSeccompProfilePath())));
    expect(args.slice(-3)).toEqual(["node", ENTRY, PLAN]);
    expect(args).toEqual(expect.arrayContaining(["--shm-size", "1g", "--memory", "2g", "--memory-swap", "2g", "--pids-limit", "1024", "--cpus", "2", "--tmpfs", `/tmp:${TMPFS}`]));
  });
  it("compacts the profile as the docker CLI does (the guard compares text), and refuses text that is not JSON", () => {
    expect(SECCOMP).toBe(JSON.stringify(JSON.parse(readFileSync(installedExecutorSeccompProfilePath(), "utf8"))));
    expect(compactJsonText('{ "a": "x  y\\" z", "b": [1, 2],\n "c": {} }')).toBe('{"a":"x  y\\" z","b":[1,2],"c":{}}');
    expect(() => compactJsonText("{ nope")).toThrow();
  });
  it("names an executor image only as a plain reference", () => {
    expect(executorImageOf({ ROVARA_EXECUTOR_IMAGE: " rovara-e2e-executor:local " })).toBe("rovara-e2e-executor:local");
    expect(executorImageOf({ ROVARA_EXECUTOR_IMAGE: "registry.example/x/y@sha256:abc" })).toBeDefined();
    for (const bad of ["", "-v /:/host", "a b", "a\nb", "x".repeat(300), undefined]) expect(executorImageOf({ ROVARA_EXECUTOR_IMAGE: bad }), String(bad)).toBeUndefined();
    expect(executorImageOf(undefined)).toBeUndefined();
  });
});

describe("browser evidence: the guard without `policy.browserEvidence` is the plain guard", () => {
  it("refuses a capture container, its image's inspect and its attach, as it always refused any other container", async () => {
    await using(null, async (w) => {
      expect((await create(w, CAPTURE, captureBody())).status).toBe(403);
      expect((await w.call("GET", `/images/${encodeURIComponent(EXECUTOR)}/json`)).status).toBe(403);
      expect(w.forwarded("/containers/create")).toEqual([]);
    }, [sandboxContainer(), captureContainer()]);
  });
  it("is the plain guard too for a policy that is not exactly the shape (no pinned id, no profile, a profile that is not text)", async () => {
    for (const bad of [{ image: "executor:latest", seccomp: SECCOMP }, { image: EXECUTOR }, { image: EXECUTOR, seccomp: "" }, { image: EXECUTOR, seccomp: 5 }, { seccomp: SECCOMP }, "x", []]) {
      await using(bad as never, async (w) => { expect((await create(w, CAPTURE, captureBody())).status, JSON.stringify(bad)).toBe(403); });
    }
  });
  it("puts the policy into the guard only when it is given (the plain policy is byte-identical)", () => {
    const base = { names: { sandboxNet: "n" }, socketPath: "/s", socketGroup: "1", workspaceDirectory: "/w", workspaceKey: "k", owner: "o", sandboxDns: "1.1.1.1", image: "i", labels: [] } as never;
    expect(guardPolicy(base)).not.toHaveProperty("browserEvidence");
    expect(guardPolicy({ ...(base as object), browserEvidence: { image: EXECUTOR, seccomp: SECCOMP } } as never)).toMatchObject({ browserEvidence: { image: EXECUTOR, seccomp: SECCOMP } });
  });
});

describe("browser evidence: creating a capture container", () => {
  it("lets the one shape through, rebuilt: only the fields the guard understands, with its own owner and class labels", async () => {
    await using({ image: EXECUTOR, seccomp: SECCOMP }, async (w) => {
      const answer = await create(w, CAPTURE, captureBody());
      expect(answer.status).toBe(201);
      const [sent] = w.forwarded("/containers/create");
      expect(sent?.url).toBe(`/containers/create?name=${CAPTURE}`);
      const body = JSON.parse(sent!.body) as Record<string, any>;
      expect(body).toMatchObject({ Image: EXECUTOR, Cmd: ["node", ENTRY, PLAN], Entrypoint: null, Env: null, User: "", Tty: false, AttachStdin: false, AttachStdout: true,
        Labels: { "rovara.local.owner": OWNER, "rovara.local.sandbox": "browser-evidence", "rovara.browser-evidence": "1" },
        HostConfig: { NetworkMode: `container:${SANDBOX}`, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges", `seccomp=${SECCOMP}`], Privileged: false, ReadonlyRootfs: true, Init: true, AutoRemove: true, ShmSize: 1073741824,
          Memory: 2147483648, MemorySwap: 2147483648, PidsLimit: 1024, NanoCpus: 2000000000, Tmpfs: { "/tmp": TMPFS }, Binds: [] } });
      expect(Object.keys(body["HostConfig"] as object).sort()).toEqual(["AutoRemove", "Binds", "CapDrop", "Init", "Memory", "MemorySwap", "NanoCpus", "NetworkMode", "PidsLimit", "Privileged", "ReadonlyRootfs", "SecurityOpt", "ShmSize", "Tmpfs"]);
    });
  });

  it("refuses every body that differs from the shape in one field, forwarding nothing", async () => {
    const refusals: Array<[string, (value: Record<string, any>) => void]> = [
      ["another image", (v) => { v.Image = "worker:test"; }], ["the image by a tag", (v) => { v.Image = "rovara-e2e-executor:latest"; }],
      ["another program", (v) => { v.Cmd = ["sh", "-c", "id"]; }], ["another entry", (v) => { v.Cmd = ["node", "/etc/passwd", PLAN]; }], ["no plan", (v) => { v.Cmd = ["node", ENTRY]; }], ["a second argument", (v) => { v.Cmd = ["node", ENTRY, PLAN, "--flag"]; }],
      ["a plan that is not base64url", (v) => { v.Cmd = ["node", ENTRY, "a b; id"]; }], ["a very long plan", (v) => { v.Cmd = ["node", ENTRY, "a".repeat(16_385)]; }],
      ["an entrypoint", (v) => { v.Entrypoint = ["/bin/sh"]; }], ["an environment", (v) => { v.Env = ["A=1"]; }], ["a user", (v) => { v.User = "0:0"; }], ["a working directory", (v) => { v.WorkingDir = "/work"; }],
      ["stdin", (v) => { v.OpenStdin = true; }], ["a tty", (v) => { v.Tty = true; }], ["a stop signal", (v) => { v.StopSignal = "SIGKILL"; }], ["another label", (v) => { v.Labels = { "rovara.local.owner": "x" }; }],
      ["a volume", (v) => { v.Volumes = { "/x": {} }; }], ["an exposed port", (v) => { v.ExposedPorts = { "80/tcp": {} }; }], ["a hostname", (v) => { v.Hostname = "evil"; }],
      ["the host network", (v) => { v.HostConfig.NetworkMode = "host"; }], ["the sandbox network by name", (v) => { v.HostConfig.NetworkMode = "rovara-snet-aaaa"; }], ["a container that is not there", (v) => { v.HostConfig.NetworkMode = "container:agentx-task-nope"; }],
      ["a service container's namespace", (v) => { v.HostConfig.NetworkMode = `container:${SERVICE}`; }], ["another capture container's", (v) => { v.HostConfig.NetworkMode = `container:${CAPTURE}`; }], ["the namespace by id", (v) => { v.HostConfig.NetworkMode = `container:${SANDBOX_ID}`; }],
      ["a capability added", (v) => { v.HostConfig.CapAdd = ["NET_ADMIN"]; }], ["capabilities not dropped", (v) => { v.HostConfig.CapDrop = []; }], ["only one capability dropped", (v) => { v.HostConfig.CapDrop = ["NET_RAW"]; }], ["every capability and another named", (v) => { v.HostConfig.CapDrop = ["ALL", "NET_RAW"]; }], ["privileged", (v) => { v.HostConfig.Privileged = true; }],
      ["another seccomp profile", (v) => { v.HostConfig.SecurityOpt = ["no-new-privileges", "seccomp=unconfined"]; }], ["no seccomp", (v) => { v.HostConfig.SecurityOpt = ["no-new-privileges"]; }], ["a profile with a change", (v) => { v.HostConfig.SecurityOpt = ["no-new-privileges", `seccomp=${SECCOMP} `]; }],
      ["no no-new-privileges", (v) => { v.HostConfig.SecurityOpt = [`seccomp=${SECCOMP}`, "label=disable"]; }], ["an apparmor opt", (v) => { v.HostConfig.SecurityOpt = ["no-new-privileges", `seccomp=${SECCOMP}`, "apparmor=unconfined"]; }],
      ["a writable root", (v) => { v.HostConfig.ReadonlyRootfs = false; }], ["no init", (v) => { v.HostConfig.Init = false; }], ["no removal", (v) => { v.HostConfig.AutoRemove = false; }],
      ["a bind mount", (v) => { v.HostConfig.Binds = ["/:/host"]; }], ["a mount", (v) => { v.HostConfig.Mounts = [{ Type: "bind", Source: "/", Target: "/host" }]; }], ["a device", (v) => { v.HostConfig.Devices = [{ PathOnHost: "/dev/kvm" }]; }],
      ["a bigger memory", (v) => { v.HostConfig.Memory = 8 * 1073741824; }], ["swap", (v) => { v.HostConfig.MemorySwap = 8 * 1073741824; }], ["more processes", (v) => { v.HostConfig.PidsLimit = 100000; }], ["more cpus", (v) => { v.HostConfig.NanoCpus = 16_000_000_000; }],
      ["no cpu limit", (v) => { delete v.HostConfig.NanoCpus; }], ["more shared memory", (v) => { v.HostConfig.ShmSize = 8 * 1073741824; }],
      ["another tmpfs", (v) => { v.HostConfig.Tmpfs = { "/tmp": "rw,exec,size=64g" }; }], ["a second tmpfs", (v) => { v.HostConfig.Tmpfs = { "/tmp": TMPFS, "/data": "rw" }; }],
      ["a published port", (v) => { v.HostConfig.PortBindings = { "80/tcp": [{ HostPort: "80" }] }; }], ["the host pid namespace", (v) => { v.HostConfig.PidMode = "host"; }], ["the host ipc namespace", (v) => { v.HostConfig.IpcMode = "host"; }],
      ["a dns server", (v) => { v.HostConfig.Dns = ["8.8.8.8"]; }], ["an extra host", (v) => { v.HostConfig.ExtraHosts = ["x:1.2.3.4"]; }], ["a restart policy", (v) => { v.HostConfig.RestartPolicy = { Name: "always" }; }],
      ["a log driver", (v) => { v.HostConfig.LogConfig = { Type: "syslog", Config: { "syslog-address": "tcp://x" } }; }], ["a sysctl", (v) => { v.HostConfig.Sysctls = { "net.ipv4.ip_forward": "1" }; }], ["a key the guard does not know", (v) => { v.HostConfig.Surprise = true; }],
      ["a network of its own", (v) => { v.NetworkingConfig = { EndpointsConfig: { bridge: {} } }; }], ["a top-level key the guard does not know", (v) => { v.Surprise = 1; }],
    ];
    await using({ image: EXECUTOR, seccomp: SECCOMP }, async (w) => {
      for (const [what, change] of refusals) expect((await create(w, CAPTURE, mutated(change))).status, what).toBe(403);
      expect(w.forwarded("/containers/create")).toEqual([]);
      // The same shape is accepted afterwards: the refusals above were each for their one field.
      expect((await create(w, CAPTURE, captureBody())).status).toBe(201);
    }, [sandboxContainer(), { id: "v".repeat(64), name: SERVICE, labels: { "rovara.local.owner": OWNER, "rovara.local.sandbox": "service", "rovara.local.profile": "check" } }, captureContainer("rovara-be-aaaaaaaaaaaa", "d".repeat(64))].slice(0, 2));
  });

  it("refuses a name that is not one of the guard's, an option the guard did not allow, malformed bodies, and a sandbox that is a dev container's or another worker's", async () => {
    await using({ image: EXECUTOR, seccomp: SECCOMP }, async (w) => {
      for (const name of ["", "rovara-be-xyz", "rovara-be-0123456789abc", "evil", "rovara-be-0123456789AB"]) expect((await create(w, name, captureBody())).status, name).toBe(403);
      expect((await create(w, CAPTURE, captureBody(), "&platform=linux/amd64")).status).toBe(403);
      expect((await create(w, CAPTURE, "not json")).status).toBe(403);
      expect((await create(w, CAPTURE, [])).status).toBe(403);
      expect((await create(w, CAPTURE, { ...captureBody(), HostConfig: undefined })).status).toBe(403);
      expect(w.forwarded("/containers/create")).toEqual([]);
    });
    const dev = { id: "d".repeat(64), name: "agentx-dev-1", labels: { "rovara.local.owner": OWNER, "rovara.local.sandbox": "1", "rovara.local.devcontainer": "1" } };
    await using({ image: EXECUTOR, seccomp: SECCOMP }, async (w) => { expect((await create(w, CAPTURE, mutated((v) => { v.HostConfig.NetworkMode = "container:agentx-dev-1"; }))).status).toBe(403); }, [sandboxContainer(), dev]);
    const stranger = { id: "x".repeat(64), name: "agentx-task-other-1", labels: { "rovara.local.owner": "b".repeat(24), "rovara.local.sandbox": "1" } };
    await using({ image: EXECUTOR, seccomp: SECCOMP }, async (w) => { expect((await create(w, CAPTURE, mutated((v) => { v.HostConfig.NetworkMode = "container:agentx-task-other-1"; }))).status).toBe(403); }, [sandboxContainer(), stranger]);
  });

  it("allows at most two at once", async () => {
    await using({ image: EXECUTOR, seccomp: SECCOMP }, async (w) => {
      expect((await create(w, "rovara-be-bbbbbbbbbbbb", captureBody())).status).toBe(429);
    }, [sandboxContainer(), captureContainer("rovara-be-aaaaaaaaaaaa", "a".repeat(64)), captureContainer("rovara-be-cccccccccccc", "b".repeat(64))]);
  });
});

describe("browser evidence: what the worker may do with a capture container", () => {
  const withCapture = [sandboxContainer(), captureContainer()];
  it("starts, waits for, inspects and removes its own capture container, and reads its output with an attach that takes no input", async () => {
    await using({ image: EXECUTOR, seccomp: SECCOMP }, async (w) => {
      expect((await w.call("POST", `/containers/${CAPTURE}/start`)).status).toBe(200);
      expect((await w.call("POST", `/containers/${CAPTURE}/wait`)).status).toBe(200);
      expect((await w.call("GET", `/containers/${CAPTURE}/json`)).status).toBe(200);
      expect((await w.call("DELETE", `/containers/${CAPTURE}?force=1`)).status).toBe(200);
      expect((await w.upgrade(`/v1.54/containers/${CAPTURE}/attach?stream=1&stdout=1&stderr=1`)).startsWith("HTTP/1.1 101")).toBe(true);
      // The executor image may be inspected by its id and nothing else new.
      expect((await w.call("GET", `/images/${encodeURIComponent(EXECUTOR)}/json`)).status).toBe(200);
      expect((await w.call("GET", `/images/${encodeURIComponent(`sha256:${"f".repeat(64)}`)}/json`)).status).toBe(403);
    }, withCapture);
  });
  it("takes no command in it, and no attach with input; a container that is not its own is not served", async () => {
    await using({ image: EXECUTOR, seccomp: SECCOMP }, async (w) => {
      expect((await w.call("POST", `/containers/${CAPTURE}/exec`, { Cmd: ["id"], AttachStdout: true })).status).toBe(403);
      const stdin = await w.upgrade(`/v1.54/containers/${CAPTURE}/attach?stream=1&stdin=1&stdout=1`);
      expect(stdin.startsWith("HTTP/1.1 101")).toBe(false);
      expect((await w.call("POST", "/containers/not-mine/start")).status).toBe(404);
      expect((await w.upgrade("/v1.54/containers/not-mine/attach?stream=1&stdout=1")).startsWith("HTTP/1.1 101")).toBe(false);
    }, withCapture);
  });
  it("a plain guard serves none of it, even for a container that carries the capture class", async () => {
    await using(null, async (w) => {
      // A plain guard does not even know the container: it is not "this worker's" (404), and nothing about it is served.
      expect((await w.call("POST", `/containers/${CAPTURE}/exec`, { Cmd: ["id"] })).status).toBe(404);
      expect((await w.upgrade(`/v1.54/containers/${CAPTURE}/attach?stream=1&stdout=1`)).startsWith("HTTP/1.1 101")).toBe(false);
      expect((await w.call("POST", `/containers/${CAPTURE}/start`)).status).toBe(404);
    }, withCapture);
  });
});
