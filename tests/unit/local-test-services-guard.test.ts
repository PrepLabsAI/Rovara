/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment --
   the guard tests build Docker API bodies as free-form objects and change one field at a time; the shape under test is whatever an attacker sends. */
// The Docker socket guard's rules for test services (isolation/docker-socket-guard-services-source.ts), proved against a daemon that keeps state and writes down every request it is sent. Each rule has a
// request that must pass and requests that must be refused (one field changed at a time). Without `policy.services` none of it is reachable: a second block builds the guard that way and checks the old answers.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer, connect as netConnect, type Server as NetServer } from "node:net";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DOCKER_SOCKET_GUARD_SOURCE } from "../../packages/core/src/local/isolation/docker-socket-guard-source.js";
import { guardPolicy } from "../../packages/core/src/local/isolation/stack.js";

const scratch: string[] = [];
afterAll(async () => { while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true }); });

const OWNER = "a".repeat(24);
const WORKSPACE = "/home/me/.rovara/workspaces/aaaa";
const KEY = createHash("sha256").update("workspace").digest("hex").slice(0, 16);
// The run folder and the guard's own folder are real folders: the guard opens each file a service container mounts and keeps a copy of it.
const RUN_DIRECTORY = realpathSync(mkdtempSync(join(tmpdir(), "rg-run-")));
const BIND_DIRECTORY = realpathSync(mkdtempSync(join(tmpdir(), "rg-binds-")));
const SOCKET_GROUP = 4242;
const RUN_FILES: Record<string, string> = { "run1/init.sql": "select 1;\n", "run1/resolv.conf": "nameserver 172.30.7.2\n", "run1/hosts": "172.30.7.16 postgres\n", "run1/x": "x", f: "f" };
mkdirSync(join(RUN_DIRECTORY, "run1"), { recursive: true });
for (const [name, text] of Object.entries(RUN_FILES)) writeFileSync(join(RUN_DIRECTORY, name), text);
/** What the guard hands the daemon for a run file: a copy named by the digest of its bytes. */
const copyOf = (name: string): string => `${BIND_DIRECTORY}/${createHash("sha256").update(RUN_FILES[name]!).digest("hex")}`;
const NET = "rovara-svc-0123456789ab";
const CHECK = `${NET}-check`;
const POSTGRES = `registry.example:5000/rovara-catalog/local/svc/postgres@sha256:${"b".repeat(64)}`;
const GUARD_IMAGE = `sha256:${"a".repeat(64)}`;
const WORKER_IMAGE = "worker:test";
const NETWORK_ID = "n".repeat(64);
const SANDBOX_ID = "s".repeat(64);
const CHECK_ID = "k".repeat(64);
const HELPER_ID = "h".repeat(64);
const runLabels = (net = NET) => ({ "rovara.run-network": net, "rovara.run-network.created": "1700000000000", "rovara.run-network.expires": "1700003600000", "rovara.run-network.workspace": KEY });

const policy = (services: boolean, extra: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({
  upstream: "/var/run/docker.sock", owner: OWNER, image: WORKER_IMAGE, workspaceDir: WORKSPACE, workspaceKey: KEY, network: "rovara-snet-aaaa", dns: ["172.31.0.2"], user: "1000:1000", port: 2375, maxSandboxes: 16,
  ...(services ? { services: { images: [POSTGRES], guardImage: GUARD_IMAGE, runDirectory: RUN_DIRECTORY, bindDirectory: BIND_DIRECTORY, socketGroup: SOCKET_GROUP, slots: { first: 1, last: 253 }, maxNetworks: 2, maxContainers: 3, maxMemoryMiB: 3072, ...extra } } : {}),
  ...top,
});

interface FakeContainer { id: string; name: string; labels: Record<string, string>; user: string }
interface FakeNetwork { id: string; name: string; labels: Record<string, string>; subnet: string; internal: boolean; driver?: string; options?: Record<string, string> }
interface Seen { method: string; url: string; body: string }

async function fakeDaemon(state: { containers: FakeContainer[]; networks: FakeNetwork[] }) {
  const directory = await mkdtemp(join(tmpdir(), "rg-svc-"));
  scratch.push(directory);
  const socketPath = join(directory, "d.sock");
  const seen: Seen[] = [];
  const attachOpened: string[] = [];
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
          else reply("200 OK", { Id: found.id, Name: `/${found.name}`, Config: { User: found.user, Labels: found.labels } });
        } else if (method === "GET" && target.pathname === "/containers/json") {
          const filters = JSON.parse(target.searchParams.get("filters") ?? "{}") as { label?: Record<string, boolean> };
          reply("200 OK", state.containers.filter((entry) => labelMatches(entry.labels, filters.label ?? {})).map((entry) => ({ Id: entry.id, Names: [`/${entry.name}`], Labels: entry.labels })));
        } else if (method === "GET" && target.pathname === "/networks") {
          const filters = JSON.parse(target.searchParams.get("filters") ?? "{}") as { label?: Record<string, boolean> };
          reply("200 OK", state.networks.filter((entry) => labelMatches(entry.labels, filters.label ?? {})).map((entry) => ({ Id: entry.id, Name: entry.name })));
        } else if (method === "GET" && (m = /^\/networks\/([^/]+)$/.exec(target.pathname)) !== null) {
          const found = state.networks.find((entry) => entry.id === m![1] || entry.name === decodeURIComponent(m![1]!));
          if (found === undefined) reply("404 Not Found", { message: "no such network" });
          else reply("200 OK", { Id: found.id, Name: found.name, Driver: found.driver ?? "bridge", Internal: found.internal, Labels: found.labels, Options: found.options ?? { "com.docker.network.bridge.inhibit_ipv4": "true", "com.docker.network.bridge.name": "rvi01234567" }, IPAM: { Config: [{ Subnet: found.subnet }] } });
        } else if (method === "POST" && target.pathname === "/containers/create") reply("201 Created", { Id: HELPER_ID });
        else if (method === "POST" && target.pathname === "/networks/create") reply("201 Created", { Id: NETWORK_ID });
        else if (method === "POST" && /^\/containers\/[^/]+\/exec$/.test(target.pathname)) reply("201 Created", { Id: "e".repeat(64) });
        else if (method === "POST" && /^\/containers\/[^/]+\/attach$/.test(target.pathname)) {
          attachOpened.push(url);
          socket.write("HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
          socket.write("hello");
        } else reply("200 OK", {});
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { socketPath, seen, attachOpened, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const owned = (over: Partial<FakeContainer> & { name: string; id: string }): FakeContainer => ({ labels: { "rovara.local.owner": OWNER, "rovara.local.sandbox": "1" }, user: "1000:1000", ...over });
const serviceLabels = (profile: string, net = NET) => ({ "rovara.local.owner": OWNER, "rovara.local.sandbox": "service", "rovara.local.profile": profile, ...runLabels(net) });
const runNetwork = (over: Partial<FakeNetwork> = {}): FakeNetwork => ({ id: NETWORK_ID, name: NET, labels: { "rovara.local.owner": OWNER, ...runLabels() }, subnet: "172.30.7.0/24", internal: true, ...over });

async function world(services: boolean, options: { policyExtra?: Record<string, unknown>; policyTop?: Record<string, unknown>; containers?: FakeContainer[]; networks?: FakeNetwork[] } = {}) {
  const state = {
    containers: options.containers ?? [owned({ name: "agentx-task-w-1", id: SANDBOX_ID }), owned({ name: CHECK, id: CHECK_ID, labels: serviceLabels("check"), user: "1000:1000" }), owned({ name: `${NET}-h0123456789`, id: HELPER_ID, labels: serviceLabels("helper"), user: "999:999" })],
    networks: options.networks ?? [runNetwork()],
  };
  const daemon = await fakeDaemon(state);
  const directory = await mkdtemp(join(tmpdir(), "rg-prog-"));
  scratch.push(directory);
  const file = join(directory, "guard.cjs");
  await writeFile(file, DOCKER_SOCKET_GUARD_SOURCE);
  const saved = { ...process.env };
  Object.assign(process.env, { ROVARA_SOCK_POLICY: JSON.stringify({ ...policy(services, options.policyExtra, options.policyTop), upstream: daemon.socketPath }), ROVARA_SOCK_LIBRARY: "1" });
  let guard: { createServer(): Server; services: unknown };
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
  const upgrade = (path: string, extra = "", after?: string): Promise<string> => new Promise((resolve) => {
    const socket = netConnect({ host: "127.0.0.1", port }, () => { socket.write(`POST ${path} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n${extra}\r\n${after ?? ""}`); });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", () => undefined);
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
    setTimeout(() => socket.destroy(), 500);
  });
  return {
    daemon, state, call, upgrade,
    forwarded: (prefix: string): Seen[] => daemon.seen.filter((entry) => entry.method !== "GET" && entry.url.startsWith(prefix)),
    close: async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await daemon.close(); },
  };
}
type World = Awaited<ReturnType<typeof world>>;
async function using<T>(services: boolean, body: (w: World) => Promise<T>, options?: Parameters<typeof world>[1]): Promise<T> {
  const w = await world(services, options);
  try { return await body(w); } finally { await w.close(); }
}

// ---- bodies, as the docker CLI sends them for the arguments the worker builds

const hostZero = (): Record<string, any> => ({
  ContainerIDFile: "", PortBindings: {}, VolumeDriver: "", VolumesFrom: null, ConsoleSize: [0, 0], CapAdd: null, Dns: null, DnsOptions: [], DnsSearch: [], ExtraHosts: null, GroupAdd: null, IpcMode: "", Cgroup: "", Links: null,
  OomScoreAdj: 0, PidMode: "", PublishAllPorts: false, UTSMode: "", UsernsMode: "", CgroupParent: "", BlkioWeight: 0, BlkioWeightDevice: [], BlkioDeviceReadBps: [], BlkioDeviceWriteBps: [], BlkioDeviceReadIOps: [],
  BlkioDeviceWriteIOps: [], CpuPeriod: 0, CpuQuota: 0, CpuRealtimePeriod: 0, CpuRealtimeRuntime: 0, CpusetMems: "", Devices: [], DeviceCgroupRules: null, DeviceRequests: null, CpuCount: 0, CpuPercent: 0, IOMaximumIOps: 0,
  IOMaximumBandwidth: 0, Runtime: "", MaskedPaths: null, ReadonlyPaths: null, CgroupnsMode: "", Isolation: "", MemorySwappiness: -1, OomKillDisable: false, Ulimits: null, CpusetCpus: "", ShmSize: 0, CpuShares: 0, MemoryReservation: 0,
  Privileged: false, RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
});
const topZero = (): Record<string, any> => ({ Hostname: "", Domainname: "", Volumes: null, WorkingDir: "", ExposedPorts: null, Env: null });
const endpoint = (address: string, aliases?: string[]) => ({ EndpointsConfig: { [NET]: { IPAMConfig: { IPv4Address: address }, ...(aliases === undefined ? {} : { Aliases: aliases }) } } });

/** `docker run --detach ... postgres` as `service-helpers.ts` builds it. */
const helperBody = (): Record<string, any> => ({
  ...topZero(), Image: POSTGRES, User: "999:999", Cmd: ["postgres"], Entrypoint: null, Env: ["POSTGRES_PASSWORD=x"], Labels: runLabels(), AttachStdin: false, AttachStdout: false, AttachStderr: false, Tty: false, OpenStdin: false, StdinOnce: false,
  HostConfig: { ...hostZero(), NetworkMode: NET, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], ReadonlyRootfs: true, Init: true, AutoRemove: false, Memory: 512 * 1048576, MemorySwap: 512 * 1048576, NanoCpus: 1_000_000_000, PidsLimit: 256,
    Sysctls: { "net.ipv4.ip_unprivileged_port_start": "1" }, Tmpfs: { "/var/run/postgresql": "rw,nosuid,nodev,noexec,size=16m,uid=999,gid=999" }, Binds: [`${RUN_DIRECTORY}/run1/init.sql:/docker-entrypoint-initdb.d/init-1.sql:ro`],
    LogConfig: { Type: "local", Config: { "max-size": "1m", "max-file": "1", compress: "false" } } },
  NetworkingConfig: endpoint("172.30.7.16", ["postgres"]),
  StopTimeout: 1,
});
/** `docker run --rm ... node probe.js` (`hardenedProgramRun`). */
const programBody = (): Record<string, any> => ({
  ...topZero(), Image: WORKER_IMAGE, User: "1000:1000", Cmd: ["/opt/agentx/packages/worker/dist/service-probe.js", "--host", "172.30.7.16", "--port", "5432"], Entrypoint: ["/usr/local/bin/node"], Labels: runLabels(),
  AttachStdin: false, AttachStdout: true, AttachStderr: true, Tty: false, OpenStdin: false, StdinOnce: false, StopTimeout: 1,
  HostConfig: { ...hostZero(), NetworkMode: NET, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], ReadonlyRootfs: true, AutoRemove: true, Memory: 64 * 1048576, MemorySwap: 64 * 1048576, NanoCpus: 250_000_000, PidsLimit: 32, LogConfig: { Type: "none", Config: {} } },
  NetworkingConfig: { EndpointsConfig: { [NET]: {} } },
});
/** The sealed check sandbox (`checkSandboxRunArgs`). */
const checkBody = (): Record<string, any> => ({
  ...topZero(), Hostname: "check", Image: WORKER_IMAGE, User: "1000:1000", Cmd: ["--", "sleep", "infinity"], Entrypoint: ["/usr/bin/tini"], WorkingDir: WORKSPACE,
  Labels: { "agentx.task": "t-1", "agentx.workspace": KEY, ...runLabels() }, AttachStdin: false, AttachStdout: false, AttachStderr: false, Tty: false, OpenStdin: false, StdinOnce: false,
  HostConfig: { ...hostZero(), NetworkMode: NET, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], Memory: 1610612736, MemorySwap: 1610612736, NanoCpus: 1_000_000_000, PidsLimit: 4096,
    Binds: [`${WORKSPACE}:${WORKSPACE}`, `${RUN_DIRECTORY}/run1/resolv.conf:/etc/resolv.conf:ro`, `${RUN_DIRECTORY}/run1/hosts:/etc/hosts:ro`], Tmpfs: { [`${WORKSPACE}/.state`]: "ro,noexec,nosuid,size=4k" } },
  NetworkingConfig: endpoint("172.30.7.4"),
});
/** The resolver guard (`resolverGuardRunArgs`, insert step). */
const resolverBody = (): Record<string, any> => ({
  ...topZero(), Image: GUARD_IMAGE, User: "0:0", Entrypoint: ["/usr/sbin/iptables-nft"], Cmd: ["-w", "5", "-I", "OUTPUT", "1", "-d", "127.0.0.11/32", "-j", "DROP"], Labels: runLabels(), AttachStdin: false, AttachStdout: true, AttachStderr: true, Tty: false, OpenStdin: false, StdinOnce: false, StopTimeout: 1,
  HostConfig: { ...hostZero(), NetworkMode: `container:${CHECK}`, CapDrop: ["ALL"], CapAdd: ["NET_ADMIN"], SecurityOpt: ["no-new-privileges"], ReadonlyRootfs: true, AutoRemove: true, Tmpfs: { "/run": "rw,noexec,nosuid,nodev,size=1m" }, PidsLimit: 32, Memory: 64 * 1048576, MemorySwap: 64 * 1048576, NanoCpus: 500_000_000 },
  NetworkingConfig: { EndpointsConfig: {} },
});
const networkBody = (): Record<string, any> => ({
  Name: NET, Driver: "bridge", Internal: true, CheckDuplicate: true, EnableIPv6: false, Attachable: false, Ingress: false,
  IPAM: { Driver: "default", Config: [{ Subnet: "172.30.7.0/24", IPRange: "172.30.7.128/25", Gateway: "172.30.7.1" }] }, Options: { "com.docker.network.bridge.name": "rvi01234567" }, Labels: runLabels(),
});

