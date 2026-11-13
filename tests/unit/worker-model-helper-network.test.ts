// TE-F1b: the model helper's network and launch (te-f1 design 2.2, 3.2, 3.3). Nothing starts Docker: a small stateful fake daemon answers the commands the modules use (network create/connect/rm/ls/inspect, run, inspect,
// ps, rm), so the order of calls, the labels, the number of networks the helper is on and the sweep are checked against behaviour and not only against argument lists.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { builtinModelCatalog } from "@agentx/contracts";
import { RESERVED_RUN_ALIASES, checkSandboxNames } from "../../packages/worker/src/check-sandbox.js";
import {
  MODEL_HELPER_ALIAS, RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_LABEL, RUN_NETWORK_SLOTS, RUN_NETWORK_WORKSPACE_LABEL, runNetworkAddresses, runNetworkHelperIp, runNetworkModelHelperIp,
} from "../../packages/worker/src/run-network.js";
import { HELPER_RESERVED_ALIASES } from "../../packages/worker/src/service-helpers.js";
import {
  MODEL_HELPER_ENTRY, MODEL_HELPER_LEDGER_DIR, MODEL_HELPER_RUN_DIR, modelHelperArgProblems, modelHelperRunArgs,
} from "../../packages/worker/src/model-helper-launch.js";
import {
  MODEL_HELPER_FEATURE, MODEL_HELPER_FAILURE_SENTENCE, modelHelperAdvertisedFeatures, modelHelperOffer, modelHelperRunId, planNonAiModelHostBlock, startModelHelper, sweepModelHelperNetworksAtWorkerStart,
} from "../../packages/worker/src/model-helper-network.js";
import { planModelHostBlock } from "../../packages/worker/src/model-helper-block.js";
import { TASK_SANDBOX_NETWORK, TaskSandbox, taskSandboxRunArgs } from "../../packages/worker/src/task-sandbox.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

const WS = "0123456789abcdef";
const OTHER_WS = "fedcba9876543210";
const TASK = "0b9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c11";
const IMAGE = "worker:test";
const RUN_DIR = "/run/rovara/job1/models";
const NOW = 1_800_000_000_000;
const LABEL_KEYS = [RUN_NETWORK_LABEL, RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_WORKSPACE_LABEL];
/** The boot facts root writes on a named worker whose walls are in place. */
const FACTS = JSON.stringify({ metadataBlocked: true, runWalls: true, ipv6Drops: true, prepull: "off", prepulled: 0, loggedOut: true, dockerVersion: "27.3.1" });
const OFFERED: NodeJS.ProcessEnv = { AGENTX_TEST_SERVICES_BOOT_FACTS: FACTS };

interface FakeNetwork { id: string; name: string; labels: Record<string, string>; subnet: string; bridge: string; internal: boolean }
interface FakeContainer { id: string; name: string; labels: Record<string, string>; networks: Map<string, string>; args: string[]; running: boolean }
interface DaemonOptions {
  failRun?: (args: readonly string[]) => boolean;
  failConnect?: boolean;
  /** Puts every started helper on this extra network as well (a daemon that disagrees with the arguments). */
  extraNetworkForHelpers?: string;
  helperStopsImmediately?: boolean;
}

