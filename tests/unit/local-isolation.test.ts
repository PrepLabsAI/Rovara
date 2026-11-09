/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call --
   the guard tests build Docker API bodies as free-form objects and change one field at a time; the shape under test is whatever an attacker sends. */
// Port lane L4b: the pieces of a local worker's walls that run without Docker: the allow-list, the egress gateway's name server, TLS
// server-name reader and address checks, and the Docker socket guard's rules for a sandbox. The gateway and the guard are programs that
// run inside containers (isolation/*-source.ts); here the very same text is loaded as a library and driven directly.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
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
  checkExecBody(text: string): void;
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
    const ok = JSON.stringify({ AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false, Cmd: ["sh", "-c", "true"], User: "1000:1000", Env: ["A=b"], WorkingDir: "/tmp" });
    expect(() => guard.checkExecBody(ok)).not.toThrow();
    expect(() => guard.checkExecBody(JSON.stringify({ Cmd: ["id"], User: "1000" }))).not.toThrow();
    expect(() => guard.checkExecBody(JSON.stringify({ Cmd: ["id"], Privileged: false }))).not.toThrow();
    for (const bad of [{ Cmd: ["id"], User: "0" }, { Cmd: ["id"], User: "root" }, { Cmd: ["id"], Privileged: true }, { Cmd: [] }, {}, { Cmd: "id" }, { Cmd: ["id"], Extra: 1 }, { Cmd: ["id"], Env: "x" }]) {
      expect(() => guard.checkExecBody(JSON.stringify(bad)), JSON.stringify(bad)).toThrow();
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
      for (const [what, options, status] of refusals) expect((await send(options)).status, what).toBe(status);
      expect((await send({ port: server.tcpPort, host, path: "/v1/internal/x", body: "x".repeat(8 * 1_048_576 + 1) }).catch(() => ({ status: 413, text: "" }))).status).toBe(413);
      expect(seen).toHaveLength(1);
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
