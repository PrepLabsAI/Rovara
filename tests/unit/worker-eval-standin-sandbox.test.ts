// L4-E56: the stand-in on the fresh eval sandbox (`createFreshEvalSandbox` with `standIns`), built on lane E12's sealed name server. Nothing starts Docker: the stateful fake daemon of the sealed eval tests
// (tests/support/fake-eval-sealed-daemon.ts) plays the model helper, the name server and the sandbox, and answers "what can the box reach?" from the arguments alone; the stand-in helper is the `start` seam.
// Every claim has a control: without `standIns` the sandbox is what it was; with it the round is sealed, the planned vendor names are in the hosts file and the name server's table at the SINKHOLE address (where the stand-in sits,
// so every other name is its catch-all), the PUBLIC certificate is in the checkout and the trust variables in the env file, never the key; the sandbox still mounts nothing but its checkout and the name server's two files; a stand-in
// that will not start fails the run and leaves nothing behind.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildOpenApiFake, type EvalStandInCounts, type EvalStandInPlan, type TrustedEvalStandInSummary } from "@agentx/contracts";
import {
  EVAL_BRIDGE_SOCKET_NAME, EVAL_HELPER_DIR_NAME, FRESH_EVAL_WORKSPACE, createFreshEvalSandbox, freshEvalEnvironment, type FreshEvalSandboxConfig, type FreshEvalSandboxRun,
} from "../../packages/worker/src/verification/eval-bridged-exec.js";
import { EVAL_CA_RELATIVE_PATH, EVAL_TRUST_VARIABLES } from "../../packages/worker/src/run-ca.js";
import { EvalStandInRound } from "../../packages/worker/src/eval-standin-round.js";
import { EVAL_STAND_IN_HELPER_INDEX, evalStandInDnsPairs, evalStandInHostsLines, type startEvalStandIns, type StartedEvalStandIns } from "../../packages/worker/src/eval-standin-hosted.js";
import { runNetworkAddresses, runNetworkHelperIp, runNetworkModelHelperIp } from "../../packages/worker/src/run-network.js";
import { EVAL_REPORT_FILE, fakeEvalDaemon } from "../support/fake-eval-sealed-daemon.js";

