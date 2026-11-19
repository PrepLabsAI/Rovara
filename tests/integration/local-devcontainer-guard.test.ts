// A project's dev container through the Docker socket guard, against a REAL Docker daemon and the REAL dev container tool the worker bundles. It is skipped unless
//   ROVARA_LOCAL_DEVCONTAINER_DOCKER_SOCKET=<the daemon's socket> ROVARA_LOCAL_DEVCONTAINER_IMAGE=<an image on docker.io that is already pulled and has /bin/sh>
// are set, and under a folder the daemon can share (a folder of your home folder on Docker Desktop and Colima). It makes one container, one internal network and one folder, and removes all three.
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DOCKER_SOCKET_GUARD_SOURCE } from "../../packages/broker/src/local/isolation/docker-socket-guard-source.js";
import { createDevcontainerCli, ensureDevcontainer, runDevcontainerCommand, type DevcontainerTarget } from "../../packages/worker/src/devcontainer.js";

const socket = process.env["ROVARA_LOCAL_DEVCONTAINER_DOCKER_SOCKET"];
const image = process.env["ROVARA_LOCAL_DEVCONTAINER_IMAGE"];
const run = promisify(execFile);

describe.skipIf(socket === undefined || image === undefined)("a dev container through the Docker socket guard (real Docker)", () => {
  it("starts from an image, runs a command as its user, is hardened as the guard says, and cannot be reached around the guard", async () => {
    const real = { ...process.env, DOCKER_HOST: `unix://${socket}` };
    const docker = (args: string[], environment: NodeJS.ProcessEnv = real) => run("docker", args, { env: environment, timeout: 120_000 });
    const mountsOf = async (id: string): Promise<string[]> => (JSON.parse((await docker(["inspect", id, "--format", "{{json .Mounts}}"])).stdout) as Array<{ Type: string; Destination: string; RW: boolean }>).map((mount) => `${mount.Type}:${mount.Destination}:${mount.RW ? "rw" : "ro"}`);
    const root = await realpath(await mkdtemp(join(homedir(), ".rovara-dcg-")));
    const network = `rovara-dcg-${Date.now().toString(36)}`;
    const owner = "t".repeat(24);
    let guardServer: { close(callback: () => void): void; closeAllConnections(): void } | undefined;
    const saved = { ...process.env };
    try {
      await mkdir(join(root, "repo/.devcontainer"), { recursive: true });
      await mkdir(join(root, ".agentx"), { recursive: true });
      await writeFile(join(root, "repo/.devcontainer/devcontainer.json"), JSON.stringify({ image, remoteUser: "root", postCreateCommand: "echo created > /tmp/created.txt" }));
      await docker(["network", "create", "--internal", network]);
      // The guard's own text, as a library, in front of the real daemon.
      const file = join(root, "guard.cjs");
      await writeFile(file, DOCKER_SOCKET_GUARD_SOURCE);
      process.env["ROVARA_SOCK_POLICY"] = JSON.stringify({ upstream: socket, owner, image: "unused:image", workspaceDir: root, workspaceKey: "integration", network, dns: ["172.30.9.2"], user: "1000:1000", port: 0, maxSandboxes: 4, devcontainer: { registries: ["docker.io"] } });
      process.env["ROVARA_SOCK_LIBRARY"] = "1";
      const guard = createRequire(import.meta.url)(file) as { createServer(): { listen(port: number, host: string, callback: () => void): void; address(): { port: number }; close(callback: () => void): void; closeAllConnections(): void } };
      const server = guard.createServer();
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      guardServer = server;
      const viaGuard = { ...real, DOCKER_HOST: `tcp://127.0.0.1:${server.address().port}` };
      // The worker's own code starts the dev container, in the worker's environment on a laptop.
      Object.assign(process.env, { DOCKER_HOST: viaGuard["DOCKER_HOST"], AGENTX_SANDBOX_NETWORK: network });
      delete process.env["AGENTX_RUNTIME"];
      const target: DevcontainerTarget = { rootPath: root, workspaceFolder: join(root, "repo"), configPath: join(root, "repo/.devcontainer/devcontainer.json") };
      const cli = createDevcontainerCli();
      const started = await ensureDevcontainer(cli, target);
      expect(started.remoteWorkspaceFolder).toBe(join(root, "repo"));
      const ran = await runDevcontainerCommand(cli, target, { cwd: "repo", executable: "sh", args: ["-c", "id -un && cat /tmp/created.txt && touch from-container"], timeoutSeconds: 60 });
      expect(ran.exitCode, ran.stderr).toBe(0);
      expect(ran.stdout).toContain("created");
      // As the daemon sees it: on the sandbox network with the guard's name server, capabilities dropped, the labels the guard puts on, the worker's folder hidden.
      const inspected = (JSON.parse((await docker(["inspect", started.containerId])).stdout) as Array<{ HostConfig: Record<string, unknown>; Config: { Labels: Record<string, string> } }>)[0]!;
      expect(inspected.HostConfig).toMatchObject({ NetworkMode: network, Privileged: false, CapDrop: ["MKNOD", "NET_RAW"], SecurityOpt: ["no-new-privileges"], Dns: ["172.30.9.2"] });
      expect(await mountsOf(started.containerId)).toContain(`tmpfs:${join(root, ".agentx")}:ro`);
      expect(inspected.Config.Labels).toMatchObject({ "rovara.local.owner": owner, "rovara.local.devcontainer": "1" });
      // Around the guard nothing is allowed: another container, a copy into the container and a registry that is not listed.
      await expect(docker(["cp", file, `${started.containerId}:/tmp/x`], viaGuard)).rejects.toThrow(/not allowed/u);
      await expect(docker(["pull", "quay.io/prometheus/busybox"], viaGuard)).rejects.toThrow(/not on the list/u);
      await docker(["rm", "--force", "--volumes", started.containerId], viaGuard);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      const left = await docker(["ps", "-aq", "--filter", `label=rovara.local.owner=${owner}`]).catch(() => ({ stdout: "" }));
      for (const id of left.stdout.split("\n").filter((line) => line !== "")) await docker(["rm", "--force", "--volumes", id]).catch(() => undefined);
      await docker(["network", "rm", network]).catch(() => undefined);
      if (guardServer !== undefined) { guardServer.closeAllConnections(); await new Promise<void>((resolve) => guardServer!.close(resolve)); }
      await rm(root, { recursive: true, force: true });
    }
  }, 240_000);
});
