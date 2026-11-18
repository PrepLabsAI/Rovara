// L4-E12 (E1): the fresh eval box joins the project's test services on its round network (.16 to .47), gets their connection variables in its env file, and still mounts only its checkout. Base and change each get a NEW copy.
// Nothing starts Docker: a stateful fake daemon (tests/support/fake-eval-sealed-daemon.ts) answers every command and answers one NETWORK question from the arguments alone (what can the box reach?). The Linux proof is a pending
// deferred check (DEFERRED-CHECKS L4-E12-LINUX).
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskDependencyPlanSchema, ownerCatalogOf, ownerStarterEntries, type TaskDependencyPlan } from "@agentx/contracts";
import {
  EVAL_BRIDGE_SOCKET_NAME, EVAL_HELPER_DIR_NAME, FRESH_EVAL_WORKSPACE, bridgeFolderMountProblems, createFreshEvalSandbox, freshEvalEnvironment, freshEvalSandboxArgProblems, freshEvalSandboxRunArgs,
  type FreshEvalSandboxConfig, type FreshEvalSandboxRun,
} from "../../packages/worker/src/verification/eval-bridged-exec.js";
import { EVAL_SERVICES_FAILURE_SENTENCE, createEvalServicesStarter, type EvalServicesStarted, type EvalServicesStarter } from "../../packages/worker/src/verification/eval-services.js";
import { planModelHostBlock } from "../../packages/worker/src/model-helper-block.js";
import { runNetworkAddresses, runNetworkHelperIp, runNetworkModelHelperIp } from "../../packages/worker/src/run-network.js";
import { testServicesConfigFromEnvironment, TEST_SERVICES_OWNER_IMAGES_ENVIRONMENT } from "../../packages/worker/src/test-services-run.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import { EVAL_REPORT_FILE, fakeEvalDaemon } from "../support/fake-eval-sealed-daemon.js";

const WS = "0123456789abcdef";
const IMAGE = `rovara/worker@sha256:${"c".repeat(64)}`;
const WORKER_IMAGE = `sha256:${"a".repeat(64)}`;
const BASE = "b".repeat(40);
const CANDIDATE = "d".repeat(40);
const TOKEN = "A".repeat(32);
const FACTS = JSON.stringify({ metadataBlocked: true, runWalls: true, ipv6Drops: true, prepull: "off", prepulled: 0, loggedOut: true, dockerVersion: "27.3.1" });
const OFFERED: NodeJS.ProcessEnv = { AGENTX_TEST_SERVICES_BOOT_FACTS: FACTS };
const REPORT = { cwd: ".", argument: EVAL_REPORT_FILE };

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const temp = async (prefix: string): Promise<string> => { const dir = await mkdtemp(join(tmpdir(), prefix)); roots.push(dir); return dir; };

/** A real postgres plan against the owner starter catalog (the one a laptop and a mirrored hosted install run). */
function postgresPlan(over: Record<string, unknown> = {}): TaskDependencyPlan {
  const entry = ownerCatalogOf(ownerStarterEntries())!.entries.find((candidate) => candidate.id === "postgres@16")!;
  return TaskDependencyPlanSchema.parse({
    id: "postgres", name: "Postgres", kind: "database", family: "postgres", backing: "local", catalogId: "postgres@16", repository: entry.image.repository, digest: entry.image.digest,
    config: { database: "app", user: "app" }, aliases: ["postgres"], connect: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], seeds: [], reset: "fresh_per_round", ...over,
  });
}
async function servicesConfig(docker: DockerCli) {
  const runDir = await temp("evs-runs-");
  const environment: NodeJS.ProcessEnv = { AGENTX_TEST_SERVICES_RUN_DIR: runDir, AGENTX_SANDBOX_IMAGE: WORKER_IMAGE, AGENTX_WORKER_IMAGE: WORKER_IMAGE, [TEST_SERVICES_OWNER_IMAGES_ENVIRONMENT]: JSON.stringify(ownerStarterEntries()), AGENTX_TEST_SERVICES_BOOT_FACTS: FACTS };
  const config = testServicesConfigFromEnvironment(environment, docker, undefined, false)!;
  return { ...config, sleep: () => Promise.resolve(), now: () => 0 };
}