const WS = "0123456789abcdef";
const IMAGE = `rovara/worker@sha256:${"c".repeat(64)}`;
const BASE = "b".repeat(40);
const CANDIDATE = "d".repeat(40);
const TOKEN = "A".repeat(32);
const WORKSPACE = "0b9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c11";
const OPERATION = "7c1f0d3a-2b8e-4a55-8f3b-9a1c2d3e4f50";
const FACTS = JSON.stringify({ metadataBlocked: true, runWalls: true, ipv6Drops: true, prepull: "off", prepulled: 0, loggedOut: true, dockerVersion: "27.3.1" });
const OFFERED: NodeJS.ProcessEnv = { AGENTX_TEST_SERVICES_BOOT_FACTS: FACTS };
const REPORT = { cwd: ".", argument: EVAL_REPORT_FILE };
const DOCUMENT = {
  openapi: "3.0.3", info: { title: "tiktok", version: "1" },
  paths: { "/v2/user/info": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", properties: { data: { type: "object", properties: { display_name: { type: "string" } } } } } } } } } } } },
};
const openapi = buildOpenApiFake(DOCUMENT, "openapi.json");
if (openapi.status !== "built") throw new Error("fixture");
const PLAN: EvalStandInPlan = [{ host: "open.tiktokapis.com", openapi }, { host: "api.vendor.test" }];

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
function standInWorld(gapCalls: number): StandInWorld & { start: typeof startEvalStandIns } {
  const state: StandInWorld = { started: 0, stopped: 0, summary: async () => summaryOf(gapCalls), failStart: false };
  const start = async (input: Parameters<typeof startEvalStandIns>[0]): Promise<StartedEvalStandIns> => {
    if (state.failStart) throw new Error("AgentX could not start the stand-in for this eval round");
    state.started += 1;
    state.startInput = input;
    return { address: input.net.helperIp(EVAL_STAND_IN_HELPER_INDEX), summary: () => state.summary(), stop: async () => { state.stopped += 1; } };
  };
  return Object.assign(state, { start });
}

interface Seen { env: string; ca: string | undefined; caExists: boolean; files: string[] }
async function world(options: { standIns?: boolean; plan?: EvalStandInPlan; gapCalls?: number; exitCode?: number } = {}) {
  const seen: Seen[] = [];
  const daemon = fakeEvalDaemon({
    ...(options.exitCode === undefined ? {} : { exitCode: options.exitCode }),
    output: (env, checkout) => {
      const caFile = join(checkout, EVAL_CA_RELATIVE_PATH);
      seen.push({ env, ca: existsSync(caFile) ? readFileSync(caFile, "utf8") : undefined, caExists: existsSync(caFile), files: readdirSync(checkout) });
      return "";
    },
  });
  const root = await mkdtemp(join(tmpdir(), "fes-si-")); roots.push(root);
  const bridgeDir = join(root, "e1", EVAL_HELPER_DIR_NAME);
  await mkdir(bridgeDir, { recursive: true, mode: 0o700 });
  const round = new EvalStandInRound({ workspaceId: WORKSPACE, operationId: OPERATION, plan: options.plan ?? PLAN });
  const stand = standInWorld(options.gapCalls ?? 1);
  const config: FreshEvalSandboxConfig = {
    docker: daemon.docker, image: IMAGE, workspace: WS, taskId: "op-1", roundBudgetMs: 600_000, repository: { directory: join(root, "repo"), baseCommit: BASE, candidateCommit: CANDIDATE },
    command: { executable: "node", args: ["eval.js"], cwd: "." }, report: REPORT, rowId: "gemini", scratchDir: join(root, "scratch"), workingSandbox: null, environment: OFFERED,
    materialize: async (_root, commit, destination) => { await writeFile(join(destination, "eval.js"), `// ${commit}`); },
    sleep: () => Promise.resolve(),
    ...(options.standIns === false ? {} : { standIns: { round, start: stand.start } }),
  };
  const input = (o: Partial<FreshEvalSandboxRun> = {}): FreshEvalSandboxRun => ({ side: "new", ids: ["q1", "q2"], runs: 1, signal: new AbortController().signal, model: { socketPath: join(bridgeDir, EVAL_BRIDGE_SOCKET_NAME), token: TOKEN }, ...o });
  return { root, bridgeDir, config, sandbox: createFreshEvalSandbox(config), input, daemon, round, stand, seen };
}
const runArgsOf = (calls: string[][], suffix: string) => calls.find((c) => c[0] === "run" && (c[c.indexOf("--name") + 1] ?? "").endsWith(suffix));
const values = (args: readonly string[], flag: string) => args.flatMap((arg, index) => (args[index - 1] === flag ? [arg] : []));
const leftovers = (w: Awaited<ReturnType<typeof world>>): string[] => (existsSync(w.config.scratchDir) ? readdirSync(w.config.scratchDir).filter((name) => name.startsWith("run-")) : []);

describe("without standIns the sandbox is what it was", () => {
  it("is not sealed, has no stand-in, no certificate file and no trust variable, and reports no stand-in", async () => {
    const w = await world({ standIns: false });
    const result = await w.sandbox.run(w.input());
    expect(runArgsOf(w.daemon.calls, "-dns")).toBeUndefined();
    expect(w.daemon.mountedFiles).toEqual([]);
    expect(w.seen[0]!.caExists).toBe(false);
    for (const variable of EVAL_TRUST_VARIABLES) expect(w.seen[0]!.env).not.toContain(`${variable}=`);
    expect(w.stand.started).toBe(0);
    expect(result).not.toHaveProperty("standIns");
  });
});

describe("with standIns", () => {
  it("seals the round, starts the stand-in at the SINKHOLE address on the round network, and removes it with everything else", async () => {
    const w = await world();
    const result = await w.sandbox.run(w.input());
    const helper = runArgsOf(w.daemon.calls, "-models")!;
    const slot = Number(helper[helper.indexOf("--ip") + 1]!.split(".")[2]);
    const standInIp = runNetworkHelperIp(slot, EVAL_STAND_IN_HELPER_INDEX);
    expect(standInIp.endsWith(".47")).toBe(true);
    expect(w.stand.startInput!.net.helperIp(EVAL_STAND_IN_HELPER_INDEX)).toBe(standInIp);
    expect(w.stand.startInput!.net.checkSandboxIp).toBe(runNetworkAddresses(slot).checkSandboxIp);
    expect(w.stand.started).toBe(1);
    expect(w.stand.stopped).toBe(1);
    const dns = runArgsOf(w.daemon.calls, "-dns")!;
    expect(values(dns, "--sinkhole")).toEqual([standInIp]);
    expect(values(dns, "--host")).toEqual(expect.arrayContaining([`open.tiktokapis.com=${standInIp}`, `api.vendor.test=${standInIp}`]));
    expect(w.daemon.containers).toEqual([]); expect(w.daemon.networks).toEqual([]);
    expect(leftovers(w)).toEqual([]);
    // L4-EINT: the run also names what it was stood in for (planned hosts, no database here, no telemetry answered).
    expect(result.standIns).toEqual({ hitGap: true, counts: expect.objectContaining({ generated: 1, served: 2, gapCalls: 1 }) as EvalStandInCounts, telemetry: [], hosts: expect.arrayContaining(["open.tiktokapis.com", "api.vendor.test"]) as string[], databases: [] });
  });
  it("puts the planned vendor names and the sinkhole in the box's hosts file (all at the stand-in), the name server as its resolver, and pins nothing with --add-host", async () => {
    const w = await world();
    await w.sandbox.run(w.input());
    const sandbox = runArgsOf(w.daemon.calls, "-eval")!;
    const standInIp = w.stand.startInput!.net.helperIp(EVAL_STAND_IN_HELPER_INDEX);
    const hosts = w.daemon.mountedFiles.find((file) => file.destination === "/etc/hosts")!.content;
    expect(hosts).toContain(`${standInIp} open.tiktokapis.com\n`);
    expect(hosts).toContain(`${standInIp} api.vendor.test\n`);
    expect(hosts).toContain(`${standInIp} sinkhole\n`);
    expect(hosts).toContain("127.0.0.1 localhost");
    expect(w.daemon.mountedFiles.find((file) => file.destination === "/etc/resolv.conf")!.content).toContain("nameserver ");
    expect(values(sandbox, "--add-host")).toEqual([]);
  });
  it("keeps the box on the round network only, with the checkout and the name server's two files as its only mounts, and able to reach nothing but the round's own containers", async () => {
    const w = await world();
    await w.sandbox.run(w.input());
    const sandbox = runArgsOf(w.daemon.calls, "-eval")!;
    expect(values(sandbox, "--network")).toHaveLength(1);
    expect(values(sandbox, "--volume").map((volume) => volume.split(":").slice(1).join(":"))).toEqual([`${FRESH_EVAL_WORKSPACE}:rw`, "/etc/resolv.conf:ro", "/etc/hosts:ro"]);
    const reach = w.daemon.reachableFrom(`${w.stand.startInput!.net.name}-eval`);
    if (reach === "anything") throw new Error("the box can reach anything");
    const helper = runArgsOf(w.daemon.calls, "-models")!;
    const slot = Number(helper[helper.indexOf("--ip") + 1]!.split(".")[2]);
    expect([...reach].sort()).toEqual([runNetworkAddresses(slot).dnsHelperIp, runNetworkModelHelperIp(slot)].sort());
  });
  it("puts the PUBLIC certificate in the checkout and the trust variables in the env file, never the key or any PEM text in a variable", async () => {
    const w = await world();
    await w.sandbox.run(w.input());
    const certificate = w.seen[0]!.ca!;
    expect(certificate).toBe(w.round.certificatePem);
    expect(certificate).toContain("BEGIN CERTIFICATE");
    expect(certificate).not.toContain("PRIVATE KEY");
    const env = w.daemon.envFiles.find((file) => file.container.endsWith("-eval"))!.content;
    for (const variable of EVAL_TRUST_VARIABLES) expect(env).toContain(`${variable}=${FRESH_EVAL_WORKSPACE}/${EVAL_CA_RELATIVE_PATH}\n`);
    expect(env).not.toContain("PRIVATE KEY");
    expect(env).not.toContain("BEGIN");
    expect(JSON.stringify(w.daemon.calls)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(w.daemon.calls)).not.toContain(w.round.setContent().ca.keyPem.slice(40, 90));
    expect(JSON.stringify(w.daemon.mountedFiles)).not.toContain("PRIVATE KEY");
  });
  it("hands the helper the round's set (the plan, the answers so far, the authority for its own mount) in a folder that is not the checkout, the bridge folder or the name server's files", async () => {
    const w = await world();
    await w.sandbox.run(w.input());
    const content = w.stand.startInput!.content;
    expect(content.plan.map((entry) => entry.host)).toEqual(["open.tiktokapis.com", "api.vendor.test"]);
    expect(content.ca.keyPem).toContain("PRIVATE KEY");
    expect(content.workspaceId).toBe(WORKSPACE);
    expect(content.operationId).toBe(OPERATION);
    const parent = w.stand.startInput!.parent;
    expect(parent.startsWith(w.config.scratchDir)).toBe(true);
    const sandbox = runArgsOf(w.daemon.calls, "-eval")!;
    for (const volume of values(sandbox, "--volume")) expect(volume.startsWith(parent)).toBe(false);
    expect(parent.startsWith(w.bridgeDir)).toBe(false);
    expect(w.seen[0]!.files).not.toContain("standin-run");
  });
  it("shares the one answer book across sides: answers the first run's helper made are in the second run's set", async () => {
    const w = await world();
    await w.sandbox.run(w.input({ side: "new" }));
    expect(w.stand.startInput!.content.book).toEqual([]);
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
  it("never gives localhost, an address, a one-word name, a model host or a reserved name to the stand-in, even if a plan carried one", async () => {
    const w = await world({ plan: [{ host: "localhost" }, { host: "redis" }, { host: "app.localhost" }, { host: "generativelanguage.googleapis.com" }, { host: "rovara-models" }, { host: "api.vendor.test" }] });
    await w.sandbox.run(w.input());
    const standInIp = w.stand.startInput!.net.helperIp(EVAL_STAND_IN_HELPER_INDEX);
    const dns = runArgsOf(w.daemon.calls, "-dns")!;
    expect(values(dns, "--host").filter((pair) => pair.endsWith(`=${standInIp}`) && !pair.startsWith("sinkhole="))).toEqual([`api.vendor.test=${standInIp}`]);
    const hosts = w.daemon.mountedFiles.find((file) => file.destination === "/etc/hosts")!.content;
    expect(hosts).not.toContain(`${standInIp} localhost`);
    expect(hosts).not.toContain(`${standInIp} generativelanguage.googleapis.com`);
    expect(hosts.match(/^127\.0\.0\.1 localhost/mu)).not.toBeNull();
  });
  it("writes the certificate before any install step and never through a link an install step could plant (a link from the commit or an earlier step is removed, never followed)", async () => {
    const w = await world();
    const outside = await mkdtemp(join(tmpdir(), "fes-out-")); roots.push(outside);
    await writeFile(join(outside, "ca.pem"), "UNTOUCHED");
    const { symlink } = await import("node:fs/promises");
    const sandbox = createFreshEvalSandbox({ ...w.config, materialize: async (_root, commit, destination) => { await writeFile(join(destination, "eval.js"), `// ${commit}`); await symlink(outside, join(destination, ".rovara-eval-ca")); } });
    await sandbox.run(w.input());
    expect(await readFile(join(outside, "ca.pem"), "utf8")).toBe("UNTOUCHED");
    expect(w.seen[0]!.ca).toBe(w.round.certificatePem);
  });
  it("a sealedDns setting of false cannot leave the vendor names unresolved: a stand-in still seals the round", async () => {
    const w = await world();
    await createFreshEvalSandbox({ ...w.config, sealedDns: false }).run(w.input());
    expect(runArgsOf(w.daemon.calls, "-dns")).toBeDefined();
  });
  it("fails the run when the stand-in will not start, and leaves no container, network or file behind", async () => {
    const w = await world();
    w.stand.failStart = true;
    await expect(w.sandbox.run(w.input())).rejects.toThrow();
    expect(runArgsOf(w.daemon.calls, "-eval")).toBeUndefined();
    expect(w.daemon.containers).toEqual([]); expect(w.daemon.networks).toEqual([]);
    expect(leftovers(w)).toEqual([]);
  });
  it("stops the stand-in when the eval fails", async () => {
    const failing = await world({ exitCode: 3 });
    await expect(failing.sandbox.run(failing.input())).rejects.toThrow();
    expect(failing.stand.stopped).toBe(1);
    expect(failing.daemon.containers).toEqual([]);
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
  it("still copies the eval's report out of the checkout", async () => {
    const w = await world();
    const result = await w.sandbox.run(w.input());
    expect(JSON.parse(await readFile(join(result.report.root, REPORT.cwd, REPORT.argument), "utf8"))).toEqual({ measures: { version: 1 } });
  });
});

describe("the names and the environment", () => {
  it("writes hosts lines and name-server pairs only for dotted outside names at a plain address", () => {
    expect(evalStandInHostsLines("172.30.7.47", ["a.vendor.test", "b.vendor.test"])).toBe("172.30.7.47 a.vendor.test\n172.30.7.47 b.vendor.test\n");
    expect(evalStandInDnsPairs("172.30.7.47", ["a.vendor.test"])).toEqual(["a.vendor.test=172.30.7.47"]);
    for (const names of [["localhost"], ["redis"], ["a.localhost"], ["10.0.0.1"], ["Not A Host"], ["a.test", "a.test"]]) expect(() => evalStandInHostsLines("172.30.7.47", names), names.join()).toThrow();
    expect(() => evalStandInDnsPairs("not-an-address", ["a.vendor.test"])).toThrow();
    expect(() => evalStandInHostsLines("172.30.7.47", Array.from({ length: 33 }, (_, at) => `h${String(at)}.vendor.test`))).toThrow();
  });
  it("builds the env file with the trust lines only when a certificate path is given", () => {
    const env = freshEvalEnvironment({ rowId: "gemini", token: TOKEN, side: "new", runs: 1, ids: ["q1"], standInCertificate: `${FRESH_EVAL_WORKSPACE}/${EVAL_CA_RELATIVE_PATH}` });
    expect(env.split("\n").filter((line) => line.startsWith("SSL_CERT_FILE="))).toEqual([`SSL_CERT_FILE=${FRESH_EVAL_WORKSPACE}/${EVAL_CA_RELATIVE_PATH}`]);
    expect(freshEvalEnvironment({ rowId: "gemini", token: TOKEN, side: "new", runs: 1, ids: ["q1"] })).not.toContain("SSL_CERT_FILE");
    expect(() => freshEvalEnvironment({ rowId: "gemini", token: TOKEN, side: "new", runs: 1, ids: ["q1"], standInCertificate: "relative.pem" })).toThrow();
  });
});
