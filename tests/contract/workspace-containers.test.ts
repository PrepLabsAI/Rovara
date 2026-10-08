import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  containerIdFromProcFiles,
  containersToRemove,
  dockerSocketApi,
  sweepWorkspaceContainers,
  type DockerApi,
  type DockerContainer,
} from "../../packages/worker/src/workspace-containers.js";

const SELF = "a".repeat(64);
const DEVCONTAINER = "b".repeat(64);
const DETACHED = "c".repeat(64);
const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolveClose) => server.close(resolveClose))));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const container = (id: string, extra: Partial<DockerContainer> = {}): DockerContainer => ({ id, names: [`/${id.slice(0, 6)}`], labels: {}, state: "running", ...extra });

/** A fake Docker whose containers are `initial`, then whatever `remove` leaves. */
function fakeDocker(initial: DockerContainer[], behaviour: { list?: () => Promise<DockerContainer[]>; remove?: (id: string) => Promise<void> } = {}) {
  let containers = [...initial];
  const removed: string[] = [];
  const docker: DockerApi = {
    listContainers: behaviour.list ?? (async () => [...containers]),
    removeContainer: behaviour.remove ?? (async (id) => { removed.push(id); containers = containers.filter((entry) => entry.id !== id); }),
  };
  return { docker, removed };
}

const inContainer = (docker: DockerApi, extra: Partial<Parameters<typeof sweepWorkspaceContainers>[0]> = {}) => sweepWorkspaceContainers({
  rootPath: "/mnt/workspace",
  scope: "container",
  docker,
  socketMounted: async () => true,
  selfContainerId: async () => SELF,
  log: () => undefined,
  ...extra,
});

describe("removing containers left from the workspace before a push (docker containment)", () => {
  it("finds the worker's own container ID from Docker's bind mounts, or from a cgroup v1 path", () => {
    const mountinfo = [
      "820 700 0:52 / / rw,relatime master:1 - overlay overlay rw,lowerdir=/mnt/workspace/.docker/overlay2/l/X",
      `833 820 259:1 /.docker/containers/${SELF}/resolv.conf /etc/resolv.conf rw,noatime - ext4 /dev/nvme1n1 rw`,
      `834 820 259:1 /.docker/containers/${SELF}/hostname /etc/hostname rw,noatime - ext4 /dev/nvme1n1 rw`,
    ].join("\n");
    expect(containerIdFromProcFiles({ mountinfo, cgroup: "0::/\n" })).toBe(SELF);
    expect(containerIdFromProcFiles({ mountinfo: "", cgroup: `12:pids:/docker/${SELF}\n` })).toBe(SELF);
    expect(containerIdFromProcFiles({ mountinfo: "820 700 0:52 / / rw - overlay overlay rw", cgroup: "0::/\n" })).toBeUndefined();
    // Two different IDs: AgentX cannot tell which is its own.
    expect(containerIdFromProcFiles({ mountinfo: `1 1 1:1 /containers/${SELF}/hosts /etc/hosts rw - ext4 x rw\n1 1 1:1 /containers/${DETACHED}/hosts /x rw - ext4 x rw`, cgroup: "" })).toBeUndefined();
  });

  it("selects every container but the worker's own: the workspace's dev containers and any other, running or not", () => {
    const containers = [
      container(SELF, { names: ["/agentx-worker"] }),
      container(DEVCONTAINER, { labels: { "devcontainer.local_folder": "/mnt/workspace/repo/sample" } }),
      container(DETACHED, { state: "exited", labels: { "agentx.role": "worker" }, names: ["/agentx-worker-2"] }),
    ];
    expect(containersToRemove(containers, { selfId: SELF, rootPath: "/mnt/workspace" })).toEqual([
      { ...containers[1], workspace: true },
      { ...containers[2], workspace: false },
    ]);
  });

  it("removes them, checks again, and reports how many it removed", async () => {
    const { docker, removed } = fakeDocker([
      container(SELF), container(DEVCONTAINER, { labels: { "devcontainer.local_folder": "/mnt/workspace/repo/sample" } }), container(DETACHED),
    ]);
    const log = vi.fn();
    await expect(inContainer(docker, { log })).resolves.toEqual({ removed: 2 });
    expect(removed).toEqual([DEVCONTAINER, DETACHED]);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "publish.containers.removed", workspace: 1, other: 1 }));
    await expect(inContainer(docker)).resolves.toEqual({ removed: 0 });
  });

  it("does nothing outside the worker container, and only logs when no Docker socket is mounted", async () => {
    const list = vi.fn(async () => [] as DockerContainer[]);
    const { docker } = fakeDocker([], { list });
    const log = vi.fn();
    await expect(sweepWorkspaceContainers({ rootPath: "/w", scope: "workspace", docker, socketMounted: async () => true, log })).resolves.toEqual({ removed: 0 });
    await expect(inContainer(docker, { socketMounted: async () => false, log })).resolves.toEqual({ removed: 0 });
    expect(list).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "publish.containers.skipped" }));
  });

  it("fails closed when Docker cannot be reached, the worker's own container is unknown or missing, a container cannot be removed, or containers keep coming back", async () => {
    await expect(inContainer(fakeDocker([], { list: async () => { throw new Error("connect ECONNREFUSED"); } }).docker))
      .rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: expect.stringMatching(/could not reach Docker.*did not push/) as unknown });
    await expect(inContainer(fakeDocker([container(SELF)]).docker, { selfContainerId: async () => undefined }))
      .rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: expect.stringMatching(/its own container.*did not push/) as unknown });
    await expect(inContainer(fakeDocker([container(DETACHED)]).docker))
      .rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: expect.stringMatching(/its own container.*did not push/) as unknown });
    await expect(inContainer(fakeDocker([container(SELF), container(DETACHED)], { remove: async () => { throw new Error("permission denied"); } }).docker))
      .rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: expect.stringMatching(/could not remove the container .*permission denied.*did not push/) as unknown });
    let next = 0;
    const respawning = fakeDocker([], { list: async () => [container(SELF), container(String(next++).padStart(64, "d"))], remove: async () => undefined });
    await expect(inContainer(respawning.docker, { rounds: 3 }))
      .rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: expect.stringMatching(/kept finding new containers.*did not push/) as unknown });
  });
});

