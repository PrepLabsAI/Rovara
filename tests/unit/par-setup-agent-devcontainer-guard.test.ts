/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment --
   the guard tests build Docker API bodies as free-form objects and change one field at a time; the shape under test is whatever an attacker sends. */
// A project's dev container through the Docker socket guard of a local worker. The guard serves one only when the owner's policy lists registries, from a body it builds from nothing; this drives the very text that
// runs in the guard's container, as a library and as a server over a fake daemon.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import { connect as netConnect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DOCKER_SOCKET_GUARD_SOURCE } from "../../packages/broker/src/local/isolation/docker-socket-guard-source.js";
import { DEFAULT_DEVCONTAINER_REGISTRIES, daemonIsVmBacked, devcontainerRegistriesForInstall, devcontainerRegistriesFrom, guardPolicy } from "../../packages/broker/src/local/isolation/stack.js";

const scratch: string[] = [];
afterAll(async () => { while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true }); });

async function load<T>(policy: Record<string, unknown>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "rovara-dcg-"));
  scratch.push(directory);
  const file = join(directory, "program.cjs");
  await writeFile(file, DOCKER_SOCKET_GUARD_SOURCE);
  const saved = { ...process.env };
  Object.assign(process.env, { ROVARA_SOCK_POLICY: JSON.stringify(policy), ROVARA_SOCK_LIBRARY: "1" });
  try { return createRequire(import.meta.url)(file) as T; } finally { for (const key of ["ROVARA_SOCK_POLICY", "ROVARA_SOCK_LIBRARY"]) delete process.env[key]; Object.assign(process.env, saved); }
}

const owner = "d".repeat(24);
const workspace = "/home/me/.rovara/workspaces/dddd";
const key = createHash("sha256").update("workspace").digest("hex").slice(0, 16);
const REGISTRIES = ["mcr.microsoft.com", "docker.io", "ghcr.io"];
const basePolicy = { owner, image: "worker:test", workspaceDir: workspace, workspaceKey: key, network: "rovara-snet-dddd", dns: ["172.30.0.2"], user: "1000:1000", port: 2375, maxSandboxes: 16 };
const withDev = { ...basePolicy, devcontainer: { registries: REGISTRIES } };
interface Guard { transformDevcontainerCreate(query: URLSearchParams, text: string): string; transformCreate(query: URLSearchParams, text: string): string; imageRefusal(ref: string): string | undefined; checkExecBody(text: string, who?: { kind: "devcontainer" } | { kind: "sandbox" }): string; createServer(): Server }

/** What the dev container tool sends for `{ "image": ... }` and the worker's own mounts. */
const cliBody = (extra: Record<string, unknown> = {}, host: Record<string, unknown> = {}) => ({
  Hostname: "", Domainname: "", User: "", AttachStdin: false, AttachStdout: true, AttachStderr: true, Tty: false, OpenStdin: false, StdinOnce: false, Env: null,
  Cmd: ["-c", "echo Container started\ntrap \"exit 0\" 15\nwhile sleep 1 & wait $!; do :; done"], Entrypoint: ["/bin/sh"], Image: "mcr.microsoft.com/devcontainers/base:ubuntu",
  Labels: { "devcontainer.local_folder": workspace, "devcontainer.config_file": `${workspace}/.devcontainer/devcontainer.json`, "rovara.local.owner": "forged", "rovara.x": "1" },
  HostConfig: { Init: true, Mounts: [{ Type: "bind", Source: workspace, Target: workspace, Consistency: "cached" }, { Type: "volume", Source: "agentx-mask-agentx-0123456789ab", Target: `${workspace}/.agentx` }], NetworkMode: "default", ...host },
  ...extra,
});
const create = (guard: Guard, body: unknown, name?: string) => JSON.parse(guard.transformDevcontainerCreate(name === undefined ? new URLSearchParams() : new URLSearchParams({ name }), JSON.stringify(body))) as Record<string, any>;

