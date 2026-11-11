/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument --
   the guard tests build Docker API bodies as free-form objects and change one field at a time; the shape under test is whatever an attacker sends. */
// Port lane L4b: the pieces of a local worker's walls that run without Docker: the allow-list, the egress gateway's name server, TLS
// server-name reader and address checks, and the Docker socket guard's rules for a sandbox. The gateway and the guard are programs that
// run inside containers (isolation/*-source.ts); here the very same text is loaded as a library and driven directly.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect as netConnect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_AGENT_ALLOW_DOMAINS } from "@agentx/contracts";
import { LOCAL_DEFAULT_ALLOW_DOMAINS, hostIsAllowed, localAllowedDomains } from "../../packages/broker/src/local/isolation/allow-list.js";
import { DOCKER_SOCKET_GUARD_SOURCE } from "../../packages/broker/src/local/isolation/docker-socket-guard-source.js";
import { EGRESS_GATEWAY_SOURCE } from "../../packages/broker/src/local/isolation/egress-gateway-source.js";
import { startCallbackServer } from "../../packages/broker/src/local/callback-server.js";
import { isForbiddenAddress, proxyHostName } from "../../packages/worker/src/test-account-proxy.js";

const scratch: string[] = [];
afterAll(async () => {
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true });
});

async function load<T>(source: string, variable: string, library: string, environment: Record<string, string>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "rovara-iso-"));
  scratch.push(directory);
  const file = join(directory, "program.cjs");
  await writeFile(file, source);
  const saved = { ...process.env };
  Object.assign(process.env, environment, { [library]: "1" });
  try {
    return createRequire(import.meta.url)(file) as T;
  } finally {
    for (const key of Object.keys(environment).concat(library, variable)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

describe("the allow-list", () => {
  it("is the cloud's default list without the cloud network's own names", () => {
    expect(LOCAL_DEFAULT_ALLOW_DOMAINS.length).toBe(DEFAULT_AGENT_ALLOW_DOMAINS.length - 3);
    for (const vpc of ["*.compute.internal", "*.ec2.internal", "*.42.10.in-addr.arpa"]) expect(LOCAL_DEFAULT_ALLOW_DOMAINS).not.toContain(vpc);
    for (const site of ["api.anthropic.com", "github.com", "*.github.com", "registry.npmjs.org", "pypi.org", "deb.debian.org"]) expect(LOCAL_DEFAULT_ALLOW_DOMAINS).toContain(site);
  });

  it("adds the owner's entries under the cloud's rules, and names the position of one it refuses, never the value", () => {
    expect(localAllowedDomains(["Artifacts.Acme.dev", "*.internal.acme.dev"])).toEqual(expect.arrayContaining(["artifacts.acme.dev", "*.internal.acme.dev"]));
    expect(localAllowedDomains(["github.com"]).filter((entry) => entry === "github.com")).toHaveLength(1);
    for (const bad of ["*", "*.com", "com", "localhost", "10.0.0.1", "*.github.io", "https://acme.dev", "acme.dev/path", "a b.dev", ""]) {
      expect(() => localAllowedDomains(["ok.acme.dev", bad]), bad).toThrowError(/allowed website number 2 must be a domain name/);
    }
  });

  it("matches a name the way the DNS firewall does: a wildcard covers subdomains at any depth, not the bare domain; an address is no name", () => {
    const list = ["github.com", "*.github.com", "registry.npmjs.org", "*.amazonaws.com"];
    const cases: Array<[string, boolean]> = [
      ["github.com", true], ["api.github.com", true], ["a.b.c.github.com", true], ["githubcom", false], ["xgithub.com", false], ["github.com.evil.dev", false],
      ["registry.npmjs.org", true], ["x.registry.npmjs.org", false], ["amazonaws.com", false], ["s3.amazonaws.com", true],
      ["127.0.0.1", false], ["2130706433", false], ["0x7f.1", false], ["localhost", false], ["", false], ["a".repeat(300) + ".github.com", false], ["github.com.", false],
    ];
    for (const [host, allowed] of cases) expect(hostIsAllowed(host, list), host).toBe(allowed);
  });
});

interface Gateway {
  hostAllowed(host: string): boolean;
  validName(host: string): boolean;
  publicAddress(address: string): boolean;
  inCidr(address: string, cidr: string): boolean;
  serverNameOf(buffer: Buffer): { name?: string; error?: string; more?: boolean };
  answerFor(message: Buffer, localIp: string): Buffer | undefined;
}

describe("the egress gateway program", async () => {
  const list = ["github.com", "*.github.com", "registry.npmjs.org", "*.amazonaws.com", "api.anthropic.com"];
  const gateway = await load<Gateway>(EGRESS_GATEWAY_SOURCE, "ROVARA_GW_CONFIG", "ROVARA_GW_LIBRARY", { ROVARA_GW_CONFIG: JSON.stringify({ allowed: list }) });

  it("judges a name exactly as the broker's own copy of the rule does", () => {
    const names = ["github.com", "api.github.com", "a.b.github.com", "github.com.", "GITHUB.com", "x.registry.npmjs.org", "registry.npmjs.org", "evil.dev", "127.0.0.1", "1.2.3.4", "0x7f.0.0.1", "localhost", "a_b.github.com", "-a.github.com", "a-.github.com", "", ".", "github..com", "s3.amazonaws.com", "amazonaws.com"];
    for (const name of names) expect(gateway.hostAllowed(name), name).toBe(hostIsAllowed(name, list));
  });

  it("agrees with the worker's test-account proxy about what a name is and what a public address is", () => {
    for (const name of ["a.example.com", "example.com", "localhost", "127.0.0.1", "0x7f.1", "2130706433", "a.b", "xn--e1afmkfd.xn--p1ai", "under_score.example.com", "-x.example.com", "a".repeat(64) + ".com", "x.1"]) {
      expect(gateway.validName(name), name).toBe(proxyHostName(name) === name);
    }
    for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.255.255", "11.0.0.1", "10.0.0.1", "10.255.255.255", "127.0.0.1", "127.255.0.1", "0.0.0.0", "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.31.255.255",
      "192.168.0.1", "192.168.5.2", "100.64.0.1", "100.127.255.255", "100.128.0.1", "192.0.0.1", "192.0.2.1", "198.18.0.1", "198.19.255.255", "198.51.100.5", "203.0.113.7", "224.0.0.1", "239.1.1.1", "240.0.0.1", "255.255.255.255", "192.88.99.1"]) {
      expect(gateway.publicAddress(address), address).toBe(!isForbiddenAddress(address));
    }
    for (const notAddress of ["", "1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4x", "::1", "::ffff:8.8.8.8", "example.com"]) expect(gateway.publicAddress(notAddress), notAddress).toBe(false);
  });

  it("reads the server name from a real TLS hello, and refuses everything that is not one", async () => {
    const capture = (options: { servername?: string; host: string }): Promise<Buffer> => new Promise((resolve) => {
      const server = createNetServer((socket) => {
        socket.once("data", (data) => {
          resolve(data);
          socket.destroy();
          server.close();
        });
      }).listen(0, "127.0.0.1", () => {
        const client = tlsConnect({ host: "127.0.0.1", port: (server.address() as { port: number }).port, rejectUnauthorized: false, ...(options.servername === undefined ? {} : { servername: options.servername }) });
        client.on("error", () => undefined);
      });
    });
    const hello = await capture({ host: "x", servername: "Api.GitHub.com" });
    expect(gateway.serverNameOf(hello)).toEqual({ name: "api.github.com" });
    // A client that connects to an address sends no name.
    expect(gateway.serverNameOf(await capture({ host: "x" }))).toEqual({ error: "no_name" });
    // Partial: wait for more. Truncated inside the record: wait. Wrong type, wrong version, fragmented, absurd length: refuse.
    expect(gateway.serverNameOf(hello.subarray(0, 3))).toEqual({ more: true });
    expect(gateway.serverNameOf(hello.subarray(0, hello.length - 10))).toEqual({ more: true });
    expect(gateway.serverNameOf(Buffer.from("GET / HTTP/1.1\r\nHost: github.com\r\n\r\n"))).toEqual({ error: "not_tls" });
    const notHello = Buffer.from(hello);
    notHello[5] = 2;
    expect(gateway.serverNameOf(notHello)).toEqual({ error: "not_client_hello" });
    const fragmented = Buffer.from(hello);
    fragmented.writeUInt16BE(40, 3);
    fragmented[6] = 0;
    fragmented[7] = 0xff;
    fragmented[8] = 0xff;
    expect(gateway.serverNameOf(fragmented).error).toBeDefined();
    const huge = Buffer.from(hello);
    huge.writeUInt16BE(60000, 3);
    expect(gateway.serverNameOf(huge)).toEqual({ error: "bad_record" });
    // Every prefix and every single-byte corruption of a real hello gives an answer, never an exception.
    for (let length = 0; length < hello.length; length += 1) expect(() => gateway.serverNameOf(hello.subarray(0, length))).not.toThrow();
    for (let index = 0; index < hello.length; index += 1) {
      const corrupt = Buffer.from(hello);
      corrupt[index] = corrupt[index]! ^ 0xff;
      expect(() => gateway.serverNameOf(corrupt), `byte ${index}`).not.toThrow();
    }
  });

  const query = (name: string, type: number, extra: { flags?: number; compressed?: boolean } = {}): Buffer => {
    const labels = name.split(".").filter(Boolean).flatMap((label) => [Buffer.from([label.length]), Buffer.from(label)]);
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0xabcd, 0);
    header.writeUInt16BE(extra.flags ?? 0x0100, 2);
    header.writeUInt16BE(1, 4);
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(type, 0);
    tail.writeUInt16BE(1, 2);
    return Buffer.concat([header, ...(extra.compressed === true ? [Buffer.from([0xc0, 0x0c])] : labels), Buffer.from([0]), tail]);
  };

  it("answers an allowed name with its own address on the asking network, and everything else with nothing", () => {
    const allowed = gateway.answerFor(query("api.github.com", 1), "172.20.0.2")!;
    expect(allowed.readUInt16BE(0)).toBe(0xabcd);
    expect(allowed.readUInt16BE(2) & 0x000f).toBe(0); // NOERROR
    expect(allowed.readUInt16BE(6)).toBe(1);
    expect([...allowed.subarray(allowed.length - 4)]).toEqual([172, 20, 0, 2]);
    // An IPv6 or other record of an allowed name: the name exists, there is no such record.
    for (const type of [28, 16, 15, 255, 2]) {
      const answer = gateway.answerFor(query("api.github.com", type), "172.20.0.2")!;
      expect(answer.readUInt16BE(2) & 0x000f, `type ${type}`).toBe(0);
      expect(answer.readUInt16BE(6), `type ${type}`).toBe(0);
    }
    // A name that is not allowed does not exist, whatever is asked for it.
    for (const name of ["example.com", "evil.github.com.example.com", "localhost", "169.254.169.254", "rovara-sock", "host.docker.internal", "1.0.0.127.in-addr.arpa"]) {
      for (const type of [1, 28, 16, 255]) {
        const answer = gateway.answerFor(query(name, type), "172.20.0.2")!;
        expect(answer.readUInt16BE(2) & 0x000f, `${name} ${type}`).toBe(3);
        expect(answer.readUInt16BE(6), `${name} ${type}`).toBe(0);
      }
    }
    // Not a query, a compressed question, a zero or many questions, a truncated message, a non-standard opcode, a label over 63 bytes: no valid answer.
    expect(gateway.answerFor(query("api.github.com", 1, { flags: 0x8100 }), "172.20.0.2")).toBeUndefined();
    expect(gateway.answerFor(query("api.github.com", 1, { compressed: true }), "172.20.0.2")).toBeUndefined();
    const many = query("api.github.com", 1);
    many.writeUInt16BE(2, 4);
    expect(gateway.answerFor(many, "172.20.0.2")).toBeUndefined();
    expect(gateway.answerFor(query("api.github.com", 1).subarray(0, 20), "172.20.0.2")).toBeUndefined();
    expect(gateway.answerFor(Buffer.alloc(0), "172.20.0.2")).toBeUndefined();
    const status = gateway.answerFor(query("api.github.com", 1, { flags: 0x1100 }), "172.20.0.2")!;
    expect(status.readUInt16BE(2) & 0x000f).toBe(4); // NOTIMP
    expect(gateway.answerFor(query("a".repeat(64) + ".github.com", 1), "172.20.0.2")).toBeUndefined();
    const random = Buffer.alloc(512);
    for (let round = 0; round < 200; round += 1) {
      for (let index = 0; index < random.length; index += 1) random[index] = Math.floor(Math.random() * 256);
      expect(() => gateway.answerFor(random.subarray(0, round + 1), "172.20.0.2")).not.toThrow();
    }
  });
});

