// TS13: the per-run services network (test-services.md 4.0.1, 4.0.6). Nothing starts Docker: a small stateful fake daemon answers the few commands the module uses (network create/rm/ls, ps, rm), with the same
// collision errors Docker gives, so slot reuse, the sweep and the labels are checked against behaviour and not only against argument lists.
import { describe, expect, it } from "vitest";
import { RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_LABEL, RUN_NETWORK_SLOTS, RUN_NETWORK_WORKSPACE_LABEL, runNetworkAddresses, runNetworkCreateArgs, runNetworkHelperIp, runNetworkName, servicesNetworkStaleAfterMs, startServicesNetwork, sweepServicesNetworks } from "../../packages/worker/src/run-network.js";
import { SETUP_NETWORK_LABEL, SETUP_WORKSPACE_LABEL } from "../../packages/worker/src/setup-network.js";
import type { DockerCli } from "../../packages/worker/src/docker-cli.js";

const RUN = "11111111-1111-4111-8111-111111111111";
const WS = "0123456789abcdef";
const OTHER_WS = "fedcba9876543210";
const BUDGET = 600_000;
const NOW = 1_800_000_000_000;
/** The budget plus 15 minutes: what a run's objects live before an allocation's sweep may take them. */
const EXPIRY = BUDGET + 15 * 60_000;
const SENTENCE = "AgentX could not set up the network for the test services";

interface FakeObject { id: string; name: string; labels: Record<string, string>; subnet?: string; bridge?: string; network?: string }