/** A Docker daemon that keeps networks and containers, honours `--filter label=k[=v]` and `--format` for the lists the modules read, and refuses what Docker refuses. */
function fakeDaemon(options: DaemonOptions = {}) {
  const networks: FakeNetwork[] = [];
  const containers: FakeContainer[] = [];
  const calls: string[][] = [];
  let ids = 0;
  const values = (args: readonly string[], flag: string) => args.flatMap((arg, index) => (args[index - 1] === flag ? [arg] : []));
  const labelsOf = (args: readonly string[]) => Object.fromEntries(values(args, "--label").map((arg) => arg.split(/=(.*)/su).slice(0, 2) as [string, string]));
  const matches = (labels: Record<string, string>, filters: string[]) => filters.every((filter) => {
    const label = /^label=([^=]+)(?:=(.*))?$/u.exec(filter);
    if (!label) return true;
    return label[2] === undefined ? label[1]! in labels : labels[label[1]!] === label[2];
  });
  const formatLabels = (labels: Record<string, string>, id: string, template: string) => template.replace(/\{\{\.ID\}\}/gu, id).replace(/\{\{\.Label "([^"]+)"\}\}/gu, (_all, key: string) => labels[key] ?? "").replace(/\{\{index \.Labels "([^"]+)"\}\}/gu, (_all, key: string) => labels[key] ?? "");
  const ok = (stdout = "") => Promise.resolve({ exitCode: 0, stdout, stderr: "" });
  const fail = (stderr: string) => Promise.resolve({ exitCode: 1, stdout: "", stderr });
  const find = (name: string) => containers.find((c) => c.name === name || c.id === name);
  const docker: DockerCli = {
    run(args) {
      calls.push([...args]);
      const [a, b] = args;
      if (a === "network" && b === "create") {
        const subnet = values(args, "--subnet")[0] ?? "";
        const bridge = values(args, "--opt")[0]?.split("=")[1] ?? "";
        const name = args.at(-1)!;
        if (networks.some((n) => n.name === name)) return fail(`network with name ${name} already exists`);
        if (subnet !== "" && networks.some((n) => n.subnet === subnet)) return fail("Error response from daemon: Pool overlaps with other one on this address space");
        networks.push({ id: `net${String(++ids)}`, name, labels: labelsOf(args), subnet, bridge, internal: args.includes("--internal") });
        return ok();
      }
      if (a === "network" && b === "inspect") {
        const found = networks.find((n) => n.name === args.at(-1));
        return found === undefined ? fail("No such network") : ok(formatLabels(found.labels, found.id, values(args, "--format")[0]!));
      }
      if (a === "network" && b === "ls") {
        const filters = values(args, "--filter");
        return ok(networks.filter((n) => matches(n.labels, filters)).map((n) => formatLabels(n.labels, n.id, values(args, "--format")[0] ?? "{{.ID}}")).join("\n"));
      }
      if (a === "network" && b === "rm") {
        const index = networks.findIndex((n) => n.id === args[2] || n.name === args[2]);
        if (index < 0) return fail("No such network");
        if (containers.some((c) => c.networks.has(networks[index]!.name))) return fail("network has active endpoints");
        networks.splice(index, 1);
        return ok();
      }
      if (a === "network" && b === "connect") {
        if (options.failConnect === true) return fail("could not connect");
        const container = find(args.at(-1)!);
        const network = networks.find((n) => n.name === args.at(-2));
        if (container === undefined || network === undefined) return fail("No such container or network");
        if (container.networks.has(network.name)) return fail("endpoint already exists");
        container.networks.set(network.name, values(args, "--ip")[0] ?? "");
        return ok();
      }
      if (a === "network" && b === "disconnect") {
        find(args.at(-1)!)?.networks.delete(args.at(-2)!);
        return ok();
      }
      if (a === "run") {
        if (options.failRun?.(args) === true) return fail("docker: run failed");
        const name = values(args, "--name")[0]!;
        const network = values(args, "--network")[0] ?? "bridge";
        if (network !== "bridge" && !networks.some((n) => n.name === network) && network !== TASK_SANDBOX_NETWORK && !network.startsWith("rovara-snet")) return fail(`network ${network} not found`);
        const container: FakeContainer = { id: `c${String(++ids)}`, name, labels: labelsOf(args), networks: new Map([[network, values(args, "--ip")[0] ?? ""]]), args: [...args], running: options.helperStopsImmediately !== true || !name.endsWith("-models") };
        if (options.extraNetworkForHelpers !== undefined && name.endsWith("-models")) container.networks.set(options.extraNetworkForHelpers, "10.0.0.2");
        containers.push(container);
        return ok(container.id);
      }
      if (a === "inspect") {
        const container = find(args.at(-1)!);
        if (container === undefined) return fail("No such object");
        const template = values(args, "--format")[0] ?? "";
        if (template.includes("{{.State.Running}}")) {
          return ok(`${container.running ? "true" : "false"}|${JSON.stringify(Object.fromEntries([...container.networks].map(([name, ip]) => [name, { IPAddress: ip }])))}`);
        }
        return ok(JSON.stringify(Object.fromEntries([...container.networks].map(([name, ip]) => [name, { IPAddress: ip }]))));
      }
      if (a === "ps") {
        const filters = values(args, "--filter");
        return ok(containers.filter((c) => matches(c.labels, filters)).map((c) => formatLabels(c.labels, c.id, values(args, "--format")[0] ?? "{{.ID}}")).join("\n"));
      }
      if (a === "rm") {
        for (const target of args.slice(1).filter((arg) => !arg.startsWith("-"))) {
          const index = containers.findIndex((c) => c.id === target || c.name === target);
          if (index >= 0) containers.splice(index, 1);
        }
        return ok();
      }
      return ok();
    },
  };
  return { docker, networks, containers, calls };
}

const helperArgs = (addresses: { listen: string; caller: string }): string[] => ["--listen", addresses.listen, "--port", "8080", "--caller", addresses.caller, "--record-escapes"];
const startInput = (overrides: Partial<Parameters<typeof startModelHelper>[1]> = {}): Parameters<typeof startModelHelper>[1] => ({
  kind: "task", id: TASK, workspace: WS, roundBudgetMs: 600_000, image: IMAGE, runDir: RUN_DIR, helperArgs, environment: OFFERED, now: () => NOW, sleep: () => Promise.resolve(), ...overrides,
});