const create = (w: World, name: string, body: unknown) => w.call("POST", `/v1.54/containers/create?name=${encodeURIComponent(name)}`, body);
const mutated = (base: () => Record<string, any>, change: (value: Record<string, any>) => void): Record<string, any> => { const value = base(); change(value); return value; };

describe("test services: the guard without `policy.services` is the plain guard", () => {
  it("builds no services section and refuses every new request as it always did", async () => {
    await using(false, async (w) => {
      expect((await w.call("POST", "/networks/create", networkBody())).status).toBe(403);
      expect((await w.call("GET", "/networks")).status).toBe(403);
      expect((await w.call("GET", `/networks/${NET}`)).status).toBe(403);
      expect((await w.call("DELETE", `/networks/${NET}`)).status).toBe(403);
      expect((await w.call("POST", `/networks/${NET}/connect`, { Container: "agentx-task-w-1", EndpointConfig: { IPAMConfig: { IPv4Address: "172.30.7.3" } } })).status).toBe(403);
      expect((await create(w, `${NET}-h0123456789`, helperBody())).status).toBe(403);
      expect((await create(w, CHECK, checkBody())).status).toBe(403);
      expect((await w.call("GET", `/images/${encodeURIComponent(POSTGRES)}/json`)).status).toBe(403);
      expect((await w.call("GET", `/containers/${HELPER_ID}/json`)).status).toBe(404);
      expect(await w.upgrade(`/containers/${SANDBOX_ID}/attach?stream=1&stdout=1`)).toMatch(/^HTTP\/1\.1 403/);
      expect(w.daemon.seen.some((entry) => entry.method !== "GET")).toBe(false);
    });
  });

  it("refuses a listing for the run's label with the sandbox filter, as before", async () => {
    await using(false, async (w) => {
      await w.call("GET", `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: { "rovara.run-network": true } }))}`);
      const sent = JSON.parse(new URL(w.daemon.seen.at(-1)!.url, "http://d").searchParams.get("filters")!) as { label: Record<string, boolean> };
      expect(Object.keys(sent.label).sort()).toEqual(["rovara.local.owner=" + OWNER, "rovara.local.sandbox=1", "rovara.run-network"].sort());
    });
  });
});

describe("test services: run networks", () => {
  it("makes a run network from exactly the worker's shape, rebuilt, with the owner label added", async () => {
    await using(true, async (w) => {
      w.state.networks.length = 0;
      const answer = await w.call("POST", "/v1.54/networks/create", networkBody());
      expect(answer.status).toBe(201);
      const sent = JSON.parse(w.forwarded("/networks/create")[0]!.body);
      expect(sent).toEqual({
        Name: NET, Driver: "bridge", Internal: true, EnableIPv6: false, Attachable: false, Ingress: false, CheckDuplicate: true,
        IPAM: { Driver: "default", Config: [{ Subnet: "172.30.7.0/24", IPRange: "172.30.7.128/25", Gateway: "172.30.7.1" }] }, Options: { "com.docker.network.bridge.name": "rvi01234567", "com.docker.network.bridge.inhibit_ipv4": "true" },
        Labels: { ...runLabels(), "rovara.local.owner": OWNER },
      });
    });
  });

  const refused: Array<[string, (value: Record<string, any>) => void]> = [
    ["another name", (v) => { v.Name = "rovara-snet-aaaa"; }],
    ["a name that is not twelve hex characters", (v) => { v.Name = "rovara-svc-xyz"; v.Labels["rovara.run-network"] = "rovara-svc-xyz"; }],
    ["a driver other than bridge", (v) => { v.Driver = "overlay"; }],
    ["a network that is not internal", (v) => { v.Internal = false; }],
    ["no internal setting", (v) => { delete v.Internal; }],
    ["IPv6", (v) => { v.EnableIPv6 = true; }],
    ["an attachable network", (v) => { v.Attachable = true; }],
    ["an ingress network", (v) => { v.Ingress = true; }],
    ["a config-only network", (v) => { v.ConfigOnly = true; }],
    ["a network taking its config from another", (v) => { v.ConfigFrom = { Network: "other" }; }],
    ["an unknown setting", (v) => { v.Something = 1; }],
    ["a subnet outside 172.30", (v) => { v.IPAM.Config[0].Subnet = "10.0.0.0/24"; }],
    ["a subnet that is not a /24", (v) => { v.IPAM.Config[0].Subnet = "172.30.7.0/16"; }],
    ["a slot outside the worker's", (v) => { v.IPAM.Config[0].Subnet = "172.30.254.0/24"; v.IPAM.Config[0].Gateway = "172.30.254.1"; v.IPAM.Config[0].IPRange = "172.30.254.128/25"; }],
    ["a gateway that is not .1", (v) => { v.IPAM.Config[0].Gateway = "172.30.7.9"; }],
    ["an ip range that is not the upper half", (v) => { v.IPAM.Config[0].IPRange = "172.30.7.0/24"; }],
    ["a second address range", (v) => { v.IPAM.Config.push({ Subnet: "172.30.8.0/24" }); }],
    ["an auxiliary address", (v) => { v.IPAM.Config[0].AuxiliaryAddresses = { a: "172.30.7.2" }; }],
    ["a custom ipam driver", (v) => { v.IPAM.Driver = "evil"; }],
    ["ipam options", (v) => { v.IPAM.Options = { a: "b" }; }],
    ["no address plan", (v) => { delete v.IPAM; }],
    ["no bridge name option", (v) => { v.Options = {}; }],
    ["a bridge name that is not rvi and eight hex", (v) => { v.Options["com.docker.network.bridge.name"] = "docker0"; }],
    ["a second option", (v) => { v.Options["com.docker.network.bridge.enable_icc"] = "true"; }],
    ["the host-address option", (v) => { v.Options = { "com.docker.network.bridge.inhibit_ipv4": "false" }; }],
    ["a missing run label", (v) => { delete v.Labels["rovara.run-network.expires"]; }],
    ["a family label for another network", (v) => { v.Labels["rovara.run-network"] = "rovara-svc-ffffffffffff"; }],
    ["another workspace's label", (v) => { v.Labels["rovara.run-network.workspace"] = "f".repeat(16); }],
    ["a time that is not a number", (v) => { v.Labels["rovara.run-network.created"] = "soon"; }],
    ["a label of its own", (v) => { v.Labels.extra = "x"; }],
    ["the owner label forged", (v) => { v.Labels["rovara.local.owner"] = "b".repeat(24); }],
    ["a body that is not JSON", () => undefined],
  ];
  for (const [what, change] of refused) {
    it(`refuses a run network with ${what}`, async () => {
      await using(true, async (w) => {
        w.state.networks.length = 0;
        const body = what === "a body that is not JSON" ? "{" : mutated(networkBody, change);
        expect((await w.call("POST", "/networks/create", body)).status).toBe(403);
        expect(w.forwarded("/networks/create")).toHaveLength(0);
      });
    });
  }

  it("refuses a query option on the create and a create past the cap", async () => {
    await using(true, async (w) => {
      expect((await w.call("POST", "/networks/create?x=1", networkBody())).status).toBe(403);
      // maxNetworks is 2: two of the worker's run networks exist.
      w.state.networks.push(runNetwork({ id: "o".repeat(64), name: "rovara-svc-0123456789ac" }));
      expect((await w.call("POST", "/networks/create", mutated(networkBody, (v) => { v.Name = "rovara-svc-0123456789ad"; v.Labels["rovara.run-network"] = "rovara-svc-0123456789ad"; }))).status).toBe(429);
      expect(w.forwarded("/networks/create")).toHaveLength(0);
    });
  });

  it("inspects, lists and removes only networks that carry the owner label and the run name, and never forwards a name it has not resolved", async () => {
    await using(true, async (w) => {
      w.state.networks.push({ ...runNetwork({ id: "x".repeat(64), name: "rovara-svc-aaaaaaaaaaaa", labels: { "rovara.local.owner": "b".repeat(24) } }) });
      w.state.networks.push({ ...runNetwork({ id: "y".repeat(64), name: "rovara-wnet-aaaa" }) });
      w.state.networks.push({ ...runNetwork({ id: "z".repeat(64), name: "rovara-svc-bbbbbbbbbbbb", internal: false }) });
      expect((await w.call("GET", `/networks/${NET}`)).status).toBe(200);
      for (const other of ["rovara-svc-aaaaaaaaaaaa", "rovara-wnet-aaaa", "rovara-svc-bbbbbbbbbbbb", "bridge", "host"]) {
        expect((await w.call("GET", `/networks/${other}`)).status, other).toBeGreaterThanOrEqual(403);
        expect((await w.call("DELETE", `/networks/${other}`)).status, other).toBeGreaterThanOrEqual(403);
      }
      expect((await w.call("DELETE", `/networks/${NET}`)).status).toBe(200);
      expect(w.forwarded("/networks/").map((entry) => `${entry.method} ${entry.url}`)).toEqual([`DELETE /networks/${NETWORK_ID}`]);
      await w.call("GET", `/networks?filters=${encodeURIComponent(JSON.stringify({ label: { "rovara.run-network": true } }))}`);
      const sent = JSON.parse(new URL(w.daemon.seen.at(-1)!.url, "http://d").searchParams.get("filters")!) as { label: Record<string, boolean>; name: Record<string, boolean> };
      expect(Object.keys(sent.label)).toContain(`rovara.local.owner=${OWNER}`);
      expect(Object.keys(sent.name)).toEqual(["rovara-svc-"]);
    });
  });

  it("connects and disconnects a container of the worker's own to a run network with one address in the run's range, rebuilt", async () => {
    await using(true, async (w) => {
      const connect = { Container: "agentx-task-w-1", EndpointConfig: { IPAMConfig: { IPv4Address: "172.30.7.3" }, Links: null, Aliases: null } };
      expect((await w.call("POST", `/networks/${NET}/connect`, connect)).status).toBe(200);
      expect(JSON.parse(w.forwarded(`/networks/${NETWORK_ID}/connect`)[0]!.body)).toEqual({ Container: SANDBOX_ID, EndpointConfig: { IPAMConfig: { IPv4Address: "172.30.7.3" } } });
      expect((await w.call("POST", `/networks/${NET}/disconnect`, { Container: "agentx-task-w-1", Force: true })).status).toBe(200);
      expect(JSON.parse(w.forwarded(`/networks/${NETWORK_ID}/disconnect`)[0]!.body)).toEqual({ Container: SANDBOX_ID, Force: true });
    });
  });

  const badConnects: Array<[string, Record<string, any>]> = [
    ["the gateway's address", { Container: "agentx-task-w-1", EndpointConfig: { IPAMConfig: { IPv4Address: "172.30.7.1" } } }],
    ["an address past the reserved ones", { Container: "agentx-task-w-1", EndpointConfig: { IPAMConfig: { IPv4Address: "172.30.7.48" } } }],
    ["another slot's address", { Container: "agentx-task-w-1", EndpointConfig: { IPAMConfig: { IPv4Address: "172.30.8.3" } } }],
    ["an address that is not an address", { Container: "agentx-task-w-1", EndpointConfig: { IPAMConfig: { IPv4Address: "172.30.7.03" } } }],
    ["no address", { Container: "agentx-task-w-1", EndpointConfig: {} }],
    ["an alias", { Container: "agentx-task-w-1", EndpointConfig: { IPAMConfig: { IPv4Address: "172.30.7.3" }, Aliases: ["rovara-sock"] } }],
    ["a link", { Container: "agentx-task-w-1", EndpointConfig: { IPAMConfig: { IPv4Address: "172.30.7.3" }, Links: ["x:y"] } }],
    ["driver options", { Container: "agentx-task-w-1", EndpointConfig: { IPAMConfig: { IPv4Address: "172.30.7.3" }, DriverOpts: { a: "b" } } }],
    ["another setting", { Container: "agentx-task-w-1", Extra: 1, EndpointConfig: { IPAMConfig: { IPv4Address: "172.30.7.3" } } }],
  ];
  for (const [what, body] of badConnects) {
    it(`refuses a connect with ${what}`, async () => {
      await using(true, async (w) => {
        expect((await w.call("POST", `/networks/${NET}/connect`, body)).status).toBe(403);
        expect(w.forwarded("/networks/")).toHaveLength(0);
      });
    });
  }

  it("refuses to connect a container that is not the worker's, or to a network that is not", async () => {
    await using(true, async (w) => {
      w.state.containers.push(owned({ name: "someone-else", id: "q".repeat(64), labels: { "rovara.local.owner": "b".repeat(24), "rovara.local.sandbox": "1" } }));
      const body = (container: string) => ({ Container: container, EndpointConfig: { IPAMConfig: { IPv4Address: "172.30.7.3" } } });
      expect((await w.call("POST", `/networks/${NET}/connect`, body("someone-else"))).status).toBe(404);
      expect((await w.call("POST", `/networks/${NET}/connect`, body("rovara-worker-aaaa"))).status).toBe(404);
      expect((await w.call("POST", "/networks/bridge/connect", body("agentx-task-w-1"))).status).toBe(404);
      expect((await w.call("POST", "/networks/rovara-snet-aaaa/connect", body("agentx-task-w-1"))).status).toBe(404);
      expect(w.forwarded("/networks/")).toHaveLength(0);
    });
  });
});

