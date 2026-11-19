// A dev container on a host that walls its network (a cloud worker): it joins the walled network, never the default bridge. The network is made before the start, the started container is checked on it
// (the network alone, NET_RAW dropped), and one that is not is created again once, then refused. Where the host walls nothing (a laptop), none of this applies.
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureDevcontainer, type DevcontainerCli, type DevcontainerTarget } from "../../packages/worker/src/devcontainer.js";
import type { ContainerInspection } from "../../packages/worker/src/devcontainer-policy.js";

async function workspace(config = '{ "image": "node:22" }\n'): Promise<DevcontainerTarget> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-walled-net-")));
  await mkdir(join(root, "repo/sample/.devcontainer"), { recursive: true });
  await writeFile(join(root, "repo/sample/.devcontainer/devcontainer.json"), config, "utf8");
  return { rootPath: root, workspaceFolder: join(root, "repo/sample"), configPath: join(root, "repo/sample/.devcontainer/devcontainer.json") };
}

interface Shape { networks?: string[]; capDrop?: string[] | null }
/** What `docker inspect` gives for a dev container: its network mode, the networks it is attached to, what it dropped, and the workspace mounts a start gives it. */
const on = (network: string, root: string, shape: Shape = {}): ContainerInspection => ({
  HostConfig: { NetworkMode: network, CapDrop: shape.capDrop === undefined ? ["NET_RAW"] : shape.capDrop },
  NetworkSettings: { Networks: Object.fromEntries((shape.networks ?? [network]).map((name) => [name, {}])) },
  Mounts: [{ Type: "bind", Source: root, Destination: root }, ...[".agentx", "agent-sessions"].map((name) => ({ Type: "volume", Destination: join(root, name) }))],
});

/** `containers` answers `inspect` in turn for what `up` started. */
function fakeCli(root: string, containers: Array<string | { network: string; shape: Shape }>, options: { walled?: boolean } = {}) {
  const events: string[] = [];
  const removed: string[] = [];
  const queue = [...containers];
  let started = 0;
  const cli: DevcontainerCli = {
    run: async () => {
      started += 1;
      events.push(`up ${started}`);
      return { exitCode: 0, stdout: `{"outcome":"success","containerId":"id-${started}","remoteUser":"node","remoteWorkspaceFolder":"/workspaces/sample"}`, stderr: "" };
    },
    ...(options.walled === false ? {} : { walledNetwork: { name: "agentx-task", ensure: async () => { events.push("ensure"); } } }),
    checks: {
      fullConfiguration: async () => ({ configuration: {}, mergedConfiguration: {} }),
      inspect: async () => {
        const next = queue.shift() ?? "bridge";
        return typeof next === "string" ? on(next, root) : on(next.network, root, next.shape);
      },
      remove: async (id) => { removed.push(id); events.push(`remove ${id}`); },
    },
  };
  return { cli, events, removed };
}

describe("a dev container where the host walls its network", () => {
  it("has its network made before it starts, and starts once when it is on that network alone (positive control)", async () => {
    const target = await workspace();
    const { cli, events, removed } = fakeCli(target.rootPath, ["agentx-task"]);
    await expect(ensureDevcontainer(cli, target)).resolves.toMatchObject({ containerId: "id-1" });
    expect(events).toEqual(["ensure", "up 1"]);
    expect(removed).toEqual([]);
  });

  it("is created again when it started on the default bridge, and kept once the second start is walled", async () => {
    const target = await workspace();
    const { cli, events, removed } = fakeCli(target.rootPath, ["bridge", "agentx-task"]);
    await expect(ensureDevcontainer(cli, target)).resolves.toMatchObject({ containerId: "id-2" });
    expect(removed).toEqual(["id-1"]);
    expect(events).toEqual(["ensure", "up 1", "remove id-1", "up 2"]);
  });

  it("is removed and refused when the second start is still not on the network (nothing else cures it)", async () => {
    const target = await workspace();
    const { cli, removed } = fakeCli(target.rootPath, ["bridge", "bridge"]);
    await expect(ensureDevcontainer(cli, target)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringMatching(/does not wall/u) as string });
    expect(removed).toEqual(["id-1", "id-2"]);
  });

  it("is created again when it is attached to a second network too, or kept NET_RAW", async () => {
    for (const bad of [{ network: "agentx-task", shape: { networks: ["agentx-task", "bridge"] } }, { network: "agentx-task", shape: { capDrop: null } }, { network: "bridge", shape: { capDrop: null } }]) {
      const target = await workspace();
      const { cli, removed } = fakeCli(target.rootPath, [bad, "agentx-task"]);
      await expect(ensureDevcontainer(cli, target)).resolves.toMatchObject({ containerId: "id-2" });
      expect(removed, JSON.stringify(bad)).toEqual(["id-1"]);
    }
  });

  it("is refused after a second start that kept NET_RAW, naming it", async () => {
    const target = await workspace();
    const noDrop = { network: "agentx-task", shape: { capDrop: null } };
    const { cli, removed } = fakeCli(target.rootPath, [noDrop, noDrop]);
    await expect(ensureDevcontainer(cli, target)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringMatching(/NET_RAW/u) as string });
    expect(removed).toEqual(["id-1", "id-2"]);
  });

  it.each([
    ["a runArgs --network", '{ "image": "node:22", "runArgs": ["--network=team-cache"] }\n', /runArgs --network/u],
    ["a runArgs --net", '{ "image": "node:22", "runArgs": ["--net", "team-cache"] }\n', /runArgs --net/u],
    ["a build.options --network", '{ "build": { "dockerfile": "Dockerfile", "options": ["--network=team-cache"] } }\n', /build\.options --network/u],
  ])("refuses %s before anything starts", async (_name, config, message) => {
    const target = await workspace(config);
    const { cli, events } = fakeCli(target.rootPath, ["agentx-task"]);
    await expect(ensureDevcontainer(cli, target)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringMatching(message) as string });
    expect(events).toEqual([]);
  });

  it("refuses a network in the full configuration the CLI reads (a feature or the image's own settings) before anything starts", async () => {
    const target = await workspace();
    const { cli, events } = fakeCli(target.rootPath, ["agentx-task"]);
    cli.checks!.fullConfiguration = async () => ({ configuration: {}, mergedConfiguration: { runArgs: ["--network=team-cache"] } });
    await expect(ensureDevcontainer(cli, target)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringMatching(/runArgs --network/u) as string });
    expect(events).toEqual([]);
  });

  it("is not checked for a network, and its runArgs network is allowed, where nothing is walled (a laptop)", async () => {
    const target = await workspace('{ "image": "node:22", "runArgs": ["--network=team-cache"] }\n');
    const { cli, events, removed } = fakeCli(target.rootPath, ["team-cache"], { walled: false });
    await expect(ensureDevcontainer(cli, target)).resolves.toMatchObject({ containerId: "id-1" });
    expect(events).toEqual(["up 1"]);
    expect(removed).toEqual([]);
  });
});