describe("the gate: a worker offers the model helper only when its walls are in place", () => {
  it("is offered with the walls and the IPv6 drops, and advertises task.modelHelper.v1", () => {
    expect(modelHelperOffer(OFFERED)).toEqual({ offered: true });
    expect(MODEL_HELPER_FEATURE).toBe("task.modelHelper.v1");
    expect(modelHelperAdvertisedFeatures(OFFERED)).toEqual(["task.modelHelper.v1"]);
  });
  it("is not offered without walls, without the IPv6 drops, with no facts (a non-named install), with unreadable facts, or when the worker is withheld", () => {
    const facts = (overrides: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(FACTS) as Record<string, unknown>, ...overrides });
    const cases: Array<[string, NodeJS.ProcessEnv, string]> = [
      ["no walls", { AGENTX_TEST_SERVICES_BOOT_FACTS: facts({ runWalls: false }) }, "walls_missing"],
      ["no IPv6 drops", { AGENTX_TEST_SERVICES_BOOT_FACTS: facts({ ipv6Drops: false, ipv6DropsReason: "rule-not-added" }) }, "ipv6_drops_missing"],
      ["no facts", {}, "no_boot_facts"],
      ["empty facts", { AGENTX_TEST_SERVICES_BOOT_FACTS: "" }, "no_boot_facts"],
      ["unreadable facts", { AGENTX_TEST_SERVICES_BOOT_FACTS: "{not json" }, "boot_facts_unreadable"],
      ["facts with an extra key", { AGENTX_TEST_SERVICES_BOOT_FACTS: facts({ extra: 1 }) }, "boot_facts_unreadable"],
      ["string true", { AGENTX_TEST_SERVICES_BOOT_FACTS: facts({ runWalls: "true" }) }, "boot_facts_unreadable"],
      ["withheld for all", { ...OFFERED, AGENTX_TEST_SERVICES_NOT_PULLED: "all" }, "worker_withheld"],
      ["a malformed not-pulled note (read as all)", { ...OFFERED, AGENTX_TEST_SERVICES_NOT_PULLED: "svc/postgres;rm -rf" }, "worker_withheld"],
    ];
    for (const [label, environment, reason] of cases) {
      expect(modelHelperOffer(environment), label).toEqual({ offered: false, reason });
      expect(modelHelperAdvertisedFeatures(environment), label).toEqual([]);
    }
  });
  it("a repository that is not pulled does not withdraw the model helper (it needs no catalog image)", () => {
    expect(modelHelperOffer({ ...OFFERED, AGENTX_TEST_SERVICES_NOT_PULLED: "svc/postgres" }).offered).toBe(true);
  });
  it("startModelHelper starts nothing on a worker that does not offer it", async () => {
    const daemon = fakeDaemon();
    await expect(startModelHelper(daemon.docker, startInput({ environment: {} }))).rejects.toThrow();
    expect(daemon.calls).toEqual([]);
  });
});

describe(".9 is the model helper's, and a repository alias can never take it", () => {
  it("is .9 of every slot, outside the service helper range (.16 to .47), and never an index of runNetworkHelperIp", () => {
    for (const slot of [1, 7, 253]) {
      const address = runNetworkModelHelperIp(slot);
      expect(address).toBe(`172.30.${String(slot)}.9`);
      for (let index = 0; index < 32; index += 1) expect(runNetworkHelperIp(slot, index)).not.toBe(address);
    }
    expect(() => runNetworkModelHelperIp(RUN_NETWORK_SLOTS + 1)).toThrow();
    expect(() => runNetworkModelHelperIp(0)).toThrow();
    // The address plan of a slot is unchanged: the model helper is not a field of it.
    expect(Object.keys(runNetworkAddresses(7))).not.toContain("modelHelperIp");
  });
  it("the name the sandboxes know it by is a reserved alias for dependencies in both launcher rule sets", () => {
    expect(MODEL_HELPER_ALIAS).toBe("rovara-models");
    expect(RESERVED_RUN_ALIASES.has(MODEL_HELPER_ALIAS)).toBe(true);
    expect(HELPER_RESERVED_ALIASES).toContain(MODEL_HELPER_ALIAS);
    const net = { slot: 5 };
    expect(() => checkSandboxNames(net, [{ alias: MODEL_HELPER_ALIAS, address: runNetworkHelperIp(5, 1) }], runNetworkHelperIp(5, 0))).toThrow();
    expect(checkSandboxNames(net, [{ alias: "postgres", address: runNetworkHelperIp(5, 1) }], runNetworkHelperIp(5, 0))).toHaveLength(2);
  });
});