describe("test services: service containers", () => {
  it("starts a catalog helper from a pinned image on the run network, rebuilt with the guard's own labels", async () => {
    await using(true, async (w) => {
      expect((await create(w, `${NET}-h0123456789`, helperBody())).status).toBe(201);
      const sent = JSON.parse(w.forwarded("/containers/create")[0]!.body);
      expect(sent.Image).toBe(POSTGRES);
      expect(sent.User).toBe("999:999");
      expect(sent.Labels).toEqual({ ...runLabels(), "rovara.local.owner": OWNER, "rovara.local.sandbox": "service", "rovara.local.profile": "helper", "rovara.local.memory": expect.any(String) });
      expect(sent.HostConfig.CapDrop).toEqual(["ALL"]);
      expect(sent.HostConfig.Privileged).toBe(false);
      expect(sent.HostConfig.NetworkMode).toBe(NET);
      expect(sent.HostConfig.PortBindings).toBeUndefined();
      expect(sent.HostConfig.Binds).toEqual([`${copyOf("run1/init.sql")}:/docker-entrypoint-initdb.d/init-1.sql:ro`]);
      expect(sent.HostConfig.Tmpfs).toEqual({ "/var/run/postgresql": "rw,nosuid,nodev,noexec,size=16m,uid=999,gid=999" });
      expect(sent.HostConfig.Sysctls).toEqual({ "net.ipv6.conf.all.disable_ipv6": "1", "net.ipv4.ip_unprivileged_port_start": "1" });
      expect(sent.NetworkingConfig).toEqual({ EndpointsConfig: { [NET]: { IPAMConfig: { IPv4Address: "172.30.7.16" }, Aliases: ["postgres"] } } });
    });
  });

  it("starts a probe, a control call, a fake server or the name server from the worker's own image, by a program file of that image", async () => {
    await using(true, async (w) => {
      expect((await create(w, `${NET}-p0123456789`, programBody())).status).toBe(201);
      expect((await create(w, `${NET}-h0123456789-cabcdef01`, programBody())).status).toBe(201);
      const dns = mutated(programBody, (v) => { v.Cmd[0] = "/opt/agentx/packages/worker/dist/sealed-dns-helper.js"; v.NetworkingConfig = endpoint("172.30.7.2"); v.HostConfig.Tmpfs = { "/state": "rw,noexec,nosuid,size=1m,uid=1000,gid=1000" }; v.HostConfig.Sysctls = { "net.ipv4.ip_unprivileged_port_start": "53" }; });
      expect((await create(w, `${NET}-dns`, dns)).status).toBe(201);
      const sent = JSON.parse(w.forwarded("/containers/create").at(-1)!.body);
      expect(sent.Entrypoint).toEqual(["/usr/local/bin/node"]);
      expect(sent.HostConfig.Tmpfs).toEqual({ "/state": "rw,nosuid,nodev,noexec,size=1m,uid=1000,gid=1000" });
      expect(sent.Labels["rovara.local.profile"]).toBe("program");
    });
  });

  it("starts the sealed check sandbox as a task sandbox on the run network alone, with the two read-only files and the fixed hostname", async () => {
    await using(true, async (w) => {
      expect((await create(w, CHECK, checkBody())).status).toBe(201);
      const sent = JSON.parse(w.forwarded("/containers/create")[0]!.body);
      expect(sent.Hostname).toBe("check");
      expect(sent.HostConfig.NetworkMode).toBe(NET);
      expect(sent.HostConfig.Dns).toEqual([]);
      expect(sent.HostConfig.Binds).toEqual([`${WORKSPACE}:${WORKSPACE}`, `${copyOf("run1/resolv.conf")}:/etc/resolv.conf:ro`, `${copyOf("run1/hosts")}:/etc/hosts:ro`]);
      expect(sent.NetworkingConfig).toEqual({ EndpointsConfig: { [NET]: { IPAMConfig: { IPv4Address: "172.30.7.4" } } } });
      expect(sent.Labels["rovara.local.sandbox"]).toBe("service");
      expect(sent.Labels["rovara.local.profile"]).toBe("check");
      expect(sent.Labels["rovara.run-network"]).toBe(NET);
    });
  });

  it("refuses a tmpfs size the guard cannot read, rather than dropping it", async () => {
    await using(true, async (w) => {
      for (const size of ["size=2g", "size=2048k", "size=", "size=1e3m"]) {
        expect((await create(w, `${NET}-h0123456789`, mutated(helperBody, (v) => { v.HostConfig.Tmpfs = { "/var/run/postgresql": `rw,nosuid,nodev,noexec,${size}` }; }))).status, size).toBe(403);
      }
      expect(w.forwarded("/containers/create")).toHaveLength(0);
      expect((await create(w, `${NET}-h0123456789`, mutated(helperBody, (v) => { v.HostConfig.Tmpfs = { "/var/run/postgresql": "rw,nosuid,nodev,noexec,size=16m" }; }))).status).toBe(201);
    });
  });

  it("turns IPv6 off in every service container and the sealed check sandbox, whatever the worker sent, and takes no other way to name it", async () => {
    const off = { "net.ipv6.conf.all.disable_ipv6": "1" };
    await using(true, async (w) => {
      expect((await create(w, `${NET}-h0123456789`, mutated(helperBody, (v) => { delete v.HostConfig.Sysctls; }))).status).toBe(201);
      expect(JSON.parse(w.forwarded("/containers/create").at(-1)!.body).HostConfig.Sysctls).toEqual(off);
      expect((await create(w, `${NET}-p0123456789`, mutated(programBody, (v) => { delete v.HostConfig.Sysctls; }))).status).toBe(201);
      expect(JSON.parse(w.forwarded("/containers/create").at(-1)!.body).HostConfig.Sysctls).toEqual(off);
      expect((await create(w, CHECK, checkBody())).status).toBe(201);
      expect(JSON.parse(w.forwarded("/containers/create").at(-1)!.body).HostConfig.Sysctls).toEqual(off);
      // The worker naming the setting itself (on or off) is a sysctl that is not the one it may choose.
      for (const value of ["0", "1"]) expect((await create(w, `${NET}-h0123456789`, mutated(helperBody, (v) => { v.HostConfig.Sysctls = { "net.ipv6.conf.all.disable_ipv6": value }; }))).status).toBe(403);
    });
  });

  it("takes the capability spelled the way the docker CLI sends it (CAP_NET_ADMIN) and forwards it spelled one way", async () => {
    await using(true, async (w) => {
      expect((await create(w, `${CHECK}-guard`, mutated(resolverBody, (v) => { v.HostConfig.CapAdd = ["CAP_NET_ADMIN"]; }))).status).toBe(201);
      expect(JSON.parse(w.forwarded("/containers/create")[0]!.body).HostConfig.CapAdd).toEqual(["NET_ADMIN"]);
    });
  });

  it("starts the resolver guard exactly as the worker builds it, for the worker's own check sandbox, and no other command", async () => {
    await using(true, async (w) => {
      expect((await create(w, `${CHECK}-guard`, resolverBody())).status).toBe(201);
      const verify = mutated(resolverBody, (v) => { v.Cmd = ["-w", "5", "-C", "OUTPUT", "-d", "127.0.0.11/32", "-j", "DROP"]; });
      expect((await create(w, `${CHECK}-guard-check`, verify)).status).toBe(201);
      const sent = JSON.parse(w.forwarded("/containers/create")[0]!.body);
      expect(sent.User).toBe("0:0");
      expect(sent.HostConfig.CapAdd).toEqual(["NET_ADMIN"]);
      expect(sent.HostConfig.NetworkMode).toBe(`container:${CHECK}`);
      expect(sent.Labels["rovara.local.profile"]).toBe("resolver");
    });
  });

  type Case = [string, string, () => Record<string, any>, (value: Record<string, any>) => void];
  const helperName = `${NET}-h0123456789`;
  const everything: Case[] = [
    // all profiles
    ["a helper: another image", helperName, helperBody, (v) => { v.Image = "alpine:3.20"; }],
    ["a helper: the same repository by a tag", helperName, helperBody, (v) => { v.Image = POSTGRES.replace(/@sha256:.*$/u, ":16"); }],
    ["a helper: the image with another digest", helperName, helperBody, (v) => { v.Image = POSTGRES.replace("b".repeat(64), "c".repeat(64)); }],
    ["a helper: root", helperName, helperBody, (v) => { v.User = "0:0"; }],
    ["a helper: a named user", helperName, helperBody, (v) => { v.User = "postgres"; }],
    ["a helper: no user", helperName, helperBody, (v) => { v.User = ""; }],
    ["a helper: uid 0 with another gid", helperName, helperBody, (v) => { v.User = "0:999"; }],
    ["a helper: its own entrypoint", helperName, helperBody, (v) => { v.Entrypoint = ["/bin/sh"]; }],
    ["a helper: a name that is not one of the run's", `${NET}-evil`, helperBody, () => undefined],
    ["a helper: a privileged container", helperName, helperBody, (v) => { v.HostConfig.Privileged = true; }],
    ["a helper: an added capability", helperName, helperBody, (v) => { v.HostConfig.CapAdd = ["NET_ADMIN"]; }],
    ["a helper: capabilities not dropped", helperName, helperBody, (v) => { v.HostConfig.CapDrop = null; }],
    ["a helper: only some capabilities dropped", helperName, helperBody, (v) => { v.HostConfig.CapDrop = ["NET_RAW"]; }],
    ["a helper: unconfined seccomp", helperName, helperBody, (v) => { v.HostConfig.SecurityOpt.push("seccomp=unconfined"); }],
    ["a helper: no security option", helperName, helperBody, (v) => { v.HostConfig.SecurityOpt = null; }],
    ["a helper: the host network", helperName, helperBody, (v) => { v.HostConfig.NetworkMode = "host"; }],
    ["a helper: the sandbox network", helperName, helperBody, (v) => { v.HostConfig.NetworkMode = "rovara-snet-aaaa"; }],
    ["a helper: another run network", helperName, helperBody, (v) => { v.HostConfig.NetworkMode = "rovara-svc-ffffffffffff"; }],
    ["a helper: a container network", helperName, helperBody, (v) => { v.HostConfig.NetworkMode = `container:${CHECK}`; }],
    ["a helper: a published port", helperName, helperBody, (v) => { v.HostConfig.PortBindings = { "5432/tcp": [{ HostPort: "5432" }] }; }],
    ["a helper: every port published", helperName, helperBody, (v) => { v.HostConfig.PublishAllPorts = true; }],
    ["a helper: an exposed port", helperName, helperBody, (v) => { v.ExposedPorts = { "5432/tcp": {} }; }],
    ["a helper: a read-write bind", helperName, helperBody, (v) => { v.HostConfig.Binds = [`${RUN_DIRECTORY}/run1/init.sql:/x:rw`]; }],
    ["a helper: a bind with no mode", helperName, helperBody, (v) => { v.HostConfig.Binds = [`${RUN_DIRECTORY}/run1/init.sql:/x`]; }],
    ["a helper: a bind outside the run folder", helperName, helperBody, (v) => { v.HostConfig.Binds = ["/etc:/x:ro"]; }],
    ["a helper: a bind of the workspace", helperName, helperBody, (v) => { v.HostConfig.Binds = [`${WORKSPACE}:${WORKSPACE}:ro`]; }],
    ["a helper: a bind of the Docker socket", helperName, helperBody, (v) => { v.HostConfig.Binds = ["/var/run/docker.sock:/var/run/docker.sock:ro"]; }],
    ["a helper: a bind that climbs out of the run folder", helperName, helperBody, (v) => { v.HostConfig.Binds = [`${RUN_DIRECTORY}/../x:/x:ro`]; }],
    ["a helper: the run folder's prefix as another folder", helperName, helperBody, (v) => { v.HostConfig.Binds = [`${RUN_DIRECTORY}x/f:/x:ro`]; }],
    ["a helper: a bind over /proc", helperName, helperBody, (v) => { v.HostConfig.Binds = [`${RUN_DIRECTORY}/f:/proc/sys:ro`]; }],
    ["a helper: a bind over /run", helperName, helperBody, (v) => { v.HostConfig.Binds = [`${RUN_DIRECTORY}/f:/run/docker.sock:ro`]; }],
    ["a helper: a mount", helperName, helperBody, (v) => { v.HostConfig.Mounts = [{ Type: "bind", Source: "/", Target: "/h" }]; }],
    ["a helper: a volume", helperName, helperBody, (v) => { v.Volumes = { "/data": {} }; }],
    ["a helper: a tmpfs over /proc", helperName, helperBody, (v) => { v.HostConfig.Tmpfs = { "/proc/x": "rw" }; }],
    ["a helper: a tmpfs with a path that climbs out", helperName, helperBody, (v) => { v.HostConfig.Tmpfs = { "/a/../etc": "rw" }; }],
    ["a helper: tmpfs options that smuggle a flag", helperName, helperBody, (v) => { v.HostConfig.Tmpfs = { "/tmp": "rw;--privileged" }; }],
    ["a helper: a sysctl other than the port one", helperName, helperBody, (v) => { v.HostConfig.Sysctls = { "net.ipv4.ip_forward": "1" }; }],
    ["a helper: the port sysctl above 1023", helperName, helperBody, (v) => { v.HostConfig.Sysctls = { "net.ipv4.ip_unprivileged_port_start": "2000" }; }],
    ["a helper: two sysctls", helperName, helperBody, (v) => { v.HostConfig.Sysctls = { "net.ipv4.ip_unprivileged_port_start": "1", "kernel.msgmax": "1" }; }],
    ["a helper: more memory than the ceiling", helperName, helperBody, (v) => { v.HostConfig.Memory = 8 * 1024 ** 3; v.HostConfig.MemorySwap = 8 * 1024 ** 3; }],
    ["a helper: no memory limit", helperName, helperBody, (v) => { v.HostConfig.Memory = 0; v.HostConfig.MemorySwap = 0; }],
    ["a helper: swap above memory", helperName, helperBody, (v) => { v.HostConfig.MemorySwap = 1024 * 1048576; }],
    ["a helper: no CPU limit", helperName, helperBody, (v) => { v.HostConfig.NanoCpus = 0; }],
    ["a helper: more CPUs than the ceiling", helperName, helperBody, (v) => { v.HostConfig.NanoCpus = 64_000_000_000; }],
    ["a helper: no process limit", helperName, helperBody, (v) => { v.HostConfig.PidsLimit = 0; }],
    ["a helper: an absurd process limit", helperName, helperBody, (v) => { v.HostConfig.PidsLimit = 1_000_000; }],
    ["a helper: the host pid namespace", helperName, helperBody, (v) => { v.HostConfig.PidMode = "host"; }],
    ["a helper: the host ipc namespace", helperName, helperBody, (v) => { v.HostConfig.IpcMode = "host"; }],
    ["a helper: a device", helperName, helperBody, (v) => { v.HostConfig.Devices = [{ PathOnHost: "/dev/kmsg", PathInContainer: "/dev/kmsg", CgroupPermissions: "rwm" }]; }],
    ["a helper: its own name servers", helperName, helperBody, (v) => { v.HostConfig.Dns = ["8.8.8.8"]; }],
    ["a helper: extra hosts", helperName, helperBody, (v) => { v.HostConfig.ExtraHosts = ["evil:10.0.0.1"]; }],
    ["a helper: a link", helperName, helperBody, (v) => { v.HostConfig.Links = ["other:x"]; }],
    ["a helper: volumes from another container", helperName, helperBody, (v) => { v.HostConfig.VolumesFrom = ["other"]; }],
    ["a helper: a restart policy", helperName, helperBody, (v) => { v.HostConfig.RestartPolicy = { Name: "always" }; }],
    ["a helper: a remote log driver", helperName, helperBody, (v) => { v.HostConfig.LogConfig = { Type: "syslog", Config: { "syslog-address": "tcp://10.0.0.1" } }; }],
    ["a helper: a log option of its own", helperName, helperBody, (v) => { v.HostConfig.LogConfig.Config["syslog-address"] = "x"; }],
    ["a helper: masked paths cleared", helperName, helperBody, (v) => { v.HostConfig.MaskedPaths = []; }],
    ["a helper: a hostname", helperName, helperBody, (v) => { v.Hostname = "evil"; }],
    ["a helper: a working folder", helperName, helperBody, (v) => { v.WorkingDir = "/"; }],
    ["a helper: input", helperName, helperBody, (v) => { v.OpenStdin = true; }],
    ["a helper: a terminal", helperName, helperBody, (v) => { v.Tty = true; }],
    ["a helper: an unknown setting", helperName, helperBody, (v) => { v.Something = 1; }],
    ["a helper: an unknown host setting", helperName, helperBody, (v) => { v.HostConfig.Something = 1; }],
    ["a helper: a label of its own", helperName, helperBody, (v) => { v.Labels.extra = "x"; }],
    ["a helper: the owner label forged", helperName, helperBody, (v) => { v.Labels["rovara.local.owner"] = "b".repeat(24); }],
    ["a helper: a missing run label", helperName, helperBody, (v) => { delete v.Labels["rovara.run-network"]; }],
    ["a helper: another workspace's label", helperName, helperBody, (v) => { v.Labels["rovara.run-network.workspace"] = "f".repeat(16); }],
    ["a helper: a label naming another network", helperName, helperBody, (v) => { v.Labels["rovara.run-network"] = "rovara-svc-ffffffffffff"; }],
    ["a helper: two endpoints", helperName, helperBody, (v) => { v.NetworkingConfig.EndpointsConfig["rovara-snet-aaaa"] = {}; }],
    ["a helper: an endpoint on another network", helperName, helperBody, (v) => { v.NetworkingConfig = { EndpointsConfig: { "rovara-snet-aaaa": {} } }; }],
    ["a helper: an address outside the run's range", helperName, helperBody, (v) => { v.NetworkingConfig.EndpointsConfig[NET].IPAMConfig.IPv4Address = "10.0.0.5"; }],
    ["a helper: an address past the reserved ones", helperName, helperBody, (v) => { v.NetworkingConfig.EndpointsConfig[NET].IPAMConfig.IPv4Address = "172.30.7.200"; }],
    ["a helper: no address", helperName, helperBody, (v) => { v.NetworkingConfig.EndpointsConfig[NET] = {}; }],
    ["a helper: an alias that is not a short name", helperName, helperBody, (v) => { v.NetworkingConfig.EndpointsConfig[NET].Aliases = ["rovara-sock.evil"]; }],
    ["a helper: too many aliases", helperName, helperBody, (v) => { v.NetworkingConfig.EndpointsConfig[NET].Aliases = Array.from({ length: 9 }, (_, i) => `a${String(i)}x`); }],
    ["a helper: a missing run network", `rovara-svc-ffffffffffff-h0123456789`, helperBody, (v) => { v.HostConfig.NetworkMode = "rovara-svc-ffffffffffff"; v.Labels = runLabels("rovara-svc-ffffffffffff"); v.NetworkingConfig = { EndpointsConfig: { "rovara-svc-ffffffffffff": { IPAMConfig: { IPv4Address: "172.30.7.16" } } } }; }],
    // worker programs
    ["a program: another image", `${NET}-p0123456789`, programBody, (v) => { v.Image = "alpine:3.20"; }],
    ["a program: root", `${NET}-p0123456789`, programBody, (v) => { v.User = "0:0"; }],
    ["a program: another user", `${NET}-p0123456789`, programBody, (v) => { v.User = "999:999"; }],
    ["a program: a shell", `${NET}-p0123456789`, programBody, (v) => { v.Entrypoint = ["/bin/sh"]; }],
    ["a program: no entrypoint", `${NET}-p0123456789`, programBody, (v) => { v.Entrypoint = null; }],
    ["a program: node with -e", `${NET}-p0123456789`, programBody, (v) => { v.Cmd = ["-e", "require('child_process').exec('id')"]; }],
    ["a program: node with --eval", `${NET}-p0123456789`, programBody, (v) => { v.Cmd = ["--eval", "1"]; }],
    ["a program: a file outside the worker image's program folder", `${NET}-p0123456789`, programBody, (v) => { v.Cmd = ["/tmp/x.js"]; }],
    ["a program: a program path that climbs", `${NET}-p0123456789`, programBody, (v) => { v.Cmd = ["/opt/agentx/packages/worker/dist/../../x.js"]; }],
    ["a program: a writable root", `${NET}-p0123456789`, programBody, (v) => { v.HostConfig.ReadonlyRootfs = false; }],
    ["a program: more memory than a program may have", `${NET}-p0123456789`, programBody, (v) => { v.HostConfig.Memory = 2 * 1024 ** 3; v.HostConfig.MemorySwap = 2 * 1024 ** 3; }],
    ["a program: a bind outside the run folder", `${NET}-p0123456789`, programBody, (v) => { v.HostConfig.Binds = ["/home/me:/x:ro"]; }],
    // the sealed check sandbox
    ["the check sandbox: another image", CHECK, checkBody, (v) => { v.Image = "alpine:3.20"; }],
    ["the check sandbox: root", CHECK, checkBody, (v) => { v.User = "0:0"; }],
    ["the check sandbox: the sandbox network", CHECK, checkBody, (v) => { v.HostConfig.NetworkMode = "rovara-snet-aaaa"; }],
    ["the check sandbox: the host network", CHECK, checkBody, (v) => { v.HostConfig.NetworkMode = "host"; }],
    ["the check sandbox: another run network", CHECK, checkBody, (v) => { v.HostConfig.NetworkMode = "rovara-svc-ffffffffffff"; }],
    ["the check sandbox: two endpoints", CHECK, checkBody, (v) => { v.NetworkingConfig.EndpointsConfig["rovara-snet-aaaa"] = {}; }],
    ["the check sandbox: its own name server", CHECK, checkBody, (v) => { v.HostConfig.Dns = ["8.8.8.8"]; }],
    ["the check sandbox: another hostname", CHECK, checkBody, (v) => { v.Hostname = "evil"; }],
    ["the check sandbox: an alias", CHECK, checkBody, (v) => { v.NetworkingConfig.EndpointsConfig[NET].Aliases = ["postgres"]; }],
    ["the check sandbox: a third read-only mount", CHECK, checkBody, (v) => { v.HostConfig.Binds.push(`${RUN_DIRECTORY}/run1/x:/etc/passwd:ro`); }],
    ["the check sandbox: a writable mount of the run folder", CHECK, checkBody, (v) => { v.HostConfig.Binds[1] = `${RUN_DIRECTORY}/run1/resolv.conf:/etc/resolv.conf`; }],
    ["the check sandbox: a mount from outside the run folder", CHECK, checkBody, (v) => { v.HostConfig.Binds[1] = "/etc/passwd:/etc/resolv.conf:ro"; }],
    ["the check sandbox: the run folder over another target", CHECK, checkBody, (v) => { v.HostConfig.Binds[1] = `${RUN_DIRECTORY}/run1/resolv.conf:/etc/shadow:ro`; }],
    ["the check sandbox: an added capability", CHECK, checkBody, (v) => { v.HostConfig.CapAdd = ["NET_ADMIN"]; }],
    ["the check sandbox: a privileged container", CHECK, checkBody, (v) => { v.HostConfig.Privileged = true; }],
    ["the check sandbox: another workspace", CHECK, checkBody, (v) => { v.Labels["agentx.workspace"] = "f".repeat(16); }],
    ["the check sandbox: another name", `${NET}-checkx`, checkBody, () => undefined],
    // the resolver guard
    ["the resolver guard: the sandbox image (not pinned)", `${CHECK}-guard`, resolverBody, (v) => { v.Image = WORKER_IMAGE; }],
    ["the resolver guard: another pinned image", `${CHECK}-guard`, resolverBody, (v) => { v.Image = `sha256:${"c".repeat(64)}`; }],
    ["the resolver guard: a catalog image", `${CHECK}-guard`, resolverBody, (v) => { v.Image = POSTGRES; }],
    ["the resolver guard: a shell", `${CHECK}-guard`, resolverBody, (v) => { v.Entrypoint = ["/bin/sh"]; v.Cmd = ["-c", "id"]; }],
    ["the resolver guard: another program", `${CHECK}-guard`, resolverBody, (v) => { v.Entrypoint = ["/usr/sbin/iptables"]; }],
    ["the resolver guard: another rule", `${CHECK}-guard`, resolverBody, (v) => { v.Cmd = ["-w", "5", "-F"]; }],
    ["the resolver guard: the verify command under the insert name", `${CHECK}-guard`, resolverBody, (v) => { v.Cmd = ["-w", "5", "-C", "OUTPUT", "-d", "127.0.0.11/32", "-j", "DROP"]; }],
    ["the resolver guard: the same rule with one word changed", `${CHECK}-guard`, resolverBody, (v) => { v.Cmd[v.Cmd.length - 1] = "ACCEPT"; }],
    ["the resolver guard: the rule aimed at another address", `${CHECK}-guard`, resolverBody, (v) => { v.Cmd[6] = "10.0.0.1/32"; }],
    ["the resolver guard: a rule with a word added", `${CHECK}-guard`, resolverBody, (v) => { v.Cmd.push("-j", "ACCEPT"); }],
    ["the resolver guard: a user other than root", `${CHECK}-guard`, resolverBody, (v) => { v.User = "1000:1000"; }],
    ["the resolver guard: a second capability spelled with the prefix", `${CHECK}-guard`, resolverBody, (v) => { v.HostConfig.CapAdd = ["CAP_NET_ADMIN", "CAP_SYS_ADMIN"]; }],
    ["the resolver guard: another capability spelled with the prefix", `${CHECK}-guard`, resolverBody, (v) => { v.HostConfig.CapAdd = ["CAP_SYS_ADMIN"]; }],
    ["the resolver guard: a name that only ends in NET_ADMIN", `${CHECK}-guard`, resolverBody, (v) => { v.HostConfig.CapAdd = ["XNET_ADMIN"]; }],
    ["the resolver guard: a second capability", `${CHECK}-guard`, resolverBody, (v) => { v.HostConfig.CapAdd = ["NET_ADMIN", "SYS_ADMIN"]; }],
    ["the resolver guard: another capability", `${CHECK}-guard`, resolverBody, (v) => { v.HostConfig.CapAdd = ["SYS_ADMIN"]; }],
    ["the resolver guard: no capability", `${CHECK}-guard`, resolverBody, (v) => { v.HostConfig.CapAdd = null; }],
    ["the resolver guard: privileged", `${CHECK}-guard`, resolverBody, (v) => { v.HostConfig.Privileged = true; }],
    ["the resolver guard: capabilities not dropped", `${CHECK}-guard`, resolverBody, (v) => { v.HostConfig.CapDrop = []; }],
    ["the resolver guard: another network namespace", `${CHECK}-guard`, resolverBody, (v) => { v.HostConfig.NetworkMode = `container:${NET}-h0123456789`; }],
    ["the resolver guard: the host network", `${CHECK}-guard`, resolverBody, (v) => { v.HostConfig.NetworkMode = "host"; }],
    ["the resolver guard: a network namespace of a task sandbox", `${CHECK}-guard`, resolverBody, (v) => { v.HostConfig.NetworkMode = "container:agentx-task-w-1"; }],
    ["the resolver guard: an endpoint of its own", `${CHECK}-guard`, resolverBody, (v) => { v.NetworkingConfig = endpoint("172.30.7.9"); }],
    ["the resolver guard: a mount", `${CHECK}-guard`, resolverBody, (v) => { v.HostConfig.Binds = [`${RUN_DIRECTORY}/f:/x:ro`]; }],
    ["the resolver guard: a writable root", `${CHECK}-guard`, resolverBody, (v) => { v.HostConfig.ReadonlyRootfs = false; }],
    ["the resolver guard: a bigger tmpfs", `${CHECK}-guard`, resolverBody, (v) => { v.HostConfig.Tmpfs = { "/run": "rw,noexec,nosuid,nodev,size=900m" }; }],
    ["the resolver guard: a second tmpfs", `${CHECK}-guard`, resolverBody, (v) => { v.HostConfig.Tmpfs["/x"] = "rw"; }],
    ["the resolver guard: more memory", `${CHECK}-guard`, resolverBody, (v) => { v.HostConfig.Memory = 1024 * 1048576; v.HostConfig.MemorySwap = 1024 * 1048576; }],
    ["the resolver guard: more processes", `${CHECK}-guard`, resolverBody, (v) => { v.HostConfig.PidsLimit = 4096; }],
    ["the resolver guard: more CPU", `${CHECK}-guard`, resolverBody, (v) => { v.HostConfig.NanoCpus = 4_000_000_000; }],
    ["the resolver guard: an environment", `${CHECK}-guard`, resolverBody, (v) => { v.Env = ["LD_PRELOAD=/x"]; }],
    ["the resolver guard: a sysctl", `${CHECK}-guard`, resolverBody, (v) => { v.HostConfig.Sysctls = { "net.ipv4.ip_forward": "1" }; }],
    ["the resolver guard: not removed when it ends", `${CHECK}-guard`, resolverBody, (v) => { v.HostConfig.AutoRemove = false; }],
    ["the resolver guard: a run label missing", `${CHECK}-guard`, resolverBody, (v) => { delete v.Labels["rovara.run-network.created"]; }],
    ["the resolver guard: for a check sandbox that does not exist", `rovara-svc-ffffffffffff-check-guard`, resolverBody, (v) => { v.HostConfig.NetworkMode = "container:rovara-svc-ffffffffffff-check"; v.Labels = runLabels("rovara-svc-ffffffffffff"); }],
  ];
  for (const [what, name, base, change] of everything) {
    it(`refuses ${what}`, async () => {
      await using(true, async (w) => {
        const body = what.endsWith("a name that is not one of the run's") || what.endsWith("another name") ? base() : mutated(base, change);
        const answer = await create(w, name, body);
        expect(answer.status, answer.text).toBeGreaterThanOrEqual(403);
        expect(w.forwarded("/containers/create")).toHaveLength(0);
      });
    });
  }

  it("refuses a resolver guard when the check sandbox is not a check sandbox of this worker (another owner, a plain sandbox, a helper)", async () => {
    for (const swapped of [{ labels: { ...serviceLabels("check"), "rovara.local.owner": "b".repeat(24) } }, { labels: { "rovara.local.owner": OWNER, "rovara.local.sandbox": "1" } }, { labels: serviceLabels("helper") }]) {
      await using(true, async (w) => {
        w.state.containers.find((entry) => entry.name === CHECK)!.labels = swapped.labels;
        expect((await create(w, `${CHECK}-guard`, resolverBody())).status).toBeGreaterThanOrEqual(403);
        expect(w.forwarded("/containers/create")).toHaveLength(0);
      });
    }
  });

  it("refuses a query option on the create, and a create past the cap (counted from the daemon, one at a time)", async () => {
    await using(true, async (w) => {
      expect((await w.call("POST", `/containers/create?name=${helperName}&platform=linux/arm64`, helperBody())).status).toBe(403);
      // maxContainers is 3 and three service containers (the check sandbox, a helper and one more) exist.
      w.state.containers.push(owned({ name: `${NET}-h0000000001`, id: "1".repeat(64), labels: serviceLabels("helper") }));
      expect((await create(w, `${NET}-h0000000002`, mutated(helperBody, () => undefined))).status).toBe(429);
      expect(w.forwarded("/containers/create")).toHaveLength(0);
    });
  });

  it("keeps a task sandbox creatable exactly as before, with services on", async () => {
    await using(true, async (w) => {
      const sandbox = { ...topZero(), Image: WORKER_IMAGE, User: "1000:1000", Cmd: ["--", "sleep", "infinity"], Entrypoint: ["/usr/bin/tini"], WorkingDir: WORKSPACE, Labels: { "agentx.task": "t", "agentx.workspace": KEY },
        HostConfig: { ...hostZero(), NetworkMode: "rovara-snet-aaaa", CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], Binds: [`${WORKSPACE}:${WORKSPACE}`], Memory: 1073741824, MemorySwap: 1073741824, PidsLimit: 4096 }, NetworkingConfig: { EndpointsConfig: {} } };
      expect((await w.call("POST", "/containers/create?name=agentx-task-0b9f-1a2b3c4d", sandbox)).status).toBe(201);
      const sent = JSON.parse(w.forwarded("/containers/create")[0]!.body);
      expect(sent.Labels["rovara.local.sandbox"]).toBe("1");
      expect(sent.Labels["rovara.local.profile"]).toBeUndefined();
      expect(sent.HostConfig.Dns).toEqual(["172.31.0.2"]);
      expect(sent.NetworkingConfig).toEqual({ EndpointsConfig: { "rovara-snet-aaaa": {} } });
    });
  });
});

