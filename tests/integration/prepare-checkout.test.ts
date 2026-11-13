// Plan 3, Task 22: a run that looks at a pull request has the pull request's head commit checked out when its workspace is prepared: detached, at exactly the
// commit the run recorded, with the repository's own default branch commit left as the manifest's resolved commit. A head that moved since the run started
// fails the preparation, and a repository the run names no pull request for is prepared as it always was.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import type { ProjectDefinition } from "@rovara-code/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allowGitFileTransportForTests } from "../../packages/worker/src/git.js";
import { prepareWorkspace, verifyCheckedOutHeads } from "../../packages/worker/src/prepare.js";

const run = promisify(execFile);
const git = (directory: string, ...args: string[]) => run("git", ["-C", directory, "-c", "user.name=Test", "-c", "user.email=test@example.test", ...args]).then((result) => result.stdout.trim());

/** A repository whose default branch is `main`, and whose `refs/pull/12/head` is a commit that is not on it. */
async function repositoryWithPullRequest() {
  const directory = await mkdtemp(join(tmpdir(), "agentx-pr-source-"));
  await run("git", ["init", "--quiet", "--initial-branch=main", directory]);
  await writeFile(join(directory, "README.md"), "main\n");
  await git(directory, "add", ".");
  await git(directory, "commit", "--quiet", "-m", "main");
  const main = await git(directory, "rev-parse", "HEAD");
  await git(directory, "checkout", "--quiet", "-b", "feature");
  await writeFile(join(directory, "feature.txt"), "the pull request's change\n");
  await git(directory, "add", ".");
  await git(directory, "commit", "--quiet", "-m", "the change");
  const head = await git(directory, "rev-parse", "HEAD");
  await git(directory, "update-ref", "refs/pull/12/head", head);
  await git(directory, "checkout", "--quiet", "main");
  return { directory, main, head };
}

function project(): ProjectDefinition {
  return {
    name: "payments", revision: 1,
    repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "demo-readwrite" }],
    setup: [], readiness: [], orchestratorInstructions: "Delegate all code changes to the remote worker.",
  };
}

const materializer = (source: string) => async (_repository: unknown, destination: string) => {
  // --no-local: a clone of a local path would copy every object, reachable or not; this one gets what a clone over the network gets.
  await run("git", ["clone", "--quiet", "--no-checkout", "--no-local", source, destination]);
};

// The fixture repositories are local, which the worker's hardened Git refuses unless a test allows it.
let undoFileTransport: (() => void) | undefined;
beforeAll(() => { undoFileTransport = allowGitFileTransportForTests(); });
afterAll(() => { undoFileTransport?.(); });