describe("the helper's docker arguments", () => {
  const MODEL_IP = runNetworkModelHelperIp(153);
  const net = { name: "rovara-svc-159715ae29a2", slot: 153, ...runNetworkAddresses(153), labelArgs: () => ["--label", `${RUN_NETWORK_LABEL}=rovara-svc-159715ae29a2`, "--label", `${RUN_NETWORK_CREATED_LABEL}=${String(NOW)}`, "--label", `${RUN_NETWORK_EXPIRES_LABEL}=${String(NOW + 1_500_000)}`, "--label", `${RUN_NETWORK_WORKSPACE_LABEL}=${WS}`] };
  const args = () => modelHelperRunArgs({ net, image: IMAGE, runDir: RUN_DIR, sandboxIp: net.workingSandboxIp, programArgs: helperArgs({ listen: MODEL_IP, caller: net.workingSandboxIp }) });
  const valuesOf = (list: readonly string[], flag: string) => list.flatMap((arg, index) => (list[index - 1] === flag ? [arg] : []));

  it("is hardened: no capability, read-only root, no new privileges, one network (the run network, at .9), no egress, no DNS upstream, no published port", () => {
    const list = args();
    expect(valuesOf(list, "--network")).toEqual([net.name]);
    expect(valuesOf(list, "--ip")).toEqual(["172.30.153.9"]);
    expect(valuesOf(list, "--cap-drop")).toEqual(["ALL"]);
    // Docker's embedded resolver (127.0.0.11) would forward a lookup to the daemon's upstream: the helper's only upstream is its own loopback, where nothing listens.
    expect(valuesOf(list, "--dns")).toEqual(["127.0.0.1"]);
    expect(list).toContain("--read-only");
    expect(valuesOf(list, "--security-opt")).toEqual(["no-new-privileges"]);
    expect(valuesOf(list, "--user")).toEqual(["1000:1000"]);
    for (const flag of ["--add-host", "--dns-search", "--publish", "-p", "--privileged", "--cap-add", "--pid", "--ipc", "--net", "--link", "--device", "--userns"]) expect(list, flag).not.toContain(flag);
    expect(list).toContain("--pull=never");
    expect(valuesOf(list, "--entrypoint")).toEqual(["/usr/local/bin/node"]);
  });
  it("carries ALL four labels of the network on the helper, so the sweep and stop() find it", () => {
    const keys = valuesOf(args(), "--label").map((label) => label.split("=")[0]);
    expect(keys.sort()).toEqual([...LABEL_KEYS].sort());
  });
  it("has exactly one bind mount, read-only, of a directory that holds only the helper's files, and exactly one tmpfs (the ledger)", () => {
    const list = args();
    expect(valuesOf(list, "--volume")).toEqual([`${RUN_DIR}:${MODEL_HELPER_RUN_DIR}:ro`]);
    expect(valuesOf(list, "--tmpfs")).toHaveLength(1);
    expect(valuesOf(list, "--tmpfs")[0]!.startsWith(`${MODEL_HELPER_LEDGER_DIR}:`)).toBe(true);
    expect(valuesOf(list, "--tmpfs")[0]).toMatch(/noexec/u);
    expect(valuesOf(list, "-v")).toEqual([]);
    expect(valuesOf(list, "--mount")).toEqual([]);
  });
  it("runs the worker's own image on the helper program with the caller's arguments, after the image", () => {
    const list = args();
    const at = list.indexOf(IMAGE);
    expect(list.slice(at, at + 2)).toEqual([IMAGE, MODEL_HELPER_ENTRY]);
    expect(list.slice(at + 2)).toEqual(helperArgs({ listen: MODEL_IP, caller: net.workingSandboxIp }));
    // May bind 443 and 80 as a non-root user, and nothing below 80.
    expect(valuesOf(list, "--sysctl")).toEqual(["net.ipv4.ip_unprivileged_port_start=80"]);
  });
  it("refuses program arguments that do not listen on .9 and serve only the sandbox's address", () => {
    const base = (programArgs: string[]) => () => modelHelperRunArgs({ net, image: IMAGE, runDir: RUN_DIR, sandboxIp: net.workingSandboxIp, programArgs });
    expect(base(["--listen", "0.0.0.0", "--caller", net.workingSandboxIp])).toThrow();
    expect(base(["--listen", MODEL_IP, "--caller", "172.30.153.4"])).toThrow();
    expect(base(["--listen", MODEL_IP, "--caller", net.workingSandboxIp, "--caller", "172.30.153.4"])).toThrow();
    expect(base(["--listen", MODEL_IP, "--listen", "172.30.153.8", "--caller", net.workingSandboxIp])).toThrow();
    expect(base(["--caller", net.workingSandboxIp])).toThrow();
    expect(base(["--listen", MODEL_IP, "--caller", net.workingSandboxIp, "a b"])).toThrow();
    expect(base(["--listen", MODEL_IP, "--caller", net.workingSandboxIp, "x\ny"])).toThrow();
    expect(base(["--listen", MODEL_IP, "--caller", net.workingSandboxIp])).not.toThrow();
  });
  it("refuses an image, a directory or a sandbox address that is not plain", () => {
    const make = (over: Partial<Parameters<typeof modelHelperRunArgs>[0]>) => () => modelHelperRunArgs({ net, image: IMAGE, runDir: RUN_DIR, sandboxIp: net.workingSandboxIp, programArgs: helperArgs({ listen: MODEL_IP, caller: net.workingSandboxIp }), ...over });
    for (const image of ["--privileged", "-x", "a b", "", "img;rm"]) expect(make({ image }), image).toThrow();
    for (const runDir of ["relative/models", "/run/x/../models", "/run/rovara/job1", "/run/rovara/job1/models/", "/run/a b/models", "/", "//models", "/run/rovara/job1/model"]) expect(make({ runDir }), runDir).toThrow();
    for (const sandboxIp of ["172.30.153.8", "172.30.153.9", "8.8.8.8", "172.30.153.3 ", "127.0.0.1"]) expect(make({ sandboxIp }), sandboxIp).toThrow();
  });
  describe("modelHelperArgProblems names every way the arguments could be unsound", () => {
    const problems = (list: string[]) => modelHelperArgProblems(list, net, { sandboxIp: net.workingSandboxIp });
    const withExtra = (extra: string[]) => {
      const list = args();
      list.splice(list.indexOf("--entrypoint"), 0, ...extra);
      return list;
    };
    it("is clean for the real arguments", () => {
      expect(problems(args())).toEqual([]);
    });
    it("a second network", () => {
      expect(problems(withExtra(["--network", TASK_SANDBOX_NETWORK])).join(";")).toMatch(/network/u);
    });
    it("an --add-host, a --dns, a published port, a capability, a privileged helper, a second mount, a host network", () => {
      for (const extra of [["--add-host", "api.openai.com:1.1.1.1"], ["--dns", "8.8.8.8"], ["--dns-option", "ndots:0"], ["--publish", "8080:8080"], ["--cap-add", "NET_ADMIN"], ["--privileged"], ["--volume", "/:/host"], ["--tmpfs", "/tmp"], ["--net", "host"], ["--pid", "host"], ["--device", "/dev/kmsg"], ["--security-opt", "seccomp=unconfined"]]) {
        expect(problems(withExtra(extra)).length, extra.join(" ")).toBeGreaterThan(0);
      }
    });
    it("a missing --dns 127.0.0.1, or another DNS server", () => {
      const without = args();
      without.splice(without.indexOf("--dns"), 2);
      expect(problems(without).join(";")).toMatch(/DNS/u);
      expect(problems(args().map((arg) => (arg === "127.0.0.1" ? "8.8.8.8" : arg))).join(";")).toMatch(/DNS/u);
    });
    it("a missing label, a missing read-only root, a missing --cap-drop ALL, a writable run directory, a root user", () => {
      const without = (flag: string, count: number) => { const list = args(); list.splice(list.indexOf(flag), count); return list; };
      expect(problems(without("--read-only", 1)).join(";")).toMatch(/read-only/u);
      expect(problems(without("--cap-drop", 2)).join(";")).toMatch(/capabilit/u);
      expect(problems(without("--label", 2)).join(";")).toMatch(/label/u);
      expect(problems(args().map((arg) => (arg.endsWith(":ro") ? arg.slice(0, -3) : arg))).join(";")).toMatch(/read-only|mount/u);
      expect(problems(args().map((arg) => (arg === "1000:1000" ? "0:0" : arg))).join(";")).toMatch(/user/u);
    });
  });
});

