// L4-E56 (row E6): the HOSTED stand-in helper's launcher (worker eval-standin-hosted.ts). Nothing starts Docker: a small stateful fake daemon answers the commands the module uses (run, inspect, exec, rm), so the labels, the one
// network the helper is on, the one read-only mount, the binding to one company and task, the retry and the cleanup are checked against behaviour and not only argument lists. The first real proof against Docker is a Linux
// check beside the eval sandbox's own.
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EVAL_STAND_IN_RUN_DIR, EVAL_STAND_IN_SET_PATH, buildOpenApiFake, parseEvalStandInSetBytes, type EvalStandInPlan, type EvalStandInSetContent, type TrustedEvalStandInSummary } from "@agentx/contracts";
import { RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_LABEL, RUN_NETWORK_WORKSPACE_LABEL, runNetworkAddresses, runNetworkHelperIp, runNetworkLabelArgs, runNetworkName } from "../../packages/worker/src/run-network.js";
import {
  EVAL_STAND_IN_ENVIRONMENT, EVAL_STAND_IN_FAILURE_SENTENCE, EVAL_STAND_IN_GRACE_MS, EVAL_STAND_IN_HELPER_ENTRY, evalStandInArgProblems, evalStandInContainerName, evalStandInRunArgs, evalStandInsOffered,
  startEvalStandIns, startEvalStandInsOnce, writeEvalStandInRunFiles, type EvalStandInNetwork,
} from "../../packages/worker/src/eval-standin-hosted.js";
import { createRunCa } from "../../packages/worker/src/run-ca.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