async function world(daemon = fakeEvalDaemon(), over: Partial<FreshEvalSandboxConfig> = {}) {
  const root = await temp("fes-e1-");
  const bridgeDir = join(root, "e1", EVAL_HELPER_DIR_NAME);
  await mkdir(bridgeDir, { recursive: true, mode: 0o700 });
  const config: FreshEvalSandboxConfig = {
    docker: daemon.docker, image: IMAGE, workspace: WS, taskId: "op-1", roundBudgetMs: 600_000, repository: { directory: join(root, "repo"), baseCommit: BASE, candidateCommit: CANDIDATE },
    command: { executable: "node", args: ["eval.js"], cwd: "." }, report: REPORT, rowId: "gemini", scratchDir: join(root, "scratch"), workingSandbox: null, environment: OFFERED,
    materialize: async (_root, commit, destination) => { await writeFile(join(destination, "eval.js"), `// ${commit}`); }, sleep: () => Promise.resolve(), ...over,
  };
  const input = (o: Partial<FreshEvalSandboxRun> = {}): FreshEvalSandboxRun => ({ side: "new", ids: ["q1", "q2"], runs: 1, signal: new AbortController().signal, model: { socketPath: join(bridgeDir, EVAL_BRIDGE_SOCKET_NAME), token: TOKEN }, ...o });
  return { root, bridgeDir, config, daemon, input, sandbox: () => createFreshEvalSandbox(config) };
}

/** A starter of the daemon's own: starts nothing real, and says which services it served (a seam for the sandbox's own wiring tests). */
function stubStarter(services: { alias: string; slotIndex: number; env: Array<[string, string]>; secrets?: string[] }[], log: string[] = []): EvalServicesStarter {
  return {
    async start(net) {
      log.push(`start ${net.name}`);
      return {
        hosts: services.map((service) => ({ alias: service.alias, address: runNetworkHelperIp(net.slot, service.slotIndex) })), env: services.flatMap((service) => service.env), secrets: services.flatMap((service) => service.secrets ?? []),
        started: services.map((service) => ({ id: service.alias, address: runNetworkHelperIp(net.slot, service.slotIndex), ports: [5432] })), targets: [], unsupported: [],
        stop: async () => { log.push(`stop ${net.name}`); },
      } satisfies EvalServicesStarted;
    },
  };
}

// ---- the arguments: a helper's address is accepted, anything else is still refused

