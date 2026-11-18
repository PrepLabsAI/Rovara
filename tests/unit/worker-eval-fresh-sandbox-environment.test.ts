// L4-EVS (D3, stderr): the fresh eval sandbox with an environment. Nothing starts Docker: the same small stateful fake daemon as worker-eval-fresh-sandbox.test.ts, plus the install step (on the shared
// sandbox network), the capped log, the saved-image seam and the customer's own per-case report. What is proven here: the install runs BEFORE the round network exists and never with a model route; the
// sealed run is on the round network only and unchanged; a failed install or eval is a named, redacted, bounded diagnostic and never a half result; JUnit becomes the measures file.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { readMeasuresFile, savedEnvRepositoryName, type EvalEnvironment } from "@agentx/contracts";
import {
  EVAL_BRIDGE_SOCKET_NAME, EVAL_HELPER_DIR_NAME, FRESH_EVAL_WORKSPACE, createFreshEvalSandbox, freshEvalEnvironment, freshEvalSandboxArgProblems,
  type FreshEvalSandboxConfig, type FreshEvalSandboxRun,
} from "../../packages/worker/src/verification/eval-bridged-exec.js";
import { EvalSandboxRunFailure, runFailureOf } from "../../packages/worker/src/verification/eval-run-diagnostic.js";
import { RUN_NETWORK_LABEL } from "../../packages/worker/src/run-network.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

const WS = "0123456789abcdef";
const IMAGE = `rovara/worker@sha256:${"c".repeat(64)}`;
const BASE = "b".repeat(40);
const CANDIDATE = "d".repeat(40);
// Built at run time: the public repository refuses key-shaped literals.
const TOKEN = ["Zk3pQ9vL2m", "Xa7TnR5wYc8", "UdB4hGe6JfS"].join("");
const FACTS = JSON.stringify({ metadataBlocked: true, runWalls: true, ipv6Drops: true, prepull: "off", prepulled: 0, loggedOut: true, dockerVersion: "27.3.1" });
const OFFERED: NodeJS.ProcessEnv = { AGENTX_TEST_SERVICES_BOOT_FACTS: FACTS };
const REPORT = { cwd: ".", argument: "eval-report.json" };
const REPORT_BYTES = JSON.stringify({ measures: { version: 1 } });
const MODEL_KEY = ["rovara", "test", "key"].join("-");

interface Container { log?: string; id: string; name: string; labels: Record<string, string>; network: string; ip: string; args: string[]; mounts: { Source: string; Destination: string; RW: boolean; Type: string }[]; paused: boolean; exit?: number }
interface Play { readonly code: number | "hang" | "timeout"; readonly log?: string; readonly files?: Readonly<Record<string, string>> }
interface DaemonOptions {
  /** What an install step or the eval does when waited on (kind, the checkout, the container's own arguments, which one of its kind this is). Default: the install exits 0; the eval writes the report. */
  readonly play?: (kind: "install" | "eval", checkout: string, args: readonly string[], index: number) => Promise<Play>;
  readonly pauseIgnored?: boolean;
  readonly unpauseIgnored?: boolean;
  readonly extraSandboxMount?: (bridgeDir: string) => { Source: string; Destination: string; RW: boolean; Type: string };
  readonly helperMountRw?: boolean;
  readonly failRun?: (args: readonly string[]) => boolean;
}