const WORKSPACE = "0b9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c11";
const OPERATION = "7c1f0d3a-2b8e-4a55-8f3b-9a1c2d3e4f50";
const IMAGE = `registry.example.test/worker@sha256:${"b".repeat(64)}`;
const DIGEST = "c".repeat(64);
const SLOT = 5;
const NOW = 1_800_000_000_000;
const LABEL_KEYS = [RUN_NETWORK_LABEL, RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_WORKSPACE_LABEL];
const DOCUMENT = {
  openapi: "3.0.3", info: { title: "tiktok", version: "1" },
  paths: { "/v2/user/info": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", required: ["data"], properties: { data: { type: "object", properties: { display_name: { type: "string" } } } } } } } } } } } },
};
const openapi = buildOpenApiFake(DOCUMENT, "openapi.json");
if (openapi.status !== "built") throw new Error("fixture");
const PLAN: EvalStandInPlan = [{ host: "open.tiktokapis.com", openapi }];

const RUN_ID = "eval-run-1";
const net: EvalStandInNetwork = {
  name: runNetworkName(RUN_ID),
  checkSandboxIp: runNetworkAddresses(SLOT).checkSandboxIp,
  helperIp: (index) => runNetworkHelperIp(SLOT, index),
  labelArgs: () => runNetworkLabelArgs({ runId: RUN_ID, workspace: "0123456789abcdef", createdAt: NOW, expiresAt: NOW + 3_600_000 }),
};
const HELPER = evalStandInContainerName(net);

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const scratch = async (): Promise<string> => { const dir = await mkdtemp(join(tmpdir(), "rovara-es-hosted-")); dirs.push(dir); return dir; };
const content = (): EvalStandInSetContent => ({ workspaceId: WORKSPACE, operationId: OPERATION, plan: PLAN, recorded: [], book: [], ca: createRunCa() });
const values = (args: readonly string[], flag: string) => args.flatMap((arg, index) => (args[index - 1] === flag ? [arg] : []));

interface DaemonOptions {
  /** The first N `docker run` calls fail. */
  failRuns?: number;
  /** Puts the helper on another network too (a daemon that disagrees with the arguments). */
  extraNetwork?: string;
  /** A helper that never writes a readable summary. */
  noSummary?: boolean;
  /** A summary bound to another company. */
  otherCompany?: boolean;
  /** The helper is never running. */
  neverRuns?: boolean;
}
function fakeDaemon(options: DaemonOptions = {}) {
  const calls: string[][] = [];
  let helper: { args: string[]; running: boolean; networks: Map<string, string> } | undefined;
  let runs = 0;
  const ok = (stdout = "") => Promise.resolve({ exitCode: 0, stdout, stderr: "", timedOut: false });
  const fail = (stderr: string) => Promise.resolve({ exitCode: 1, stdout: "", stderr, timedOut: false });
  const docker: DockerCli = {
    run(args) {
      calls.push([...args]);
      if (args[0] === "run") {
        runs += 1;
        if (runs <= (options.failRuns ?? 0)) return fail("boom");
        const networks = new Map<string, string>([[values(args, "--network")[0]!, values(args, "--ip")[0]!]]);
        if (options.extraNetwork !== undefined) networks.set(options.extraNetwork, "172.99.0.2");
        helper = { args: [...args], running: options.neverRuns !== true, networks };
        return ok("cid\n");
      }
      if (args[0] === "inspect") {
        if (helper === undefined) return fail("no such container");
        return ok(`${String(helper.running)}|${JSON.stringify(Object.fromEntries([...helper.networks].map(([name, ip]) => [name, { IPAddress: ip }])))}\n`);
      }
      if (args[0] === "exec") {
        if (helper === undefined || options.noSummary === true) return fail("exec failed");
        const program = helper.args.slice(helper.args.indexOf("--listen"));
        const summary: TrustedEvalStandInSummary = {
          schemaVersion: 1, trusted: true, workspaceId: options.otherCompany === true ? "1c9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c12" : values(program, "--workspace")[0]!, operationId: values(program, "--operation")[0]!, digest: values(program, "--digest")[0]!,
          counts: { recorded: 0, generated: 0, generatedNoContract: 1, newConnections: 0, served: 1, gapCalls: 1, saturated: false }, foreign: 0, refused: 0, tlsFailed: 0, additions: [], gaps: [], newHosts: [],
        };
        return ok(`${JSON.stringify(summary)}\n`);
      }
      if (args[0] === "rm") { helper = undefined; return ok(); }
      return fail("unknown");
    },
  };
  return { docker, calls, helper: () => helper };
}

describe("the launch arguments", () => {
  const input = { net, image: IMAGE, runDir: "/scratch/run-x/standin", digest: DIGEST, workspaceId: WORKSPACE, operationId: OPERATION, lifetimeMs: 3_600_000 };
  const args = evalStandInRunArgs(input);
  const problems = (mutated: string[]) => evalStandInArgProblems(mutated, net, { digest: DIGEST, workspaceId: WORKSPACE, operationId: OPERATION, lifetimeMs: input.lifetimeMs, runDir: input.runDir });
  const replace = (flag: string, value: string, index = 0): string[] => { const out = [...args]; let seen = 0; out.forEach((arg, at) => { if (arg === flag && seen++ === index) out[at + 1] = value; }); return out; };

  it("are one network, one read-only mount, no capability, no port, no env, a non-root user and the round's four labels", () => {
    expect(problems(args)).toEqual([]);
    expect(values(args, "--network")).toEqual([net.name]);
    expect(values(args, "--ip")).toEqual([net.helperIp(0)]);
    expect(values(args, "--volume")).toEqual([`/scratch/run-x/standin:${EVAL_STAND_IN_RUN_DIR}:ro`]);
    expect(values(args, "--cap-drop")).toEqual(["ALL"]);
    expect(values(args, "--user")).toEqual(["1000:1000"]);
    expect(args).toContain("--read-only");
    expect(args.filter((arg) => ["--publish", "-p", "--env", "-e", "--env-file", "--add-host", "--privileged", "--cap-add", "--device", "--pid", "--volumes-from"].includes(arg))).toEqual([]);
    expect(values(args, "--label").map((label) => label.split("=")[0])).toEqual(LABEL_KEYS);
    expect(values(args, "--name")).toEqual([HELPER]);
    expect(args.slice(args.indexOf(IMAGE))).toEqual([IMAGE, EVAL_STAND_IN_HELPER_ENTRY, "--listen", net.helperIp(0), "--caller", net.checkSandboxIp, "--digest", DIGEST, "--workspace", WORKSPACE, "--operation", OPERATION, "--lifetime-ms", "3600000"]);
  });
  it("serve ONE caller (the eval box at .4), listen on the helper's own address (.16), and carry the one namespaced sysctl that lets a non-root helper bind 80 and 443", () => {
    expect(net.checkSandboxIp.endsWith(".4")).toBe(true);
    expect(net.helperIp(0).endsWith(".16")).toBe(true);
    expect(values(args, "--sysctl")).toEqual(["net.ipv4.ip_unprivileged_port_start=0"]);
  });
  it.each([
    ["a second network", [...args.slice(0, 1), "--network", "bridge", ...args.slice(1)]],
    ["a published port", [...args.slice(0, 1), "--publish", "443:443", ...args.slice(1)]],
    ["an added capability", [...args.slice(0, 1), "--cap-add", "NET_ADMIN", ...args.slice(1)]],
    ["a second mount", [...args.slice(0, 1), "--volume", "/var/run/docker.sock:/var/run/docker.sock", ...args.slice(1)]],
    ["an env variable", [...args.slice(0, 1), "--env", "SECRET=1", ...args.slice(1)]],
    ["a host table entry", [...args.slice(0, 1), "--add-host", "x:1.2.3.4", ...args.slice(1)]],
    ["a second sysctl", [...args.slice(0, 1), "--sysctl", "net.ipv4.ip_forward=1", ...args.slice(1)]],
    ["a privileged container", [...args.slice(0, 1), "--privileged", ...args.slice(1)]],
    ["a different sysctl", replace("--sysctl", "net.ipv4.ip_forward=1")],
    ["a writable mount", replace("--volume", `/scratch/run-x/standin:${EVAL_STAND_IN_RUN_DIR}:rw`)],
    ["a mount of another folder", replace("--volume", `/etc:${EVAL_STAND_IN_RUN_DIR}:ro`)],
    ["a different caller", replace("--caller", "172.30.5.3")],
    ["another company", replace("--workspace", "1c9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c12")],
    ["another digest", replace("--digest", "d".repeat(64))],
    ["a longer life", replace("--lifetime-ms", "9999999")],
    ["a different user", replace("--user", "0:0")],
    ["a DNS server", replace("--dns", "8.8.8.8")],
    ["a different address", replace("--ip", "172.30.5.99")],
    ["a log", replace("--log-driver", "json-file")],
    ["more memory", replace("--memory", "8g")],
  ])("are refused with %s", (_name, mutated) => {
    expect(problems(mutated).length).toBeGreaterThan(0);
  });
  it("are refused when a label is missing or twice, and for an unplain input", () => {
    const withoutLabel = [...args]; const at = withoutLabel.indexOf("--label"); withoutLabel.splice(at, 2);
    expect(problems(withoutLabel).length).toBeGreaterThan(0);
    expect(() => evalStandInRunArgs({ ...input, runDir: "/scratch/../etc/standin" })).toThrow();
    expect(() => evalStandInRunArgs({ ...input, runDir: "/scratch/run-x/other" })).toThrow();
    expect(() => evalStandInRunArgs({ ...input, image: "worker:latest" })).toThrow();
    expect(() => evalStandInRunArgs({ ...input, digest: "nope" })).toThrow();
    expect(() => evalStandInRunArgs({ ...input, workspaceId: "company" })).toThrow();
    expect(() => evalStandInRunArgs({ ...input, lifetimeMs: 5 })).toThrow();
    expect(() => evalStandInRunArgs({ ...input, net: { ...net, name: "bridge" } })).toThrow();
  });
});

describe("the run files", () => {
  it("hold the set in a read-only-mountable folder: the plan, the binding and the authority, readable by the helper and nobody's secret", async () => {
    const parent = await scratch();
    const body = content();
    const files = (await writeEvalStandInRunFiles({ parent, content: body }))!;
    expect(files.runDir).toBe(join(parent, "standin"));
    const file = join(files.runDir, EVAL_STAND_IN_SET_PATH.slice(EVAL_STAND_IN_RUN_DIR.length + 1));
    expect((await stat(files.runDir)).mode & 0o777).toBe(0o755);
    expect((await stat(file)).mode & 0o777).toBe(0o644);
    expect(await readdir(files.runDir)).toEqual(["set.json"]);
    const parsed = parseEvalStandInSetBytes(await readFile(file), { digest: files.digest, workspaceId: WORKSPACE, operationId: OPERATION })!;
    expect(parsed.plan[0]!.host).toBe("open.tiktokapis.com");
    expect(parsed.ca.keyPem).toBe(body.ca.keyPem);
  });
  it("lose the repository's recordings, not the stand-in, when the set would be past its size limit", async () => {
    const parent = await scratch();
    const huge = Array.from({ length: 2_000 }, (_, at) => ({ method: "GET" as const, host: "a.test", path: `/p/${String(at)}`, query: "", status: 200, contentType: "text/plain", body: "x".repeat(8_000) }));
    const files = (await writeEvalStandInRunFiles({ parent, content: { ...content(), recorded: huge, book: Array.from({ length: 1_500 }, (_, at) => ({ key: at.toString(16).padStart(64, "0"), status: 200, contentType: "text/plain", body: "y".repeat(8_000), cls: "generated" as const })) } }))!;
    expect(files).toBeDefined();
    const parsed = parseEvalStandInSetBytes(await readFile(join(files.runDir, "set.json")), { digest: files.digest, workspaceId: WORKSPACE, operationId: OPERATION })!;
    expect(parsed.recorded).toEqual([]);
    expect(parsed.book).toHaveLength(1_500);
    expect(await writeEvalStandInRunFiles({ parent: await scratch(), content: { ...content(), recorded: [], book: Array.from({ length: 1_500 }, (_, at) => ({ key: at.toString(16).padStart(64, "0"), status: 200, contentType: "text/plain", body: "y".repeat(8_000 * 2), cls: "generated" as const })) } })).toBeUndefined();
  });
  it("are not written for a set that cannot be stored", async () => {
    expect(await writeEvalStandInRunFiles({ parent: await scratch(), content: { ...content(), plan: [{ host: "Not A Host" }] } })).toBeUndefined();
  });
});

describe("starting the helper", () => {
  it("runs the helper on the round network only, waits until its first summary is bound to this company, task and digest, and gives its address", async () => {
    const daemon = fakeDaemon();
    const started = await startEvalStandInsOnce({ docker: daemon.docker, image: IMAGE, net, parent: await scratch(), content: content(), roundBudgetMs: 600_000, sleep: async () => undefined });
    expect(started.address).toBe(net.helperIp(0));
    const run = daemon.calls.find((call) => call[0] === "run")!;
    expect(values(run, "--lifetime-ms")).toEqual([String(600_000 + EVAL_STAND_IN_GRACE_MS)]);
    expect(daemon.calls.map((call) => call[0])).toEqual(["run", "inspect", "exec"]);
    const summary = await started.summary();
    expect(summary).toMatchObject({ trusted: true, counts: { gapCalls: 1 } });
    await started.stop();
    expect(daemon.helper()).toBeUndefined();
  });
  it("never puts the authority's key on a command line", async () => {
    const daemon = fakeDaemon();
    const body = content();
    const started = await startEvalStandInsOnce({ docker: daemon.docker, image: IMAGE, net, parent: await scratch(), content: body, roundBudgetMs: 600_000, sleep: async () => undefined });
    expect(JSON.stringify(daemon.calls)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(daemon.calls)).not.toContain(body.ca.keyPem.slice(40, 80));
    await started.stop();
  });
  it("removes the helper and the run files when it will not start, and says one fixed sentence", async () => {
    for (const options of [{ failRuns: 9 }, { neverRuns: true }, { noSummary: true }, { otherCompany: true }, { extraNetwork: "bridge" }] as DaemonOptions[]) {
      const daemon = fakeDaemon(options);
      const parent = await scratch();
      await expect(startEvalStandInsOnce({ docker: daemon.docker, image: IMAGE, net, parent, content: content(), roundBudgetMs: 600_000, sleep: async () => undefined })).rejects.toThrow(EVAL_STAND_IN_FAILURE_SENTENCE);
      expect(daemon.helper()).toBeUndefined();
      expect(await readdir(parent)).toEqual([]);
    }
  });
  it("refuses a helper the daemon put on a network the arguments did not name", async () => {
    const daemon = fakeDaemon({ extraNetwork: "agentx-task" });
    await expect(startEvalStandInsOnce({ docker: daemon.docker, image: IMAGE, net, parent: await scratch(), content: content(), roundBudgetMs: 600_000, sleep: async () => undefined })).rejects.toThrow(EVAL_STAND_IN_FAILURE_SENTENCE);
  });
  it("tries once more when the first start fails (a Rovara problem, not the customer's), and gives up after the second", async () => {
    const once = fakeDaemon({ failRuns: 1 });
    const started = await startEvalStandIns({ docker: once.docker, image: IMAGE, net, parent: await scratch(), content: content(), roundBudgetMs: 600_000, sleep: async () => undefined });
    expect(once.calls.filter((call) => call[0] === "run")).toHaveLength(2);
    await started.stop();
    const twice = fakeDaemon({ failRuns: 2 });
    await expect(startEvalStandIns({ docker: twice.docker, image: IMAGE, net, parent: await scratch(), content: content(), roundBudgetMs: 600_000, sleep: async () => undefined })).rejects.toThrow(EVAL_STAND_IN_FAILURE_SENTENCE);
    expect(twice.calls.filter((call) => call[0] === "run")).toHaveLength(2);
  });
  it("reads no summary from a helper whose answer is for another company", async () => {
    const daemon = fakeDaemon();
    const started = await startEvalStandInsOnce({ docker: daemon.docker, image: IMAGE, net, parent: await scratch(), content: content(), roundBudgetMs: 600_000, sleep: async () => undefined });
    const other = fakeDaemon({ otherCompany: true });
    const wrong = await startEvalStandInsOnce({ docker: other.docker, image: IMAGE, net, parent: await scratch(), content: content(), roundBudgetMs: 600_000, sleep: async () => undefined }).catch(() => undefined);
    expect(wrong).toBeUndefined();
    await started.stop();
  });
});

describe("the operator's switch", () => {
  it("is off unless it says 1 and the image is pinned", () => {
    expect(evalStandInsOffered({}, IMAGE)).toBe(false);
    expect(evalStandInsOffered({ [EVAL_STAND_IN_ENVIRONMENT]: "0" }, IMAGE)).toBe(false);
    expect(evalStandInsOffered({ [EVAL_STAND_IN_ENVIRONMENT]: "1" }, "worker:latest")).toBe(false);
    expect(evalStandInsOffered({ [EVAL_STAND_IN_ENVIRONMENT]: "1" }, IMAGE)).toBe(true);
  });
});