describe("E1: the sandbox's arguments (allow-list)", () => {
  const net = { name: "rovara-svc-0123456789ab", checkSandboxIp: "172.30.7.4", dnsHelperIp: "172.30.7.2", labelArgs: () => ["--label", "rovara.run-network=rovara-svc-0123456789ab", "--label", "rovara.run-network.created=1", "--label", "rovara.run-network.expires=2", "--label", `rovara.run-network.workspace=${WS}`] };
  const block = planModelHostBlock({ hasModelRow: true, helperIp: "172.30.7.9" });
  const build = (extra: object = {}) => freshEvalSandboxRunArgs({ net, image: IMAGE, name: `${net.name}-eval`, checkout: "/scratch/run-a/checkout", envFile: "/scratch/run-a/env", block, command: { executable: "node", args: ["eval.js"], cwd: "." }, ...extra }, { bridgeDir: "/scratch/e1/models" });
  const problems = (args: string[], extra: object = {}) => freshEvalSandboxArgProblems(args, net, { checkout: "/scratch/run-a/checkout", bridgeDir: "/scratch/e1/models", helperIp: "172.30.7.9", ...extra });
  const service = [{ alias: "postgres", address: "172.30.7.16" }];

  it("accepts a service helper's name pinned to its own address (.16), and nothing about the mounts or the network changes", () => {
    const args = build({ serviceHosts: service });
    expect(args).toContain("postgres:172.30.7.16");
    expect(problems(args, { serviceHosts: service })).toEqual([]);
    // still exactly one mount, one network, the same walls
    expect(args.filter((arg, index) => args[index - 1] === "--volume")).toEqual([`/scratch/run-a/checkout:${FRESH_EVAL_WORKSPACE}:rw`]);
    expect(args.filter((arg, index) => args[index - 1] === "--network")).toEqual([net.name]);
    expect(args).toContain("--read-only");
    expect(args.filter((arg, index) => args[index - 1] === "--cap-drop")).toEqual(["ALL"]);
  });

  it("refuses a pin that points anywhere else: another address, another name, a public address, or a service that was not declared (mutant: the pin check)", () => {
    const args = build({ serviceHosts: service });
    const swap = (from: string, to: string) => args.map((arg) => (arg === from ? to : arg));
    expect(problems(swap("postgres:172.30.7.16", "postgres:172.30.7.40"), { serviceHosts: service })).not.toEqual([]);
    expect(problems(swap("postgres:172.30.7.16", "postgres:8.8.8.8"), { serviceHosts: service })).not.toEqual([]);
    expect(problems(swap("postgres:172.30.7.16", "other:172.30.7.16"), { serviceHosts: service })).not.toEqual([]);
    expect(problems(args, {})).not.toEqual([]);
  });

  it("is still refused: a second network, a published port, another mount, a docker socket, a capability, a device, a second env file", () => {
    const args = build({ serviceHosts: service });
    const withExtra = (...extra: string[]) => [...args.slice(0, args.indexOf("--entrypoint")), ...extra, ...args.slice(args.indexOf("--entrypoint"))];
    for (const extra of [["--network", "bridge"], ["--publish", "5432:5432"], ["--volume", "/var/run/docker.sock:/var/run/docker.sock"], ["--volume", "/etc:/etc:ro"], ["--cap-add", "NET_ADMIN"], ["--device", "/dev/net/tun"], ["--env-file", "/x/env"], ["--add-host", "evil:172.30.7.17"], ["--network-alias", "x"], ["--privileged", "true"]]) {
      expect(problems(withExtra(...extra), { serviceHosts: service }), extra.join(" ")).not.toEqual([]);
    }
  });

  it("refuses to build arguments when a service name is not a plain name or is at an address outside the helper range (.16 to .47) of the round", async () => {
    const daemon = fakeEvalDaemon();
    const w = await world(daemon, { services: { start: async (net2) => ({ hosts: [{ alias: "Bad Name!", address: runNetworkHelperIp(net2.slot, 0) }], env: [], secrets: [], started: [], targets: [], unsupported: [], stop: async () => undefined }) } });
    await expect(w.sandbox().run(w.input())).rejects.toThrow();
    expect(daemon.everStarted.some((container) => container.name.endsWith("-eval"))).toBe(false);
    const outside = await world(fakeEvalDaemon(), { services: { start: async (net2) => ({ hosts: [{ alias: "postgres", address: runNetworkAddresses(net2.slot).gateway }], env: [], secrets: [], started: [], targets: [], unsupported: [], stop: async () => undefined }) } });
    await expect(outside.sandbox().run(outside.input())).rejects.toThrow();
    expect(outside.daemon.everStarted.some((container) => container.name.endsWith("-eval"))).toBe(false);
  });

  it("the env file carries the service variables after the model's, plain; a name twice or one that is not a plain name is refused (mutant: the duplicate check)", () => {
    const text = freshEvalEnvironment({ rowId: "gemini", token: TOKEN, side: "new", runs: 1, ids: ["q1"], helperIp: "172.30.7.9", services: [["DATABASE_URL", "postgres://app:pw@postgres:5432/app"], ["PGHOST", "postgres"]] });
    const lines = text.trim().split("\n");
    expect(lines).toContain("DATABASE_URL=postgres://app:pw@postgres:5432/app");
    expect(lines.indexOf("DATABASE_URL=postgres://app:pw@postgres:5432/app")).toBeGreaterThan(lines.findIndex((line) => line.startsWith("GOOGLE_GEMINI_BASE_URL=")));
    expect(lines.filter((line) => line.startsWith("ROVARA_EVAL_"))).toHaveLength(3);
    expect(() => freshEvalEnvironment({ rowId: "gemini", token: TOKEN, side: "new", runs: 1, ids: ["q1"], services: [["HOME", "/x"]] })).toThrow();
    expect(() => freshEvalEnvironment({ rowId: "gemini", token: TOKEN, side: "new", runs: 1, ids: ["q1"], services: [["A", "1"], ["A", "2"]] })).toThrow();
    expect(() => freshEvalEnvironment({ rowId: "gemini", token: TOKEN, side: "new", runs: 1, ids: ["q1"], services: [["A=B", "1"]] })).toThrow();
    expect(() => freshEvalEnvironment({ rowId: "gemini", token: TOKEN, side: "new", runs: 1, ids: ["q1"], services: [["A", "line\nbreak"]] })).toThrow();
    // no services: exactly the old file
    expect(freshEvalEnvironment({ rowId: "gemini", token: TOKEN, side: "new", runs: 1, ids: ["q1"], helperIp: "172.30.7.9" })).not.toContain("DATABASE_URL");
  });
});

