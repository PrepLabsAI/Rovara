// a project's `pip install --break-system-packages -r requirements-dev.txt` (Debian's pip, run as the sandbox's non-root user) installs into the
// user site under the container's own HOME. Setup runs in one throw-away sandbox container and every later operation (the task, a send-back, the checks)
// starts a new one from the image, so the installed tools were gone: `ruff` and `pytest` were "not found" (or off PATH) for the agent and for AgentX's checks.
// Project commands in the sandbox now get PYTHONUSERBASE on the workspace volume, with its bin first on PATH; a project command's own `env` still wins.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ProjectDefinitionSchema, type ProjectCommand, type ProjectDefinition } from "@agentx/contracts";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { prepareWorkspace } from "../../packages/worker/src/prepare.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import { TaskSandbox } from "../../packages/worker/src/task-sandbox.js";

const run = promisify(execFile);
const IMAGE = "registry.example.test/agentx/worker@sha256:" + "c".repeat(64);

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * A Docker CLI whose container is this machine with its own empty HOME, so two of them behave like two containers started from the same image:
 * whatever one wrote under its HOME is not there for the other. Only the workspace path is shared.
 */
function localContainer(home: string): DockerCli {
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
      const command = args.slice(index + 1);
      const env = { PATH: process.env["PATH"] ?? "", HOME: home, PIP_DISABLE_PIP_VERSION_CHECK: "1", ...flags };
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

/** A real wheel (pure Python, a console script `fixturetool`), built offline, so `pip install` of it is real pip work. */
const WHEEL_SCRIPT = `
import sys, zipfile
out = sys.argv[1]
files = {
  "fixturetool/__init__.py": "def main():\\n    print('fixturetool ran')\\n",
  "fixturetool-1.0.dist-info/METADATA": "Metadata-Version: 2.1\\nName: fixturetool\\nVersion: 1.0\\n",
  "fixturetool-1.0.dist-info/WHEEL": "Wheel-Version: 1.0\\nGenerator: test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n",
  "fixturetool-1.0.dist-info/entry_points.txt": "[console_scripts]\\nfixturetool = fixturetool:main\\n",
}
record = "".join(name + ",,\\n" for name in files) + "fixturetool-1.0.dist-info/RECORD,,\\n"
with zipfile.ZipFile(out, "w") as wheel:
    for name, body in files.items():
        wheel.writestr(name, body)
    wheel.writestr("fixturetool-1.0.dist-info/RECORD", record)
`;

let pythonAvailable = false;
beforeAll(async () => {
  pythonAvailable = await run("python3", ["-m", "pip", "--version"]).then(() => true, () => false);
});

async function wheelPath(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "agentx-py-wheel-"));
  cleanup.push(folder);
  const wheel = join(folder, "fixturetool-1.0-py3-none-any.whl");
  await run("python3", ["-I", "-c", WHEEL_SCRIPT, wheel]);
  return wheel;
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

async function workspace(options: { directory?: boolean } = {}): Promise<{ root: string; sourceRepository: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-py-task-")));
  const source = await mkdtemp(join(tmpdir(), "agentx-py-source-"));
  cleanup.push(root, source);
  if (options.directory === true) await mkdir(join(root, "repo/sample"), { recursive: true });
  await writeFile(join(source, "README.md"), "sample\n");
  await run("git", ["init", "--quiet", "--initial-branch=main", source]);
  await run("git", ["-C", source, "add", "."]);
  await run("git", ["-C", source, "-c", "user.name=AgentX", "-c", "user.email=agentx@example.test", "commit", "--quiet", "-m", "fixture"]);
  return { root, sourceRepository: source };
}

async function freshHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "agentx-py-home-"));
  cleanup.push(home);
  return home;
}

/** Runs the project's setup in one container, as workspace preparation does. */
async function prepareWith(root: string, source: string, definition: ProjectDefinition) {
  const materializer = async (_repository: unknown, destination: string) => { await run("git", ["clone", "--quiet", source, destination]); };
  return await prepareWorkspace({ rootPath: root, project: definition, materializer, taskShell: { kind: "sandbox", docker: localContainer(await freshHome()), image: IMAGE } })
    .then((manifest) => ({ manifest, error: undefined }), (error: unknown) => ({ manifest: undefined, error: error instanceof Error ? error.message : String(error) }));
}

