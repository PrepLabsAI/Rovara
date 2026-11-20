// L4-E12 (E1): the fresh eval box joins the project's test services on its round network (.16 to .47), gets their connection variables in its env file, and still mounts only its checkout. Base and change each get a NEW copy.
// Nothing starts Docker: a stateful fake daemon (tests/support/fake-eval-sealed-daemon.ts) answers every command and answers one NETWORK question from the arguments alone (what can the box reach?). The Linux proof is a pending
// deferred check (DEFERRED-CHECKS L4-E12-LINUX).
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskDependencyPlanSchema, ownerCatalogOf, ownerStarterEntries, type TaskDependencyPlan } from "@agentx/contracts";
import { EVAL_BRIDGE_SOCKET_NAME, EVAL_HELPER_DIR_NAME, createFreshEvalSandbox, freshEvalModelBlock, freshEvalEnvironment, freshEvalSandboxArgProblems, freshEvalSandboxRunArgs, type FreshEvalSandboxConfig, type FreshEvalSandboxRun } from "../../packages/worker/src/verification/eval-bridged-exec.js";
import { createEvalServicesStarter, type EvalServicesStarted, type EvalServicesStarter } from "../../packages/worker/src/verification/eval-services.js";
import { runNetworkHelperIp } from "../../packages/worker/src/run-network.js";
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
  const block = freshEvalModelBlock("172.30.7.9");
  const build = (extra: object = {}) => freshEvalSandboxRunArgs({ net, image: IMAGE, name: `${net.name}-eval`, checkout: "/scratch/run-a/checkout", envFile: "/scratch/run-a/env", block, command: { executable: "node", args: ["eval.js"], cwd: "." }, ...extra }, { bridgeDir: "/scratch/e1/models" });
  const problems = (args: string[], extra: object = {}) => freshEvalSandboxArgProblems(args, net, { checkout: "/scratch/run-a/checkout", bridgeDir: "/scratch/e1/models", helperIp: "172.30.7.9", ...extra });
  const service = [{ alias: "postgres", address: "172.30.7.16" }];

  it("is still refused: a second network, a published port, another mount, a docker socket, a capability, a device, a second env file", () => {
    const args = build({ serviceHosts: service });
    const withExtra = (...extra: string[]) => [...args.slice(0, args.indexOf("--entrypoint")), ...extra, ...args.slice(args.indexOf("--entrypoint"))];
    for (const extra of [["--network", "bridge"], ["--publish", "5432:5432"], ["--volume", "/var/run/docker.sock:/var/run/docker.sock"], ["--volume", "/etc:/etc:ro"], ["--cap-add", "NET_ADMIN"], ["--device", "/dev/net/tun"], ["--env-file", "/x/env"], ["--add-host", "evil:172.30.7.17"], ["--network-alias", "x"], ["--privileged", "true"]]) {
      expect(problems(withExtra(...extra), { serviceHosts: service }), extra.join(" ")).not.toEqual([]);
    }
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

});

describe("E1: when there is nothing to start", () => {
  it("no starter without a test-services configuration, without a plan, or with a plan that has no real-software service (the run is then exactly what it was)", async () => {
    const daemon = fakeEvalDaemon();
    const config = await servicesConfig(daemon.docker);
    expect(createEvalServicesStarter({ config: undefined, dependencies: [postgresPlan()] })).toBeUndefined();
    expect(createEvalServicesStarter({ config, dependencies: undefined })).toBeUndefined();
    expect(createEvalServicesStarter({ config, dependencies: [] })).toBeUndefined();
  });

});

describe("E2: the sealed name server on the eval round", () => {

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
    const block = freshEvalModelBlock("172.30.7.9");
    const args = freshEvalSandboxRunArgs({ net, image: IMAGE, name: `${net.name}-eval`, checkout: "/scratch/run-a/checkout", envFile: "/scratch/run-a/env", block, command: { executable: "node", args: ["e.js"], cwd: "." }, dnsFiles }, { bridgeDir: "/scratch/e1/models" });
    const expected = { checkout: "/scratch/run-a/checkout", bridgeDir: "/scratch/e1/models", helperIp: "172.30.7.9", dnsFiles };
    expect(freshEvalSandboxArgProblems(args, net, expected)).toEqual([]);
    for (const other of ["8.8.8.8", "127.0.0.1", "172.30.7.1"]) expect(freshEvalSandboxArgProblems(args.map((arg) => (arg === "172.30.7.2" ? other : arg)), net, expected), other).not.toEqual([]);
    const without = args.filter((arg, index) => arg !== "--dns" && args[index - 1] !== "--dns");
    expect(freshEvalSandboxArgProblems(without, net, expected)).not.toEqual([]);
  });

  it("the allow-list checks a service entry itself: an alias that is not plain or an address outside .16 to .47 of the round is a problem even when the pin matches it", () => {
    const net = { name: "rovara-svc-0123456789ab", checkSandboxIp: "172.30.7.4", dnsHelperIp: "172.30.7.2", labelArgs: () => ["--label", "rovara.run-network=rovara-svc-0123456789ab", "--label", "rovara.run-network.created=1", "--label", "rovara.run-network.expires=2", "--label", `rovara.run-network.workspace=${WS}`] };
    const block = freshEvalModelBlock("172.30.7.9");
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


it("passes the round's command runner to seeding and captures the database ledger before stop", async () => {
  const daemon = fakeEvalDaemon(); const config = await servicesConfig(daemon.docker); const events: string[] = [];
  const starter = createEvalServicesStarter({ config, dependencies: [postgresPlan()], seed: async (started, _net, signal, runCommand) => {
    expect(started.env.some(([name]) => name === "DATABASE_URL")).toBe(true);
    expect(await runCommand!({ cwd: ".", executable: "alembic", args: ["upgrade", "head"], timeoutSeconds: 30 }, signal)).toEqual({ exitCode: 0, timedOut: false });
    events.push("seeded");
    return { observe: async ids => { events.push(`observed ${ids.join(",")}`); } };
  } })!;
  const w = await world(daemon, { services: starter, reportStandInDatabases: true });
  await w.sandbox().run(w.input());
  expect(events).toEqual(["seeded", "observed q1,q2"]);
  expect(daemon.containers).toEqual([]); expect(daemon.networks).toEqual([]);
});
