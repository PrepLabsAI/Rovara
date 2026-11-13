// TE-F3 part B: the hidden eval set's read-only mount in the sealed check sandbox's plan (check-sandbox.ts), and nowhere else. Pure: no Docker is started.
import { describe, expect, it } from "vitest";
import { checkSandboxArgProblems, checkSandboxPlan, checkSandboxRunArgs, detachWorkingSandbox, startCheckSandbox, type CheckSandboxInput, type CheckSandboxNetwork } from "../../packages/worker/src/check-sandbox.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import { runNetworkAddresses, runNetworkLabelArgs, runNetworkName } from "../../packages/worker/src/run-network.js";
import { taskSandboxRunArgs } from "../../packages/worker/src/task-sandbox.js";

const RUN = "11111111-1111-4111-8111-111111111111";
const SLOT = 5;
const ROOT = "/workspace/project";
const HIDDEN = "/var/lib/rovara/hidden/project-1";
const MOUNT = `${HIDDEN}:/rovara/hidden-eval:ro`;
const GUARD_IMAGE = `registry.example.test/agentx/worker@sha256:${"c".repeat(64)}`;
function network(): CheckSandboxNetwork {
  const addresses = runNetworkAddresses(SLOT);
  return { name: runNetworkName(RUN), slot: SLOT, subnet: addresses.subnet, dnsHelperIp: addresses.dnsHelperIp, workingSandboxIp: addresses.workingSandboxIp, checkSandboxIp: addresses.checkSandboxIp, labelArgs: () => runNetworkLabelArgs({ runId: RUN, workspace: "0123456789abcdef", createdAt: 1_800_000_000_000, expiresAt: 1_800_000_900_000 }) };
}
const input = (over: Partial<CheckSandboxInput> = {}): CheckSandboxInput => ({
  net: network(), taskId: "task-1", image: "worker:img", guardImage: GUARD_IMAGE, rootPath: ROOT, maskedPaths: ["/workspace/project/.agentx-state"], filesDir: "/run/rovara/check-1", helpers: [], sinkholeIp: runNetworkAddresses(SLOT).subnet.replace(/\.0\/24$/u, ".16"), ...over,
});
const FILES = { resolvConfPath: "/run/rovara/check-1/resolv.conf", hostsPath: "/run/rovara/check-1/hosts" };
const volumes = (args: readonly string[]) => args.flatMap((arg, index) => (args[index - 1] === "--volume" ? [arg] : []));
const paths = { ...FILES, rootPath: ROOT, image: "worker:img", maskedPaths: ["/workspace/project/.agentx-state"] };

describe("the sealed check sandbox plan with a hidden eval set", () => {
  it("has no hidden mount unless it is asked for: the plan is exactly what it was", () => {
    const plan = checkSandboxPlan(input());
    expect(volumes(plan.sandboxRunArgs)).toEqual([`${ROOT}:${ROOT}`, `${FILES.resolvConfPath}:/etc/resolv.conf:ro`, `${FILES.hostsPath}:/etc/hosts:ro`]);
    expect(plan.sandboxRunArgs.join(" ")).not.toContain("hidden-eval");
  });
  it("mounts the set read-only at one fixed path, as a fourth mount, and says so in the plan", () => {
    const plan = checkSandboxPlan(input({ hiddenEvalSetPath: HIDDEN }));
    expect(volumes(plan.sandboxRunArgs)).toEqual([`${ROOT}:${ROOT}`, `${FILES.resolvConfPath}:/etc/resolv.conf:ro`, `${FILES.hostsPath}:/etc/hosts:ro`, MOUNT]);
    expect(plan.hiddenEvalSetPath).toBe(HIDDEN);
    expect(checkSandboxArgProblems(plan.sandboxRunArgs, network(), { ...paths, hiddenEvalSetPath: HIDDEN })).toEqual([]);
  });
  it("is checked against the plan: an unexpected extra mount, a read-write mount, or a mount the plan did not ask for is a problem", () => {
    const withMount = checkSandboxRunArgs(input({ hiddenEvalSetPath: HIDDEN }), FILES);
    expect(checkSandboxArgProblems(withMount, network(), paths).join(";")).toMatch(/exactly the workspace/u);
    const plain = checkSandboxRunArgs(input(), FILES);
    expect(checkSandboxArgProblems(plain, network(), { ...paths, hiddenEvalSetPath: HIDDEN }).join(";")).toMatch(/exactly the workspace/u);
    const rw = withMount.map((arg) => (arg === MOUNT ? `${HIDDEN}:/rovara/hidden-eval` : arg));
    expect(checkSandboxArgProblems(rw, network(), { ...paths, hiddenEvalSetPath: HIDDEN }).join(";")).toMatch(/exactly the workspace/u);
    const twice = [...withMount.slice(0, withMount.indexOf("--entrypoint")), "--volume", MOUNT, ...withMount.slice(withMount.indexOf("--entrypoint"))];
    expect(checkSandboxArgProblems(twice, network(), { ...paths, hiddenEvalSetPath: HIDDEN }).join(";")).toMatch(/exactly the workspace/u);
  });
  it("refuses a path that is not a plain absolute path, is inside the workspace (the working sandbox would see it), or is the run's own file", () => {
    for (const bad of ["relative/hidden", "/a/../b", "/a b", ROOT, `${ROOT}/hidden`, "/run/rovara/check-1/hosts", "/var/run/docker.sock", "/"]) {
      expect(() => checkSandboxPlan(input({ hiddenEvalSetPath: bad })), bad).toThrow(/hidden eval|run file|plain absolute|docker socket|workspace/u);
    }
  });
  it("may sit under a masked folder, which the sandbox and the working sandbox both see as an empty tmpfs", () => {
    expect(() => checkSandboxPlan(input({ hiddenEvalSetPath: "/workspace/project/.agentx-state/hidden" }))).not.toThrow();
  });
});