function fakeDaemon(options: DaemonOptions = {}) {
  const networks: { name: string; labels: Record<string, string> }[] = [{ name: "agentx-task", labels: {} }];
  const plays = { install: 0, eval: 0 };
  const order: string[] = [];
  const containers: Container[] = [];
  const working: Container = { id: "w1", name: "agentx-task-1", labels: {}, network: "agentx-task", ip: "", args: [], mounts: [], paused: false };
  const calls: string[][] = [];
  const envSeen: string[] = [];
  const waiters: Array<() => void> = [];
  let ids = 0;
  const values = (args: readonly string[], flag: string) => args.flatMap((arg, index) => (args[index - 1] === flag ? [arg] : []));
  const labelsOf = (args: readonly string[]) => Object.fromEntries(values(args, "--label").map((arg) => arg.split(/=(.*)/su).slice(0, 2) as [string, string]));
  const ok = (stdout = "") => Promise.resolve({ exitCode: 0, stdout, stderr: "" });
  const fail = (stderr = "error") => Promise.resolve({ exitCode: 1, stdout: "", stderr });
  const find = (name: string) => (name === working.name ? working : containers.find((c) => c.name === name || c.id === name));
  const docker: DockerCli = {
    async run(args) {
      calls.push([...args]);
      const [a, b] = args;
      if (a === "network" && b === "create") { order.push("network:create"); const name = args.at(-1)!; if (networks.some((n) => n.name === name)) return fail(); networks.push({ name, labels: labelsOf(args) }); return ok(); }
      if (a === "network" && b === "ls") return ok("");
      if (a === "network" && b === "inspect") return fail("No such network");
      if (a === "network" && b === "rm") { const index = networks.findIndex((n) => n.name === args[2]); if (index < 0) return fail("No such network"); if (containers.some((c) => c.network === networks[index]!.name)) return fail("active endpoints"); networks.splice(index, 1); return ok(); }
      if (a === "run") {
        order.push(`run:${values(args, "--name")[0]!.includes("-install-") ? "install" : values(args, "--name")[0]!.endsWith("-eval") ? "eval" : "helper"}`);
        if (options.failRun?.(args) === true) return fail("run failed");
        const name = values(args, "--name")[0]!;
        const network = values(args, "--network")[0]!;
        if (!networks.some((n) => n.name === network)) return fail("no network");
        const mounts = [
          ...values(args, "--volume").map((v) => { const [Source, Destination, mode] = v.split(":"); return { Source: Source!, Destination: Destination!, RW: mode !== "ro", Type: "bind" }; }),
          ...values(args, "--tmpfs").map((v) => ({ Source: "", Destination: v.split(":")[0]!, RW: true, Type: "tmpfs" })),
        ];
        const envFile = values(args, "--env-file")[0];
        if (envFile !== undefined) envSeen.push(readFileSync(envFile, "utf8"));
        const container: Container = { id: `c${String(++ids)}`, name, labels: labelsOf(args), network, ip: values(args, "--ip")[0] ?? "", args: [...args], mounts, paused: false };
        if (name.endsWith("-models") && options.helperMountRw === true) container.mounts = container.mounts.map((m) => (m.Type === "bind" ? { ...m, RW: true } : m));
        if (name.endsWith("-eval") && options.extraSandboxMount !== undefined) {
          const helper = containers.find((c) => c.name.endsWith("-models"))!;
          container.mounts.push(options.extraSandboxMount(helper.mounts[0]!.Source));
        }
        containers.push(container);
        return ok(container.id);
      }
      if (a === "inspect") {
        const container = find(args.at(-1)!);
        if (container === undefined) return fail("No such object");
        const template = values(args, "--format")[0] ?? "";
        if (template.includes("{{.State.Running}}")) return ok(`true|${JSON.stringify({ [container.network]: { IPAddress: container.ip } })}`);
        if (template.includes("{{json .Mounts}}")) return ok(JSON.stringify(container.mounts));
        if (template.includes("{{.State.Paused}}")) return ok(String(container.paused));
        return ok(JSON.stringify({ [container.network]: { IPAddress: container.ip } }));
      }
      if (a === "kill") { order.push("kill"); return ok(); }
      if (a === "pause") { const c = find(args[1]!); if (c === undefined) return fail(); if (options.pauseIgnored !== true) c.paused = true; return ok(); }
      if (a === "unpause") { const c = find(args[1]!); if (c === undefined) return fail(); if (options.unpauseIgnored !== true) c.paused = false; return ok(); }
      if (a === "wait") {
        const container = find(args[1]!);
        if (container === undefined) return fail("No such container");
        const checkout = container.mounts.find((m) => m.Destination === FRESH_EVAL_WORKSPACE)!.Source;
        const kind = container.name.includes("-install-") ? "install" as const : "eval" as const;
        order.push(`wait:${kind}`);
        const defaultPlay = async (k: "install" | "eval"): Promise<Play> => { if (k === "eval") await writeFile(join(checkout, REPORT.argument), REPORT_BYTES); return { code: 0 }; };
        const play: Play = await (options.play ?? defaultPlay)(kind, checkout, container.args, plays[kind]++);
        for (const [path, text] of Object.entries(play.files ?? {})) { await mkdir(join(checkout, path, ".."), { recursive: true }); await writeFile(join(checkout, path), text); }
        if (play.log !== undefined) container.log = play.log;
        if (play.code === "timeout") return Promise.resolve({ exitCode: null, stdout: "", stderr: "", timedOut: true });
        if (play.code === "hang") {
          await new Promise<void>((resolve) => { waiters.push(resolve); });
          return find(args[1]!) === undefined ? fail("No such container") : ok("137");
        }
        return ok(String(play.code));
      }
      if (a === "logs") { const container = find(args.at(-1)!); return container === undefined ? fail("No such container") : Promise.resolve({ exitCode: 0, stdout: "", stderr: container.log ?? "" }); }
      if (a === "ps") {
        const filter = values(args, "--filter").find((f) => f.startsWith(`label=${RUN_NETWORK_LABEL}=`));
        const wanted = filter?.split("=")[2];
        const template = values(args, "--format")[0] ?? "{{.ID}}";
        return ok(containers.filter((c) => wanted === undefined || c.labels[RUN_NETWORK_LABEL] === wanted)
          .map((c) => template.replace(/\{\{\.ID\}\}/gu, c.id).replace(/\{\{\.Label "([^"]+)"\}\}/gu, (_all, key: string) => c.labels[key] ?? "")).join("\n"));
      }
      if (a === "rm") {
        for (const target of args.slice(1).filter((arg) => !arg.startsWith("-"))) { const index = containers.findIndex((c) => c.id === target || c.name === target); if (index >= 0) containers.splice(index, 1); }
        waiters.splice(0).forEach((wake) => wake());
        return ok();
      }
      return ok();
    },
  };
  return { docker, networks, containers, working, calls, envSeen, order };
}
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function world(daemon = fakeDaemon(), over: Partial<FreshEvalSandboxConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), "fes-")); roots.push(root);
  const bridgeDir = join(root, "e1", EVAL_HELPER_DIR_NAME);
  await mkdir(bridgeDir, { recursive: true, mode: 0o700 });
  const materialized: { commit: string; destination: string; workingPaused: boolean }[] = [];
  const config: FreshEvalSandboxConfig = {
    docker: daemon.docker, image: IMAGE, workspace: WS, taskId: "op-1", roundBudgetMs: 600_000, repository: { directory: join(root, "repo"), baseCommit: BASE, candidateCommit: CANDIDATE },
    command: { executable: "node", args: ["eval.js"], cwd: "." }, report: REPORT, rowId: "gemini", scratchDir: join(root, "scratch"), workingSandbox: daemon.working.name, environment: OFFERED,
    materialize: async (_root, commit, destination) => { materialized.push({ commit, destination, workingPaused: daemon.working.paused }); await writeFile(join(destination, "eval.js"), `// ${commit}`); },
    sleep: () => Promise.resolve(), ...over,
  };
  const input = (o: Partial<FreshEvalSandboxRun> = {}): FreshEvalSandboxRun => ({ side: "new", ids: ["q1", "q2"], runs: 1, signal: new AbortController().signal, model: { socketPath: join(bridgeDir, EVAL_BRIDGE_SOCKET_NAME), token: TOKEN }, ...o });
  return { root, bridgeDir, config, sandbox: createFreshEvalSandbox(config), input, materialized, daemon };
}
const runArgsOf = (calls: string[][], suffix: string) => calls.find((c) => c[0] === "run" && (c[c.indexOf("--name") + 1] ?? "").endsWith(suffix));
const installArgsOf = (calls: string[][]) => calls.filter((c) => c[0] === "run" && (c[c.indexOf("--name") + 1] ?? "").includes("-install-"));
const flag = (args: readonly string[], name: string): string[] => args.flatMap((arg, index) => (args[index - 1] === name ? [arg] : []));
const PIP: EvalEnvironment = { kind: "install", commands: [{ executable: "python3", args: ["-m", "pip", "install", "-r", "requirements.txt"], cwd: "." }] };
const junit = (cases: Array<[string, boolean]>): string => `<testsuites><testsuite name="pytest">${cases.map(([name, pass]) => (pass ? `<testcase name="${name}"/>` : `<testcase name="${name}"><failure message="x"/></testcase>`)).join("")}</testsuite></testsuites>`;
const roundNetworks = (daemon: ReturnType<typeof fakeDaemon>) => daemon.networks.filter((n) => n.name !== "agentx-task");

