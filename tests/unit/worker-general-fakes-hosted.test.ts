// General fakes slice 2b: the HOSTED fake helper's launcher (worker general-fakes-hosted.ts). Nothing starts Docker: a small stateful fake daemon answers the commands the module uses (network create/connect/disconnect/inspect/rm/ls,
// run, inspect, exec, ps, rm), so the order of calls, the labels, the networks the helper and the sandbox are on, the binding to one company and task and the cleanup are checked against behaviour and not only argument lists.
// The first real proof against Docker is tests/linux/general-fakes-helper.test.ts (CI's linux-runtime job).
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GENERAL_FAKES_RUN_DIR, buildGeneralFakesSetBytes, buildOpenApiFake, type GeneralFakeServiceFake, type TrustedGeneralFakesSummary } from "@agentx/contracts";
import { RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_LABEL, RUN_NETWORK_SLOTS, RUN_NETWORK_STALE_MARGIN_MS, RUN_NETWORK_WORKSPACE_LABEL, runNetworkAddresses, runNetworkHelperIp } from "../../packages/worker/src/run-network.js";
import {
  GENERAL_FAKES_HELPER_ENTRY, GENERAL_FAKES_HELPER_GRACE_MS, GENERAL_FAKES_HOSTED_FAILURE_SENTENCE, generalFakesArgProblems, generalFakesContainerName, generalFakesHostedOffer, generalFakesRunArgs, generalFakesRunId, hostedCallsBetween,
  hostedFakesLauncherFor, startGeneralFakesHelper, writeGeneralFakesRunFiles, type GeneralFakesLaunchNetwork, type StartGeneralFakesHelperInput,
} from "../../packages/worker/src/general-fakes-hosted.js";
import { TASK_SANDBOX_NETWORK } from "../../packages/worker/src/task-sandbox.js";
import type { DockerCli } from "../../packages/worker/src/docker-cli.js";

