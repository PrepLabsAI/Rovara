// TS16: the sealed check sandbox's arguments, files and DNS helper arguments (check-sandbox.ts; test-services.md 4.0.2). Nothing starts Docker: the functions are pure, and the one reader uses a fake docker.
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHECK_SANDBOX_HOSTNAME, RESERVED_RUN_ALIASES, SEALED_DNS_HELPER_ENTRY, SEALED_DNS_STATE_FILE, SINKHOLE_ALIAS,
  EMBEDDED_RESOLVER_ADDRESS, RESOLVER_GUARD_BINARY, RESOLVER_GUARD_STEPS, isPinnedImage, resolverGuardArgProblems, resolverGuardName, resolverGuardRunArgs,
  checkSandboxArgProblems, checkSandboxHostsFile, detachWorkingSandbox, reattachWorkingSandbox, startCheckSandbox, withDetachedWorking, checkSandboxNames, checkSandboxPlan, checkSandboxResolvConf, checkSandboxRunArgs, parseSealedDnsRecord, readSealedDnsRecord, sealedDnsHelperRunArgs, waitForSealedDnsHelper, writeCheckSandboxFiles,
  type CheckSandboxInput, type CheckSandboxNetwork,
} from "../../packages/worker/src/check-sandbox.js";
import { RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_LABEL, RUN_NETWORK_WORKSPACE_LABEL, runNetworkAddresses, runNetworkHelperIp, runNetworkLabelArgs, runNetworkName } from "../../packages/worker/src/run-network.js";
import { SealedDnsHelper } from "../../packages/worker/src/setup-dns-watch.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import { TASK_SANDBOX_NETWORK, taskSandboxRunArgs } from "../../packages/worker/src/task-sandbox.js";

const RUN = "11111111-1111-4111-8111-111111111111";
const WS = "0123456789abcdef";
const SLOT = 5;
const ROOT = "/workspace/project";
/** The worker's own image, pinned: what the resolver guard runs from (the sandbox image, "worker:img" here, is a different one on purpose). */
const GUARD_IMAGE = `registry.example.test/agentx/worker@sha256:${"c".repeat(64)}`;

function network(overrides: Partial<CheckSandboxNetwork> = {}): CheckSandboxNetwork {
  const addresses = runNetworkAddresses(SLOT);
  return {
    name: runNetworkName(RUN), slot: SLOT, subnet: addresses.subnet, dnsHelperIp: addresses.dnsHelperIp, workingSandboxIp: addresses.workingSandboxIp, checkSandboxIp: addresses.checkSandboxIp,
    labelArgs: () => runNetworkLabelArgs({ runId: RUN, workspace: WS, createdAt: 1_800_000_000_000, expiresAt: 1_800_000_900_000 }),
    ...overrides,
  };
}
const helper = (index: number) => runNetworkHelperIp(SLOT, index);
function input(overrides: Partial<CheckSandboxInput> = {}): CheckSandboxInput {
  return {
    net: network(), taskId: "task-1", image: "worker:img", guardImage: GUARD_IMAGE, rootPath: ROOT, maskedPaths: ["/workspace/project/.agentx-state"], hostCpus: 4, hostMemoryBytes: 16 * 2 ** 30,
    filesDir: "/run/rovara/check-1", helpers: [{ alias: "postgres", address: helper(1) }, { alias: "aws", address: helper(2) }], sinkholeIp: helper(0), ...overrides,
  };
}
const FILES = { resolvConfPath: "/run/rovara/check-1/resolv.conf", hostsPath: "/run/rovara/check-1/hosts" };
const valuesOf = (args: readonly string[], flag: string) => args.flatMap((arg, index) => (args[index - 1] === flag ? [arg] : []));
const config = (code: string): unknown => expect.objectContaining({ code, message: expect.any(String) as unknown }) as unknown;

describe("the sealed check sandbox's run arguments", () => {
  const args = checkSandboxRunArgs(input(), FILES);

  it("is attached to the run's services network alone, at the fixed address .4", () => {
    expect(valuesOf(args, "--network")).toEqual([runNetworkName(RUN)]);
    expect(valuesOf(args, "--ip")).toEqual([runNetworkAddresses(SLOT).checkSandboxIp]);
    expect(runNetworkAddresses(SLOT).checkSandboxIp).toBe("172.30.5.4");
    expect(args).not.toContain(TASK_SANDBOX_NETWORK);
    for (const forbidden of ["bridge", "host", "none", "--net", "--publish", "-p", "--publish-all", "-P", "--expose", "--link", "--network-alias", "--add-host", "--privileged", "--cap-add", "--device", "--sysctl"]) expect(args, forbidden).not.toContain(forbidden);
    expect(args.some((arg) => arg.startsWith("--network="))).toBe(false);
  });

  it("names no DNS server of Docker's: the resolver file is the run's own", () => {
    for (const flag of ["--dns", "--dns-search", "--dns-option"]) expect(args).not.toContain(flag);
    expect(valuesOf(args, "--volume")).toEqual([`${ROOT}:${ROOT}`, `${FILES.resolvConfPath}:/etc/resolv.conf:ro`, `${FILES.hostsPath}:/etc/hosts:ro`]);
  });

  it("is the task sandbox's own hardening plus only the run's additions (hostname, the four labels, the two read-only files)", () => {
    const base = taskSandboxRunArgs({ name: `${runNetworkName(RUN)}-check`, taskId: "task-1", image: "worker:img", rootPath: ROOT, maskedPaths: ["/workspace/project/.agentx-state"], hostCpus: 4, hostMemoryBytes: 16 * 2 ** 30, network: { name: runNetworkName(RUN), ip: "172.30.5.4" } });
    const additions = ["--hostname", CHECK_SANDBOX_HOSTNAME, ...network().labelArgs(), "--volume", `${FILES.resolvConfPath}:/etc/resolv.conf:ro`, "--volume", `${FILES.hostsPath}:/etc/hosts:ro`];
    expect(args).toEqual([...base.slice(0, -6), ...additions, ...base.slice(-6)]);
    expect(valuesOf(args, "--user")).toEqual(["1000:1000"]);
    expect(valuesOf(args, "--cap-drop")).toEqual(["ALL"]);
    expect(valuesOf(args, "--security-opt")).toEqual(["no-new-privileges"]);
    expect(valuesOf(args, "--pids-limit")).toEqual(["4096"]);
    expect(valuesOf(args, "--memory")).toEqual(["13107m"]);
    expect(valuesOf(args, "--cpus")).toEqual(["3"]);
    expect(args.slice(-4)).toEqual(["worker:img", "--", "sleep", "infinity"]);
  });

  it("carries all four run-network labels, so the sweep and stop() can find it", () => {
    const labels = valuesOf(args, "--label");
    for (const key of [RUN_NETWORK_LABEL, RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_WORKSPACE_LABEL]) expect(labels.some((label) => label.startsWith(`${key}=`)), key).toBe(true);
  });

  it("passes its own soundness check, and the check finds each unsound change", () => {
    const paths = { ...FILES, rootPath: ROOT, image: "worker:img", maskedPaths: ["/workspace/project/.agentx-state"] };
    expect(checkSandboxArgProblems(args, network(), paths)).toEqual([]);
    const withBefore = (...extra: string[]) => [...args.slice(0, -6), ...extra, ...args.slice(-6)];
    const bad: Array<[string, string[]]> = [
      ["second network", withBefore("--network", "agentx-task")],
      ["publish", withBefore("--publish", "8080:80")],
      ["short publish", withBefore("-p", "8080:80")],
      ["dns", withBefore("--dns", "8.8.8.8")],
      ["dns equals form", withBefore("--dns=8.8.8.8")],
      ["add-host", withBefore("--add-host", "a:1.2.3.4")],
      ["cap-add", withBefore("--cap-add", "NET_ADMIN")],
      ["privileged", withBefore("--privileged")],
      ["device", withBefore("--device", "/dev/net/tun")],
      ["pid host", withBefore("--pid", "host")],
      ["a flag after a boolean flag", withBefore("--init", "--publish", "1:1")],
      ["a flag that starts a value", withBefore("--label", "--publish")],
      ["docker socket", withBefore("--volume", "/var/run/docker.sock:/var/run/docker.sock")],
      ["extra mount", withBefore("--volume", "/etc:/host-etc")],
      ["a writable resolv.conf", args.map((arg) => (arg === `${FILES.resolvConfPath}:/etc/resolv.conf:ro` ? `${FILES.resolvConfPath}:/etc/resolv.conf` : arg))],
      ["a writable hosts", args.map((arg) => (arg === `${FILES.hostsPath}:/etc/hosts:ro` ? `${FILES.hostsPath}:/etc/hosts` : arg))],
      ["host network", args.map((arg) => (arg === runNetworkName(RUN) ? "host" : arg))],
      ["the default bridge", args.map((arg) => (arg === runNetworkName(RUN) ? "bridge" : arg))],
      ["the task network", args.map((arg) => (arg === runNetworkName(RUN) ? TASK_SANDBOX_NETWORK : arg))],
      ["another address", args.map((arg) => (arg === "172.30.5.4" ? "172.30.5.3" : arg))],
      ["no ip", args.filter((arg, index) => arg !== "--ip" && args[index - 1] !== "--ip")],
      ["no cap-drop", args.filter((arg, index) => arg !== "--cap-drop" && args[index - 1] !== "--cap-drop")],
      ["a different cap-drop", args.map((arg) => (arg === "ALL" ? "NET_RAW" : arg))],
      ["no no-new-privileges", args.map((arg) => (arg === "no-new-privileges" ? "seccomp=unconfined" : arg))],
      ["no user", args.filter((arg, index) => arg !== "--user" && args[index - 1] !== "--user")],
      ["no pids limit", args.filter((arg, index) => arg !== "--pids-limit" && args[index - 1] !== "--pids-limit")],
    ];
    for (const [name, changed] of bad) expect(checkSandboxArgProblems(changed, network(), paths), name).not.toEqual([]);
    // Each rule says so in its own words (so one rule cannot hide behind another).
    const said = (changed: string[]) => checkSandboxArgProblems(changed, network(), paths).join(" | ");
    expect(said(withBefore("--network", "some-other-net"))).toMatch(/services network alone/u);
    expect(said(args.map((arg) => (arg === runNetworkName(RUN) ? "bridge" : arg)))).toMatch(/route out/u);
    expect(said(args.map((arg) => (arg === runNetworkName(RUN) ? "host" : arg)))).toMatch(/route out/u);
    expect(said(withBefore("--network", "container:abc"))).toMatch(/route out/u);
    expect(said(withBefore("--volume", "/var/run/docker.sock:/s"))).toMatch(/docker socket/u);
    expect(said(withBefore("--volume", "/x/docker.sock:/s"))).toMatch(/docker socket/u);
    expect(said(args.map((arg) => (arg === "172.30.5.4" ? "172.30.5.3" : arg)))).toMatch(/fixed check sandbox address/u);
    expect(said(args.map((arg) => (arg === "ALL" ? "NET_RAW" : arg)))).toMatch(/every capability/u);
    expect(said(args.map((arg) => (arg === "no-new-privileges" ? "seccomp=unconfined" : arg)))).toMatch(/no-new-privileges/u);
    expect(said(withBefore("--publish", "1:1"))).toMatch(/publishes a port/u);
    expect(said(withBefore("--volume", "/etc:/e"))).toMatch(/exactly the workspace/u);
    expect(said(args.filter((arg, index) => arg !== "--user" && args[index - 1] !== "--user"))).toMatch(/lacks --user/u);
  });

  it("a label whose text looks like a flag is a value, not a flag", () => {
    const odd = checkSandboxRunArgs(input({ taskId: "not-a-flag" }), FILES);
    expect(checkSandboxArgProblems(odd, network(), { ...FILES, rootPath: ROOT, image: "worker:img", maskedPaths: ["/workspace/project/.agentx-state"] })).toEqual([]);
  });

  it("refuses a network that is not the run's address plan or has lost a label", () => {
    expect(() => checkSandboxRunArgs(input({ net: network({ checkSandboxIp: "172.30.5.9" }) }), FILES)).toThrow(config("CONFIG_INVALID"));
    expect(() => checkSandboxRunArgs(input({ net: network({ dnsHelperIp: "172.30.5.9" }) }), FILES)).toThrow(config("CONFIG_INVALID"));
    expect(() => checkSandboxRunArgs(input({ net: network({ subnet: "172.30.6.0/24" }) }), FILES)).toThrow(config("CONFIG_INVALID"));
    expect(() => checkSandboxRunArgs(input({ net: network({ name: TASK_SANDBOX_NETWORK }) }), FILES)).toThrow(config("CONFIG_INVALID"));
    expect(() => checkSandboxRunArgs(input({ net: network({ name: "bridge" }) }), FILES)).toThrow(config("CONFIG_INVALID"));
    for (const name of ["my-own-net", "rovara-svc-xyz", "rovara-svc-0123456789abc", "rovara-svc-0123456789ab-x", "--network"]) expect(() => checkSandboxRunArgs(input({ net: network({ name }) }), FILES), name).toThrow(config("CONFIG_INVALID"));
    for (const key of [RUN_NETWORK_LABEL, RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_WORKSPACE_LABEL]) {
      const labels = network().labelArgs();
      const without = labels.filter((arg, index) => !arg.startsWith(`${key}=`) && !(labels[index + 1]?.startsWith(`${key}=`) && arg === "--label"));
      expect(() => checkSandboxRunArgs(input({ net: network({ labelArgs: () => without }) }), FILES), key).toThrow(config("CONFIG_INVALID"));
    }
  });

  it("refuses a path that is not a plain absolute path, or two files at one path", () => {
    for (const bad of ["relative/resolv.conf", "/a/../b", "/a/./b", "/a:b", "/a,b", "/a b", "", "/", "/a/\n/b", `/${"a".repeat(600)}`]) {
      expect(() => checkSandboxRunArgs(input(), { ...FILES, resolvConfPath: bad }), bad).toThrow(config("CONFIG_INVALID"));
      expect(() => checkSandboxRunArgs(input(), { ...FILES, hostsPath: bad }), bad).toThrow(config("CONFIG_INVALID"));
    }
    expect(() => checkSandboxRunArgs(input(), { resolvConfPath: FILES.hostsPath, hostsPath: FILES.hostsPath })).toThrow(config("CONFIG_INVALID"));
  });
});

