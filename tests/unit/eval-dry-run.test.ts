// L4-E12 (E2, DEC 254zzz55 N6): the FREE dry run of the drafted eval. The eval runs once on main in the sealed box with SCRIPTED model replies (no bridge, no token, no gateway: no model call can be made, so none can cost money),
// and what it reached becomes the dependency list: a database, an outside host, a missing variable. Nothing starts Docker (tests/support/fake-eval-sealed-daemon.ts).
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ModelBridgeModule from "../../packages/worker/src/model-bridge.js";
import { EvalDependencyListSchema, evalDependencyListWords, type EvalDependencyList, type SetupEvalDiscoveryReport, evalCommandFingerprintOf } from "@agentx/contracts";
import {
  EVAL_BRIDGE_SOCKET_NAME, EVAL_HELPER_DIR_NAME, createBridgedEvalExec, createFreshEvalSandbox, type EvalDryRunObservation, type FreshEvalSandboxConfig,
} from "../../packages/worker/src/verification/eval-bridged-exec.js";
import { dependencyListFrom, findMissingEnvVars, mergeDependencyLists, runEvalDryRun, runSetupEvalDryRun } from "../../packages/worker/src/verification/eval-dry-run.js";
import type { EvalServicesStarter } from "../../packages/worker/src/verification/eval-services.js";
import { EVAL_REPORT_FILE, fakeEvalDaemon } from "../support/fake-eval-sealed-daemon.js";

// The spy for "no model call": the bridge is the only way a sealed eval reaches the gateway, and only a paid run builds one.
const bridge = vi.hoisted(() => ({ made: 0 }));
vi.mock("../../packages/worker/src/model-bridge.js", async (original) => {
  const real = await original<typeof ModelBridgeModule>();
  return { ...real, createModelBridge: (...args: Parameters<typeof real.createModelBridge>) => { bridge.made += 1; return real.createModelBridge(...args); } };
});

const WS = "0123456789abcdef";
const IMAGE = `rovara/worker@sha256:${"c".repeat(64)}`;
const MAIN = "b".repeat(40);
const FACTS = JSON.stringify({ metadataBlocked: true, runWalls: true, ipv6Drops: true, prepull: "off", prepulled: 0, loggedOut: true, dockerVersion: "27.3.1" });
const OFFERED: NodeJS.ProcessEnv = { AGENTX_TEST_SERVICES_BOOT_FACTS: FACTS, AGENTX_WORKER_IMAGE: IMAGE };
const REPORT = { cwd: ".", argument: EVAL_REPORT_FILE };

