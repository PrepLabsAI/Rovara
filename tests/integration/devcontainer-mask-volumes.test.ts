// The empty volumes a dev container's start mounts over the worker's own folders are named per start, so they are removed
// wherever their container is: when a started container is refused or created again, in the sweep before a push, and, when
// nothing uses them, at the worker's startup. A volume the project named itself is never touched.
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureDevcontainer, removeLeftoverMaskVolumes, type DevcontainerCli, type DevcontainerTarget } from "../../packages/worker/src/devcontainer.js";
import type { ContainerInspection } from "../../packages/worker/src/devcontainer-policy.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import { sweepWorkspaceContainers, type DockerApi, type DockerContainer } from "../../packages/worker/src/workspace-containers.js";

const SELF = "a".repeat(64);
const maskVolume = (name: string, token: string) => ({ Type: "volume", Name: `${name}-${token}`, Source: `/var/lib/docker/volumes/${name}-${token}/_data` });

async function workspace(): Promise<DevcontainerTarget> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-mask-volumes-")));
  await mkdir(join(root, "repo/sample/.devcontainer"), { recursive: true });
  await writeFile(join(root, "repo/sample/.devcontainer/devcontainer.json"), '{ "image": "node:22" }\n', "utf8");
  return { rootPath: root, workspaceFolder: join(root, "repo/sample"), configPath: join(root, "repo/sample/.devcontainer/devcontainer.json") };
}

/** A fake CLI whose `up` starts `id-<n>` and whose Docker reports `inspections` in turn; it records what was removed. */
function fakeCli(inspections: ContainerInspection[]) {
  const removed: string[] = [];
  const volumesRemoved: string[][] = [];
  let started = 0;
  const cli: DevcontainerCli = {
    run: async () => {
      started += 1;
      return { exitCode: 0, stdout: `{"outcome":"success","containerId":"id-${started}","remoteUser":"node","remoteWorkspaceFolder":"/workspaces/sample"}`, stderr: "" };
    },
    checks: {
      fullConfiguration: async () => ({ configuration: {}, mergedConfiguration: {} }),
      inspect: async () => inspections.shift() ?? { Mounts: [] },
      remove: async (id) => { removed.push(id); },
      removeVolumes: async (names) => { volumesRemoved.push([...names]); },
    },
  };
  return { cli, removed, volumesRemoved };
}

describe("the mask volumes of a dev container", () => {
  it("are removed with a started container AgentX refuses", async () => {
    const target = await workspace();
    const refused: ContainerInspection = { HostConfig: { Privileged: true }, Mounts: [
      { Type: "bind", Source: target.rootPath, Destination: target.rootPath },
      { ...maskVolume("agentx-mask-agentx", "aaaaaaaaaaaa"), Destination: join(target.rootPath, ".agentx") },
      { ...maskVolume("agentx-mask-agent-sessions", "aaaaaaaaaaaa"), Destination: join(target.rootPath, "agent-sessions") },
      { Type: "volume", Name: "project-cache", Source: "/var/lib/docker/volumes/project-cache/_data", Destination: "/cache" },
    ] };
    const { cli, removed, volumesRemoved } = fakeCli([refused]);
    await expect(ensureDevcontainer(cli, target)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(removed).toEqual(["id-1"]);
    const names = volumesRemoved.flat();
    expect(names).toEqual(expect.arrayContaining(["agentx-mask-agentx-aaaaaaaaaaaa", "agentx-mask-agent-sessions-aaaaaaaaaaaa"]));
    expect(names).not.toContain("project-cache");
  });

  it("are removed with a container that is created again because the worker's folders were visible in it", async () => {
    const target = await workspace();
    await mkdir(join(target.rootPath, ".docker"));
    const unmasked: ContainerInspection = { Mounts: [
      { Type: "bind", Source: target.rootPath, Destination: target.rootPath },
      { ...maskVolume("agentx-docker-data-mask", "bbbbbbbbbbbb"), Destination: join(target.rootPath, ".docker") },
    ] };
    const masked: ContainerInspection = { Mounts: [
      { Type: "bind", Source: target.rootPath, Destination: target.rootPath },
      ...[".agentx", "agent-sessions", ".docker"].map((name) => ({ Type: "volume", Destination: join(target.rootPath, name) })),
    ] };
    const { cli, removed, volumesRemoved } = fakeCli([unmasked, masked]);
    await expect(ensureDevcontainer(cli, target)).resolves.toMatchObject({ containerId: "id-2" });
    expect(removed).toEqual(["id-1"]);
    expect(volumesRemoved.flat()).toContain("agentx-docker-data-mask-bbbbbbbbbbbb");
  });
});

describe("the sweep before a push", () => {
  const container = (id: string): DockerContainer => ({ id, names: [`/${id.slice(0, 4)}`], labels: {}, state: "exited" });

  it("removes the mask volumes once no container but the worker's is left, and only those", async () => {
    let containers = [container(SELF), container("b".repeat(64))];
    let volumes = ["agentx-mask-agentx-aaaaaaaaaaaa", "agentx-docker-data-mask-bbbbbbbbbbbb", "project-cache", "agentx-mask-notes"];
    const removedVolumes: string[] = [];
    const docker: DockerApi = {
      listContainers: async () => [...containers],
      removeContainer: async (id) => { containers = containers.filter((entry) => entry.id !== id); },
      listVolumes: async () => [...volumes],
      removeVolume: async (name) => { removedVolumes.push(name); volumes = volumes.filter((entry) => entry !== name); },
    };
    await sweepWorkspaceContainers({ rootPath: "/mnt/workspace", scope: "container", docker, socketMounted: async () => true, selfContainerId: async () => SELF, log: () => undefined });
    expect(removedVolumes.sort()).toEqual(["agentx-docker-data-mask-bbbbbbbbbbbb", "agentx-mask-agentx-aaaaaaaaaaaa"]);
    expect(volumes).toEqual(["project-cache", "agentx-mask-notes"]);
  });
});

describe("the worker's startup sweep", () => {
  it("removes the mask volumes no container uses, asking Docker for unused ones, and says how many", async () => {
    const calls: string[][] = [];
    const docker: DockerCli = {
      run: async (args) => {
        calls.push([...args]);
        if (args[0] === "volume" && args[1] === "ls") return { exitCode: 0, stdout: "agentx-mask-agentx-aaaaaaaaaaaa\nagentx-docker-data-mask-bbbbbbbbbbbb\nproject-cache\n", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    await expect(removeLeftoverMaskVolumes(docker)).resolves.toBe(2);
    const listing = calls.find((args) => args[1] === "ls")!;
    expect(listing).toEqual(expect.arrayContaining(["--filter", "dangling=true"]));
    expect(calls.at(-1)).toEqual(["volume", "rm", "agentx-mask-agentx-aaaaaaaaaaaa", "agentx-docker-data-mask-bbbbbbbbbbbb"]);
  });

  it("removes nothing when there is nothing to remove", async () => {
    const calls: string[][] = [];
    const docker: DockerCli = { run: async (args) => { calls.push([...args]); return { exitCode: 0, stdout: "", stderr: "" }; } };
    await expect(removeLeftoverMaskVolumes(docker)).resolves.toBe(0);
    expect(calls.filter((args) => args[1] === "rm")).toEqual([]);
  });
});