describe("test services: what the worker may do with a service container", () => {
  it("runs commands in a helper as the helper's own configured user, never another, never privileged", async () => {
    await using(true, async (w) => {
      const exec = (body: unknown) => w.call("POST", `/containers/${NET}-h0123456789/exec`, body);
      expect((await exec({ AttachStdout: true, Cmd: ["psql", "-c", "select 1"] })).status).toBe(201);
      expect(JSON.parse(w.forwarded(`/containers/${HELPER_ID}/exec`)[0]!.body).User).toBe("999:999");
      expect((await exec({ AttachStdout: true, Cmd: ["id"], User: "999" })).status).toBe(201);
      for (const bad of [{ Cmd: ["id"], User: "0" }, { Cmd: ["id"], User: "root" }, { Cmd: ["id"], User: "1000:1000" }, { Cmd: ["id"], Privileged: true }]) expect((await exec(bad)).status, JSON.stringify(bad)).toBe(403);
    });
  });

  it("takes no exec in the resolver guard, a container with no fixed user, or a container that is not the worker's", async () => {
    await using(true, async (w) => {
      w.state.containers.push(owned({ name: `${CHECK}-guard`, id: "r".repeat(64), labels: serviceLabels("resolver"), user: "0:0" }));
      // Even a resolver guard that somehow had an ordinary user is not exec'd into: its profile decides, not its user.
      w.state.containers.push(owned({ name: `${CHECK}-guard-check`, id: "t".repeat(64), labels: serviceLabels("resolver"), user: "1000:1000" }));
      w.state.containers.push(owned({ name: `${NET}-h0000000009`, id: "9".repeat(64), labels: serviceLabels("helper"), user: "" }));
      w.state.containers.push(owned({ name: "someone-else", id: "q".repeat(64), labels: { ...serviceLabels("helper"), "rovara.local.owner": "b".repeat(24) }, user: "999:999" }));
      for (const target of [`${CHECK}-guard`, `${CHECK}-guard-check`, `${NET}-h0000000009`, "someone-else"]) {
        const answer = await w.call("POST", `/containers/${target}/exec`, { Cmd: ["id"] });
        expect(answer.status, target).toBeGreaterThanOrEqual(403);
      }
      expect(w.forwarded("/containers/")).toHaveLength(0);
    });
  });

  it("starts, stops, restarts, waits for, reads and removes its own service containers, and a plain sandbox keeps working", async () => {
    await using(true, async (w) => {
      for (const [method, path] of [["POST", "start"], ["POST", "stop?t=1"], ["POST", "restart?t=1"], ["POST", "wait?condition=removed"], ["GET", "json"], ["GET", "logs?stdout=1&stderr=1"]] as const) {
        expect((await w.call(method, `/containers/${NET}-h0123456789/${path}`)).status, path).toBe(200);
      }
      expect((await w.call("DELETE", `/containers/${NET}-h0123456789?force=1&v=1`)).status).toBe(200);
      expect((await w.call("POST", "/containers/agentx-task-w-1/start")).status).toBe(200);
      expect((await w.call("GET", "/containers/someone-else/json")).status).toBe(404);
    });
  });

  it("pauses, unpauses and reads the stats of its own containers only, with no body and no other option", async () => {
    await using(true, async (w) => {
      for (const [method, path] of [["POST", "pause"], ["POST", "unpause"], ["GET", "stats?stream=false&one-shot=true"]] as const) {
        expect((await w.call(method, `/containers/agentx-task-w-1/${path}`)).status, path).toBe(200);
        expect((await w.call(method, `/containers/${NET}-h0123456789/${path}`)).status, path).toBe(200);
        expect((await w.call(method, `/containers/someone-else/${path}`)).status, path).toBe(404);
      }
      expect((await w.call("GET", `/containers/${NET}-h0123456789/pause`)).status).toBe(403);
      expect((await w.call("POST", `/containers/${NET}-h0123456789/pause`, {})).status).toBe(403);
      expect((await w.call("GET", `/containers/${NET}-h0123456789/stats?stream=true&x=1`)).status).toBe(403);
      expect(w.forwarded("/containers/").map((entry) => entry.url)).toEqual([`/containers/${SANDBOX_ID}/pause`, `/containers/${HELPER_ID}/pause`, `/containers/${SANDBOX_ID}/unpause`, `/containers/${HELPER_ID}/unpause`]);
    });
  });

  it("answers pause and stats exactly as before without services", async () => {
    await using(false, async (w) => {
      expect((await w.call("POST", "/containers/agentx-task-w-1/pause")).status).toBe(403);
      expect((await w.call("GET", "/containers/agentx-task-w-1/stats?stream=false")).status).toBe(403);
    });
  });

  it("lists the run's service containers when the listing asks for the run's family label, and the sandboxes otherwise", async () => {
    await using(true, async (w) => {
      const labelOf = (): Record<string, boolean> => (JSON.parse(new URL(w.daemon.seen.at(-1)!.url, "http://d").searchParams.get("filters")!) as { label: Record<string, boolean> }).label;
      await w.call("GET", `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: [`rovara.run-network=${NET}`, `rovara.run-network.workspace=${KEY}`] }))}`);
      expect(Object.keys(labelOf()).sort()).toEqual([`rovara.local.owner=${OWNER}`, "rovara.local.sandbox=service", `rovara.run-network=${NET}`, `rovara.run-network.workspace=${KEY}`].sort());
      await w.call("GET", `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: ["agentx.task"] }))}`);
      expect(Object.keys(labelOf()).sort()).toEqual([`rovara.local.owner=${OWNER}`, "rovara.local.sandbox=1", "agentx.task"].sort());
      // A worker cannot widen the listing past its own by naming the class itself: its own label filter is added to, never replaced.
      await w.call("GET", `/containers/json?filters=${encodeURIComponent(JSON.stringify({ label: { "rovara.local.owner=bbbb": true, "rovara.run-network": true } }))}`);
      expect(Object.keys(labelOf())).toContain(`rovara.local.owner=${OWNER}`);
    });
  });

  it("inspects the worker's own image and the pinned catalog images and the pinned guard image, and no other image", async () => {
    await using(true, async (w) => {
      for (const image of [WORKER_IMAGE, POSTGRES, GUARD_IMAGE]) expect((await w.call("GET", `/images/${encodeURIComponent(image)}/json`)).status, image).toBe(200);
      for (const image of ["alpine:3.20", POSTGRES.replace("b".repeat(64), "c".repeat(64)), `sha256:${"c".repeat(64)}`, POSTGRES.replace(/@.*/u, ":16")]) expect((await w.call("GET", `/images/${encodeURIComponent(image)}/json`)).status, image).toBe(403);
    });
  });

  it("hijacks an attach to a service container only after the daemon says 101, with a request the guard built, and refuses everything else", async () => {
    await using(true, async (w) => {
      const ok = await w.upgrade(`/v1.54/containers/${NET}-h0123456789/attach?stream=1&stdout=1&stderr=1`);
      expect(ok).toMatch(/^HTTP\/1\.1 101 /);
      expect(ok).toContain("hello");
      expect(w.daemon.attachOpened).toEqual([`/containers/${HELPER_ID}/attach?stream=1&stdout=1&stderr=1`]);
      const before = w.daemon.attachOpened.length;
      // A sandbox is not a service container, and with no dev containers on there is no attach rule for it at all.
      expect(await w.upgrade(`/containers/agentx-task-w-1/attach?stream=1&stdout=1`)).toMatch(/^HTTP\/1\.1 403/);
      expect(await w.upgrade("/containers/someone-else/attach?stream=1")).toMatch(/^HTTP\/1\.1 404/);
      expect(await w.upgrade(`/containers/${NET}-h0123456789/attach?stream=1&stdin=1&stdout=1`)).toMatch(/^HTTP\/1\.1 403/);
      expect(await w.upgrade(`/containers/${NET}-h0123456789/attach?stream=1&hijack=1`)).toMatch(/^HTTP\/1\.1 403/);
      expect(await w.upgrade(`/containers/${NET}-h0123456789/attach?stream=1`, "", "POST /containers/create?name=x HTTP/1.1\r\nContent-Length: 0\r\n\r\n")).toMatch(/^HTTP\/1\.1 403/);
      // A chunked body next to a length is refused by the server's own parser before the guard reads it: no answer, and nothing reaches the daemon.
      expect(await w.upgrade(`/containers/${NET}-h0123456789/attach?stream=1`, "Transfer-Encoding: chunked\r\n")).not.toMatch(/^HTTP\/1\.1 101/);
      expect(w.daemon.attachOpened).toHaveLength(before);
    });
  });

  it("refuses everything else it refused before (volumes, builds, pulls, copies, events, images of its own naming)", async () => {
    await using(true, async (w) => {
      for (const [method, path] of [["POST", "/volumes/create"], ["POST", "/build"], ["POST", "/images/create?fromImage=alpine"], ["GET", "/events"], ["GET", `/containers/${NET}-h0123456789/archive?path=/`], ["PUT", `/containers/${NET}-h0123456789/archive?path=/`], ["POST", "/networks/prune"], ["POST", "/containers/prune"], ["GET", "/info"], ["POST", `/containers/${NET}-h0123456789/update`], ["POST", `/containers/${NET}-h0123456789/rename?name=x`], ["POST", `/containers/${NET}-h0123456789/kill?signal=KILL`]] as const) {
        const answer = await w.call(method, path);
        if (path.endsWith("/kill?signal=KILL")) expect(answer.status, path).toBe(200);
        else expect(answer.status, path).toBe(403);
      }
    });
  });
});

