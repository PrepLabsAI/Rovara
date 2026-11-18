// L4-E56: the stand-in on the fresh eval sandbox (`createFreshEvalSandbox` with `standIns`). Nothing starts Docker: a small stateful fake daemon (the one the fresh sandbox test uses, trimmed) plays the model helper and the sandbox,
// and the stand-in helper is the `start` seam. Every claim has a control: without `standIns` the sandbox is byte-identical to before; with it the sandbox gets the planned vendor names in its host table, the PUBLIC certificate in its
// checkout and the trust variables in its env file, never the key; the sandbox still mounts nothing but its checkout; a stand-in that will not start fails the run and leaves nothing behind.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildOpenApiFake, type EvalStandInCounts, type EvalStandInPlan, type TrustedEvalStandInSummary } from "@agentx/contracts";
import {
  EVAL_BRIDGE_SOCKET_NAME, EVAL_HELPER_DIR_NAME, FRESH_EVAL_WORKSPACE, createFreshEvalSandbox, freshEvalEnvironment, freshEvalSandboxArgProblems, freshEvalSandboxRunArgs,
  type FreshEvalSandboxConfig, type FreshEvalSandboxRun,
} from "../../packages/worker/src/verification/eval-bridged-exec.js";
import { planModelHostBlock } from "../../packages/worker/src/model-helper-block.js";
import { EVAL_CA_RELATIVE_PATH, EVAL_TRUST_VARIABLES } from "../../packages/worker/src/run-ca.js";
import { EvalStandInRound } from "../../packages/worker/src/eval-standin-round.js";
import { RUN_NETWORK_LABEL, runNetworkAddresses, runNetworkHelperIp } from "../../packages/worker/src/run-network.js";
import type { startEvalStandIns, StartedEvalStandIns } from "../../packages/worker/src/eval-standin-hosted.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

