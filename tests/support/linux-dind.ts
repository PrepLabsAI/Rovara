import { execFile } from "node:child_process";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createProcessDockerCli, type DockerCli } from "../../packages/verifier/src/host/docker-application-host.js";

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Docker 25.0.5 in Docker, pinned by the digest of the multi-architecture index. This is the daemon generation of the Amazon Linux 2023 worker (its repository
 * ships 25.0.x only), which does not forward the DNS queries of a container that is only on internal networks to a `--dns` server; the CI runner's own daemon is newer and hides that.
 */
export const DOCKER_25_DIND_IMAGE = "docker:25.0.5-dind@sha256:b41d0183012e2334aacd4e0b8e339b89246c4fdb7eada6cc86b0355f41328549";

export type Dind = Readonly<{
  name: string;
  /** The daemon's version inside, for example `25.0.5`. */
  version: string;
  /** The production host's Docker CLI, talking to the daemon inside (every call is a `docker exec` of the CLI in the dind container). */
  cli: DockerCli;
  /** Runs one docker command against the daemon inside and returns its output. */
  docker(...args: string[]): Promise<string>;
  /** Copies an image of the outer daemon into the inner one. */
  load(image: string): Promise<void>;
  stop(): Promise<void>;
}>;

/**
 * Starts a privileged Docker-in-Docker container of `image` and waits for its daemon. `shared` directories are mounted at the same path inside, so a path the production
 * host hands its Docker (a bind mount source, a seccomp profile) means the same thing to the daemon inside. Nothing about the outer daemon or host is changed: the daemon inside
 * has its own network namespace, iptables and image store.
 */
export async function startDind(image: string, shared: { path: string; readOnly?: boolean }[]): Promise<Dind> {
  const name = `rovara-dind-${process.pid}-${Date.now().toString(36)}`;
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "rovara-dind-cli-")));
  const mounts = shared.flatMap(({ path, readOnly }) => ["-v", `${path}:${path}${readOnly ? ":ro" : ""}`]);
  await execFileAsync("docker", ["run", "-d", "--privileged", "--name", name, "-e", "DOCKER_TLS_CERTDIR=", ...mounts, image]);
  const inner = async (...args: string[]) => (await execFileAsync("docker", ["exec", name, "docker", ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
  const stop = async () => {
    await execFileAsync("docker", ["rm", "-f", "-v", name]).catch(() => undefined);
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    let version = "";
    for (let attempt = 0; attempt < 120 && version === ""; attempt += 1) {
      version = await inner("version", "--format", "{{.Server.Version}}").catch(() => "");
      if (version === "") await sleep(500);
    }
    if (version === "") throw new Error("the Docker daemon inside the dind container did not start");
    // The production host spawns one binary with the docker arguments; this one runs them in the dind container.
    const binary = join(scratch, "docker");
    await writeFile(binary, `#!/bin/sh\nexec docker exec ${name} docker "$@"\n`);
    await chmod(binary, 0o755);
    return {
      name, version, cli: createProcessDockerCli(binary), docker: inner, stop,
      async load(imageRef) {
        await execFileAsync("sh", ["-c", `docker save "$1" | docker exec -i "$2" docker load`, "sh", imageRef, name], { maxBuffer: 64 * 1024 * 1024 });
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