describe("the run's names, resolv.conf and hosts file", () => {
  it("lists every dependency at its helper's address, and the sinkhole", () => {
    expect(checkSandboxNames(network(), input().helpers, helper(0))).toEqual([{ alias: "postgres", address: "172.30.5.17" }, { alias: "aws", address: "172.30.5.18" }, { alias: SINKHOLE_ALIAS, address: "172.30.5.16" }]);
  });

  it("names the DNS helper at .2 alone in resolv.conf, with no search domain and no second server", () => {
    expect(checkSandboxResolvConf("172.30.5.2")).toBe("nameserver 172.30.5.2\noptions ndots:0 timeout:2 attempts:2\n");
    const plan = checkSandboxPlan(input());
    expect(plan.resolvConf.match(/^nameserver /gmu)).toHaveLength(1);
    expect(plan.resolvConf).not.toMatch(/search|domain|127\.0\.0\.11/u);
    expect(() => checkSandboxResolvConf("not-an-ip")).toThrow(config("CONFIG_INVALID"));
    expect(() => checkSandboxResolvConf("fd00::2")).toThrow(config("CONFIG_INVALID"));
  });

  it("writes the hosts file with loopback, the sandbox itself and the run's names", () => {
    expect(checkSandboxPlan(input()).hosts).toBe("127.0.0.1 localhost\n::1 localhost ip6-localhost ip6-loopback\n172.30.5.4 check\n172.30.5.17 postgres\n172.30.5.18 aws\n172.30.5.16 sinkhole\n");
    expect(checkSandboxHostsFile("172.30.5.4", [])).toBe("127.0.0.1 localhost\n::1 localhost ip6-localhost ip6-loopback\n172.30.5.4 check\n");
  });

  it("refuses an alias that is not a plain name, is reserved, or is given twice", () => {
    const names = (helpers: CheckSandboxInput["helpers"]) => () => checkSandboxNames(network(), helpers, helper(0));
    expect(names([{ alias: "my-db2", address: helper(1) }])).not.toThrow();
    for (const bad of ["", "A", "Postgres", "1db", "db-", "-db", "d", "a.b", "a_b", "db db", "db\n127.0.0.1 evil", "--privileged", "x".repeat(33), "db;rm", "../x"]) expect(names([{ alias: bad, address: helper(1) }]), JSON.stringify(bad)).toThrow(config("CONFIG_INVALID"));
    for (const reserved of RESERVED_RUN_ALIASES) expect(names([{ alias: reserved, address: helper(1) }]), reserved).toThrow(config("CONFIG_INVALID"));
    expect([...RESERVED_RUN_ALIASES]).toEqual(expect.arrayContaining([SINKHOLE_ALIAS, "localhost", "dns", "proxy", "check", "working"]));
    expect(names([{ alias: "db", address: helper(1) }, { alias: "db", address: helper(2) }])).toThrow(config("CONFIG_INVALID"));
  });

  it("refuses an address that is not one of THIS run's helper addresses (.16 to .47)", () => {
    const names = (address: string, sinkhole = helper(0)) => () => checkSandboxNames(network(), [{ alias: "db", address }], sinkhole);
    expect(names("172.30.5.47")).not.toThrow();
    expect(names("172.30.5.16", helper(1))).not.toThrow();
    for (const bad of ["172.30.5.1", "172.30.5.2", "172.30.5.3", "172.30.5.4", "172.30.5.8", "172.30.5.15", "172.30.5.48", "172.30.6.17", "172.29.5.17", "8.8.8.8", "169.254.169.254", "127.0.0.1", "172.30.5.17\n1.2.3.4 x", "", "::1"]) {
      expect(names(bad), JSON.stringify(bad)).toThrow(config("CONFIG_INVALID"));
      expect(names(helper(1), bad), `sinkhole ${JSON.stringify(bad)}`).toThrow(config("CONFIG_INVALID"));
    }
  });

  it("refuses more names than the sealed table holds", () => {
    const many = Array.from({ length: 300 }, (_, index) => ({ alias: `svc${String(index)}-x`, address: helper(1) }));
    expect(() => checkSandboxNames(network(), many, helper(0))).toThrow(config("CONFIG_INVALID"));
  });
});

describe("the DNS helper's run arguments (sealed mode)", () => {
  const args = sealedDnsHelperRunArgs({ net: network(), image: "worker:img", helpers: input().helpers, sinkholeIp: helper(0) });

  it("is on the services network at .2, with all four labels, and nothing else attached", () => {
    expect(valuesOf(args, "--network")).toEqual([runNetworkName(RUN)]);
    expect(valuesOf(args, "--ip")).toEqual(["172.30.5.2"]);
    expect(valuesOf(args, "--name")).toEqual([`${runNetworkName(RUN)}-dns`]);
    expect(valuesOf(args, "--label")).toEqual(valuesOf(network().labelArgs(), "--label"));
    for (const forbidden of ["--publish", "-p", "--publish-all", "-P", "--dns", "--add-host", "--privileged", "--cap-add", "--device", "--net", "--link", "--upstream", "bridge", "host", TASK_SANDBOX_NETWORK]) expect(args, forbidden).not.toContain(forbidden);
  });

  it("has the setup helper's hardening", () => {
    expect(valuesOf(args, "--user")).toEqual(["1000:1000"]);
    expect(valuesOf(args, "--cap-drop")).toEqual(["ALL"]);
    expect(valuesOf(args, "--security-opt")).toEqual(["no-new-privileges"]);
    expect(args).toContain("--read-only");
    expect(args).toContain("--pull=never");
    expect(valuesOf(args, "--sysctl")).toEqual(["net.ipv4.ip_unprivileged_port_start=53"]);
    expect(valuesOf(args, "--pids-limit")).toEqual(["64"]);
    expect(valuesOf(args, "--memory")).toEqual(["128m"]);
    expect(valuesOf(args, "--memory-swap")).toEqual(["128m"]);
    expect(valuesOf(args, "--cpus")).toEqual(["0.5"]);
    expect(valuesOf(args, "--tmpfs")).toEqual(["/state:rw,noexec,nosuid,size=1m,uid=1000,gid=1000"]);
  });

  it("runs the sealed program, serving .4 only, with the sinkhole, the table and no upstream", () => {
    const program = args.slice(args.indexOf("worker:img"));
    expect(program).toEqual(["worker:img", SEALED_DNS_HELPER_ENTRY, "--listen", "172.30.5.2", "--source", "172.30.5.4", "--sinkhole", "172.30.5.16",
      "--host", "postgres=172.30.5.17", "--host", "aws=172.30.5.18", "--host", "sinkhole=172.30.5.16", "--state", SEALED_DNS_STATE_FILE]);
    expect(program).not.toContain("--upstream");
    expect(valuesOf(args, "--entrypoint")).toEqual(["/usr/local/bin/node"]);
  });

  it("refuses a network that is not the run's address plan", () => {
    expect(() => sealedDnsHelperRunArgs({ net: network({ dnsHelperIp: "172.30.5.9" }), image: "i", helpers: input().helpers, sinkholeIp: helper(0) })).toThrow(config("CONFIG_INVALID"));
  });

  it("validates the names itself when it is called on its own: a bad alias, a stray address or a public sinkhole never reaches a docker argument", () => {
    const make = (helpers: CheckSandboxInput["helpers"], sinkholeIp = helper(0)) => () => sealedDnsHelperRunArgs({ net: network(), image: "i", helpers, sinkholeIp });
    expect(make(input().helpers)).not.toThrow();
    expect(make([{ alias: "--privileged", address: helper(1) }])).toThrow(config("CONFIG_INVALID"));
    expect(make([{ alias: "db", address: "8.8.8.8" }])).toThrow(config("CONFIG_INVALID"));
    expect(make([{ alias: "sinkhole", address: helper(1) }])).toThrow(config("CONFIG_INVALID"));
    expect(make(input().helpers, "8.8.8.8")).toThrow(config("CONFIG_INVALID"));
  });
});