const roots: string[] = [];
afterEach(async () => { bridge.made = 0; await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const temp = async (prefix: string): Promise<string> => { const dir = await mkdtemp(join(tmpdir(), prefix)); roots.push(dir); return dir; };

/** What a real eval prints when it reaches for a database, an outside API and a variable, in the shapes the closed list reads. */
const EVAL_OUTPUT = [
  "Traceback (most recent call last):",
  '  File "evals/run.py", line 9, in <module>',
  '    key = os.environ["STRIPE_API_KEY"]',
  "KeyError: 'STRIPE_API_KEY'",
  'psycopg2.OperationalError: connection to server at "db" (172.30.7.47), port 5432 failed: Connection refused',
  "requests.exceptions.ConnectionError: HTTPSConnectionPool(host='api.vendor.example.test', port=443): Max retries exceeded with url: /v1/charges (Caused by NameResolutionError(\"Failed to resolve 'api.vendor.example.test'\"))",
].join("\n");

const observation = (over: Partial<EvalDryRunObservation> = {}): EvalDryRunObservation => ({
  code: 1, timedOut: false, output: EVAL_OUTPUT, dns: { unknown: [{ name: "db", queries: 2 }, { name: "api.vendor.example.test", queries: 3 }], dropped: 0, unrecorded: 0 },
  modelRoute: { hosts: ["generativelanguage.googleapis.com"], suffixes: [] }, secrets: ["placeholder-key-0000"], sinkholeIp: "172.30.7.47", ...over,
});

describe("the dependency list from what a dry run left behind", () => {

  it("pairs the one unnamed host with the one port the sinkhole refused (an IP-only connect error), and leaves two ambiguous ports unnamed", () => {
    const one = dependencyListFrom(observation({ output: "Error: connect ECONNREFUSED 172.30.7.47:8443", dns: { unknown: [{ name: "vendor.example.test", queries: 1 }], dropped: 0, unrecorded: 0 } }));
    expect(one.hosts).toEqual([{ name: "vendor.example.test", port: 8443 }]);
    const two = dependencyListFrom(observation({ output: "Error: connect ECONNREFUSED 172.30.7.47:8443\nError: connect ECONNREFUSED 172.30.7.47:9443", dns: { unknown: [{ name: "vendor.example.test", queries: 1 }], dropped: 0, unrecorded: 0 } }));
    expect(two.hosts).toEqual([{ name: "vendor.example.test" }]);
    // a database port seen at the sinkhole is the database's, never a host's
    const db = dependencyListFrom(observation({ output: "dial tcp 172.30.7.47:5432: connect: connection refused", dns: { unknown: [{ name: "vendor.example.test", queries: 1 }], dropped: 0, unrecorded: 0 } }));
    expect(db.databases).toEqual([{ port: 5432, engine: "postgres" }]);
    expect(db.hosts).toEqual([{ name: "vendor.example.test" }]);
  });

  it("reads a missing variable only from the shapes that name one: an environ lookup's KeyError, 'Missing required environment variable X', 'X is not set'; never a plain KeyError, never a value, never the box's own variables", () => {
    expect(findMissingEnvVars('    url = os.environ["DATABASE_URL"]\nKeyError: \'DATABASE_URL\'')).toEqual(["DATABASE_URL"]);
    expect(findMissingEnvVars("Error: Missing required environment variable: OPENAI_API_KEY")).toEqual(["OPENAI_API_KEY"]);
    expect(findMissingEnvVars("Error: REDIS_URL is not set")).toEqual(["REDIS_URL"]);
    expect(findMissingEnvVars("environment variable SENDGRID_KEY is required")).toEqual(["SENDGRID_KEY"]);
    expect(findMissingEnvVars("KeyError: 'DATABASE_URL'")).toEqual([]);
    expect(findMissingEnvVars("data = {}\n    x = data['ROW_ID']\nKeyError: 'ROW_ID'")).toEqual([]);
    // what the box itself sets is never "missing"; Rovara's own names are never listed
    expect(findMissingEnvVars("Error: GEMINI_API_KEY is not set\nError: HOME is not set\nError: ROVARA_EVAL_SIDE is not set")).toEqual([]);
    // lower-case shapes are not variables
    expect(findMissingEnvVars("Error: my_var is not set")).toEqual([]);
    // each name once, in the order the output says them
    expect(findMissingEnvVars("A_KEY is not set\nB_KEY is not set\nA_KEY is not set")).toEqual(["A_KEY", "B_KEY"]);
    // a name that holds one of the run's secrets is dropped
    expect(findMissingEnvVars("SECRETVALUE1234_KEY is not set", ["SECRETVALUE1234"])).toEqual([]);
  });

  it("the list carries no log line, value, path, address or credential: a canary in the output, in a URL's password and in an address never reaches it", () => {
    const canary = "canary-password-8f3a";
    const list = dependencyListFrom(observation({
      output: `${EVAL_OUTPUT}\nconnecting to postgres://app:${canary}@db:5432/app\nTypeError: /workspace/secret/path.py failed\nError: connect ECONNREFUSED 10.1.2.3:6379`,
      secrets: [canary],
    }));
    const text = JSON.stringify(list);
    expect(text).not.toContain(canary);
    expect(text).not.toContain("/workspace");
    expect(text).not.toContain("10.1.2.3");
    expect(text).not.toContain("172.30");
    expect(list.databases.map((database) => database.port).sort()).toEqual([5432, 6379]);
  });

  it("says how the run ended, and why a stop that hides what comes after (a package that is not installed, the time limit) makes the list possibly incomplete", () => {
    expect(dependencyListFrom(observation({ timedOut: true, code: undefined, output: "" })).ended).toBe("timed_out");
    expect(dependencyListFrom(observation({ timedOut: true, code: undefined, output: "" })).stoppedEarly).toBe("run_timed_out");
    const missing = dependencyListFrom(observation({ output: "ModuleNotFoundError: No module named 'psycopg2'", dns: { unknown: [], dropped: 0, unrecorded: 0 } }));
    expect(missing).toMatchObject({ ended: "failed", stoppedEarly: "missing_package", databases: [], hosts: [], envVars: [] });
    expect(evalDependencyListWords(missing)).toContain("stopped early");
    expect(evalDependencyListWords(missing)).toContain("may be incomplete");
    // a run that reached something and ended well has no "stopped early"
    expect(dependencyListFrom(observation({ code: 0, output: "connect ECONNREFUSED 10.0.0.5:5432" })).stoppedEarly).toBeUndefined();
  });

  it("an unreadable observation gives an empty list, never a throw; lists are bounded", () => {
    expect(dependencyListFrom({} as EvalDryRunObservation)).toMatchObject({ databases: [], hosts: [], envVars: [], modelCalls: 0 });
    const many = Array.from({ length: 40 }, (_, index) => ({ name: `h${String(index)}.example.test`, queries: 1 }));
    const list = dependencyListFrom(observation({ output: "", dns: { unknown: many, dropped: 0, unrecorded: 0 } }));
    expect(list.hosts).toHaveLength(16);
  });

  it("merging suites keeps each thing once and the worst ending", () => {
    const a = dependencyListFrom(observation());
    const b = dependencyListFrom(observation({ code: 0, output: "connect ECONNREFUSED 10.0.0.5:6379", dns: { unknown: [{ name: "other.example.test", queries: 1 }], dropped: 0, unrecorded: 0 } }));
    const merged: EvalDependencyList = mergeDependencyLists([a, b]);
    expect(merged.databases.map((d) => d.port).sort()).toEqual([5432, 6379]);
    expect(merged.hosts.map((host) => host.name).sort()).toEqual(["api.vendor.example.test", "other.example.test"]);
    expect(merged.ended).toBe("failed");
    expect(EvalDependencyListSchema.safeParse(merged).success).toBe(true);
  });
});

// ---- the sandbox's dry run

async function world(daemon = fakeEvalDaemon(), over: Partial<FreshEvalSandboxConfig> = {}) {
  const root = await temp("fes-dry-");
  const materialized: string[] = [];
  const config: FreshEvalSandboxConfig = {
    docker: daemon.docker, image: IMAGE, workspace: WS, taskId: "setup-op-1", roundBudgetMs: 600_000, repository: { directory: join(root, "repo"), baseCommit: MAIN, candidateCommit: MAIN },
    command: { executable: "node", args: ["eval.js"], cwd: "." }, report: REPORT, rowId: "gemini", scratchDir: join(root, "scratch"), workingSandbox: null, environment: OFFERED, sealedDns: true,
    materialize: async (_root, commit, destination) => { materialized.push(commit); await writeFile(join(destination, "eval.js"), `// ${commit}`); }, sleep: () => Promise.resolve(), ...over,
  };
  return { root, config, daemon, materialized, sandbox: () => createFreshEvalSandbox(config) };
}

describe("the free dry run in the sealed box", () => {

  it("positive control for the spy: a PAID run builds a bridge, and its helper is `real` over the bridge socket (mutant: flip the dry run's mode to real)", async () => {
    const daemon = fakeEvalDaemon();
    const w = await world(daemon, { sealedDns: false });
    // A Unix socket path is short on every platform: the bridge refuses a long one.
    const runDir = await mkdtemp("/tmp/fp-"); roots.push(runDir);
    const exec = createBridgedEvalExec({ sandbox: w.sandbox(), runDir, modelAllowed: () => true });
    const egress = { capabilities: {}, forward: async function* () { /* no call is made */ } } as never;
    await exec.run({ side: "new", ids: ["q1"], runs: 1, signal: new AbortController().signal, egress, scope: {} } as never).catch(() => undefined);
    expect(bridge.made).toBe(1);
    const helper = daemon.everStarted.find((container) => container.name.endsWith("-models"))!;
    const args = helper.args.slice(helper.args.indexOf("--listen"));
    expect(args[args.indexOf("--mode") + 1]).toBe("real");
    expect(args).toContain("--bridge-socket");
  });

  it("is given NO test services even when the config has a starter (a dry run must SEE what the eval needs), and reads the name server's record while it runs", async () => {
    const started: string[] = [];
    const starter: EvalServicesStarter = { start: async () => { started.push("start"); throw new Error("a dry run starts no service"); } };
    const daemon = fakeEvalDaemon({ dnsUnknown: ["vendor.example.test"], output: () => "ok" });
    const w = await world(daemon, { services: starter });
    const list = await runEvalDryRun({ sandbox: w.sandbox(), ids: ["q1"], signal: new AbortController().signal });
    expect(started).toEqual([]);
    expect(list?.hosts).toEqual([{ name: "vendor.example.test" }]);
    expect(daemon.everStarted.filter((container) => container.name.endsWith("-dns"))).toHaveLength(1);
  });

  it("a failed eval still lists what it reached; a run that cannot start gives NO list (never 'found nothing')", async () => {
    const failing = await world(fakeEvalDaemon({ exitCode: 1, output: () => "connect ECONNREFUSED 10.0.0.5:3306" }));
    expect((await runEvalDryRun({ sandbox: failing.sandbox(), ids: ["q1"], signal: new AbortController().signal }))?.databases).toEqual([{ port: 3306, engine: "mysql" }]);
    const broken = await world(fakeEvalDaemon({ failRun: (args) => args.some((arg) => arg.endsWith("-eval")) }));
    expect(await runEvalDryRun({ sandbox: broken.sandbox(), ids: ["q1"], signal: new AbortController().signal })).toBeUndefined();
    expect(broken.daemon.containers).toEqual([]);
    expect(broken.daemon.networks).toEqual([]);
  });

  it("leaves nothing behind: no container, no network, no scratch folder of the run; and a sandbox that is not offered (no walls) makes no Docker call at all", async () => {
    const daemon = fakeEvalDaemon({ output: () => "ok" });
    const w = await world(daemon);
    await runEvalDryRun({ sandbox: w.sandbox(), ids: ["q1"], signal: new AbortController().signal });
    expect(daemon.containers).toEqual([]);
    expect(daemon.networks).toEqual([]);
    expect(await readdir(w.config.scratchDir)).toEqual([]);
    const off = await world(fakeEvalDaemon(), { environment: {} });
    expect(await runEvalDryRun({ sandbox: off.sandbox(), ids: ["q1"], signal: new AbortController().signal })).toBeUndefined();
    expect(off.daemon.calls).toEqual([]);
  });
});

// ---- the setup run's own dry run

describe("the setup run's dry run over the drafted eval", () => {
  const command = { executable: "node", args: ["evals/run.js"], cwd: "." };
  const suite = (over: Record<string, unknown> = {}) => ({
    selection: "evals/demo", repository: "web", questions: [{ id: "q1", category: "ordinary", path: "evals/demo/q1.txt" }], command, report: REPORT, commandFingerprint: evalCommandFingerprintOf(command, REPORT),
    judge: { kind: "rule", scoringPath: "evals/demo/score.txt" }, subsetSupported: false, catalogRowId: "gemini", model: "gemini-2.5-flash", modelVersion: "gemini-2.5-flash-001", image: IMAGE, route: "gateway", maxCallsPerQuestion: 1, maxCostMicrosPerQuestion: 10, ...over,
  });
  const report = (...suites: object[]): SetupEvalDiscoveryReport => ({ schemaVersion: 1, suites }) as SetupEvalDiscoveryReport;
  const host = async (daemon = fakeEvalDaemon({ exitCode: 1, output: () => EVAL_OUTPUT, dnsUnknown: ["api.vendor.example.test"] }), over: Record<string, unknown> = {}) => {
    const root = await temp("fes-setup-");
    const made: FreshEvalSandboxConfig[] = [];
    return {
      daemon, made, root,
      host: {
        docker: daemon.docker, environment: OFFERED, taskId: "setup-op-1", workspaceKey: async () => WS, repositories: [{ name: "web", directory: join(root, "web") }], commits: [{ repository: "web", commit: MAIN }], servicesOff: true, scratchParent: root,
        make: (config: FreshEvalSandboxConfig) => { made.push(config); return createFreshEvalSandbox({ ...config, materialize: async (_r, _c, destination) => { await writeFile(join(destination, "eval.js"), "// main"); }, sleep: () => Promise.resolve() }); }, ...over,
      },
    };
  };

  it("with test services on the list does not say they are off; a suite in a repository the run did not read, or with no recorded commit, is skipped; with nothing run the answer is undefined", async () => {
    const on = await host(undefined, { servicesOff: false });
    expect((await runSetupEvalDryRun(on.host, report(suite())))?.servicesOff).toBeUndefined();
    const other = await host();
    expect(await runSetupEvalDryRun(other.host, report(suite({ repository: "other-repo" })))).toBeUndefined();
    const noCommit = await host(undefined, { commits: [{ repository: "web", commit: "not-a-sha" }] });
    expect(await runSetupEvalDryRun(noCommit.host, report(suite()))).toBeUndefined();
    expect(other.made).toEqual([]);
  });

  it("two suites are run one after the other and merged; an image that is not pinned, or no workspace, gives nothing and starts nothing", async () => {
    const h = await host();
    const list = await runSetupEvalDryRun(h.host, report(suite(), suite({ selection: "evals/other" })));
    expect(h.made).toHaveLength(2);
    expect(list?.hosts.filter((entry) => entry.name === "api.vendor.example.test")).toHaveLength(1);
    const unpinned = await host(undefined, { environment: { ...OFFERED, AGENTX_WORKER_IMAGE: "worker:latest" } });
    expect(await runSetupEvalDryRun(unpinned.host, report(suite()))).toBeUndefined();
    expect(unpinned.made).toEqual([]);
    const throwing = await host(undefined, { workspaceKey: async () => { throw new Error("no key"); } });
    expect(await runSetupEvalDryRun(throwing.host, report(suite()))).toBeUndefined();
  });

  it("the scratch folders of the suites are removed", async () => {
    const h = await host();
    await runSetupEvalDryRun(h.host, report(suite()));
    expect((await readdir(h.root)).filter((name) => name.startsWith("eval-dry-"))).toEqual([]);
    void mkdir;
    void EVAL_HELPER_DIR_NAME; void EVAL_BRIDGE_SOCKET_NAME;
  });
});
