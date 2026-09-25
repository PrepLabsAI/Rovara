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
            type: "linear",
            credentialRef: "linear-key",
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