describe("starting the helper", () => {
  it("makes the network, then the helper on it (all four labels), waits for it, and only then is a sandbox block available; the network is an internal rvi bridge", async () => {
    const daemon = fakeDaemon();
    const started = await startModelHelper(daemon.docker, startInput());
    const order = daemon.calls.map((call) => call.slice(0, 2).join(" "));
    expect(order.indexOf("network create")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("run --detach")).toBeGreaterThan(order.indexOf("network create"));
    expect(daemon.networks).toHaveLength(1);
    expect(daemon.networks[0]!.internal).toBe(true);
    expect(daemon.networks[0]!.bridge).toMatch(/^rvi[0-9a-f]{8}$/u);
    const helper = daemon.containers.find((c) => c.name.endsWith("-models"))!;
    expect(helper.networks.size).toBe(1);
    expect([...helper.networks.keys()]).toEqual([daemon.networks[0]!.name]);
    expect(helper.networks.get(daemon.networks[0]!.name)).toBe(runNetworkModelHelperIp(started.network.slot));
    expect(Object.keys(helper.labels).sort()).toEqual([...LABEL_KEYS].sort());
    expect(started.helperIp).toBe(runNetworkModelHelperIp(started.network.slot));
    expect(started.sandboxIp).toBe(started.network.workingSandboxIp);
  });
  it("one network per task: two tasks get two networks and two helpers, each on its own network only", async () => {
    const daemon = fakeDaemon();
    const first = await startModelHelper(daemon.docker, startInput({ id: "task-aaaa" }));
    const second = await startModelHelper(daemon.docker, startInput({ id: "task-bbbb" }));
    expect(first.network.name).not.toBe(second.network.name);
    expect(daemon.networks).toHaveLength(2);
    for (const helper of daemon.containers.filter((c) => c.name.endsWith("-models"))) expect(helper.networks.size).toBe(1);
  });
  it("a failed helper start removes the network and answers one fixed sentence (the docker error is not repeated)", async () => {
    const daemon = fakeDaemon({ failRun: (args) => args.some((arg) => arg.endsWith("-models")) });
    const error = await startModelHelper(daemon.docker, startInput()).catch((caught: unknown) => caught as Error);
    expect((error as Error).message).toContain(MODEL_HELPER_FAILURE_SENTENCE);
    expect((error as Error).message).not.toMatch(/docker: run failed/u);
    expect(daemon.networks).toEqual([]);
    expect(daemon.containers).toEqual([]);
  });
  it("a helper that is not running, or that the daemon put on a second network, fails closed and is cleaned up", async () => {
    for (const options of [{ helperStopsImmediately: true }, { extraNetworkForHelpers: TASK_SANDBOX_NETWORK }] as DaemonOptions[]) {
      const daemon = fakeDaemon(options);
      const error = await startModelHelper(daemon.docker, startInput()).catch((caught: unknown) => caught as Error);
      expect((error as Error).message, JSON.stringify(options)).toContain(MODEL_HELPER_FAILURE_SENTENCE);
      expect(daemon.networks, JSON.stringify(options)).toEqual([]);
      expect(daemon.containers, JSON.stringify(options)).toEqual([]);
    }
  });
  it("stop() removes the helper and then the network, and is safe to call again", async () => {
    const daemon = fakeDaemon();
    const started = await startModelHelper(daemon.docker, startInput());
    await started.stop();
    await started.stop();
    expect(daemon.containers).toEqual([]);
    expect(daemon.networks).toEqual([]);
  });
  it("the run id of a task and of each round are different hashes, never the id itself", () => {
    const ids = [modelHelperRunId("task", TASK), modelHelperRunId("round", TASK, 1), modelHelperRunId("round", TASK, 2), modelHelperRunId("task", "other")];
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(id).toMatch(/^mh-[0-9a-f]{32}$/u);
    expect(() => modelHelperRunId("round", TASK, -1)).toThrow();
    expect(() => modelHelperRunId("task", "")).toThrow();
  });
});