describe("the plan the ServiceRunner takes", () => {
  it("gathers the attachment, the files and both containers' arguments", () => {
    const plan = checkSandboxPlan(input());
    expect(plan.network).toEqual({ name: runNetworkName(RUN), ip: "172.30.5.4" });
    expect(plan.sandboxName).toBe(`${runNetworkName(RUN)}-check`);
    expect(plan.dnsHelperName).toBe(`${runNetworkName(RUN)}-dns`);
    expect(plan.resolvConfPath).toBe("/run/rovara/check-1/resolv.conf");
    expect(plan.hostsPath).toBe("/run/rovara/check-1/hosts");
    expect(plan.sandboxRunArgs).toEqual(checkSandboxRunArgs(input(), { resolvConfPath: plan.resolvConfPath, hostsPath: plan.hostsPath }));
    expect(valuesOf(plan.sandboxRunArgs, "--name")).toEqual([plan.sandboxName]);
  });

  it("refuses a files directory that is not a plain absolute path", () => {
    for (const bad of ["relative", "/a/../b", "/a:b", ""]) expect(() => checkSandboxPlan(input({ filesDir: bad })), bad).toThrow(config("CONFIG_INVALID"));
  });

  it("the hosts file and the DNS table list the same names and addresses, and the helper serves exactly those (an unknown name goes to the sinkhole and is counted)", async () => {
    const plan = checkSandboxPlan(input());
    const table = Object.fromEntries(plan.names.map((entry) => [entry.alias, entry.address]));
    const hostLines = plan.hosts.split("\n").filter((line) => line.startsWith("172.30.5.") && !line.endsWith(" check"));
    expect(hostLines).toEqual(plan.names.map((entry) => `${entry.address} ${entry.alias}`));
    const dns = new SealedDnsHelper({ listenAddress: "127.0.0.1", allowLoopback: true, port: 0, names: table, sinkholeAddress: "172.30.5.16", allowedSources: ["127.0.0.1"] });
    const { port } = await dns.start();
    try {
      const { createSocket } = await import("node:dgram");
      const ask = (name: string) => new Promise<string>((resolve) => {
        const client = createSocket("udp4");
        const packet = Buffer.concat([Buffer.from([0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]), ...name.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0, 0, 1, 0, 1])]);
        client.on("message", (reply) => { client.close(); resolve([...reply.subarray(reply.length - 4)].join(".")); });
        client.send(packet, port, "127.0.0.1");
      });
      expect(await ask("postgres")).toBe("172.30.5.17");
      expect(await ask("aws")).toBe("172.30.5.18");
      expect(await ask("api.some-vendor.com")).toBe("172.30.5.16");
      expect(dns.unknownNames()).toEqual([{ name: "api.some-vendor.com", queries: 1 }]);
    } finally {
      await dns.stop();
    }
  });
});

describe("the run-owned files", () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

  it("writes both files with the plan's content, readable by the sandbox's user and not writable by it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "check-sandbox-"));
    dirs.push(dir);
    const plan = checkSandboxPlan(input({ filesDir: dir }));
    await writeCheckSandboxFiles(plan);
    expect(await readFile(plan.resolvConfPath, "utf8")).toBe(plan.resolvConf);
    expect(await readFile(plan.hostsPath, "utf8")).toBe(plan.hosts);
    for (const path of [plan.resolvConfPath, plan.hostsPath]) expect((await stat(path)).mode & 0o777).toBe(0o644);
  });

  it("does not overwrite an existing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "check-sandbox-"));
    dirs.push(dir);
    const plan = checkSandboxPlan(input({ filesDir: dir }));
    await writeFile(plan.hostsPath, "planted");
    await expect(writeCheckSandboxFiles(plan)).rejects.toThrow(/EEXIST/u);
    expect(await readFile(plan.hostsPath, "utf8")).toBe("planted");
  });
});

describe("the helper's record of unknown names", () => {
  it("parses the file the helper writes", () => {
    expect(parseSealedDnsRecord(JSON.stringify({ unknown: [{ name: "api.vendor.com", queries: 3 }, { name: "postgress", queries: 1 }], dropped: 2, unrecorded: 1 }))).toEqual({ unknown: [{ name: "api.vendor.com", queries: 3 }, { name: "postgress", queries: 1 }], dropped: 2, unrecorded: 1 });
  });

  it("gives an empty record for anything that is not exactly that shape, and keeps no name that is not a plain name", () => {
    const empty = { unknown: [], dropped: 0, unrecorded: 0 };
    for (const text of ["", "not json", "null", "[]", "42", '"x"']) expect(parseSealedDnsRecord(text), text).toEqual(empty);
    const parsed = parseSealedDnsRecord(JSON.stringify({ unknown: [{ name: "ok.test", queries: 1 }, { name: "Evil Name", queries: 1 }, { name: "a\nb", queries: 1 }, { name: "x", queries: 0 }, { name: "y", queries: -1 }, { name: 5, queries: 1 }, null, "z", { name: "no-count" }], dropped: -3, unrecorded: "many" }));
    expect(parsed).toEqual({ unknown: [{ name: "ok.test", queries: 1 }], dropped: 0, unrecorded: 0 });
  });

  it("keeps at most 200 names", () => {
    const text = JSON.stringify({ unknown: Array.from({ length: 500 }, (_, index) => ({ name: `n${String(index)}.test`, queries: 1 })), dropped: 0, unrecorded: 0 });
    expect(parseSealedDnsRecord(text).unknown).toHaveLength(200);
  });

  it("reads it with one fixed docker exec, and a failed read gives an empty record", async () => {
    const calls: string[][] = [];
    const docker = (result: { exitCode: number; stdout: string }): DockerCli => ({ run: (args) => { calls.push([...args]); return Promise.resolve({ ...result, stderr: "" }); } });
    const helperName = `${runNetworkName(RUN)}-dns`;
    const ok = await readSealedDnsRecord(docker({ exitCode: 0, stdout: JSON.stringify({ unknown: [{ name: "a.test", queries: 2 }], dropped: 0, unrecorded: 0 }) }), helperName);
    expect(ok.unknown).toEqual([{ name: "a.test", queries: 2 }]);
    expect(calls).toEqual([["exec", helperName, "cat", SEALED_DNS_STATE_FILE]]);
    expect(await readSealedDnsRecord(docker({ exitCode: 1, stdout: "" }), helperName)).toEqual({ unknown: [], dropped: 0, unrecorded: 0 });
    expect(await readSealedDnsRecord({ run: () => Promise.reject(new Error("boom")) }, helperName)).toEqual({ unknown: [], dropped: 0, unrecorded: 0 });
    await expect(readSealedDnsRecord(docker({ exitCode: 0, stdout: "{}" }), "some-other-container")).rejects.toThrow(config("CONFIG_INVALID"));
    await expect(readSealedDnsRecord(docker({ exitCode: 0, stdout: "{}" }), "--all")).rejects.toThrow(config("CONFIG_INVALID"));
  });

  it("waits until the helper listens: its state file exists only after the bind, so the round never starts against a helper that is still loading (L3 on Linux: EAI_AGAIN, nothing recorded)", async () => {
    const helperName = `${runNetworkName(RUN)}-dns`;
    const calls: string[][] = [];
    let clock = 0;
    const answers = [1, 1, 1, 0];
    const docker: DockerCli = { run: (args) => { calls.push([...args]); return Promise.resolve({ exitCode: answers.shift() ?? 0, stdout: "", stderr: "" }); } };
    await waitForSealedDnsHelper(docker, helperName, { sleep: async (ms) => { clock += ms; }, now: () => clock, pollMs: 250, timeoutMs: 10_000 });
    expect(calls).toEqual(Array.from({ length: 4 }, () => ["exec", helperName, "cat", SEALED_DNS_STATE_FILE]));
    expect(clock).toBe(750);
  });

  it("refuses to start the round when the helper never listens (exited, or still not bound at the limit), when the wait is cancelled, and for a name that is not a sealed helper's", async () => {
    const helperName = `${runNetworkName(RUN)}-dns`;
    let clock = 0;
    const never: DockerCli = { run: () => Promise.resolve({ exitCode: 1, stdout: "", stderr: "No such container" }) };
    await expect(waitForSealedDnsHelper(never, helperName, { sleep: async (ms) => { clock += ms; }, now: () => clock, timeoutMs: 2_000 })).rejects.toThrow(/not listening/u);
    expect(clock).toBeGreaterThanOrEqual(2_000);
    const failing: DockerCli = { run: () => Promise.reject(new Error("docker gone")) };
    clock = 0;
    await expect(waitForSealedDnsHelper(failing, helperName, { sleep: async (ms) => { clock += ms; }, now: () => clock, timeoutMs: 1_000 })).rejects.toThrow(/not listening/u);
    const aborted = new AbortController();
    aborted.abort();
    await expect(waitForSealedDnsHelper(never, helperName, { signal: aborted.signal })).rejects.toThrow(/cancelled/u);
    await expect(waitForSealedDnsHelper(never, "--all")).rejects.toThrow(config("CONFIG_INVALID"));
  });
});