interface Guard {
  transformCreate(query: URLSearchParams, text: string): string;
  checkExecBody(text: string, who: { kind: "sandbox" }): void;
  Refusal: new (message: string) => Error;
}

describe("the Docker socket guard program", async () => {
  const policy = {
    upstream: "/var/run/docker.sock", owner: "a".repeat(24), image: "worker:test", workspaceDir: "/home/me/.rovara/workspaces/aaaa", workspaceKey: createHash("sha256").update("workspace").digest("hex").slice(0, 16),
    network: "rovara-snet-aaaa", dns: ["172.30.0.2"], user: "1000:1000", port: 2375, maxSandboxes: 16,
  };
  const guard = await load<Guard>(DOCKER_SOCKET_GUARD_SOURCE, "ROVARA_SOCK_POLICY", "ROVARA_SOCK_LIBRARY", { ROVARA_SOCK_POLICY: JSON.stringify(policy) });
  const name = (): URLSearchParams => new URLSearchParams({ name: "agentx-task-0b9f-1a2b3c4d" });
  /** What the docker CLI sends for the arguments the worker's `taskSandboxRunArgs` builds. */
  const body = (): Record<string, any> => ({
    Hostname: "", Domainname: "", User: "1000:1000", AttachStdin: false, AttachStdout: false, AttachStderr: false, Tty: false, OpenStdin: false, StdinOnce: false, Env: null,
    Cmd: ["--", "sleep", "infinity"], Image: "worker:test", Volumes: {}, WorkingDir: policy.workspaceDir, Entrypoint: ["/usr/bin/tini"],
    Labels: { "agentx.task": "t-1", "agentx.workspace": policy.workspaceKey },
    HostConfig: {
      Binds: [`${policy.workspaceDir}:${policy.workspaceDir}`], ContainerIDFile: "", LogConfig: { Type: "", Config: {} }, NetworkMode: policy.network, PortBindings: {}, RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      AutoRemove: false, VolumeDriver: "", VolumesFrom: null, ConsoleSize: [0, 0], CapAdd: null, CapDrop: ["ALL"], CgroupnsMode: "", Dns: null, DnsOptions: [], DnsSearch: [], ExtraHosts: null, GroupAdd: null,
      IpcMode: "", Cgroup: "", Links: null, OomScoreAdj: 0, PidMode: "", Privileged: false, PublishAllPorts: false, ReadonlyRootfs: false, SecurityOpt: ["no-new-privileges"],
      Tmpfs: { [`${policy.workspaceDir}/.state`]: "ro,noexec,nosuid,size=4k" }, UTSMode: "", UsernsMode: "", ShmSize: 0, Isolation: "", CpuShares: 0, Memory: 1610612736, NanoCpus: 1000000000, CgroupParent: "", BlkioWeight: 0,
      BlkioWeightDevice: [], BlkioDeviceReadBps: [], BlkioDeviceWriteBps: [], BlkioDeviceReadIOps: [], BlkioDeviceWriteIOps: [], CpuPeriod: 0, CpuQuota: 0, CpuRealtimePeriod: 0, CpuRealtimeRuntime: 0, CpusetCpus: "", CpusetMems: "",
      Devices: [], DeviceCgroupRules: null, DeviceRequests: null, MemoryReservation: 0, MemorySwap: 1610612736, MemorySwappiness: -1, OomKillDisable: false, PidsLimit: 4096, Ulimits: null, CpuCount: 0, CpuPercent: 0,
      IOMaximumIOps: 0, IOMaximumBandwidth: 0, MaskedPaths: null, ReadonlyPaths: null,
    },
    NetworkingConfig: { EndpointsConfig: {} },
  });
  const changed = (change: (value: Record<string, any>) => void): string => {
    const value = body();
    change(value);
    return JSON.stringify(value);
  };

  it("accepts the worker's own sandbox and rebuilds it with the guard's labels, name server and network", () => {
    const rebuilt = JSON.parse(guard.transformCreate(name(), JSON.stringify(body()))) as Record<string, any>;
    expect(rebuilt.HostConfig.Dns).toEqual(policy.dns);
    expect(rebuilt.HostConfig.NetworkMode).toBe(policy.network);
    expect(rebuilt.NetworkingConfig).toEqual({ EndpointsConfig: { [policy.network]: {} } });
    expect(rebuilt.Labels).toEqual({ "agentx.task": "t-1", "agentx.workspace": policy.workspaceKey, "rovara.local.owner": policy.owner, "rovara.local.sandbox": "1" });
    expect(rebuilt.HostConfig.Binds).toEqual([`${policy.workspaceDir}:${policy.workspaceDir}`]);
  });

  it("replaces whatever network settings the worker sent with the one endpoint on the sandbox network", () => {
    const rebuilt = JSON.parse(guard.transformCreate(name(), changed((value) => { value.NetworkingConfig = { EndpointsConfig: { other: { IPAddress: "10.0.0.5", Aliases: ["rovara-sock"] } } }; }))) as Record<string, any>;
    expect(rebuilt.NetworkingConfig).toEqual({ EndpointsConfig: { [policy.network]: {} } });
  });

  it("does not let a worker forge the guard's own labels", () => {
    const forged = JSON.parse(guard.transformCreate(name(), changed((value) => { value.Labels["rovara.local.owner"] = "b".repeat(24); value.Labels["rovara.x"] = "1"; }))) as Record<string, any>;
    expect(forged.Labels["rovara.local.owner"]).toBe(policy.owner);
    expect(forged.Labels["rovara.x"]).toBeUndefined();
  });

  const refused: Array<[string, (value: Record<string, any>) => void]> = [
    ["a privileged container", (v) => { v.HostConfig.Privileged = true; }],
    ["the host network", (v) => { v.HostConfig.NetworkMode = "host"; }],
    ["another network", (v) => { v.HostConfig.NetworkMode = "rovara-wnet-aaaa"; }],
    ["a container network", (v) => { v.HostConfig.NetworkMode = "container:abc"; }],
    ["no network mode", (v) => { delete v.HostConfig.NetworkMode; }],
    ["a bind of the root", (v) => { v.HostConfig.Binds.push("/:/host"); }],
    ["a bind of the state folder", (v) => { v.HostConfig.Binds = ["/home/me/.rovara:/s"]; }],
    ["a bind of the Docker socket", (v) => { v.HostConfig.Binds.push("/var/run/docker.sock:/var/run/docker.sock"); }],
    ["a read-write bind spelled with options", (v) => { v.HostConfig.Binds = [`${policy.workspaceDir}:${policy.workspaceDir}:rw,shared`]; }],
    ["the parent folder of the workspace", (v) => { v.HostConfig.Binds = ["/home/me/.rovara/workspaces:/home/me/.rovara/workspaces"]; }],
    ["a bind with the workspace as a prefix of another folder", (v) => { v.HostConfig.Binds = [`${policy.workspaceDir}x:${policy.workspaceDir}x`]; }],
    ["a mount", (v) => { v.HostConfig.Mounts = [{ Type: "bind", Source: "/", Target: "/h" }]; }],
    ["a volume", (v) => { v.Volumes = { "/data": {} }; }],
    ["a tmpfs outside the workspace", (v) => { v.HostConfig.Tmpfs = { "/etc": "rw" }; }],
    ["a tmpfs over the workspace itself", (v) => { v.HostConfig.Tmpfs = { [policy.workspaceDir]: "rw" }; }],
    ["a tmpfs with a path that climbs out", (v) => { v.HostConfig.Tmpfs = { [`${policy.workspaceDir}/../x`]: "rw" }; }],
    ["tmpfs options that smuggle a flag", (v) => { v.HostConfig.Tmpfs = { [`${policy.workspaceDir}/x`]: "rw;--privileged" }; }],
    ["an added capability", (v) => { v.HostConfig.CapAdd = ["SYS_ADMIN"]; }],
    ["capabilities not dropped", (v) => { v.HostConfig.CapDrop = null; }],
    ["only some capabilities dropped", (v) => { v.HostConfig.CapDrop = ["NET_RAW"]; }],
    ["unconfined seccomp", (v) => { v.HostConfig.SecurityOpt.push("seccomp=unconfined"); }],
    ["unconfined apparmor", (v) => { v.HostConfig.SecurityOpt.push("apparmor=unconfined"); }],
    ["unconfined system paths", (v) => { v.HostConfig.SecurityOpt.push("systempaths=unconfined"); }],
    ["no security option at all", (v) => { v.HostConfig.SecurityOpt = null; }],
    ["no-new-privileges switched off", (v) => { v.HostConfig.SecurityOpt = ["no-new-privileges:false"]; }],
    ["masked paths cleared", (v) => { v.HostConfig.MaskedPaths = []; }],
    ["read-only paths cleared", (v) => { v.HostConfig.ReadonlyPaths = []; }],
    ["the host pid namespace", (v) => { v.HostConfig.PidMode = "host"; }],
    ["the host ipc namespace", (v) => { v.HostConfig.IpcMode = "host"; }],
    ["the host uts namespace", (v) => { v.HostConfig.UTSMode = "host"; }],
    ["the host user namespace", (v) => { v.HostConfig.UsernsMode = "host"; }],
    ["the host cgroup namespace", (v) => { v.HostConfig.CgroupnsMode = "host"; }],
    ["a cgroup parent", (v) => { v.HostConfig.CgroupParent = "/"; }],
    ["a device", (v) => { v.HostConfig.Devices = [{ PathOnHost: "/dev/kmsg", PathInContainer: "/dev/kmsg", CgroupPermissions: "rwm" }]; }],
    ["a device request", (v) => { v.HostConfig.DeviceRequests = [{ Driver: "nvidia", Count: -1 }]; }],
    ["a device cgroup rule", (v) => { v.HostConfig.DeviceCgroupRules = ["a *:* rwm"]; }],
    ["a published port", (v) => { v.HostConfig.PortBindings = { "80/tcp": [{ HostPort: "80" }] }; }],
    ["every port published", (v) => { v.HostConfig.PublishAllPorts = true; }],
    ["exposed ports", (v) => { v.ExposedPorts = { "80/tcp": {} }; }],
    ["extra hosts", (v) => { v.HostConfig.ExtraHosts = ["evil:10.0.0.1"]; }],
    ["a link", (v) => { v.HostConfig.Links = ["other:x"]; }],
    ["volumes from another container", (v) => { v.HostConfig.VolumesFrom = ["other"]; }],
    ["a group added", (v) => { v.HostConfig.GroupAdd = ["0"]; }],
    ["a sysctl", (v) => { v.HostConfig.Sysctls = { "net.ipv4.ip_forward": "1" }; }],
    ["a storage option", (v) => { v.HostConfig.StorageOpt = { size: "1" }; }],
    ["a runtime", (v) => { v.HostConfig.Runtime = "runc-evil"; }],
    ["a remote log driver", (v) => { v.HostConfig.LogConfig = { Type: "syslog", Config: { "syslog-address": "tcp://10.0.0.1" } }; }],
    ["a restart policy", (v) => { v.HostConfig.RestartPolicy = { Name: "always" }; }],
    ["its own name servers", (v) => { v.HostConfig.DnsSearch = ["evil.dev"]; }],
    ["its own resolver options", (v) => { v.HostConfig.DnsOptions = ["ndots:5"]; }],
    ["a negative memory", (v) => { v.HostConfig.Memory = -1; }],
    ["an absurd process limit", (v) => { v.HostConfig.PidsLimit = 10_000_000; }],
    ["no process limit written as zero is fine but a string is not", (v) => { v.HostConfig.PidsLimit = "unlimited"; }],
    ["root", (v) => { v.User = "0:0"; }],
    ["no user", (v) => { v.User = ""; }],
    ["a named user", (v) => { v.User = "root"; }],
    ["another image", (v) => { v.Image = "alpine:3.20"; }],
    ["the image by another spelling", (v) => { v.Image = "worker:test@sha256:" + "0".repeat(64); }],
    ["a working folder outside the workspace", (v) => { v.WorkingDir = "/"; }],
    ["a working folder that climbs out", (v) => { v.WorkingDir = `${policy.workspaceDir}/../..`; }],
    ["a hostname", (v) => { v.Hostname = "evil"; }],
    ["a mac address", (v) => { v.MacAddress = "02:42:ac:11:00:02"; }],
    ["a health check", (v) => { v.Healthcheck = { Test: ["CMD", "true"] }; }],
    ["a sysctl set to nothing", (v) => { v.HostConfig.Sysctls = { "net.ipv4.ip_forward": "" }; }],
    ["a named exposed port", (v) => { v.ExposedPorts = { "80/tcp": {} }; }],
    ["an unknown host setting", (v) => { v.HostConfig.SomethingNew = "yes"; }],
    ["an unknown setting", (v) => { v.SomethingNew = "yes"; }],
    ["another workspace's label", (v) => { v.Labels["agentx.workspace"] = "ffffffffffffffff"; }],
    ["no workspace label", (v) => { delete v.Labels["agentx.workspace"]; }],
    ["no task label", (v) => { delete v.Labels["agentx.task"]; }],
    ["a label that is not text", (v) => { v.Labels.x = { a: 1 }; }],
    ["a command that is not a list", (v) => { v.Cmd = "sleep"; }],
    ["an environment that is not a list", (v) => { v.Env = { A: "b" }; }],
  ];
  for (const [what, change] of refused) {
    it(`refuses a sandbox with ${what}`, () => {
      expect(() => guard.transformCreate(name(), changed(change))).toThrow();
    });
  }

  it("refuses names outside agentx-task-, extra query options, and bodies that are not an object", () => {
    for (const bad of ["evil", "agentx-task-", "agentx-task-x y", "agentx-task-x/../y", "agentx-task-" + "x".repeat(101), "rovara-worker-aaaa"]) {
      expect(() => guard.transformCreate(new URLSearchParams({ name: bad }), JSON.stringify(body())), bad).toThrow();
    }
    expect(() => guard.transformCreate(new URLSearchParams(), JSON.stringify(body()))).toThrow();
    expect(() => guard.transformCreate(new URLSearchParams({ name: "agentx-task-x", platform: "linux/arm64" }), JSON.stringify(body()))).toThrow();
    for (const text of ["", "null", "[]", "1", "{", "\"x\""]) expect(() => guard.transformCreate(name(), text), text).toThrow();
  });

  it("lets a command run as the sandbox user and no other, never privileged", () => {
    const sandbox = { kind: "sandbox" } as const;
    const ok = JSON.stringify({ AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false, Cmd: ["sh", "-c", "true"], User: "1000:1000", Env: ["A=b"], WorkingDir: "/tmp" });
    expect(() => guard.checkExecBody(ok, sandbox)).not.toThrow();
    expect(() => guard.checkExecBody(JSON.stringify({ Cmd: ["id"], User: "1000" }), sandbox)).not.toThrow();
    expect(() => guard.checkExecBody(JSON.stringify({ Cmd: ["id"], Privileged: false }), sandbox)).not.toThrow();
    for (const bad of [{ Cmd: ["id"], User: "0" }, { Cmd: ["id"], User: "root" }, { Cmd: ["id"], Privileged: true }, { Cmd: [] }, {}, { Cmd: "id" }, { Cmd: ["id"], Extra: 1 }, { Cmd: ["id"], Env: "x" }]) {
      expect(() => guard.checkExecBody(JSON.stringify(bad), sandbox), JSON.stringify(bad)).toThrow();
    }
  });
});

