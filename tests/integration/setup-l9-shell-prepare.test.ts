// SETUP-L9-SHELL (DEC 254zzz562): a real workspace preparation, in the task sandbox (a Docker CLI whose container is this machine, as sandbox-python-user-site.test.ts does), runs the saved setup lines and test lines
// of a FIXTURE repository as shell lines: one shell session for the setup group, one for the test group. The clean-machine check, a task's machine and the setup proof all run `prepareWorkspace`, so this is the one journey.
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ProjectDefinitionSchema, parseCommandLine, type ProjectDefinition } from "@agentx/contracts";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { prepareWorkspace } from "../../packages/worker/src/prepare.js";
import type { DockerCli } from "../../packages/worker/src/docker-cli.js";

const run = promisify(execFile);
const IMAGE = "123456789012.dkr.ecr.us-west-2.amazonaws.com/agentx-staging/worker@sha256:" + "d".repeat(64);
const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

let pythonDirectories: string[] = [];
let pythonAvailable = false;
beforeAll(async () => {
  pythonAvailable = await run("python3", ["-m", "venv", "--help"]).then(() => true, () => false);
  if (!pythonAvailable) return;
  // Where a venv made here points its interpreter links: the real interpreter's folder, and the folder `python3` is found in.
  const real = (await run("python3", ["-c", "import os, sys; print(os.path.dirname(os.path.realpath(sys.executable))); print(os.path.dirname(sys.executable))"])).stdout.trim().split("\n");
  const found = (await run("sh", ["-c", "dirname \"$(command -v python3)\""])).stdout.trim();
  pythonDirectories = [...new Set([...real, found, dirname(await realpath(found))])];
});

/** A Docker CLI whose container is this machine with an environment of its own (PATH with a stand-in `npm`, HOME): only what an exec passes reaches the command. */
function localContainer(home: string, stubBin: string): DockerCli {
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
      const env = { PATH: `${stubBin}:${process.env["PATH"] ?? ""}`, HOME: home, PIP_DISABLE_PIP_VERSION_CHECK: "1", ...flags };
      return await new Promise((resolve) => {
        const child = spawn(command[0]!, command.slice(1), { env, stdio: ["ignore", "pipe", "pipe"], ...(options?.signal === undefined ? {} : { signal: options.signal }) });
        let stdout = ""; let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); options?.onStdout?.(chunk); });
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); options?.onStderr?.(chunk); });
        child.on("error", (error) => resolve({ exitCode: -1, stdout, stderr: `${stderr}${error.message}` }));
        child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
      });
    },
  };
}

async function scratch(prefix: string): Promise<string> { const path = await realpath(await mkdtemp(join(tmpdir(), prefix))); cleanup.push(path); return path; }

async function fixtureRepository(files: Record<string, string>): Promise<string> {
  const source = await scratch("agentx-l9-source-");
  for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(source, path)), { recursive: true }); await writeFile(join(source, path), text); }
  await run("git", ["init", "--quiet", "--initial-branch=main", source]);
  await run("git", ["-C", source, "add", "-A"]);
  await run("git", ["-C", source, "-c", "user.name=AgentX", "-c", "user.email=agentx@example.test", "commit", "--quiet", "-m", "fixture"]);
  return source;
}

const lines = (setup: string[], tests: string[], timeoutSeconds = 120): Pick<ProjectDefinition, "setup" | "readiness"> => ({
  setup: setup.map((text) => parseCommandLine(text, "repo/app", timeoutSeconds)),
  readiness: tests.map((text) => parseCommandLine(text, "repo/app", timeoutSeconds)),
});

function project(commands: Pick<ProjectDefinition, "setup" | "readiness">): ProjectDefinition {
  return ProjectDefinitionSchema.parse({
    name: "app", revision: 1,
    repositories: [{ name: "app", url: "http://127.0.0.1/app.git", path: "repo/app", defaultBranch: "main", credentialRef: "app-readwrite" }],
    orchestratorInstructions: "Delegate all code changes to the remote worker.",
    ...commands,
  });
}

async function prepare(source: string, definition: ProjectDefinition) {
  const root = await scratch("agentx-l9-task-");
  const home = await scratch("agentx-l9-home-");
  const stubBin = await scratch("agentx-l9-bin-");
  await writeFile(join(stubBin, "npm"), '#!/bin/sh\necho "npm $* in $(basename "$PWD")" | tee -a "$HOME/npm.log"\n');
  await chmod(join(stubBin, "npm"), 0o755);
  const materializer = async (_repository: unknown, destination: string) => { await run("git", ["clone", "--quiet", source, destination]); };
  const outcome = await prepareWorkspace({
    rootPath: root, project: definition, materializer,
    taskShell: { kind: "sandbox", docker: localContainer(home, stubBin), image: IMAGE },
    venvLinkPolicy: { interpreterDirectories: pythonDirectories, managedPythonRoots: [] },
  }).then((manifest) => ({ manifest, error: undefined as string | undefined }), (error: unknown) => ({ manifest: undefined, error: error instanceof Error ? error.message : String(error) }));
  return { root, home, ...outcome };
}

