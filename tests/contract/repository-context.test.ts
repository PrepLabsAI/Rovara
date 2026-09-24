import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendRepositoryContextFiles,
  loadRepositoryContextFiles,
  MAX_REPOSITORY_CONTEXT_FILE_BYTES,
  readPreparedRepositories,
  type RepositoryContextFile,
} from "../../packages/worker/src/repository-context.js";
import {
  createWorkspacePiSession,
  openRegisteredWorkspacePiSession,
  type PiSessionAdapter,
  type PiSessionInput,
} from "../../packages/worker/src/pi-session.js";

const repositories = [
  { name: "personal-website", path: "repo/personal-website" },
  { name: "api", path: "repo/api" },
];

describe("repository context files", () => {
  it("loads only the repositories that have one, labelled with repository and path", async () => {
    const rootPath = await workspace();
    await writeFile(join(rootPath, "repo/personal-website/AGENTS.md"), "Run npm test before a PR.\n");

    const { files, diagnostics } = await loadRepositoryContextFiles(rootPath, repositories);

    expect(diagnostics).toEqual([]);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe(join(rootPath, "repo/personal-website/AGENTS.md"));
    expect(files[0]?.content).toContain("Run npm test before a PR.");
    expect(files[0]?.content).toContain('"personal-website"');
    expect(files[0]?.content).toContain("repo/personal-website");
    expect(files[0]?.content).not.toContain("repo/api");
  });

  it("follows pi's candidate order", async () => {
    const rootPath = await workspace();
    const directory = join(rootPath, "repo/api");
    await writeFile(join(directory, "CLAUDE.md"), "claude guidance\n");

    const claudeOnly = await loadRepositoryContextFiles(rootPath, repositories);
    expect(claudeOnly.files[0]?.content).toContain("claude guidance");

    await writeFile(join(directory, "AGENTS.md"), "agents guidance\n");
    const agents = await loadRepositoryContextFiles(rootPath, repositories);
    expect(agents.files).toHaveLength(1);
    expect(agents.files[0]?.content).toContain("agents guidance");

    await writeFile(join(directory, "AGENTS.override.md"), "override guidance\n");
    const override = await loadRepositoryContextFiles(rootPath, repositories);
    expect(override.files).toHaveLength(1);
    expect(override.files[0]?.content).toContain("override guidance");
  });

  it("does not load a context file that resolves outside its repository", async () => {
    const rootPath = await workspace();
    const secret = join(rootPath, "secret.md");
    await writeFile(secret, "workspace secret\n");
    await symlink(secret, join(rootPath, "repo/api/AGENTS.md"));

    const { files, diagnostics } = await loadRepositoryContextFiles(rootPath, repositories);

    expect(files).toEqual([]);
    expect(diagnostics).toEqual([
      "skipped repo/api/AGENTS.md: it resolves outside the repository",
    ]);
  });

  it("skips an oversized context file with a diagnostic", async () => {
    const rootPath = await workspace();
    await writeFile(
      join(rootPath, "repo/api/AGENTS.md"),
      "a".repeat(MAX_REPOSITORY_CONTEXT_FILE_BYTES + 1),
    );

    const { files, diagnostics } = await loadRepositoryContextFiles(rootPath, repositories);

    expect(files).toEqual([]);
    expect(diagnostics[0]).toMatch(/^skipped repo\/api\/AGENTS\.md: 65537 bytes exceeds the 65536-byte limit$/);
  });

  it("treats a repository path that escapes the workspace as a diagnostic, not a load", async () => {
    const rootPath = await workspace();

    const { files, diagnostics } = await loadRepositoryContextFiles(rootPath, [
      { name: "escapee", path: "../elsewhere" },
    ]);

    expect(files).toEqual([]);
    expect(diagnostics).toEqual([
      "skipped the context file of escapee: ../elsewhere escapes the workspace root",
    ]);
  });

  it("appends the repository files to the ones pi already discovered", async () => {
    const workspaceFile = { path: "/mnt/workspace/AGENTS.md", content: "workspace" };
    const repositoryFile = { path: "/mnt/workspace/repo/api/AGENTS.md", content: "repository" };

    const override = appendRepositoryContextFiles([repositoryFile]);

    expect(override({ agentsFiles: [workspaceFile] })).toEqual({
      agentsFiles: [workspaceFile, repositoryFile],
    });
  });

  it("reads the prepared repositories, and none when the manifest is unreadable", async () => {
    const rootPath = await workspace();
    await expect(readPreparedRepositories(rootPath)).resolves.toEqual(repositories);
    await expect(readPreparedRepositories(join(rootPath, "repo"))).resolves.toEqual([]);
  });
});