/** A later operation: a new sandbox container (a new, empty HOME) over the same workspace. */
async function laterOperation(root: string): Promise<TaskSandbox> {
  return new TaskSandbox({ rootPath: root, taskId: randomUUID(), docker: localContainer(await freshHome()), image: IMAGE });
}

describe("a project's Python tools installed by setup", () => {
  it("are found by a later sandbox container: a project command, the agent's shell, and a readiness check", async () => {
    if (!pythonAvailable) return;
    const wheel = await wheelPath();
    const { root, sourceRepository } = await workspace();
    const { error, manifest } = await prepareWith(root, sourceRepository, project({
      setup: [command("python3", ["-m", "pip", "install", "--no-index", "--user", "--break-system-packages", wheel])],
      // The console script is on PATH in the container that ran setup, as `ruff` would be after `pip install -r requirements-dev.txt`.
      readiness: [command("fixturetool", [])],
    }));
    expect(error).toBeUndefined();
    expect(manifest?.readinessResults?.[0]).toMatchObject({ ready: true, exitCode: 0 });

    const sandbox = await laterOperation(root);
    const script = await sandbox.runCommand(command("fixturetool", []));
    expect({ exitCode: script.exitCode, stdout: script.stdout.trim() }).toEqual({ exitCode: 0, stdout: "fixturetool ran" });
    const module = await sandbox.runCommand(command("python3", ["-c", "import fixturetool; fixturetool.main()"]));
    expect({ exitCode: module.exitCode, stdout: module.stdout.trim() }).toEqual({ exitCode: 0, stdout: "fixturetool ran" });
    let shell = "";
    const { exitCode } = await sandbox.bashOperations().exec("fixturetool && python3 -c 'import fixturetool'", root, { onData: (data) => { shell += data.toString(); }, env: {} });
    expect({ exitCode, shell: shell.trim() }).toEqual({ exitCode: 0, shell: "fixturetool ran" });
    await sandbox.dispose();
  }, 180_000);

  it("keep the user site on the workspace volume, and keep its files out of Git even where the repository is the workspace root", async () => {
    if (!pythonAvailable) return;
    const wheel = await wheelPath();
    const { root } = await workspace({ directory: true });
    await run("git", ["init", "--quiet", "--initial-branch=main", root]);
    const sandbox = await laterOperation(root);
    const installed = await sandbox.runCommand(command("python3", ["-m", "pip", "install", "--no-index", "--user", "--break-system-packages", wheel]));
    expect(installed.exitCode).toBe(0);
    expect((await stat(join(root, ".agentx-python"))).isDirectory()).toBe(true);
    const status = await run("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"]);
    expect(status.stdout).toBe("");
    await sandbox.dispose();
  }, 180_000);

  it("leave a project command's own PYTHONUSERBASE and PATH alone", async () => {
    if (!pythonAvailable) return;
    const { root } = await workspace({ directory: true });
    const sandbox = await laterOperation(root);
    const base = await sandbox.runCommand(command("python3", ["-c", "import os; print(os.environ['PYTHONUSERBASE'])"]));
    expect(base.stdout.trim()).toBe(join(root, ".agentx-python"));
    const own = await sandbox.runCommand(command("python3", ["-c", "import os; print(os.environ['PYTHONUSERBASE'])"], { PYTHONUSERBASE: "/custom/base" }));
    expect(own.stdout.trim()).toBe("/custom/base");
    const defaultPath = await sandbox.runCommand(command("sh", ["-c", 'printf "%s" "$PATH"']));
    expect(defaultPath.stdout.startsWith(`${join(root, ".agentx-python", "bin")}:`)).toBe(true);
    const ownPath = await sandbox.runCommand(command("sh", ["-c", 'printf "%s" "$PATH"'], { PATH: "/usr/bin:/bin" }));
    expect(ownPath.stdout).toBe("/usr/bin:/bin");
    await sandbox.dispose();
  }, 60_000);
});