const WS = "0123456789abcdef";
const WORKSPACE = "0b9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c11";
const OPERATION = "7c1f0d3a-2b8e-4a55-8f3b-9a1c2d3e4f50";
const IMAGE = `registry.example.test/worker@sha256:${"b".repeat(64)}`;
const SANDBOX = "agentx-task-op-12345678";
const NOW = 1_800_000_000_000;
const LABEL_KEYS = [RUN_NETWORK_LABEL, RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_WORKSPACE_LABEL];
const FACTS = JSON.stringify({ metadataBlocked: true, runWalls: true, ipv6Drops: true, prepull: "off", prepulled: 0, loggedOut: true, dockerVersion: "27.3.1" });
const DOCUMENT = {
  openapi: "3.0.3", info: { title: "pets", version: "1" },
  paths: { "/pets/{id}": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", required: ["id"], properties: { id: { type: "integer", minimum: 1, maximum: 9 } } } } } } } } } },
};
const FAKES: GeneralFakeServiceFake[] = [{ status: "built", fake: buildOpenApiFake(DOCUMENT, "openapi.json") }];

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const scratch = async (): Promise<string> => { const dir = await mkdtemp(join(tmpdir(), "rovara-gf-hosted-")); dirs.push(dir); return dir; };
const offered = async (): Promise<NodeJS.ProcessEnv> => ({ AGENTX_GENERAL_FAKES_HELPER: "1", AGENTX_WORKER_IMAGE: IMAGE, AGENTX_TEST_SERVICES_RUN_DIR: await scratch(), AGENTX_TEST_SERVICES_BOOT_FACTS: FACTS });

interface FakeNetwork { id: string; name: string; labels: Record<string, string>; subnet: string; bridge: string; internal: boolean }
interface FakeContainer { id: string; name: string; labels: Record<string, string>; networks: Map<string, string>; args: string[]; running: boolean }
interface DaemonOptions {
  failRun?: boolean;
  failConnect?: boolean;
  /** Puts the helper on this extra network too (a daemon that disagrees with the arguments). */
  extraNetworkForHelper?: string;
  /** The sandbox is already on another run network. */
  sandboxOnRunNetwork?: boolean;
  /** Extra container on the run network after the sandbox joined. */
  intruder?: boolean;
  /** A daemon that reports a different network address for one named member. */
  memberAddress?: { helper?: string; sandbox?: string };
  helperStopsImmediately?: boolean;
  /** The first N disconnects do nothing. */
  ignoreDisconnects?: number;
  /** What `exec --summarize` prints (default: a trusted zero summary bound to the helper's own arguments). */
  summary?: (helper: FakeContainer) => string;
}
const values = (args: readonly string[], flag: string) => args.flatMap((arg, index) => (args[index - 1] === flag ? [arg] : []));

/** A Docker daemon that keeps networks and containers and refuses what Docker refuses. The sandbox is a container on the shared task network. */
function fakeDaemon(options: DaemonOptions = {}) {
  const networks: FakeNetwork[] = [];
  const containers: FakeContainer[] = [{ id: "csandbox", name: SANDBOX, labels: {}, networks: new Map([[TASK_SANDBOX_NETWORK, "172.20.0.5"], ...(options.sandboxOnRunNetwork === true ? [["rovara-svc-aaaaaaaaaaaa", "172.30.9.3"] as [string, string]] : [])]), args: [], running: true }];
  const calls: string[][] = [];
  let ids = 0;
  let disconnects = 0;
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
  const networksJson = (container: FakeContainer) => JSON.stringify(Object.fromEntries([...container.networks].map(([name, ip]) => [name, { IPAddress: ip }])));
  const defaultSummary = (helper: FakeContainer): string => {
    const program = helper.args.slice(helper.args.indexOf("--listen"));
    const summary: TrustedGeneralFakesSummary = {
      schemaVersion: 1, trusted: true, workspaceId: values(program, "--workspace")[0]!, operationId: values(program, "--operation")[0]!, digest: values(program, "--digest")[0]!,
      served: 0, cannotAnswer: { no_spec: 0, spec_unreadable: 0, spec_ambiguous: 0, operation_unknown: 0, operation_unsupported: 0 }, foreign: 0, unrouted: 0, refused: 0, saturated: false,
    };
    return `${JSON.stringify(summary)}\n`;
  };
  const docker: DockerCli = {
    run(args) {
      calls.push([...args]);
      const [a, b] = args;
      if (a === "network" && b === "create") {
        const subnet = values(args, "--subnet")[0] ?? "";
        const bridge = values(args, "--opt")[0]?.split("=")[1] ?? "";
        const name = args.at(-1)!;
        if (networks.some((n) => n.name === name)) return fail(`network with name ${name} already exists`);
        if (networks.some((n) => n.subnet === subnet)) return fail("Error response from daemon: Pool overlaps with other one on this address space");
        networks.push({ id: `net${String(++ids)}`, name, labels: labelsOf(args), subnet, bridge, internal: args.includes("--internal") });
        return ok();
      }
      if (a === "network" && b === "inspect") {
        const found = networks.find((n) => n.name === args.at(-1));
        if (found === undefined) return fail("No such network");
        const template = values(args, "--format")[0]!;
        if (template === "{{json .Containers}}") {
          return ok(JSON.stringify(Object.fromEntries(containers.filter((c) => c.networks.has(found.name)).map((c) => [c.id, { Name: c.name, IPv4Address: `${(c.name === SANDBOX ? options.memberAddress?.sandbox : c.name.endsWith("-fakes") ? options.memberAddress?.helper : undefined) ?? c.networks.get(found.name)!}/24` }]))));
        }
        return ok(formatLabels(found.labels, found.id, template));
      }
      if (a === "network" && b === "ls") return ok(networks.filter((n) => matches(n.labels, values(args, "--filter"))).map((n) => formatLabels(n.labels, n.id, values(args, "--format")[0] ?? "{{.ID}}")).join("\n"));
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
        if (options.intruder === true) containers.push({ id: "cintruder", name: "intruder", labels: {}, networks: new Map([[network.name, `${network.subnet.split("/")[0]!.replace(/\.0$/u, "")}.50`]]), args: [], running: true });
        return ok();
      }
      if (a === "network" && b === "disconnect") {
        // A daemon that says "ok" but does not disconnect (the first N times).
        if (disconnects++ < (options.ignoreDisconnects ?? 0)) return ok();
        find(args.at(-1)!)?.networks.delete(args.at(-2)!);
        return ok();
      }
      if (a === "run") {
        if (options.failRun === true) return fail("docker: run failed");
        const name = values(args, "--name")[0]!;
        const network = values(args, "--network")[0] ?? "bridge";
        if (!networks.some((n) => n.name === network)) return fail(`network ${network} not found`);
        const container: FakeContainer = { id: `c${String(++ids)}`, name, labels: labelsOf(args), networks: new Map([[network, values(args, "--ip")[0] ?? ""]]), args: [...args], running: options.helperStopsImmediately !== true };
        if (options.extraNetworkForHelper !== undefined) container.networks.set(options.extraNetworkForHelper, "10.0.0.2");
        containers.push(container);
        return ok(container.id);
      }
      if (a === "inspect") {
        const container = find(args.at(-1)!);
        if (container === undefined) return fail("No such object");
        const template = values(args, "--format")[0] ?? "";
        return template.includes("{{.State.Running}}") ? ok(`${container.running ? "true" : "false"}|${networksJson(container)}`) : ok(networksJson(container));
      }
      if (a === "exec") {
        const container = find(args[1]!);
        if (container === undefined || !container.running) return fail("No such container");
        if (args[2] !== "/usr/local/bin/node" || args[3] !== GENERAL_FAKES_HELPER_ENTRY || args[4] !== "--summarize" || args.length !== 5) return fail("unexpected exec");
        return ok((options.summary ?? defaultSummary)(container));
      }
      if (a === "ps") return ok(containers.filter((c) => matches(c.labels, values(args, "--filter"))).map((c) => formatLabels(c.labels, c.id, values(args, "--format")[0] ?? "{{.ID}}")).join("\n"));
      if (a === "rm") {
        for (const target of args.slice(1).filter((arg) => !arg.startsWith("-"))) {
          const index = containers.findIndex((c) => (c.id === target || c.name === target) && c.name !== SANDBOX);
          if (index >= 0) containers.splice(index, 1);
        }
        return ok();
      }
      return ok();
    },
  };
  return { docker, networks, containers, calls };
}