describe("pi sessions carry each repository's context file", () => {
  it("passes them to a newly created session", async () => {
    const rootPath = await workspace();
    await writeFile(join(rootPath, "repo/api/AGENTS.md"), "api guidance\n");
    const capture = capturingAdapter();

    await createWorkspacePiSession({ rootPath, model: fixtureModel }, capture.adapter);

    expect(capture.inputs).toHaveLength(1);
    expect(capture.inputs[0]?.cwd).toBe(rootPath);
    expect(contents(capture.inputs[0]?.contextFiles)).toEqual([
      expect.stringContaining("api guidance"),
    ]);
  });

  it("passes them to a reopened session, including edits made since the last task", async () => {
    const rootPath = await workspace();
    const capture = capturingAdapter();
    const first = await createWorkspacePiSession({ rootPath, model: fixtureModel }, capture.adapter);
    expect(capture.inputs[0]?.contextFiles).toEqual([]);

    await writeFile(join(rootPath, "repo/api/AGENTS.md"), "guidance added later\n");
    const diagnostics: string[] = [];
    await openRegisteredWorkspacePiSession(
      {
        rootPath,
        model: fixtureModel,
        conversationId: first.conversationId,
        sessionFile: first.sessionFile,
        onDiagnostic: (message) => diagnostics.push(message),
      },
      capture.adapter,
    );

    expect(diagnostics).toEqual([]);
    expect(contents(capture.inputs[1]?.contextFiles)).toEqual([
      expect.stringContaining("guidance added later"),
    ]);
  });
});

const fixtureModel = { provider: "fixture", modelId: "fixture" };

async function workspace(): Promise<string> {
  const rootPath = await realpath(await mkdtemp(join(tmpdir(), "agentx-context-")));
  await mkdir(join(rootPath, ".agentx"), { recursive: true });
  for (const repository of repositories) {
    await mkdir(join(rootPath, repository.path), { recursive: true });
  }
  await writeFile(
    join(rootPath, ".agentx/preparation-manifest.json"),
    JSON.stringify({
      schemaVersion: 2,
      projectName: "payments",
      projectRevision: 1,
      environmentDigest: `registry.example.test/worker@sha256:${"a".repeat(64)}`,
      repositories: repositories.map((repository) => ({
        ...repository,
        defaultBranch: "main",
        resolvedCommit: "b".repeat(40),
        resolvedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      })),
      completedSetupSteps: [],
      readinessResults: [],
      creationIdentity: "test",
      complete: true,
      updatedAt: new Date().toISOString(),
    }),
  );
  return rootPath;
}

function capturingAdapter(): { adapter: PiSessionAdapter; inputs: PiSessionInput[] } {
  const inputs: PiSessionInput[] = [];
  const handle = async (input: PiSessionInput, conversationId: string) => {
    inputs.push(input);
    const sessionFile = join(input.sessionDirectory, `${conversationId}.jsonl`);
    await writeFile(sessionFile, "");
    return {
      conversationId,
      sessionFile,
      async prompt() {},
      async abort() {},
      subscribe: () => () => undefined,
      dispose() {},
    };
  };
  return {
    inputs,
    adapter: {
      create: async (input) => handle(input, "conversation-1"),
      open: async (input) => handle(input, input.conversationId),
    },
  };
}

function contents(files: RepositoryContextFile[] | undefined): string[] {
  return (files ?? []).map(({ content }) => content);
}