describe("which registries a dev container may pull from", () => {
  it("is the owner's own list, or none", () => {
    expect(devcontainerRegistriesFrom("0")).toEqual([]);
    expect(devcontainerRegistriesFrom("  ")).toEqual([]);
    expect(devcontainerRegistriesFrom("Registry.Example.com, ghcr.io , 10.0.0.1, localhost, registry.example.com:5000, bad name")).toEqual(["registry.example.com", "ghcr.io", "registry.example.com:5000"]);
  });
  it("is on by default only on a Docker that runs in a virtual machine, rootless or Docker Desktop, and off on a rootful Linux host and whenever it cannot be told", async () => {
    const mac = { platform: "darwin", dockerHost: undefined, facts: undefined };
    expect(daemonIsVmBacked(mac)).toBe(true);
    expect(daemonIsVmBacked({ ...mac, platform: "win32", dockerHost: "npipe:////./pipe/docker_engine" })).toBe(true);
    expect(daemonIsVmBacked({ ...mac, dockerHost: "unix:///Users/me/.colima/default/docker.sock" })).toBe(true);
    // A remote daemon from a laptop is not a virtual machine this computer owns.
    expect(daemonIsVmBacked({ ...mac, dockerHost: "tcp://build.example.dev:2375" })).toBe(false);
    expect(daemonIsVmBacked({ ...mac, dockerHost: "ssh://me@host.example.dev" })).toBe(false);
    expect(daemonIsVmBacked({ platform: "linux", dockerHost: undefined, facts: undefined })).toBe(false);
    expect(daemonIsVmBacked({ platform: "linux", dockerHost: undefined, facts: { securityOptions: ["name=seccomp,profile=builtin"], operatingSystem: "Ubuntu 24.04" } })).toBe(false);
    expect(daemonIsVmBacked({ platform: "linux", dockerHost: undefined, facts: { securityOptions: ["name=seccomp,profile=builtin", "name=rootless"], operatingSystem: "Ubuntu 24.04" } })).toBe(true);
    expect(daemonIsVmBacked({ platform: "linux", dockerHost: undefined, facts: { securityOptions: [], operatingSystem: "Docker Desktop" } })).toBe(true);
    const asked: string[][] = [];
    const runner = (stdout: string, exitCode = 0) => ({ run: async (args: readonly string[]) => { asked.push([...args]); return { exitCode, stdout, stderr: "" }; } });
    // Linux: the daemon is asked, and only then.
    expect(await devcontainerRegistriesForInstall({}, runner('["name=seccomp,profile=builtin"]|Ubuntu 24.04'), "linux")).toEqual([]);
    expect(await devcontainerRegistriesForInstall({}, runner('["name=rootless"]|Ubuntu 24.04'), "linux")).toEqual(DEFAULT_DEVCONTAINER_REGISTRIES);
    expect(await devcontainerRegistriesForInstall({}, runner("", 1), "linux")).toEqual([]);
    expect(await devcontainerRegistriesForInstall({}, runner("not json|x"), "linux")).toEqual([]);
    expect(asked.length).toBe(4);
    expect(await devcontainerRegistriesForInstall({}, runner(""), "darwin")).toEqual(DEFAULT_DEVCONTAINER_REGISTRIES);
    expect(asked.length).toBe(4);
    // The owner's own word decides, either way, and the daemon is not asked.
    expect(await devcontainerRegistriesForInstall({ ROVARA_DEVCONTAINER_REGISTRIES: "ghcr.io" }, runner(""), "linux")).toEqual(["ghcr.io"]);
    expect(await devcontainerRegistriesForInstall({ ROVARA_DEVCONTAINER_REGISTRIES: "0" }, runner(""), "darwin")).toEqual([]);
    expect(asked.length).toBe(4);
  });
  it("reaches the guard only when there is a list", () => {
    expect(guardPolicy({ image: "i", names: { sandboxNet: "n" } } as never)).not.toHaveProperty("devcontainer");
    expect(guardPolicy({ image: "i", names: { sandboxNet: "n" }, devcontainerRegistries: [] } as never)).not.toHaveProperty("devcontainer");
    expect(guardPolicy({ image: "i", names: { sandboxNet: "n" }, devcontainerRegistries: ["ghcr.io"] } as never)).toMatchObject({ devcontainer: { registries: ["ghcr.io"] } });
  });
});