async function input(daemon: ReturnType<typeof fakeDaemon>, overrides: Partial<StartGeneralFakesHelperInput> = {}): Promise<StartGeneralFakesHelperInput> {
  const environment = await offered();
  return {
    docker: daemon.docker, image: IMAGE, workspaceKey: WS, workspaceId: WORKSPACE, operationId: OPERATION, round: 1, sandboxName: SANDBOX, fakes: FAKES, variables: ["PETS_API_URL"],
    scratchParent: environment.AGENTX_TEST_SERVICES_RUN_DIR!, roundBudgetMs: 600_000, environment, now: () => NOW, sleep: () => Promise.resolve(), ...overrides,
  };
}
const FAILURE = GENERAL_FAKES_HOSTED_FAILURE_SENTENCE;
const nothingLeft = (daemon: ReturnType<typeof fakeDaemon>) => {
  expect(daemon.networks).toEqual([]);
  expect(daemon.containers.map((c) => c.name)).toEqual([SANDBOX]);
  expect([...daemon.containers[0]!.networks.keys()]).toEqual([TASK_SANDBOX_NETWORK]);
};

describe("the gate", () => {
  it("offers the helper only when the operator turned it on, the worker's pinned image and run directory are known and the boot walls are in place", async () => {
    const env = await offered();
    expect(generalFakesHostedOffer(env)).toEqual({ offered: true, image: IMAGE, runDirectoryParent: env.AGENTX_TEST_SERVICES_RUN_DIR });
    const without = (name: string) => { const copy = { ...env }; delete copy[name]; return generalFakesHostedOffer(copy); };
    expect(without("AGENTX_GENERAL_FAKES_HELPER")).toEqual({ offered: false, reason: "not_enabled" });
    expect(generalFakesHostedOffer({ ...env, AGENTX_GENERAL_FAKES_HELPER: "true" })).toEqual({ offered: false, reason: "not_enabled" });
    expect(without("AGENTX_WORKER_IMAGE")).toEqual({ offered: false, reason: "no_image" });
    expect(generalFakesHostedOffer({ ...env, AGENTX_WORKER_IMAGE: "worker:latest" })).toEqual({ offered: false, reason: "no_image" });
    expect(without("AGENTX_TEST_SERVICES_RUN_DIR")).toEqual({ offered: false, reason: "no_run_dir" });
    expect(generalFakesHostedOffer({ ...env, AGENTX_TEST_SERVICES_RUN_DIR: "relative/dir" })).toEqual({ offered: false, reason: "no_run_dir" });
    expect(generalFakesHostedOffer({ ...env, AGENTX_TEST_SERVICES_RUN_DIR: "/tmp/../etc" })).toEqual({ offered: false, reason: "no_run_dir" });
    expect(without("AGENTX_TEST_SERVICES_BOOT_FACTS")).toEqual({ offered: false, reason: "no_boot_facts" });
    expect(generalFakesHostedOffer({ ...env, AGENTX_TEST_SERVICES_BOOT_FACTS: "{" })).toEqual({ offered: false, reason: "boot_facts_unreadable" });
    expect(generalFakesHostedOffer({ ...env, AGENTX_TEST_SERVICES_BOOT_FACTS: JSON.stringify({ ...JSON.parse(FACTS) as object, runWalls: false }) })).toEqual({ offered: false, reason: "walls_missing" });
    expect(generalFakesHostedOffer({ ...env, AGENTX_TEST_SERVICES_BOOT_FACTS: JSON.stringify({ ...JSON.parse(FACTS) as object, ipv6Drops: false }) })).toEqual({ offered: false, reason: "ipv6_drops_missing" });
    expect(generalFakesHostedOffer({ ...env, AGENTX_TEST_SERVICES_NOT_PULLED: "all" })).toEqual({ offered: false, reason: "worker_withheld" });
    // Off by default: an empty environment offers nothing.
    expect(generalFakesHostedOffer({})).toEqual({ offered: false, reason: "not_enabled" });
  });

  it("makes no launcher unless every condition holds (each alone makes it undefined)", async () => {
    const environment = await offered();
    const base = { sandbox: { name: SANDBOX }, testServices: false, devcontainer: false, requested: true, docker: fakeDaemon().docker, rootPath: await scratch(), workspaceId: WORKSPACE, operationId: OPERATION, roundBudgetMs: () => 1, environment };
    expect(hostedFakesLauncherFor(base)).toBeDefined();
    expect(hostedFakesLauncherFor({ ...base, sandbox: undefined })).toBeUndefined();
    expect(hostedFakesLauncherFor({ ...base, testServices: true })).toBeUndefined();
    expect(hostedFakesLauncherFor({ ...base, devcontainer: true })).toBeUndefined();
    expect(hostedFakesLauncherFor({ ...base, requested: false })).toBeUndefined();
    expect(hostedFakesLauncherFor({ ...base, environment: { ...environment, AGENTX_GENERAL_FAKES_HELPER: "0" } })).toBeUndefined();
    expect(hostedFakesLauncherFor({ ...base, environment: {} })).toBeUndefined();
  });
});