describe("the working sandbox is dual-homed; the fresh check sandbox is on a new round network the working sandbox is never on", () => {
  const cleanup: string[] = [];
  afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
  const root = async () => { const path = await realpath(await mkdtemp(join(tmpdir(), "agentx-model-helper-"))); cleanup.push(path); return path; };

  it("starts the helper BEFORE the sandbox, gives the sandbox every name at .9 (and rovara-models), then joins it to the helper network at .3", async () => {
    const daemon = fakeDaemon();
    const helper = await startModelHelper(daemon.docker, startInput());
    const sandbox = new TaskSandbox({ rootPath: await root(), taskId: TASK, docker: daemon.docker, image: IMAGE, environment: {}, modelBlock: helper.sandboxBlock({}) });
    await sandbox.start();
    const kinds = daemon.calls.map((call) => (call[0] === "run" ? (call.includes("--detach") && call.some((arg) => arg.endsWith("-models")) ? "run-helper" : "run-sandbox") : call.slice(0, 2).join(" ")));
    expect(kinds.indexOf("run-helper")).toBeLessThan(kinds.indexOf("run-sandbox"));
    expect(kinds.indexOf("run-sandbox")).toBeLessThan(kinds.indexOf("network connect"));
    const run = daemon.calls.find((call) => call[0] === "run" && !call.some((arg) => arg.endsWith("-models")))!;
    const pairs = run.flatMap((arg, index) => (run[index - 1] === "--add-host" ? [arg] : []));
    expect(pairs).toContain(`rovara-models:${helper.helperIp}`);
    expect(pairs).toContain(`api.openai.com:${helper.helperIp}`);
    expect(pairs).toContain(`generativelanguage.googleapis.com:${helper.helperIp}`);
    expect(pairs).toContain(`us-central1-aiplatform.googleapis.com:${helper.helperIp}`);
    expect(pairs).toContain(`oauth2.googleapis.com:${helper.helperIp}`);
    expect(pairs.every((pair) => pair.endsWith(`:${helper.helperIp}`))).toBe(true);
    expect(run[run.indexOf("--network") + 1]).toBe(TASK_SANDBOX_NETWORK);
    expect(daemon.calls).toContainEqual(["network", "connect", "--ip", helper.network.workingSandboxIp, helper.network.name, expect.stringMatching(/^agentx-task-/u) as unknown as string]);
    const container = daemon.containers.find((c) => c.name.startsWith("agentx-task-"))!;
    expect([...container.networks.keys()].sort()).toEqual([TASK_SANDBOX_NETWORK, helper.network.name].sort());
    await sandbox.dispose();
    expect(daemon.containers).toEqual([]);
    expect(daemon.networks.map((n) => n.name)).toEqual([TASK_SANDBOX_NETWORK]);
  });
  it("a sandbox whose join to the helper network fails is removed and its start fails (no sandbox runs with a block that points nowhere)", async () => {
    const daemon = fakeDaemon();
    const helper = await startModelHelper(daemon.docker, startInput());
    daemon.docker.run = ((original) => (args: readonly string[], opts?: unknown) => (args[0] === "network" && args[1] === "connect" ? Promise.resolve({ exitCode: 1, stdout: "", stderr: "no" }) : original(args, opts as never)))(daemon.docker.run.bind(daemon.docker));
    const sandbox = new TaskSandbox({ rootPath: await root(), taskId: TASK, docker: daemon.docker, image: IMAGE, environment: {}, modelBlock: helper.sandboxBlock({}) });
    await expect(sandbox.start()).rejects.toThrow();
    expect(daemon.containers.filter((c) => c.name.startsWith("agentx-task-"))).toEqual([]);
    await sandbox.dispose();
    expect(daemon.networks.map((n) => n.name)).toEqual([TASK_SANDBOX_NETWORK]);
  });
  it("dispose with a sandbox that never started still tears the helper down", async () => {
    const daemon = fakeDaemon();
    const helper = await startModelHelper(daemon.docker, startInput());
    const sandbox = new TaskSandbox({ rootPath: await root(), taskId: TASK, docker: daemon.docker, image: IMAGE, environment: {}, modelBlock: helper.sandboxBlock({}) });
    await sandbox.dispose();
    expect(daemon.containers).toEqual([]);
    expect(daemon.networks).toEqual([]);
  });
  it("a sandbox with no model block has the arguments it always had: no --add-host, no extra network", async () => {
    const daemon = fakeDaemon();
    await new TaskSandbox({ rootPath: await root(), taskId: TASK, docker: daemon.docker, image: IMAGE, environment: {} }).start();
    const run = daemon.calls.find((call) => call[0] === "run")!;
    expect(run).not.toContain("--add-host");
    expect(daemon.calls.some((call) => call[0] === "network" && call[1] === "connect")).toBe(false);
    const base = { name: "n", taskId: TASK, image: IMAGE, rootPath: "/mnt/workspace", maskedPaths: [] as string[], hostCpus: 4, hostMemoryBytes: 8 * 1024 ** 3 };
    expect(taskSandboxRunArgs(base)).not.toContain("--add-host");
  });
  it("a sandbox block with the dropped address (a non-AI project) adds the names and joins nothing", async () => {
    const daemon = fakeDaemon();
    const block = planModelHostBlock({ gatewayRows: [], hasModelRow: false, nonAiGate: true, wallsOffered: true });
    await new TaskSandbox({ rootPath: await root(), taskId: TASK, docker: daemon.docker, image: IMAGE, environment: {}, modelBlock: { block } }).start();
    const run = daemon.calls.find((call) => call[0] === "run")!;
    const pairs = run.flatMap((arg, index) => (run[index - 1] === "--add-host" ? [arg] : []));
    expect(pairs.length).toBe(block.hosts.length);
    expect(pairs.every((pair) => pair.endsWith(":10.255.255.1"))).toBe(true);
    expect(pairs.some((pair) => pair.startsWith("rovara-models:"))).toBe(false);
    expect(daemon.calls.some((call) => call[0] === "network")).toBe(true); // only the shared task network's own inspect and create
    expect(daemon.calls.some((call) => call[0] === "network" && call[1] === "connect")).toBe(false);
  });
  it("taskSandboxRunArgs refuses a block whose address is not the helper's .9 or the dropped address, or whose name is a wildcard", () => {
    const base = { name: "n", taskId: TASK, image: IMAGE, rootPath: "/mnt/workspace", maskedPaths: [] as string[] };
    const good = planModelHostBlock({ hasModelRow: true, helperIp: "172.30.7.9" });
    expect(taskSandboxRunArgs({ ...base, modelBlock: good }).filter((arg) => arg === "--add-host").length).toBe(good.hosts.length + 1);
    for (const address of ["8.8.8.8", "172.30.7.8", "127.0.0.1", "172.30.7.9 "]) expect(() => taskSandboxRunArgs({ ...base, modelBlock: { ...good, address } }), address).toThrow();
    expect(() => taskSandboxRunArgs({ ...base, modelBlock: { ...good, hosts: ["*.googleapis.com"] } })).toThrow();
    expect(() => taskSandboxRunArgs({ ...base, modelBlock: { ...good, hosts: ["a.example.com\n--privileged"] } })).toThrow();
  });
  it("a round gets a NEW network and its check sandbox is at .4; the working sandbox can never be attached to it, and the task network keeps the working sandbox at .3", async () => {
    const daemon = fakeDaemon();
    const task = await startModelHelper(daemon.docker, startInput());
    const round = await startModelHelper(daemon.docker, startInput({ kind: "round", round: 1 }));
    expect(round.network.name).not.toBe(task.network.name);
    expect(round.sandboxIp).toBe(round.network.checkSandboxIp);
    expect(task.sandboxIp).toBe(task.network.workingSandboxIp);
    daemon.containers.push({ id: "w1", name: "working-sandbox", labels: {}, networks: new Map([[TASK_SANDBOX_NETWORK, ""]]), args: [], running: true });
    daemon.containers.push({ id: "k1", name: "check-sandbox", labels: {}, networks: new Map([[TASK_SANDBOX_NETWORK, ""]]), args: [], running: true });
    await expect(round.attachSandbox("working-sandbox", "working")).rejects.toThrow();
    await expect(task.attachSandbox("check-sandbox", "check")).rejects.toThrow();
    await task.attachSandbox("working-sandbox", "working");
    await round.attachSandbox("check-sandbox", "check");
    const networksOf = (name: string) => [...daemon.containers.find((c) => c.name === name)!.networks.keys()];
    expect(networksOf("working-sandbox")).toEqual([TASK_SANDBOX_NETWORK, task.network.name]);
    expect(networksOf("check-sandbox")).toEqual([TASK_SANDBOX_NETWORK, round.network.name]);
    expect(daemon.calls).toContainEqual(["network", "connect", "--ip", round.network.checkSandboxIp, round.network.name, "check-sandbox"]);
    expect(daemon.calls.some((call) => call[0] === "network" && call[1] === "connect" && call.at(-2) === round.network.name && call.at(-1) === "working-sandbox")).toBe(false);
  });
  it("a round's network refuses a container that is already on another run network (the working sandbox is never on a round's network, whoever calls)", async () => {
    const daemon = fakeDaemon();
    const task = await startModelHelper(daemon.docker, startInput());
    const round = await startModelHelper(daemon.docker, startInput({ kind: "round", round: 1 }));
    daemon.containers.push({ id: "w2", name: "working-two", labels: {}, networks: new Map([[TASK_SANDBOX_NETWORK, ""]]), args: [], running: true });
    await task.attachSandbox("working-two", "working");
    const before = daemon.calls.filter((call) => call[0] === "network" && call[1] === "connect").length;
    await expect(round.attachSandbox("working-two", "check")).rejects.toThrow();
    expect(daemon.calls.filter((call) => call[0] === "network" && call[1] === "connect").length).toBe(before);
    expect([...daemon.containers.find((c) => c.name === "working-two")!.networks.keys()]).not.toContain(round.network.name);
    // The same container again on its OWN network is fine (a repeat of the join).
    await expect(task.attachSandbox("working-two", "working")).resolves.toBeUndefined();
  });
  it("refuses when the container's networks cannot be read, before any connect", async () => {
    const daemon = fakeDaemon();
    const round = await startModelHelper(daemon.docker, startInput({ kind: "round", round: 1 }));
    await expect(round.attachSandbox("no-such-container", "check")).rejects.toThrow();
    expect(daemon.calls.some((call) => call[0] === "network" && call[1] === "connect")).toBe(false);
  });
  it("a round's sandbox block cannot be given to the working sandbox (TaskSandbox is the working sandbox)", async () => {
    const daemon = fakeDaemon();
    const round = await startModelHelper(daemon.docker, startInput({ kind: "round", round: 1 }));
    expect(round.sandboxBlock({}).role).toBe("check");
    expect(() => new TaskSandbox({ rootPath: "/mnt/workspace", taskId: TASK, docker: daemon.docker, image: IMAGE, environment: {}, modelBlock: round.sandboxBlock({}) })).toThrow();
    const task = await startModelHelper(daemon.docker, startInput());
    expect(task.sandboxBlock({}).role).toBe("working");
    expect(() => new TaskSandbox({ rootPath: "/mnt/workspace", taskId: TASK, docker: daemon.docker, image: IMAGE, environment: {}, modelBlock: task.sandboxBlock({}) })).not.toThrow();
  });
  it("attachSandbox checks with an inspect that the sandbox is on the network: a connect that 'worked' on a container that is not there fails", async () => {
    const daemon = fakeDaemon();
    const task = await startModelHelper(daemon.docker, startInput());
    await expect(task.attachSandbox("no-such-container", "working")).rejects.toThrow();
  });
  it("attachSandbox refuses a container name that could be a docker option", async () => {
    const daemon = fakeDaemon();
    const task = await startModelHelper(daemon.docker, startInput());
    for (const bad of ["--privileged", "-x", "a b", ""]) await expect(task.attachSandbox(bad, "working"), bad).rejects.toThrow();
    // Nothing reached docker: a name like that would be read as an option.
    expect(daemon.calls.some((call) => call[0] === "network" && call[1] === "connect")).toBe(false);
  });
});