/** A Docker daemon that keeps containers and networks, honours `--filter label=k[=v]` and `--format` for the lists the module reads, and refuses what Docker refuses. */
function fakeDaemon(options: { lax?: boolean } = {}) {
  const networks: FakeObject[] = [];
  const containers: FakeObject[] = [];
  const calls: string[][] = [];
  let ids = 0;
  const filtersOf = (args: readonly string[]) => args.flatMap((arg, index) => (args[index - 1] === "--filter" ? [arg] : []));
  const matches = (object: FakeObject, filters: string[]) => filters.every((filter) => {
    const label = /^label=([^=]+)(?:=(.*))?$/u.exec(filter);
    if (!label) return true;
    return label[2] === undefined ? label[1]! in object.labels : object.labels[label[1]!] === label[2];
  });
  const format = (object: FakeObject, template: string) => template.replace(/\{\{\.ID\}\}/gu, object.id).replace(/\{\{\.Label "([^"]+)"\}\}/gu, (_all, key: string) => object.labels[key] ?? "").replace(/\{\{index \.Labels "([^"]+)"\}\}/gu, (_all, key: string) => object.labels[key] ?? "");
  const list = (kind: FakeObject[], args: readonly string[]) => {
    const template = args.includes("--format") ? args[args.indexOf("--format") + 1] : undefined;
    const rows = (options.lax ? kind : kind.filter((object) => matches(object, filtersOf(args)))).map((object) => (template === undefined ? object.id : format(object, template)));
    return { exitCode: 0, stdout: rows.join("\n"), stderr: "" };
  };
  const labelsOf = (args: readonly string[]) => Object.fromEntries(args.flatMap((arg, index) => (args[index - 1] === "--label" ? [arg.split(/=(.*)/su).slice(0, 2) as [string, string]] : [])));
  const docker: DockerCli = {
    run(args) {
      calls.push([...args]);
      const [a, b] = args;
      if (a === "network" && b === "create") {
        const subnet = args[args.indexOf("--subnet") + 1]!;
        const bridge = args.find((arg) => arg.startsWith("com.docker.network.bridge.name="))!.split("=")[1]!;
        const name = args.at(-1)!;
        if (networks.some((n) => n.name === name)) return Promise.resolve({ exitCode: 1, stdout: "", stderr: `network with name ${name} already exists` });
        if (networks.some((n) => n.subnet === subnet)) return Promise.resolve({ exitCode: 1, stdout: "", stderr: "Error response from daemon: Pool overlaps with other one on this address space" });
        if (networks.some((n) => n.bridge === bridge)) return Promise.resolve({ exitCode: 1, stdout: "", stderr: `Error response from daemon: bridge device ${bridge} already exists` });
        networks.push({ id: `net${String(++ids)}`, name, labels: labelsOf(args), subnet, bridge });
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      }
      if (a === "network" && b === "inspect") {
        const found = networks.find((n) => n.name === args.at(-1) || n.id === args.at(-1));
        return Promise.resolve(found === undefined ? { exitCode: 1, stdout: "", stderr: "No such network" } : { exitCode: 0, stdout: format(found, args[args.indexOf("--format") + 1]!), stderr: "" });
      }
      if (a === "network" && b === "ls") return Promise.resolve(list(networks, args));
      if (a === "network" && b === "rm") {
        const target = args[2]!;
        const index = networks.findIndex((n) => n.id === target || n.name === target);
        if (index < 0) return Promise.resolve({ exitCode: 1, stdout: "", stderr: "No such network" });
        if (containers.some((c) => c.network === networks[index]!.name)) return Promise.resolve({ exitCode: 1, stdout: "", stderr: "network has active endpoints" });
        networks.splice(index, 1);
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      }
      if (a === "ps") return Promise.resolve(list(containers, args));
      if (a === "rm") {
        for (const target of args.slice(1).filter((arg) => !arg.startsWith("-"))) {
          const index = containers.findIndex((c) => c.id === target || c.name === target);
          if (index >= 0) containers.splice(index, 1);
        }
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    },
  };
  /** The labels of a run's objects; `expiresAt` defaults to creation + the usual budget + 15 minutes. */
  const familyLabels = (runId: string, createdAt: number, workspace = WS, expiresAt = createdAt + servicesNetworkStaleAfterMs(BUDGET)) => ({ [RUN_NETWORK_LABEL]: runNetworkName(runId), [RUN_NETWORK_CREATED_LABEL]: String(createdAt), [RUN_NETWORK_EXPIRES_LABEL]: String(expiresAt), [RUN_NETWORK_WORKSPACE_LABEL]: workspace });
  const addContainer = (name: string, labels: Record<string, string>, network?: string) => { const c: FakeObject = { id: `ctr${String(++ids)}`, name, labels, ...(network ? { network } : {}) }; containers.push(c); return c; };
  const addNetwork = (name: string, labels: Record<string, string>, subnet: string, bridge: string) => { const n: FakeObject = { id: `net${String(++ids)}`, name, labels, subnet, bridge }; networks.push(n); return n; };
  return { docker, calls, networks, containers, familyLabels, addContainer, addNetwork };
}

describe("names, slots and addresses", () => {
  it("fixes the addresses of a slot: gateway .1, DNS helper .2, working sandbox .3, check sandbox .4, proxy .8, helpers .16 to .47", () => {
    expect(runNetworkAddresses(7)).toEqual({ subnet: "172.30.7.0/24", gateway: "172.30.7.1", ipRange: "172.30.7.128/25", dnsHelperIp: "172.30.7.2", workingSandboxIp: "172.30.7.3", checkSandboxIp: "172.30.7.4", proxyIp: "172.30.7.8" });
    expect(runNetworkHelperIp(7, 0)).toBe("172.30.7.16");
    expect(runNetworkHelperIp(7, 31)).toBe("172.30.7.47");
    expect(() => runNetworkHelperIp(7, 32)).toThrow();
    expect(() => runNetworkHelperIp(7, -1)).toThrow();
    expect(() => runNetworkHelperIp(7, 1.5)).toThrow();
    expect(() => runNetworkAddresses(0)).toThrow();
    expect(() => runNetworkAddresses(RUN_NETWORK_SLOTS + 1)).toThrow();
    expect(() => runNetworkAddresses(1.5)).toThrow();
    expect(RUN_NETWORK_SLOTS).toBe(253);
  });
});

describe("the network arguments (snapshot)", () => {
  it("is an internal bridge on the fixed /24, named by hash, with the family labels and nothing else", () => {
    const args = runNetworkCreateArgs({ runId: RUN, slot: 153, workspace: WS, createdAt: NOW, expiresAt: NOW + EXPIRY });
    expect(args).toEqual([
      "network", "create", "--driver", "bridge", "--internal",
      "--subnet", "172.30.153.0/24", "--gateway", "172.30.153.1", "--ip-range", "172.30.153.128/25",
      "--opt", "com.docker.network.bridge.name=rvi058c09fd",
      "--label", "rovara.run-network=rovara-svc-159715ae29a2",
      "--label", "rovara.run-network.created=1800000000000",
      "--label", "rovara.run-network.expires=1800001500000",
      "--label", "rovara.run-network.workspace=0123456789abcdef",
      "rovara-svc-159715ae29a2",
    ]);
  });
});

describe("no repository-controlled string reaches a docker argument", () => {
  it("refuses a run id or a workspace that is not plain, before any docker call, with a sentence that does not repeat it", async () => {
    const hostile = ["a; rm -rf /", "x --privileged", "$(touch /tmp/x)", "../../etc", "a b", "", "x".repeat(65), "run\nid", "--network=host"];
    for (const runId of hostile) {
      const d = fakeDaemon();
      const failure = await startServicesNetwork(d.docker, { runId, workspace: WS, roundBudgetMs: BUDGET, now: () => NOW }).catch((error: unknown) => error as Error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).not.toContain(runId === "" ? "\u0000" : runId);
      expect(d.calls).toEqual([]);
    }
    for (const workspace of ["--privileged", "../x", "ABCDEF0123456789", "0123456789abcde", "0123456789abcdef0", ""]) {
      const d = fakeDaemon();
      await expect(startServicesNetwork(d.docker, { runId: RUN, workspace, roundBudgetMs: BUDGET, now: () => NOW })).rejects.toThrow();
      expect(d.calls).toEqual([]);
    }
  });
});

describe("starting a run's network", () => {
  it("tries the next slot when the subnet or the host interface name is taken, up to 8 times, then gives one fixed sentence and never the docker error", async () => {
    const taken = fakeDaemon();
    taken.addNetwork("someone-else", {}, "172.30.153.0/24", "rvizzzzzzzz");
    const net = await startServicesNetwork(taken.docker, { runId: RUN, workspace: WS, roundBudgetMs: BUDGET, now: () => NOW });
    expect(net.slot).toBe(154);
    expect(net.bridge).toBe("rviaa00d2c8");
    const full = fakeDaemon();
    for (let slot = 153; slot < 153 + 8; slot += 1) full.addNetwork(`n${String(slot)}`, {}, `172.30.${String(slot)}.0/24`, `rvin${String(slot)}`);
    const failure = await startServicesNetwork(full.docker, { runId: RUN, workspace: WS, roundBudgetMs: BUDGET, now: () => NOW }).catch((error: unknown) => error as Error);
    expect((failure as Error).message).toContain(SENTENCE);
    expect(full.calls.filter((call) => call[1] === "create")).toHaveLength(8);
  });
  it("L1: a network of this run's own name left by a failed stop or a kill (this workspace's, this run's labels) is removed with its helpers and the start goes through, once", async () => {
    const d = fakeDaemon();
    const first = await startServicesNetwork(d.docker, { runId: RUN, workspace: WS, roundBudgetMs: BUDGET, now: () => NOW });
    d.addContainer("left-helper", d.familyLabels(RUN, NOW), first.name);
    d.calls.length = 0;
    const again = await startServicesNetwork(d.docker, { runId: RUN, workspace: WS, roundBudgetMs: BUDGET, now: () => NOW + 1000 });
    expect(again.slot).toBe(first.slot);
    expect(d.containers).toHaveLength(0);
    expect(d.networks).toHaveLength(1);
    expect(d.calls.filter((call) => call[1] === "create")).toHaveLength(2);
  });
  it("L1: the retry happens once: a network that cannot be removed ends the start", async () => {
    const d = fakeDaemon();
    await startServicesNetwork(d.docker, { runId: RUN, workspace: WS, roundBudgetMs: BUDGET, now: () => NOW });
    const stuck: DockerCli = { run: (args) => (args[0] === "network" && args[1] === "rm" ? Promise.resolve({ exitCode: 1, stdout: "", stderr: "busy" }) : d.docker.run(args)) };
    d.calls.length = 0;
    const failure = await startServicesNetwork(stuck, { runId: RUN, workspace: WS, roundBudgetMs: BUDGET, now: () => NOW + 1 }).catch((error: unknown) => error as Error);
    expect((failure as Error).message).toContain(SENTENCE);
    expect(d.calls.filter((call) => call[1] === "create")).toHaveLength(1);
  });
  it("rejects a round budget that is not a positive whole number of milliseconds", async () => {
    for (const roundBudgetMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(startServicesNetwork(fakeDaemon().docker, { runId: RUN, workspace: WS, roundBudgetMs, now: () => NOW })).rejects.toThrow();
    }
  });
});

describe("stopping a run's network", () => {
  it("never throws, even when docker is gone; it tries three times and a later stop tries again; the worker-start sweep removes what is left (TS-L6)", async () => {
    const d = fakeDaemon();
    let down = true;
    const gone: DockerCli = { run: (args) => (down && (args[0] === "rm" || args[1] === "rm" || args[0] === "ps") ? Promise.reject(new Error("docker is gone")) : d.docker.run(args)) };
    const net = await startServicesNetwork(gone, { runId: RUN, workspace: WS, roundBudgetMs: BUDGET, now: () => NOW });
    d.calls.length = 0;
    await expect(net.stop()).resolves.toBeUndefined();
    expect(d.networks).toHaveLength(1);
    down = false;
    await net.stop();
    expect(d.networks).toHaveLength(0);
    // And a network the daemon lost in the meantime is a finished stop, not a retry forever.
    const e = fakeDaemon();
    const other = await startServicesNetwork(e.docker, { runId: RUN, workspace: WS, roundBudgetMs: BUDGET, now: () => NOW });
    e.networks.length = 0;
    await other.stop();
    e.calls.length = 0;
    await other.stop();
    expect(e.calls).toEqual([]);
  });
});

describe("the sweep removes only this run family's objects", () => {
  const OLD = NOW - 2 * servicesNetworkStaleAfterMs(BUDGET);
  const build = (options: { lax?: boolean } = {}) => {
    const d = fakeDaemon(options);
    const staleNet = d.addNetwork("rovara-svc-stale", d.familyLabels("44444444-4444-4444-8444-444444444444", OLD), "172.30.9.0/24", "rvi00000009");
    const staleBox = d.addContainer("stale-helper", d.familyLabels("44444444-4444-4444-8444-444444444444", OLD), staleNet.name);
    const youngNet = d.addNetwork("rovara-svc-young", d.familyLabels("55555555-5555-4555-8555-555555555555", NOW - 1000), "172.30.10.0/24", "rvi0000000a");
    const youngBox = d.addContainer("young-helper", d.familyLabels("55555555-5555-4555-8555-555555555555", NOW - 1000), youngNet.name);
    const otherWsNet = d.addNetwork("rovara-svc-otherws", d.familyLabels("66666666-6666-4666-8666-666666666666", OLD, OTHER_WS), "172.30.11.0/24", "rvi0000000b");
    const otherWsBox = d.addContainer("otherws-helper", d.familyLabels("66666666-6666-4666-8666-666666666666", OLD, OTHER_WS), otherWsNet.name);
    const setupNet = d.addNetwork("agentx-setup-abc", { [SETUP_NETWORK_LABEL]: "agentx-setup-abc", [SETUP_WORKSPACE_LABEL]: WS }, "172.29.5.0/24", "rvbs5");
    const setupBox = d.addContainer("agentx-setup-abc-dns", { [SETUP_NETWORK_LABEL]: "agentx-setup-abc", [SETUP_WORKSPACE_LABEL]: WS }, setupNet.name);
    const e2eNet = d.addNetwork("rovara-e2e-9", { "rovara.run": "9", "rovara.created": String(OLD) }, "10.9.0.0/24", "rvi12345678");
    const e2eBox = d.addContainer("rovara-e2e-9-app", { "rovara.run": "9", "rovara.created": String(OLD) }, e2eNet.name);
    const plain = d.addContainer("postgres-dev", {}, "bridge");
    const noExpiry = d.addContainer("family-no-expiry", { [RUN_NETWORK_LABEL]: "rovara-svc-aaaaaaaaaaaa", [RUN_NETWORK_WORKSPACE_LABEL]: WS });
    const oddFamily = d.addContainer("family-odd-value", { ...d.familyLabels(RUN, OLD), [RUN_NETWORK_LABEL]: "somebody-elses-family" });
    const badAge = d.addContainer("family-bad-age", { ...d.familyLabels("77777777-7777-4777-8777-777777777777", OLD), [RUN_NETWORK_EXPIRES_LABEL]: "long ago" });
    return { d, staleNet, staleBox, youngNet, youngBox, otherWsNet, otherWsBox, setupNet, setupBox, e2eNet, e2eBox, plain, noExpiry, oddFamily, badAge };
  };
  for (const lax of [false, true]) {
    it(`removes the expired objects of this workspace and family and nothing else${lax ? " (even when the daemon ignores the filters and lists everything)" : ""}`, async () => {
      const w = build({ lax });
      const result = await sweepServicesNetworks(w.d.docker, { workspace: WS, now: () => NOW });
      expect(result).toEqual({ containers: 1, networks: 1 });
      expect(w.d.containers.map((c) => c.name).sort()).toEqual(["agentx-setup-abc-dns", "family-bad-age", "family-no-expiry", "family-odd-value", "otherws-helper", "postgres-dev", "rovara-e2e-9-app", "young-helper"]);
      expect(w.d.networks.map((n) => n.name).sort()).toEqual(["agentx-setup-abc", "rovara-e2e-9", "rovara-svc-otherws", "rovara-svc-young"]);
    });
  }
});

