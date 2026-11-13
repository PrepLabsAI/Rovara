// TE-F3 part B: the hidden eval set's read-only mount in the sealed check sandbox's plan (check-sandbox.ts), and nowhere else. A hidden round runs on its own throwaway copy of the workspace, with the working sandbox PAUSED and the
// pause confirmed. Pure: no Docker is started (a fake docker answers the few calls a start makes).
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkSandboxArgProblems, checkSandboxPlan, checkSandboxRunArgs, detachWorkingSandbox, pauseWorkingSandbox, startCheckSandbox, withDetachedWorking, type CheckSandboxInput, type CheckSandboxNetwork,
} from "../../packages/worker/src/check-sandbox.js";
import { runNetworkAddresses, runNetworkLabelArgs, runNetworkName } from "../../packages/worker/src/run-network.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import { taskSandboxRunArgs } from "../../packages/worker/src/task-sandbox.js";

const RUN = "11111111-1111-4111-8111-111111111111";
const SLOT = 5;
/** The shared task workspace, and the throwaway copy the hidden round runs on. */
const TASK = "/workspace/project";
const COPY = "/workspace/hidden-round-copy";
const HIDDEN = "/srv/rovara/hidden/project-1";
const MOUNT = `${HIDDEN}:/rovara/hidden-eval:ro`;
const GUARD_IMAGE = `registry.example.test/agentx/worker@sha256:${"c".repeat(64)}`;
function network(run = RUN): CheckSandboxNetwork {
  const addresses = runNetworkAddresses(SLOT);
  return { name: runNetworkName(run), slot: SLOT, subnet: addresses.subnet, dnsHelperIp: addresses.dnsHelperIp, workingSandboxIp: addresses.workingSandboxIp, checkSandboxIp: addresses.checkSandboxIp, labelArgs: () => runNetworkLabelArgs({ runId: run, workspace: "0123456789abcdef", createdAt: 1_800_000_000_000, expiresAt: 1_800_000_900_000 }) };
}
const plain = (over: Partial<CheckSandboxInput> = {}): CheckSandboxInput => ({
  net: network(), taskId: "task-1", image: "worker:img", guardImage: GUARD_IMAGE, rootPath: TASK, maskedPaths: ["/workspace/project/.agentx-state"], filesDir: "/run/rovara/check-1", helpers: [], sinkholeIp: runNetworkAddresses(SLOT).subnet.replace(/\.0\/24$/u, ".16"), ...over,
});
/** A hidden round: the sandbox's workspace is the COPY. */
const hiddenInput = (over: Partial<CheckSandboxInput> = {}): CheckSandboxInput => plain({ rootPath: COPY, maskedPaths: [`${COPY}/.agentx-state`], hiddenEvalSetPath: HIDDEN, hiddenRoundWorkspace: { copyPath: COPY, taskWorkspacePath: TASK }, ...over });
const FILES = { resolvConfPath: "/run/rovara/check-1/resolv.conf", hostsPath: "/run/rovara/check-1/hosts" };
const volumes = (args: readonly string[]) => args.flatMap((arg, index) => (args[index - 1] === "--volume" ? [arg] : []));
const paths = { ...FILES, rootPath: COPY, image: "worker:img", maskedPaths: [`${COPY}/.agentx-state`] };