describe("the image a dev container names", () => {
  it("is refused for every image when the owner listed no registry", async () => {
    const guard = await load<Guard>(basePolicy);
    expect(guard.imageRefusal("node:20")).toBeTypeOf("string");
    expect(() => create(guard, cliBody())).toThrow();
  });
  it("is a plain reference on a listed registry", async () => {
    const guard = await load<Guard>(withDev);
    for (const ref of ["node:20", "library/node:20-bookworm", "mcr.microsoft.com/devcontainers/base:ubuntu", "ghcr.io/example/img@sha256:" + "a".repeat(64), "index.docker.io/library/alpine", "docker.io/example/img:v1.2_3"]) expect(guard.imageRefusal(ref), ref).toBeUndefined();
  });
  it("is refused for an address or a loopback name even when the owner's list holds one", async () => {
    const guard = await load<Guard>({ ...basePolicy, devcontainer: { registries: ["10.0.0.5:5000", "localhost:5000", "[::1]:5000", "localhost"] } });
    for (const ref of ["10.0.0.5:5000/example/img", "localhost:5000/example/img", "[::1]:5000/img", "localhost/img"]) expect(guard.imageRefusal(ref), ref).toBeTypeOf("string");
  });
  it.each([
    ["a registry that is not listed", "quay.io/example/img:1"], ["a private registry", "registry.example.com:5000/example/img"], ["a loopback registry", "localhost:5000/example/img"], ["an address", "10.0.0.5/example/img"],
    ["an address with a port", "192.168.1.9:5000/img"], ["an IPv6 address", "[::1]:5000/img"], ["upper case in the path", "docker.io/Example/Img"], ["a space", "node :20"], ["a newline", "node:20\nx"], ["a backslash", "node\\20"],
    ["an empty name", ""], ["a bad digest", "node@sha256:abc"], ["a bad tag", "node:-1"], ["an option", "--privileged"], ["a scheme", "https://docker.io/node"],
  ])("is refused for %s", async (_what, ref) => {
    const guard = await load<Guard>(withDev);
    expect(guard.imageRefusal(ref), ref).toBeTypeOf("string");
  });
});