// ---- the run: services on the round network, fresh on both sides

describe("E1: a sealed run with services", () => {
  it("starts the services on THIS round's network, puts their variables in the box's env file, mounts only the checkout and the name files, and removes everything afterwards", async () => {
    const log: string[] = [];
    const daemon = fakeEvalDaemon();
    const w = await world(daemon, { services: stubStarter([{ alias: "postgres", slotIndex: 0, env: [["DATABASE_URL", "postgres://app:s3cretpw0@postgres:5432/app"], ["PGHOST", "postgres"]], secrets: ["s3cretpw0"] }], log) });
    await w.sandbox().run(w.input());
    const sandbox = daemon.everStarted.find((container) => container.name.endsWith("-eval"))!;
    const envFile = daemon.envFiles.find((file) => file.container === sandbox.name)!.content;
    expect(envFile).toContain("DATABASE_URL=postgres://app:s3cretpw0@postgres:5432/app");
    expect(envFile).toContain("PGHOST=postgres");
    // the round network the services were started on is the sandbox's own
    expect(log).toEqual([`start ${sandbox.network}`, `stop ${sandbox.network}`]);
    // exactly the checkout plus (sealed name server) the two run-owned name files, read-only: nothing else
    expect(sandbox.mounts.filter((mount) => mount.Type === "bind").map((mount) => [mount.Destination, mount.RW])).toEqual([[FRESH_EVAL_WORKSPACE, true], ["/etc/resolv.conf", false], ["/etc/hosts", false]]);
    // the name files hold the service's name at its helper address and the model hosts at the model helper
    const hosts = daemon.mountedFiles.find((file) => file.destination === "/etc/hosts")!.content;
    expect(hosts).toContain(`${runNetworkHelperIp(Number(/172\.30\.(\d+)\./u.exec(sandbox.ip)![1]), 0)} postgres`);
    expect(hosts).toMatch(/172\.30\.\d+\.9 generativelanguage\.googleapis\.com/u);
    // everything is gone: no container, no network
    expect(daemon.containers).toEqual([]);
    expect(daemon.networks).toEqual([]);
  });

  it("review M1: with the stand-in switch off a services round reports NOTHING of stand-ins (no `standIns`, no 'Ran against' databases); with it on the run names the databases", async () => {
    const stub = () => stubStarter([{ alias: "postgres", slotIndex: 0, env: [["DATABASE_URL", "postgres://app:pw@postgres:5432/app"]] }]);
    const off = await world(fakeEvalDaemon(), { services: stub() });
    expect((await off.sandbox().run(off.input())).standIns).toBeUndefined();
    const on = await world(fakeEvalDaemon(), { services: stub(), reportStandInDatabases: true });
    expect((await on.sandbox().run(on.input())).standIns).toMatchObject({ hitGap: false, databases: ["Postgres"] });
  });

  it("the old side and the new side each get a FRESH copy: two networks, two starts, two stops, never one shared (mutant: share the starter's result)", async () => {
    const log: string[] = [];
    const daemon = fakeEvalDaemon();
    const w = await world(daemon, { services: stubStarter([{ alias: "postgres", slotIndex: 0, env: [["DATABASE_URL", "postgres://app:pw@postgres:5432/app"]] }], log), workingSandbox: null });
    const sandbox = w.sandbox();
    await sandbox.run(w.input({ side: "old" }));
    await sandbox.run(w.input({ side: "new" }));
    const networks = [...new Set(daemon.everStarted.map((container) => container.network))];
    expect(networks).toHaveLength(2);
    expect(log.filter((line) => line.startsWith("start "))).toHaveLength(2);
    expect(new Set(log.filter((line) => line.startsWith("start ")))).toHaveProperty("size", 2);
    expect(log.filter((line) => line.startsWith("stop "))).toHaveLength(2);
    // The sides' services were started on their OWN round network.
    for (const network of networks) expect(log).toContain(`start ${network}`);
  });

  it("with the production starter: each side's postgres is a new container on its own network, from the same pinned image with the same user and database, and a new password; all of it is removed", async () => {
    const daemon = fakeEvalDaemon();
    const config = await servicesConfig(daemon.docker);
    const starter = createEvalServicesStarter({ config, dependencies: [postgresPlan()] })!;
    expect(starter).toBeDefined();
    const w = await world(daemon, { services: starter });
    const sandbox = w.sandbox();
    await sandbox.run(w.input({ side: "old" }));
    await sandbox.run(w.input({ side: "new" }));
    const postgres = daemon.everStarted.filter((container) => container.aliases.includes("postgres"));
    expect(postgres).toHaveLength(2);
    expect(postgres[0]!.network).not.toBe(postgres[1]!.network);
    expect(postgres[0]!.name).not.toBe(postgres[1]!.name);
    const imageOf = (container: (typeof postgres)[number]) => container.args[container.args.findIndex((arg) => arg === "--") - 0] ?? container.args.find((arg) => arg.includes("@sha256:"));
    expect(imageOf(postgres[0]!)).toBe(imageOf(postgres[1]!));
    // the connection variables each side's box got name the same user, database, host and port; only the secret differs
    const urls = daemon.envFiles.filter((file) => file.container.endsWith("-eval")).map((file) => /^DATABASE_URL=(.*)$/mu.exec(file.content)![1]!);
    expect(urls).toHaveLength(2);
    const shape = (url: string) => url.replace(/\/\/app:[^@]+@/u, "//app:<pw>@");
    expect(shape(urls[0]!)).toBe(shape(urls[1]!));
    expect(shape(urls[0]!)).toMatch(/^postgres:\/\/app:<pw>@postgres:5432\/app$/u);
    expect(urls[0]).not.toBe(urls[1]);
    expect(daemon.containers).toEqual([]);
    expect(daemon.networks).toEqual([]);
  });

  it("the box can reach the Postgres helper and the model helper and the name server, and NOTHING else (the round network is internal, the box is on it alone, nothing is published)", async () => {
    const daemon = fakeEvalDaemon();
    const config = await servicesConfig(daemon.docker);
    const w = await world(daemon, { services: createEvalServicesStarter({ config, dependencies: [postgresPlan()] })! });
    await w.sandbox().run(w.input());
    const sandbox = daemon.everStarted.find((container) => container.name.endsWith("-eval"))!;
    const slot = Number(/172\.30\.(\d+)\./u.exec(sandbox.ip)![1]);
    const reach = daemon.reachableFrom(sandbox.name);
    expect(reach).not.toBe("anything");
    expect([...(reach as string[])].sort()).toEqual([runNetworkAddresses(slot).dnsHelperIp, runNetworkModelHelperIp(slot), runNetworkHelperIp(slot, 0)].sort());
    // the network is an internal bridge on the walled `rvi` interface
    const network = daemon.networks.length === 0 ? undefined : daemon.networks[0];
    void network;
    const created = daemon.calls.find((call) => call[0] === "network" && call[1] === "create")!;
    expect(created).toContain("--internal");
    expect(created.join(" ")).toMatch(/com\.docker\.network\.bridge\.name=rvi[0-9a-f]{8}/u);
    // a second network (an escape) would make the model say "anything": positive control for the model itself
    daemon.everStarted.push({ ...sandbox, name: "escaped-box", args: [...sandbox.args, "--network", "bridge"] });
    expect(daemon.reachableFrom("escaped-box")).toBe("anything");
    daemon.everStarted.push({ ...sandbox, name: "published-box", args: [...sandbox.args, "--publish", "5432:5432"] });
    expect(daemon.reachableFrom("published-box")).toBe("anything");
  });

  it("a services start that fails ends the run before the box exists: no sandbox, no leftover container or network", async () => {
    const daemon = fakeEvalDaemon();
    const w = await world(daemon, { services: { start: async () => { throw new Error(EVAL_SERVICES_FAILURE_SENTENCE); } } });
    await expect(w.sandbox().run(w.input())).rejects.toThrow(EVAL_SERVICES_FAILURE_SENTENCE);
    expect(daemon.everStarted.some((container) => container.name.endsWith("-eval"))).toBe(false);
    expect(daemon.containers).toEqual([]);
    expect(daemon.networks).toEqual([]);
  });

  it("a service's password never shows in a failed run's output tail (the starter's secrets are registered for redaction)", async () => {
    const daemon = fakeEvalDaemon({ exitCode: 1, output: () => "psycopg2.OperationalError: password authentication failed for user app (s3cretpw0)\nFATAL: password s3cretpw0" });
    const w = await world(daemon, { services: stubStarter([{ alias: "postgres", slotIndex: 0, env: [["DATABASE_URL", "postgres://app:s3cretpw0@postgres:5432/app"]], secrets: ["s3cretpw0"] }]) });
    const error = await w.sandbox().run(w.input()).catch((caught: unknown) => caught) as { diagnostic?: { tail: string } };
    expect(error.diagnostic).toBeDefined();
    expect(error.diagnostic!.tail).not.toContain("s3cretpw0");
    expect(error.diagnostic!.tail).toContain("password authentication failed");
  });
});

