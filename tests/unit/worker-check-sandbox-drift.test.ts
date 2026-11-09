// TS16: the sealed check sandbox builds on the task sandbox's arguments (task-sandbox.ts `taskSandboxRunArgs`) and checks its own result. If a later change to the task sandbox's arguments would give the sealed
// sandbox a second network, a published port, a DNS option, an added capability or another shape, the builder must refuse. These tests replace `taskSandboxRunArgs` with such drifted versions.
import { describe, expect, it, vi } from "vitest";
import type * as TaskSandboxModule from "../../packages/worker/src/task-sandbox.js";

const drift = vi.hoisted(() => ({ extra: [] as string[], swapNetwork: undefined as string | undefined, dropFlag: undefined as string | undefined, tail: undefined as string[] | undefined }));

vi.mock("../../packages/worker/src/task-sandbox.js", async (importOriginal) => {
  const original = await importOriginal<typeof TaskSandboxModule>();
  return {
    ...original,
    taskSandboxRunArgs: (input: Parameters<typeof original.taskSandboxRunArgs>[0]) => {
      let args = original.taskSandboxRunArgs(input);
      if (drift.swapNetwork !== undefined) args = args.map((arg) => (arg === input.network?.name ? drift.swapNetwork! : arg));
      if (drift.dropFlag !== undefined) args = args.filter((arg, index) => arg !== drift.dropFlag && args[index - 1] !== drift.dropFlag);
      if (drift.tail !== undefined) args = [...args.slice(0, -6), ...drift.tail];
      return drift.extra.length === 0 ? args : [...args.slice(0, -6), ...drift.extra, ...args.slice(-6)];
    },
  };
});

const { checkSandboxRunArgs } = await import("../../packages/worker/src/check-sandbox.js");
const { runNetworkAddresses, runNetworkLabelArgs, runNetworkName } = await import("../../packages/worker/src/run-network.js");

const RUN = "11111111-1111-4111-8111-111111111111";
const addresses = runNetworkAddresses(5);
const net = {
  name: runNetworkName(RUN), slot: 5, subnet: addresses.subnet, dnsHelperIp: addresses.dnsHelperIp, workingSandboxIp: addresses.workingSandboxIp, checkSandboxIp: addresses.checkSandboxIp,
  labelArgs: () => runNetworkLabelArgs({ runId: RUN, workspace: "0123456789abcdef", createdAt: 1, expiresAt: 2 }),
};
const input = { net, taskId: "t", image: "img", guardImage: `sha256:${"a".repeat(64)}`, rootPath: "/ws", maskedPaths: [], filesDir: "/run/x", helpers: [], sinkholeIp: "172.30.5.16" };
const files = { resolvConfPath: "/run/x/resolv.conf", hostsPath: "/run/x/hosts" };
const reset = () => { drift.extra = []; drift.swapNetwork = undefined; drift.dropFlag = undefined; drift.tail = undefined; };

describe("the sealed check sandbox refuses a task sandbox that drifted", () => {
  it("builds when nothing drifted", () => {
    reset();
    expect(checkSandboxRunArgs(input, files)).toContain("--hostname");
  });

  it.each([
    ["a second network", ["--network", "agentx-task"]],
    ["a published port", ["--publish", "8080:80"]],
    ["a DNS server", ["--dns", "8.8.8.8"]],
    ["an added capability", ["--cap-add", "NET_ADMIN"]],
    ["a privileged container", ["--privileged"]],
    ["a docker socket", ["--volume", "/var/run/docker.sock:/var/run/docker.sock"]],
    ["a host entry", ["--add-host", "evil:1.2.3.4"]],
    ["a network in the equals form", ["--network=bridge"]],
    ["an address in the equals form", ["--ip=172.30.5.3"]],
    ["seccomp unconfined in the equals form", ["--security-opt=seccomp=unconfined"]],
    ["a different capability drop", ["--cap-drop=NET_RAW"]],
    ["root as the user", ["--user=0:0"]],
    ["a second user", ["--user", "0:0"]],
    ["an attached short publish", ["-p8080:80"]],
    ["a host bind mount", ["-v", "/:/host"]],
    ["a mount flag", ["--mount", "type=bind,src=/,dst=/host"]],
    ["volumes from another container", ["--volumes-from", "other"]],
    ["a tmpfs over /etc", ["--tmpfs", "/etc"]],
    ["another runtime", ["--runtime", "runc"]],
    ["an added group", ["--group-add", "0"]],
    ["another cgroup parent", ["--cgroup-parent", "/x"]],
    ["a GPU", ["--gpus", "all"]],
    ["a DOCKER_HOST variable", ["--env", "DOCKER_HOST=tcp://x:2375"]],
  ])("refuses %s", (_name, extra) => {
    reset();
    drift.extra = extra;
    expect(() => checkSandboxRunArgs(input, files)).toThrow(/arguments are unsound/u);
    reset();
  });

  it("refuses the default bridge in place of the run's network", () => {
    reset();
    drift.swapNetwork = "bridge";
    expect(() => checkSandboxRunArgs(input, files)).toThrow(/arguments are unsound/u);
    reset();
  });

  it("refuses a task sandbox that lost its capability drop", () => {
    reset();
    drift.dropFlag = "--cap-drop";
    expect(() => checkSandboxRunArgs(input, files)).toThrow(/arguments are unsound/u);
    reset();
  });

  it("refuses a task sandbox whose arguments changed shape at the end", () => {
    reset();
    drift.tail = ["--entrypoint", "tini", "img", "sleep", "infinity", "extra"];
    expect(() => checkSandboxRunArgs(input, files)).toThrow(/changed shape/u);
    reset();
  });

  it("refuses a flag placed after --entrypoint, before the image", () => {
    reset();
    drift.tail = ["--entrypoint", "tini", "--network=bridge", "img", "--", "sleep", "infinity"];
    expect(() => checkSandboxRunArgs(input, files)).toThrow(/changed shape|unsound/u);
    reset();
  });

  it("refuses an extra argument after the image", () => {
    reset();
    drift.tail = ["--entrypoint", "tini", "img", "--", "sleep", "infinity", "--privileged"];
    expect(() => checkSandboxRunArgs(input, files)).toThrow(/changed shape|unsound/u);
    reset();
  });
});