describe("a dev container's create", () => {
  it("is built from nothing: the network and name server are the sandbox's, the guard's labels win, the worker's masks are read-only tmpfs and no volume is made", async () => {
    const guard = await load<Guard>(withDev);
    const built = create(guard, cliBody({}, { Dns: [] }));
    expect(built.HostConfig).toMatchObject({ NetworkMode: "rovara-snet-dddd", Dns: ["172.30.0.2"], Privileged: false, CapDrop: ["MKNOD", "NET_RAW"], Init: true, Binds: [], SecurityOpt: ["no-new-privileges"], CapAdd: [] });
    expect(built.HostConfig.Mounts).toEqual([
      { Type: "bind", Source: workspace, Target: workspace, ReadOnly: false },
      { Type: "tmpfs", Target: `${workspace}/.agentx`, ReadOnly: true, TmpfsOptions: { SizeBytes: 1048576 } },
    ]);
    expect(built.HostConfig.Tmpfs).toEqual({});
    expect(built.HostConfig.Memory).toBeGreaterThan(0);
    expect(built.HostConfig.PidsLimit).toBe(4096);
    expect(built.Labels).toMatchObject({ "rovara.local.owner": owner, "rovara.local.sandbox": "1", "rovara.local.devcontainer": "1", "agentx.workspace": key, "devcontainer.local_folder": workspace });
    expect(built.NetworkingConfig).toEqual({ EndpointsConfig: { "rovara-snet-dddd": {} } });
    expect(built.Image).toBe("mcr.microsoft.com/devcontainers/base:ubuntu");
    // A label of the guard's own namespace the worker made up is not passed on.
    expect(Object.keys(built.Labels).filter((label) => label.startsWith("rovara."))).toEqual(["rovara.local.owner", "rovara.local.sandbox", "rovara.local.devcontainer"].sort((a, b) => Object.keys(built.Labels).indexOf(a) - Object.keys(built.Labels).indexOf(b)));
  });

  it.each([
    ["privileged mode", { Privileged: true }], ["the host's network", { NetworkMode: "host" }], ["another network", { NetworkMode: "other" }], ["the host's processes", { PidMode: "host" }], ["the host's IPC", { IpcMode: "host" }],
    ["the host's user namespace", { UsernsMode: "host" }], ["a device", { Devices: [{ PathOnHost: "/dev/sda", PathInContainer: "/dev/sda", CgroupPermissions: "rwm" }] }], ["a published port", { PortBindings: { "80/tcp": [{ HostPort: "80" }] } }],
    ["an added capability", { CapAdd: ["NET_ADMIN"] }], ["an added capability beside the allowed one", { CapAdd: ["SYS_PTRACE", "SYS_ADMIN"] }], ["unconfined seccomp", { SecurityOpt: ["seccomp=unconfined"] }], ["apparmor off", { SecurityOpt: ["apparmor=unconfined"] }],
    ["a bind of the host's root", { Binds: ["/:/host"] }], ["a bind of the home folder", { Binds: ["/home/me/.ssh:/ssh"] }], ["extra hosts", { ExtraHosts: ["a:10.0.0.1"] }], ["links", { Links: ["x:y"] }],
    ["a volumes-from", { VolumesFrom: ["other"] }], ["a sysctl", { Sysctls: { "net.core.somaxconn": "1" } }], ["a masked-path change", { MaskedPaths: [] }], ["a runtime", { Runtime: "runc" }],
    ["a memory limit above the machine's", { Memory: 2 ** 60 }], ["a restart policy", { RestartPolicy: { Name: "always" } }], ["a name that is not a Docker field", { privileged: true }],
  ])("refuses %s", async (_what, host) => {
    const guard = await load<Guard>(withDev);
    expect(() => create(guard, cliBody({}, host)), _what).toThrow();
  });

  it.each([
    ["a bind of another folder", { Type: "bind", Source: "/home/me", Target: "/home/me" }], ["a bind of the workspace at another path", { Type: "bind", Source: workspace, Target: "/work" }],
    ["a bind of the workspace's parent", { Type: "bind", Source: "/home/me/.rovara/workspaces", Target: "/home/me/.rovara/workspaces" }], ["a volume that is not a mask", { Type: "volume", Source: "data", Target: `${workspace}/data` }],
    ["a mask over a folder outside the workspace", { Type: "volume", Source: "agentx-mask-agentx-0123456789ab", Target: "/etc" }], ["a mask over the whole workspace", { Type: "volume", Source: "agentx-mask-agentx-0123456789ab", Target: workspace }],
    ["a tmpfs outside the workspace", { Type: "tmpfs", Target: "/tmp" }], ["an npipe", { Type: "npipe", Source: "x", Target: "y" }], ["a read-only flag", { Type: "bind", Source: workspace, Target: workspace, ReadOnly: true }],
    ["bind options", { Type: "bind", Source: workspace, Target: workspace, BindOptions: { Propagation: "shared" } }], ["volume options", { Type: "volume", Source: "agentx-mask-agentx-0123456789ab", Target: `${workspace}/.agentx`, VolumeOptions: { DriverConfig: { Name: "x" } } }],
    ["a mount of another kind", { Type: "image", Source: "x", Target: `${workspace}/y` }],
  ])("refuses %s", async (_what, mount) => {
    const guard = await load<Guard>(withDev);
    expect(() => create(guard, cliBody({}, { Mounts: [mount] })), _what).toThrow();
  });

  it("refuses the workspace mounted twice, an image that is not listed, a user that is not plain, a name outside agentx-dev-, and the worker's image through this path", async () => {
    const guard = await load<Guard>(withDev);
    const twice = { Type: "bind", Source: workspace, Target: workspace };
    expect(() => create(guard, cliBody({}, { Mounts: [twice, twice] }))).toThrow();
    expect(() => create(guard, cliBody({ Image: "quay.io/example/img" }))).toThrow();
    expect(() => create(guard, cliBody({ User: "root; id" }))).toThrow();
    expect(() => create(guard, cliBody(), "escape")).toThrow();
    expect(() => create(guard, cliBody(), "agentx-dev-ok_1")).not.toThrow();
    expect(() => guard.transformDevcontainerCreate(new URLSearchParams({ name: "agentx-dev-x", platform: "linux/arm64" }), JSON.stringify(cliBody()))).toThrow();
    expect(() => create(guard, cliBody({ Healthcheck: { Test: ["CMD", "x"] } }))).toThrow();
    expect(() => create(guard, cliBody({ Volumes: { "/x": {} } }))).toThrow();
  });

  it("forces privileged off in the body it builds, whatever null or false was sent", async () => {
    const guard = await load<Guard>(withDev);
    expect(create(guard, cliBody({}, { Privileged: null })).HostConfig.Privileged).toBe(false);
    expect(create(guard, cliBody({}, { Privileged: false })).HostConfig.Privileged).toBe(false);
  });

  it("always sets no-new-privileges, and accepts only that as a security option", async () => {
    const guard = await load<Guard>(withDev);
    expect(create(guard, cliBody()).HostConfig.SecurityOpt).toEqual(["no-new-privileges"]);
    expect(create(guard, cliBody({}, { SecurityOpt: [] })).HostConfig.SecurityOpt).toEqual(["no-new-privileges"]);
    expect(create(guard, cliBody({}, { SecurityOpt: ["no-new-privileges:true"] })).HostConfig.SecurityOpt).toEqual(["no-new-privileges"]);
    expect(() => create(guard, cliBody({}, { SecurityOpt: ["no-new-privileges", "seccomp=unconfined"] }))).toThrow();
  });

  it("allows only the limits that cannot hurt the machine, for a dev container and a sandbox", async () => {
    const guard = await load<Guard>(withDev);
    const limit = (Name: string) => ({ Ulimits: [{ Name, Soft: 1024, Hard: 4096 }] });
    for (const name of ["nofile", "nproc", "core"]) expect(create(guard, cliBody({}, limit(name))).HostConfig.Ulimits, name).toEqual([{ Name: name, Soft: 1024, Hard: 4096 }]);
    for (const name of ["rtprio", "memlock", "nice", "msgqueue", "sigpending", "locks", "NOFILE", "stack"]) expect(() => create(guard, cliBody({}, limit(name))), name).toThrow();
    const sandbox = (Name: string) => JSON.stringify({ User: "1000:1000", Image: "worker:test", Labels: { "agentx.task": "t", "agentx.workspace": key }, HostConfig: { Binds: [`${workspace}:${workspace}`], NetworkMode: "rovara-snet-dddd", CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], ...limit(Name) } });
    expect(() => guard.transformCreate(new URLSearchParams({ name: "agentx-task-x" }), sandbox("nofile"))).not.toThrow();
    expect(() => guard.transformCreate(new URLSearchParams({ name: "agentx-task-x" }), sandbox("rtprio"))).toThrow();
  });

  it("allows SYS_PTRACE and no-new-privileges, the two the worker's own check of the started container accepts", async () => {
    const guard = await load<Guard>(withDev);
    const built = create(guard, cliBody({}, { CapAdd: ["SYS_PTRACE"], SecurityOpt: ["no-new-privileges"] }));
    expect(built.HostConfig.CapAdd).toEqual(["SYS_PTRACE"]);
    expect(built.HostConfig.SecurityOpt).toEqual(["no-new-privileges"]);
  });

  it("leaves the sandbox's rules exactly as they were: a sandbox is still the worker's image on the sandbox network with every capability dropped", async () => {
    const guard = await load<Guard>(withDev);
    const sandbox = { User: "1000:1000", Image: "worker:test", Cmd: ["sleep", "infinity"], Labels: { "agentx.task": "t", "agentx.workspace": key }, HostConfig: { Binds: [`${workspace}:${workspace}`], NetworkMode: "rovara-snet-dddd", CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"] } };
    expect(JSON.parse(guard.transformCreate(new URLSearchParams({ name: "agentx-task-x" }), JSON.stringify(sandbox))).HostConfig).toMatchObject({ CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"] });
    expect(() => guard.transformCreate(new URLSearchParams({ name: "agentx-task-x" }), JSON.stringify({ ...sandbox, HostConfig: { ...sandbox.HostConfig, Mounts: [{ Type: "bind", Source: workspace, Target: workspace }] } }))).toThrow();
    expect(() => guard.transformCreate(new URLSearchParams({ name: "agentx-task-x" }), JSON.stringify({ ...sandbox, HostConfig: { ...sandbox.HostConfig, CapAdd: ["SYS_PTRACE"] } }))).toThrow();
    expect(() => guard.transformCreate(new URLSearchParams({ name: "agentx-task-x" }), JSON.stringify({ ...sandbox, Image: "mcr.microsoft.com/devcontainers/base:ubuntu" }))).toThrow();
  });

  it("runs a dev container's commands as its own user, never privileged; a sandbox's still run as the sandbox user", async () => {
    const guard = await load<Guard>(withDev);
    const exec = (extra: Record<string, unknown>) => JSON.stringify({ AttachStdout: true, Cmd: ["id"], ...extra });
    const dev = { kind: "devcontainer" } as const;
    const sandbox = { kind: "sandbox" } as const;
    expect(JSON.parse(guard.checkExecBody(exec({ User: "vscode" }), dev))).toMatchObject({ User: "vscode", Privileged: false });
    expect(JSON.parse(guard.checkExecBody(exec({}), dev))).toMatchObject({ User: "", Privileged: false });
    expect(() => guard.checkExecBody(exec({ User: "root; id" }), dev)).toThrow();
    expect(() => guard.checkExecBody(exec({ Privileged: true, User: "root" }), dev)).toThrow();
    expect(() => guard.checkExecBody(exec({ User: "root" }), sandbox)).toThrow();
    expect(JSON.parse(guard.checkExecBody(exec({ User: "1000" }), sandbox))).toMatchObject({ User: "1000:1000" });
    // A kind this guard does not know, or the old boolean, never runs a command: a caller that was not updated fails closed rather than as root.
    for (const unknown of [undefined, true, false, "root", { kind: "service", user: "1000" }, { kind: "devcontainer-ish" }, null]) {
      expect(() => guard.checkExecBody(exec({}), unknown as never), JSON.stringify(unknown)).toThrow();
    }
  });
});

// ---- the guard as a server, over a fake daemon

async function fakeDaemon(ownerLabel: string, options: { devcontainer?: boolean; attach?: "101" | "plain" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "rovara-dcd-"));
  scratch.push(directory);
  const socketPath = join(directory, "docker.sock");
  const requests: Array<{ method: string; url: string; body: string }> = [];
  const containerId = "c".repeat(64);
  const server = createNetServer((socket) => {
    let held = Buffer.alloc(0);
    let raw = false;
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      if (raw) { socket.write(Buffer.concat([Buffer.from("echo:"), chunk])); return; }
      held = Buffer.concat([held, chunk]);
      const end = held.indexOf("\r\n\r\n");
      if (end === -1) return;
      const head = held.subarray(0, end).toString("latin1");
      const length = Number(/content-length: (\d+)/i.exec(head)?.[1] ?? 0);
      if (held.length < end + 4 + length) return;
      const [method = "", url = ""] = (head.split("\r\n")[0] ?? "").split(" ");
      requests.push({ method, url, body: held.subarray(end + 4, end + 4 + length).toString("utf8") });
      held = Buffer.alloc(0);
      const reply = (status: string, json: unknown): void => { const text = JSON.stringify(json); socket.write(`HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`); socket.end(); };
      if (method === "GET" && /^\/containers\/[^/]+\/json$/.test(url)) reply("200 OK", { Id: containerId, Config: { Labels: { "rovara.local.owner": ownerLabel, "rovara.local.sandbox": "1", ...(options.devcontainer === true ? { "rovara.local.devcontainer": "1" } : {}) } } });
      else if (method === "GET" && url.startsWith("/containers/json")) reply("200 OK", []);
      else if (method === "POST" && url.startsWith("/containers/create")) reply("201 Created", { Id: containerId });
      else if (method === "POST" && /\/attach/.test(url) && options.attach === "plain") socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}");
      else if (method === "POST" && /\/attach/.test(url)) { socket.write("HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n"); raw = true; }
      else reply("200 OK", {});
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { socketPath, requests, containerId, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }) };
}

async function startServer(policy: Record<string, unknown>, daemon: Awaited<ReturnType<typeof fakeDaemon>>) {
  const guard = await load<Guard>({ ...policy, upstream: daemon.socketPath });
  const server = guard.createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  const call = (method: string, path: string, body?: string): Promise<{ status: number; text: string }> => new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: "127.0.0.1", port, method, path, headers: body === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, text: Buffer.concat(chunks).toString() }));
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
  const upgrade = (path: string, after = ""): Promise<string> => new Promise((resolve) => {
    const socket = netConnect({ host: "127.0.0.1", port }, () => {
      socket.write(`POST ${path} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n`);
      if (after !== "") { setTimeout(() => socket.write(after), 5); setTimeout(() => socket.write(after), 200); }
    });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", () => undefined);
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
    setTimeout(() => socket.destroy(), 600);
  });
  return { call, upgrade, close: async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await daemon.close(); } };
}