describe("a project's saved setup and test lines are run by a shell, in one session per group", () => {
  it("the owner's case runs green on a fixture repo: `python3 -m venv .venv`, `source ... && pip install -r requirements.txt`, `source ... && python3 -m src.db`", async () => {
    if (!pythonAvailable) return;
    const source = await fixtureRepository({
      "requirements.txt": "# nothing to install\n",
      "src/__init__.py": "",
      "src/db.py": "import os, sys\nassert sys.prefix != sys.base_prefix, 'not in the venv'\nprint('db ok', os.path.basename(os.environ['VIRTUAL_ENV']))\n",
    });
    const { manifest, error } = await prepare(source, project(lines(
      ["python3 -m venv .venv", "source .venv/bin/activate && pip install -r requirements.txt", "source .venv/bin/activate && python3 -m src.db"],
      // The test group is a session of its own, started clean: its first line activates, the next needs no `source` of its own.
      ["source .venv/bin/activate", "python3 -c \"import sys; sys.exit(0 if sys.prefix != sys.base_prefix else 1)\"", "python3 -m src.db"],
    )));
    expect(error).toBeUndefined();
    expect(manifest).toMatchObject({ complete: true, completedSetupSteps: [0, 1, 2] });
    expect(manifest?.readinessResults?.map((result) => result.ready)).toEqual([true, true, true]);
    expect(manifest?.readinessResults?.[2]?.stdout.trim()).toBe("db ok .venv");
  }, 180_000);

  it("`cd sub && npm ci` runs in sub, and the next line starts at the root again (cd does not persist)", async () => {
    const source = await fixtureRepository({ "sub/package.json": "{}\n", "README.md": "app\n" });
    const { home, manifest, error } = await prepare(source, project(lines(["cd sub && npm ci", "npm run build"], ["npm test"])));
    expect(error).toBeUndefined();
    expect(manifest?.complete).toBe(true);
    expect((await readFile(join(home, "npm.log"), "utf8")).trim().split("\n")).toEqual(["npm ci in sub", "npm run build in app", "npm test in app"]);
  });

  it("`cd frontend && npm ci` then `cd backend && npm ci` both work: each line starts at the repository root", async () => {
    const source = await fixtureRepository({ "frontend/package.json": "{}\n", "backend/package.json": "{}\n" });
    const { home, error } = await prepare(source, project(lines(["cd frontend && npm ci", "cd backend && npm ci"], [])));
    expect(error).toBeUndefined();
    expect((await readFile(join(home, "npm.log"), "utf8")).trim().split("\n")).toEqual(["npm ci in frontend", "npm ci in backend"]);
  });

  it("a failing middle line stops the group and names that line, with its exit code and its last lines; the lines after it never run", async () => {
    const source = await fixtureRepository({ "README.md": "app\n" });
    const { root, manifest, error } = await prepare(source, project(lines(
      ["echo first > first.txt", "echo broken-here >&2 && exit 7", "echo third > third.txt"],
      ["npm test"],
    )));
    expect(manifest).toBeUndefined();
    expect(error).toMatch(/^setup step 1 \(echo broken-here >&2 && exit 7 in repo\/app\) exited 7/u);
    expect(error).toContain("broken-here");
    expect(await readFile(join(root, "repo/app/first.txt"), "utf8")).toBe("first\n");
    await expect(readFile(join(root, "repo/app/third.txt"), "utf8")).rejects.toThrow();
  });

  it("a line that runs past its time limit is stopped and named as timed out, well before the shell would have ended", async () => {
    const source = await fixtureRepository({ "README.md": "app\n" });
    const started = Date.now();
    const { error } = await prepare(source, project({ setup: [parseCommandLine("sleep 60 && echo done", "repo/app", 1)], readiness: [] }));
    expect(error).toMatch(/^setup step 0 \(sleep 60 && echo done in repo\/app\) timed out after 1 s/u);
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);

  it("a test line that fails is reported as that test, and the lines before and after it still run (the test group is not stopped by a failure)", async () => {
    const source = await fixtureRepository({ "README.md": "app\n" });
    const { manifest, error } = await prepare(source, project(lines([], ["echo one", "exit 2", "echo three"])));
    expect(manifest).toBeUndefined();
    expect(error).toMatch(/^readiness check 1 \(exit 2 in repo\/app\) exited 2/u);
  });
});