describe("the working sandbox never carries the hidden set", () => {
  it("is built from arguments that have no way to name it, whatever the plan holds", () => {
    const args = taskSandboxRunArgs({ name: "agentx-task-1", taskId: "t", image: "worker:img", rootPath: ROOT, maskedPaths: [] });
    expect(args.join(" ")).not.toContain("hidden-eval");
    const plan = checkSandboxPlan(input({ hiddenEvalSetPath: HIDDEN }));
    expect(plan.sandboxRunArgs.join(" ")).toContain("hidden-eval");
    expect(plan.dnsHelperRunArgs.join(" ")).not.toContain("hidden");
    expect(plan.resolverGuardArgs.insert.join(" ")).not.toContain("hidden");
    expect(plan.resolverGuardArgs.verify.join(" ")).not.toContain("hidden");
  });
});

describe("the sealed sandbox is started only from a plan that says what it mounts", () => {
  const NET = runNetworkName(RUN);
  /** A docker that remembers which networks the working sandbox is on, and answers the three calls a start makes. */
  function fakeDocker() {
    let networks = [NET, "agentx-task"];
    const calls: string[][] = [];
    const docker: DockerCli = {
      run: (args) => {
        calls.push([...args]);
        if (args[0] === "network" && args[1] === "disconnect") { networks = networks.filter((name) => name !== args[2]); return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }); }
        if (args[0] === "inspect") return Promise.resolve({ exitCode: 0, stdout: JSON.stringify(Object.fromEntries(networks.map((name) => [name, { IPAddress: "x" }]))), stderr: "" });
        if (args[0] === "run") return Promise.resolve({ exitCode: 0, stdout: "container-id\n", stderr: "" });
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      },
    };
    return { docker, calls };
  }
  const start = async (plan: ReturnType<typeof checkSandboxPlan>) => {
    const fake = fakeDocker();
    const proof = await detachWorkingSandbox(fake.docker, plan);
    fake.calls.length = 0;
    const result = await startCheckSandbox(fake.docker, plan, proof).then(() => "started", (error: unknown) => error);
    return { result, runs: fake.calls.filter((call) => call[0] === "run") };
  };
  it("starts a sound plan with the hidden mount", async () => {
    const { result } = await start(checkSandboxPlan(input({ hiddenEvalSetPath: HIDDEN })));
    expect(result).toBe("started");
  });
  it("refuses a hand-edited plan whose arguments carry a hidden mount the plan does not name, or name one the arguments lack, and starts nothing", async () => {
    const withMount = checkSandboxPlan(input({ hiddenEvalSetPath: HIDDEN }));
    const { hiddenEvalSetPath: _dropped, ...forgotten } = withMount;
    const smuggled = await start(forgotten as typeof withMount);
    expect(String(smuggled.result)).toMatch(/unsound/u);
    expect(smuggled.runs).toEqual([]);
    const plain = checkSandboxPlan(input());
    const claimed = await start({ ...plain, hiddenEvalSetPath: HIDDEN });
    expect(String(claimed.result)).toMatch(/unsound/u);
    expect(claimed.runs).toEqual([]);
  });
});