describe("the non-AI blackhole is applied only when the worker offers the walls", () => {
  it("with the walls and the gate: the dropped address; without the walls: no block at all, with the reason", () => {
    expect(planNonAiModelHostBlock({ nonAiGate: true, environment: OFFERED })).toMatchObject({ mode: "by_name", target: "blackhole", address: "10.255.255.1" });
    for (const environment of [{}, { AGENTX_TEST_SERVICES_BOOT_FACTS: JSON.stringify({ ...JSON.parse(FACTS) as Record<string, unknown>, runWalls: false }) }, { ...OFFERED, AGENTX_TEST_SERVICES_NOT_PULLED: "all" }]) {
      const block = planNonAiModelHostBlock({ nonAiGate: true, environment });
      expect(block).toMatchObject({ mode: "none", target: "none", hosts: [], noBlockReason: "walls_not_offered" });
    }
    expect(planNonAiModelHostBlock({ nonAiGate: false, environment: OFFERED })).toMatchObject({ mode: "none", noBlockReason: "gate_off" });
  });
});

describe("the worker-start sweep", () => {
  it("removes every helper container and network of THIS workspace once, whatever their expiry, and nothing of another workspace", async () => {
    const daemon = fakeDaemon();
    await startModelHelper(daemon.docker, startInput({ id: "task-1111" }));
    await startModelHelper(daemon.docker, startInput({ id: "task-2222", workspace: OTHER_WS }));
    expect(daemon.networks).toHaveLength(2);
    const swept = await sweepModelHelperNetworksAtWorkerStart(daemon.docker, WS);
    expect(swept).toEqual({ containers: 1, networks: 1 });
    expect(daemon.networks.map((n) => n.labels[RUN_NETWORK_WORKSPACE_LABEL])).toEqual([OTHER_WS]);
    expect(daemon.containers.every((c) => c.labels[RUN_NETWORK_WORKSPACE_LABEL] === OTHER_WS)).toBe(true);
  });
  it("refuses a workspace that is not a 16-hex key", async () => {
    await expect(sweepModelHelperNetworksAtWorkerStart(fakeDaemon().docker, "not-a-key")).rejects.toThrow();
  });
});

describe("the catalog's own check: the model-row block comes from the built-in catalog by default", () => {
  it("sandboxBlock({}) is the built-in catalog's block at the helper's address", async () => {
    const daemon = fakeDaemon();
    const helper = await startModelHelper(daemon.docker, startInput());
    const block = helper.sandboxBlock({}).block;
    expect(block.hosts).toContain(builtinModelCatalog().rows[0]!.hosts[0]);
    expect(block.address).toBe(helper.helperIp);
    expect(block.target).toBe("helper");
  });
});
