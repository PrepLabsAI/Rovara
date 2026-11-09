// TS13: the per-run services network (test-services.md 4.0.1, 4.0.6). Nothing starts Docker: a small stateful fake daemon answers the few commands the module uses (network create/rm/ls, ps, rm), with the same
// collision errors Docker gives, so slot reuse, the sweep and the labels are checked against behaviour and not only against argument lists.
import { describe, expect, it } from "vitest";
import {
  RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_LABEL, RUN_NETWORK_SLOTS, RUN_NETWORK_WORKSPACE_LABEL,
  runNetworkAddresses, runNetworkBridge, runNetworkCreateArgs, runNetworkHelperIp, runNetworkLabelArgs, runNetworkName,
  servicesNetworkStaleAfterMs, startServicesNetwork, sweepServicesNetworks,
} from "../../packages/worker/src/run-network.js";
import { SETUP_NETWORK_LABEL, SETUP_WORKSPACE_LABEL, setupNetworkSlot } from "../../packages/worker/src/setup-network.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

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

/** A run id whose first slot is the same as another's: the two collide until one is gone. */
function runIdWithSlotOf(other: string): string {
  for (let n = 0; n < 5000; n += 1) {
    const candidate = `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
    if (candidate !== other && setupNetworkSlot(candidate) === setupNetworkSlot(other)) return candidate;
  }
  throw new Error("no colliding run id found");
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
  it("is in its own range, not the setup run's 172.29, and its bridge is rvi + 8 hex (inside the boot firewall's rvi+ wall, 11 of 15 characters)", () => {
    for (const slot of [1, 2, 100, 253]) expect(runNetworkAddresses(slot).subnet.startsWith(`172.30.${String(slot)}.`)).toBe(true);
    const bridge = runNetworkBridge(RUN, 153);
    expect(bridge).toMatch(/^rvi[0-9a-f]{8}$/u);
    expect(bridge).toBe("rvi058c09fd");
    expect(runNetworkBridge(RUN, 154)).not.toBe(bridge);
    expect(runNetworkName(RUN)).toBe("rovara-svc-159715ae29a2");
    expect(runNetworkName(RUN)).not.toBe(runNetworkName("11111111-1111-4111-8111-111111111112"));
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
  it("gives helpers the same four labels, so the sweep finds them", () => {
    expect(runNetworkLabelArgs({ runId: RUN, workspace: WS, createdAt: NOW, expiresAt: NOW + EXPIRY })).toEqual([
      "--label", "rovara.run-network=rovara-svc-159715ae29a2",
      "--label", "rovara.run-network.created=1800000000000",
      "--label", "rovara.run-network.expires=1800001500000",
      "--label", "rovara.run-network.workspace=0123456789abcdef",
    ]);
  });
  it("uses its own labels, never the setup run's or the end-to-end checker's, so none of the three sweeps can touch another's", () => {
    expect(RUN_NETWORK_LABEL).not.toBe(SETUP_NETWORK_LABEL);
    expect(RUN_NETWORK_WORKSPACE_LABEL).not.toBe(SETUP_WORKSPACE_LABEL);
    for (const label of [RUN_NETWORK_LABEL, RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_WORKSPACE_LABEL]) expect(label).not.toBe("rovara.run");
    expect(runNetworkCreateArgs({ runId: RUN, slot: 1, workspace: WS, createdAt: NOW, expiresAt: NOW + EXPIRY }).join(" ")).not.toMatch(/rvbs|172\.29|agentx\.setup|rovara\.run=/u);
  });
});

describe("no repository-controlled string reaches a docker argument", () => {
  const FIXED = new Set(["network", "create", "ls", "rm", "ps", "--all", "--quiet", "--force", "--volumes", "--driver", "bridge", "--internal", "--subnet", "--gateway", "--ip-range", "inspect", "--opt", "--label", "--filter", "--format"]);
  const SHAPES = [
    /^rovara-svc-[0-9a-f]{12}$/u, /^172\.30\.\d{1,3}\.(?:0\/24|1|128\/25)$/u, /^com\.docker\.network\.bridge\.name=rvi[0-9a-f]{8}$/u,
    /^rovara\.run-network=rovara-svc-[0-9a-f]{12}$/u, /^rovara\.run-network\.(?:created|expires)=\d{1,16}$/u, /^rovara\.run-network\.workspace=[0-9a-f]{16}$/u,
    /^label=rovara\.run-network$/u, /^label=rovara\.run-network\.workspace=[0-9a-f]{16}$/u, /^label=rovara\.run-network=rovara-svc-[0-9a-f]{12}$/u,
    /^\{\{\.ID\}\}(?:\t\{\{\.Label "rovara\.run-network(?:\.created|\.expires|\.workspace)?"\}\})*$/u, /^\{\{index \.Labels "rovara\.run-network"\}\}\t\{\{index \.Labels "rovara\.run-network\.workspace"\}\}$/u, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u,
  ];
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
  it("every argument of every call (start, sweep and stop) is a fixed word or a hash- and number-shaped value", async () => {
    const d = fakeDaemon();
    const net = await startServicesNetwork(d.docker, { runId: RUN, workspace: WS, roundBudgetMs: BUDGET, now: () => NOW });
    d.addContainer("helper", d.familyLabels(RUN, NOW), net.name);
    await sweepServicesNetworks(d.docker, { workspace: WS, workerStart: true, now: () => NOW });
    await net.stop();
    expect(d.calls.length).toBeGreaterThan(4);
    for (const call of d.calls) for (const arg of call) expect(FIXED.has(arg) || SHAPES.some((shape) => shape.test(arg)), `unexpected docker argument: ${arg}`).toBe(true);
  });
  it("passes on only plain object ids from a docker listing: a hostile id is skipped, a plain one is removed", async () => {
    const d = fakeDaemon();
    const evil = d.addContainer("evil", d.familyLabels(RUN, NOW - 10_000_000, WS, NOW - 1));
    evil.id = "--privileged";
    const ok = d.addContainer("ok", d.familyLabels(RUN, NOW - 10_000_000, WS, NOW - 1));
    await sweepServicesNetworks(d.docker, { workspace: WS, now: () => NOW });
    expect(d.calls.filter((call) => call[0] === "rm")).toEqual([["rm", "--force", "--volumes", ok.id]]);
  });
});

describe("starting a run's network", () => {
  it("sweeps first, then creates one network with the first slot's addresses, and hands back the labels, addresses and a stop", async () => {
    const d = fakeDaemon();
    const net = await startServicesNetwork(d.docker, { runId: RUN, workspace: WS, roundBudgetMs: BUDGET, now: () => NOW });
    expect(d.calls.map((call) => `${call[0]} ${call[1]}`)).toEqual(["ps --all", "network ls", "network create"]);
    expect(net).toMatchObject({ name: "rovara-svc-159715ae29a2", bridge: "rvi058c09fd", slot: 153, subnet: "172.30.153.0/24", gateway: "172.30.153.1", dnsHelperIp: "172.30.153.2", workingSandboxIp: "172.30.153.3", checkSandboxIp: "172.30.153.4", proxyIp: "172.30.153.8" });
    expect(net.helperIp(0)).toBe("172.30.153.16");
    expect(net.labelArgs()).toEqual(runNetworkLabelArgs({ runId: RUN, workspace: WS, createdAt: NOW, expiresAt: NOW + EXPIRY }));
    expect(d.networks).toHaveLength(1);
    expect(d.networks[0]!.labels).toEqual(d.familyLabels(RUN, NOW, WS, NOW + EXPIRY));
  });
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
  it("does not retry any other failure, and says only the fixed sentence", async () => {
    const broken: DockerCli = { run: (args) => Promise.resolve(args[1] === "create" ? { exitCode: 1, stdout: "", stderr: "secret detail /var/run" } : { exitCode: 0, stdout: "", stderr: "" }) };
    const failure = await startServicesNetwork(broken, { runId: RUN, workspace: WS, roundBudgetMs: BUDGET, now: () => NOW }).catch((error: unknown) => error as Error);
    expect((failure as Error).message).toContain(SENTENCE);
    expect((failure as Error).message).not.toContain("secret");
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
  it("L1: a network of that name that is NOT this workspace's and run's is never removed, and the start fails with the fixed sentence", async () => {
    for (const labels of [{}, { [RUN_NETWORK_LABEL]: runNetworkName(RUN) }, { [RUN_NETWORK_LABEL]: runNetworkName(RUN), [RUN_NETWORK_WORKSPACE_LABEL]: OTHER_WS }, { [RUN_NETWORK_LABEL]: "rovara-svc-aaaaaaaaaaaa", [RUN_NETWORK_WORKSPACE_LABEL]: WS }]) {
      const d = fakeDaemon();
      d.addNetwork(runNetworkName(RUN), labels, "10.99.0.0/24", "rvi99999999");
      const failure = await startServicesNetwork(d.docker, { runId: RUN, workspace: WS, roundBudgetMs: BUDGET, now: () => NOW }).catch((error: unknown) => error as Error);
      expect((failure as Error).message).toContain(SENTENCE);
      expect(d.networks).toHaveLength(1);
      expect(d.calls.filter((call) => call[1] === "create")).toHaveLength(1);
      expect(d.calls.some((call) => call[1] === "rm")).toBe(false);
    }
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
  it("M2: dynamic addresses come from the upper half of the /24, never the reserved .1 to .47", () => {
    const args = runNetworkCreateArgs({ runId: RUN, slot: 9, workspace: WS, createdAt: NOW, expiresAt: NOW + EXPIRY });
    expect(args[args.indexOf("--ip-range") + 1]).toBe("172.30.9.128/25");
    expect(runNetworkAddresses(9).ipRange).toBe("172.30.9.128/25");
  });
  it("a sweep that fails does not stop the start", async () => {
    const d = fakeDaemon();
    const flaky: DockerCli = { run: (args) => (args[0] === "ps" || (args[0] === "network" && args[1] === "ls") ? Promise.reject(new Error("daemon busy")) : d.docker.run(args)) };
    const net = await startServicesNetwork(flaky, { runId: RUN, workspace: WS, roundBudgetMs: BUDGET, now: () => NOW });
    expect(net.slot).toBe(153);
  });
  it("rejects a round budget that is not a positive whole number of milliseconds", async () => {
    for (const roundBudgetMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(startServicesNetwork(fakeDaemon().docker, { runId: RUN, workspace: WS, roundBudgetMs, now: () => NOW })).rejects.toThrow();
    }
  });
});

describe("stopping a run's network", () => {
  it("removes the containers that carry the network's label, then the network, once; a second stop does nothing", async () => {
    const d = fakeDaemon();
    const net = await startServicesNetwork(d.docker, { runId: RUN, workspace: WS, roundBudgetMs: BUDGET, now: () => NOW });
    d.addContainer("helper-1", d.familyLabels(RUN, NOW), net.name);
    d.addContainer("helper-2", d.familyLabels(RUN, NOW), net.name);
    const bystander = d.addContainer("bystander", { "rovara.run": "e2e-1" }, "bridge");
    const sibling = d.addContainer("sibling", d.familyLabels("33333333-3333-4333-8333-333333333333", NOW), "rovara-svc-other");
    await net.stop();
    expect(d.networks).toHaveLength(0);
    expect(d.containers.map((c) => c.id)).toEqual([bystander.id, sibling.id]);
    d.calls.length = 0;
    await net.stop();
    expect(d.calls).toEqual([]);
  });
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
  it("L1: stop retries a failed Docker call within one stop, and is done once the network is gone", async () => {
    const d = fakeDaemon();
    let failures = 2;
    const flaky: DockerCli = { run: (args) => (args[0] === "network" && args[1] === "rm" && failures-- > 0 ? Promise.resolve({ exitCode: 1, stdout: "", stderr: "busy" }) : d.docker.run(args)) };
    const net = await startServicesNetwork(flaky, { runId: RUN, workspace: WS, roundBudgetMs: BUDGET, now: () => NOW });
    await net.stop();
    expect(d.networks).toHaveLength(0);
  });
  it("L2: stop lists only this workspace's and this run's objects and re-checks every row, even when the daemon ignores the filters", async () => {
    for (const lax of [false, true]) {
      const d = fakeDaemon({ lax });
      const net = await startServicesNetwork(d.docker, { runId: RUN, workspace: WS, roundBudgetMs: BUDGET, now: () => NOW });
      const mine = d.addContainer("mine", d.familyLabels(RUN, NOW), net.name);
      const otherWorkspace = d.addContainer("other-ws", d.familyLabels(RUN, NOW, OTHER_WS), net.name);
      const otherRun = d.addContainer("other-run", d.familyLabels("33333333-3333-4333-8333-333333333333", NOW), "x");
      d.calls.length = 0;
      await net.stop();
      expect(d.calls[0]!.filter((arg, index) => d.calls[0]![index - 1] === "--filter")).toEqual([`label=rovara.run-network=${net.name}`, `label=rovara.run-network.workspace=${WS}`]);
      expect(d.calls.find((call) => call[0] === "rm")).toEqual(["rm", "--force", "--volumes", mine.id]);
      expect(d.containers.map((c) => c.id)).toEqual([otherWorkspace.id, otherRun.id]);
    }
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
  it("H1: a short run's sweep leaves a longer run's live helpers alone: each object lives until ITS OWN creation + budget + 15 minutes", async () => {
    const d = fakeDaemon();
    const SHORT = 60_000;
    const LONG = 6 * 3_600_000;
    const short = await startServicesNetwork(d.docker, { runId: RUN, workspace: WS, roundBudgetMs: SHORT, now: () => NOW });
    const longRun = "22222222-2222-4222-8222-222222222222";
    const long = await startServicesNetwork(d.docker, { runId: longRun, workspace: WS, roundBudgetMs: LONG, now: () => NOW + 1000 });
    d.addContainer("short-helper", d.familyLabels(RUN, NOW, WS, NOW + servicesNetworkStaleAfterMs(SHORT)), short.name);
    d.addContainer("long-helper", d.familyLabels(longRun, NOW + 1000, WS, NOW + 1000 + servicesNetworkStaleAfterMs(LONG)), long.name);
    expect(d.networks.find((n) => n.name === long.name)!.labels[RUN_NETWORK_EXPIRES_LABEL]).toBe(String(NOW + 1000 + LONG + 15 * 60_000));
    // A third, short run starts two hours in: the short run is long expired and goes; the long run (budget 6 h) has hours left and stays.
    const third = "33333333-3333-4333-8333-333333333333";
    await startServicesNetwork(d.docker, { runId: third, workspace: WS, roundBudgetMs: SHORT, now: () => NOW + 2 * 3_600_000 });
    expect(d.networks.map((n) => n.name).sort()).toEqual([runNetworkName(third), long.name].sort());
    expect(d.containers.map((c) => c.name)).toEqual(["long-helper"]);
    // Right at the long run's own expiry it goes too.
    await sweepServicesNetworks(d.docker, { workspace: WS, now: () => NOW + 1000 + LONG + 15 * 60_000 - 1 });
    expect(d.containers.map((c) => c.name)).toEqual(["long-helper"]);
    await sweepServicesNetworks(d.docker, { workspace: WS, now: () => NOW + 1000 + LONG + 15 * 60_000 });
    expect(d.containers).toHaveLength(0);
  });
  it("asks Docker for only the family label and this workspace's, in both lists", async () => {
    const w = build();
    await sweepServicesNetworks(w.d.docker, { workspace: WS, now: () => NOW });
    const lists = w.d.calls.filter((call) => call[0] === "ps" || (call[0] === "network" && call[1] === "ls"));
    expect(lists).toHaveLength(2);
    for (const call of lists) expect(call.filter((arg, index) => call[index - 1] === "--filter")).toEqual(["label=rovara.run-network", `label=rovara.run-network.workspace=${WS}`]);
  });
  it("removes the containers before the networks they sit on, so a network is never refused for an endpoint the sweep itself holds", async () => {
    const w = build();
    await sweepServicesNetworks(w.d.docker, { workspace: WS, now: () => NOW });
    const order = w.d.calls.filter((call) => call[0] === "rm" || (call[0] === "network" && call[1] === "rm")).map((call) => call[0]);
    expect(order).toEqual(["rm", "network"]);
  });
  it("uses the round budget plus 15 minutes as the time after creation when a run counts as stale", () => {
    expect(servicesNetworkStaleAfterMs(BUDGET)).toBe(BUDGET + 15 * 60_000);
    expect(() => servicesNetworkStaleAfterMs(0)).toThrow();
  });
  it("at a worker's start removes every family object of its own workspace, young ones and ones with no readable expiry too, and none of another worker's", async () => {
    const w = build();
    const result = await sweepServicesNetworks(w.d.docker, { workspace: WS, workerStart: true, now: () => NOW });
    expect(result).toEqual({ containers: 4, networks: 2 });
    expect(w.d.networks.map((n) => n.name)).not.toContain("rovara-svc-young");
    expect(w.d.networks.map((n) => n.name)).toContain("rovara-svc-otherws");
  });
  it("never throws and counts only what docker accepted to remove", async () => {
    const dead: DockerCli = { run: () => Promise.reject(new Error("docker is gone")) };
    await expect(sweepServicesNetworks(dead, { workspace: WS, workerStart: true, now: () => NOW })).resolves.toEqual({ containers: 0, networks: 0 });
    await expect(sweepServicesNetworks(fakeDaemon().docker, { workspace: "not-a-key", workerStart: true, now: () => NOW })).rejects.toThrow();
  });
});

describe("a slot is reused after a kill", () => {
  it("while the killed run's network is still young its slot is busy and the next run takes the next slot; once the sweep removes it the slot is the first choice again", async () => {
    const d = fakeDaemon();
    const killed = await startServicesNetwork(d.docker, { runId: RUN, workspace: WS, roundBudgetMs: BUDGET, now: () => NOW });
    d.addContainer("helper-of-killed", d.familyLabels(RUN, NOW), killed.name);
    // The worker is killed here: stop() is never called.
    const next = runIdWithSlotOf(RUN);
    expect(setupNetworkSlot(next)).toBe(setupNetworkSlot(RUN));
    const whileYoung = await startServicesNetwork(d.docker, { runId: next, workspace: WS, roundBudgetMs: BUDGET, now: () => NOW + 60_000 });
    expect(whileYoung.slot).toBe(killed.slot + 1);
    await whileYoung.stop();
    const later = NOW + servicesNetworkStaleAfterMs(BUDGET) + 1;
    const afterSweep = await startServicesNetwork(d.docker, { runId: next, workspace: WS, roundBudgetMs: BUDGET, now: () => later });
    expect(afterSweep.slot).toBe(killed.slot);
    expect(afterSweep.subnet).toBe(killed.subnet);
    expect(d.containers.map((c) => c.name)).not.toContain("helper-of-killed");
    expect(d.networks.map((n) => n.name)).not.toContain(killed.name);
  });
  it("a restarted worker clears its own killed runs with an age of 0, and the same run id can then start again", async () => {
    const d = fakeDaemon();
    await startServicesNetwork(d.docker, { runId: RUN, workspace: WS, roundBudgetMs: BUDGET, now: () => NOW });
    await sweepServicesNetworks(d.docker, { workspace: WS, workerStart: true, now: () => NOW });
    const again = await startServicesNetwork(d.docker, { runId: RUN, workspace: WS, roundBudgetMs: BUDGET, now: () => NOW });
    expect(again.slot).toBe(153);
  });
});