describe("the allow-list refuses every spelling of every bypass (review M1)", () => {
  const args = checkSandboxRunArgs(input(), FILES);
  const paths = { ...FILES, rootPath: ROOT, image: "worker:img", maskedPaths: ["/workspace/project/.agentx-state"] };
  const entry = args.indexOf("--entrypoint");
  const before = (...extra: string[]) => [...args.slice(0, entry), ...extra, ...args.slice(entry)];
  const afterEntrypoint = (...extra: string[]) => [...args.slice(0, entry + 2), ...extra, ...args.slice(entry + 2)];
  const afterImage = (...extra: string[]) => [...args, ...extra];

  it("the real arguments pass", () => {
    expect(checkSandboxArgProblems(args, network(), paths)).toEqual([]);
  });

  const BYPASSES: Array<[string, string[]]> = [
    ["--network=bridge", ["--network=bridge"]],
    ["--network=host", ["--network=host"]],
    ["--ip=172.30.5.3", ["--ip=172.30.5.3"]],
    ["--security-opt=seccomp=unconfined", ["--security-opt=seccomp=unconfined"]],
    ["--security-opt seccomp=unconfined", ["--security-opt", "seccomp=unconfined"]],
    ["--cap-drop=NET_RAW", ["--cap-drop=NET_RAW"]],
    ["--user=0:0", ["--user=0:0"]],
    ["a second --user", ["--user", "0:0"]],
    ["a second --user with the same value", ["--user", "1000:1000"]],
    ["-p8080:80", ["-p8080:80"]],
    ["-p 8080:80", ["-p", "8080:80"]],
    ["-v /:/host", ["-v", "/:/host"]],
    ["-v/:/host", ["-v/:/host"]],
    ["--volume=/:/host", ["--volume=/:/host"]],
    ["--mount type=bind", ["--mount", "type=bind,src=/,dst=/host"]],
    ["--mount=type=bind", ["--mount=type=bind,src=/,dst=/host"]],
    ["--volumes-from", ["--volumes-from", "other"]],
    ["--tmpfs /etc", ["--tmpfs", "/etc"]],
    ["--tmpfs=/etc", ["--tmpfs=/etc:rw"]],
    ["--runtime", ["--runtime", "runc"]],
    ["--group-add 0", ["--group-add", "0"]],
    ["--cgroup-parent", ["--cgroup-parent", "/x"]],
    ["--gpus", ["--gpus", "all"]],
    ["--env DOCKER_HOST=", ["--env", "DOCKER_HOST="]],
    ["-e DOCKER_HOST=", ["-e", "DOCKER_HOST=tcp://x:2375"]],
    ["--env=DOCKER_HOST=", ["--env=DOCKER_HOST="]],
    ["--env-file", ["--env-file", "/etc/passwd"]],
    ["--dns=8.8.8.8", ["--dns=8.8.8.8"]],
    ["--add-host=evil:1.2.3.4", ["--add-host=evil:1.2.3.4"]],
    ["--cap-add=NET_ADMIN", ["--cap-add=NET_ADMIN"]],
    ["--privileged=true", ["--privileged=true"]],
    ["--pid=host", ["--pid=host"]],
    ["--sysctl", ["--sysctl", "net.ipv4.ip_forward=1"]],
    ["a flag nobody has heard of", ["--frobnicate", "yes"]],
    ["a bare dash", ["-"]],
    ["a label key that is not ours", ["--label", "com.example.x=1"]],
    ["a second hostname", ["--hostname", "other"]],
    ["a second workdir", ["--workdir", "/"]],
    ["a second entrypoint", ["--entrypoint", "/bin/sh"]],
    ["a second memory", ["--memory", "1g"]],
  ];
  it.each(BYPASSES)("refuses %s before the entrypoint", (_name, extra) => {
    expect(checkSandboxArgProblems(before(...extra), network(), paths)).not.toEqual([]);
  });
  it.each(BYPASSES)("refuses %s after --entrypoint (the scan runs up to the image, not up to --entrypoint)", (_name, extra) => {
    expect(checkSandboxArgProblems(afterEntrypoint(...extra), network(), paths)).not.toEqual([]);
  });
  it.each([["--network", "bridge"], ["--privileged"], ["-p8080:80"], ["--cap-add=ALL"], ["--user=0"]] as Array<string[]>)("refuses %j after the image", (...extra) => {
    expect(checkSandboxArgProblems(afterImage(...extra), network(), paths)).not.toEqual([]);
  });

  it("says which rule each one broke", () => {
    const said = (changed: string[]) => checkSandboxArgProblems(changed, network(), paths).join(" | ");
    expect(said(before("--network=bridge"))).toMatch(/services network alone/u);
    expect(said(before("--ip=172.30.5.3"))).toMatch(/fixed check sandbox address/u);
    expect(said(before("--security-opt=seccomp=unconfined"))).toMatch(/no-new-privileges/u);
    expect(said(before("--cap-drop=NET_RAW"))).toMatch(/every capability/u);
    expect(said(before("--user=0:0"))).toMatch(/exactly one --user 1000:1000/u);
    expect(said(before("-p8080:80"))).toMatch(/-p, which publishes a port/u);
    expect(said(before("-v", "/:/host"))).toMatch(/-v, which adds a mount/u);
    expect(said(before("--runtime", "runc"))).toMatch(/--runtime/u);
    expect(said(before("--gpus", "all"))).toMatch(/--gpus/u);
    expect(said(before("--tmpfs", "/etc"))).toMatch(/masked folders/u);
    expect(said(afterImage("--privileged"))).toMatch(/after the image/u);
  });

  it("a different image, a missing masked folder or a changed working directory is a problem too", () => {
    expect(checkSandboxArgProblems(args, network(), { ...paths, image: "other:img" })).toEqual(expect.arrayContaining([expect.stringMatching(/another image/u)]));
    expect(checkSandboxArgProblems(args, network(), { ...paths, maskedPaths: [] })).toEqual(expect.arrayContaining([expect.stringMatching(/masked folders/u)]));
    expect(checkSandboxArgProblems(args, network(), { ...paths, rootPath: "/elsewhere" })).not.toEqual([]);
    expect(checkSandboxArgProblems(args.slice(1), network(), paths)).not.toEqual([]);
  });
});

