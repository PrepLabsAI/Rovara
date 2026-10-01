import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runCollected, type CollectedProcess, type CollectedProcessOptions } from "../collected-process.js";
import type { ContainerExec } from "../devcontainer.js";
import { offlineSettings } from "./offline.js";

/** SWE-bench publishes x86 images only (spec 043). */
export const TASK_PLATFORM = "linux/amd64";
/** Where every SWE-bench image keeps the repository, at the task's base commit. */
export const TESTBED = "/testbed";

/** The Docker CLI, as a seam for tests. */
export interface DockerCli {
  run(args: readonly string[], options?: CollectedProcessOptions): Promise<CollectedProcess>;
}

export function createDockerCli(): DockerCli {
  return { run: (args, options) => runCollected("docker", args, options ?? {}) };
}

/** Pulls the task image and returns the digest it resolved to, as `<repository>@sha256:<hex>`. */
export async function pullTaskImage(docker: DockerCli, image: string): Promise<string> {
  await checked(docker, ["pull", "--platform", TASK_PLATFORM, image], `pull ${image}`, { timeoutMs: 30 * 60_000 });
  const inspected = await checked(docker, ["image", "inspect", "--format", "{{json .RepoDigests}}", image], `inspect ${image}`);
  const digests = JSON.parse(inspected.stdout.trim() || "[]") as unknown;
  const digest = Array.isArray(digests) ? digests.find((value): value is string => typeof value === "string" && value.includes("@sha256:")) : undefined;
  if (digest === undefined) throw new Error(`${image} has no registry digest after the pull`);
  return digest;
}

/**
 * Where the image keeps the repository: SWE-bench's at /testbed, SWE-Bench Pro's at /app and a few
 * at /testbed (spec 044 FR-004).
 */
export async function findRepository(docker: DockerCli, image: string): Promise<string> {
  const found = await checked(docker, [
    "run", "--rm", "--platform", TASK_PLATFORM, "--network", "none", "--entrypoint", "sh", image, "-c",
    "for d in /app /testbed; do if [ -d \"$d/.git\" ]; then echo \"$d\"; exit 0; fi; done; exit 3",
  ], `find the repository in ${image}`, { timeoutMs: 5 * 60_000 });
  const path = found.stdout.trim().split("\n").pop() ?? "";
  if (path !== "/app" && path !== TESTBED) throw new Error(`${image} has no git repository at /app or /testbed`);
  return path;
}

/** Copies the image's repository (/testbed unless given) to `hostFolder`, which must not exist yet. */
export async function copyTestbed(docker: DockerCli, image: string, hostFolder: string, repository: string = TESTBED): Promise<void> {
  const name = `agentx-swebench-copy-${randomUUID()}`;
  await checked(docker, ["create", "--platform", TASK_PLATFORM, "--name", name, image], `create a container from ${image}`);
  try {
    await checked(docker, ["cp", `${name}:${repository}`, hostFolder], `copy ${repository} out of the image`, { timeoutMs: 20 * 60_000 });
  } finally {
    await docker.run(["rm", "--force", name]).catch(() => undefined);
  }
}

/**
 * Starts the task container the agent's shell runs in (FR-009, FR-011): no network, the host copy of
 * the repository mounted back where the image keeps it, so the image's install sees the agent's edits, and the
 * run's root mounted at its own path so the shell's working directory exists in the container.
 * Every shell command starts in the image's `testbed` conda environment, with the offline data
 * settings (offline.ts), through BASH_ENV.
 */
export async function startTaskContainer(
  docker: DockerCli,
  input: { image: string; name: string; rootPath: string; testbedHost: string; repository?: string },
): Promise<void> {
  const repository = input.repository ?? TESTBED;
  const environmentFile = resolve(input.rootPath, ".agentx", "swebench-shell.sh");
  const offline = await offlineSettings(input.rootPath);
  await writeFile(environmentFile, [
    "# Sourced by every non-interactive bash in the SWE-bench task container (spec 043).",
    "# In a function, so conda's activate does not read the command's own positional arguments.",
    "__agentx_testbed() { . /opt/miniconda3/bin/activate && conda activate testbed; }",
    "if [ -f /opt/miniconda3/bin/activate ]; then __agentx_testbed; fi",
    "unset -f __agentx_testbed",
    ...offline,
    "",
  ].join("\n"), { mode: 0o644 });
  await checked(docker, [
    "run", "--detach",
    "--platform", TASK_PLATFORM,
    "--name", input.name,
    "--network", "none",
    "--volume", `${input.rootPath}:${input.rootPath}`,
    "--volume", `${input.testbedHost}:${repository}`,
    "--env", `BASH_ENV=${environmentFile}`,
    "--workdir", repository,
    "--entrypoint", "tail",
    input.image, "-f", "/dev/null",
  ], `start the task container from ${input.image}`, { timeoutMs: 5 * 60_000 });
}

/** `docker exec` in the task container, for the agent's shell. */
export function taskContainerExec(docker: DockerCli, name: string): ContainerExec {
  return (command, options) => docker.run([
    "exec",
    ...Object.entries(options.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    name, ...command,
  ], {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onStdout === undefined ? {} : { onStdout: options.onStdout }),
    ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
  });
}

export async function removeContainer(docker: DockerCli, name: string): Promise<void> {
  await docker.run(["rm", "--force", name]).catch(() => undefined);
}

async function checked(docker: DockerCli, args: readonly string[], what: string, options: CollectedProcessOptions = {}): Promise<CollectedProcess> {
  const result = await docker.run(args, options);
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim().split("\n").slice(-5).join(" ").slice(0, 800);
    throw new Error(`could not ${what}${result.timedOut === true ? " (timed out)" : ""}: ${detail || `exit ${String(result.exitCode)}`}`);
  }
  return result;
}