describe("no environment: today's run, byte for byte", () => {
  it("runs no install, makes no extra variable, and starts the helper and the eval as before", async () => {
    const w = await world();
    await w.sandbox.run(w.input());
    expect(w.daemon.order.filter((step) => step.endsWith("install"))).toEqual([]);
    expect(w.daemon.envSeen).toEqual([freshEvalEnvironment({ rowId: "gemini", token: TOKEN, side: "new", runs: 1, ids: ["q1", "q2"] })]);
    expect(w.daemon.envSeen[0]).not.toContain("PYTHONUSERBASE");
    expect(w.daemon.calls.some((c) => c[0] === "logs")).toBe(true);
  });
});

describe("install steps", () => {
  it("run BEFORE the round network exists, on the shared sandbox network with no model route and no token, then the sealed run is on the round network only", async () => {
    const seen: { network: string[]; checkoutHadInstall: boolean[] } = { network: [], checkoutHadInstall: [] };
    const daemon = fakeDaemon({ play: async (kind, checkout) => {
      if (kind === "install") return { code: 0, files: { ".venv/lib/site-packages/yaml.py": "# yaml" } };
      seen.checkoutHadInstall.push(existsSync(join(checkout, ".venv/lib/site-packages/yaml.py")));
      await writeFile(join(checkout, REPORT.argument), REPORT_BYTES);
      return { code: 0 };
    } });
    const w = await world(daemon, { evalEnvironment: PIP });
    await w.sandbox.run(w.input());
    const order = w.daemon.order;
    expect(order.indexOf("run:install")).toBeLessThan(order.indexOf("wait:install"));
    expect(order.indexOf("wait:install")).toBeLessThan(order.indexOf("network:create"));
    expect(order.indexOf("network:create")).toBeLessThan(order.indexOf("run:helper"));
    expect(order.indexOf("run:helper")).toBeLessThan(order.indexOf("run:eval"));
    const [install] = installArgsOf(w.daemon.calls);
    expect(flag(install!, "--network")).toEqual(["agentx-task"]);
    expect(install).not.toContain("--env-file");
    expect(install).not.toContain("--ip");
    expect(install!.join(" ")).not.toContain(TOKEN);
    expect(install!.join(" ")).not.toContain(w.bridgeDir);
    expect(flag(install!, "--add-host").every((host) => host.endsWith(":10.255.255.1"))).toBe(true);
    // The sealed run: the round network ONLY, the helper's address for model names, and the arguments the allow-list accepts, as before.
    const sealed = runArgsOf(w.daemon.calls, "-eval")!;
    expect(flag(sealed, "--network")).toHaveLength(1);
    expect(flag(sealed, "--network")[0]).not.toBe("agentx-task");
    expect(flag(sealed, "--dns")).toEqual(["127.0.0.1"]);
    expect(sealed).not.toContain("--publish");
    expect(flag(sealed, "--add-host").every((host) => !host.endsWith(":10.255.255.1"))).toBe(true);
    // The install's files are in the checkout the sealed run mounts; its variables tell the run where a --user install lives.
    expect(seen.checkoutHadInstall).toEqual([true]);
    expect(w.daemon.envSeen[0]).toContain("PYTHONUSERBASE=/workspace/.rovara-python");
    // Gone: the install box, the helper, the network.
    expect(w.daemon.containers).toEqual([]);
    expect(roundNetworks(w.daemon)).toEqual([]);
  });

  it("carry the task sandbox labels (the worker's own leftover sweep finds a box a crash left) and are removed even when the run fails later", async () => {
    const daemon = fakeDaemon({ play: async (kind) => (kind === "install" ? { code: 0 } : { code: 1, log: "boom" }) });
    const w = await world(daemon, { evalEnvironment: PIP });
    await expect(w.sandbox.run(w.input())).rejects.toBeInstanceOf(EvalSandboxRunFailure);
    const [install] = installArgsOf(w.daemon.calls);
    expect(flag(install!, "--label").map((label) => label.split("=")[0]!).sort()).toEqual(["agentx.task", "agentx.workspace"]);
    expect(w.daemon.containers).toEqual([]);
  });

  it("a failed install step stops the run before the helper or the round network: a named, redacted diagnostic, and nothing left behind", async () => {
    const daemon = fakeDaemon({ play: async (kind) => (kind === "install" ? { code: 2, log: `ERROR: No matching distribution found for pyyaml\nusing token ${TOKEN} and key ${MODEL_KEY}` } : { code: 0 }) });
    const w = await world(daemon, { evalEnvironment: PIP });
    const error = await w.sandbox.run(w.input({ side: "old" })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EvalSandboxRunFailure);
    const diagnostic = runFailureOf(error)!;
    expect(diagnostic).toMatchObject({ code: "install_failed", phase: "install", exitCode: 2 });
    expect(diagnostic.tail).toContain("No matching distribution");
    expect(diagnostic.tail).not.toContain(TOKEN);
    expect(diagnostic.tail).not.toContain(MODEL_KEY);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(w.daemon.order).not.toContain("run:helper");
    expect(w.daemon.order).not.toContain("run:eval");
    expect(w.daemon.containers).toEqual([]);
    expect(roundNetworks(w.daemon)).toEqual([]);
    expect(w.daemon.working.paused).toBe(false);
  });

  it("L4-TH1: a sealed eval that tried to reach a database and an outside host is named; a model host the sandbox pinned to the helper is not", async () => {
    const log = ["Error: getaddrinfo ENOTFOUND api.openai.com", "Error: connect ECONNREFUSED 172.30.1.7:5432", "Error: getaddrinfo ENOTFOUND api.stripe.com"].join("\n");
    const w = await world(fakeDaemon({ play: async (kind) => (kind === "install" ? { code: 0 } : { code: 1, log }) }));
    const diagnostic = runFailureOf(await w.sandbox.run(w.input({ side: "old" })).catch((e: unknown) => e))!;
    expect(diagnostic).toMatchObject({ code: "blocked_connection", phase: "run", exitCode: 1, blocked: { items: [{ kind: "database", port: 5432 }, { kind: "service", host: "api.stripe.com" }] } });
    const only = await world(fakeDaemon({ play: async (kind) => (kind === "install" ? { code: 0 } : { code: 1, log: "Error: getaddrinfo ENOTFOUND api.openai.com" }) }));
    expect(runFailureOf(await only.sandbox.run(only.input({ side: "old" })).catch((e: unknown) => e))).toMatchObject({ code: "exited" });
  });

  it("an install that ran out of time, or a box that did not start, is its own named failure", async () => {
    const timedOut = fakeDaemon({ play: async (kind) => (kind === "install" ? { code: "timeout" } : { code: 0 }) });
    const a = await world(timedOut, { evalEnvironment: PIP });
    expect(runFailureOf(await a.sandbox.run(a.input()).catch((e: unknown) => e))).toMatchObject({ code: "install_timed_out", phase: "install" });
    const noStart = fakeDaemon({ failRun: (args) => (args[args.indexOf("--name") + 1] ?? "").includes("-install-") });
    const b = await world(noStart, { evalEnvironment: PIP });
    expect(runFailureOf(await b.sandbox.run(b.input()).catch((e: unknown) => e))).toMatchObject({ code: "install_failed", phase: "install" });
    expect(b.daemon.containers).toEqual([]);
  });

  it("run in order, each in the command's own folder; the second does not start if the first failed", async () => {
    const env: EvalEnvironment = { kind: "install", commands: [{ executable: "npm", args: ["ci"], cwd: "web" }, { executable: "pip", args: ["install", "-r", "r.txt"], cwd: "." }] };
    const ok = await world(fakeDaemon(), { evalEnvironment: env });
    await ok.sandbox.run(ok.input());
    expect(installArgsOf(ok.daemon.calls).map((args) => flag(args, "--workdir")[0])).toEqual(["/workspace/web", "/workspace"]);
    const failing = await world(fakeDaemon({ play: async (kind) => (kind === "install" ? { code: 1 } : { code: 0 }) }), { evalEnvironment: env });
    await failing.sandbox.run(failing.input()).catch(() => undefined);
    expect(installArgsOf(failing.daemon.calls)).toHaveLength(1);
  });
});