describe("the guard as a server, with dev containers on", () => {
  it("pulls only an image of a listed registry, passing on the reference and the platform and nothing else", async () => {
    const daemon = await fakeDaemon(owner);
    const world = await startServer(withDev, daemon);
    try {
      expect((await world.call("POST", "/v1.54/images/create?fromImage=mcr.microsoft.com%2Fdevcontainers%2Fbase&tag=ubuntu&platform=linux%2Farm64")).status).toBe(200);
      expect(daemon.requests.at(-1)!.url).toBe("/images/create?fromImage=mcr.microsoft.com%2Fdevcontainers%2Fbase&tag=ubuntu&platform=linux%2Farm64");
      const before = daemon.requests.length;
      for (const bad of ["fromImage=quay.io%2Fx%2Fy", "fromImage=localhost%3A5000%2Fx", "fromImage=node&fromSrc=-", "fromImage=node&repo=x", "fromImage=node&message=x", "fromImage=node&changes=CMD%20x", "tag=1", "fromImage=node&tag=%3B", "fromImage=node&platform=linux%20x"]) {
        expect((await world.call("POST", `/v1.54/images/create?${bad}`)).status, bad).toBe(403);
      }
      expect(daemon.requests.length).toBe(before);
      expect((await world.call("GET", "/v1.54/images/node%3A20/json")).status).toBe(200);
      expect((await world.call("GET", "/v1.54/images/quay.io%2Fx%2Fy/json")).status).toBe(403);
      expect((await world.call("GET", "/v1.54/images/worker%3Atest/json")).status).toBe(200);
    } finally { await world.close(); }
  });

  it("reads events of this worker's own containers only: the label filters are forced and other options refused", async () => {
    const daemon = await fakeDaemon(owner);
    const world = await startServer(withDev, daemon);
    try {
      expect((await world.call("GET", `/v1.54/events?filters=${encodeURIComponent(JSON.stringify({ event: { start: true }, label: { "x=y": true } }))}`)).status).toBe(200);
      const filters = JSON.parse(new URL(daemon.requests.at(-1)!.url, "http://x").searchParams.get("filters")!);
      expect(filters).toEqual({ event: { start: true }, type: { container: true }, label: { [`rovara.local.owner=${owner}`]: true, "rovara.local.sandbox=1": true } });
      expect((await world.call("GET", "/v1.54/events")).status).toBe(200);
      expect(JSON.parse(new URL(daemon.requests.at(-1)!.url, "http://x").searchParams.get("filters")!).label).toEqual({ [`rovara.local.owner=${owner}`]: true, "rovara.local.sandbox=1": true });
      expect((await world.call("GET", "/v1.54/events?foo=1")).status).toBe(403);
    } finally { await world.close(); }
  });

  it("sends the daemon the body it built for a dev container, and keeps the sandbox on its own rules", async () => {
    const daemon = await fakeDaemon(owner);
    const world = await startServer(withDev, daemon);
    try {
      const made = await world.call("POST", "/v1.54/containers/create", JSON.stringify(cliBody({}, { Privileged: 1 })));
      expect(made.status).toBe(403);
      expect(daemon.requests.some((request) => request.url.startsWith("/containers/create"))).toBe(false);
      const ok = await world.call("POST", "/v1.54/containers/create", JSON.stringify(cliBody()));
      expect(ok.status).toBe(201);
      const sent = JSON.parse(daemon.requests.find((request) => request.url.startsWith("/containers/create"))!.body);
      expect(sent.HostConfig).toMatchObject({ NetworkMode: "rovara-snet-dddd", CapDrop: ["MKNOD", "NET_RAW"] });
      expect(sent.Labels["rovara.local.owner"]).toBe(owner);
      expect(daemon.requests.find((request) => request.url.startsWith("/containers/create"))!.url).toBe("/containers/create");
      // The worker's own image is a sandbox: it still needs its name and its rules.
      expect((await world.call("POST", "/v1.54/containers/create", JSON.stringify({ User: "1000:1000", Image: "worker:test", Labels: { "agentx.task": "t", "agentx.workspace": key }, HostConfig: { NetworkMode: "rovara-snet-dddd", CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], Binds: [`${workspace}:${workspace}`] } }))).status).toBe(403);
    } finally { await world.close(); }
  });

  it("attaches only to a container of this worker, with the options a docker run uses, and passes bytes on only after the daemon said 101", async () => {
    const daemon = await fakeDaemon(owner, { devcontainer: true });
    const world = await startServer(withDev, daemon);
    try {
      const answer = await world.upgrade(`/v1.54/containers/${daemon.containerId}/attach?stream=1&stdout=1&stderr=1&evil=1`);
      expect(answer).toMatch(/^HTTP\/1\.1 403 /);
      const good = await world.upgrade(`/v1.54/containers/${daemon.containerId}/attach?stream=1&stdout=1&stderr=1`);
      expect(good).toMatch(/^HTTP\/1\.1 101 UPGRADED/);
      expect(daemon.requests.find((request) => request.url.includes("/attach"))!.url).toBe(`/containers/${daemon.containerId}/attach?stream=1&stdout=1&stderr=1`);
    } finally { await world.close(); }
    const foreign = await fakeDaemon("f".repeat(24), { devcontainer: true });
    const other = await startServer(withDev, foreign);
    try {
      expect(await other.upgrade(`/v1.54/containers/${foreign.containerId}/attach?stream=1`)).toMatch(/^HTTP\/1\.1 404 /);
      expect(foreign.requests.some((request) => request.url.includes("/attach"))).toBe(false);
    } finally { await other.close(); }
  });

  it("does not read a request pipelined behind an attach the daemon did not take over (answered 200 with the connection kept open)", async () => {
    const daemon = await fakeDaemon(owner, { devcontainer: true, attach: "plain" });
    const world = await startServer(withDev, daemon);
    try {
      const smuggled = "GET /containers/json?all=1 HTTP/1.1\r\nHost: x\r\n\r\nPOST /containers/create?name=escape HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 40\r\n\r\n{\"Image\":\"x\",\"HostConfig\":{\"Privileged\":1}}";
      const answer = await world.upgrade(`/v1.54/containers/${daemon.containerId}/attach?stream=1&stdout=1`, smuggled);
      expect(answer).toMatch(/^HTTP\/1\.1 200 /);
      expect(answer).not.toContain("101");
      expect(daemon.requests.map((request) => `${request.method} ${request.url.split("?")[0]}`)).toEqual([`GET /containers/${daemon.containerId}/json`, `POST /containers/${daemon.containerId}/attach`]);
    } finally { await world.close(); }
  });

  it("runs a command in a dev container as its own user, and in a sandbox as the sandbox user only", async () => {
    const dev = await fakeDaemon(owner, { devcontainer: true });
    const world = await startServer(withDev, dev);
    try {
      expect((await world.call("POST", `/v1.54/containers/${dev.containerId}/exec`, JSON.stringify({ AttachStdout: true, Cmd: ["id"], User: "vscode" }))).status).toBe(200);
      expect(JSON.parse(dev.requests.find((request) => request.url.endsWith("/exec"))!.body)).toMatchObject({ User: "vscode", Privileged: false });
    } finally { await world.close(); }
    const sandbox = await fakeDaemon(owner);
    const other = await startServer(withDev, sandbox);
    try {
      expect((await other.call("POST", `/v1.54/containers/${sandbox.containerId}/exec`, JSON.stringify({ AttachStdout: true, Cmd: ["id"], User: "vscode" }))).status).toBe(403);
    } finally { await other.close(); }
  });
});