describe("the working sandbox is detached for the round (review H1)", () => {
  const plan = checkSandboxPlan(input());
  const NET = runNetworkName(RUN);
  const WORK = `${NET}-work`;

  /** A docker that remembers which networks the working sandbox is on. */
  function fakeDocker(state: { networks: string[]; disconnectExit?: number; inspectExit?: number; inspectOut?: string; runExit?: number; connectExit?: number }) {
    const calls: string[][] = [];
    const docker: DockerCli = {
      run: (args) => {
        calls.push([...args]);
        if (args[0] === "network" && args[1] === "disconnect") {
          if ((state.disconnectExit ?? 0) === 0) state.networks = state.networks.filter((name) => name !== args[2]);
          return Promise.resolve({ exitCode: state.disconnectExit ?? 0, stdout: "", stderr: "" });
        }
        if (args[0] === "network" && args[1] === "connect") return Promise.resolve({ exitCode: state.connectExit ?? 0, stdout: "", stderr: "" });
        if (args[0] === "inspect") return Promise.resolve({ exitCode: state.inspectExit ?? 0, stdout: state.inspectOut ?? JSON.stringify(Object.fromEntries(state.networks.map((name) => [name, { IPAddress: "x" }]))), stderr: "" });
        if (args[0] === "run") return Promise.resolve({ exitCode: state.runExit ?? 0, stdout: "container-id\n", stderr: "" });
        return Promise.resolve({ exitCode: 1, stdout: "", stderr: "unexpected" });
      },
    };
    return { docker, calls, state };
  }
  const started = (calls: string[][]) => calls.filter((call) => call[0] === "run");

  it("the plan says the working sandbox must be detached, and names it and its address", () => {
    expect(plan.mustDetachWorking).toBe(true);
    expect(plan.workingSandboxName).toBe(WORK);
    expect(plan.workingSandboxIp).toBe("172.30.5.3");
    expect(checkSandboxPlan(input({ workingSandboxName: "my-working" })).workingSandboxName).toBe("my-working");
    for (const bad of ["--privileged", "", "a b", `${NET}-check`, `${NET}-dns`, "x".repeat(200)]) expect(() => checkSandboxPlan(input({ workingSandboxName: bad })), bad).toThrow(config("CONFIG_INVALID"));
  });

  it("disconnects the working sandbox from the run's network and checks with an inspect that it is gone", async () => {
    const { docker, calls } = fakeDocker({ networks: [NET, "agentx-task"] });
    const proof = await detachWorkingSandbox(docker, plan);
    expect(calls).toEqual([["network", "disconnect", NET, WORK], ["inspect", "--format", "{{json .NetworkSettings.Networks}}", WORK]]);
    expect(proof).toEqual({ network: NET, container: WORK });
  });

  it("does not trust the disconnect's exit code: still attached after a 'successful' disconnect is an error", async () => {
    const stuck: DockerCli = { run: (args) => Promise.resolve(args[0] === "inspect" ? { exitCode: 0, stdout: JSON.stringify({ [NET]: {}, "agentx-task": {} }), stderr: "" } : { exitCode: 0, stdout: "", stderr: "" }) };
    await expect(detachWorkingSandbox(stuck, plan)).rejects.toThrow(/still on the run's services network/u);
  });

  it("a container that was already off the network passes, even though docker refused the disconnect", async () => {
    const { docker } = fakeDocker({ networks: ["agentx-task"], disconnectExit: 1 });
    await expect(detachWorkingSandbox(docker, plan)).resolves.toEqual({ network: NET, container: WORK });
  });

  it("a disconnect that failed while the container is still attached is an error", async () => {
    const { docker } = fakeDocker({ networks: [NET, "agentx-task"], disconnectExit: 1 });
    await expect(detachWorkingSandbox(docker, plan)).rejects.toThrow(/still on the run's services network/u);
  });

  it("a network list that cannot be read is an error, not a pass", async () => {
    for (const state of [{ inspectExit: 1 }, { inspectOut: "not json" }, { inspectOut: "[]" }, { inspectOut: "null" }, { inspectOut: "" }]) {
      const { docker } = fakeDocker({ networks: ["agentx-task"], ...state });
      await expect(detachWorkingSandbox(docker, plan), JSON.stringify(state)).rejects.toThrow(/could not be read/u);
    }
    await expect(detachWorkingSandbox({ run: () => Promise.reject(new Error("boom")) }, plan)).rejects.toThrow(/could not be read/u);
  });

  it("starts the check sandbox with the plan's arguments once the detach is proven, and looks at the networks again first", async () => {
    const { docker, calls } = fakeDocker({ networks: [NET, "agentx-task"] });
    const proof = await detachWorkingSandbox(docker, plan);
    calls.length = 0;
    expect(await startCheckSandbox(docker, plan, proof)).toBe("container-id");
    expect(calls).toEqual([["inspect", "--format", "{{json .NetworkSettings.Networks}}", WORK], plan.sandboxRunArgs, plan.resolverGuardArgs.insert, plan.resolverGuardArgs.verify]);
  });

  it("refuses to start the check sandbox without the proof: nothing was detached, a made-up proof, or another plan's proof", async () => {
    const { docker, calls } = fakeDocker({ networks: [NET, "agentx-task"] });
    await expect(startCheckSandbox(docker, plan, { network: NET, container: WORK })).rejects.toThrow(/does not start before/u);
    await expect(startCheckSandbox(docker, plan, undefined as never)).rejects.toThrow();
    const otherPlan = checkSandboxPlan(input({ workingSandboxName: "another-working" }));
    const other = fakeDocker({ networks: ["agentx-task"] });
    const otherProof = await detachWorkingSandbox(other.docker, otherPlan);
    await expect(startCheckSandbox(docker, plan, otherProof)).rejects.toThrow(/does not start before/u);
    expect(started(calls)).toEqual([]);
    expect(started(other.calls)).toEqual([]);
  });

  it("refuses when the working sandbox got back on the network between the detach and the start", async () => {
    const { docker, calls, state } = fakeDocker({ networks: [NET, "agentx-task"] });
    const proof = await detachWorkingSandbox(docker, plan);
    state.networks = [NET, "agentx-task"];
    await expect(startCheckSandbox(docker, plan, proof)).rejects.toThrow(/on the run's services network again/u);
    expect(started(calls)).toEqual([]);
  });

  it("a docker that refuses to start the container is an error", async () => {
    const { docker } = fakeDocker({ networks: ["agentx-task"], runExit: 125 });
    const proof = await detachWorkingSandbox(docker, plan);
    await expect(startCheckSandbox(docker, plan, proof)).rejects.toThrow(/could not be started/u);
  });

  it("connects the working sandbox back at .3 after the round, and says so when docker refuses", async () => {
    const { docker, calls } = fakeDocker({ networks: ["agentx-task"] });
    await reattachWorkingSandbox(docker, plan);
    expect(calls.filter((call) => call[0] === "network")).toEqual([["network", "connect", "--ip", "172.30.5.3", NET, WORK]]);
    await expect(reattachWorkingSandbox(fakeDocker({ networks: [], connectExit: 1 }).docker, plan)).rejects.toThrow(/attached to the run's services network again/u);
    await expect(reattachWorkingSandbox({ run: () => Promise.reject(new Error("boom")) }, plan)).rejects.toThrow(/attached to the run's services network again/u);
  });

  it("refuses a plan whose network or container is not a plain name", async () => {
    const { docker, calls } = fakeDocker({ networks: [] });
    await expect(detachWorkingSandbox(docker, { ...plan, network: { name: "bridge", ip: "172.30.5.4" } })).rejects.toThrow(config("CONFIG_INVALID"));
    await expect(detachWorkingSandbox(docker, { ...plan, workingSandboxName: "--all" })).rejects.toThrow(config("CONFIG_INVALID"));
    await expect(reattachWorkingSandbox(docker, { ...plan, workingSandboxName: plan.sandboxName })).rejects.toThrow(config("CONFIG_INVALID"));
    expect(calls).toEqual([]);
  });
});

describe("the run's files are not inside the workspace (review M3)", () => {
  const wide = (overrides: Partial<CheckSandboxInput> = {}) => input({ rootPath: "/workspace", maskedPaths: ["/workspace/.agentx-state"], ...overrides });

  it("refuses a files directory inside the workspace root, the root itself, and a sibling that only looks like a masked path", () => {
    for (const filesDir of ["/workspace/run", "/workspace", "/workspace/.agentx-state2/run", "/workspace/a/b/c", "//workspace/run"]) {
      expect(() => checkSandboxPlan(wide({ filesDir })), filesDir).toThrow(/inside the workspace/u);
    }
  });

  it("accepts a directory outside the workspace, and one under a masked folder", () => {
    for (const filesDir of ["/run/rovara/check-1", "/workspacex/run", "/work", "/workspace/.agentx-state/run", "/workspace/.agentx-state"]) {
      expect(() => checkSandboxPlan(wide({ filesDir })), filesDir).not.toThrow();
    }
  });

  it("checks the two file paths of the builder itself, not just the plan's directory", () => {
    expect(() => checkSandboxRunArgs(wide(), { resolvConfPath: "/workspace/resolv.conf", hostsPath: "/run/x/hosts" })).toThrow(/inside the workspace/u);
    expect(() => checkSandboxRunArgs(wide(), { resolvConfPath: "/run/x/resolv.conf", hostsPath: "/workspace/hosts" })).toThrow(/inside the workspace/u);
    expect(() => checkSandboxRunArgs(wide(), { resolvConfPath: "/workspace/.agentx-state/resolv.conf", hostsPath: "/workspace/.agentx-state/hosts" })).not.toThrow();
  });
});

describe("smaller review items", () => {
  it("L2: a dependency cannot sit at the sinkhole's address", () => {
    expect(() => checkSandboxNames(network(), [{ alias: "db", address: helper(0) }], helper(0))).toThrow(/sinkhole's address/u);
    expect(() => checkSandboxNames(network(), [{ alias: "db", address: helper(1) }], helper(0))).not.toThrow();
  });

  it("L3: the helper's record is read only from a name of the form rovara-svc-<12 hex>-dns", async () => {
    const docker: DockerCli = { run: () => Promise.resolve({ exitCode: 0, stdout: "{}", stderr: "" }) };
    await expect(readSealedDnsRecord(docker, "rovara-svc-0123456789ab-dns")).resolves.toEqual({ unknown: [], dropped: 0, unrecorded: 0 });
    for (const bad of ["xrovara-svc-0123456789ab-dns", "rovara-svc-0123456789ab-dns\n", "rovara-svc-0123456789ab-x-dns", "rovara-svc-0123456789ab", "rovara-svc-0123456789AB-dns", "rovara-svc-0123456789a-dns", "rovara-svc-0123456789abc-dns", "rovara-svc--dns", "rovara-svc-0123456789ab-dns-dns"]) {
      await expect(readSealedDnsRecord(docker, bad), JSON.stringify(bad)).rejects.toThrow(config("CONFIG_INVALID"));
    }
  });

  it("M4: a recorded name is at most 64 characters", () => {
    const sixtyFour = `${"a".repeat(63)}b`;
    const parsed = parseSealedDnsRecord(JSON.stringify({ unknown: [{ name: sixtyFour, queries: 1 }, { name: `${sixtyFour}c`, queries: 1 }], dropped: 0, unrecorded: 0 }));
    expect(parsed.unknown).toEqual([{ name: sixtyFour, queries: 1 }]);
  });
});

/** A docker with a little state: the working sandbox's networks, whether the check sandbox exists, and every call in order. */
function statefulDocker(state: { networks: string[]; sandboxExists?: boolean; rmFails?: boolean; connectFails?: boolean; startFails?: boolean; guardExit?: number; guardRejects?: boolean; guardExitOnStep?: { verify?: number }; guardSurvivesRm?: boolean }) {
  const calls: string[][] = [];
  const docker: DockerCli = {
    run: (args) => {
      calls.push([...args]);
      const done = (exitCode = 0, stdout = "") => Promise.resolve({ exitCode, stdout, stderr: "" });
      if (args[0] === "network" && args[1] === "disconnect") { state.networks = state.networks.filter((name) => name !== args[2]); return done(); }
      if (args[0] === "network" && args[1] === "connect") {
        if (state.connectFails === true) return done(1);
        if (state.networks.includes(args[args.length - 2]!)) return done(1);
        state.networks = [...state.networks, args[args.length - 2]!];
        return done();
      }
      if (args[0] === "inspect") return done(0, JSON.stringify(Object.fromEntries(state.networks.map((name) => [name, {}]))));
      if (args[0] === "run" && args.includes("NET_ADMIN")) return state.guardRejects === true ? Promise.reject(new Error("docker went away")) : done(args.includes("-C") ? state.guardExitOnStep?.verify ?? state.guardExit ?? 0 : state.guardExit ?? 0);
      if (args[0] === "run") { if (state.startFails === true) return done(125); state.sandboxExists = true; return done(0, "id\n"); }
      if (args[0] === "rm") { if (state.rmFails !== true) state.sandboxExists = false; return done(state.rmFails === true ? 1 : 0); }
      if (args[0] === "container" && args[1] === "inspect") {
        if (String(args[args.length - 1]).includes("-guard")) return state.guardSurvivesRm === true ? done(0, "guard-id\n") : done(1);
        return done(state.sandboxExists === true ? 0 : 1, state.sandboxExists === true ? "id\n" : "");
      }
      return done(1);
    },
  };
  return { docker, calls, state };
}
const kind = (call: string[]) => (call[0] === "network" ? `${call[0]} ${call[1]}` : call[0] === "container" ? "container inspect" : call[0]!);

describe("one round through withDetachedWorking (review lows 1 and 2)", () => {
  const plan = checkSandboxPlan(input());
  const NET = runNetworkName(RUN);

  it("detaches, runs the round, removes the check sandbox, and only then reattaches", async () => {
    const { docker, calls, state } = statefulDocker({ networks: [NET, "agentx-task"] });
    let seenInRound: string[] = [];
    const result = await withDetachedWorking(docker, plan, async (start) => {
      expect(state.networks).toEqual(["agentx-task"]);
      expect(await start()).toBe("id");
      expect(state.sandboxExists).toBe(true);
      seenInRound = calls.map(kind);
      return "round-result";
    });
    expect(result).toBe("round-result");
    expect(seenInRound).toEqual(["network disconnect", "inspect", "inspect", "run", "run", "run"]);
    const order = calls.map(kind);
    expect(order.indexOf("rm")).toBeGreaterThan(order.indexOf("run"));
    expect(order.indexOf("network connect")).toBeGreaterThan(order.indexOf("rm"));
    expect(order.indexOf("network connect")).toBeGreaterThan(order.lastIndexOf("container inspect"));
    expect(calls.find((call) => call[0] === "rm")).toEqual(["rm", "--force", plan.sandboxName]);
    expect(state.sandboxExists).toBe(false);
    expect(state.networks).toEqual(["agentx-task", NET]);
  });

  it("reattaches and removes the check sandbox when the round fails, and the round's error is the one thrown", async () => {
    const { docker, calls, state } = statefulDocker({ networks: [NET, "agentx-task"] });
    await expect(withDetachedWorking(docker, plan, async (start) => { await start(); throw new Error("the round failed"); })).rejects.toThrow("the round failed");
    expect(state.sandboxExists).toBe(false);
    expect(state.networks).toContain(NET);
    const order = calls.map(kind);
    expect(order.indexOf("network connect")).toBeGreaterThan(order.indexOf("rm"));
  });

  it("removes and reattaches even when the round never started the sandbox", async () => {
    const { docker, calls, state } = statefulDocker({ networks: [NET, "agentx-task"] });
    await withDetachedWorking(docker, plan, () => Promise.resolve(undefined));
    expect(calls.map(kind)).toContain("rm");
    expect(state.networks).toContain(NET);
  });

  it("does not run the round when the detach cannot be proven, and removes and reattaches nothing", async () => {
    const stuck: DockerCli = { run: (args) => Promise.resolve(args[0] === "inspect" ? { exitCode: 0, stdout: JSON.stringify({ [NET]: {} }), stderr: "" } : { exitCode: 0, stdout: "", stderr: "" }) };
    let ran = false;
    await expect(withDetachedWorking(stuck, plan, () => { ran = true; return Promise.resolve(1); })).rejects.toThrow(/still on the run's services network/u);
    expect(ran).toBe(false);
  });

  it("leaves the working sandbox detached and says so when the check sandbox cannot be removed, whatever the round did", async () => {
    for (const roundFails of [false, true]) {
      const { docker, calls, state } = statefulDocker({ networks: [NET, "agentx-task"], rmFails: true });
      const run = withDetachedWorking(docker, plan, async (start) => { await start(); if (roundFails) throw new Error("the round failed"); });
      await expect(run).rejects.toThrow(roundFails ? "the round failed" : /could not be removed/u);
      expect(calls.map(kind)).not.toContain("network connect");
      expect(state.networks).not.toContain(NET);
    }
  });

  it("says so when the working sandbox cannot be reattached after a good round", async () => {
    const { docker } = statefulDocker({ networks: [NET, "agentx-task"], connectFails: true });
    await expect(withDetachedWorking(docker, plan, () => Promise.resolve(1))).rejects.toThrow(/attached to the run's services network again/u);
  });
});

describe("reattaching is idempotent (review low 1)", () => {
  const plan = checkSandboxPlan(input());
  const NET = runNetworkName(RUN);

  it("does nothing when the working sandbox is already on the network", async () => {
    const { docker, calls } = statefulDocker({ networks: [NET, "agentx-task"] });
    await reattachWorkingSandbox(docker, plan);
    await reattachWorkingSandbox(docker, plan);
    expect(calls.map(kind)).toEqual(["inspect", "inspect"]);
  });

  it("connects once, and a second call is a no-op", async () => {
    const { docker, calls, state } = statefulDocker({ networks: ["agentx-task"] });
    await reattachWorkingSandbox(docker, plan);
    await reattachWorkingSandbox(docker, plan);
    expect(calls.filter((call) => call[0] === "network")).toHaveLength(1);
    expect(state.networks).toEqual(["agentx-task", NET]);
  });

  it("passes when docker says the endpoint exists but a look shows it connected, and fails when it is not connected", async () => {
    let looks = 0;
    const racing: DockerCli = {
      run: (args) => {
        if (args[0] === "inspect") { looks += 1; return Promise.resolve({ exitCode: 0, stdout: JSON.stringify(looks >= 2 ? { [NET]: {} } : {}), stderr: "" }); }
        return Promise.resolve({ exitCode: 1, stdout: "", stderr: "endpoint with name already exists in network" });
      },
    };
    await expect(reattachWorkingSandbox(racing, plan)).resolves.toBeUndefined();
    await expect(reattachWorkingSandbox(statefulDocker({ networks: [], connectFails: true }).docker, plan)).rejects.toThrow(/attached to the run's services network again/u);
  });
});

describe("startCheckSandbox checks the plan's arguments again (review low 2)", () => {
  const plan = checkSandboxPlan(input());
  const NET = runNetworkName(RUN);
  const entry = plan.sandboxRunArgs.indexOf("--entrypoint");

  async function startWith(edited: typeof plan) {
    const fake = statefulDocker({ networks: [NET, "agentx-task"] });
    const proof = await detachWorkingSandbox(fake.docker, edited);
    fake.calls.length = 0;
    const result = await startCheckSandbox(fake.docker, edited, proof).then(() => "started", (error: unknown) => error);
    return { result, calls: fake.calls };
  }

  it("starts a sound plan", async () => {
    const { result, calls } = await startWith(plan);
    expect(result).toBe("started");
    expect(calls.map(kind)).toEqual(["inspect", "run", "run", "run"]);
  });

  it("refuses a hand-built plan with --privileged, a published port, another network, another image or another workspace, and runs nothing", async () => {
    const edits: Array<[string, (typeof plan)]> = [
      ["--privileged", { ...plan, sandboxRunArgs: [...plan.sandboxRunArgs.slice(0, entry), "--privileged", ...plan.sandboxRunArgs.slice(entry)] }],
      ["a published port", { ...plan, sandboxRunArgs: [...plan.sandboxRunArgs.slice(0, entry), "-p8080:80", ...plan.sandboxRunArgs.slice(entry)] }],
      ["the default bridge", { ...plan, sandboxRunArgs: plan.sandboxRunArgs.map((arg) => (arg === NET ? "bridge" : arg)) }],
      ["another image", { ...plan, image: "other:img" }],
      ["another workspace", { ...plan, rootPath: "/elsewhere" }],
      ["no args at all", { ...plan, sandboxRunArgs: [] }],
    ];
    for (const [name, edited] of edits) {
      const { result, calls } = await startWith(edited);
      expect(String(result), name).toMatch(/arguments are unsound/u);
      expect(calls.map(kind), name).not.toContain("run");
    }
  });
});

describe("the run files and the workspace are checked harder (review low 3)", () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
  const layout = (overrides: Partial<CheckSandboxInput> = {}) => input({ rootPath: "/workspace/project", maskedPaths: ["/workspace/project/.agentx-state"], filesDir: "/run/rovara/check-1", ...overrides });

  it("refuses a workspace root that is not an absolute path", () => {
    for (const rootPath of ["workspace/project", "./project", "", "project"]) expect(() => checkSandboxPlan(layout({ rootPath, maskedPaths: [] })), rootPath).toThrow(/absolute path/u);
    expect(() => checkSandboxRunArgs(layout({ rootPath: "rel", maskedPaths: [] }), FILES)).toThrow(/absolute path/u);
  });

  it("refuses a masked folder that is not strictly inside the root", () => {
    for (const masked of ["/workspace/other", "/workspace/project", "/workspace/projectx/state", "/workspace", "/", "/workspace/project/../x", "relative/state", "/etc"]) {
      expect(() => checkSandboxPlan(layout({ maskedPaths: [masked] })), masked).toThrow(config("CONFIG_INVALID"));
      expect(() => checkSandboxRunArgs(layout({ maskedPaths: [masked] }), FILES), masked).toThrow(config("CONFIG_INVALID"));
    }
    expect(() => checkSandboxPlan(layout({ maskedPaths: ["/workspace/project/.agentx-state", "/workspace/project/a/b"] }))).not.toThrow();
  });

  it("follows a symbolic link in a parent directory: a link from outside into the workspace is inside", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "check-sandbox-links-")));
    dirs.push(base);
    const ws = join(base, "ws");
    await mkdir(join(ws, "sub"), { recursive: true });
    await mkdir(join(base, "out"));
    await symlink(join(ws, "sub"), join(base, "out", "link"));
    const there = layout({ rootPath: ws, maskedPaths: [] });
    expect(() => checkSandboxPlan({ ...there, filesDir: join(base, "out", "link", "run") })).toThrow(/inside the workspace/u);
    expect(() => checkSandboxPlan({ ...there, filesDir: join(base, "out", "plain") })).not.toThrow();
  });

  it("follows a link the other way: a masked folder that is a link out of the workspace is refused, and a link into a masked folder is accepted", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "check-sandbox-links-")));
    dirs.push(base);
    const ws = join(base, "ws");
    await mkdir(join(ws, "masked"), { recursive: true });
    await mkdir(join(base, "out"));
    await symlink(join(base, "out"), join(ws, "escape"));
    await symlink(join(ws, "masked"), join(base, "into-masked"));
    expect(() => checkSandboxPlan(layout({ rootPath: ws, maskedPaths: [join(ws, "escape")], filesDir: join(base, "files") }))).toThrow(/strictly inside/u);
    expect(() => checkSandboxPlan(layout({ rootPath: ws, maskedPaths: [join(ws, "masked")], filesDir: join(base, "into-masked", "run") }))).not.toThrow();
    expect(() => checkSandboxPlan(layout({ rootPath: ws, maskedPaths: [join(ws, "masked")], filesDir: join(ws, "masked", "run") }))).not.toThrow();
    expect(() => checkSandboxPlan(layout({ rootPath: ws, maskedPaths: [join(ws, "masked")], filesDir: join(ws, "escape", "run") }))).toThrow(/inside the workspace/u);
  });

  it("works for paths that do not exist yet (the usual case): the real path of the nearest existing parent is used", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "check-sandbox-links-")));
    dirs.push(base);
    expect(() => checkSandboxPlan(layout({ rootPath: join(base, "no", "such", "ws"), maskedPaths: [], filesDir: join(base, "files", "deep", "dir") }))).not.toThrow();
    expect(() => checkSandboxPlan(layout({ rootPath: join(base, "no", "such", "ws"), maskedPaths: [], filesDir: join(base, "no", "such", "ws", "x") }))).toThrow(/inside the workspace/u);
  });
});

