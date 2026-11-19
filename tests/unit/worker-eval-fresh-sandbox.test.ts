// TE-B1: the fresh eval check sandbox (`createFreshEvalSandbox`). Nothing starts Docker: a small stateful fake daemon answers the commands the module uses (network create/rm/ls/inspect, run, inspect, wait, pause, unpause,
// ps, rm), keeps each container's mounts from its own arguments, and plays the eval (it writes the report into the mounted checkout when the sandbox is waited on). The Linux proofs (TS-L1..L3, docker inspect of the mounts)
// are tests/linux/eval-fresh-sandbox.test.ts, run by CI's linux-runtime job.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isEvalBaseAttestation } from "@agentx/contracts";
import {
  EVAL_BRIDGE_SOCKET_NAME, EVAL_HELPER_DIR_NAME, FRESH_EVAL_IDS_VARIABLE, FRESH_EVAL_WORKSPACE, bridgeFolderMountProblems, createFreshEvalSandbox, freshEvalEnvironment, freshEvalSandboxArgProblems, freshEvalSandboxRunArgs,
  type FreshEvalSandboxConfig, type FreshEvalSandboxRun,
} from "../../packages/worker/src/verification/eval-bridged-exec.js";
import { MODEL_HELPER_BRIDGE_SOCKET } from "../../packages/worker/src/model-helper-bridge-backend.js";
import { planModelHostBlock } from "../../packages/worker/src/model-helper-block.js";
import { RUN_NETWORK_LABEL, runNetworkAddresses, runNetworkModelHelperIp } from "../../packages/worker/src/run-network.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

const WS = "0123456789abcdef";
const IMAGE = `rovara/worker@sha256:${"c".repeat(64)}`;
const BASE = "b".repeat(40);
const CANDIDATE = "d".repeat(40);
const TOKEN = "A".repeat(32);
const FACTS = JSON.stringify({ metadataBlocked: true, runWalls: true, ipv6Drops: true, prepull: "off", prepulled: 0, loggedOut: true, dockerVersion: "27.3.1" });
const OFFERED: NodeJS.ProcessEnv = { AGENTX_TEST_SERVICES_BOOT_FACTS: FACTS };
const REPORT = { cwd: ".", argument: "eval-report.json" };
const REPORT_BYTES = JSON.stringify({ measures: { version: 1 } });

interface Container { id: string; name: string; labels: Record<string, string>; network: string; ip: string; args: string[]; mounts: { Source: string; Destination: string; RW: boolean; Type: string }[]; paused: boolean; exit?: number }
interface DaemonOptions {
  /** What the eval does when the sandbox is waited on (default: writes the report into the checkout and exits 0). */
  readonly eval?: (checkout: string, env: string) => Promise<number | "hang">;
  readonly pauseIgnored?: boolean;
  readonly unpauseIgnored?: boolean;
  readonly extraSandboxMount?: (bridgeDir: string) => { Source: string; Destination: string; RW: boolean; Type: string };
  readonly helperMountRw?: boolean;
  readonly failRun?: (args: readonly string[]) => boolean;
}