describe("preparing a workspace for a run that looks at a pull request", () => {
  it("checks the pull request's head out detached at exactly the recorded commit, and records it beside the default branch's", async () => {
    const source = await repositoryWithPullRequest();
    const root = await mkdtemp(join(tmpdir(), "agentx-pr-workspace-"));
    const manifest = await prepareWorkspace({
      rootPath: root, project: project(), materializer: materializer(source.directory), pullRequestRemote: () => pathToFileURL(source.directory).href,
      checkout: [{ repository: "demo", pullRequest: 12, headSha: source.head }],
    });
    const repository = join(root, "repo", "demo");
    expect(await git(repository, "rev-parse", "HEAD")).toBe(source.head);
    expect(await readFile(join(repository, "feature.txt"), "utf8")).toBe("the pull request's change\n");
    expect(await git(repository, "symbolic-ref", "-q", "HEAD").catch(() => "detached")).toBe("detached");
    expect(manifest.repositories[0]).toMatchObject({ name: "demo", resolvedCommit: source.main, checkedOut: { pullRequest: 12, headSha: source.head } });
  });

  it("fails the preparation when the pull request's head is not the commit the run recorded", async () => {
    const source = await repositoryWithPullRequest();
    const root = await mkdtemp(join(tmpdir(), "agentx-pr-workspace-"));
    await mkdir(root, { recursive: true });
    await expect(prepareWorkspace({
      rootPath: root, project: project(), materializer: materializer(source.directory), pullRequestRemote: () => pathToFileURL(source.directory).href,
      checkout: [{ repository: "demo", pullRequest: 12, headSha: "a".repeat(40) }],
    })).rejects.toThrow("pull request 12 has a new commit since the run started");
  });

  it("fails when neither the pull request nor the recorded commit exists, and never falls back to the default branch", async () => {
    const source = await repositoryWithPullRequest();
    const root = await mkdtemp(join(tmpdir(), "agentx-pr-workspace-"));
    await expect(prepareWorkspace({
      rootPath: root, project: project(), materializer: materializer(source.directory), pullRequestRemote: () => pathToFileURL(source.directory).href,
      checkout: [{ repository: "demo", pullRequest: 99, headSha: "b".repeat(40) }],
    })).rejects.toThrow();
  });

  it("prepares the repository as it always was when the run names no pull request for it", async () => {
    const source = await repositoryWithPullRequest();
    const root = await mkdtemp(join(tmpdir(), "agentx-pr-workspace-"));
    const manifest = await prepareWorkspace({
      rootPath: root, project: project(), materializer: materializer(source.directory), pullRequestRemote: () => pathToFileURL(source.directory).href,
      checkout: [{ repository: "another", pullRequest: 12, headSha: source.head }],
    });
    expect(await git(join(root, "repo", "demo"), "rev-parse", "HEAD")).toBe(source.main);
    expect(manifest.repositories[0]!.checkedOut).toBeUndefined();
  });
  it("M5: fetches the recorded commit by its sha when the pull request's ref has moved on since, and reviews exactly that commit", async () => {
    const source = await repositoryWithPullRequest();
    // The author force-pushed: the pull request's ref names a commit that is not a descendant of the recorded one, and the recorded one is on no branch any more
    // (only its sha can still name it).
    await git(source.directory, "config", "uploadpack.allowAnySHA1InWant", "true");
    await git(source.directory, "checkout", "--quiet", "-b", "rewritten", "main");
    await writeFile(join(source.directory, "later.txt"), "pushed later\n");
    await git(source.directory, "add", ".");
    await git(source.directory, "commit", "--quiet", "-m", "later");
    const later = await git(source.directory, "rev-parse", "HEAD");
    await git(source.directory, "update-ref", "refs/pull/12/head", later);
    await git(source.directory, "checkout", "--quiet", "main");
    await git(source.directory, "branch", "--quiet", "-D", "feature", "rewritten");
    const root = await mkdtemp(join(tmpdir(), "agentx-pr-workspace-"));
    const manifest = await prepareWorkspace({
      rootPath: root, project: project(), materializer: materializer(source.directory), pullRequestRemote: () => pathToFileURL(source.directory).href,
      checkout: [{ repository: "demo", pullRequest: 12, headSha: source.head }],
    });
    expect(await git(join(root, "repo", "demo"), "rev-parse", "HEAD")).toBe(source.head);
    expect(manifest.repositories[0]).toMatchObject({ checkedOut: { pullRequest: 12, headSha: source.head } });
  });

  it("M5: a step checks the workspace's HEAD against the commit its payload names before it runs", async () => {
    const source = await repositoryWithPullRequest();
    const root = await mkdtemp(join(tmpdir(), "agentx-pr-workspace-"));
    const checkout = [{ repository: "demo", pullRequest: 12, headSha: source.head }];
    const manifest = await prepareWorkspace({
      rootPath: root, project: project(), materializer: materializer(source.directory), pullRequestRemote: () => pathToFileURL(source.directory).href, checkout,
    });
    await expect(verifyCheckedOutHeads(root, manifest, checkout)).resolves.toBeUndefined();
    await expect(verifyCheckedOutHeads(root, manifest, [])).resolves.toBeUndefined();
    // A second head named for the same repository is not the one preparation checked out, and is not looked at.
    await expect(verifyCheckedOutHeads(root, manifest, [...checkout, { repository: "demo", pullRequest: 13, headSha: "c".repeat(40) }])).resolves.toBeUndefined();
    // The workspace was moved off the commit (or never held it): the step does not run.
    await git(join(root, "repo", "demo"), "checkout", "--quiet", "--detach", source.main);
    await expect(verifyCheckedOutHeads(root, manifest, checkout)).rejects.toThrow("pull request 12");
    await expect(verifyCheckedOutHeads(root, manifest, [{ repository: "other", pullRequest: 3, headSha: source.head }])).rejects.toThrow("pull request 3");
  });

  // Final fix wave (runs I-2): the pull request's code is the contributor's. An agent run's preparation only clones and checks out.
  describe("an agent run's preparation (readOnly) runs nothing of the repository", () => {
    function hostile(): ProjectDefinition {
      return {
        ...project(),
        setup: [{ cwd: "repo/demo", executable: "sh", args: ["-c", "echo ran > ../../setup-ran.marker"], timeoutSeconds: 10 }],
        readiness: [{ cwd: "repo/demo", executable: "sh", args: ["-c", "echo ran > ../../readiness-ran.marker; exit 1"], timeoutSeconds: 10 }],
        devcontainer: { repository: "demo" },
      };
    }
    const withoutDevcontainer = (definition: ProjectDefinition): ProjectDefinition => { const { devcontainer: _devcontainer, ...rest } = definition; return rest; }; // eslint-disable-line @typescript-eslint/no-unused-vars -- taken out of the copy, not read
    const exists = (path: string) => readFile(path, "utf8").then(() => true, () => false);

    it("runs no setup command, starts no devcontainer, and a failing readiness does not fail it", async () => {
      const source = await repositoryWithPullRequest();
      await mkdir(join(source.directory, ".devcontainer"), { recursive: true });
      await writeFile(join(source.directory, ".devcontainer/devcontainer.json"), "{\"image\":\"node:22\",\"postCreateCommand\":\"curl evil\"}\n");
      await git(source.directory, "checkout", "--quiet", "feature");
      await git(source.directory, "add", ".");
      await git(source.directory, "commit", "--quiet", "-m", "devcontainer");
      const head = await git(source.directory, "rev-parse", "HEAD");
      await git(source.directory, "update-ref", "refs/pull/12/head", head);
      await git(source.directory, "checkout", "--quiet", "main");
      const root = await mkdtemp(join(tmpdir(), "agentx-pr-workspace-"));
      const attempts: string[] = [];
      const devcontainerCli = new Proxy({}, { get: (_target, name) => async () => { attempts.push(String(name)); throw new Error("the devcontainer CLI was called"); } }) as never;
      const manifest = await prepareWorkspace({
        rootPath: root, project: hostile(), materializer: materializer(source.directory), pullRequestRemote: () => pathToFileURL(source.directory).href,
        checkout: [{ repository: "demo", pullRequest: 12, headSha: head }], readOnly: true, devcontainerCli,
        taskShell: { kind: "local" },
        commandRunner: async (command) => { attempts.push(`command ${command.executable}`); return { exitCode: 0, stdout: "", stderr: "" }; },
      });
      expect(attempts).toEqual([]);
      expect(await exists(join(root, "setup-ran.marker"))).toBe(false);
      expect(await exists(join(root, "readiness-ran.marker"))).toBe(false);
      expect(await git(join(root, "repo", "demo"), "rev-parse", "HEAD")).toBe(head);
      expect(manifest).toMatchObject({ complete: true, completedSetupSteps: [], readinessResults: [] });
      expect(manifest.devcontainer).toBeUndefined();
      expect(manifest.failure).toBeUndefined();
    });

    it("runs no project command with the real local shell either: a hostile setup and a failing readiness leave no marker", async () => {
      const source = await repositoryWithPullRequest();
      const root = await mkdtemp(join(tmpdir(), "agentx-pr-workspace-"));
      const manifest = await prepareWorkspace({
        rootPath: root, project: withoutDevcontainer(hostile()), materializer: materializer(source.directory), pullRequestRemote: () => pathToFileURL(source.directory).href,
        checkout: [{ repository: "demo", pullRequest: 12, headSha: source.head }], readOnly: true, taskShell: { kind: "local" },
      });
      expect(manifest.complete).toBe(true);
      expect(await exists(join(root, "setup-ran.marker"))).toBe(false);
      expect(await exists(join(root, "readiness-ran.marker"))).toBe(false);
    });

    it("control: without readOnly the same project does run its setup (the marker proves the probe can see it)", async () => {
      const source = await repositoryWithPullRequest();
      const root = await mkdtemp(join(tmpdir(), "agentx-pr-workspace-"));
      await prepareWorkspace({
        rootPath: root, project: { ...withoutDevcontainer(hostile()), readiness: [] }, materializer: materializer(source.directory), pullRequestRemote: () => pathToFileURL(source.directory).href,
        checkout: [{ repository: "demo", pullRequest: 12, headSha: source.head }], taskShell: { kind: "local" },
      });
      expect(await exists(join(root, "setup-ran.marker"))).toBe(true);
    });
  });
});