describe("the sealed check sandbox plan with a hidden eval set", () => {
  it("has no hidden mount unless it is asked for: the plan is exactly what it was", () => {
    const plan = checkSandboxPlan(plain());
    expect(volumes(plan.sandboxRunArgs)).toEqual([`${TASK}:${TASK}`, `${FILES.resolvConfPath}:/etc/resolv.conf:ro`, `${FILES.hostsPath}:/etc/hosts:ro`]);
    expect(plan.sandboxRunArgs.join(" ")).not.toContain("hidden-eval");
    expect(plan.mustPauseWorking).toBeUndefined();
  });
  it("mounts the set read-only at one fixed path as a fourth mount, with the throwaway copy as the workspace, and says in the plan that the working sandbox must be paused", () => {
    const plan = checkSandboxPlan(hiddenInput());
    expect(volumes(plan.sandboxRunArgs)).toEqual([`${COPY}:${COPY}`, `${FILES.resolvConfPath}:/etc/resolv.conf:ro`, `${FILES.hostsPath}:/etc/hosts:ro`, MOUNT]);
    expect(plan.hiddenEvalSetPath).toBe(HIDDEN);
    expect(plan.hiddenRoundWorkspace).toEqual({ copyPath: COPY, taskWorkspacePath: TASK });
    expect(plan.mustPauseWorking).toBe(true);
    expect(plan.returnRunnerOutputToAgent).toBe(false);
    expect(plan.sandboxRunArgs.join(" ")).not.toContain(`${TASK}:`);
    expect(checkSandboxArgProblems(plan.sandboxRunArgs, network(), { ...paths, hiddenEvalSetPath: HIDDEN })).toEqual([]);
  });
  it("refuses a hidden mount unless the round has its own throwaway copy of the workspace, and it is the sandbox's workspace and not the task workspace", () => {
    const refuse = (over: Partial<CheckSandboxInput>, reason: RegExp) => expect(() => checkSandboxPlan(hiddenInput(over))).toThrow(reason);
    refuse({ hiddenRoundWorkspace: undefined } as never, /throwaway copy/u);
    // the sandbox mounts the task workspace itself
    refuse({ rootPath: TASK, maskedPaths: [`${TASK}/.agentx-state`] }, /not its throwaway copy/u);
    // the "copy" is the task workspace, inside it, or around it
    refuse({ hiddenRoundWorkspace: { copyPath: COPY, taskWorkspacePath: COPY } }, /task workspace/u);
    refuse({ rootPath: `${TASK}/copy`, maskedPaths: [`${TASK}/copy/.s`], hiddenRoundWorkspace: { copyPath: `${TASK}/copy`, taskWorkspacePath: TASK } }, /task workspace/u);
    refuse({ rootPath: "/workspace", maskedPaths: ["/workspace/.s"], hiddenRoundWorkspace: { copyPath: "/workspace", taskWorkspacePath: TASK } }, /task workspace/u);
    refuse({ hiddenRoundWorkspace: { copyPath: "relative/copy", taskWorkspacePath: TASK } }, /plain absolute/u);
  });
  it("refuses a hidden path that is not a plain absolute path, is inside or around ANY workspace tree (no masked-folder exception), or is the run's own file", () => {
    for (const bad of ["relative/hidden", "/a/../b", "/a b", "/", TASK, `${TASK}/hidden`, COPY, `${COPY}/hidden`, `${COPY}/.agentx-state/hidden`, "/workspace", "/run/rovara/check-1/hosts", "/var/run/docker.sock"]) {
      expect(() => checkSandboxPlan(hiddenInput({ hiddenEvalSetPath: bad })), bad).toThrow(/hidden eval|run file|plain absolute|docker socket|workspace/u);
    }
  });
  it("refuses a hidden path that CONTAINS the copy or the task workspace, each on its own", () => {
    // contains only the copy: the task workspace is elsewhere
    expect(() => checkSandboxPlan(hiddenInput({ hiddenEvalSetPath: "/workspace", hiddenRoundWorkspace: { copyPath: COPY, taskWorkspacePath: "/elsewhere/task" } }))).toThrow(/inside a workspace/u);
    // contains only the task workspace: the copy is elsewhere
    expect(() => checkSandboxPlan(hiddenInput({ rootPath: "/other/copy", maskedPaths: ["/other/copy/.s"], hiddenEvalSetPath: "/workspace", hiddenRoundWorkspace: { copyPath: "/other/copy", taskWorkspacePath: TASK } }))).toThrow(/inside a workspace/u);
    // inside only the copy, inside only the task workspace
    expect(() => checkSandboxPlan(hiddenInput({ hiddenEvalSetPath: `${COPY}/h`, hiddenRoundWorkspace: { copyPath: COPY, taskWorkspacePath: "/elsewhere/task" } }))).toThrow(/inside a workspace/u);
    expect(() => checkSandboxPlan(hiddenInput({ hiddenEvalSetPath: `${TASK}/h`, hiddenRoundWorkspace: { copyPath: COPY, taskWorkspacePath: TASK } }))).toThrow(/inside a workspace/u);
  });
  it("resolves links: a hidden path that is a link into a workspace is refused, and the plan mounts the REAL path", async () => {
    const base = await mkdtemp(join(tmpdir(), "te-f3-links-"));
    try {
      const task = join(base, "task");
      const copy = join(base, "copy");
      const real = join(base, "hidden-real");
      await mkdir(task); await mkdir(copy); await mkdir(real);
      await symlink(task, join(base, "link-to-task"));
      await symlink(real, join(base, "link-to-real"));
      const over = (hiddenEvalSetPath: string): Partial<CheckSandboxInput> => ({ rootPath: copy, maskedPaths: [join(copy, ".s")], hiddenEvalSetPath, hiddenRoundWorkspace: { copyPath: copy, taskWorkspacePath: task } });
      expect(() => checkSandboxPlan(hiddenInput(over(join(base, "link-to-task", "x"))))).toThrow(/inside a workspace/u);
      const plan = checkSandboxPlan(hiddenInput(over(join(base, "link-to-real"))));
      const { realpath } = await import("node:fs/promises");
      expect(plan.hiddenEvalSetPath).toBe(await realpath(real));
      expect(volumes(plan.sandboxRunArgs).at(-1)).toBe(`${await realpath(real)}:/rovara/hidden-eval:ro`);
      expect(plan.sandboxRunArgs.join(" ")).not.toContain("link-to-real");
    } finally { await rm(base, { recursive: true, force: true }); }
  });
  it("is checked against the plan: an unexpected extra mount, a read-write mount, or a mount the plan did not ask for is a problem", () => {
    const withMount = checkSandboxRunArgs(hiddenInput(), FILES);
    expect(checkSandboxArgProblems(withMount, network(), paths).join(";")).toMatch(/exactly the workspace/u);
    const none = checkSandboxRunArgs(plain(), FILES);
    expect(checkSandboxArgProblems(none, network(), { ...paths, rootPath: TASK, hiddenEvalSetPath: HIDDEN }).join(";")).toMatch(/exactly the workspace/u);
    const rw = withMount.map((arg) => (arg === MOUNT ? `${HIDDEN}:/rovara/hidden-eval` : arg));
    expect(checkSandboxArgProblems(rw, network(), { ...paths, hiddenEvalSetPath: HIDDEN }).join(";")).toMatch(/exactly the workspace/u);
    const twice = [...withMount.slice(0, withMount.indexOf("--entrypoint")), "--volume", MOUNT, ...withMount.slice(withMount.indexOf("--entrypoint"))];
    expect(checkSandboxArgProblems(twice, network(), { ...paths, hiddenEvalSetPath: HIDDEN }).join(";")).toMatch(/exactly the workspace/u);
  });
});