describe("the launch arguments", () => {
  const net = (slot = 7): GeneralFakesLaunchNetwork => {
    const addresses = runNetworkAddresses(slot);
    return { name: "rovara-svc-0123456789ab", slot, workingSandboxIp: addresses.workingSandboxIp, helperIp: (index) => runNetworkHelperIp(slot, index), labelArgs: () => LABEL_KEYS.flatMap((key) => ["--label", `${key}=x`]) };
  };
  const launch = { image: IMAGE, runDir: "/run/rovara/job1/fakes", digest: "a".repeat(64), workspaceId: WORKSPACE, operationId: OPERATION, lifetimeMs: 900_000 };
  const args = () => generalFakesRunArgs({ net: net(), ...launch });
  const problems = (list: readonly string[]) => generalFakesArgProblems(list, net(), { digest: launch.digest, workspaceId: WORKSPACE, operationId: OPERATION, runDir: launch.runDir, lifetimeMs: launch.lifetimeMs });

  it("names every way arguments are unsound (each mutation alone), and repeats no value", () => {
    const base = args();
    const swap = (flag: string, value: string) => base.map((arg, index) => (base[index - 1] === flag ? value : arg));
    const drop = (flag: string, count = 2) => { const at = base.indexOf(flag); return [...base.slice(0, at), ...base.slice(at + count)]; };
    const cases: Array<[string, string[]]> = [
      ["network", swap("--network", "bridge")],
      ["a second network", [...base.slice(0, 2), "--network", "agentx-task", ...base.slice(2)]],
      ["dns", swap("--dns", "8.8.8.8")],
      ["ip", swap("--ip", "172.30.7.9")],
      ["cap", drop("--cap-drop")],
      ["cap-add", [...base.slice(0, 2), "--cap-add", "NET_ADMIN", ...base.slice(2)]],
      ["read-only", drop("--read-only", 1)],
      ["security", swap("--security-opt", "seccomp=unconfined")],
      ["user", swap("--user", "0:0")],
      ["entrypoint", swap("--entrypoint", "/bin/sh")],
      ["tmpfs", swap("--tmpfs", "/rovara/ledger:rw,size=9999m")],
      ["memory", swap("--memory", "8g")],
      ["swap", swap("--memory-swap", "16g")],
      ["cpus", swap("--cpus", "8")],
      ["pids", swap("--pids-limit", "-1")],
      ["log", swap("--log-driver", "json-file")],
      ["rw mount", swap("--volume", `${launch.runDir}:${GENERAL_FAKES_RUN_DIR}`)],
      ["another host directory, still read-only at the right place", swap("--volume", `/var/run/docker.sock:${GENERAL_FAKES_RUN_DIR}:ro`)],
      ["the root, still read-only at the right place", swap("--volume", `/:${GENERAL_FAKES_RUN_DIR}:ro`)],
      ["another container name", swap("--name", "some-other-container")],
      ["second mount", [...base.slice(0, 2), "--volume", "/var/run/docker.sock:/var/run/docker.sock", ...base.slice(2)]],
      ["a label missing", base.filter((arg, index) => !(base[index - 1] === "--label" && arg.startsWith(RUN_NETWORK_LABEL)) && !(arg === "--label" && base[index + 1]?.startsWith(RUN_NETWORK_LABEL)))],
      ["publish", [...base.slice(0, 2), "--publish", "8080:8080", ...base.slice(2)]],
      ["privileged", [...base.slice(0, 2), "--privileged", ...base.slice(2)]],
      ["env", [...base.slice(0, 2), "--env", "TOKEN=x", ...base.slice(2)]],
      ["add-host", [...base.slice(0, 2), "--add-host", "a:1.2.3.4", ...base.slice(2)]],
      ["image tag", base.map((arg) => (arg === IMAGE ? "worker:latest" : arg))],
      ["program", base.map((arg) => (arg === GENERAL_FAKES_HELPER_ENTRY ? "/bin/sh" : arg))],
      ["listen", swap("--listen", "0.0.0.0")],
      ["caller", swap("--caller", "172.30.7.4")],
      ["digest", swap("--digest", "c".repeat(64))],
      ["company", swap("--workspace", "11111111-1111-4111-8111-111111111111")],
      ["task", swap("--operation", "11111111-1111-4111-8111-111111111111")],
      ["an extra program flag", [...base, "--port", "80"]],
      ["no lifetime", drop("--lifetime-ms")],
      ["a longer lifetime than the round's", swap("--lifetime-ms", "86400000")],
      ["a shorter lifetime than the round's", swap("--lifetime-ms", "1000")],
      ["a lifetime that is not a plain number", swap("--lifetime-ms", "9e5")],
      ["a second lifetime", [...base, "--lifetime-ms", "900000"]],
      ["not a run", ["create", ...base.slice(1)]],
    ];
    for (const [name, list] of cases) {
      const found = problems(list);
      expect(found.length, name).toBeGreaterThan(0);
      expect(found.join(" "), name).not.toContain("8.8.8.8");
    }
  });

  it("is refused before a docker call for input that is not plain", () => {
    const bad = (overrides: Partial<Parameters<typeof generalFakesRunArgs>[0]>) => expect(() => generalFakesRunArgs({ net: net(), ...launch, ...overrides })).toThrow(/for the fake helper/u);
    bad({ image: "worker:latest" });
    bad({ image: "x y@sha256:" + "b".repeat(64) });
    bad({ runDir: "/run/rovara/job1/models" });
    bad({ runDir: "/run/../fakes" });
    bad({ runDir: "relative/fakes" });
    bad({ digest: "zz" });
    bad({ workspaceId: "w1" });
    bad({ operationId: "o1" });
    for (const lifetimeMs of [0, -1, 999, 86_400_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) bad({ lifetimeMs });
    expect(() => generalFakesRunArgs({ net: { ...net(), name: "evil name" }, ...launch })).toThrow();
  });

  it("names the container after the network, and every round gets a network id of its own", () => {
    expect(generalFakesContainerName({ name: "rovara-svc-0123456789ab" })).toBe("rovara-svc-0123456789ab-fakes");
    expect(generalFakesRunId(OPERATION, 1)).toMatch(/^gf-[0-9a-f]{32}$/u);
    expect(new Set([generalFakesRunId(OPERATION, 1), generalFakesRunId(OPERATION, 2), generalFakesRunId("11111111-1111-4111-8111-111111111111", 1)]).size).toBe(3);
    expect(() => generalFakesRunId("not-a-uuid", 1)).toThrow();
    expect(() => generalFakesRunId(OPERATION, -1)).toThrow();
    expect(RUN_NETWORK_SLOTS).toBeGreaterThan(8);
  });
});

describe("the run files", () => {
  it("writes nothing for fakes that cannot be stored", async () => {
    const parent = await scratch();
    expect(await writeGeneralFakesRunFiles({ parent, workspaceId: "x", operationId: OPERATION, fakes: FAKES })).toBeUndefined();
    expect(await readdir(parent)).toEqual([]);
    expect(buildGeneralFakesSetBytes).toBeDefined();
  });
});

describe("starting the helper", () => {

  it("gives the helper its own deadline: the round budget plus a grace shorter than the network's 15 minute stale margin, so it stops itself even if stop() never runs", async () => {
    expect(GENERAL_FAKES_HELPER_GRACE_MS).toBeLessThan(RUN_NETWORK_STALE_MARGIN_MS);
    const daemon = fakeDaemon();
    const started = await startGeneralFakesHelper(await input(daemon));
    const helper = daemon.containers.find((c) => c.name.endsWith("-fakes"))!;
    expect(values(helper.args, "--lifetime-ms")).toEqual([String(600_000 + GENERAL_FAKES_HELPER_GRACE_MS)]);
    await started.stop();
    // A different budget gives a different deadline (the value is derived, not fixed); a test seam shortens it for a real Docker host.
    const second = fakeDaemon();
    const short = await startGeneralFakesHelper(await input(second, { roundBudgetMs: 60_000 }));
    expect(values(second.containers.find((c) => c.name.endsWith("-fakes"))!.args, "--lifetime-ms")).toEqual([String(60_000 + GENERAL_FAKES_HELPER_GRACE_MS)]);
    await short.stop();
    const third = fakeDaemon();
    const override = await startGeneralFakesHelper(await input(third, { helperLifetimeMs: 4000 }));
    expect(values(third.containers.find((c) => c.name.endsWith("-fakes"))!.args, "--lifetime-ms")).toEqual(["4000"]);
    await override.stop();
  });

  const failsClosed = async (daemonOptions: DaemonOptions, overrides: Partial<StartGeneralFakesHelperInput> = {}) => {
    const daemon = fakeDaemon(daemonOptions);
    const given = await input(daemon, overrides);
    await expect(startGeneralFakesHelper(given)).rejects.toThrow(FAILURE);
    nothingLeft(daemon);
    // The run files are deleted too.
    expect(await readdir(given.scratchParent)).toEqual([]);
  };
  it("a helper that cannot be started leaves nothing behind, with one fixed sentence", () => failsClosed({ failRun: true }));
  it("a helper that stops at once (a set it refused) leaves nothing behind", () => failsClosed({ helperStopsImmediately: true }));
  it("a helper on a second network is refused (the daemon disagreed with the arguments)", () => failsClosed({ extraNetworkForHelper: "bridge" }));
  it("a sandbox that cannot join leaves nothing behind", () => failsClosed({ failConnect: true }));
  it("a sandbox that is already on another run network is never joined to this one, and is left as it was", async () => {
    const daemon = fakeDaemon({ sandboxOnRunNetwork: true });
    await expect(startGeneralFakesHelper(await input(daemon))).rejects.toThrow(FAILURE);
    expect(daemon.networks).toEqual([]);
    expect(daemon.containers.map((c) => c.name)).toEqual([SANDBOX]);
    expect([...daemon.containers[0]!.networks.keys()]).toEqual([TASK_SANDBOX_NETWORK, "rovara-svc-aaaaaaaaaaaa"]);
    expect(daemon.calls.some((call) => call[0] === "network" && call[1] === "connect")).toBe(false);
  });
  it("a network that holds anything but the helper and the sandbox is refused", async () => {
    const daemon = fakeDaemon({ intruder: true });
    await expect(startGeneralFakesHelper(await input(daemon))).rejects.toThrow(FAILURE);
    // The helper is gone and the sandbox is off the network; the unlabelled intruder is not this module's to remove (the network then stays until a sweep finds it empty).
    expect(daemon.containers.map((c) => c.name).sort()).toEqual([SANDBOX, "intruder"]);
    expect([...daemon.containers.find((c) => c.name === SANDBOX)!.networks.keys()]).toEqual([TASK_SANDBOX_NETWORK]);
  });
  it("is refused before any docker call for input that is not plain, or a worker that does not offer it", async () => {
    const daemon = fakeDaemon();
    const refused = async (overrides: Partial<StartGeneralFakesHelperInput>) => { await expect(startGeneralFakesHelper(await input(daemon, overrides))).rejects.toThrow(); expect(daemon.calls).toEqual([]); };
    await refused({ workspaceKey: "short" });
    await refused({ workspaceId: "w" });
    await refused({ operationId: "o" });
    await refused({ sandboxName: "bad name!" });
    await refused({ image: "worker:latest" });
    await refused({ fakes: [] });
    await refused({ fakes: FAKES, variables: [] });
    await refused({ environment: {} });
  });
});

function fakeSummary(helper: FakeContainer): string {
  const program = helper.args.slice(helper.args.indexOf("--listen"));
  return JSON.stringify({
    schemaVersion: 1, trusted: true, workspaceId: values(program, "--workspace")[0], operationId: values(program, "--operation")[0], digest: values(program, "--digest")[0], served: 0,
    cannotAnswer: { no_spec: 0, spec_unreadable: 0, spec_ambiguous: 0, operation_unknown: 0, operation_unsupported: 0 }, foreign: 0, unrouted: 0, refused: 0, saturated: false,
  });
}

describe("reading what the helper answered", () => {
  const withCounts = (counts: Partial<Record<string, unknown>>) => (helper: FakeContainer) => `${JSON.stringify({ ...JSON.parse(fakeSummary(helper)) as object, ...counts })}\n`;
  it("gives nothing (never 'no calls') for a summary that is untrusted, saturated, bound to another company, task or digest, or smaller than the last one", async () => {
    let current: (helper: FakeContainer) => string = withCounts({});
    const daemon = fakeDaemon({ summary: (helper) => current(helper) });
    const started = await startGeneralFakesHelper(await input(daemon));
    current = withCounts({ served: 4 });
    expect(await started.drain()).toMatchObject({ served: 4 });
    for (const bad of [withCounts({ saturated: true }), withCounts({ workspaceId: "11111111-1111-4111-8111-111111111111" }), withCounts({ operationId: "11111111-1111-4111-8111-111111111111" }), withCounts({ digest: "0".repeat(64) }), withCounts({ served: 1 }), () => "garbage\n", () => `${JSON.stringify({ schemaVersion: 1, trusted: false })}\n`, () => "x".repeat(10_000)]) {
      current = bad;
      expect(await started.drain()).toBeUndefined();
    }
    current = withCounts({ served: 6 });
    expect(await started.drain()).toMatchObject({ served: 2 });
    await started.stop();
  });
  it("the launcher gives the helper lowercase ids whatever case the invocation spelled them in", async () => {
    const daemon = fakeDaemon();
    const environment = await offered();
    const launcher = hostedFakesLauncherFor({ sandbox: { name: SANDBOX }, testServices: false, devcontainer: false, requested: true, docker: daemon.docker, rootPath: await scratch(), workspaceId: WORKSPACE.toUpperCase(), operationId: OPERATION.toUpperCase(), roundBudgetMs: () => 600_000, environment })!;
    const started = await launcher.start({ fakes: FAKES, variables: ["PETS_API_URL"] });
    const helper = daemon.containers.find((c) => c.name.endsWith("-fakes"))!;
    expect(helper.args).toContain(WORKSPACE);
    expect(helper.args).toContain(OPERATION);
    await started.stop();
  });
});

describe("the call arithmetic", () => {
  const zero = { served: 0, no_spec: 0, spec_unreadable: 0, spec_ambiguous: 0, operation_unknown: 0, operation_unsupported: 0, foreign: 0, unrouted: 0, refused: 0 };
  it("is the difference of two readings, and refuses a counter that went down", () => {
    expect(hostedCallsBetween(undefined, { ...zero, served: 3, foreign: 1 })).toEqual({ served: 3, foreign: 1, unrouted: 0, refused: 0, cannotAnswer: { no_spec: 0, spec_unreadable: 0, spec_ambiguous: 0, operation_unknown: 0, operation_unsupported: 0 } });
    expect(hostedCallsBetween({ ...zero, served: 3 }, { ...zero, served: 3, operation_unsupported: 2 })).toMatchObject({ served: 0, cannotAnswer: { operation_unsupported: 2 } });
    for (const key of Object.keys(zero)) expect(hostedCallsBetween({ ...zero, [key]: 2 }, { ...zero, [key]: 1 }), key).toBeUndefined();
  });
});