// TS-SEAL-5 (b): Docker's embedded resolver (127.0.0.11) is closed inside the check sandbox before any command runs, by two short-lived NET_ADMIN helpers that join the sandbox's network namespace.
describe("the resolver guard's arguments (TS-SEAL-5 b)", () => {
  const plan = checkSandboxPlan(input());
  const NET = runNetworkName(RUN);
  const insert = plan.resolverGuardArgs.insert;
  const verify = plan.resolverGuardArgs.verify;
  const guard = insert;
  const expected = { sandboxName: plan.sandboxName, image: GUARD_IMAGE, step: "insert" as const };

  it("is two foreground --rm helpers of the worker's image that join the check sandbox's network namespace by name: one inserts the rule, one reads it back with -C", () => {
    expect(insert).toEqual(resolverGuardRunArgs({ net: network(), guardImage: GUARD_IMAGE, step: "insert" }));
    expect(verify).toEqual(resolverGuardRunArgs({ net: network(), guardImage: GUARD_IMAGE, step: "verify" }));
    expect(insert.slice(0, 5)).toEqual(["run", "--rm", "--pull=never", "--name", `${NET}-check-guard`]);
    expect(verify.slice(0, 5)).toEqual(["run", "--rm", "--pull=never", "--name", `${NET}-check-guard-check`]);
    expect(resolverGuardName(`${NET}-check`)).toBe(`${NET}-check-guard`);
    expect(resolverGuardName(`${NET}-check`, "verify")).toBe(`${NET}-check-guard-check`);
    for (const args of [insert, verify]) {
      expect(args).not.toContain("--detach");
      expect(valuesOf(args, "--network")).toEqual([`container:${NET}-check`]);
    }
    expect(insert.slice(-(RESOLVER_GUARD_STEPS.insert.length + 3))).toEqual(["--entrypoint", RESOLVER_GUARD_BINARY, GUARD_IMAGE, ...RESOLVER_GUARD_STEPS.insert]);
    expect(verify.slice(-(RESOLVER_GUARD_STEPS.verify.length + 3))).toEqual(["--entrypoint", RESOLVER_GUARD_BINARY, GUARD_IMAGE, ...RESOLVER_GUARD_STEPS.verify]);
  });

  it("calls /usr/sbin/iptables-nft by absolute path, with no shell and no PATH lookup", () => {
    expect(RESOLVER_GUARD_BINARY).toBe("/usr/sbin/iptables-nft");
    for (const args of [insert, verify]) {
      expect(valuesOf(args, "--entrypoint")).toEqual(["/usr/sbin/iptables-nft"]);
      expect(args).not.toContain("-c");
      expect(args).not.toContain("/bin/sh");
      expect(args.join(" ")).not.toMatch(/\bsh\b|bash/u);
    }
  });

  it("runs from the WORKER's image, not the sandbox's: a plan whose sandbox image differs still gets the worker image for both guard steps", () => {
    const other = checkSandboxPlan(input({ image: "customer/devcontainer:latest" }));
    expect(other.image).toBe("customer/devcontainer:latest");
    expect(other.guardImage).toBe(GUARD_IMAGE);
    for (const args of [other.resolverGuardArgs.insert, other.resolverGuardArgs.verify]) {
      expect(args).toContain(GUARD_IMAGE);
      expect(args).not.toContain("customer/devcontainer:latest");
      expect(args.some((arg) => arg.includes("devcontainer"))).toBe(false);
    }
    expect(other.sandboxRunArgs).toContain("customer/devcontainer:latest");
    expect(other.sandboxRunArgs).not.toContain(GUARD_IMAGE);
  });

  it("refuses a guard image that is not pinned: a tag, no image, a shell word, a flag", () => {
    for (const bad of ["worker:img", "worker:latest", "", "--privileged", `worker@sha256:${"c".repeat(63)}`, `worker@sha256:${"C".repeat(64)}`, `worker@sha256:${"c".repeat(64)} --privileged`, `UPPER/worker@sha256:${"c".repeat(64)}`]) {
      expect(isPinnedImage(bad), bad).toBe(false);
      expect(() => checkSandboxPlan(input({ guardImage: bad })), bad).toThrow(config("CONFIG_INVALID"));
      expect(() => resolverGuardRunArgs({ net: network(), guardImage: bad, step: "insert" }), bad).toThrow(config("CONFIG_INVALID"));
    }
    for (const good of [GUARD_IMAGE, `sha256:${"d".repeat(64)}`, `123456789012.dkr.ecr.us-west-2.amazonaws.com/agentx-staging/worker@sha256:${"a".repeat(64)}`]) expect(isPinnedImage(good), good).toBe(true);
    expect(checkSandboxPlan(input({ guardImage: `sha256:${"d".repeat(64)}` })).resolverGuardArgs.insert).toContain(`sha256:${"d".repeat(64)}`);
  });

  it("holds NET_ADMIN and nothing else: every capability dropped first, root, no privileges to gain, a read-only root, no mount, no port, no other network", () => {
    for (const args of [insert, verify]) {
      expect(valuesOf(args, "--cap-add")).toEqual(["NET_ADMIN"]);
      expect(valuesOf(args, "--cap-drop")).toEqual(["ALL"]);
      expect(args.indexOf("--cap-drop")).toBeLessThan(args.indexOf("--cap-add"));
      expect(valuesOf(args, "--user")).toEqual(["0:0"]);
      expect(valuesOf(args, "--security-opt")).toEqual(["no-new-privileges"]);
      expect(args).toContain("--read-only");
      expect(valuesOf(args, "--tmpfs")).toEqual(["/run:rw,noexec,nosuid,nodev,size=1m"]);
      for (const forbidden of ["--privileged", "--volume", "-v", "--mount", "--publish", "-p", "--ip", "--dns", "--pid", "--env", "--device", "--sysctl", "--detach"]) expect(args, forbidden).not.toContain(forbidden);
      expect(valuesOf(args, "--pids-limit")).toEqual(["32"]);
      expect(valuesOf(args, "--memory")).toEqual(["64m"]);
      expect(valuesOf(args, "--memory-swap")).toEqual(["64m"]);
      expect(valuesOf(args, "--cpus")).toEqual(["0.5"]);
    }
  });

  it("carries the four run-network labels, so a sweep removes a guard that outlived its worker", () => {
    for (const args of [insert, verify]) {
      const labels = valuesOf(args, "--label");
      expect(labels).toEqual(valuesOf(network().labelArgs(), "--label"));
      for (const key of [RUN_NETWORK_LABEL, RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_WORKSPACE_LABEL]) expect(labels.some((label) => label.startsWith(`${key}=`)), key).toBe(true);
    }
  });

  it("is one rule for the ADDRESS alone, in the filter OUTPUT chain, first, for every protocol, and the second step reads that rule back (a port in the rule would never match Docker's rewritten packets)", () => {
    expect(EMBEDDED_RESOLVER_ADDRESS).toBe("127.0.0.11");
    expect(RESOLVER_GUARD_STEPS.insert).toEqual(["-w", "5", "-I", "OUTPUT", "1", "-d", "127.0.0.11/32", "-j", "DROP"]);
    expect(RESOLVER_GUARD_STEPS.verify).toEqual(["-w", "5", "-C", "OUTPUT", "-d", "127.0.0.11/32", "-j", "DROP"]);
    for (const step of Object.values(RESOLVER_GUARD_STEPS)) expect(step.join(" ")).not.toMatch(/--dport|--sport|-p |-t nat|REJECT|ACCEPT/u);
  });

  it("is in the plan, and the check sandbox itself never gets a capability or the network of the guard", () => {
    expect(plan.guardImage).toBe(GUARD_IMAGE);
    expect(plan.sandboxRunArgs).not.toContain("--cap-add");
    expect(plan.sandboxRunArgs).not.toContain("NET_ADMIN");
    expect(valuesOf(plan.sandboxRunArgs, "--cap-drop")).toEqual(["ALL"]);
    // adding NET_ADMIN to the sandbox is a problem of its own
    const paths = { ...FILES, rootPath: ROOT, image: "worker:img", maskedPaths: ["/workspace/project/.agentx-state"] };
    const sandbox = checkSandboxRunArgs(input(), FILES);
    const entry2 = sandbox.indexOf("--entrypoint");
    expect(checkSandboxArgProblems([...sandbox.slice(0, entry2), "--cap-add", "NET_ADMIN", ...sandbox.slice(entry2)], network(), paths).join(" ")).toMatch(/--cap-add, which adds a capability/u);
  });

  it("is judged as sound, and every change to it is a problem: another network, a second capability, privileged, a mount, another program or image, a foreign, repeated or missing label", () => {
    expect(resolverGuardArgProblems(insert, expected)).toEqual([]);
    expect(resolverGuardArgProblems(verify, { ...expected, step: "verify" })).toEqual([]);
    const before = (flag: string) => guard.indexOf(flag);
    const swap = (from: string, to: string) => guard.map((arg) => (arg === from ? to : arg));
    const bad: Array<[string, string[]]> = [
      ["the default bridge", swap(`container:${NET}-check`, "bridge")],
      ["another sandbox's namespace", swap(`container:${NET}-check`, "container:other-sandbox")],
      ["the host network", swap(`container:${NET}-check`, "host")],
      ["a second capability", [...guard.slice(0, before("--cap-add") + 2), "--cap-add", "NET_RAW", ...guard.slice(before("--cap-add") + 2)]],
      ["SYS_ADMIN instead", swap("NET_ADMIN", "SYS_ADMIN")],
      ["privileged", [...guard.slice(0, 5), "--privileged", ...guard.slice(5)]],
      ["a mount", [...guard.slice(0, before("--network")), "--volume", "/:/host", ...guard.slice(before("--network"))]],
      ["a published port", [...guard.slice(0, before("--network")), "-p", "80:80", ...guard.slice(before("--network"))]],
      ["a shell as the program", swap(RESOLVER_GUARD_BINARY, "/bin/sh")],
      ["another program", swap(RESOLVER_GUARD_BINARY, "iptables")],
      ["another rule", [...guard.slice(0, -1), "ACCEPT"]],
      ["an extra argument", [...guard, "id"]],
      ["another image", swap(GUARD_IMAGE, "other:img")],
      ["not root", swap("0:0", "1000:1000")],
      ["a writable root", guard.filter((arg) => arg !== "--read-only")],
      ["a foreign label", [...guard.slice(0, 5), "--label", "evil=1", ...guard.slice(5)]],
      ["a label twice", [...guard.slice(0, 5), "--label", `${RUN_NETWORK_LABEL}=a`, "--label", `${RUN_NETWORK_LABEL}=b`, ...guard.slice(5)]],
      ["a label with a space", [...guard.slice(0, 5), "--label", `${RUN_NETWORK_LABEL}=a b`, ...guard.slice(5)]],
      ["no labels at all", [...guard.slice(0, 5), ...guard.slice(5 + network().labelArgs().length)]],
      ["three of the four labels", [...guard.slice(0, 5), ...network().labelArgs().slice(0, 6), ...guard.slice(5 + network().labelArgs().length)]],
      ["another name", swap(`${NET}-check-guard`, "other-guard")],
      ["not a run command", guard.slice(1)],
      ["nothing", []],
    ];
    for (const [name, args] of bad) expect(resolverGuardArgProblems(args, expected), name).not.toEqual([]);
    expect(resolverGuardArgProblems(insert, { ...expected, image: "other:img" })).not.toEqual([]);
    expect(resolverGuardArgProblems(insert, { ...expected, sandboxName: "other-check" })).not.toEqual([]);
    expect(resolverGuardArgProblems(insert, { ...expected, step: "verify" })).not.toEqual([]);
    expect(resolverGuardArgProblems(swapImage(insert, "worker:img"), { ...expected, image: "worker:img" })).toEqual(expect.arrayContaining([expect.stringMatching(/pinned image/u)]));
    function swapImage(args: string[], image: string): string[] { return args.map((arg) => (arg === GUARD_IMAGE ? image : arg)); }
  });

  it("requires all four run labels (a missing one is named)", () => {
    const labelArgs = network().labelArgs();
    const three = [...insert.slice(0, 5), ...labelArgs.slice(0, 6), ...insert.slice(5 + labelArgs.length)];
    expect(resolverGuardArgProblems(three, expected)).toEqual(expect.arrayContaining([expect.stringMatching(/all four run labels/u)]));
    expect(() => resolverGuardRunArgs({ net: network({ labelArgs: () => labelArgs.slice(0, 6) }), guardImage: GUARD_IMAGE, step: "insert" })).toThrow(config("CONFIG_INVALID"));
  });

  it("refuses a name that is not a plain container name, and a network that is not a run's", () => {
    for (const bad of ["--privileged", "", "a b", "x".repeat(200)]) expect(() => resolverGuardName(bad), bad).toThrow(config("CONFIG_INVALID"));
    expect(() => resolverGuardRunArgs({ net: network({ name: "bridge" }), guardImage: GUARD_IMAGE, step: "insert" })).toThrow(config("CONFIG_INVALID"));
  });
});

