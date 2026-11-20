/* eslint-disable @typescript-eslint/no-explicit-any --
   the guard tests build Docker API bodies as free-form objects and change one field at a time; the shape under test is whatever an attacker sends. */
// A project's dev container through the Docker socket guard of a local worker. The guard serves one only when the owner's policy lists registries, from a body it builds from nothing; this drives the very text that
// runs in the guard's container, as a library and as a server over a fake daemon.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { type Server } from "node:http";
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

});

// ---- the guard as a server, over a fake daemon