describe("the saved environment", () => {
  const repository = savedEnvRepositoryName({ env: "staging", orgId: "company-a", projectId: "project-a" });
  const saved = (fallbackInstall?: Extract<EvalEnvironment, { kind: "install" }>["commands"]): EvalEnvironment => ({
    kind: "saved", repository, digest: `sha256:${"a".repeat(64)}`, environmentKey: "b".repeat(64), testEnvRevision: 2, directory: "app",
    login: { registry: "123456789012.dkr.ecr.us-west-2.amazonaws.com", repository, username: "AWS", password: ["pw", "y".repeat(24)].join("-"), expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
    ...(fallbackInstall === undefined ? {} : { fallbackInstall }),
  });

  it("is used when it works: no install runs, and the seam got this environment and the checkout the commit was written to", async () => {
    const calls: Array<{ kind: string; checkout: string; hadCommitFile: boolean }> = [];
    const w = await world(fakeDaemon(), { evalEnvironment: saved(PIP.kind === "install" ? PIP.commands : []), useSavedEnvironment: async ({ environment, checkout }) => { calls.push({ kind: environment.kind, checkout, hadCommitFile: existsSync(join(checkout, "eval.js")) }); return true; } });
    await w.sandbox.run(w.input());
    expect(calls).toEqual([{ kind: "saved", checkout: w.materialized[0]!.destination, hadCommitFile: true }]);
    expect(installArgsOf(w.daemon.calls)).toEqual([]);
    expect(w.daemon.envSeen[0]).toContain("PYTHONUSERBASE=");
  });

  it("falls back to the plan's install steps when it cannot be used, and to the bare image when there are none; it never blocks the eval", async () => {
    const failing = async () => false;
    const withFallback = await world(fakeDaemon(), { evalEnvironment: saved(PIP.kind === "install" ? PIP.commands : []), useSavedEnvironment: failing });
    await withFallback.sandbox.run(withFallback.input());
    expect(installArgsOf(withFallback.daemon.calls)).toHaveLength(1);
    const bare = await world(fakeDaemon(), { evalEnvironment: saved(), useSavedEnvironment: failing });
    await bare.sandbox.run(bare.input());
    expect(installArgsOf(bare.daemon.calls)).toEqual([]);
    expect(bare.daemon.order).toContain("run:eval");
  });

  it("an environment that is not whole makes the sandbox unavailable (the plan's word is checked at runtime)", async () => {
    const w = await world(fakeDaemon());
    for (const bad of [{ kind: "install", commands: [] }, { kind: "saved" }, { kind: "x" }]) expect(createFreshEvalSandbox({ ...w.config, evalEnvironment: bad as never }).available()).toBe(false);
    expect(createFreshEvalSandbox({ ...w.config, installNetwork: "bad net" }).available()).toBe(false);
  });
});

describe("a failed eval is named, redacted and bounded (stderr for Not run)", () => {
  it("a missing package: the cause, the one name and the redacted tail; the token and key never show; nothing is left", async () => {
    const log = ["Traceback (most recent call last):", `  File "evals/run.py", line 3`, `    client = connect("http://rovara-models:8080/p/gemini/x/${TOKEN}", key="${MODEL_KEY}")`, "ModuleNotFoundError: No module named 'yaml'"].join("\n");
    const w = await world(fakeDaemon({ play: async () => ({ code: 1, log }) }));
    const error = await w.sandbox.run(w.input()).catch((e: unknown) => e);
    const diagnostic = runFailureOf(error)!;
    expect(diagnostic).toMatchObject({ code: "missing_package", phase: "run", name: "yaml", exitCode: 1 });
    expect(diagnostic.tail).toContain("No module named 'yaml'");
    expect(diagnostic.tail).not.toContain(TOKEN);
    expect(diagnostic.tail).not.toContain(MODEL_KEY);
    expect(diagnostic.tail.length).toBeLessThanOrEqual(4096);
    expect(w.daemon.containers).toEqual([]);
    expect(roundNetworks(w.daemon)).toEqual([]);
  });

  it("an eval that exits 0 without a report, or exits non-zero WITH a report (its own gate failed), is not a failed run: as before", async () => {
    const quiet = await world(fakeDaemon({ play: async () => ({ code: 0 }) }));
    const quietResult = await quiet.sandbox.run(quiet.input());
    expect(existsSync(join(quietResult.report.root, REPORT.argument))).toBe(false);
    const gate = await world(fakeDaemon({ play: async (_k, checkout) => { await writeFile(join(checkout, REPORT.argument), REPORT_BYTES); return { code: 1, log: "gate failed: 80% < 90%" }; } }));
    const gateResult = await gate.sandbox.run(gate.input());
    expect(await readFile(join(gateResult.report.root, REPORT.argument), "utf8")).toBe(REPORT_BYTES);
  });

  it("a run that ran out of time is a failure whatever it wrote", async () => {
    const w = await world(fakeDaemon({ play: async (_k, checkout) => { await writeFile(join(checkout, REPORT.argument), REPORT_BYTES); return { code: "timeout" }; } }));
    expect(runFailureOf(await w.sandbox.run(w.input()).catch((e: unknown) => e))).toMatchObject({ code: "run_timed_out", phase: "run" });
    expect(w.daemon.containers).toEqual([]);
  });

  it("asks only for the log tail (a bounded number of lines) after the wait, and the log is read before the box is removed", async () => {
    const w = await world(fakeDaemon({ play: async () => ({ code: 1, log: "x" }) }));
    await w.sandbox.run(w.input()).catch(() => undefined);
    const logs = w.daemon.calls.filter((c) => c[0] === "logs");
    expect(logs).toHaveLength(1);
    expect(logs[0]!.slice(0, 3)).toEqual(["logs", "--tail", "200"]);
    const names = w.daemon.calls.map((c) => c[0]);
    expect(names.indexOf("logs")).toBeGreaterThan(names.indexOf("wait"));
  });
});

describe("the customer's own per-case report (JUnit)", () => {
  const plays = (runs: Array<Array<[string, boolean]> | undefined>) => fakeDaemon({ play: async (kind, checkout, _args, index) => {
    if (kind === "install") return { code: 0 };
    const rows = runs[index];
    if (rows !== undefined) await writeFile(join(checkout, REPORT.argument), junit(rows));
    return { code: 0 };
  } });

  it("runs the command once per run, and turns the reports into the measures file (one sample per run, in order); the first run is told `runs`, the others one", async () => {
    const daemon = plays([[["a", true], ["b", false]], [["a", false], ["b", false]], [["a", true], ["b", true]]]);
    const w = await world(daemon);
    const result = await w.sandbox.run(w.input({ ids: ["a", "b"], runs: 3 }));
    expect(w.daemon.envSeen.map((env) => /ROVARA_EVAL_RUNS=(\d)/u.exec(env)![1])).toEqual(["3", "1", "1"]);
    const read = readMeasuresFile(JSON.parse(await readFile(join(result.report.root, REPORT.argument), "utf8")));
    expect(read.status).toBe("ok");
    if (read.status === "ok") expect(read.file.questions!.map((q) => [q.id, q.samples.map((s) => s.pass)])).toEqual([["a", [true, false, true]], ["b", [false, false, true]]]);
    expect(w.daemon.containers).toEqual([]);
  });

  it("a later run that writes nothing leaves NO report (never a half result, never an old file read as fresh)", async () => {
    const w = await world(plays([[["a", true]], [["a", true]], undefined]));
    const result = await w.sandbox.run(w.input({ ids: ["a"], runs: 3 }));
    expect(existsSync(join(result.report.root, REPORT.argument))).toBe(false);
  });

  it("a later run that fails with no report is a named failure; a one-run report works without a second run", async () => {
    const failing = await world(fakeDaemon({ play: async (kind, checkout, _a, index) => {
      if (kind === "eval" && index === 0) { await writeFile(join(checkout, REPORT.argument), junit([["a", true]])); return { code: 0 }; }
      return { code: 3, log: "ModuleNotFoundError: No module named 'torch'" };
    } }));
    expect(runFailureOf(await failing.sandbox.run(failing.input({ ids: ["a"], runs: 2 })).catch((e: unknown) => e))).toMatchObject({ code: "missing_package", name: "torch" });
    const single = await world(plays([[["a", false]]]));
    const result = await single.sandbox.run(single.input({ ids: ["a"], runs: 1 }));
    expect(single.daemon.order.filter((step) => step === "run:eval")).toHaveLength(1);
    expect(existsSync(join(result.report.root, REPORT.argument))).toBe(true);
  });

  it("Rovara's own measures file is copied as it is, with one run of the command (the command loops itself)", async () => {
    const measures = JSON.stringify({ schemaVersion: 1, source: "project_runner", measures: [{ name: "m", unit: "u", direction: "up_good", value: 1 }], questions: [{ id: "a", samples: [{ pass: true, answer: "x" }, { pass: true, answer: "y" }, { pass: false, answer: "z" }] }] });
    const w = await world(fakeDaemon({ play: async (kind, checkout) => { if (kind === "eval") await writeFile(join(checkout, REPORT.argument), measures); return { code: 0 }; } }));
    const result = await w.sandbox.run(w.input({ ids: ["a"], runs: 3 }));
    expect(w.daemon.order.filter((step) => step === "run:eval")).toHaveLength(1);
    expect(await readFile(join(result.report.root, REPORT.argument), "utf8")).toBe(measures);
  });
});

describe("the sealed run's arguments (L4-EVS: the capped log)", () => {
  it("pass the allow-list as built, and name a log option that is missing, extra or different", async () => {
    const w = await world(fakeDaemon());
    await w.sandbox.run(w.input());
    const sealed = runArgsOf(w.daemon.calls, "-eval")!;
    const net = { name: flag(sealed, "--network")[0]!, checkSandboxIp: flag(sealed, "--ip")[0]! };
    const expected = { checkout: flag(sealed, "--volume")[0]!.split(":")[0]!, bridgeDir: w.bridgeDir, helperIp: flag(sealed, "--add-host")[0]!.split(":").at(-1)! };
    expect(freshEvalSandboxArgProblems(sealed, net, expected)).toEqual([]);
    const without = sealed.flatMap((arg, index) => (arg === "--log-opt" || sealed[index - 1] === "--log-opt" ? [] : [arg]));
    expect(freshEvalSandboxArgProblems(without, net, expected)).not.toEqual([]);
    const swapped = sealed.map((arg) => (arg === "max-size=64k" ? "max-size=64m" : arg));
    expect(freshEvalSandboxArgProblems(swapped, net, expected)).not.toEqual([]);
    const extra = [...sealed.slice(0, sealed.indexOf("--tmpfs")), "--log-opt", "labels=x", ...sealed.slice(sealed.indexOf("--tmpfs"))];
    expect(freshEvalSandboxArgProblems(extra, net, expected)).not.toEqual([]);
    expect(RUN_NETWORK_LABEL).toBeTruthy();
    void FRESH_EVAL_WORKSPACE;
  });
});

describe("a run past its deadline, and a stop (REVIEW-1 findings 2, 3, 7)", () => {
  it("a sealed run that ran out of time is KILLED before its log is read", async () => {
    const w = await world(fakeDaemon({ play: async () => ({ code: "timeout", log: "slow" }) }));
    await w.sandbox.run(w.input()).catch(() => undefined);
    const names = w.daemon.calls.map((c) => c[0]);
    expect(names.indexOf("kill")).toBeGreaterThan(-1);
    expect(names.indexOf("kill")).toBeLessThan(names.indexOf("logs"));
  });

  it("an install step that ran out of time is killed before its log is read", async () => {
    const w = await world(fakeDaemon({ play: async (kind) => (kind === "install" ? { code: "timeout" } : { code: 0 }) }), { evalEnvironment: PIP });
    await w.sandbox.run(w.input()).catch(() => undefined);
    const names = w.daemon.calls.map((c) => c[0]);
    expect(names.indexOf("kill")).toBeLessThan(names.indexOf("logs"));
  });

  it("a stop while an install step runs removes that box at once and rejects only after everything is gone", async () => {
    const controller = new AbortController();
    const daemon = fakeDaemon({ play: async (kind) => { if (kind === "install") { setTimeout(() => controller.abort(), 30); return { code: "hang" }; } return { code: 0 }; } });
    const w = await world(daemon, { evalEnvironment: PIP });
    await expect(w.sandbox.run(w.input({ signal: controller.signal }))).rejects.toThrow();
    expect(w.daemon.containers).toEqual([]);
    expect(w.daemon.order).not.toContain("run:helper");
  });

  it("a plan with no install step gives the sealed run the whole round budget, as before; one with an install step shares the one deadline", async () => {
    const waits: number[] = [];
    const base = fakeDaemon();
    const spy: DockerCli = { run: async (args, options) => { if (args[0] === "wait") waits.push(options?.timeoutMs ?? -1); return base.docker.run(args, options); } };
    const plain = await world({ ...base, docker: spy });
    await plain.sandbox.run(plain.input());
    expect(waits).toEqual([600_000]);
    waits.length = 0;
    const base2 = fakeDaemon();
    const spy2: DockerCli = { run: async (args, options) => { if (args[0] === "wait") waits.push(options?.timeoutMs ?? -1); return base2.docker.run(args, options); } };
    const withInstall = await world({ ...base2, docker: spy2 }, { evalEnvironment: PIP });
    await withInstall.sandbox.run(withInstall.input());
    expect(waits).toHaveLength(2);
    expect(waits[1]!).toBeLessThanOrEqual(600_000);
  });
});
