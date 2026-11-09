import { execFile } from "node:child_process";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ProjectDefinition } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { prepareWorkspace, type RepositoryMaterializer } from "../../packages/worker/src/prepare.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

const run = promisify(execFile);

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentx-readiness-links-source-"));
  await run("git", ["init", "--quiet", "--initial-branch=main", directory]);
  await writeFile(join(directory, "README.md"), "# readiness links\n");
  await run("git", ["-C", directory, "add", "-A"]);
  await run("git", ["-C", directory, "-c", "user.name=AgentX", "-c", "user.email=agentx@example.test", "commit", "--quiet", "-m", "fixture"]);
  return directory;
}

const clone = (source: string): RepositoryMaterializer => async (_repository, destination) => {
  await run("git", ["clone", "--quiet", source, destination]);
};

const command = { cwd: "repo/app", executable: "plant", args: [], timeoutSeconds: 2 };

function project(withSetup: boolean): ProjectDefinition {
  return {
    name: "payments",
    revision: 1,
    repositories: [{ name: "app", url: "http://127.0.0.1/app.git", path: "repo/app", defaultBranch: "main", credentialRef: "app-readwrite" }],
    setup: withSetup ? [command] : [],
    readiness: [command],
    orchestratorInstructions: "Delegate all code changes to the remote worker.",
  };
}

describe("VL-1: workspace preparation checks for escaping links after the readiness commands", () => {
  it("refuses a link out of the workspace that a readiness command made, and leaves the workspace not complete", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-readiness-links-"));
    const outside = await mkdtemp(join(tmpdir(), "agentx-readiness-links-outside-"));
    let ran = 0;
    const options = {
      rootPath: root,
      project: project(true),
      materializer: clone(await fixture()),
      commandRunner: async (_command: unknown, index: number) => {
        ran += 1;
        // The setup step is clean. The readiness command (the second call) plants a link to a folder outside the workspace.
        if (ran === 2) await symlink(outside, join(root, "repo/app/escape"));
        void index;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    await expect(prepareWorkspace(options)).rejects.toThrow("workspace path escapes its root");
    expect(ran).toBe(2);
    const manifest = JSON.parse(await readFile(join(root, ".agentx/preparation-manifest.json"), "utf8")) as { complete: boolean };
    expect(manifest.complete).toBe(false);
  });

  it("positive control: the same preparation without the link completes", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-readiness-links-ok-"));
    await expect(prepareWorkspace({
      rootPath: root,
      project: project(true),
      materializer: clone(await fixture()),
      commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    })).resolves.toMatchObject({ complete: true });
  });

  it("refuses a link a readiness command made even when its readiness result is a failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-readiness-links-fail-"));
    const outside = await mkdtemp(join(tmpdir(), "agentx-readiness-links-outside-"));
    await expect(prepareWorkspace({
      rootPath: root,
      project: project(false),
      materializer: clone(await fixture()),
      commandRunner: async () => {
        await symlink(outside, join(root, "repo/app/escape"));
        return { exitCode: 1, stdout: "", stderr: "" };
      },
    })).rejects.toThrow("workspace path escapes its root");
  });
});

describe("S4-L2: the check for escaping links is made after the task sandbox is gone", () => {
  // A fake Docker whose commands all succeed. A background process of a readiness command can still make a link until its container is removed, so the fake does that at the removal.
  const sandboxWith = (onRemove: () => Promise<void>): { docker: DockerCli; removed: () => number } => {
    let removed = 0;
    return {
      removed: () => removed,
      docker: { run: async (args) => {
        if (args[0] === "rm" && args.includes("--force")) { removed += 1; await onRemove(); }
        return { exitCode: 0, stdout: "", stderr: "" };
      } },
    };
  };
  const IMAGE = "worker-image:test";

  it("refuses a link a background process made until the sandbox was removed, and leaves the workspace not complete", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-readiness-late-link-"));
    const outside = await mkdtemp(join(tmpdir(), "agentx-readiness-late-link-outside-"));
    const fake = sandboxWith(async () => { await symlink(outside, join(root, "repo/app/late-escape")); });
    await expect(prepareWorkspace({
      rootPath: root, project: project(false), materializer: clone(await fixture()), taskShell: { kind: "sandbox", docker: fake.docker, image: IMAGE },
    })).rejects.toThrow("workspace path escapes its root");
    expect(fake.removed()).toBeGreaterThan(0);
    const manifest = JSON.parse(await readFile(join(root, ".agentx/preparation-manifest.json"), "utf8")) as { complete: boolean };
    expect(manifest.complete).toBe(false);
  });

  it("I1: a sandbox that cannot be removed fails the preparation as not complete, whatever the link check would find", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-readiness-stuck-sandbox-"));
    let removeCalls = 0;
    const docker: DockerCli = { run: async (args) => {
      if (args[0] === "rm" && args.includes("--force")) { removeCalls += 1; return { exitCode: 1, stdout: "", stderr: "device or resource busy" }; }
      return { exitCode: 0, stdout: "", stderr: "" };
    } };
    await expect(prepareWorkspace({
      rootPath: root, project: project(false), materializer: clone(await fixture()), taskShell: { kind: "sandbox", docker, image: IMAGE },
    })).rejects.toThrow("could not be removed");
    expect(removeCalls).toBeGreaterThanOrEqual(2);
    const manifest = JSON.parse(await readFile(join(root, ".agentx/preparation-manifest.json"), "utf8")) as { complete: boolean; failure?: string };
    expect(manifest.complete).toBe(false);
    expect(manifest.failure).toContain("could not be removed");
  });

  it("positive control: the same preparation in the sandbox, with nothing made at its removal, completes", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-readiness-late-link-ok-"));
    const fake = sandboxWith(async () => undefined);
    await expect(prepareWorkspace({
      rootPath: root, project: project(false), materializer: clone(await fixture()), taskShell: { kind: "sandbox", docker: fake.docker, image: IMAGE },
    })).resolves.toMatchObject({ complete: true });
    expect(fake.removed()).toBeGreaterThan(0);
  });
});