describe("test services: the broker's policy", () => {
  it("adds nothing to the guard's policy unless services are given, and passes exactly the knobs it was given", () => {
    const base = { image: WORKER_IMAGE, labels: [], names: { worker: "w", gateway: "g", guard: "s", workerNet: "wn", sandboxNet: "sn", externalNet: "xn" }, socketPath: "/var/run/docker.sock", socketGroup: "0", workspaceDirectory: WORKSPACE, workspaceKey: KEY, owner: OWNER, sandboxDns: "172.31.0.2" };
    expect("services" in guardPolicy(base)).toBe(false);
    expect(guardPolicy({ ...base, services: { images: [POSTGRES], guardImage: GUARD_IMAGE, runDirectory: RUN_DIRECTORY, bindDirectory: BIND_DIRECTORY, socketGroup: SOCKET_GROUP, maxMemoryMiB: 2048 } })["services"]).toEqual({ images: [POSTGRES], guardImage: GUARD_IMAGE, runDirectory: RUN_DIRECTORY, bindDirectory: BIND_DIRECTORY, socketGroup: SOCKET_GROUP, maxMemoryMiB: 2048 });
  });
});

// ---- review fixes: what a worker that writes in its own run folder can and cannot make the guard mount, the run network's host address, who a command runs as, and the caps

