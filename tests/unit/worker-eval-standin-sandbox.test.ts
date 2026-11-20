// L4-E56: the stand-in on the fresh eval sandbox (`createFreshEvalSandbox` with `standIns`), built on lane E12's sealed name server. Nothing starts Docker: the stateful fake daemon of the sealed eval tests
// (tests/support/fake-eval-sealed-daemon.ts) plays the model helper, the name server and the sandbox, and answers "what can the box reach?" from the arguments alone; the stand-in helper is the `start` seam.
// Every claim has a control: without `standIns` the sandbox is what it was; with it the round is sealed, the planned vendor names are in the hosts file and the name server's table at the SINKHOLE address (where the stand-in sits,
// so every other name is its catch-all), the PUBLIC certificate is in the checkout and the trust variables in the env file, never the key; the sandbox still mounts nothing but its checkout and the name server's two files; a stand-in
// that will not start fails the run and leaves nothing behind.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildOpenApiFake, type EvalStandInPlan, type TrustedEvalStandInSummary } from "@agentx/contracts";
import { EVAL_BRIDGE_SOCKET_NAME, EVAL_HELPER_DIR_NAME, createFreshEvalSandbox, type FreshEvalSandboxConfig, type FreshEvalSandboxRun } from "../../packages/worker/src/verification/eval-bridged-exec.js";
import { EVAL_CA_RELATIVE_PATH } from "../../packages/worker/src/run-ca.js";
import { EvalStandInRound } from "../../packages/worker/src/eval-standin-round.js";
import { EVAL_STAND_IN_HELPER_INDEX, evalStandInDnsPairs, evalStandInHostsLines, type startEvalStandIns, type StartedEvalStandIns } from "../../packages/worker/src/eval-standin-hosted.js";
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

describe("with standIns", () => {
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
});

describe("the names and the environment", () => {
  it("writes hosts lines and name-server pairs only for dotted outside names at a plain address", () => {
    expect(evalStandInHostsLines("172.30.7.47", ["a.vendor.test", "b.vendor.test"])).toBe("172.30.7.47 a.vendor.test\n172.30.7.47 b.vendor.test\n");
    expect(evalStandInDnsPairs("172.30.7.47", ["a.vendor.test"])).toEqual(["a.vendor.test=172.30.7.47"]);
    for (const names of [["localhost"], ["redis"], ["a.localhost"], ["10.0.0.1"], ["Not A Host"], ["a.test", "a.test"]]) expect(() => evalStandInHostsLines("172.30.7.47", names), names.join()).toThrow();
    expect(() => evalStandInDnsPairs("not-an-address", ["a.vendor.test"])).toThrow();
    expect(() => evalStandInHostsLines("172.30.7.47", Array.from({ length: 33 }, (_, at) => `h${String(at)}.vendor.test`))).toThrow();
  });
});