describe("the guard and networks", () => {
  it("never connects, disconnects, creates or removes a network, so a dev container stays on the sandbox network alone", async () => {
    const dev = await fakeDaemon(owner, { devcontainer: true });
    const world = await startServer(withDev, dev);
    try {
      const before = dev.requests.length;
      const connect = JSON.stringify({ Container: dev.containerId, EndpointConfig: {} });
      for (const [method, path, body] of [
        ["POST", "/v1.54/networks/rovara-snet-dddd/connect", connect],
        ["POST", "/v1.54/networks/rovara-run-other/connect", connect],
        ["POST", `/v1.54/networks/${"d".repeat(64)}/connect`, connect],
        ["POST", "/v1.54/networks/rovara-run-other/disconnect", connect],
        ["POST", "/v1.54/networks/create", JSON.stringify({ Name: "x" })],
        ["DELETE", "/v1.54/networks/rovara-snet-dddd", undefined],
        ["GET", "/v1.54/networks", undefined],
        ["GET", "/v1.54/networks/rovara-run-other", undefined]
      ] as const) {
        expect((await world.call(method, path, body)).status, `${method} ${path}`).toBe(403);
      }
      expect(dev.requests.length).toBe(before);
    } finally { await world.close(); }
  });
});

describe("the guard with dev containers off (the owner listed no registry)", () => {
  it("answers as it always did: no pull, no event stream, no attach, no image but the worker's", async () => {
    const daemon = await fakeDaemon(owner, { devcontainer: true });
    const world = await startServer(basePolicy, daemon);
    try {
      expect((await world.call("POST", "/v1.54/images/create?fromImage=node&tag=20")).status).toBe(403);
      expect((await world.call("GET", "/v1.54/events")).status).toBe(403);
      expect((await world.call("GET", "/v1.54/images/node%3A20/json")).status).toBe(403);
      expect((await world.call("POST", "/v1.54/containers/create", JSON.stringify(cliBody()))).status).toBe(403);
      expect(await world.upgrade(`/v1.54/containers/${daemon.containerId}/attach?stream=1`)).toMatch(/^HTTP\/1\.1 403 /);
      expect(daemon.requests.filter((request) => !request.url.startsWith("/containers/json") && !/containers\/[^/]+\/json$/.test(request.url))).toEqual([]);
    } finally { await world.close(); }
  });
});