describe("test services: a bind source is never a path the worker could have changed (it is copied by the guard)", () => {
  const helperName = `${NET}-h0123456789`;
  const withBind = (source: string) => mutated(helperBody, (v) => { v.HostConfig.Binds = [`${source}:/x:ro`]; });
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "rg-outside-")));
  writeFileSync(join(outside, "secret"), "the owner's secret");
  mkdirSync(join(RUN_DIRECTORY, "probe"), { recursive: true });
  symlinkSync("/var/run/docker.sock", join(RUN_DIRECTORY, "probe", "sock"));
  symlinkSync("/", join(RUN_DIRECTORY, "probe", "root"));
  symlinkSync(outside, join(RUN_DIRECTORY, "probe", "home"));
  symlinkSync(join(outside, "secret"), join(RUN_DIRECTORY, "probe", "file"));
  mkdirSync(join(RUN_DIRECTORY, "probe", "folder"), { recursive: true });

  for (const [what, source] of [
    ["a link to the Docker socket", `${RUN_DIRECTORY}/probe/sock`],
    ["a link to the root of the machine", `${RUN_DIRECTORY}/probe/root`],
    ["a link to the owner's home folder", `${RUN_DIRECTORY}/probe/home`],
    ["a link to a file outside the run folder", `${RUN_DIRECTORY}/probe/file`],
    ["a file below a link to the root", `${RUN_DIRECTORY}/probe/root/etc/passwd`],
    ["a file below a link to a folder outside", `${RUN_DIRECTORY}/probe/home/secret`],
    ["a folder", `${RUN_DIRECTORY}/probe/folder`],
    ["a file that does not exist", `${RUN_DIRECTORY}/probe/nothing`],
  ] as const) {
    it(`refuses ${what}`, async () => {
      await using(true, async (w) => {
        const answer = await create(w, helperName, withBind(source));
        expect(answer.status, answer.text).toBe(403);
        expect(w.forwarded("/containers/create")).toHaveLength(0);
      });
    });
  }

  it("the same refusals hold for the sealed check sandbox's two files and a worker program's", async () => {
    await using(true, async (w) => {
      const check = mutated(checkBody, (v) => { v.HostConfig.Binds[1] = `${RUN_DIRECTORY}/probe/sock:/etc/resolv.conf:ro`; });
      expect((await create(w, CHECK, check)).status).toBe(403);
      const program = mutated(programBody, (v) => { v.HostConfig.Binds = [`${RUN_DIRECTORY}/probe/root:/x:ro`]; });
      expect((await create(w, `${NET}-h0123456789-c00000001`.replace("h0123456789-c00000001", "p0123456789"), program)).status).toBe(403);
      expect(w.forwarded("/containers/create")).toHaveLength(0);
    });
  });

  it("hands the daemon a copy in the guard's own folder, never the path the worker named, and a copy has the file's bytes", async () => {
    await using(true, async (w) => {
      expect((await create(w, helperName, withBind(`${RUN_DIRECTORY}/run1/init.sql`))).status).toBe(201);
      const sent = JSON.parse(w.forwarded("/containers/create")[0]!.body);
      const [source] = String(sent.HostConfig.Binds[0]).split(":");
      expect(source!.startsWith(`${BIND_DIRECTORY}/`)).toBe(true);
      expect(source!.startsWith(`${RUN_DIRECTORY}/`)).toBe(false);
      expect(readFileSync(source!, "utf8")).toBe(RUN_FILES["run1/init.sql"]);
    });
  });

  it("a file swapped for a link after the guard copied it changes nothing: the daemon is given the copy", async () => {
    await using(true, async (w) => {
      writeFileSync(join(RUN_DIRECTORY, "swap"), "first");
      expect((await create(w, helperName, withBind(`${RUN_DIRECTORY}/swap`))).status).toBe(201);
      const first = String(JSON.parse(w.forwarded("/containers/create")[0]!.body).HostConfig.Binds[0]).split(":")[0]!;
      rmSync(join(RUN_DIRECTORY, "swap"));
      symlinkSync("/var/run/docker.sock", join(RUN_DIRECTORY, "swap"));
      expect(readFileSync(first, "utf8")).toBe("first");
      // ... and the link is refused when it is asked for.
      expect((await create(w, `${NET}-h0123456788`, withBind(`${RUN_DIRECTORY}/swap`))).status).toBe(403);
      rmSync(join(RUN_DIRECTORY, "swap"));
    });
  });

  it("refuses a file that has another name (a hard link could be a file from outside the run folder)", async () => {
    await using(true, async (w) => {
      const outside = mkdtempSync(join(tmpdir(), "rovara-outside-"));
      try {
        writeFileSync(join(outside, "secret"), "outside");
        linkSync(join(outside, "secret"), join(RUN_DIRECTORY, "hard"));
        const answer = await create(w, helperName, withBind(`${RUN_DIRECTORY}/hard`));
        expect(answer.status, answer.text).toBe(403);
        expect(w.forwarded("/containers/create")).toHaveLength(0);
        // With the other name gone it is a plain file again.
        rmSync(join(outside, "secret"));
        expect((await create(w, `${NET}-h0123456788`, withBind(`${RUN_DIRECTORY}/hard`))).status).toBe(201);
      } finally { rmSync(outside, { recursive: true, force: true }); rmSync(join(RUN_DIRECTORY, "hard"), { force: true }); }
    });
  });

  it("removes copies nobody asked for in an hour, so a long-lived worker never hits the cap; a full folder of young copies refuses", async () => {
    const fill = (age: number): void => {
      for (let index = 0; index < 256; index += 1) {
        const path = join(BIND_DIRECTORY, `${"0".repeat(60)}${String(index).padStart(4, "0")}`);
        writeFileSync(path, String(index));
        const when = new Date(Date.now() - age);
        utimesSync(path, when, when);
      }
    };
    const clear = (): void => { for (const name of readdirSync(BIND_DIRECTORY)) rmSync(join(BIND_DIRECTORY, name), { force: true }); };
    await using(true, async (w) => {
      clear();
      fill(0);
      writeFileSync(join(RUN_DIRECTORY, "fresh"), "fresh bytes");
      expect((await create(w, helperName, withBind(`${RUN_DIRECTORY}/fresh`))).status).toBe(403);
      clear();
      fill(2 * 3600000);
      expect((await create(w, `${NET}-h0123456788`, withBind(`${RUN_DIRECTORY}/fresh`))).status).toBe(201);
      expect(readdirSync(BIND_DIRECTORY)).toHaveLength(1);
      // A copy that is used again is young again, so it stays.
      const [name] = readdirSync(BIND_DIRECTORY);
      const old = new Date(Date.now() - 2 * 3600000);
      utimesSync(join(BIND_DIRECTORY, name!), old, old);
      expect((await create(w, `${NET}-h0123456787`, withBind(`${RUN_DIRECTORY}/fresh`))).status).toBe(201);
      expect(existsSync(join(BIND_DIRECTORY, name!))).toBe(true);
      expect(Date.now() - statSync(join(BIND_DIRECTORY, name!)).mtimeMs).toBeLessThan(60000);
      clear();
      rmSync(join(RUN_DIRECTORY, "fresh"));
    });
  });

  it("refuses a file that is too big, and a guard with no folder for its copies", async () => {
    await using(true, async (w) => {
      writeFileSync(join(RUN_DIRECTORY, "big"), Buffer.alloc(4 * 1048576 + 1));
      expect((await create(w, helperName, withBind(`${RUN_DIRECTORY}/big`))).status).toBe(403);
      rmSync(join(RUN_DIRECTORY, "big"));
    });
    await using(true, async (w) => {
      expect((await create(w, helperName, withBind(`${RUN_DIRECTORY}/run1/init.sql`))).status).toBe(403);
    }, { policyExtra: { bindDirectory: "" } });
  });
});