describe("E1: when there is nothing to start", () => {
  it("no starter without a test-services configuration, without a plan, or with a plan that has no real-software service (the run is then exactly what it was)", async () => {
    const daemon = fakeEvalDaemon();
    const config = await servicesConfig(daemon.docker);
    expect(createEvalServicesStarter({ config: undefined, dependencies: [postgresPlan()] })).toBeUndefined();
    expect(createEvalServicesStarter({ config, dependencies: undefined })).toBeUndefined();
    expect(createEvalServicesStarter({ config, dependencies: [] })).toBeUndefined();
  });

  it("a run with no services keeps loopback DNS, the pinned model names and one mount: its arguments carry no name file, no host name and no service pin (golden)", async () => {
    const daemon = fakeEvalDaemon();
    const w = await world(daemon);
    await w.sandbox().run(w.input());
    const sandbox = daemon.everStarted.find((container) => container.name.endsWith("-eval"))!;
    expect(sandbox.args).toContain("--dns");
    expect(sandbox.args[sandbox.args.indexOf("--dns") + 1]).toBe("127.0.0.1");
    expect(sandbox.args).not.toContain("--hostname");
    expect(sandbox.mounts.filter((mount) => mount.Type === "bind")).toHaveLength(1);
    expect(daemon.calls.some((call) => call.includes("rovara-svc") && call.join(" ").includes("sealed-dns-helper"))).toBe(false);
    expect(daemon.everStarted.some((container) => container.name.endsWith("-dns"))).toBe(false);
  });
});

