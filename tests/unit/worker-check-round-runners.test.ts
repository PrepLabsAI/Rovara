// Slice 1, s1-sealed T1: the sealed check round (check-round-runners.ts). Deferred checks TS-SEAL-3 (the check sandbox starts only through startCheckSandbox inside withDetachedWorking) and the
// run's variables (an env file, last, never an argument). Nothing starts Docker: a fake CLI records every call and plays the check sandbox.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSandboxPlan, type CheckSandboxInput, type CheckSandboxPlan } from "../../packages/worker/src/check-sandbox.js";
import { sealedContainerExec, runSealedCheckRound, withSealedCheckRound } from "../../packages/worker/src/check-round-runners.js";
import { TEST_SERVICES_DEVCONTAINER_SENTENCE, assertSealedNetworkMembers, refuseTestServicesWithDevcontainer } from "../../packages/worker/src/check-round-runners.js";
import { runNetworkAddresses, runNetworkHelperIp, runNetworkLabelArgs, runNetworkName } from "../../packages/worker/src/run-network.js";
import { buildServiceEnvironment, createRunDirectoryFiles, createServiceRedactor, type ServiceEnvironment } from "../../packages/worker/src/service-env.js";
import { helperContainerName, type HelperFiles } from "../../packages/worker/src/service-helpers.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import { AGENTX_GIT_IDENTITY_ENVIRONMENT } from "../../packages/worker/src/git.js";
import { createCheckRunners, planChecks, runChecks } from "../../packages/worker/src/verification/checks.js";

const RUN = "22222222-2222-4222-8222-222222222222";
const SLOT = 7;
const NET = runNetworkName(RUN);
const WORK = "agentx-task-t1-abcd1234";
/** The working sandbox's own (working-phase) services network: it lives here during the whole task and never joins a round's network. */
const WORKNET = runNetworkName("44444444-4444-4444-8444-444444444444");
const PASSWORD = ["Zq8Wv3Lm9", "Xc2Rt5"].join("");
const MINUTE = 60_000;

let dir: string;
let rootPath: string;
let files: HelperFiles & { directory: string };
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "sealed-round-")));
  rootPath = join(dir, "workspace");
  await mkdir(rootPath);
  await mkdir(join(rootPath, "pkg"));
  files = await createRunDirectoryFiles(dir, "run-files");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function environment(): ServiceEnvironment {
  return buildServiceEnvironment({
    sandbox: "check", sinkholeUrl: "http://sinkhole", neverValues: [],
    dependencies: [{
      id: "postgres", host: "postgres", port: 5432, credentials: { user: "app", password: PASSWORD, database: "app" },
      connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], hostAliases: ["postgres"] },
    }],
  });
}
function plan(): CheckSandboxPlan {
  return checkSandboxPlan(planInput());
}
function planInput(): CheckSandboxInput {
  const addresses = runNetworkAddresses(SLOT);
  const input: CheckSandboxInput = {
    net: {
      name: NET, slot: SLOT, subnet: addresses.subnet, dnsHelperIp: addresses.dnsHelperIp, workingSandboxIp: addresses.workingSandboxIp, checkSandboxIp: addresses.checkSandboxIp,
      labelArgs: () => runNetworkLabelArgs({ runId: RUN, workspace: "0123456789abcdef", createdAt: 1_800_000_000_000, expiresAt: 1_800_000_900_000 }),
    },
    taskId: "t1", image: "worker:img", guardImage: `registry.example.test/agentx/worker@sha256:${"c".repeat(64)}`, rootPath, maskedPaths: [], filesDir: files.directory, helpers: [{ alias: "postgres", address: runNetworkHelperIp(SLOT, 1) }], sinkholeIp: runNetworkHelperIp(SLOT, 0),
    workingSandboxName: WORK,
  };
  return input;
}