describe("test services: who a service container runs as", () => {
  const helperName = `${NET}-h0123456789`;
  for (const [what, user] of [
    ["root's group with a plain user", "1000:0"],
    ["the Docker socket's group", `1000:${SOCKET_GROUP}`],
    ["the socket's group as user and group", `${SOCKET_GROUP}:${SOCKET_GROUP}`],
    ["a group that is not the user's own number", "999:1000"],
    ["a user with a leading zero", "0999:0999"],
    ["a group name", "999:docker"],
  ] as const) {
    it(`refuses a helper that runs as ${what}`, async () => {
      await using(true, async (w) => {
        expect((await create(w, helperName, mutated(helperBody, (v) => { v.User = user; }))).status).toBe(403);
        expect(w.forwarded("/containers/create")).toHaveLength(0);
      });
    });
  }

  it("refuses an exec in a service container whose configured user has gid 0 or the socket's group, or is not the one shape, whatever the container's label says", async () => {
    for (const user of ["1000:0", `1000:${SOCKET_GROUP}`, "0:0", "999:1000", ""]) {
      await using(true, async (w) => {
        w.state.containers.find((entry) => entry.name === helperName)!.user = user;
        expect((await w.call("POST", `/containers/${helperName}/exec`, { AttachStdout: true, Cmd: ["id"] })).status, user).toBe(403);
      });
    }
  });
});

describe("test services: a run network has no address on the host's side", () => {
  const body = () => networkBody();
  it("sets inhibit_ipv4 itself, and a worker that names the option is refused (the rule is the guard's, not the worker's)", async () => {
    await using(true, async (w) => {
      for (const value of ["true", "false"]) {
        const bad = body();
        bad.Options["com.docker.network.bridge.inhibit_ipv4"] = value;
        expect((await w.call("POST", "/v1.54/networks/create", bad)).status, value).toBe(403);
      }
      expect((await w.call("POST", "/v1.54/networks/create", body())).status).toBe(201);
      expect(JSON.parse(w.forwarded("/networks/create")[0]!.body).Options["com.docker.network.bridge.inhibit_ipv4"]).toBe("true");
    });
  });

  it("does not use a network that keeps a host address: inspect, remove, connect and a container joining it are all refused", async () => {
    await using(true, async (w) => {
      w.state.networks[0]!.options = { "com.docker.network.bridge.name": "rvi01234567" };
      expect((await w.call("GET", `/networks/${NET}`)).status).toBe(404);
      expect((await w.call("DELETE", `/networks/${NET}`)).status).toBe(404);
      expect((await w.call("POST", `/networks/${NET}/connect`, { Container: "agentx-task-w-1", EndpointConfig: { IPAMConfig: { IPv4Address: "172.30.7.3" } } })).status).toBe(404);
      expect((await create(w, `${NET}-h0123456789`, helperBody())).status).toBe(403);
      w.state.networks[0]!.options = { "com.docker.network.bridge.name": "rvi01234567", "com.docker.network.bridge.inhibit_ipv4": "false" };
      expect((await w.call("GET", `/networks/${NET}`)).status).toBe(404);
    });
  });
});

describe("test services: a project's dev container is not a sandbox or a service container here", () => {
  const dev = () => owned({ name: "agentx-dev-1", id: "d".repeat(64), user: "", labels: { "rovara.local.owner": OWNER, "rovara.local.sandbox": "1", "rovara.local.devcontainer": "1" } });
  it("never joins a run network (a dev container keeps Docker's default capabilities) and, with no dev containers on, takes no attach", async () => {
    await using(true, async (w) => {
      w.state.containers.push(dev());
      expect((await w.call("POST", `/networks/${NET}/connect`, { Container: "agentx-dev-1", EndpointConfig: { IPAMConfig: { IPv4Address: "172.30.7.3" } } })).status).toBe(403);
      expect((await w.call("POST", `/networks/${NET}/connect`, { Container: "agentx-task-w-1", EndpointConfig: { IPAMConfig: { IPv4Address: "172.30.7.3" } } })).status).toBe(200);
      expect(await w.upgrade("/containers/agentx-dev-1/attach?stream=1&stdout=1")).toMatch(/^HTTP\/1\.1 403/);
    });
  });
});

/** The guard program loaded as a library with the services policy, for the functions that need no daemon. */
async function loadGuard(): Promise<{ checkExecBody(text: string, kind?: unknown): string; buildHostConfig(host: unknown, mode?: unknown): Record<string, any> }> {
  const directory = await mkdtemp(join(tmpdir(), "rg-lib-"));
  scratch.push(directory);
  const file = join(directory, "guard.cjs");
  await writeFile(file, DOCKER_SOCKET_GUARD_SOURCE);
  const saved = { ...process.env };
  Object.assign(process.env, { ROVARA_SOCK_POLICY: JSON.stringify({ ...policy(true), upstream: "/nowhere.sock" }), ROVARA_SOCK_LIBRARY: "1" });
  try { return createRequire(import.meta.url)(file) as { checkExecBody(text: string, kind?: unknown): string; buildHostConfig(host: unknown, mode?: unknown): Record<string, any> }; } finally { for (const key of ["ROVARA_SOCK_POLICY", "ROVARA_SOCK_LIBRARY"]) delete process.env[key]; Object.assign(process.env, saved); }
}

describe("test services: a command's kind is a tagged value", () => {
  it("takes the sandbox kind, the service kind with a user of the one allowed shape and the dev container kind, and refuses anything else (no kind included), so a wrong merge fails here", async () => {
    const guard = await loadGuard();
    const ok = JSON.stringify({ Cmd: ["id"] });
    expect(JSON.parse(guard.checkExecBody(ok, { kind: "sandbox" })).User).toBe("1000:1000");
    expect(JSON.parse(guard.checkExecBody(ok, { kind: "service", user: "999:999" })).User).toBe("999:999");
    expect(() => guard.checkExecBody(JSON.stringify({ Cmd: ["id"], User: "1000:1000" }), { kind: "service", user: "999:999" })).toThrow(/runs as/);
    expect(() => guard.checkExecBody(JSON.stringify({ Cmd: ["id"], User: "0" }), { kind: "sandbox" })).toThrow(/sandbox user/);
    for (const wrong of [undefined, true, false, "999:999", "service", "devcontainer", { kind: "dev" }, { kind: "service" }, { user: "999:999" }, null]) {
      expect(() => guard.checkExecBody(ok, wrong as never), JSON.stringify(wrong)).toThrow();
    }
    for (const user of ["0:0", "1000:0", `1000:${SOCKET_GROUP}`]) expect(() => guard.checkExecBody(ok, { kind: "service", user }), user).toThrow(/runs as|Docker socket/);
    // The dev container kind keeps its own user (root may be named) and is the only kind that may.
    expect(JSON.parse(guard.checkExecBody(JSON.stringify({ Cmd: ["id"], User: "root" }), { kind: "devcontainer" })).User).toBe("root");
    expect(JSON.parse(guard.checkExecBody(ok, { kind: "devcontainer" })).User).toBe("");
    for (const kind of [{ kind: "sandbox" }, { kind: "service", user: "999:999" }] as const) expect(() => guard.checkExecBody(JSON.stringify({ Cmd: ["id"], User: "root" }), kind), kind.kind).toThrow(/runs as/);
  });
});