describe("the resolver guard runs before the check sandbox is handed back, and the round fails closed without it (TS-SEAL-5 b)", () => {
  const plan = checkSandboxPlan(input());
  const NET = runNetworkName(RUN);

  async function start(state: Parameters<typeof statefulDocker>[0], edited: typeof plan = plan, signal?: AbortSignal) {
    const fake = statefulDocker(state);
    const proof = await detachWorkingSandbox(fake.docker, edited);
    fake.calls.length = 0;
    const result = await startCheckSandbox(fake.docker, edited, proof, signal === undefined ? {} : { signal }).then((id) => id, (error: unknown) => error);
    return { result, calls: fake.calls, state };
  }
  const guardRuns = (calls: string[][]) => calls.filter((call) => call.includes("NET_ADMIN"));

  it("starts the sandbox, then runs the guard's two steps in order, then returns: nothing else runs between", async () => {
    const { result, calls } = await start({ networks: [NET, "agentx-task"] });
    expect(result).toBe("id");
    expect(calls.map(kind)).toEqual(["inspect", "run", "run", "run"]);
    expect(calls[1]).toEqual(plan.sandboxRunArgs);
    expect(calls[2]).toEqual(plan.resolverGuardArgs.insert);
    expect(calls[3]).toEqual(plan.resolverGuardArgs.verify);
  });

  it("with a sandbox image that is not the worker's, the guard still runs the worker's image", async () => {
    const other = checkSandboxPlan(input({ image: "customer/devcontainer:latest" }));
    const { result, calls } = await start({ networks: [NET, "agentx-task"] }, other);
    expect(result).toBe("id");
    expect(calls[1]).toContain("customer/devcontainer:latest");
    for (const call of guardRuns(calls)) { expect(call).toContain(GUARD_IMAGE); expect(call).not.toContain("customer/devcontainer:latest"); }
    expect(guardRuns(calls)).toHaveLength(2);
  });

  it("fails closed when the first step exits non-zero (iptables missing, no NET_ADMIN): the second step does not run, the guards and the sandbox are removed, the id is never returned", async () => {
    const { result, calls, state } = await start({ networks: [NET, "agentx-task"], guardExit: 1 });
    expect(String(result)).toMatch(/embedded resolver could not be closed, so the sealed round did not start/u);
    expect(String(result)).not.toMatch(/could not be removed/u);
    expect(result).toEqual(expect.objectContaining({ code: "RUNTIME_UNAVAILABLE" }));
    expect(guardRuns(calls)).toEqual([plan.resolverGuardArgs.insert]);
    expect(calls.filter((call) => call[0] === "rm")).toEqual([["rm", "--force", `${NET}-check-guard`], ["rm", "--force", `${NET}-check-guard-check`], ["rm", "--force", `${NET}-check`]]);
    expect(state.sandboxExists).toBe(false);
  });

  it("fails closed when the read-back (the second step) fails: the rule is not there", async () => {
    const { result, calls, state } = await start({ networks: [NET, "agentx-task"], guardExitOnStep: { verify: 1 } });
    expect(String(result)).toMatch(/could not be closed/u);
    expect(guardRuns(calls)).toEqual([plan.resolverGuardArgs.insert, plan.resolverGuardArgs.verify]);
    expect(state.sandboxExists).toBe(false);
  });

  it("fails closed when docker itself fails the guard's call (a timeout or a lost connection)", async () => {
    const { result, calls, state } = await start({ networks: [NET, "agentx-task"], guardRejects: true });
    expect(String(result)).toMatch(/could not be closed/u);
    expect(calls.filter((call) => call[0] === "rm")).toHaveLength(3);
    expect(state.sandboxExists).toBe(false);
  });

  it("says so, specifically, when a guard container cannot be removed afterwards (a leftover with NET_ADMIN)", async () => {
    const { result } = await start({ networks: [NET, "agentx-task"], guardExit: 1, guardSurvivesRm: true });
    expect(String(result)).toMatch(/resolver guard container could not be removed/u);
    expect(result).toEqual(expect.objectContaining({ code: "RUNTIME_UNAVAILABLE" }));
  });

  it("says so, specifically, when the check sandbox itself cannot be removed after a failed guard (it is still up without the rule)", async () => {
    const { result } = await start({ networks: [NET, "agentx-task"], guardExit: 1, rmFails: true });
    expect(String(result)).toMatch(/embedded resolver could not be closed/u);
    expect(String(result)).toMatch(/check sandbox itself could not be removed and is still running without the rule/u);
    expect(String(result)).not.toMatch(/guard container could not be removed/u);
    const both = await start({ networks: [NET, "agentx-task"], guardExit: 1, rmFails: true, guardSurvivesRm: true });
    expect(String(both.result)).toMatch(/guard container could not be removed, and the check sandbox itself could not be removed/u);
  });

  it("does not run the guard when the sandbox did not start", async () => {
    const { result, calls } = await start({ networks: [NET, "agentx-task"], startFails: true });
    expect(String(result)).toMatch(/could not be started/u);
    expect(guardRuns(calls)).toEqual([]);
  });

  it("passes the round's abort signal to the guard's docker calls, and a round already aborted does not run the guard but fails closed", async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const fake = statefulDocker({ networks: [NET, "agentx-task"] });
    const inner = fake.docker.run.bind(fake.docker);
    const docker: DockerCli = { run: (args, options) => { if (args.includes("NET_ADMIN")) seen.push(options?.signal); return inner(args, options); } };
    const proof = await detachWorkingSandbox(docker, plan);
    const controller = new AbortController();
    await startCheckSandbox(docker, plan, proof, { signal: controller.signal });
    expect(seen).toEqual([controller.signal, controller.signal]);
    controller.abort();
    const aborted = await start({ networks: [NET, "agentx-task"] }, plan, controller.signal);
    expect(String(aborted.result)).toMatch(/could not be closed/u);
    expect(guardRuns(aborted.calls)).toEqual([]);
    expect(aborted.state.sandboxExists).toBe(false);
  });

  it("refuses a plan whose guard arguments or guard image were edited, before anything starts (NET_ADMIN in the wrong place, another network, a different program, a tag)", async () => {
    const swapAll = (from: string, to: string) => ({ insert: plan.resolverGuardArgs.insert.map((arg) => (arg === from ? to : arg)), verify: plan.resolverGuardArgs.verify.map((arg) => (arg === from ? to : arg)) });
    const edits: Array<[string, typeof plan]> = [
      ["another capability", { ...plan, resolverGuardArgs: swapAll("NET_ADMIN", "SYS_ADMIN") }],
      ["the host network", { ...plan, resolverGuardArgs: { ...plan.resolverGuardArgs, insert: plan.resolverGuardArgs.insert.map((arg) => (arg.startsWith("container:") ? "host" : arg)) } }],
      ["no guard", { ...plan, resolverGuardArgs: { insert: [], verify: [] } }],
      ["a shell", { ...plan, resolverGuardArgs: swapAll("/usr/sbin/iptables-nft", "/bin/sh") }],
      ["a tag as the guard image", { ...plan, guardImage: "worker:img", resolverGuardArgs: swapAll(GUARD_IMAGE, "worker:img") }],
      ["the guard image changed in the plan only", { ...plan, guardImage: `registry.example.test/agentx/worker@sha256:${"e".repeat(64)}` }],
    ];
    for (const [name, edited] of edits) {
      const { result, calls } = await start({ networks: [NET, "agentx-task"] }, edited);
      expect(String(result), name).toMatch(/resolver guard is unsound/u);
      expect(calls.map(kind), name).not.toContain("run");
    }
  });

  it("through withDetachedWorking: a guard failure stops the round before its first command, removes the sandbox and puts the working sandbox back", async () => {
    const { docker, calls, state } = statefulDocker({ networks: [NET, "agentx-task"], guardExit: 125 });
    let ranCommand = false;
    await expect(withDetachedWorking(docker, plan, async (begin) => { await begin(); ranCommand = true; })).rejects.toThrow(/could not be closed/u);
    expect(ranCommand).toBe(false);
    expect(state.sandboxExists).toBe(false);
    expect(state.networks).toContain(NET);
    expect(calls.map(kind)).not.toContain("exec");
  });

  it("every round runs its own guard: two rounds, four steps", async () => {
    const { docker, calls } = statefulDocker({ networks: [NET, "agentx-task"] });
    for (let round = 0; round < 2; round += 1) await withDetachedWorking(docker, plan, async (begin) => { await begin(); });
    expect(guardRuns(calls)).toHaveLength(4);
  });
});