interface ExecSeen { args: string[]; envFile?: { path: string; text: string; mode: number }; command: string[]; envFlags: string[] }
interface FakeOptions {
  /** What the check sandbox answers to one command (the part after the container name). */
  answer?: (seen: ExecSeen) => { exitCode: number; stdout?: string; stderr?: string } | Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
  removeFails?: boolean;
  startExit?: number; guardExit?: number;
  /** Containers on the services network besides the DNS helper, the helper and the check sandbox: name and address. */
  extraMembers?: Array<{ name: string; address: string }>;
  /** What `network inspect` says instead of the real membership (an unreadable answer). */
  inspectAnswer?: { exitCode: number; stdout: string };
  /** `docker pause` of the working sandbox answers with this exit code (default 0). */
  pauseExit?: number;
  /** The old single-network shape: the working sandbox starts on the round's network (only the detach tests that need a relay use it). */
  workingStartsOnRound?: boolean;
  /** The extra members only appear once the check sandbox is up. */
  extraAfterStart?: boolean;
  /** A check sandbox that is on the network at the wrong address. */
  sandboxAddress?: string;
}
/** A docker that remembers the working sandbox's networks and whether the check sandbox is up, and logs every call in order. */
function fakeDocker(sandboxName: string, options: FakeOptions = {}) {
  const calls: string[][] = [];
  const execs: ExecSeen[] = [];
  const state = { workingNetworks: options.workingStartsOnRound === true ? [NET, "agentx-task"] : [WORKNET, "agentx-task"], sandboxUp: false, paused: false };
  /** The working sandbox's networks after every docker call: the proof that it was never on the round's network. */
  const history: string[][] = [[...[WORKNET, "agentx-task"]]];
  const members = (): Record<string, { Name: string; IPv4Address: string }> => {
    const addresses = runNetworkAddresses(SLOT);
    const out: Record<string, { Name: string; IPv4Address: string }> = {
      dns: { Name: `${NET}-dns`, IPv4Address: `${addresses.dnsHelperIp}/24` },
      pg: { Name: helperContainerName({ name: NET }, "postgres"), IPv4Address: `${runNetworkHelperIp(SLOT, 1)}/24` },
    };
    if (state.workingNetworks.includes(NET)) out["work"] = { Name: WORK, IPv4Address: `${addresses.workingSandboxIp}/24` };
    if (state.sandboxUp) out["check"] = { Name: sandboxName, IPv4Address: `${options.sandboxAddress ?? addresses.checkSandboxIp}/24` };
    for (const [index, extra] of (options.extraAfterStart === true && !state.sandboxUp ? [] : options.extraMembers ?? []).entries()) out[`x${String(index)}`] = { Name: extra.name, IPv4Address: `${extra.address}/24` };
    return out;
  };
  const handle = async (args: readonly string[]) => {
      calls.push([...args]);
      const [verb, second] = args;
      if (verb === "network" && second === "disconnect") { state.workingNetworks = state.workingNetworks.filter((name) => name !== args[2]); return { exitCode: 0, stdout: "", stderr: "" }; }
      if (verb === "network" && second === "connect") { state.workingNetworks = [...state.workingNetworks, args[args.length - 2]!]; return { exitCode: 0, stdout: "", stderr: "" }; }
      if (verb === "pause") { if ((options.pauseExit ?? 0) === 0) state.paused = true; return { exitCode: options.pauseExit ?? 0, stdout: "", stderr: "" }; }
      if (verb === "unpause") { state.paused = false; return { exitCode: 0, stdout: "", stderr: "" }; }
      if (verb === "network" && second === "inspect") return options.inspectAnswer === undefined ? { exitCode: 0, stdout: JSON.stringify(members()), stderr: "" } : { ...options.inspectAnswer, stderr: "" };
      if (verb === "inspect") return { exitCode: 0, stdout: JSON.stringify(Object.fromEntries(state.workingNetworks.map((name) => [name, {}]))), stderr: "" };
      if (verb === "run" && args.includes("NET_ADMIN")) return { exitCode: options.guardExit ?? 0, stdout: "", stderr: "" };
      if (verb === "run") { state.sandboxUp = (options.startExit ?? 0) === 0; return { exitCode: options.startExit ?? 0, stdout: "sandbox-id\n", stderr: "" }; }
      if (verb === "rm") { if (options.removeFails !== true) state.sandboxUp = false; return { exitCode: 0, stdout: "", stderr: "" }; }
      if (verb === "container" && second === "inspect") return { exitCode: state.sandboxUp ? 0 : 1, stdout: state.sandboxUp ? "sandbox-id\n" : "", stderr: "" };
      if (verb === "exec") {
        const at = args.indexOf(sandboxName);
        const before = args.slice(1, at);
        const envFileAt = before.indexOf("--env-file");
        const envFilePath = envFileAt >= 0 ? before[envFileAt + 1] : undefined;
        const seen: ExecSeen = {
          args: [...args], command: args.slice(at + 1),
          envFlags: before.flatMap((arg, index) => (before[index - 1] === "--env" ? [arg] : [])),
          ...(envFilePath === undefined ? {} : { envFile: { path: envFilePath, text: readFileSync(envFilePath, "utf8"), mode: statSync(envFilePath).mode & 0o777 } }),
        };
        // The stop sequence's own execs (TERM, KILL) are not commands of the round.
        if (seen.command[2]?.includes("kill")) return { exitCode: 0, stdout: "", stderr: "" };
        execs.push(seen);
        const answered: NonNullable<FakeOptions["answer"]> = options.answer ?? (() => ({ exitCode: 0, stdout: "ok\n" }));
        const answer = await answered(seen);
        return { exitCode: answer.exitCode, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected" };
  };
  const docker: DockerCli = { run: async (args) => { const result = await handle(args); history.push([...state.workingNetworks]); return result; } };
  return { docker, calls, execs, state, history };
}
const verbs = (calls: string[][]) => calls.map((call) => (call[0] === "network" ? `network ${call[1]}` : call[0] === "container" ? "container inspect" : call[0]!));

function roundInput(docker: DockerCli, p: CheckSandboxPlan, extra: Partial<Parameters<typeof withSealedCheckRound>[0]> = {}): Parameters<typeof withSealedCheckRound>[0] {
  return { docker, plan: p, hasDevcontainer: false, workingPhaseNetwork: { name: WORKNET, ip: "172.30.9.3" }, rootPath, files, environment: environment(), redactor: createServiceRedactor([PASSWORD]), ...extra };
}
const command = (executable: string, args: string[] = [], env?: Record<string, string>) => ({ cwd: ".", executable, args, timeoutSeconds: 60, ...(env === undefined ? {} : { env }) });

describe("withSealedCheckRound: the order is the seal (TS-SEAL-3)", () => {
  it("starts the check sandbox, runs the checks in it and removes it; the working sandbox never joins the round's network", async () => {
    const p = plan();
    const { docker, calls, execs } = fakeDocker(p.sandboxName);
    const round = await runSealedCheckRound(roundInput(docker, p), planChecks([command("pytest", ["-q"])], { firstRuns: () => [] }), { budgetMs: 30 * MINUTE, signal: new AbortController().signal });
    expect(round.entries.map((entry) => entry.after)).toEqual(["passed"]);
    const order = verbs(calls);
    expect(order.indexOf("network disconnect")).toBeLessThan(order.indexOf("run"));
    // The proof is read again right before the start, and the start is the plan's own arguments, once.
    // ...and the resolver guard (TS-SEAL-5 b) is the next docker run, before the first command.
    expect(calls.filter((call) => call[0] === "run")).toEqual([p.sandboxRunArgs, p.resolverGuardArgs.insert, p.resolverGuardArgs.verify]);
    expect(order.lastIndexOf("run")).toBeLessThan(order.indexOf("exec"));
    expect(order.lastIndexOf("exec")).toBeLessThan(order.indexOf("rm"));
    expect(calls.filter((call) => call[0] === "network" && call[1] === "connect")).toEqual([]);
    expect(execs).toHaveLength(1);
  });

  it("every check, project command and agent replay, goes into the check sandbox; none into the working sandbox", async () => {
    const p = plan();
    const { docker, calls, execs } = fakeDocker(p.sandboxName);
    const checks = planChecks(undefined, { firstRuns: () => [{ order: 0, command: "pytest -q", replay: "pytest -q", exitCode: 0, afterFirstEdit: false, output: "" }, { order: 1, command: "cd pkg && make test", replay: "cd pkg && make test", exitCode: 0, afterFirstEdit: false, output: "" }] });
    const round = await runSealedCheckRound(roundInput(docker, p), checks, { budgetMs: 30 * MINUTE, signal: new AbortController().signal });
    expect(round.entries.map((entry) => entry.after)).toEqual(["passed", "passed"]);
    expect(execs).toHaveLength(2);
    for (const call of calls.filter((entry) => entry[0] === "exec")) {
      expect(call).toContain(p.sandboxName);
      expect(call).not.toContain(WORK);
    }
    // The replay of `cd pkg && make test` runs `make test` from the contained directory.
    expect(execs[1]!.command[4]).toBe(join(rootPath, "pkg"));
    expect(execs[1]!.command.at(-1)).toBe("make test");
  });

  it("the check sandbox is gone and the working sandbox is still off the round network when the round throws", async () => {
    const p = plan();
    const { docker, calls, state } = fakeDocker(p.sandboxName);
    await expect(withSealedCheckRound(roundInput(docker, p), () => Promise.reject(new Error("round failed")))).rejects.toThrow("round failed");
    expect(state.sandboxUp).toBe(false);
    expect(state.workingNetworks).toContain(WORKNET);
    expect(state.workingNetworks).not.toContain(NET);
    expect(verbs(calls)).not.toContain("network connect");
  });

  it("the working sandbox stays off the round network when the round is cancelled mid-check, and nothing runs after", async () => {
    const p = plan();
    const controller = new AbortController();
    const { docker, calls, state } = fakeDocker(p.sandboxName, { answer: () => { controller.abort(); return { exitCode: 143 }; } });
    const round = await runSealedCheckRound(roundInput(docker, p), planChecks([command("sleep", ["30"]), command("true")], { firstRuns: () => [] }), { budgetMs: 30 * MINUTE, signal: controller.signal });
    expect(round.stopped).toBe(true);
    expect(round.entries.map((entry) => entry.after)).toEqual(["not_run", "not_run"]);
    expect(state.sandboxUp).toBe(false);
    expect(state.workingNetworks).not.toContain(NET);
    expect(verbs(calls).filter((verb) => verb === "run")).toHaveLength(3);
  });

  it("does not run the round at all when the working sandbox cannot be proved off the network", async () => {
    const p = plan();
    const { docker, calls } = fakeDocker(p.sandboxName);
    const stuck: DockerCli = { run: (args) => (args[0] === "inspect" ? Promise.resolve({ exitCode: 0, stdout: JSON.stringify({ [NET]: {}, "agentx-task": {} }), stderr: "" }) : docker.run(args)) };
    let ran = false;
    await expect(withSealedCheckRound(roundInput(stuck, p), () => { ran = true; return Promise.resolve(); })).rejects.toThrow(/still on the run's services network/u);
    expect(ran).toBe(false);
    expect(calls.filter((call) => call[0] === "run")).toEqual([]);
  });

  it("does not run the round when the check sandbox cannot start, and the working sandbox never joined the round network", async () => {
    const p = plan();
    const { docker, state } = fakeDocker(p.sandboxName, { startExit: 125 });
    let ran = false;
    await expect(withSealedCheckRound(roundInput(docker, p), () => { ran = true; return Promise.resolve(); })).rejects.toThrow(/could not be started/u);
    expect(ran).toBe(false);
    expect(state.workingNetworks).not.toContain(NET);
  });

  it("leaves the working sandbox detached, and throws, when the check sandbox cannot be removed", async () => {
    const p = plan();
    const { docker, state } = fakeDocker(p.sandboxName, { removeFails: true });
    await expect(withSealedCheckRound(roundInput(docker, p), () => Promise.resolve("done"))).rejects.toThrow(/could not be removed/u);
    expect(state.workingNetworks).not.toContain(NET);
  });

  it("fails closed when the resolver guard fails (TS-SEAL-5 b): no check, no helper reset, no command runs in the sandbox, the sandbox is removed and the working sandbox is back", async () => {
    const p = plan();
    const { docker, calls, execs, state } = fakeDocker(p.sandboxName, { guardExit: 1 });
    let reset = false;
    const input = roundInput(docker, p, { freshServices: () => { reset = true; return Promise.resolve(); } });
    await expect(runSealedCheckRound(input, planChecks([command("true")], { firstRuns: () => [] }), { budgetMs: 30 * MINUTE, signal: new AbortController().signal })).rejects.toThrow(/embedded resolver could not be closed/u);
    expect(execs).toEqual([]);
    expect(reset).toBe(false);
    expect(verbs(calls)).not.toContain("exec");
    expect(calls.filter((call) => call[0] === "run")).toEqual([p.sandboxRunArgs, p.resolverGuardArgs.insert]);
    expect(state.sandboxUp).toBe(false);
    expect(state.workingNetworks).toContain(WORKNET);
    expect(state.paused).toBe(false);
  });

  it("passes the round's abort signal to the resolver guard's docker calls: through runSealedCheckRound's options, and through the setup's own signal (low-1)", async () => {
    const p = plan();
    const controller = new AbortController();
    for (const mode of ["options", "setup"] as const) {
      const fake = fakeDocker(p.sandboxName);
      const seen: Array<AbortSignal | undefined> = [];
      const docker: DockerCli = { run: (args, options) => { if (args.includes("NET_ADMIN")) seen.push(options?.signal); return fake.docker.run(args, options); } };
      const input = roundInput(docker, p, mode === "setup" ? { signal: controller.signal } : {});
      await runSealedCheckRound(input, planChecks([command("true")], { firstRuns: () => [] }), { budgetMs: 30 * MINUTE, signal: mode === "options" ? controller.signal : new AbortController().signal });
      expect(seen, mode).toHaveLength(2);
      for (const signal of seen) expect(signal, mode).toBe(controller.signal);
    }
  });

  it("each round is its own: a second call starts a second check sandbox after the first was removed (the TESTPROOF rerun)", async () => {
    const p = plan();
    const { docker, calls } = fakeDocker(p.sandboxName);
    const input = roundInput(docker, p);
    for (let index = 0; index < 2; index += 1) await runSealedCheckRound(input, planChecks([command("true")], { firstRuns: () => [] }), { budgetMs: 30 * MINUTE, signal: new AbortController().signal });
    expect(verbs(calls).filter((verb) => verb === "run")).toHaveLength(6);
    expect(verbs(calls).filter((verb) => verb === "rm")).toHaveLength(2);
    expect(verbs(calls)).not.toContain("network connect");
  });

  it("puts the helpers back (freshServices) only after the working sandbox is gone and the check sandbox is up, before the first check", async () => {
    const p = plan();
    const { docker, calls } = fakeDocker(p.sandboxName);
    const seen: string[] = [];
    const input = roundInput(docker, p, { freshServices: () => { seen.push(verbs(calls).join(",")); return Promise.resolve(); } });
    await runSealedCheckRound(input, planChecks([command("true")], { firstRuns: () => [] }), { budgetMs: 30 * MINUTE, signal: new AbortController().signal });
    expect(seen).toEqual(["network disconnect,inspect,pause,network inspect,inspect,run,run,run,network inspect"]);
  });

  it("looks at the services network itself before and after the start", async () => {
    const p = plan();
    const { docker, calls } = fakeDocker(p.sandboxName);
    await runSealedCheckRound(roundInput(docker, p), planChecks([command("true")], { firstRuns: () => [] }), { budgetMs: 30 * MINUTE, signal: new AbortController().signal });
    const order = verbs(calls);
    const inspects = order.flatMap((verb, index) => (verb === "network inspect" ? [index] : []));
    expect(inspects).toHaveLength(2);
    expect(inspects[0]!).toBeLessThan(order.indexOf("run"));
    expect(inspects[1]!).toBeGreaterThan(order.indexOf("run"));
    expect(inspects[1]!).toBeLessThan(order.indexOf("exec"));
    expect(calls.filter((call) => call[0] === "network" && call[1] === "inspect")[0]).toEqual(["network", "inspect", "--format", "{{json .Containers}}", NET]);
  });

  it("does not trust the name the caller gave for the working sandbox: the real one still on the network stops the round before the check sandbox starts", async () => {
    const p = checkSandboxPlan({ ...planInput(), workingSandboxName: "some-other-container" });
    const { docker, calls, state } = fakeDocker(p.sandboxName, { extraMembers: [{ name: WORK, address: runNetworkAddresses(SLOT).workingSandboxIp }] });
    state.workingNetworks = ["agentx-task"];
    let ran = false;
    await expect(withSealedCheckRound(roundInput(docker, p), () => { ran = true; return Promise.resolve(); })).rejects.toThrow(/does not expect/u);
    expect(ran).toBe(false);
    expect(calls.filter((call) => call[0] === "run")).toEqual([]);
    expect(calls.filter((call) => call[0] === "rm")).toHaveLength(1);
  });

  it("fails closed and tears down when something else is on the network, before the start or after it", async () => {
    const p = plan();
    const extras = [{ name: "squatter", address: "172.30.7.99" }, { name: WORK, address: runNetworkAddresses(SLOT).workingSandboxIp }, { name: `${NET}-h0123456789`, address: "172.30.7.200" }];
    for (const extraAfterStart of [false, true]) {
      for (const extra of extras) {
        const { docker, calls, state } = fakeDocker(p.sandboxName, { extraMembers: [extra], extraAfterStart });
        let ran = false;
        await expect(withSealedCheckRound(roundInput(docker, p), () => { ran = true; return Promise.resolve(); }), `${extra.name} ${String(extraAfterStart)}`).rejects.toThrow(/does not expect/u);
        expect(ran).toBe(false);
        // Before the start nothing was run; after it the sandbox is removed. Either way the working sandbox is on its working-phase network and was never connected to the round's.
        expect(calls.filter((call) => call[0] === "run")).toHaveLength(extraAfterStart ? 3 : 0);
        expect(state.sandboxUp).toBe(false);
        expect(state.workingNetworks).toContain(WORKNET);
        expect(verbs(calls)).not.toContain("network connect");
      }
    }
  });

  it("assertSealedNetworkMembers: the exact membership passes; a missing DNS helper, a doubled or misplaced check sandbox, and an unreadable list do not", async () => {
    const p = plan();
    const ok = fakeDocker(p.sandboxName);
    ok.state.workingNetworks = ["agentx-task"];
    await expect(assertSealedNetworkMembers(ok.docker, p, "before_start")).resolves.toBeUndefined();
    await expect(assertSealedNetworkMembers(ok.docker, p, "after_start")).rejects.toThrow(/does not expect/u);
    ok.state.sandboxUp = true;
    await expect(assertSealedNetworkMembers(ok.docker, p, "after_start")).resolves.toBeUndefined();
    // The check sandbox before its start is not expected.
    await expect(assertSealedNetworkMembers(ok.docker, p, "before_start")).rejects.toThrow(/does not expect/u);
    const wrongAddress = fakeDocker(p.sandboxName, { sandboxAddress: "172.30.7.77" });
    wrongAddress.state.sandboxUp = true;
    await expect(assertSealedNetworkMembers(wrongAddress.docker, p, "after_start")).rejects.toThrow(/does not expect/u);
    for (const answer of [{ exitCode: 1, stdout: "" }, { exitCode: 0, stdout: "not json" }, { exitCode: 0, stdout: "[]" }, { exitCode: 0, stdout: "null" }, { exitCode: 0, stdout: "{\"a\":{\"Name\":1}}" }]) {
      const { docker } = fakeDocker(p.sandboxName, { inspectAnswer: answer });
      await expect(assertSealedNetworkMembers(docker, p, "before_start"), JSON.stringify(answer)).rejects.toThrow();
    }
  });

  it("the working sandbox is NEVER on a round network, at any moment of a round: success, failure, cancel, start failure", async () => {
    const p = plan();
    const scenarios: Array<[string, () => Promise<unknown>, ReturnType<typeof fakeDocker>]> = [];
    const ok = fakeDocker(p.sandboxName);
    scenarios.push(["success", () => runSealedCheckRound(roundInput(ok.docker, p), planChecks([command("true")], { firstRuns: () => [] }), { budgetMs: 30 * MINUTE, signal: new AbortController().signal }), ok]);
    const failed = fakeDocker(p.sandboxName);
    scenarios.push(["failure", () => withSealedCheckRound(roundInput(failed.docker, p), () => Promise.reject(new Error("x"))).catch(() => undefined), failed]);
    const controller = new AbortController();
    const cancelled = fakeDocker(p.sandboxName, { answer: () => { controller.abort(); return { exitCode: 143 }; } });
    scenarios.push(["cancel", () => runSealedCheckRound(roundInput(cancelled.docker, p), planChecks([command("sleep", ["9"])], { firstRuns: () => [] }), { budgetMs: 30 * MINUTE, signal: controller.signal }), cancelled]);
    const noStart = fakeDocker(p.sandboxName, { startExit: 125 });
    scenarios.push(["start failure", () => withSealedCheckRound(roundInput(noStart.docker, p), () => Promise.resolve()).catch(() => undefined), noStart]);
    for (const [name, run, fake] of scenarios) {
      await run();
      expect(fake.history.length, name).toBeGreaterThan(2);
      for (const networks of fake.history) expect(networks, name).not.toContain(NET);
      expect(fake.calls.filter((call) => call[0] === "network" && call[1] === "connect" && call.includes(NET)), name).toEqual([]);
      expect(fake.state.workingNetworks, name).toContain(WORKNET);
    }
  });

  it("puts the working sandbox back on its working-phase network, at its address, only if it is missing there", async () => {
    const p = plan();
    const { docker, calls, state, history } = fakeDocker(p.sandboxName);
    state.workingNetworks = ["agentx-task"];
    await withSealedCheckRound(roundInput(docker, p), () => Promise.resolve());
    expect(calls.filter((call) => call[0] === "network" && call[1] === "connect")).toEqual([["network", "connect", "--ip", "172.30.9.3", WORKNET, WORK]]);
    for (const networks of history) expect(networks).not.toContain(NET);
    expect(state.workingNetworks).toContain(WORKNET);
  });

  it("refuses, before any Docker call, a working-phase network that is the round's own or not a services network", async () => {
    const p = plan();
    for (const name of [NET, "bridge", "host", "agentx-task", "--privileged"]) {
      const { docker, calls } = fakeDocker(p.sandboxName);
      await expect(withSealedCheckRound(roundInput(docker, p, { workingPhaseNetwork: { name, ip: "172.30.9.3" } }), () => Promise.resolve()), name).rejects.toThrow(/never to a round's network/u);
      expect(calls, name).toEqual([]);
    }
  });

  it("freezes the working sandbox (docker pause) before the check sandbox starts and unfreezes it only after the check sandbox is gone, on every exit path (H3)", async () => {
    const p = plan();
    const check = (name: string, calls: string[][], state: { paused: boolean }, options: { unpaused: boolean }) => {
      const order = verbs(calls);
      expect(order.indexOf("pause"), name).toBeGreaterThan(order.indexOf("network disconnect"));
      expect(order.filter((verb) => verb === "pause"), name).toHaveLength(1);
      const run = order.indexOf("run");
      if (run >= 0) expect(order.indexOf("pause"), name).toBeLessThan(run);
      expect(state.paused, name).toBe(!options.unpaused);
      if (options.unpaused) expect(order.indexOf("unpause"), name).toBeGreaterThan(order.lastIndexOf("rm"));
      expect(calls.find((call) => call[0] === "pause"), name).toEqual(["pause", WORK]);
    };
    const ok = fakeDocker(p.sandboxName);
    await runSealedCheckRound(roundInput(ok.docker, p), planChecks([command("true")], { firstRuns: () => [] }), { budgetMs: 30 * MINUTE, signal: new AbortController().signal });
    check("success", ok.calls, ok.state, { unpaused: true });
    const failed = fakeDocker(p.sandboxName);
    await withSealedCheckRound(roundInput(failed.docker, p), () => Promise.reject(new Error("x"))).catch(() => undefined);
    check("failure", failed.calls, failed.state, { unpaused: true });
    const controller = new AbortController();
    const cancelled = fakeDocker(p.sandboxName, { answer: () => { controller.abort(); return { exitCode: 143 }; } });
    await runSealedCheckRound(roundInput(cancelled.docker, p), planChecks([command("sleep", ["9"])], { firstRuns: () => [] }), { budgetMs: 30 * MINUTE, signal: controller.signal });
    check("cancel", cancelled.calls, cancelled.state, { unpaused: true });
    const noStart = fakeDocker(p.sandboxName, { startExit: 125 });
    await withSealedCheckRound(roundInput(noStart.docker, p), () => Promise.resolve()).catch(() => undefined);
    check("start failure", noStart.calls, noStart.state, { unpaused: true });
    // A sandbox that cannot be removed stays frozen.
    const stuck = fakeDocker(p.sandboxName, { removeFails: true });
    await withSealedCheckRound(roundInput(stuck.docker, p), () => Promise.resolve()).catch(() => undefined);
    check("check sandbox not removed", stuck.calls, stuck.state, { unpaused: false });
    expect(verbs(stuck.calls)).not.toContain("unpause");
  });

  it("fails closed when the pause fails: the round does not run, the check sandbox never starts, and nothing is left frozen", async () => {
    const p = plan();
    const { docker, calls, state } = fakeDocker(p.sandboxName, { pauseExit: 1 });
    let ran = false;
    await expect(withSealedCheckRound(roundInput(docker, p), () => { ran = true; return Promise.resolve(); })).rejects.toThrow(/could not be paused/u);
    expect(ran).toBe(false);
    expect(verbs(calls)).not.toContain("run");
    expect(verbs(calls)).not.toContain("unpause");
    expect(state.paused).toBe(false);
  });

  it("refuses a second round on a plan while the first runs, and allows one again afterwards (also after a failure)", async () => {
    const p = plan();
    const { docker, calls } = fakeDocker(p.sandboxName);
    let release: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => { release = resolve; });
    let inside: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => { inside = resolve; });
    const first = withSealedCheckRound(roundInput(docker, p), async () => { inside(); await holding; return "first"; });
    await entered;
    const before = calls.length;
    await expect(withSealedCheckRound(roundInput(docker, p), () => Promise.resolve("second"))).rejects.toThrow(/already running on this plan/u);
    expect(calls.length).toBe(before);
    release();
    await expect(first).resolves.toBe("first");
    await expect(withSealedCheckRound(roundInput(docker, p), () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(withSealedCheckRound(roundInput(docker, p), () => Promise.resolve("third"))).resolves.toBe("third");
  });

  it("a plan in use does not block another plan (another run)", async () => {
    const p = plan();
    const other = checkSandboxPlan({ ...planInput(), taskId: "t2", net: { ...planInput().net, name: runNetworkName("33333333-3333-4333-8333-333333333333") } });
    expect(other.sandboxName).not.toBe(p.sandboxName);
    const a = fakeDocker(p.sandboxName);
    let release: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => { release = resolve; });
    let inside: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => { inside = resolve; });
    const first = withSealedCheckRound(roundInput(a.docker, p), async () => { inside(); await holding; });
    await entered;
    // A different plan reaches its own checks (its fake network is not this run's, so it stops at the network look, not at the lock).
    await expect(withSealedCheckRound(roundInput(fakeDocker(other.sandboxName).docker, other), () => Promise.resolve())).rejects.not.toThrow(/already running/u);
    release();
    await first;
  });

  it("refuses a project with a dev container before any Docker call (not available yet)", async () => {
    const p = plan();
    const { docker, calls } = fakeDocker(p.sandboxName);
    await expect(withSealedCheckRound(roundInput(docker, p, { hasDevcontainer: true }), () => Promise.resolve())).rejects.toThrow(TEST_SERVICES_DEVCONTAINER_SENTENCE);
    expect(calls).toEqual([]);
    expect(() => refuseTestServicesWithDevcontainer({ dependencies: [{}], devcontainer: true })).toThrow(TEST_SERVICES_DEVCONTAINER_SENTENCE);
    expect(() => refuseTestServicesWithDevcontainer({ dependencies: 2, devcontainer: true })).toThrow(/not available yet/u);
    expect(() => refuseTestServicesWithDevcontainer({ dependencies: [], devcontainer: true })).not.toThrow();
    expect(() => refuseTestServicesWithDevcontainer({ dependencies: 3, devcontainer: false })).not.toThrow();
    // And the lock is not taken by a refused round.
    await expect(withSealedCheckRound(roundInput(docker, p), () => Promise.resolve("ok"))).resolves.toBe("ok");
  });
});

describe("the sealed exec: the run's variables are a file, last, and never on the command line", () => {
  it("writes the variables to a 0600 env file for the exec, passes only its path, and removes it afterwards", async () => {
    const p = plan();
    const { docker, execs } = fakeDocker(p.sandboxName);
    await runSealedCheckRound(roundInput(docker, p), planChecks([command("pytest")], { firstRuns: () => [] }), { budgetMs: 30 * MINUTE, signal: new AbortController().signal });
    const seen = execs[0]!;
    expect(seen.envFile!.mode).toBe(0o600);
    expect(seen.envFile!.text).toBe(`DATABASE_URL=postgres://app:${PASSWORD}@postgres:5432/app\n`);
    expect(seen.envFile!.path.startsWith(files.directory)).toBe(true);
    // The secret is nowhere in any docker argument of the whole round.
    expect(seen.args.join("\0")).not.toContain(PASSWORD);
    expect(existsSync(seen.envFile!.path)).toBe(false);
    expect(readdirSync(files.directory)).toEqual([]);
  });

  it("drops a name the run sets from the command's own env, so the repository cannot win over the channel", async () => {
    const p = plan();
    const { docker, execs } = fakeDocker(p.sandboxName);
    const checks = planChecks([command("pytest", [], { DATABASE_URL: "postgres://evil@attacker.test/x", KEEP_ME: "1" })], { firstRuns: () => [] });
    await runSealedCheckRound(roundInput(docker, p), checks, { budgetMs: 30 * MINUTE, signal: new AbortController().signal });
    const seen = execs[0]!;
    expect(seen.envFlags).toContain("KEEP_ME=1");
    expect(seen.envFlags.some((flag) => flag.startsWith("DATABASE_URL="))).toBe(false);
    expect(seen.args.join("\0")).not.toContain("attacker.test");
    expect(seen.envFile!.text).toContain("DATABASE_URL=postgres://app:");
  });

  it("refuses a command's variable whose name is not a POSIX name, so an `=` or a flag cannot be smuggled into the exec", async () => {
    const p = plan();
    for (const name of ["A=B", "--privileged", "A B", "1ABC", "", "A-B", "É", "A\nB"]) {
      const { docker, execs } = fakeDocker(p.sandboxName);
      const round = await runSealedCheckRound(roundInput(docker, p), planChecks([command("pytest", [], { [name]: "x" })], { firstRuns: () => [] }), { budgetMs: 30 * MINUTE, signal: new AbortController().signal });
      expect(round.entries[0], JSON.stringify(name)).toMatchObject({ after: "failed" });
      expect(execs, JSON.stringify(name)).toEqual([]);
    }
    const { docker, execs } = fakeDocker(p.sandboxName);
    await runSealedCheckRound(roundInput(docker, p), planChecks([command("pytest", [], { _OK_1: "x", lower_ok: "y" })], { firstRuns: () => [] }), { budgetMs: 30 * MINUTE, signal: new AbortController().signal });
    expect(execs[0]!.envFlags).toEqual(expect.arrayContaining(["_OK_1=x", "lower_ok=y"]));
  });

  it("does not copy the worker's own environment into the agent's replay", async () => {
    const p = plan();
    const { docker, execs } = fakeDocker(p.sandboxName);
    process.env["ROVARA_TEST_WORKER_SECRET"] = "worker-only-value-1234";
    try {
      const checks = planChecks(undefined, { firstRuns: () => [{ order: 0, command: "pytest -q", replay: "pytest -q", exitCode: 0, afterFirstEdit: false, output: "" }] });
      await runSealedCheckRound(roundInput(docker, p), checks, { budgetMs: 30 * MINUTE, signal: new AbortController().signal });
    } finally { delete process.env["ROVARA_TEST_WORKER_SECRET"]; }
    expect(execs[0]!.args.join("\0")).not.toContain("worker-only-value-1234");
    // What it does get: the sandbox's Python setting and the AgentX git identity, as the working sandbox's replay does.
    expect(execs[0]!.envFlags).toEqual(expect.arrayContaining([`PYTHONUSERBASE=${join(rootPath, ".agentx-python")}`, ...Object.entries(AGENTX_GIT_IDENTITY_ENVIRONMENT).map(([name, value]) => `${name}=${value}`)]));
  });

  it("an exec after the round is over is refused, so a runner kept by mistake runs nothing", async () => {
    const p = plan();
    const { docker, calls } = fakeDocker(p.sandboxName);
    let kept: ReturnType<typeof createCheckRunners> | undefined;
    await withSealedCheckRound(roundInput(docker, p), (runners) => { kept = runners; return Promise.resolve(); });
    const before = calls.length;
    const result = await runChecks(planChecks([command("true")], { firstRuns: () => [] }), kept!, { budgetMs: 30 * MINUTE, signal: new AbortController().signal });
    expect(result.entries[0]).toMatchObject({ after: "failed" });
    expect(result.entries[0]!.output).toMatch(/not running/u);
    expect(calls.length).toBe(before);
  });

  it("refuses an exec input the sealed round did not make (TS-SEAL-3)", () => {
    for (const container of [plan().sandboxName, "--privileged x", "-v"]) {
      expect(() => sealedContainerExec({ docker: fakeDocker("x").docker, container, files, environment: environment(), live: () => true })).toThrow(/only by a sealed check round/u);
    }
  });

  it("an empty environment passes no env file", async () => {
    const p = plan();
    const { docker, execs } = fakeDocker(p.sandboxName);
    await runSealedCheckRound(roundInput(docker, p, { environment: { entries: [], secretValues: [] } }), planChecks([command("true")], { firstRuns: () => [] }), { budgetMs: 30 * MINUTE, signal: new AbortController().signal });
    expect(execs[0]!.envFile).toBeUndefined();
    expect(execs[0]!.args).not.toContain("--env-file");
  });
});

describe("the sealed runners keep the run's secrets out of what they report", () => {
  it("redacts the password, in any case, from stdout, stderr and the agent's output", async () => {
    const p = plan();
    const { docker } = fakeDocker(p.sandboxName, { answer: () => ({ exitCode: 1, stdout: `connecting as ${PASSWORD}\n`, stderr: `FATAL: password authentication failed for ${PASSWORD.toUpperCase()} / ${PASSWORD.toLowerCase()}\n` }) });
    const checks = planChecks([command("pytest")], { firstRuns: () => [] });
    const readiness = await runSealedCheckRound(roundInput(docker, p), checks, { budgetMs: 30 * MINUTE, signal: new AbortController().signal });
    expect(readiness.entries[0]!.after).toBe("failed");
    expect(readiness.entries[0]!.output.toLowerCase()).not.toContain(PASSWORD.toLowerCase());
    expect(readiness.entries[0]!.output).toContain("<redacted>");
    const replay = planChecks(undefined, { firstRuns: () => [{ order: 0, command: "pytest -q", replay: "pytest -q", exitCode: 0, afterFirstEdit: false, output: "" }] });
    const agent = await runSealedCheckRound(roundInput(docker, p), replay, { budgetMs: 30 * MINUTE, signal: new AbortController().signal });
    expect(JSON.stringify(agent.entries).toLowerCase()).not.toContain(PASSWORD.toLowerCase());
  });

  it("redacts the password from the message of a failed exec", async () => {
    const p = plan();
    const { docker } = fakeDocker(p.sandboxName, { answer: () => { throw new Error(`docker exec failed near ${PASSWORD}`); } });
    const round = await runSealedCheckRound(roundInput(docker, p), planChecks([command("pytest")], { firstRuns: () => [] }), { budgetMs: 30 * MINUTE, signal: new AbortController().signal });
    expect(round.entries[0]).toMatchObject({ after: "failed" });
    expect(JSON.stringify(round.entries)).not.toContain(PASSWORD);
  });
});

describe("the sealed runners have no unsealed fallback", () => {
  it("createCheckRunners has no sealed option: given one it throws instead of running the checks unsealed", () => {
    const sealedOption = { exec: () => Promise.reject(new Error("unused")), redact: (text: string) => text };
    expect(() => createCheckRunners({ rootPath, ...({ sealed: sealedOption } as object) })).toThrow(/only by a sealed check round/u);
    expect(() => createCheckRunners({ rootPath, ...({ sealed: undefined } as object) })).toThrow(/only by a sealed check round/u);
    expect(() => createCheckRunners({ rootPath })).not.toThrow();
  });

  it("still refuses an agent command that is not a simple test command, and a cd that leaves the workspace", async () => {
    const p = plan();
    const { docker, execs } = fakeDocker(p.sandboxName);
    const checks = planChecks(undefined, { firstRuns: () => [
      { order: 0, command: "make test; rm -rf pkg", replay: "make test; rm -rf pkg", exitCode: 0, afterFirstEdit: false, output: "" },
      { order: 1, command: "cd .. && make test", replay: "cd .. && make test", exitCode: 0, afterFirstEdit: false, output: "" },
    ] });
    const round = await runSealedCheckRound(roundInput(docker, p), checks, { budgetMs: 30 * MINUTE, signal: new AbortController().signal });
    expect(round.entries.map((entry) => entry.after)).toEqual(["not_run", "not_run"]);
    expect(execs).toEqual([]);
  });
});