describe("the working sandbox never carries the hidden set", () => {
  it("is built from arguments that have no way to name it, whatever the plan holds", () => {
    const args = taskSandboxRunArgs({ name: "agentx-task-1", taskId: "t", image: "worker:img", rootPath: TASK, maskedPaths: [] });
    expect(args.join(" ")).not.toContain("hidden-eval");
    const plan = checkSandboxPlan(hiddenInput());
    expect(plan.sandboxRunArgs.join(" ")).toContain("hidden-eval");
    expect(plan.dnsHelperRunArgs.join(" ")).not.toContain("hidden");
    expect(plan.resolverGuardArgs.insert.join(" ")).not.toContain("hidden");
    expect(plan.resolverGuardArgs.verify.join(" ")).not.toContain("hidden");
  });
});

describe("a hidden round starts only with the working sandbox PAUSED and confirmed", () => {
  const NET = runNetworkName(RUN);
  const WORK = `${NET}-work`;
  /** A docker with a state: the working sandbox's networks and its paused flag. `pauseWorks: false` models a pause that does not take. */
  function fakeDocker(options: { pauseWorks?: boolean; inspectPausedAnswer?: string } = {}) {
    let networks = [NET, "agentx-task"];
    let paused = false;
    const calls: string[][] = [];
    const docker: DockerCli = {
      run: (args) => {
        calls.push([...args]);
        if (args[0] === "network" && args[1] === "disconnect") { networks = networks.filter((name) => name !== args[2]); return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }); }
        if (args[0] === "pause") { if (options.pauseWorks !== false) paused = true; return Promise.resolve({ exitCode: options.pauseWorks === false ? 1 : 0, stdout: "", stderr: "" }); }
        if (args[0] === "unpause") { paused = false; return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }); }
        if (args[0] === "inspect" && args[2] === "{{.State.Paused}}") return Promise.resolve({ exitCode: 0, stdout: options.inspectPausedAnswer ?? (paused ? "true\n" : "false\n"), stderr: "" });
        if (args[0] === "inspect") return Promise.resolve({ exitCode: 0, stdout: JSON.stringify(Object.fromEntries(networks.map((name) => [name, { IPAddress: "x" }]))), stderr: "" });
        if (args[0] === "run") return Promise.resolve({ exitCode: 0, stdout: "container-id\n", stderr: "" });
        // a removed container is gone: `docker container inspect` finds nothing
        if (args[0] === "container") return Promise.resolve({ exitCode: 1, stdout: "", stderr: "no such container" });
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      },
    };
    return { docker, calls, isPaused: () => paused };
  }
  const kinds = (calls: string[][]) => calls.map((call) => call[0]);

  it("pauses and confirms with an inspect of the paused state, and refuses when the state is not confirmed", async () => {
    const plan = checkSandboxPlan(hiddenInput());
    const fake = fakeDocker();
    expect(await pauseWorkingSandbox(fake.docker, plan)).toEqual({ container: WORK });
    expect(fake.isPaused()).toBe(true);
    for (const options of [{ pauseWorks: false }, { inspectPausedAnswer: "false\n" }, { inspectPausedAnswer: "" }, { inspectPausedAnswer: "garbage" }]) {
      await expect(pauseWorkingSandbox(fakeDocker(options).docker, plan), JSON.stringify(options)).rejects.toThrow(/could not be confirmed paused/u);
    }
  });
  it("startCheckSandbox refuses a hidden plan without a pause proof for THIS plan, with a forged proof, and when the sandbox is no longer paused, and starts nothing", async () => {
    const plan = checkSandboxPlan(hiddenInput());
    const fake = fakeDocker();
    const detached = await detachWorkingSandbox(fake.docker, plan);
    const attempt = (options: Parameters<typeof startCheckSandbox>[3]) => startCheckSandbox(fake.docker, plan, detached, options).then(() => "started", (error: unknown) => String(error));
    expect(await attempt({})).toMatch(/confirmed paused/u);
    expect(await attempt({ paused: { container: WORK } })).toMatch(/confirmed paused/u);
    const proof = await pauseWorkingSandbox(fake.docker, plan);
    expect(await attempt({ paused: { ...proof } })).toMatch(/confirmed paused/u);
    await fake.docker.run(["unpause", WORK]);
    expect(await attempt({ paused: proof })).toMatch(/confirmed paused/u);
    expect(fake.calls.filter((call) => call[0] === "run")).toEqual([]);
    await fake.docker.run(["pause", WORK]);
    expect(await attempt({ paused: proof })).toBe("started");
  });
  it("a pause proof made for another run's working sandbox does not start this one", async () => {
    const plan = checkSandboxPlan(hiddenInput());
    const otherPlan = checkSandboxPlan(hiddenInput({ net: network("22222222-2222-4222-8222-222222222222") }));
    const fake = fakeDocker();
    const detached = await detachWorkingSandbox(fake.docker, plan);
    await pauseWorkingSandbox(fake.docker, plan);
    const otherProof = await pauseWorkingSandbox(fakeDocker().docker, otherPlan);
    expect(otherProof.container).not.toBe(WORK);
    await expect(startCheckSandbox(fake.docker, plan, detached, { paused: otherProof })).rejects.toThrow(/confirmed paused/u);
  });
  it("re-asserts the hidden path rules from the plan's own data: a hand-edited plan is refused", async () => {
    const plan = checkSandboxPlan(hiddenInput());
    const fake = fakeDocker();
    const detached = await detachWorkingSandbox(fake.docker, plan);
    const proof = await pauseWorkingSandbox(fake.docker, plan);
    const attempt = (edited: typeof plan) => startCheckSandbox(fake.docker, edited, detached, { paused: proof }).then(() => "started", (error: unknown) => String(error));
    const taskVolume = (arg: string) => (arg === `${COPY}:${COPY}` ? `${TASK}:${TASK}` : arg);
    expect(await attempt({ ...plan, hiddenRoundWorkspace: undefined } as never)).toMatch(/unsound|throwaway/u);
    expect(await attempt({ ...plan, rootPath: TASK, sandboxRunArgs: plan.sandboxRunArgs.map((arg) => taskVolume(arg)) })).toMatch(/unsound|throwaway|not its/u);
    expect(fake.calls.filter((call) => call[0] === "run")).toEqual([]);
  });
  it("withDetachedWorking pauses (confirmed), starts, removes the check sandbox, discards the copy, then unpauses, in that order", async () => {
    const plan = checkSandboxPlan(hiddenInput());
    const fake = fakeDocker();
    const order: string[] = [];
    const result = await withDetachedWorking(fake.docker, plan, async (start) => { order.push("round"); await start(); return "done"; }, {
      returnTo: "none", discardWorkspaceCopy: () => { order.push("discard"); return Promise.resolve(); },
    });
    expect(result).toBe("done");
    expect(order).toEqual(["round", "discard"]);
    const kind = kinds(fake.calls);
    expect(kind.indexOf("pause")).toBeGreaterThan(-1);
    expect(kind.indexOf("pause")).toBeLessThan(kind.indexOf("run"));
    expect(kind.lastIndexOf("unpause")).toBeGreaterThan(kind.lastIndexOf("rm"));
    expect(fake.isPaused()).toBe(false);
  });
  it("withDetachedWorking does not run the round when the pause cannot be confirmed", async () => {
    const plan = checkSandboxPlan(hiddenInput());
    const fake = fakeDocker({ pauseWorks: false });
    let ran = false;
    await expect(withDetachedWorking(fake.docker, plan, () => { ran = true; return Promise.resolve("x"); }, { returnTo: "none", discardWorkspaceCopy: () => Promise.resolve() })).rejects.toThrow(/confirmed paused/u);
    expect(ran).toBe(false);
    expect(fake.calls.filter((call) => call[0] === "run")).toEqual([]);
  });
  it("withDetachedWorking refuses a hidden round that cannot say how its copy is discarded, before it touches anything", async () => {
    const plan = checkSandboxPlan(hiddenInput());
    const fake = fakeDocker();
    await expect(withDetachedWorking(fake.docker, plan, () => Promise.resolve("x"), { returnTo: "none" })).rejects.toThrow(/discards its throwaway/u);
    expect(fake.calls).toEqual([]);
  });
  it("a plain plan still starts without any pause proof, as before", async () => {
    const plan = checkSandboxPlan(plain());
    const fake = fakeDocker();
    const detached = await detachWorkingSandbox(fake.docker, plan);
    expect(await startCheckSandbox(fake.docker, plan, detached)).toBe("container-id");
  });
});
