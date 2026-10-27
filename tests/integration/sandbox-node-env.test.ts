// the worker image sets NODE_ENV=production for the worker itself, and the task sandbox starts from that image, so a
// project's `npm ci` skipped its devDependencies and `npm test` exited 127 (vitest not found). The sandbox's commands (project
// setup and readiness, AgentX's checks, the agent's shell) must not inherit it; a project's own `env` still sets it.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ProjectDefinitionSchema, type ProjectCommand, type ProjectDefinition } from "@agentx/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { prepareWorkspace } from "../../packages/worker/src/prepare.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import { TaskSandbox } from "../../packages/worker/src/task-sandbox.js";

const run = promisify(execFile);
const IMAGE = "registry.example.test/agentx/worker@sha256:" + "b".repeat(64);
/** The ENV of environments/base/Dockerfile that a container started from the worker image carries. */
const IMAGE_ENV = { NODE_ENV: "production", PORT: "8080" };
const NPM = join(dirname(process.execPath), "npm");

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * A Docker CLI whose containers are this machine: `docker exec --env K=V name cmd...` runs `cmd` here, in an environment made of
 * the image's ENV and the `--env` flags and nothing of this process's own NODE_ENV, which is what Docker does.
 */
function localContainers(home: string): DockerCli {
  return {
    run: async (args, options) => {
      if (args[0] === "network" && args[1] === "inspect") return { exitCode: 0, stdout: "bridge {} false", stderr: "" };
      if (args[0] !== "exec") return { exitCode: 0, stdout: "", stderr: "" };
      const flags: Record<string, string> = {};
      let index = 1;
      while (args[index] === "--env") {
        const [name, ...value] = args[index + 1]!.split("=");
        flags[name!] = value.join("=");
        index += 2;
      }
      const [, ...command] = [args[index], ...args.slice(index + 1)];
      const env = { PATH: process.env["PATH"] ?? "", HOME: home, npm_config_cache: join(home, ".npm"), npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false", ...IMAGE_ENV, ...flags };
      return await new Promise((resolve) => {
        const child = spawn(command[0]!, command.slice(1), { env, stdio: ["ignore", "pipe", "pipe"], ...(options?.signal === undefined ? {} : { signal: options.signal }) });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); options?.onStdout?.(chunk); });
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); options?.onStderr?.(chunk); });
        child.on("error", (error) => resolve({ exitCode: -1, stdout, stderr: `${stderr}${error.message}` }));
        child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
      });
    },
  };
}

/** A real Node project whose test command is a devDependency's executable (the shape of vitest, jest or mocha). */
async function nodeProjectSource(): Promise<string> {
  const source = await mkdtemp(join(tmpdir(), "agentx-node-env-source-"));
  cleanup.push(source);
  await mkdir(join(source, "tools/test-runner"), { recursive: true });
  await writeFile(join(source, "tools/test-runner/package.json"), JSON.stringify({ name: "test-runner", version: "1.0.0", bin: { "test-runner": "bin.js" } }));
  await writeFile(join(source, "tools/test-runner/bin.js"), "#!/usr/bin/env node\nconsole.log('1 test passed');\n", { mode: 0o755 });
  await writeFile(join(source, "package.json"), JSON.stringify({
    name: "sample", version: "1.0.0", private: true, scripts: { test: "test-runner" }, devDependencies: { "test-runner": "file:./tools/test-runner" },
  }));
  await run(NPM, ["install", "--package-lock-only", "--offline", "--ignore-scripts"], { cwd: source, env: { ...process.env, NODE_ENV: "development" } });
  await run("git", ["init", "--quiet", "--initial-branch=main", source]);
  await run("git", ["-C", source, "add", "."]);
  await run("git", ["-C", source, "-c", "user.name=AgentX", "-c", "user.email=agentx@example.test", "commit", "--quiet", "-m", "fixture"]);
  return source;
}

const command = (executable: string, args: string[], env?: Record<string, string>): ProjectCommand => ({
  cwd: "repo/sample", executable, args, timeoutSeconds: 120, ...(env === undefined ? {} : { env }),
});

function project(overrides: Partial<ProjectDefinition> = {}): ProjectDefinition {
  return ProjectDefinitionSchema.parse({
    name: "sample", revision: 1,
    repositories: [{ name: "sample", url: "http://127.0.0.1/sample.git", path: "repo/sample", defaultBranch: "main", credentialRef: "sample-readwrite" }],
    setup: [], readiness: [], orchestratorInstructions: "Delegate all code changes to the remote worker.",
    ...overrides,
  });
}

async function prepare(definition: ProjectDefinition) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-node-env-task-")));
  const home = await mkdtemp(join(tmpdir(), "agentx-node-env-home-"));
  cleanup.push(root, home);
  const source = await nodeProjectSource();
  const materializer = async (_repository: unknown, destination: string) => { await run("git", ["clone", "--quiet", source, destination]); };
  const docker = localContainers(home);
  const outcome = await prepareWorkspace({ rootPath: root, project: definition, materializer, taskShell: { kind: "sandbox", docker, image: IMAGE } })
    .then((manifest) => ({ manifest, error: undefined }), (error: unknown) => ({ manifest: undefined, error: error instanceof Error ? error.message : String(error) }));
  return { root, home, docker, ...outcome };
}

describe("a project's Node project in the task sandbox", () => {
  it("installs its devDependencies with `npm ci` and passes `npm test`, although the image sets NODE_ENV=production", async () => {
    const { error, manifest } = await prepare(project({ setup: [command("npm", ["ci"])], readiness: [command("npm", ["test"])] }));
    expect(error).toBeUndefined();
    expect(manifest?.complete).toBe(true);
    expect(manifest?.readinessResults?.[0]).toMatchObject({ ready: true, exitCode: 0 });
  }, 120_000);

  it("runs the agent's shell without the image's NODE_ENV", async () => {
    const { root, home, docker } = await prepare(project());
    const sandbox = new TaskSandbox({ rootPath: root, taskId: randomUUID(), docker, image: IMAGE });
    let output = "";
    const { exitCode } = await sandbox.bashOperations().exec('printf "NODE_ENV=[%s] PORT=[%s]" "${NODE_ENV-unset}" "$PORT"', join(root, "repo/sample"), { onData: (data) => { output += data.toString(); }, env: { HOME: home } });
    expect(exitCode).toBe(0);
    expect(output).toBe("NODE_ENV=[unset] PORT=[8080]");
    await sandbox.dispose();
  });

  it("keeps NODE_ENV when the project's own command environment sets it", async () => {
    const { root, docker } = await prepare(project());
    const sandbox = new TaskSandbox({ rootPath: root, taskId: randomUUID(), docker, image: IMAGE });
    const shown = async (env?: Record<string, string>) => (await sandbox.runCommand(command("sh", ["-c", 'printf "[%s]" "${NODE_ENV-unset}"'], env))).stdout;
    expect(await shown()).toBe("[unset]");
    expect(await shown({ NODE_ENV: "production" })).toBe("[production]");
    expect(await shown({ NODE_ENV: "test" })).toBe("[test]");
    await sandbox.dispose();
  });

  it("does not touch the image's other variables, which are the worker's own settings", async () => {
    const { root, docker } = await prepare(project());
    const sandbox = new TaskSandbox({ rootPath: root, taskId: randomUUID(), docker, image: IMAGE });
    expect((await sandbox.runCommand(command("sh", ["-c", 'printf "%s" "$PORT"']))).stdout).toBe("8080");
    await sandbox.dispose();
  });
});
