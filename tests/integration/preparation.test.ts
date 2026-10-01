import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ProjectDefinition, StoredProjectDefinition } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { prepareWorkspace, type RepositoryMaterializer } from "../../packages/worker/src/prepare.js";
import { assertWorkspaceReady, evaluateReadiness } from "../../packages/worker/src/readiness.js";

const run = promisify(execFile);
describe("workspace preparation", () => {
  it("materializes the working tree after a no-checkout clone", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-workspace-"));
    const source = await createGitFixture("no-checkout");
    const project = fixtureProject([{ name: "no-checkout", commit: source.commit }]);
    const credentialProvider = async () => ({ token: "short-lived-token" });

    const manifest = await prepareWorkspace({
      rootPath: root,
      project,
      credentialProvider,
      materializer: async (_repository, destination, credential) => {
        expect(credential).toEqual({ token: "short-lived-token" });
        await run("git", ["clone", "--quiet", "--no-checkout", source.directory, destination]);
      },
    });

    expect(manifest.complete).toBe(true);
    expect(manifest.repositories[0]).toMatchObject({
      defaultBranch: "main",
      resolvedCommit: source.commit,
    });
    await expect(readFile(join(root, "repo/no-checkout/README.md"), "utf8")).resolves.toBe(
      "# no-checkout\n",
    );
  });

  it("resumes a partial clone and never replaces an existing checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-workspace-"));
    const sources = await Promise.all([createGitFixture("one"), createGitFixture("two")]);
    const project = fixtureProject([
      { name: "one", commit: sources[0].commit },
      { name: "two", commit: sources[1].commit },
    ]);
    const cloneCounts = new Map<string, number>();
    let failSecondClone = true;
    const materializer: RepositoryMaterializer = async (repository, destination) => {
      cloneCounts.set(repository.name, (cloneCounts.get(repository.name) ?? 0) + 1);
      if (repository.name === "two" && failSecondClone) {
        failSecondClone = false;
        throw new Error("simulated repository outage");
      }
      const source = sources[repository.name === "one" ? 0 : 1].directory;
      await run("git", ["clone", "--quiet", source, destination]);
    };

    await expect(prepareWorkspace({ rootPath: root, project, materializer })).rejects.toThrow(
      "simulated repository outage",
    );
    await writeFile(join(root, "repo/one/private-edit.txt"), "must survive\n");

    const manifest = await prepareWorkspace({ rootPath: root, project, materializer });

    expect(manifest.complete).toBe(true);
    expect(cloneCounts.get("one")).toBe(1);
    expect(cloneCounts.get("two")).toBe(2);
    await expect(readFile(join(root, "repo/one/private-edit.txt"), "utf8")).resolves.toBe("must survive\n");
  });

  it("records completed setup steps atomically and retries only unfinished work", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-workspace-"));
    const source = await createGitFixture("setup");
    const project = {
      ...fixtureProject([{ name: "setup", commit: source.commit }]),
      setup: [
        { cwd: "repo/setup", executable: "fixture-step-zero", args: [], timeoutSeconds: 2 },
        { cwd: "repo/setup", executable: "fixture-step-one", args: [], timeoutSeconds: 2 },
      ],
    } satisfies ProjectDefinition;
    const stepRuns = [0, 0];
    let failStepOne = true;

    const options = {
      rootPath: root,
      project,
      materializer: (async (_repository, destination) => {
        await run("git", ["clone", "--quiet", source.directory, destination]);
      }) satisfies RepositoryMaterializer,
      commandRunner: async (_command: ProjectDefinition["setup"][number], index: number) => {
        stepRuns[index] = (stepRuns[index] ?? 0) + 1;
        if (index === 1 && failStepOne) {
          failStepOne = false;
          throw new Error("setup failed once");
        }
        return { exitCode: 0, stdout: `step ${index}`, stderr: "" };
      },
    };

    await expect(prepareWorkspace(options)).rejects.toThrow("setup failed once");
    const manifest = await prepareWorkspace(options);

    expect(stepRuns).toEqual([1, 2]);
    expect(manifest.completedSetupSteps).toEqual([0, 1]);
    expect(JSON.parse(await readFile(join(root, ".agentx/preparation-manifest.json"), "utf8"))).toEqual(
      manifest,
    );
  });

  it("ignores an inaccessible filesystem-owned lost+found directory at the workspace root", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-workspace-"));
    const source = await createGitFixture("ebs-root");
    const project = fixtureProject([{ name: "ebs-root", commit: source.commit }]);
    const systemDirectory = join(root, "lost+found");
    await mkdir(systemDirectory);
    await chmod(systemDirectory, 0o000);

    try {
      const manifest = await prepareWorkspace({
        rootPath: root,
        project,
        materializer: async (_repository, destination) => {
          await run("git", ["clone", "--quiet", source.directory, destination]);
        },
      });
      expect(manifest.complete).toBe(true);
    } finally {
      await chmod(systemDirectory, 0o700);
    }
  });

  it("prepares a workspace whose stored definition has a connector of an unknown type", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-workspace-"));
    const source = await createGitFixture("rolled-back");
    const project = {
      ...fixtureProject([{ name: "rolled-back", commit: source.commit }]),
      integrations: {
        connectors: [
          {
            name: "tracker",
            type: "future-vendor",
            credentialRef: "future-vendor-key",
            scopes: ["rolled-back"],
            tools: [{ name: "list_items", access: "read" }],
          },
        ],
      },
    } satisfies StoredProjectDefinition;

    const manifest = await prepareWorkspace({
      rootPath: root,
      project,
      materializer: async (_repository, destination) => {
        await run("git", ["clone", "--quiet", source.directory, destination]);
      },
    });

    expect(manifest.complete).toBe(true);
  });

  it("still rejects a project whose non-connector field is invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-workspace-"));
    const project: ProjectDefinition = {
      ...fixtureProject([{ name: "bad", commit: "deadbeef" }]),
      revision: -1,
    };

    await expect(prepareWorkspace({ rootPath: root, project })).rejects.toThrow();
  });

  it("does not permit coding until every configured readiness check succeeds", async () => {
    await expect(
      evaluateReadiness(
        {
          rootPath: "/mnt/workspace",
          commands: [{ cwd: "repo/app", executable: "check", args: [], timeoutSeconds: 1 }],
        },
        async () => ({ exitCode: 1, stdout: "", stderr: "not ready" }),
      ),
    ).resolves.toMatchObject({ ready: false });

    expect(() => assertWorkspaceReady("PREPARING")).toThrow(/not ready/i);
    expect(() => assertWorkspaceReady("PREPARATION_FAILED")).toThrow(/preparation failed/i);
    expect(() => assertWorkspaceReady("READY")).not.toThrow();
  });
});