describe("E2: the sealed name server on the eval round", () => {
  it("is on when asked for (and with services by default), serves .4 only, has the sinkhole at the last helper address, and the box takes /etc/resolv.conf and /etc/hosts from the run's own files (no --dns, no --add-host)", async () => {
    const daemon = fakeEvalDaemon();
    const w = await world(daemon, { sealedDns: true });
    await w.sandbox().run(w.input());
    const sandbox = daemon.everStarted.find((container) => container.name.endsWith("-eval"))!;
    const dns = daemon.everStarted.find((container) => container.name.endsWith("-dns"))!;
    const slot = Number(/172\.30\.(\d+)\./u.exec(sandbox.ip)![1]);
    expect(dns.ip).toBe(runNetworkAddresses(slot).dnsHelperIp);
    expect(dns.args[dns.args.indexOf("--source") + 1]).toBe(runNetworkAddresses(slot).checkSandboxIp);
    expect(dns.args[dns.args.indexOf("--sinkhole") + 1]).toBe(runNetworkHelperIp(slot, 31));
    // the embedded resolver's only upstream is the run's own sealed name server (never the host's, never loopback)
    expect(sandbox.args.filter((arg, index) => sandbox.args[index - 1] === "--dns")).toEqual([runNetworkAddresses(slot).dnsHelperIp]);
    expect(sandbox.args).not.toContain("--add-host");
    expect(sandbox.args[sandbox.args.indexOf("--hostname") + 1]).toBe("check");
    expect(daemon.mountedFiles.find((file) => file.destination === "/etc/resolv.conf")!.content).toContain(`nameserver ${runNetworkAddresses(slot).dnsHelperIp}`);
    // the model hosts are in the name server's table too, at the model helper
    expect(dns.args.filter((arg, index) => dns.args[index - 1] === "--host").some((pair) => pair === `generativelanguage.googleapis.com=${runNetworkModelHelperIp(slot)}`)).toBe(true);
  });

  it("the daemon's view of the box's mounts must be the checkout plus exactly the two name files read-only: a third mount or a writable name file stops the run (mutant: the mount check)", () => {
    const checkout = "/scratch/run-a/checkout";
    const dnsFiles = { resolvConfPath: "/scratch/run-a/resolv.conf", hostsPath: "/scratch/run-a/hosts" };
    const helper = [{ source: "/scratch/e1/models", destination: "/rovara/models", rw: false, type: "bind" }];
    const good = [{ source: checkout, destination: FRESH_EVAL_WORKSPACE, rw: true, type: "bind" }, { source: dnsFiles.resolvConfPath, destination: "/etc/resolv.conf", rw: false, type: "bind" }, { source: dnsFiles.hostsPath, destination: "/etc/hosts", rw: false, type: "bind" }, { source: "", destination: "/tmp", rw: true, type: "tmpfs" }];
    const check = (sandbox: typeof good, files: typeof dnsFiles | null = dnsFiles) => bridgeFolderMountProblems({ helper, sandbox, bridgeDir: "/scratch/e1/models", checkout, ...(files === null ? {} : { dnsFiles: files }) });
    expect(check(good)).toEqual([]);
    expect(check([...good, { source: "/etc", destination: "/host-etc", rw: false, type: "bind" }])).not.toEqual([]);
    expect(check(good.map((mount) => (mount.destination === "/etc/hosts" ? { ...mount, rw: true } : mount)))).not.toEqual([]);
    expect(check(good.map((mount) => (mount.destination === "/etc/hosts" ? { ...mount, source: "/scratch/other/hosts" } : mount)))).not.toEqual([]);
    expect(check(good.filter((mount) => mount.destination !== "/etc/resolv.conf"))).not.toEqual([]);
    // not sealed: the old rule, one mount
    expect(check(good, null)).not.toEqual([]);
    expect(check([good[0]!, good[3]!], null)).toEqual([]);
  });

  it("is refused when the daemon shows a third mount on the sealed box: the run fails and the box is killed", async () => {
    const daemon = fakeEvalDaemon();
    const real = daemon.docker.run.bind(daemon.docker);
    const docker: DockerCli = { run: async (args, options) => { const result = await real(args, options); if (args[0] === "run" && args.includes("--hostname")) daemon.find(args[args.indexOf("--name") + 1]!)!.mounts.push({ Source: "/etc", Destination: "/host-etc", RW: false, Type: "bind" }); return result; } };
    const w = await world(daemon, { sealedDns: true, docker });
    await expect(w.sandbox().run(w.input())).rejects.toThrow("the fresh sandbox is not isolated from the bridge folder");
    expect(daemon.containers).toEqual([]);
  });

  it("the off switch: ROVARA_EVAL_SEALED_DNS=0 keeps loopback DNS even where the host asked for none to change", async () => {
    const { evalSealedDnsOn } = await import("../../packages/worker/src/verification/eval-wiring.js");
    expect(evalSealedDnsOn({})).toBe(true);
    expect(evalSealedDnsOn({ ROVARA_EVAL_SEALED_DNS: "1" })).toBe(true);
    expect(evalSealedDnsOn({ ROVARA_EVAL_SEALED_DNS: "0" })).toBe(false);
  });
});