function fakeDaemon(options: DaemonOptions = {}) {
  const networks: { name: string; labels: Record<string, string> }[] = [];
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
      if (a === "network" && b === "create") { const name = args.at(-1)!; if (networks.some((n) => n.name === name)) return fail(); networks.push({ name, labels: labelsOf(args) }); return ok(); }
      if (a === "network" && b === "ls") return ok("");
      if (a === "network" && b === "inspect") return fail("No such network");
      if (a === "network" && b === "rm") { const index = networks.findIndex((n) => n.name === args[2]); if (index < 0) return fail("No such network"); if (containers.some((c) => c.network === networks[index]!.name)) return fail("active endpoints"); networks.splice(index, 1); return ok(); }
      if (a === "run") {
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
      if (a === "pause") { const c = find(args[1]!); if (c === undefined) return fail(); if (options.pauseIgnored !== true) c.paused = true; return ok(); }
      if (a === "unpause") { const c = find(args[1]!); if (c === undefined) return fail(); if (options.unpauseIgnored !== true) c.paused = false; return ok(); }
      if (a === "wait") {
        const container = find(args[1]!);
        if (container === undefined) return fail("No such container");
        const checkout = container.mounts.find((m) => m.Destination === FRESH_EVAL_WORKSPACE)!.Source;
        const code = await (options.eval ?? (async (dir: string) => { await writeFile(join(dir, REPORT.argument), REPORT_BYTES); return 0; }))(checkout, envSeen.at(-1) ?? "");
        if (code === "hang") {
          await new Promise<void>((resolve) => { waiters.push(resolve); });
          return find(args[1]!) === undefined ? fail("No such container") : ok("137");
        }
        return ok(String(code));
      }
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
  return { docker, networks, containers, working, calls, envSeen };
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

describe("available()", () => {
  it("is true only on a worker that offers the model helper, with a whole config and a PINNED worker image", async () => {
    const w = await world();
    expect(w.sandbox.available()).toBe(true);
    expect(createFreshEvalSandbox({ ...w.config, environment: {} }).available()).toBe(false);
    expect(createFreshEvalSandbox({ ...w.config, image: "rovara/worker:latest" }).available()).toBe(false);
    expect(createFreshEvalSandbox({ ...w.config, repository: { ...w.config.repository, baseCommit: "HEAD" } }).available()).toBe(false);
    expect(createFreshEvalSandbox({ ...w.config, command: { ...w.config.command, cwd: "../x" } }).available()).toBe(false);
    expect(createFreshEvalSandbox({ ...w.config, scratchDir: "relative" }).available()).toBe(false);
    expect(createFreshEvalSandbox(undefined as never).available()).toBe(false);
  });
});

describe("one run", () => {
  it("starts a new round network, the helper on it at .9 with the bridge folder as its one read-only mount, then the sandbox at .4 on that network only, and removes all of it before resolving", async () => {
    const w = await world();
    const result = await w.sandbox.run(w.input());
    const helper = runArgsOf(w.daemon.calls, "-models")!;
    const sandbox = runArgsOf(w.daemon.calls, "-eval")!;
    const net = helper[helper.indexOf("--network") + 1]!;
    const slot = Number(helper[helper.indexOf("--ip") + 1]!.split(".")[2]);
    expect(helper[helper.indexOf("--ip") + 1]).toBe(runNetworkModelHelperIp(slot));
    expect(helper.filter((arg) => arg === "--volume")).toHaveLength(1);
    expect(helper[helper.indexOf("--volume") + 1]).toBe(`${w.bridgeDir}:/rovara/models:ro`);
    expect(helper.slice(helper.indexOf("--mode"), helper.indexOf("--mode") + 2)).toEqual(["--mode", "real"]);
    expect(helper.slice(helper.indexOf("--bridge-socket"), helper.indexOf("--bridge-socket") + 2)).toEqual(["--bridge-socket", MODEL_HELPER_BRIDGE_SOCKET]);
    expect(helper[helper.indexOf("--caller") + 1]).toBe(runNetworkAddresses(slot).checkSandboxIp);
    expect(sandbox.filter((arg) => arg === "--network")).toHaveLength(1);
    expect(sandbox[sandbox.indexOf("--network") + 1]).toBe(net);
    expect(sandbox[sandbox.indexOf("--ip") + 1]).toBe(runNetworkAddresses(slot).checkSandboxIp);
    expect(sandbox.filter((arg) => arg === "--volume")).toHaveLength(1);
    expect(sandbox.join(" ")).not.toContain(w.bridgeDir);
    // the helper is up before the sandbox; the mounts are read from the daemon after the sandbox starts and before it is waited on
    const order = w.daemon.calls.map((c) => (c[0] === "run" ? `run${c[c.indexOf("--name") + 1]!.endsWith("-eval") ? ":eval" : ":helper"}` : c[0] === "inspect" && c.includes("{{json .Mounts}}") ? "mounts" : c[0]));
    expect(order.indexOf("run:helper")).toBeLessThan(order.indexOf("run:eval"));
    expect(order.lastIndexOf("mounts")).toBeLessThan(order.indexOf("wait"));
    // joined: nothing left in the daemon, nothing of the run on disk but the report copy
    expect(w.daemon.containers).toEqual([]); expect(w.daemon.networks).toEqual([]);
    expect(readdirSync(w.config.scratchDir).filter((name) => name.startsWith("run-"))).toEqual([]);
    expect(readdirSync(w.bridgeDir)).toEqual([]);
    expect(await readFile(join(result.report.root, REPORT.cwd, REPORT.argument), "utf8")).toBe(REPORT_BYTES);
    expect(result.report).toMatchObject({ cwd: REPORT.cwd, argument: REPORT.argument });
    expect(result).not.toHaveProperty("attestation");
  });
  it("the token reaches the sandbox only through its env file: never on a docker command line, and the file is gone at once", async () => {
    let envWhileRunning: boolean | undefined;
    const daemon = fakeDaemon({ eval: async (dir) => { const run = runArgsOf(daemon.calls, "-eval")!; envWhileRunning = existsSync(run[run.indexOf("--env-file") + 1]!); await writeFile(join(dir, REPORT.argument), REPORT_BYTES); return 0; } });
    const w = await world(daemon);
    await w.sandbox.run(w.input());
    expect(JSON.stringify(w.daemon.calls)).not.toContain(TOKEN);
    expect(w.daemon.envSeen).toHaveLength(1);
    expect(w.daemon.envSeen[0]).toContain(`GOOGLE_GEMINI_BASE_URL=http://rovara-models:8080/p/gemini/x/${TOKEN}`);
    expect(w.daemon.envSeen[0]).toContain(`${FRESH_EVAL_IDS_VARIABLE}=q1,q2`);
    const sandbox = runArgsOf(w.daemon.calls, "-eval")!;
    expect(existsSync(sandbox[sandbox.indexOf("--env-file") + 1]!)).toBe(false);
    expect(envWhileRunning).toBe(false);
  });
  it("the new side checks out the candidate commit; the old side the base commit, with the working sandbox paused (checked) for the run and unpaused after, and a real attestation", async () => {
    const w = await world();
    const pausedWhileRunning: boolean[] = [];
    const daemon = fakeDaemon({ eval: async (dir) => { pausedWhileRunning.push(daemon.working.paused); await writeFile(join(dir, REPORT.argument), REPORT_BYTES); return 0; } });
    const v = await world(daemon);
    const fresh = await v.sandbox.run(v.input({ side: "new" }));
    const old = await v.sandbox.run(v.input({ side: "old" }));
    expect(v.materialized.map((m) => m.commit)).toEqual([CANDIDATE, BASE]);
    // the base checkout is written with the working sandbox already paused (it cannot change the objects while they are read)
    expect(v.materialized.map((m) => m.workingPaused)).toEqual([false, true]);
    expect(pausedWhileRunning).toEqual([false, true]);
    expect(daemon.working.paused).toBe(false);
    expect(fresh.attestation).toBeUndefined();
    expect(isEvalBaseAttestation(old.attestation)).toBe(true);
    expect(old.attestation?.baseCommit).toBe(BASE);
    void w;
  });
  it("a working sandbox that does not show as paused stops the old side before the sandbox exists; everything is removed and the working sandbox unpaused", async () => {
    const daemon = fakeDaemon({ pauseIgnored: true });
    const w = await world(daemon);
    await expect(w.sandbox.run(w.input({ side: "old" }))).rejects.toThrow();
    expect(runArgsOf(daemon.calls, "-eval")).toBeUndefined();
    expect(daemon.calls.some((c) => c[0] === "unpause")).toBe(true);
    expect(daemon.containers).toEqual([]); expect(daemon.networks).toEqual([]);
  });
  it("two runs (or two tasks) get two networks, two checkouts and two report folders: one never reads the other's report", async () => {
    const daemon = fakeDaemon({ eval: async (dir) => { await writeFile(join(dir, REPORT.argument), readFileSync(join(dir, "eval.js"), "utf8")); return 0; } });
    const a = await world(daemon, { taskId: "company-a-op" });
    const b = await world(daemon, { taskId: "company-b-op", repository: { directory: "/repo/b", baseCommit: BASE, candidateCommit: "e".repeat(40) } });
    const [ra, rb] = await Promise.all([a.sandbox.run(a.input()), b.sandbox.run(b.input())]);
    expect(ra.report.root).not.toBe(rb.report.root);
    expect(await readFile(join(ra.report.root, REPORT.argument), "utf8")).toBe(`// ${CANDIDATE}`);
    expect(await readFile(join(rb.report.root, REPORT.argument), "utf8")).toBe(`// ${"e".repeat(40)}`);
    const nets = daemon.calls.filter((c) => c[0] === "network" && c[1] === "create").map((c) => c.at(-1));
    expect(new Set(nets).size).toBe(2);
  });
});

describe("the report", () => {
  it("a report the eval did not write, or one older than the run, is not copied: the location reads nothing", async () => {
    const none = await world(fakeDaemon({ eval: async () => 0 }));
    const result = await none.sandbox.run(none.input());
    expect(existsSync(join(result.report.root, REPORT.argument))).toBe(false);
    const stale = await world(fakeDaemon({ eval: async () => 0 }), { materialize: async (_r, _c, destination) => { const { utimes } = await import("node:fs/promises"); const file = join(destination, REPORT.argument); await writeFile(file, REPORT_BYTES); await utimes(file, new Date(0), new Date(0)); } });
    const old = await stale.sandbox.run(stale.input());
    expect(existsSync(join(old.report.root, REPORT.argument))).toBe(false);
  });
  it("a report that is a link out of the checkout is not followed", async () => {
    const outside = await mkdtemp(join(tmpdir(), "fes-out-")); roots.push(outside);
    await writeFile(join(outside, "secret.json"), "SECRET");
    const w = await world(fakeDaemon({ eval: async (dir) => { const { symlink } = await import("node:fs/promises"); await symlink(join(outside, "secret.json"), join(dir, REPORT.argument)); return 0; } }));
    const result = await w.sandbox.run(w.input());
    expect(existsSync(join(result.report.root, REPORT.argument))).toBe(false);
  });
});

describe("join, also on a stop", () => {
  it("a stop while the eval runs kills the sandbox at once, and run rejects only after the helper and the network are gone", async () => {
    const stop = new AbortController();
    const daemon = fakeDaemon({ eval: async () => { setTimeout(() => stop.abort(), 10); return "hang"; } });
    const w = await world(daemon);
    await expect(w.sandbox.run(w.input({ signal: stop.signal }))).rejects.toThrow("eval stage stopped");
    expect(daemon.containers).toEqual([]); expect(daemon.networks).toEqual([]);
    expect(readdirSync(w.config.scratchDir)).toEqual([]);
  });
  it("a sandbox that does not start, or a helper that does not, leaves nothing behind", async () => {
    for (const suffix of ["-eval", "-models"]) {
      const daemon = fakeDaemon({ failRun: (args) => (args[args.indexOf("--name") + 1] ?? "").endsWith(suffix) });
      const w = await world(daemon);
      await expect(w.sandbox.run(w.input())).rejects.toThrow();
      expect(daemon.containers, suffix).toEqual([]); expect(daemon.networks, suffix).toEqual([]);
      expect(readdirSync(w.bridgeDir), suffix).toEqual([]);
    }
  });
});

describe("TE-F1C-SOCKET-ACCESS from the daemon's view", () => {
  it("a sandbox the daemon shows mounting the bridge folder is stopped and the run fails", async () => {
    const daemon = fakeDaemon({ extraSandboxMount: (bridgeDir) => ({ Source: bridgeDir, Destination: "/x", RW: false, Type: "bind" }) });
    const w = await world(daemon);
    await expect(w.sandbox.run(w.input())).rejects.toThrow("not isolated");
    expect(daemon.calls.some((c) => c[0] === "wait")).toBe(false);
    expect(daemon.containers).toEqual([]);
  });
  it("a helper whose bridge mount the daemon shows writable fails the run too", async () => {
    const daemon = fakeDaemon({ helperMountRw: true });
    const w = await world(daemon);
    await expect(w.sandbox.run(w.input())).rejects.toThrow("not isolated");
  });
  it("names every way the mounts are wrong, and an unreadable look is never fine", () => {
    const helper = [{ source: "/b/models", destination: "/rovara/models", rw: false, type: "bind" }, { source: "", destination: "/rovara/ledger", rw: true, type: "tmpfs" }];
    const sandbox = [{ source: "/r/checkout", destination: FRESH_EVAL_WORKSPACE, rw: true, type: "bind" }, { source: "", destination: "/tmp", rw: true, type: "tmpfs" }];
    const ok = { helper, sandbox, bridgeDir: "/b/models", checkout: "/r/checkout" };
    expect(bridgeFolderMountProblems(ok)).toEqual([]);
    expect(bridgeFolderMountProblems({ ...ok, helper: undefined })).not.toEqual([]);
    expect(bridgeFolderMountProblems({ ...ok, sandbox: undefined })).not.toEqual([]);
    expect(bridgeFolderMountProblems({ ...ok, helper: [{ ...helper[0]!, rw: true }] })).not.toEqual([]);
    expect(bridgeFolderMountProblems({ ...ok, helper: [...helper, { source: "/etc", destination: "/etc", rw: false, type: "bind" }] })).not.toEqual([]);
    expect(bridgeFolderMountProblems({ ...ok, sandbox: [...sandbox, { source: "/b/models", destination: "/m", rw: false, type: "bind" }] })).not.toEqual([]);
    expect(bridgeFolderMountProblems({ ...ok, sandbox: [...sandbox, { source: "/b", destination: "/m", rw: false, type: "bind" }] })).not.toEqual([]);
    expect(bridgeFolderMountProblems({ ...ok, sandbox: [...sandbox, { source: "/var/run/docker.sock", destination: "/var/run/docker.sock", rw: true, type: "bind" }] })).not.toEqual([]);
    expect(bridgeFolderMountProblems({ ...ok, sandbox: [{ ...sandbox[0]!, source: "/elsewhere" }] })).not.toEqual([]);
    // the sandbox's one mount IS the bridge folder (a checkout path that points at it): refused by the bridge rule itself
    expect(bridgeFolderMountProblems({ ...ok, sandbox: [{ ...sandbox[0]!, source: "/b/models" }], checkout: "/b/models" })).not.toEqual([]);
  });
});

describe("the sandbox's arguments (allow-list)", () => {
  const net = { name: "rovara-svc-0123456789ab", checkSandboxIp: "172.30.7.4", labelArgs: () => ["--label", `${RUN_NETWORK_LABEL}=rovara-svc-0123456789ab`, "--label", "rovara.run-network.created=1", "--label", "rovara.run-network.expires=2", "--label", `rovara.run-network.workspace=${WS}`] };
  const block = planModelHostBlock({ hasModelRow: true, helperIp: "172.30.7.9" });
  const input = { net, image: IMAGE, name: "rovara-svc-0123456789ab-eval", checkout: "/s/r1/checkout", envFile: "/s/r1/env", block, command: { executable: "node", args: ["eval.js", "--fast"], cwd: "evals" } };
  const expected = { checkout: input.checkout, bridgeDir: "/s/e1/models", helperIp: "172.30.7.9" };
  it("are sound as built: the round network only, its .4, no upstream DNS, the checkout as the one mount, non-root, no capability, read-only root, the init, model hosts pinned to the helper", () => {
    const args = freshEvalSandboxRunArgs(input, { bridgeDir: expected.bridgeDir });
    expect(freshEvalSandboxArgProblems(args, net, expected)).toEqual([]);
    expect(args.slice(args.indexOf(IMAGE))).toEqual([IMAGE, "--", "node", "eval.js", "--fast"]);
    expect(args[args.indexOf("--workdir") + 1]).toBe(`${FRESH_EVAL_WORKSPACE}/evals`);
    expect(args.filter((arg) => arg === "--add-host").length).toBeGreaterThan(1);
  });
  it("names each unsound change (mutants of the built list)", () => {
    const args = freshEvalSandboxRunArgs(input, { bridgeDir: expected.bridgeDir });
    const at = args.indexOf(IMAGE);
    const insert = (...extra: string[]) => [...args.slice(0, at), ...extra, ...args.slice(at)];
    const replace = (flag: string, value: string) => args.map((arg, index) => (args[index - 1] === flag ? value : arg));
    const mutants: Record<string, string[]> = {
      "second network": insert("--network", "agentx-task"),
      "other network": replace("--network", "bridge"),
      "working address": replace("--ip", "172.30.7.3"),
      "dns upstream": replace("--dns", "8.8.8.8"),
      "published port": insert("--publish", "8080:8080"),
      "privileged": insert("--privileged"),
      "cap add": insert("--cap-add", "NET_ADMIN"),
      "root user": replace("--user", "0:0"),
      "bridge folder mounted": insert("--volume", `${expected.bridgeDir}:/m:ro`),
      "bridge parent mounted": replace("--volume", "/s:/workspace:rw"),
      "docker socket": insert("--volume", "/var/run/docker.sock:/var/run/docker.sock"),
      "writable root": args.filter((arg) => arg !== "--read-only"),
      "a tag": [...args.slice(0, at), "rovara/worker:latest", ...args.slice(at + 1)],
      "host pinned elsewhere": insert("--add-host", "api.openai.com:1.2.3.4"),
      "env value on the line": insert("--env", "X=1"),
      "seccomp off": replace("--security-opt", "seccomp=unconfined"),
      "second env file": insert("--env-file", "/etc/passwd"),
    };
    for (const [name, mutant] of Object.entries(mutants)) expect(freshEvalSandboxArgProblems(mutant, net, expected), name).not.toEqual([]);
  });
  it("refuses to build arguments that would mount the bridge folder", () => {
    expect(() => freshEvalSandboxRunArgs({ ...input, checkout: "/s/e1/models/checkout" }, { bridgeDir: expected.bridgeDir })).toThrow();
  });
});

describe("refusals before anything starts", () => {
  it("a socket that is not the exec's, a bad token, bad ids, a bad run count or a stop: rejected with no docker call", async () => {
    const daemon = fakeDaemon();
    const w = await world(daemon);
    // a real folder that is not the exec's `models` folder: refused by its name, not by a failed write
    await mkdir(join(w.root, "elsewhere"), { recursive: true });
    const stopped = new AbortController(); stopped.abort();
    const bad: Partial<FreshEvalSandboxRun>[] = [
      { model: { socketPath: join(w.root, "elsewhere", EVAL_BRIDGE_SOCKET_NAME), token: TOKEN } }, { model: { socketPath: join(w.bridgeDir, "other"), token: TOKEN } }, { model: { socketPath: "models/m", token: TOKEN } },
      { model: { socketPath: join(w.bridgeDir, EVAL_BRIDGE_SOCKET_NAME), token: "short" } }, { model: { socketPath: join(w.bridgeDir, EVAL_BRIDGE_SOCKET_NAME), token: `${TOKEN}\nX=1` } },
      { ids: [] }, { ids: ["a,b"] }, { ids: ["a\nb"] }, { ids: ["q", "q"] }, { runs: 4 as never }, { side: "both" as never }, { signal: stopped.signal },
    ];
    for (const over of bad) await expect(w.sandbox.run(w.input(over)), JSON.stringify(over)).rejects.toThrow();
    expect(daemon.calls).toEqual([]);
  });
  it("the env file holds plain lines only: no value can add a variable", () => {
    expect(() => freshEvalEnvironment({ rowId: "gemini", token: "a\nB=1", side: "new", runs: 1, ids: ["q"] })).toThrow();
    expect(() => freshEvalEnvironment({ rowId: "gemini", token: TOKEN, side: "new", runs: 1, ids: ["q r"] })).toThrow();
    expect(freshEvalEnvironment({ rowId: "gemini", token: TOKEN, side: "old", runs: 3, ids: ["q1", "q2"] }).split("\n").filter(Boolean).map((line) => line.split("=")[0])).toEqual(["GOOGLE_GEMINI_BASE_URL", "GEMINI_API_KEY", "GOOGLE_API_KEY", "HOME", "ROVARA_EVAL_SIDE", "ROVARA_EVAL_RUNS", "ROVARA_EVAL_IDS"]);
  });
});

describe("review fixes (TE-B1 REVIEW-1)", () => {
  it("a working sandbox that was already paused is left paused; one that does not wake fails the run after everything else is removed", async () => {
    const daemon = fakeDaemon();
    daemon.working.paused = true;
    const w = await world(daemon);
    await w.sandbox.run(w.input({ side: "old" }));
    expect(daemon.working.paused).toBe(true);
    expect(daemon.calls.some((c) => c[0] === "pause" || c[0] === "unpause")).toBe(false);
    const stuck = fakeDaemon({ unpauseIgnored: true });
    const s2 = await world(stuck);
    await expect(s2.sandbox.run(s2.input({ side: "old" }))).rejects.toThrow("could not be unpaused");
    expect(stuck.containers).toEqual([]); expect(stuck.networks).toEqual([]);
  });
  it("two sandboxes for the SAME operation (a retried invocation) never share a round network", async () => {
    const daemon = fakeDaemon();
    const a = await world(daemon, { taskId: "same-op" });
    const b = await world(daemon, { taskId: "same-op" });
    await Promise.all([a.sandbox.run(a.input()), b.sandbox.run(b.input())]);
    const nets = daemon.calls.filter((c) => c[0] === "network" && c[1] === "create").map((c) => c.at(-1));
    expect(nets).toHaveLength(2); expect(new Set(nets).size).toBe(2);
  });
  it("the sandbox's log is small and capped (an agent's output cannot fill the host's disk) and goes with the container (L4-EVS: it was `none`; the worker reads its tail for a failed run)", async () => {
    const w = await world();
    await w.sandbox.run(w.input());
    const sandbox = runArgsOf(w.daemon.calls, "-eval")!;
    expect(sandbox[sandbox.indexOf("--log-driver") + 1]).toBe("json-file");
    expect(sandbox.flatMap((arg, index) => (sandbox[index - 1] === "--log-opt" ? [arg] : [])).sort()).toEqual(["max-file=1", "max-size=64k"]);
  });
  it("names unsound limits, name, working folder, labels and env file (mutants of the built list)", () => {
    const net = { name: "rovara-svc-0123456789ab", checkSandboxIp: "172.30.7.4", labelArgs: () => ["--label", `${RUN_NETWORK_LABEL}=rovara-svc-0123456789ab`, "--label", "rovara.run-network.created=1", "--label", "rovara.run-network.expires=2", "--label", `rovara.run-network.workspace=${WS}`] };
    const block = planModelHostBlock({ hasModelRow: true, helperIp: "172.30.7.9" });
    const input = { net, image: IMAGE, name: "rovara-svc-0123456789ab-eval", checkout: "/s/r1/checkout", envFile: "/s/r1/env", block, command: { executable: "node", args: [], cwd: "." } };
    const expected = { checkout: input.checkout, bridgeDir: "/s/e1/models", helperIp: "172.30.7.9" };
    const args = freshEvalSandboxRunArgs(input, { bridgeDir: expected.bridgeDir });
    const replace = (flag: string, value: string) => args.map((arg, index) => (args[index - 1] === flag ? value : arg));
    const at = args.indexOf(IMAGE);
    const insert = (...extra: string[]) => [...args.slice(0, at), ...extra, ...args.slice(at)];
    for (const [name, mutant] of Object.entries({
      memory: replace("--memory", "64g"), swap: replace("--memory-swap", "-1"), cpus: replace("--cpus", "64"), pids: replace("--pids-limit", "-1"), stop: replace("--stop-timeout", "3600"),
      logs: replace("--log-driver", "local"), name: replace("--name", "other"), workdir: replace("--workdir", "/"), workdirUp: replace("--workdir", "/workspace/../etc"),
      label: insert("--label", "com.docker.compose.project=x"), labelLookalike: insert("--label", "rovara.run-networkX=1"), envInCheckout: replace("--env-file", "/s/r1/checkout/.env"), envInBridge: replace("--env-file", "/s/e1/models/env"),
    })) expect(freshEvalSandboxArgProblems(mutant, net, expected), name).not.toEqual([]);
  });
  it("a helper with any second mount (a volume, not only a bind) is refused", () => {
    const helper = [{ source: "/b/models", destination: "/rovara/models", rw: false, type: "bind" }, { source: "/var/lib/docker/volumes/x", destination: "/x", rw: true, type: "volume" }];
    const sandbox = [{ source: "/r/checkout", destination: FRESH_EVAL_WORKSPACE, rw: true, type: "bind" }];
    expect(bridgeFolderMountProblems({ helper, sandbox, bridgeDir: "/b/models", checkout: "/r/checkout" })).not.toEqual([]);
  });
});

describe("the vertex row (L4-EVV)", () => {
  const argAfter = (args: readonly string[], flag: string): string | undefined => { const at = args.indexOf(flag); return at < 0 ? undefined : args[at + 1]; };
  const lines = (text: string): Record<string, string> => Object.fromEntries(text.split("\n").filter(Boolean).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as [string, string]));
  it("a gemini row's run is exactly as before: no metadata port, no project id, a gemini helper row", async () => {
    let rows = "";
    const daemon = fakeDaemon({ eval: async (dir) => { rows = await readFile(join(w.bridgeDir, "rows.json"), "utf8"); await writeFile(join(dir, REPORT.argument), REPORT_BYTES); return 0; } });
    const w = await world(daemon);
    await w.sandbox.run(w.input());
    const helper = runArgsOf(daemon.calls, "-models")!;
    expect(helper).not.toContain("--meta-port"); expect(helper).not.toContain("--project-id");
    expect(JSON.parse(rows)).toEqual([{ id: "gemini", family: "gemini" }]);
  });
  it("a vertex row's run serves a vertex helper row with the metadata port and Rovara's placeholder project, and writes the Vertex client's variables (and no key) into the env file", async () => {
    let rows = "";
    const daemon = fakeDaemon({ eval: async (dir) => { rows = await readFile(join(w.bridgeDir, "rows.json"), "utf8"); await writeFile(join(dir, REPORT.argument), REPORT_BYTES); return 0; } });
    const w = await world(daemon, { rowId: "vertex" });
    await w.sandbox.run(w.input());
    const helper = runArgsOf(daemon.calls, "-models")!;
    expect(argAfter(helper, "--meta-port")).toBe("8081");
    expect(argAfter(helper, "--project-id")).toBe("rovara-eval-project");
    expect(JSON.parse(rows)).toEqual([{ id: "vertex", family: "vertex" }]);
    const env = lines(daemon.envSeen[0]!);
    const helperIp = argAfter(helper, "--ip")!;
    expect(env).toMatchObject({
      GOOGLE_VERTEX_BASE_URL: `http://rovara-models:8080/p/vertex/x/${TOKEN}`, GOOGLE_CLOUD_PROJECT: "rovara-eval-project", GOOGLE_CLOUD_LOCATION: "rovara-eval1",
      GCE_METADATA_HOST: `${helperIp}:8081`, GCE_METADATA_IP: `${helperIp}:8081`, ROVARA_EVAL_IDS: "q1,q2",
    });
    // A key next to a project makes google-genai use the express form (no project in the path), which the gateway does not serve; and the Gemini client's variable is not set either.
    for (const name of ["GOOGLE_API_KEY", "GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL"]) expect(env, name).not.toHaveProperty(name);
    expect(JSON.stringify(daemon.calls)).not.toContain(TOKEN);
    expect(daemon.containers).toEqual([]);
  });
  it("the env text: the vertex names in a fixed order, the helper's address required and checked, every value plain", () => {
    const text = freshEvalEnvironment({ rowId: "vertex", token: TOKEN, side: "new", runs: 1, ids: ["q"], helperIp: "172.30.7.9" });
    expect(text.split("\n").filter(Boolean).map((line) => line.split("=")[0])).toEqual(["GOOGLE_VERTEX_BASE_URL", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GCE_METADATA_HOST", "GCE_METADATA_IP", "HOME", "ROVARA_EVAL_SIDE", "ROVARA_EVAL_RUNS", "ROVARA_EVAL_IDS"]);
    for (const helperIp of [undefined, "", "127.0.0.1", "172.30.7.4", "172.30.7.9\nX=1", "rovara-models"]) expect(() => freshEvalEnvironment({ rowId: "vertex", token: TOKEN, side: "new", runs: 1, ids: ["q"], ...(helperIp === undefined ? {} : { helperIp }) }), String(helperIp)).toThrow();
    // A gemini row needs no address and ignores one.
    expect(freshEvalEnvironment({ rowId: "gemini", token: TOKEN, side: "new", runs: 1, ids: ["q"], helperIp: "172.30.7.9" })).toBe(freshEvalEnvironment({ rowId: "gemini", token: TOKEN, side: "new", runs: 1, ids: ["q"] }));
  });
});


describe("stand-in project commands on the round network", () => {
  it("runs each side's migrations in its own checkout with service variables, walls and cleanup before the eval", async () => {
    const daemon = fakeDaemon(); const events: string[] = [];
    const w = await world(daemon, { reportStandInDatabases: true, sealedDns: false, services: {
      async start(net, signal, commands) {
        const started = { hosts: [{ alias: "postgres", address: net.checkSandboxIp.replace(/\.4$/u, ".16") }], env: [["DATABASE_URL", "postgres://app:run-only@postgres/app"]] as Array<[string, string]>, secrets: ["run-only"], started: [], targets: [], unsupported: [] };
        expect(commands).toBeTypeOf("function");
        const result = await commands!(started)({ cwd: ".", executable: "alembic", args: ["upgrade", "head"], timeoutSeconds: 2 }, signal);
        expect(result).toEqual({ exitCode: 0, timedOut: false }); events.push("migrated");
        return { ...started, observe: async ids => { events.push(`observed ${ids.join(",")}`); }, stop: async () => { events.push("stopped"); } };
      },
    } });
    for (const side of ["old", "new"] as const) await w.sandbox.run(w.input({ side }));
    const seeds = daemon.calls.filter(args => args[0] === "run" && args.includes("alembic"));
    expect(seeds).toHaveLength(2);
    for (const args of seeds) {
      expect(args.slice(-4)).toEqual(["--", "alembic", "upgrade", "head"]);
      expect(args).toContain("--read-only"); expect(args).toContain("no-new-privileges");
      const name = args[args.indexOf("--name") + 1]!;
      expect(args[args.indexOf("--network") + 1]).toBe(name.replace(/-eval$/u, ""));
      expect(daemon.calls).toContainEqual(["rm", "--force", name]);
    }
    expect(daemon.envSeen.filter(text => text.includes("DATABASE_URL=") && !text.includes(TOKEN))).toHaveLength(2);
    for (const text of daemon.envSeen.filter(text => text.includes("DATABASE_URL=") && !text.includes(TOKEN))) {
      expect(text).toContain("DATABASE_URL=postgres://app:run-only@postgres/app"); expect(text).not.toContain(TOKEN);
    }
    expect(w.materialized.map(m => m.commit)).toEqual([BASE, CANDIDATE]);
    expect(events).toEqual(["migrated", "observed q1,q2", "stopped", "migrated", "observed q1,q2", "stopped"]);
    expect(daemon.containers).toHaveLength(0); expect(daemon.networks).toHaveLength(0);
  });
});


it("never starts a preparation command whose checkout no longer satisfies its seed lock", async () => {
  const daemon = fakeDaemon();
  const w = await world(daemon, { reportStandInDatabases: true, sealedDns: false, services: {
    async start(_net, signal, commands) {
      const started = { hosts: [], env: [], secrets: [], started: [], targets: [], unsupported: [] };
      await expect(commands!(started)({ cwd: ".", executable: "node", args: ["seed.js"], timeoutSeconds: 2 }, signal, { version: 1, hash: "0".repeat(64), from: ["seed.js"] })).rejects.toThrow("the eval seed lock differs");
      return { ...started, stop: async () => undefined };
    },
  } });
  await w.sandbox.run(w.input());
  expect(daemon.calls.some(args => args[0] === "run" && args.includes("alembic"))).toBe(false);
  expect(daemon.containers).toHaveLength(0);
});

describe("stand-in project commands: folder and isolation (L4-EINT2 review)", () => {
  it("runs a command in its folder inside the side's checkout and refuses a folder that climbs out", async () => {
    const daemon = fakeDaemon();
    const w = await world(daemon, { reportStandInDatabases: true, sealedDns: false, services: {
      async start(_net, signal, commands) {
        const started = { hosts: [], env: [], secrets: [], started: [], targets: [], unsupported: [] };
        expect(await commands!(started)({ cwd: "repo/db", executable: "alembic", args: ["upgrade", "head"], timeoutSeconds: 2 }, signal)).toEqual({ exitCode: 0, timedOut: false });
        await expect(commands!(started)({ cwd: "../elsewhere", executable: "alembic", args: ["upgrade", "head"], timeoutSeconds: 2 }, signal)).rejects.toThrow("the eval seed folder is unavailable");
        return { ...started, stop: async () => undefined };
      },
    } });
    await w.sandbox.run(w.input());
    const seeds = daemon.calls.filter(args => args[0] === "run" && args.includes("alembic"));
    expect(seeds).toHaveLength(1);
    expect(seeds[0]![seeds[0]!.indexOf("--workdir") + 1]).toBe(`${FRESH_EVAL_WORKSPACE}/db`);
  });
  it("stops a preparation box that can see the model bridge folder, and removes it", async () => {
    const daemon = fakeDaemon({ extraSandboxMount: (bridgeDir) => ({ Source: bridgeDir, Destination: "/x", RW: false, Type: "bind" }) });
    const w = await world(daemon, { reportStandInDatabases: true, sealedDns: false, services: {
      async start(_net, signal, commands) {
        const started = { hosts: [], env: [], secrets: [], started: [], targets: [], unsupported: [] };
        await expect(commands!(started)({ cwd: ".", executable: "alembic", args: ["upgrade", "head"], timeoutSeconds: 2 }, signal)).rejects.toThrow("the eval seed is not isolated");
        throw new Error("services failed");
      },
    } });
    await w.sandbox.run(w.input()).catch(() => undefined);
    expect(daemon.calls.some(args => args[0] === "wait")).toBe(false);
    expect(daemon.containers).toHaveLength(0);
  });
});