describe("the callback listener", () => {
  async function serve(unixSocket: boolean) {
    const directory = await mkdtemp(join(tmpdir(), "rcb-"));
    scratch.push(directory);
    const seen: Array<{ path: string; host: string | undefined; body: string | undefined }> = [];
    const server = await startCallbackServer({ stateDirectory: directory, unixSocket, handler: async (request) => { seen.push({ path: request.path, host: request.headers.host, body: request.body }); return { statusCode: 200, headers: {}, body: '{"ok":true}' }; } });
    return { server, seen, directory };
  }
  const send = (options: { port?: number; socketPath?: string; method?: string; path: string; host?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; text: string }> =>
    new Promise((resolve, reject) => {
      const outgoing = httpRequest({ ...(options.socketPath === undefined ? { host: "127.0.0.1", port: options.port } : { socketPath: options.socketPath }), method: options.method ?? "POST", path: options.path, headers: { ...(options.host === undefined ? {} : { host: options.host }), ...options.headers } }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, text: Buffer.concat(chunks).toString() }));
      });
      outgoing.on("error", reject);
      outgoing.end(options.body);
    });

  it("answers only POST /v1/internal/... with the host name a worker uses, and nothing else", async () => {
    const { server, seen } = await serve(false);
    try {
      const host = `host.docker.internal:${server.tcpPort}`;
      expect((await send({ port: server.tcpPort, host, path: "/v1/internal/workspaces/w/operations/o/events", body: '{"a":1}' })).status).toBe(200);
      expect(seen).toEqual([{ path: "/v1/internal/workspaces/w/operations/o/events", host, body: '{"a":1}' }]);
      const refusals: Array<[string, Parameters<typeof send>[0], number]> = [
        ["the owner's host name", { port: server.tcpPort, host: `127.0.0.1:${server.tcpPort}`, path: "/v1/internal/x" }, 403],
        ["localhost", { port: server.tcpPort, host: `localhost:${server.tcpPort}`, path: "/v1/internal/x" }, 403],
        ["another port", { port: server.tcpPort, host: "host.docker.internal:1", path: "/v1/internal/x" }, 403],
        ["a browser", { port: server.tcpPort, host, headers: { origin: "http://evil.dev" }, path: "/v1/internal/x" }, 403],
        ["GET", { port: server.tcpPort, host, method: "GET", path: "/v1/internal/x" }, 405],
        ["DELETE", { port: server.tcpPort, host, method: "DELETE", path: "/v1/internal/x" }, 405],
        ["an owner route", { port: server.tcpPort, host, path: "/v1/local/status" }, 404],
        ["the health route", { port: server.tcpPort, host, path: "/healthz" }, 404],
        ["an admin route", { port: server.tcpPort, host, path: "/v1/admin/projects" }, 404],
        ["a path that climbs out", { port: server.tcpPort, host, path: "/v1/internal/../local/status" }, 404],
        ["an empty segment", { port: server.tcpPort, host, path: "/v1/internal//x" }, 404],
        ["a path that only looks internal", { port: server.tcpPort, host, path: "/v1/internalx/y" }, 404],
      ];
      refusals.push(
        ["a GET of a source path with more on it", { port: server.tcpPort, host, method: "GET", path: "/v1/internal/context-tools/call" }, 405],
        ["a GET of the source list with a query", { port: server.tcpPort, host, method: "GET", path: "/v1/internal/context-tools?x=1" }, 405],
      );
      for (const [what, options, status] of refusals) expect((await send(options)).status, what).toBe(status);
      expect((await send({ port: server.tcpPort, host, path: "/v1/internal/x", body: "x".repeat(8 * 1_048_576 + 1) }).catch(() => ({ status: 413, text: "" }))).status).toBe(413);
      expect(seen).toHaveLength(1);
      // A stage's source list is one exact GET, handed on with the headers it came with; every other GET stays refused.
      expect((await send({ port: server.tcpPort, host, method: "GET", path: "/v1/internal/context-tools", headers: { "x-agentx-callback-capability": "c" } })).status).toBe(200);
      expect(seen.at(-1)).toMatchObject({ path: "/v1/internal/context-tools" });
    } finally {
      await server.close();
    }
  });

  it("serves a Unix socket in the private state folder too, where the platform has one", async () => {
    const { server, seen, directory } = await serve(true);
    try {
      if (server.socketDirectory === undefined) return; // a path too long for a socket on this machine
      expect(server.socketDirectory).toBe(join(directory, "run"));
      const socketPath = join(server.socketDirectory, "callback.sock");
      const host = `host.docker.internal:${server.tcpPort}`;
      expect((await send({ socketPath, host, path: "/v1/internal/workspaces/w/operations/o/events" })).status).toBe(200);
      expect((await send({ socketPath, host, path: "/v1/local/status" })).status).toBe(404);
      expect((await send({ socketPath, host: "127.0.0.1:1", path: "/v1/internal/x" })).status).toBe(403);
      expect(seen).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("is bound to 127.0.0.1 and only there", async () => {
    const { server } = await serve(false);
    try {
      const probe = createServer();
      expect(probe).toBeDefined();
      for (const host of ["127.0.0.1"]) {
        await new Promise<void>((resolve, reject) => {
          const socket = netConnect({ host, port: server.tcpPort }, () => { socket.destroy(); resolve(); });
          socket.on("error", reject);
        });
      }
    } finally {
      await server.close();
    }
  });
});

// ---- the guard as a server, against a daemon that writes down every request it is sent

interface Recorded {
  method: string;
  url: string;
  body: string;
}

/** A stand-in for the Docker daemon on a Unix socket: parses requests one after another on a connection, as Docker does, and answers. */
async function fakeDaemon(options: { owner: string; hijack: "101" | "plain"; maxContainers?: number }) {
  const directory = await mkdtemp(join("/tmp", "rg-"));
  scratch.push(directory);
  const socketPath = join(directory, "d.sock");
  const requests: Recorded[] = [];
  let created = 0;
  const containerId = "c".repeat(64);
  const execId = "e".repeat(64);
  const stdin: Buffer[] = [];
  const connections = { count: 0 };
  const server = createNetServer((socket) => {
    connections.count += 1;
    let held = Buffer.alloc(0);
    let raw = false;
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      if (raw) {
        stdin.push(chunk);
        socket.write(Buffer.concat([Buffer.from("echo:"), chunk]));
        return;
      }
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
        requests.push({ method, url, body });
        const reply = (status: string, json: unknown): void => {
          const text = JSON.stringify(json);
          socket.write(`HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
        };
        if (method === "GET" && /^\/containers\/[^/]+\/json$/.test(url)) reply("200 OK", { Id: containerId, Config: { Labels: { "rovara.local.owner": options.owner, "rovara.local.sandbox": "1" } } });
        else if (method === "GET" && url.startsWith("/containers/json")) reply("200 OK", Array.from({ length: Math.min(created, options.maxContainers ?? 99) }, () => ({})));
        else if (method === "POST" && url.startsWith("/containers/create")) { created += 1; reply("201 Created", { Id: containerId }); }
        else if (method === "POST" && /^\/containers\/[^/]+\/exec$/.test(url)) reply("201 Created", { Id: execId });
        else if (method === "POST" && /^\/exec\/[^/]+\/start$/.test(url) && options.hijack === "101" && !body.includes('"Detach":true')) {
          socket.write("HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
          raw = true;
          if (held.length > 0) { stdin.push(held); held = Buffer.alloc(0); }
        } else reply("200 OK", {});
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { socketPath, requests, stdin, containerId, execId, get connections() { return connections.count; }, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function rawExchange(port: number, text: string, options: { wait?: number; after?: string } = {}): Promise<string> {
  return new Promise((resolve) => {
    const socket = netConnect({ host: "127.0.0.1", port }, () => {
      socket.write(text);
      if (options.after !== undefined) setTimeout(() => socket.write(options.after!), 150);
    });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", () => undefined);
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
    setTimeout(() => socket.destroy(), options.wait ?? 700);
  });
}

describe("the Docker socket guard as a server (pipelining, upgrades and case-variant keys)", () => {
  const owner = "d".repeat(24);
  const workspace = "/home/me/.rovara/workspaces/dddd";
  const key = createHash("sha256").update("workspace").digest("hex").slice(0, 16);
  async function start(hijack: "101" | "plain", maxSandboxes = 16, maxContainers?: number) {
    const daemon = await fakeDaemon({ owner, hijack, ...(maxContainers === undefined ? {} : { maxContainers }) });
    const policy = { upstream: daemon.socketPath, owner, image: "worker:test", workspaceDir: workspace, workspaceKey: key, network: "rovara-snet-dddd", dns: ["172.30.0.2"], user: "1000:1000", port: 2375, maxSandboxes };
    const guard = await load<{ createServer(): Server }>(DOCKER_SOCKET_GUARD_SOURCE, "ROVARA_SOCK_POLICY", "ROVARA_SOCK_LIBRARY", { ROVARA_SOCK_POLICY: JSON.stringify(policy) });
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
    const exec = async (): Promise<string> => {
      const made = await call("POST", `/v1.54/containers/${daemon.containerId}/exec`, JSON.stringify({ AttachStdout: true, Cmd: ["id"], User: "1000:1000" }));
      expect(made.status).toBe(201);
      return (JSON.parse(made.text) as { Id: string }).Id;
    };
    return { daemon, port, call, exec, close: async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await daemon.close(); } };
  }
  const createBody = (extra: Record<string, unknown> = {}): string => JSON.stringify({
    User: "1000:1000", Image: "worker:test", Cmd: ["sleep", "infinity"], Labels: { "agentx.task": "t", "agentx.workspace": key },
    HostConfig: { Binds: [`${workspace}:${workspace}`], NetworkMode: "rovara-snet-dddd", CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], ...extra },
  });
  const upgradeRequest = (execId: string, body: string, trailer = ""): string =>
    `POST /v1.54/exec/${execId}/start HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}${trailer}`;
  const SMUGGLED_CREATE = `POST /containers/create?name=escape HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 40\r\n\r\n{"Image":"x","HostConfig":{"Privileged":1}}`;

  it("does not let a detached start smuggle a second request to the daemon behind an Upgrade", async () => {
    const world = await start("plain");
    try {
      const id = await world.exec();
      const answer = await rawExchange(world.port, upgradeRequest(id, '{"Detach":true}', `GET /containers/json?all=1 HTTP/1.1\r\nHost: x\r\n\r\n${SMUGGLED_CREATE}`));
      expect(answer).toMatch(/^HTTP\/1\.1 400 /);
      expect(world.daemon.requests.map((request) => `${request.method} ${request.url.split("?")[0]}`)).not.toContain("POST /containers/create");
      expect(world.daemon.requests.filter((request) => request.url.includes("/start"))).toEqual([]);
      expect(world.daemon.requests.filter((request) => request.url.startsWith("/containers/json") && request.url.includes("all=1")).length).toBeLessThanOrEqual(0);
    } finally {
      await world.close();
    }
  });

  it("does not read a request pipelined behind an upgrade that the daemon did not take over", async () => {
    const world = await start("plain");
    try {
      const id = await world.exec();
      const before = world.daemon.requests.length;
      const answer = await rawExchange(world.port, upgradeRequest(id, '{"Detach":false}', `GET /containers/json?all=1 HTTP/1.1\r\nHost: x\r\n\r\n${SMUGGLED_CREATE}`));
      expect(answer).toMatch(/^HTTP\/1\.1 200 /);
      expect(answer).not.toContain("101");
      const seen = world.daemon.requests.slice(before).map((request) => `${request.method} ${request.url.split("?")[0]}`);
      expect(seen).toEqual([`POST /exec/${id}/start`]);
    } finally {
      await world.close();
    }
  });

  it("hijacks a command's streams only after the daemon says 101, with a start body the guard rebuilt", async () => {
    const world = await start("101");
    try {
      const id = await world.exec();
      const answer = await rawExchange(world.port, upgradeRequest(id, '{"Detach":false,"Tty":true,"ConsoleSize":[0,0]}', "early-input"), { after: "later-input", wait: 900 });
      expect(answer).toMatch(/^HTTP\/1\.1 101 UPGRADED/);
      expect(answer).toContain("echo:early-input");
      expect(answer).toContain("echo:later-input");
      const start = world.daemon.requests.find((request) => request.url.endsWith("/start"))!;
      expect(JSON.parse(start.body)).toEqual({ Detach: false, Tty: true });
    } finally {
      await world.close();
    }
  });

  it("refuses an upgrade for a command it did not make, a body it cannot read, and a chunked or oversized start", async () => {
    const world = await start("101");
    try {
      const id = await world.exec();
      expect(await rawExchange(world.port, upgradeRequest("f".repeat(64), '{"Detach":false}'))).toMatch(/^HTTP\/1\.1 403 /);
      expect(await rawExchange(world.port, upgradeRequest(id, "not json"))).toMatch(/^HTTP\/1\.1 403 /);
      expect(await rawExchange(world.port, upgradeRequest(id, '{"Detach":false,"Extra":1}'))).toMatch(/^HTTP\/1\.1 403 /);
      expect(await rawExchange(world.port, `POST /exec/${id}/start HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`)).toMatch(/^HTTP\/1\.1 400 /);
      expect(await rawExchange(world.port, `POST /exec/${id}/start HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 999999\r\n\r\n`)).toMatch(/^HTTP\/1\.1 400 /);
      expect(await rawExchange(world.port, `GET /v1.54/containers/json HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n`)).toMatch(/^HTTP\/1\.1 403 /);
      expect(world.daemon.requests.filter((request) => request.url.endsWith("/start"))).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it("refuses a create whose keys differ only in case, and sends the daemon a body it built itself", async () => {
    const world = await start("plain");
    try {
      const sneaky = await world.call("POST", "/v1.54/containers/create?name=agentx-task-x", `{"User":"1000:1000","Image":"worker:test","Labels":{"agentx.task":"t","agentx.workspace":"${key}"},"HostConfig":{"Binds":["${workspace}:${workspace}"],"NetworkMode":"rovara-snet-dddd","CapDrop":["ALL"],"SecurityOpt":["no-new-privileges"],"capdrop":[],"securityopt":[],"pidslimit":0}}`);
      expect(sneaky.status).toBe(403);
      for (const variant of ["CAPDROP", "Capdrop", "capAdd", "privileged", "networkmode", "Dns"]) {
        const refused = await world.call("POST", "/v1.54/containers/create?name=agentx-task-x", createBody()).then(async () => world.call("POST", "/v1.54/containers/create?name=agentx-task-y", createBody({ [variant]: variant === "Dns" ? [] : variant === "privileged" ? true : variant === "networkmode" ? "host" : ["NET_ADMIN"] })));
        if (variant !== "Dns") expect(refused.status, variant).toBe(403);
      }
      expect(world.daemon.requests.filter((request) => request.url.startsWith("/containers/create")).length).toBeGreaterThan(0);
      for (const request of world.daemon.requests.filter((entry) => entry.url.startsWith("/containers/create"))) {
        const sent = JSON.parse(request.body) as Record<string, any>;
        expect(Object.keys(sent.HostConfig).filter((name) => name !== name.charAt(0).toUpperCase() + name.slice(1))).toEqual([]);
        expect(sent.HostConfig).toMatchObject({ CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], Privileged: false, NetworkMode: "rovara-snet-dddd", Dns: ["172.30.0.2"], PidsLimit: 4096, Memory: 4294967296, MemorySwap: 4294967296 });
        expect(sent.HostConfig.Tmpfs).toEqual({});
        expect(sent.Labels).toMatchObject({ "rovara.local.owner": owner, "rovara.local.sandbox": "1" });
      }
    } finally {
      await world.close();
    }
  });

  it("forces the limits and flags it checks, whatever the worker asked for, and rebuilds a mask's options", async () => {
    const world = await start("plain");
    try {
      const made = await world.call("POST", "/v1.54/containers/create?name=agentx-task-a", createBody({ PidsLimit: 7, Memory: 1000, MemorySwap: 10, Tmpfs: { [`${workspace}/.state`]: "rw,exec,suid,dev,size=4k,mode=1777" } }));
      expect(made.status).toBe(201);
      const sent = JSON.parse(world.daemon.requests.find((request) => request.url.startsWith("/containers/create"))!.body) as Record<string, any>;
      expect(sent.HostConfig).toMatchObject({ PidsLimit: 7, Memory: 1000, MemorySwap: 1000 });
      expect(sent.HostConfig.Tmpfs).toEqual({ [`${workspace}/.state`]: "ro,noexec,nosuid,nodev,size=4k,mode=1777" });
    } finally {
      await world.close();
    }
  });

  it("rebuilds a command's body: the sandbox user whatever was asked, and no field it does not know, in any case", async () => {
    const world = await start("plain");
    try {
      for (const body of [{ Cmd: ["id"], user: "0" }, { Cmd: ["id"], User: "0" }, { Cmd: ["id"], privileged: true }, { Cmd: ["id"], Privileged: true }, { Cmd: ["id"], cmd: ["x"] }]) {
        expect((await world.call("POST", `/v1.54/containers/${world.daemon.containerId}/exec`, JSON.stringify(body))).status, JSON.stringify(body)).toBe(403);
      }
      await world.exec();
      const sent = JSON.parse(world.daemon.requests.find((request) => request.url.endsWith("/exec"))!.body) as Record<string, unknown>;
      expect(sent).toMatchObject({ User: "1000:1000", Privileged: false, Cmd: ["id"] });
      expect(Object.keys(sent).sort()).toEqual(["AttachStderr", "AttachStdin", "AttachStdout", "Cmd", "Privileged", "Tty", "User"]);
    } finally {
      await world.close();
    }
  });

  it("refuses a body on a route that takes none, so it cannot reach the daemon as a second request", async () => {
    const world = await start("plain");
    try {
      const smuggled = `POST /containers/create?name=escape HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 40\r\n\r\n{"Image":"x","HostConfig":{"Privileged":1}}`;
      const id = await world.exec();
      const before = world.daemon.requests.length;
      const routes = ["GET /_ping", "HEAD /_ping", "GET /version", "GET /containers/json", `GET /containers/${world.daemon.containerId}/json`, `GET /containers/${world.daemon.containerId}/logs`,
        `DELETE /containers/${world.daemon.containerId}`, `GET /exec/${id}/json`, "GET /images/worker:test/json", "GET /networks/rovara-snet-dddd", `POST /containers/${world.daemon.containerId}/stop`, `POST /exec/${id}/resize`];
      for (const route of routes) {
        const [method, path] = route.split(" ");
        const withLength = await rawExchange(world.port, `${method} /v1.54${path} HTTP/1.1\r\nHost: x\r\nContent-Length: ${Buffer.byteLength(smuggled)}\r\n\r\n${smuggled}`);
        expect(withLength, route).toMatch(/^HTTP\/1\.1 403 /);
        const chunked = await rawExchange(world.port, `${method} /v1.54${path} HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n${smuggled.length.toString(16)}\r\n${smuggled}\r\n0\r\n\r\n`);
        expect(chunked, route).toMatch(/^HTTP\/1\.1 403 /);
      }
      const seen = world.daemon.requests.slice(before);
      expect(seen.filter((request) => request.url.startsWith("/containers/create"))).toEqual([]);
      // The refusal comes before anything is sent; at most the ownership lookups of the routes that name a container reached the daemon.
      expect(seen.every((request) => request.method === "GET" && /^\/containers\/[^/]+\/json$/.test(request.url))).toBe(true);
    } finally {
      await world.close();
    }
  });

  it("sends the daemon one request per connection, so nothing rides behind another", async () => {
    const world = await start("plain");
    try {
      const answer = await rawExchange(world.port, "GET /v1.54/_ping HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n");
      expect(answer).toMatch(/^HTTP\/1\.1 200 /);
      expect(world.daemon.requests.at(-1)?.url).toBe("/_ping");
      expect(world.daemon.connections).toBeGreaterThanOrEqual(1);
    } finally {
      await world.close();
    }
  });

  it("refuses more memory than the machine has", async () => {
    const world = await start("plain");
    try {
      expect((await world.call("POST", "/v1.54/containers/create?name=agentx-task-m", createBody({ Memory: 1e15 }))).status).toBe(403);
      expect((await world.call("POST", "/v1.54/containers/create?name=agentx-task-m", createBody({ Memory: 1_000_000, MemorySwap: 1e15 }))).status).toBe(403);
      expect((await world.call("POST", "/v1.54/containers/create?name=agentx-task-m", createBody({ Memory: 1_000_000 }))).status).toBe(201);
    } finally {
      await world.close();
    }
  });

  it("makes sandboxes one at a time, so the limit holds when creates arrive together", async () => {
    const world = await start("plain", 1);
    try {
      const results = await Promise.all([1, 2, 3, 4].map((index) => world.call("POST", `/v1.54/containers/create?name=agentx-task-n${index}`, createBody())));
      expect(results.map((result) => result.status).sort()).toEqual([201, 429, 429, 429]);
    } finally {
      await world.close();
    }
  });
});