describe("E2: review fixes (embedded resolver, default, cleanup)", () => {
  it("a sealed box's only --dns is the run's own name server: another upstream, loopback or none is refused (mutant: drop the --dns check)", () => {
    const net = { name: "rovara-svc-0123456789ab", checkSandboxIp: "172.30.7.4", dnsHelperIp: "172.30.7.2", labelArgs: () => ["--label", "rovara.run-network=rovara-svc-0123456789ab", "--label", "rovara.run-network.created=1", "--label", "rovara.run-network.expires=2", "--label", `rovara.run-network.workspace=${WS}`] };
    const dnsFiles = { resolvConfPath: "/scratch/run-a/resolv.conf", hostsPath: "/scratch/run-a/hosts" };
    const block = planModelHostBlock({ hasModelRow: true, helperIp: "172.30.7.9" });
    const args = freshEvalSandboxRunArgs({ net, image: IMAGE, name: `${net.name}-eval`, checkout: "/scratch/run-a/checkout", envFile: "/scratch/run-a/env", block, command: { executable: "node", args: ["e.js"], cwd: "." }, dnsFiles }, { bridgeDir: "/scratch/e1/models" });
    const expected = { checkout: "/scratch/run-a/checkout", bridgeDir: "/scratch/e1/models", helperIp: "172.30.7.9", dnsFiles };
    expect(freshEvalSandboxArgProblems(args, net, expected)).toEqual([]);
    for (const other of ["8.8.8.8", "127.0.0.1", "172.30.7.1"]) expect(freshEvalSandboxArgProblems(args.map((arg) => (arg === "172.30.7.2" ? other : arg)), net, expected), other).not.toEqual([]);
    const without = args.filter((arg, index) => arg !== "--dns" && args[index - 1] !== "--dns");
    expect(freshEvalSandboxArgProblems(without, net, expected)).not.toEqual([]);
  });

  it("the allow-list checks a service entry itself: an alias that is not plain or an address outside .16 to .47 of the round is a problem even when the pin matches it", () => {
    const net = { name: "rovara-svc-0123456789ab", checkSandboxIp: "172.30.7.4", dnsHelperIp: "172.30.7.2", labelArgs: () => ["--label", "rovara.run-network=rovara-svc-0123456789ab", "--label", "rovara.run-network.created=1", "--label", "rovara.run-network.expires=2", "--label", `rovara.run-network.workspace=${WS}`] };
    const block = planModelHostBlock({ hasModelRow: true, helperIp: "172.30.7.9" });
    for (const bad of [{ alias: "postgres", address: "172.30.7.60" }, { alias: "postgres", address: "172.30.7.15" }, { alias: "postgres", address: "172.30.8.16" }, { alias: "Bad_Name", address: "172.30.7.16" }]) {
      const base = freshEvalSandboxRunArgs({ net, image: IMAGE, name: `${net.name}-eval`, checkout: "/scratch/run-a/checkout", envFile: "/scratch/run-a/env", block, command: { executable: "node", args: ["e.js"], cwd: "." } }, { bridgeDir: "/scratch/e1/models" });
      const at = base.indexOf("--user");
      const withPin = [...base.slice(0, at), "--add-host", `${bad.alias}:${bad.address}`, ...base.slice(at)];
      expect(freshEvalSandboxArgProblems(withPin, net, { checkout: "/scratch/run-a/checkout", bridgeDir: "/scratch/e1/models", helperIp: "172.30.7.9", serviceHosts: [bad] }).length, JSON.stringify(bad)).toBeGreaterThan(0);
    }
  });

  it("production wiring keeps a plain paid round on loopback DNS (sealedDns left undefined: on only with services or a dry run) and only the operator's switch forces false", () => {
    const wiring = readFileSync(new URL("../../packages/worker/src/verification/eval-wiring.ts", import.meta.url), "utf8");
    expect(wiring).toMatch(/\.\.\.\(evalSealedDnsOn\(host\.environment\) \? \{\} : \{ sealedDns: false \}\)/u);
    expect(wiring).not.toMatch(/sealedDns: evalSealedDnsOn/u);
  });

  it("a sealed name server that cannot start ends the run and leaves no container, network or name file (the services stop too)", async () => {
    const log: string[] = [];
    const daemon = fakeEvalDaemon({ failRun: (args) => (args[args.indexOf("--name") + 1] ?? "").endsWith("-dns") });
    const w = await world(daemon, { sealedDns: true, services: stubStarter([{ alias: "postgres", slotIndex: 0, env: [["DATABASE_URL", "postgres://a:b@postgres:5432/app"]] }], log) });
    await expect(w.sandbox().run(w.input())).rejects.toThrow("the sealed name server could not start");
    expect(daemon.everStarted.some((container) => container.name.endsWith("-eval"))).toBe(false);
    expect(daemon.containers).toEqual([]);
    expect(daemon.networks).toEqual([]);
    expect(log.filter((line) => line.startsWith("stop "))).toHaveLength(1);
  });
});