// Test services and dev containers on together: each kind of container keeps its own rules, and no rule of one reaches the other.
describe("test services and dev containers together", () => {
  const both = { policyTop: { devcontainer: { registries: ["docker.io"] } } };
  const DEV_ID = "d".repeat(64);
  const devContainer = () => owned({ name: "agentx-dev-1", id: DEV_ID, user: "", labels: { "rovara.local.owner": OWNER, "rovara.local.sandbox": "1", "rovara.local.devcontainer": "1" } });
  const execBody = (w: World, id: string): Record<string, any> => JSON.parse(w.forwarded(`/containers/${id}/exec`).at(-1)!.body) as Record<string, any>;

  it("refuses an exec into a helper that asks for root, and forces the helper's own user", async () => {
    await using(true, async (w) => {
      expect((await w.call("POST", `/containers/${NET}-h0123456789/exec`, { AttachStdout: true, Cmd: ["id"], User: "0" })).status).toBe(403);
      expect((await w.call("POST", `/containers/${NET}-h0123456789/exec`, { AttachStdout: true, Cmd: ["id"], User: "root" })).status).toBe(403);
      expect(w.forwarded(`/containers/${HELPER_ID}/exec`)).toHaveLength(0);
      expect((await w.call("POST", `/containers/${NET}-h0123456789/exec`, { AttachStdout: true, Cmd: ["id"] })).status).toBe(201);
      expect(execBody(w, HELPER_ID).User).toBe("999:999");
    }, both);
  });

  it("gives a dev container's exec its own user, never the sandbox's 1000:1000, with services on or off", async () => {
    for (const services of [true, false]) {
      await using(services, async (w) => {
        w.state.containers.push(devContainer());
        expect((await w.call("POST", "/containers/agentx-dev-1/exec", { AttachStdout: true, Cmd: ["id"], User: "root" })).status, `services ${String(services)}`).toBe(201);
        expect(execBody(w, DEV_ID).User).toBe("root");
        expect((await w.call("POST", "/containers/agentx-dev-1/exec", { AttachStdout: true, Cmd: ["id"] })).status).toBe(201);
        expect(execBody(w, DEV_ID).User).toBe("");
        // The sandbox beside it is still held to the sandbox user, and a dev container's user must be plain.
        expect((await w.call("POST", "/containers/agentx-task-w-1/exec", { AttachStdout: true, Cmd: ["id"], User: "root" })).status).toBe(403);
        expect((await w.call("POST", "/containers/agentx-dev-1/exec", { AttachStdout: true, Cmd: ["id"], User: "root;id" })).status).toBe(403);
      }, services ? both : { policyTop: { devcontainer: { registries: ["docker.io"] } }, containers: [owned({ name: "agentx-task-w-1", id: SANDBOX_ID }), devContainer()] });
    }
  });

  it("refuses an exec into a leftover dev container when dev containers are off, even with services on and a root user asked", async () => {
    await using(true, async (w) => {
      w.state.containers.push(devContainer());
      for (const user of [undefined, "root", "0", "1000"]) {
        expect((await w.call("POST", "/containers/agentx-dev-1/exec", { AttachStdout: true, Cmd: ["id"], ...(user === undefined ? {} : { User: user }) })).status, String(user)).toBe(403);
      }
      expect(w.forwarded(`/containers/${DEV_ID}/exec`)).toHaveLength(0);
      // The sandbox beside it is unchanged, and with dev containers on the same exec is served.
      expect((await w.call("POST", "/containers/agentx-task-w-1/exec", { AttachStdout: true, Cmd: ["id"] })).status).toBe(201);
    });
    await using(true, async (w) => {
      w.state.containers.push(devContainer());
      expect((await w.call("POST", "/containers/agentx-dev-1/exec", { AttachStdout: true, Cmd: ["id"], User: "root" })).status).toBe(201);
    }, both);
  });

  it("refuses a dev container joining a run network, with both on, and still serves a sandbox", async () => {
    await using(true, async (w) => {
      w.state.containers.push(devContainer());
      expect((await w.call("POST", `/networks/${NET}/connect`, { Container: "agentx-dev-1", EndpointConfig: { IPAMConfig: { IPv4Address: "172.30.7.3" } } })).status).toBe(403);
      expect((await w.call("POST", `/networks/${NET}/disconnect`, { Container: "agentx-dev-1" })).status).toBe(403);
      expect((await w.call("POST", `/networks/${NET}/connect`, { Container: "agentx-task-w-1", EndpointConfig: { IPAMConfig: { IPv4Address: "172.30.7.3" } } })).status).toBe(200);
    }, both);
  });

  it("refuses a check sandbox create that has any dev container capability, and never builds a host config for a mode it does not know", async () => {
    await using(true, async (w) => {
      for (const [what, change] of [
        ["SYS_PTRACE added", (v: Record<string, any>) => { v.HostConfig.CapAdd = ["SYS_PTRACE"]; }],
        ["no CapDrop ALL (the dev container's list)", (v: Record<string, any>) => { v.HostConfig.CapDrop = ["MKNOD", "NET_RAW"]; }],
        ["no CapDrop at all", (v: Record<string, any>) => { v.HostConfig.CapDrop = null; }],
        ["no security option", (v: Record<string, any>) => { v.HostConfig.SecurityOpt = []; }],
        ["the dev container's mask mounts", (v: Record<string, any>) => { v.HostConfig.Mounts = [{ Type: "volume", Source: `agentx-mask-x-${"a".repeat(8)}`, Target: `${WORKSPACE}/node_modules` }]; }],
        ["the dev container's network default", (v: Record<string, any>) => { v.HostConfig.NetworkMode = "default"; }],
      ] as const) {
        expect((await create(w, CHECK, mutated(checkBody, change))).status, what).toBe(403);
      }
      expect(w.forwarded("/containers/create")).toHaveLength(0);
    }, both);
    const guard = await loadGuard();
    const devHost = { ...hostZero(), NetworkMode: "default", CapDrop: [], CapAdd: ["SYS_PTRACE"], SecurityOpt: ["no-new-privileges"], Binds: null };
    const built = guard.buildHostConfig(devHost, { kind: "devcontainer" });
    expect(built.CapAdd).toEqual(["SYS_PTRACE"]);
    expect(built.CapDrop).toEqual(["MKNOD", "NET_RAW"]);
    const variant = { network: NET, readOnlyBinds: [], copies: [] };
    expect(() => guard.buildHostConfig(devHost, { kind: "check", variant })).toThrow();
    expect(() => guard.buildHostConfig(devHost, { kind: "sandbox" })).toThrow();
    for (const wrong of [undefined, null, true, false, "devcontainer", "check", { kind: "dev" }, { kind: "check" }, { kind: "check", variant: null }, { variant }]) {
      expect(() => guard.buildHostConfig({ ...hostZero(), NetworkMode: NET, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"] }, wrong), JSON.stringify(wrong)).toThrow(/unknown host config mode/);
    }
  });

  it("refuses an attach with stdin to a service container, and serves one to a dev container and a sandbox", async () => {
    await using(true, async (w) => {
      w.state.containers.push(devContainer());
      expect(await w.upgrade(`/containers/${NET}-h0123456789/attach?stream=1&stdin=1&stdout=1`)).toMatch(/^HTTP\/1\.1 403/);
      expect(await w.upgrade(`/containers/${NET}-h0123456789/attach?stream=1&stdout=1`)).toMatch(/^HTTP\/1\.1 101 /);
      const opened = w.daemon.attachOpened.length;
      expect(await w.upgrade("/containers/agentx-dev-1/attach?stream=1&stdin=1&stdout=1")).toMatch(/^HTTP\/1\.1 101 /);
      expect(await w.upgrade("/containers/agentx-task-w-1/attach?stream=1&stdout=1")).toMatch(/^HTTP\/1\.1 101 /);
      expect(w.daemon.attachOpened.slice(opened)).toEqual([`/containers/${DEV_ID}/attach?stream=1&stdin=1&stdout=1`, `/containers/${SANDBOX_ID}/attach?stream=1&stdout=1`]);
      // The resolver guard and a container that is not this worker's are served by neither rule.
      expect(await w.upgrade("/containers/someone-else/attach?stream=1")).toMatch(/^HTTP\/1\.1 404/);
    }, both);
  });

  it("changes nothing for an install with neither on: no attach, no dev image, the sandbox's own user", async () => {
    await using(false, async (w) => {
      expect(await w.upgrade(`/containers/${SANDBOX_ID}/attach?stream=1&stdout=1`)).toMatch(/^HTTP\/1\.1 403/);
      expect((await w.call("POST", "/containers/agentx-task-w-1/exec", { AttachStdout: true, Cmd: ["id"], User: "root" })).status).toBe(403);
      expect((await w.call("POST", "/containers/agentx-task-w-1/exec", { AttachStdout: true, Cmd: ["id"] })).status).toBe(201);
      expect(execBody(w, SANDBOX_ID).User).toBe("1000:1000");
      expect((await w.call("POST", "/images/create?fromImage=docker.io/library/alpine&tag=3")).status).toBe(403);
      expect((await w.call("GET", `/images/${encodeURIComponent("docker.io/library/alpine:3")}/json`)).status).toBe(403);
    });
  });
});

describe("test services: the program profile and the caps", () => {
  const programName = `${NET}-p0123456789`;
  it("refuses an environment that makes a program or a helper load code (NODE_OPTIONS, a preload)", async () => {
    for (const env of [["NODE_OPTIONS=--import=data:text/javascript,1"], ["NODE_PATH=/run/x"], ["LD_PRELOAD=/x.so"], ["DYLD_INSERT_LIBRARIES=/x"], ["node_options=--require=/x"]]) {
      await using(true, async (w) => {
        expect((await create(w, programName, mutated(programBody, (v) => { v.Env = ["A=b", ...env]; }))).status, env[0]).toBe(403);
        expect(w.forwarded("/containers/create")).toHaveLength(0);
      });
    }
    await using(true, async (w) => {
      expect((await create(w, `${NET}-h0123456789`, mutated(helperBody, (v) => { v.Env = ["LD_PRELOAD=/x.so"]; }))).status).toBe(403);
      expect((await create(w, programName, mutated(programBody, (v) => { v.Env = ["SERVICE_URL=http://postgres"]; }))).status).toBe(201);
    });
  });

  it("refuses an attach with any stdin value but none, 0 or false", async () => {
    await using(true, async (w) => {
      for (const value of ["1", "true", "yes", "TRUE", "on", "y"]) expect(await w.upgrade(`/containers/${NET}-h0123456789/attach?stream=1&stdout=1&stdin=${value}`), value).toMatch(/^HTTP\/1\.1 403/);
      expect(await w.upgrade(`/containers/${NET}-h0123456789/attach?stream=1&stdout=1&stdin=0`)).toMatch(/^HTTP\/1\.1 101/);
      expect(await w.upgrade(`/containers/${NET}-h0123456789/attach?stream=1&stdout=1&stdin=false`)).toMatch(/^HTTP\/1\.1 101/);
    });
  });

  it("caps the memory of all a worker's service containers together, from what the daemon holds", async () => {
    await using(true, async (w) => {
      // 3 GiB each: the machine this runs on decides the total (three quarters of its memory), so give the existing ones a label that fills it.
      const total = Math.floor(totalmem() * 0.75);
      w.state.containers.find((entry) => entry.name === `${NET}-h0123456789`)!.labels["rovara.local.memory"] = String(total);
      const answer = await create(w, `${NET}-h0123456788`, mutated(helperBody, () => undefined));
      expect(answer.status, answer.text).toBe(429);
      expect(w.forwarded("/containers/create")).toHaveLength(0);
    }, { policyExtra: { maxContainers: 9 } });
  });

  for (const [what, change] of [
    ["CpuShares above the ceiling", (v: Record<string, any>) => { v.HostConfig.CpuShares = 100000; }],
    ["ShmSize above the ceiling", (v: Record<string, any>) => { v.HostConfig.ShmSize = 1024 * 1048576; }],
    ["a MemoryReservation above the memory limit", (v: Record<string, any>) => { v.HostConfig.MemoryReservation = 2048 * 1048576; }],
    ["a tmpfs of more than 1024m", (v: Record<string, any>) => { v.HostConfig.Tmpfs = { "/var/run/postgresql": "rw,size=999999m" }; }],
  ] as const) {
    it(`refuses ${what}`, async () => {
      await using(true, async (w) => {
        expect((await create(w, `${NET}-h0123456789`, mutated(helperBody, change))).status).toBe(403);
      });
    });
  }
});

describe("test services: the owner's list (images by digest only)", () => {
  const STARTER = "docker.io/library/postgres@sha256:f9a7b9ebf6f56201f949db745e47bc423c0f0f8294bafe991cc10bf74b029657";
  const OTHER_DIGEST = STARTER.replace("f9a7b9eb", "00000000");
  const ownerBody = (image: string) => mutated(helperBody, (v) => { v.Image = image; });
  const withImages = (images: string[]) => ({ policyExtra: { images } });

  it("starts exactly the digests on the list, and refuses a starter name with another digest", async () => {
    await using(true, async (w) => {
      expect((await create(w, `${NET}-h0123456789`, ownerBody(STARTER))).status).toBe(201);
      for (const [index, image] of [OTHER_DIGEST, STARTER.replace(/@sha256:.*$/u, ":16"), STARTER.replace(/@sha256:.*$/u, ""), "postgres:16", "postgres"].entries()) {
        expect((await create(w, `${NET}-h012345678${String(index)}`, ownerBody(image))).status, image).toBe(403);
      }
    }, withImages([STARTER]));
  });

  it("drops a list entry that is not a digest reference, so a tag on the list starts nothing and is not inspectable", async () => {
    await using(true, async (w) => {
      expect((await create(w, `${NET}-h0123456789`, ownerBody("docker.io/library/postgres:16"))).status).toBe(403);
      expect((await w.call("GET", "/v1.54/images/docker.io%2Flibrary%2Fpostgres%3A16/json")).status).toBe(403);
      // The digest entry beside it still works.
      expect((await create(w, `${NET}-h0123456788`, ownerBody(STARTER))).status).toBe(201);
    }, withImages(["docker.io/library/postgres:16", "postgres", STARTER, "sha256:" + "a".repeat(64), "docker.io/library/postgres@sha256:short"]));
  });

  it("starts no image at all when the list is empty (nothing approved)", async () => {
    await using(true, async (w) => {
      expect((await create(w, `${NET}-h0123456789`, ownerBody(STARTER))).status).toBe(403);
    }, withImages([]));
  });
});