const WS = "0123456789abcdef";
const IMAGE = `rovara/worker@sha256:${"c".repeat(64)}`;
const BASE = "b".repeat(40);
const CANDIDATE = "d".repeat(40);
const TOKEN = "A".repeat(32);
const WORKSPACE = "0b9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c11";
const OPERATION = "7c1f0d3a-2b8e-4a55-8f3b-9a1c2d3e4f50";
const FACTS = JSON.stringify({ metadataBlocked: true, runWalls: true, ipv6Drops: true, prepull: "off", prepulled: 0, loggedOut: true, dockerVersion: "27.3.1" });
const OFFERED: NodeJS.ProcessEnv = { AGENTX_TEST_SERVICES_BOOT_FACTS: FACTS };
const REPORT = { cwd: ".", argument: "eval-report.json" };
const REPORT_BYTES = JSON.stringify({ measures: { version: 1 } });
const DOCUMENT = {
  openapi: "3.0.3", info: { title: "tiktok", version: "1" },
  paths: { "/v2/user/info": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", properties: { data: { type: "object", properties: { display_name: { type: "string" } } } } } } } } } } } },
};
const openapi = buildOpenApiFake(DOCUMENT, "openapi.json");
if (openapi.status !== "built") throw new Error("fixture");
const PLAN: EvalStandInPlan = [{ host: "open.tiktokapis.com", openapi }, { host: "api.vendor.test" }];

interface Container { id: string; name: string; labels: Record<string, string>; network: string; ip: string; args: string[]; mounts: { Source: string; Destination: string; RW: boolean; Type: string }[]; paused: boolean }
interface DaemonOptions { readonly eval?: (checkout: string, env: string) => Promise<number | "hang"> }

function fakeDaemon(options: DaemonOptions = {}) {
  const networks: { name: string; labels: Record<string, string> }[] = [];
  const containers: Container[] = [];
  const working: Container = { id: "w1", name: "agentx-task-1", labels: {}, network: "agentx-task", ip: "", args: [], mounts: [], paused: false };
  const calls: string[][] = [];
  const envSeen: string[] = [];
  const checkoutsSeen: { files: string[]; ca: string | undefined }[] = [];
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
      if (a === "network" && b === "create") { const name = args.at(-1)!; networks.push({ name, labels: labelsOf(args) }); return ok(); }
      if (a === "network" && b === "ls") return ok("");
      if (a === "network" && b === "inspect") return fail("No such network");
      if (a === "network" && b === "rm") { const index = networks.findIndex((n) => n.name === args[2]); if (index < 0) return fail("No such network"); if (containers.some((c) => c.network === networks[index]!.name)) return fail("active endpoints"); networks.splice(index, 1); return ok(); }
      if (a === "run") {
        const name = values(args, "--name")[0]!;
        const network = values(args, "--network")[0]!;
        const mounts = [
          ...values(args, "--volume").map((v) => { const [Source, Destination, mode] = v.split(":"); return { Source: Source!, Destination: Destination!, RW: mode !== "ro", Type: "bind" }; }),
          ...values(args, "--tmpfs").map((v) => ({ Source: "", Destination: v.split(":")[0]!, RW: true, Type: "tmpfs" })),
        ];
        const envFile = values(args, "--env-file")[0];
        if (envFile !== undefined) envSeen.push(readFileSync(envFile, "utf8"));
        const container: Container = { id: `c${String(++ids)}`, name, labels: labelsOf(args), network, ip: values(args, "--ip")[0] ?? "", args: [...args], mounts, paused: false };
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
      if (a === "pause") { const c = find(args[1]!); if (c === undefined) return fail(); c.paused = true; return ok(); }
      if (a === "unpause") { const c = find(args[1]!); if (c === undefined) return fail(); c.paused = false; return ok(); }
      if (a === "wait") {
        const container = find(args[1]!);
        if (container === undefined) return fail("No such container");
        const checkout = container.mounts.find((m) => m.Destination === FRESH_EVAL_WORKSPACE)!.Source;
        const caFile = join(checkout, EVAL_CA_RELATIVE_PATH);
        checkoutsSeen.push({ files: [], ca: existsSync(caFile) ? readFileSync(caFile, "utf8") : undefined });
        const code = await (options.eval ?? (async (dir: string) => { await writeFile(join(dir, REPORT.argument), REPORT_BYTES); return 0; }))(checkout, envSeen.at(-1) ?? "");
        return code === "hang" ? fail("hang") : ok(String(code));
      }
      if (a === "ps") {
        const filter = values(args, "--filter").find((f) => f.startsWith(`label=${RUN_NETWORK_LABEL}=`));
        const wanted = filter?.split("=")[2];
        const template = values(args, "--format")[0] ?? "{{.ID}}";
        return ok(containers.filter((c) => wanted === undefined || c.labels[RUN_NETWORK_LABEL] === wanted).map((c) => template.replace(/\{\{\.ID\}\}/gu, c.id).replace(/\{\{\.Label "([^"]+)"\}\}/gu, (_all, key: string) => c.labels[key] ?? "")).join("\n"));
      }
      if (a === "rm") {
        for (const target of args.slice(1).filter((arg) => !arg.startsWith("-"))) { const index = containers.findIndex((c) => c.id === target || c.name === target); if (index >= 0) containers.splice(index, 1); }
        return ok();
      }
      return ok();
    },
  };
  return { docker, networks, containers, working, calls, envSeen, checkoutsSeen };
}

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const summaryOf = (gapCalls: number): TrustedEvalStandInSummary => ({
  schemaVersion: 1, trusted: true, workspaceId: WORKSPACE, operationId: OPERATION, digest: "e".repeat(64),
  counts: { recorded: 0, generated: gapCalls, generatedNoContract: 0, newConnections: 0, served: gapCalls + 1, gapCalls, saturated: false },
  foreign: 0, refused: 0, tlsFailed: 0,
  additions: gapCalls === 0 ? [] : [{ key: "a".repeat(64), status: 200, contentType: "application/json", body: "{}", cls: "generated" }],
  gaps: [], newHosts: [],
});

interface StandInWorld { started: number; stopped: number; startInput?: Parameters<typeof startEvalStandIns>[0]; summary: () => Promise<TrustedEvalStandInSummary | undefined>; failStart: boolean }
function standInWorld(gapCalls = 1): StandInWorld & { start: typeof startEvalStandIns } {
  const state: StandInWorld = { started: 0, stopped: 0, summary: async () => summaryOf(gapCalls), failStart: false };
  const start = async (input: Parameters<typeof startEvalStandIns>[0]): Promise<StartedEvalStandIns> => {
    if (state.failStart) throw new Error("AgentX could not start the stand-in for this eval round");
    state.started += 1;
    state.startInput = input;
    return { address: input.net.helperIp(0), summary: () => state.summary(), stop: async () => { state.stopped += 1; } };
  };
  return Object.assign(state, { start });
}

async function world(options: { standIns?: boolean; plan?: EvalStandInPlan; daemon?: ReturnType<typeof fakeDaemon>; gapCalls?: number } = {}) {
  const daemon = options.daemon ?? fakeDaemon();
  const root = await mkdtemp(join(tmpdir(), "fes-si-")); roots.push(root);
  const bridgeDir = join(root, "e1", EVAL_HELPER_DIR_NAME);
  await mkdir(bridgeDir, { recursive: true, mode: 0o700 });
  const round = new EvalStandInRound({ workspaceId: WORKSPACE, operationId: OPERATION, plan: options.plan ?? PLAN });
  const stand = standInWorld(options.gapCalls ?? 1);
  const config: FreshEvalSandboxConfig = {
    docker: daemon.docker, image: IMAGE, workspace: WS, taskId: "op-1", roundBudgetMs: 600_000, repository: { directory: join(root, "repo"), baseCommit: BASE, candidateCommit: CANDIDATE },
    command: { executable: "node", args: ["eval.js"], cwd: "." }, report: REPORT, rowId: "gemini", scratchDir: join(root, "scratch"), workingSandbox: daemon.working.name, environment: OFFERED,
    materialize: async (_root, commit, destination) => { await writeFile(join(destination, "eval.js"), `// ${commit}`); },
    sleep: () => Promise.resolve(),
    ...(options.standIns === false ? {} : { standIns: { round, start: stand.start } }),
  };
  const input = (o: Partial<FreshEvalSandboxRun> = {}): FreshEvalSandboxRun => ({ side: "new", ids: ["q1", "q2"], runs: 1, signal: new AbortController().signal, model: { socketPath: join(bridgeDir, EVAL_BRIDGE_SOCKET_NAME), token: TOKEN }, ...o });
  return { root, bridgeDir, config, sandbox: createFreshEvalSandbox(config), input, daemon, round, stand };
}
const runArgsOf = (calls: string[][], suffix: string) => calls.find((c) => c[0] === "run" && (c[c.indexOf("--name") + 1] ?? "").endsWith(suffix));
const values = (args: readonly string[], flag: string) => args.flatMap((arg, index) => (args[index - 1] === flag ? [arg] : []));

describe("without standIns the sandbox is what it was", () => {
  it("has no vendor name in its host table, no certificate file, no trust variable and no stand-in", async () => {
    const w = await world({ standIns: false });
    const result = await w.sandbox.run(w.input());
    const sandbox = runArgsOf(w.daemon.calls, "-eval")!;
    expect(values(sandbox, "--add-host").every((pair) => pair.startsWith("rovara-models:") || /^[a-z0-9.-]+:10\.255\.255\.1$|:172\.\d+\.\d+\.9$/u.test(pair))).toBe(true);
    expect(w.daemon.checkoutsSeen[0]!.ca).toBeUndefined();
    for (const variable of EVAL_TRUST_VARIABLES) expect(w.daemon.envSeen[0]).not.toContain(`${variable}=`);
    expect(w.stand.started).toBe(0);
    expect(result).not.toHaveProperty("standIns");
  });
});

describe("with standIns", () => {
  it("starts the stand-in on the round network after the model helper, joins the planned vendor names to it, and removes it with everything else", async () => {
    const w = await world();
    const result = await w.sandbox.run(w.input());
    const sandbox = runArgsOf(w.daemon.calls, "-eval")!;
    const helper = runArgsOf(w.daemon.calls, "-models")!;
    const slot = Number(helper[helper.indexOf("--ip") + 1]!.split(".")[2]);
    const standInIp = runNetworkHelperIp(slot, 0);
    expect(w.stand.startInput!.net.helperIp(0)).toBe(standInIp);
    expect(w.stand.startInput!.net.checkSandboxIp).toBe(runNetworkAddresses(slot).checkSandboxIp);
    const hosts = values(sandbox, "--add-host");
    expect(hosts).toEqual(expect.arrayContaining([`open.tiktokapis.com:${standInIp}`, `api.vendor.test:${standInIp}`]));
    expect(sandbox.filter((arg) => arg === "--network")).toHaveLength(1);
    expect(sandbox.filter((arg) => arg === "--volume")).toHaveLength(1);
    expect(w.stand.started).toBe(1);
    expect(w.stand.stopped).toBe(1);
    expect(w.daemon.containers).toEqual([]); expect(w.daemon.networks).toEqual([]);
    expect(result.standIns).toEqual({ hitGap: true, counts: expect.objectContaining({ generated: 1, served: 2, gapCalls: 1 }) as EvalStandInCounts });
  });
  it("puts the PUBLIC certificate in the checkout and the trust variables in the env file, never the key or any PEM text in a variable", async () => {
    const w = await world();
    await w.sandbox.run(w.input());
    const certificate = w.daemon.checkoutsSeen[0]!.ca!;
    expect(certificate).toBe(w.round.certificatePem);
    expect(certificate).toContain("BEGIN CERTIFICATE");
    expect(certificate).not.toContain("PRIVATE KEY");
    const env = w.daemon.envSeen[0]!;
    for (const variable of EVAL_TRUST_VARIABLES) expect(env).toContain(`${variable}=${FRESH_EVAL_WORKSPACE}/${EVAL_CA_RELATIVE_PATH}\n`);
    expect(env).not.toContain("PRIVATE KEY");
    expect(env).not.toContain("BEGIN");
    expect(JSON.stringify(w.daemon.calls)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(w.daemon.calls)).not.toContain(w.round.setContent().ca.keyPem.slice(40, 90));
  });
  it("hands the helper the round's set: the plan, the answers so far and the authority (for its own mount), and keeps the key out of the sandbox's checkout", async () => {
    const w = await world();
    await w.sandbox.run(w.input());
    const content = w.stand.startInput!.content;
    expect(content.plan.map((entry) => entry.host)).toEqual(["open.tiktokapis.com", "api.vendor.test"]);
    expect(content.ca.keyPem).toContain("PRIVATE KEY");
    expect(content.workspaceId).toBe(WORKSPACE);
    expect(content.operationId).toBe(OPERATION);
    expect(w.stand.startInput!.parent.startsWith(w.config.scratchDir)).toBe(true);
    expect(w.stand.startInput!.parent).not.toBe(w.bridgeDir);
  });
  it("keeps the sandbox's mounts to its checkout: the daemon's own view passes with the stand-in running", async () => {
    const w = await world();
    await expect(w.sandbox.run(w.input())).resolves.toBeDefined();
    const mountCalls = w.daemon.calls.filter((c) => c[0] === "inspect" && c.includes("{{json .Mounts}}"));
    expect(mountCalls.length).toBeGreaterThanOrEqual(2);
  });
  it("shares the one answer book across sides: answers the first run's helper made are in the second run's set", async () => {
    const w = await world();
    await w.sandbox.run(w.input({ side: "new" }));
    const first = w.stand.startInput!.content.book;
    expect(first).toEqual([]);
    await w.sandbox.run(w.input({ side: "old" }));
    const second = w.stand.startInput!.content.book;
    expect(second).toHaveLength(1);
    expect(second[0]!.key).toBe("a".repeat(64));
    expect(w.round.counts()).toMatchObject({ generated: 1, served: 4, gapCalls: 2 });
  });
  it("reports a run with no gap as such, and an unreadable summary as a run that hit one", async () => {
    const clean = await world({ gapCalls: 0 });
    expect((await clean.sandbox.run(clean.input())).standIns).toMatchObject({ hitGap: false });
    const unreadable = await world();
    unreadable.stand.summary = async () => undefined;
    expect((await unreadable.sandbox.run(unreadable.input())).standIns).toMatchObject({ hitGap: true });
    const throwing = await world();
    throwing.stand.summary = async () => { throw new Error("exec failed"); };
    expect((await throwing.sandbox.run(throwing.input())).standIns).toMatchObject({ hitGap: true });
  });
  it("never gives localhost, a one-word name or a name under localhost to the stand-in, even if a plan carried one", async () => {
    const w = await world({ plan: [{ host: "localhost" }, { host: "redis" }, { host: "app.localhost" }, { host: "api.vendor.test" }] });
    await w.sandbox.run(w.input());
    const sandbox = runArgsOf(w.daemon.calls, "-eval")!;
    const standInIp = w.stand.startInput!.net.helperIp(0);
    expect(values(sandbox, "--add-host").filter((pair) => pair.endsWith(`:${standInIp}`))).toEqual([`api.vendor.test:${standInIp}`]);
  });
  it("never gives a planned name that is a model host to the stand-in (the model route wins)", async () => {
    const w = await world({ plan: [{ host: "generativelanguage.googleapis.com" }, { host: "rovara-models" }, { host: "api.vendor.test" }] });
    await w.sandbox.run(w.input());
    const sandbox = runArgsOf(w.daemon.calls, "-eval")!;
    const standInIp = w.stand.startInput!.net.helperIp(0);
    expect(values(sandbox, "--add-host").filter((pair) => pair.endsWith(`:${standInIp}`))).toEqual([`api.vendor.test:${standInIp}`]);
  });
  it("fails the run when the stand-in will not start, and leaves no container, network or file behind", async () => {
    const w = await world();
    w.stand.failStart = true;
    await expect(w.sandbox.run(w.input())).rejects.toThrow();
    expect(runArgsOf(w.daemon.calls, "-eval")).toBeUndefined();
    expect(w.daemon.containers).toEqual([]); expect(w.daemon.networks).toEqual([]);
    expect(existsSync(w.config.scratchDir) ? (await import("node:fs")).readdirSync(w.config.scratchDir).filter((name) => name.startsWith("run-")) : []).toEqual([]);
  });
  it("stops the stand-in when the eval is stopped, and when the eval fails", async () => {
    const stop = new AbortController();
    const hang = await world({ daemon: fakeDaemon({ eval: async () => { setTimeout(() => stop.abort(), 10); return "hang"; } }) });
    await expect(hang.sandbox.run(hang.input({ signal: stop.signal }))).rejects.toThrow();
    expect(hang.stand.stopped).toBe(1);
    const failing = await world({ daemon: fakeDaemon({ eval: async () => 3 }) });
    await expect(failing.sandbox.run(failing.input())).rejects.toThrow();
    expect(failing.stand.stopped).toBe(1);
  });
  it("two companies' rounds share nothing: separate books, authorities and helpers", async () => {
    const a = await world();
    const b = await world({ plan: [{ host: "other.vendor.test" }] });
    await a.sandbox.run(a.input());
    await b.sandbox.run(b.input());
    expect(a.round.book).not.toBe(b.round.book);
    expect(a.round.certificatePem).not.toBe(b.round.certificatePem);
    expect(b.stand.startInput!.content.plan.map((entry) => entry.host)).toEqual(["other.vendor.test"]);
    expect(a.stand.startInput!.content.plan.map((entry) => entry.host)).toEqual(["open.tiktokapis.com", "api.vendor.test"]);
  });
});

describe("the argument allow-list", () => {
  const net = { name: "rovara-svc-0123456789ab", checkSandboxIp: "172.30.7.4", labelArgs: () => ["--label", `${RUN_NETWORK_LABEL}=rovara-svc-0123456789ab`, "--label", "rovara.run-network.created=1", "--label", "rovara.run-network.expires=2", "--label", `rovara.run-network.workspace=${WS}`] };
  const block = planModelHostBlock({ hasModelRow: true, helperIp: "172.30.7.9" });
  const standIn = { address: "172.30.7.16", hosts: ["open.tiktokapis.com", "api.vendor.test"] };
  const input = { net, image: IMAGE, name: "rovara-svc-0123456789ab-eval", checkout: "/s/r1/checkout", envFile: "/s/r1/env", block, command: { executable: "node", args: ["eval.js"], cwd: "." }, standIn };
  const expected = { checkout: input.checkout, bridgeDir: "/s/e1/models", helperIp: "172.30.7.9", standIn };
  const args = freshEvalSandboxRunArgs(input, { bridgeDir: expected.bridgeDir });
  const insert = (flag: string, value: string): string[] => { const at = args.indexOf("--detach") + 1; return [...args.slice(0, at), flag, value, ...args.slice(at)]; };

  it("are sound as built, with the stand-in's names pinned to the stand-in and the model hosts still pinned to the model helper", () => {
    expect(freshEvalSandboxArgProblems(args, net, expected)).toEqual([]);
    expect(values(args, "--add-host")).toEqual(expect.arrayContaining(["open.tiktokapis.com:172.30.7.16", "api.vendor.test:172.30.7.16", "rovara-models:172.30.7.9"]));
    expect(args.filter((arg) => arg === "--network")).toHaveLength(1);
    expect(args.filter((arg) => arg === "--volume")).toEqual(["--volume"]);
  });
  it("without a stand-in the arguments are exactly what they were", () => {
    const plain = freshEvalSandboxRunArgs({ ...input, standIn: undefined }, { bridgeDir: expected.bridgeDir });
    expect(plain.join(" ")).not.toContain("open.tiktokapis.com");
    expect(freshEvalSandboxArgProblems(plain, net, { ...expected, standIn: undefined })).toEqual([]);
  });
  it.each([
    ["a name pinned to a stranger", () => insert("--add-host", "evil.example.test:1.2.3.4")],
    ["a stand-in name pinned to a different address in the range", () => insert("--add-host", "open.tiktokapis.com:172.30.7.17")],
    ["a name the plan did not list pinned to the stand-in", () => insert("--add-host", "other.example.test:172.30.7.16")],
    ["a model host pinned to the stand-in", () => insert("--add-host", "generativelanguage.googleapis.com:172.30.7.16")],
    ["a second network", () => insert("--network", "bridge")],
    ["a second mount", () => insert("--volume", "/s/r1/standin:/standin:ro")],
    ["the stand-in's folder as the mount", () => args.map((arg) => (arg === "/s/r1/checkout:/workspace:rw" ? "/s/r1/standin:/workspace:rw" : arg))],
    ["an env value on the line", () => insert("--env", "SSL_CERT_FILE=/x")],
  ])("refuses %s", (_name, make) => {
    const mutant = make();
    expect(freshEvalSandboxArgProblems(mutant, net, expected)).not.toEqual([]);
  });
  it("refuses a stand-in outside the helper range, in another network, or one that names the model helper's host, localhost or a one-word name", () => {
    for (const bad of [{ address: "172.30.7.16", hosts: ["localhost"] }, { address: "172.30.7.16", hosts: ["redis"] }, { address: "172.30.7.3", hosts: ["a.test"] }, { address: "172.30.7.48", hosts: ["a.test"] }, { address: "172.30.8.16", hosts: ["a.test"] }, { address: "172.30.7.16", hosts: ["rovara-models"] }, { address: "172.30.7.16", hosts: ["not a host"] }]) {
      expect(freshEvalSandboxArgProblems(args, net, { ...expected, standIn: bad }), JSON.stringify(bad)).not.toEqual([]);
    }
  });
  it("builds the env file with the trust lines only when a certificate path is given", () => {
    const env = freshEvalEnvironment({ rowId: "gemini", token: TOKEN, side: "new", runs: 1, ids: ["q1"], standInCertificate: `${FRESH_EVAL_WORKSPACE}/${EVAL_CA_RELATIVE_PATH}` });
    expect(env.split("\n").filter((line) => line.startsWith("SSL_CERT_FILE="))).toEqual([`SSL_CERT_FILE=${FRESH_EVAL_WORKSPACE}/${EVAL_CA_RELATIVE_PATH}`]);
    expect(freshEvalEnvironment({ rowId: "gemini", token: TOKEN, side: "new", runs: 1, ids: ["q1"] })).not.toContain("SSL_CERT_FILE");
    expect(() => freshEvalEnvironment({ rowId: "gemini", token: TOKEN, side: "new", runs: 1, ids: ["q1"], standInCertificate: "relative.pem" })).toThrow();
  });
});

describe("the report is unchanged by the stand-in", () => {
  it("still copies the eval's report out of the checkout", async () => {
    const w = await world();
    const result = await w.sandbox.run(w.input());
    expect(await readFile(join(result.report.root, REPORT.cwd, REPORT.argument), "utf8")).toBe(REPORT_BYTES);
  });
});