describe("the Docker API client", () => {
  async function fakeDaemon(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ socketPath: string; requests: string[] }> {
    const directory = await mkdtemp(join(tmpdir(), "dk-"));
    directories.push(directory);
    const socketPath = join(directory, "d.sock");
    const requests: string[] = [];
    const server = createServer((request, response) => { requests.push(`${request.method} ${request.url}`); handler(request, response); });
    servers.push(server);
    await new Promise<void>((resolveListen) => server.listen(socketPath, resolveListen));
    return { socketPath, requests };
  }

  it("lists every container, stopped ones included, and force-removes one; a container already gone counts as removed", async () => {
    const { socketPath, requests } = await fakeDaemon((request, response) => {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([{ Id: SELF, Names: ["/agentx-worker"], Labels: null, State: "running" }, { Id: DETACHED, Names: ["/x"], Labels: { a: "b" }, State: "exited" }]));
      } else {
        response.writeHead(request.url?.includes(DETACHED) ? 204 : 404);
        response.end();
      }
    });
    const docker = dockerSocketApi(socketPath);
    await expect(docker.listContainers()).resolves.toEqual([
      { id: SELF, names: ["/agentx-worker"], labels: {}, state: "running" },
      { id: DETACHED, names: ["/x"], labels: { a: "b" }, state: "exited" },
    ]);
    await docker.removeContainer(DETACHED);
    await docker.removeContainer(DEVCONTAINER);
    expect(requests).toEqual(["GET /containers/json?all=1", `DELETE /containers/${DETACHED}?force=1`, `DELETE /containers/${DEVCONTAINER}?force=1`]);
  });

  it("reports a refused removal or an unreadable list as an error", async () => {
    const { socketPath } = await fakeDaemon((request, response) => {
      response.writeHead(request.method === "GET" ? 200 : 500, { "content-type": "application/json" });
      response.end(request.method === "GET" ? "not json" : JSON.stringify({ message: "container is paused" }));
    });
    const docker = dockerSocketApi(socketPath);
    await expect(docker.listContainers()).rejects.toThrow();
    await expect(docker.removeContainer(DETACHED)).rejects.toThrow(/500.*container is paused/);
    await expect(dockerSocketApi(join(tmpdir(), "no-such.sock")).listContainers()).rejects.toThrow();
  });
});