// #154: a failed setup step or readiness check says which command failed, and why, with the last
// lines of its error output, redacted before they are cut.
describe("a failed setup or readiness command (#154)", () => {
  const TOKEN = `ghp_${"A1b2C3d4E5".repeat(4)}`;

  async function preparing(name: string, commands: { setup?: ProjectDefinition["setup"]; readiness?: ProjectDefinition["readiness"] }) {
    const root = await mkdtemp(join(tmpdir(), "agentx-workspace-"));
    const source = await createGitFixture(name);
    const project = { ...fixtureProject([{ name, commit: source.commit }]), ...commands } satisfies ProjectDefinition;
    const materializer: RepositoryMaterializer = async (_repository, destination) => {
      await run("git", ["clone", "--quiet", source.directory, destination]);
    };
    const failure = await prepareWorkspace({ rootPath: root, project, materializer }).then(
      () => { throw new Error("preparation unexpectedly succeeded"); },
      (error: unknown) => error as Error,
    );
    const manifest = JSON.parse(await readFile(join(root, ".agentx/preparation-manifest.json"), "utf8")) as { failure?: string };
    return { message: failure.message, manifest };
  }

  it("names the step's command and directory and says it timed out, with its limit", async () => {
    const { message, manifest } = await preparing("timeout", {
      setup: [{ cwd: "repo/timeout", executable: "sleep", args: ["30"], timeoutSeconds: 1 }],
    });
    expect(message).toBe("setup step 0 (sleep 30 in repo/timeout) timed out after 1 s");
    expect(manifest.failure).toBe(message);
  });

  it("says a step exited with its code and shows only the last lines of its error output", async () => {
    const { message } = await preparing("noisy", {
      setup: [{ cwd: "repo/noisy", executable: "sh", args: ["-c", "i=1; while [ $i -le 100 ]; do echo line-$i >&2; i=$((i+1)); done; exit 3"], timeoutSeconds: 10 }],
    });
    expect(message).toMatch(/^setup step 0 \(sh -c i=1; .* in repo\/noisy\) exited 3\nLast lines:\n/);
    const lines = message.split("Last lines:\n")[1]!.split("\n");
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe("line-81");
    expect(lines.at(-1)).toBe("line-100");
    expect(message).not.toContain("line-80\n");
    expect(message.length).toBeLessThanOrEqual(1_000);
  });

  it("keeps the end of more than 1 MiB of error output, where the error is, and lets the step finish", async () => {
    const script = "process.stderr.write(\"noise\\n\".repeat(400000)); process.stderr.write(\"the real error\\n\"); process.exitCode = 1;";
    const { message } = await preparing("flood", {
      setup: [{ cwd: "repo/flood", executable: process.execPath, args: ["-e", script], timeoutSeconds: 20 }],
    });
    expect(message).toMatch(/\) exited 1\nLast lines:\n/);
    expect(message.endsWith("noise\nthe real error")).toBe(true);
  });

  it("says a step could not run when its executable does not exist (#154 review)", async () => {
    const { message } = await preparing("missing-exe", {
      setup: [{ cwd: "repo/missing-exe", executable: "agentx-no-such-command-154", args: [], timeoutSeconds: 10 }],
    });
    expect(message).toMatch(/^setup step 0 \(agentx-no-such-command-154 in repo\/missing-exe\) could not run\nLast lines:\n.*ENOENT/);
  });

  it("names the step when its directory does not exist (#154 review)", async () => {
    const { message } = await preparing("missing-cwd", {
      setup: [{ cwd: "repo/missing-cwd/nowhere", executable: "true", args: [], timeoutSeconds: 10 }],
    });
    expect(message).toBe("setup step 0 (true in repo/missing-cwd/nowhere) could not run\nLast lines:\ndirectory does not exist in this workspace: repo/missing-cwd/nowhere");
  });

  it("caps the command at 120 characters", async () => {
    const { message } = await preparing("long", {
      setup: [{ cwd: "repo/long", executable: "sh", args: ["-c", `exit 1; ${"x".repeat(300)}`], timeoutSeconds: 10 }],
    });
    const shown = /^setup step 0 \((.*) in repo\/long\) exited 1$/.exec(message)?.[1];
    expect(shown).toBeDefined();
    expect(shown!.length).toBeLessThanOrEqual(120);
    expect(shown!.endsWith("...")).toBe(true);
  });

  it("says a step was killed by a signal", async () => {
    const { message } = await preparing("killed", {
      setup: [{ cwd: "repo/killed", executable: "sh", args: ["-c", "kill -KILL $$"], timeoutSeconds: 10 }],
    });
    expect(message).toBe("setup step 0 (sh -c kill -KILL $$ in repo/killed) was killed by SIGKILL");
  });

  it("redacts a token in the step's arguments and in its error output, before the output is cut", async () => {
    const { message, manifest } = await preparing("secret", {
      setup: [{ cwd: "repo/secret", executable: "sh", args: ["-c", `echo "fatal: bad credentials ${TOKEN}" >&2; exit 1`, "--token", TOKEN], timeoutSeconds: 10 }],
    });
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain(TOKEN.slice(0, 12));
    expect(message).toContain("--token [REDACTED]");
    expect(message).toContain("fatal: bad credentials [REDACTED]");
    expect(JSON.stringify(manifest.failure)).not.toContain(TOKEN.slice(0, 12));
  });

  it("fails a setup step that timed out even when it exited 0 on SIGTERM (#170 review)", async () => {
    const { message } = await preparing("trapped", {
      setup: [{ cwd: "repo/trapped", executable: "sh", args: ["-c", "trap 'exit 0' TERM; sleep 30 & wait"], timeoutSeconds: 1 }],
    });
    expect(message).toBe("setup step 0 (sh -c trap 'exit 0' TERM; sleep 30 & wait in repo/trapped) timed out after 1 s");
  });

  it("is not ready when a readiness check timed out, even when it exited 0 on SIGTERM (#170 review)", async () => {
    const { message } = await preparing("trapready", {
      readiness: [{ cwd: "repo/trapready", executable: "sh", args: ["-c", "trap 'exit 0' TERM; sleep 30 & wait"], timeoutSeconds: 1 }],
    });
    expect(message).toBe("readiness check 0 (sh -c trap 'exit 0' TERM; sleep 30 & wait in repo/trapready) timed out after 1 s");
  });

  it("stores a failed preparation's reason in the manifest redacted (#170 review)", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-workspace-"));
    const project = fixtureProject([{ name: "clonefail", commit: "a".repeat(40) }]);
    const materializer: RepositoryMaterializer = async () => {
      throw new Error(`fatal: could not read from remote: bad credentials ${TOKEN}`);
    };
    await expect(prepareWorkspace({ rootPath: root, project, materializer })).rejects.toThrow(/could not read/);
    const stored = await readFile(join(root, ".agentx/preparation-manifest.json"), "utf8");
    expect(stored).not.toContain(TOKEN);
    expect((JSON.parse(stored) as { failure?: string }).failure).toBe("fatal: could not read from remote: bad credentials [REDACTED]");
  });

  it("stores a readiness check's output in the manifest redacted, never raw (#170)", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-workspace-"));
    const source = await createGitFixture("stored");
    const project = {
      ...fixtureProject([{ name: "stored", commit: source.commit }]),
      readiness: [{ cwd: "repo/stored", executable: "sh", args: ["-c", `echo "token ${TOKEN}"; echo "again ${TOKEN}" >&2`], timeoutSeconds: 10 }],
    } satisfies ProjectDefinition;
    const materializer: RepositoryMaterializer = async (_repository, destination) => {
      await run("git", ["clone", "--quiet", source.directory, destination]);
    };
    const manifest = await prepareWorkspace({ rootPath: root, project, materializer });
    expect(manifest.readinessResults[0]).toMatchObject({ ready: true, stdout: "token [REDACTED]\n", stderr: "again [REDACTED]\n" });
    expect(await readFile(join(root, ".agentx/preparation-manifest.json"), "utf8")).not.toContain(TOKEN);
  });

  it("names the first failed readiness check, how it failed, and how many more failed", async () => {
    const { message } = await preparing("ready", {
      readiness: [
        { cwd: "repo/ready", executable: "true", args: [], timeoutSeconds: 10 },
        { cwd: "repo/ready", executable: "sh", args: ["-c", "echo 2 tests failed >&2; exit 1"], timeoutSeconds: 10 },
        { cwd: "repo/ready", executable: "false", args: [], timeoutSeconds: 10 },
      ],
    });
    expect(message).toBe("readiness check 1 (sh -c echo 2 tests failed >&2; exit 1 in repo/ready) exited 1 (and 1 more)\nLast lines:\n2 tests failed");
  });
});

async function createGitFixture(name: string): Promise<{ directory: string; commit: string }> {
  const directory = await mkdtemp(join(tmpdir(), `agentx-${name}-source-`));
  await run("git", ["init", "--quiet", "--initial-branch=main", directory]);
  await writeFile(join(directory, "README.md"), `# ${name}\n`);
  await run("git", ["-C", directory, "add", "README.md"]);
  await run("git", ["-C", directory, "-c", "user.name=AgentX", "-c", "user.email=agentx@example.test", "commit", "--quiet", "-m", "fixture"]);
  const { stdout } = await run("git", ["-C", directory, "rev-parse", "HEAD"]);
  return { directory, commit: stdout.trim() };
}

function fixtureProject(repositories: Array<{ name: string; commit: string }>): ProjectDefinition {
  return {
    name: "payments",
    revision: 1,
    repositories: repositories.map((repository) => ({
      name: repository.name,
      url: `http://127.0.0.1/${repository.name}.git`,
      path: `repo/${repository.name}`,
      defaultBranch: "main",
      credentialRef: `${repository.name}-readwrite`,
    })),
    setup: [],
    readiness: [],
    orchestratorInstructions: "Delegate all code changes to the remote worker.",
  };
}
