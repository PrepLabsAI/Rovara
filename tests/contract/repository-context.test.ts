import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRepositoryContextFiles, WORKSPACE_NOTE_PATH, type RepositoryContextFile } from "../../packages/worker/src/repository-context.js";
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

});

// R56: the task controls AGENTS.md and can flip it between a real file and a link while the worker reads it. The read needs
// /proc/self/fd, so this runs on Linux (CI, and the cloud test runner).
(process.platform === "linux" ? describe : describe.skip)("a context file the task flips to a link that leaves the repository", () => {
  it("never reads anything outside the repository, however the flips fall", async () => {
    const rootPath = await workspace();
    const secret = join(rootPath, "secret-outside.md");
    await writeFile(secret, "WORKER-SIDE-SECRET");
    const directory = join(rootPath, "repo/api");
    const agents = join(directory, "AGENTS.md");
    await writeFile(agents, "real guidance\n");
    let flipping = true;
    const flipper = (async () => {
      let toOutside = true;
      while (flipping) {
        const temporary = join(directory, "AGENTS.md.flip");
        await rm(temporary, { force: true });
        if (toOutside) await symlink(secret, temporary); else await writeFile(temporary, "real guidance\n");
        await rename(temporary, agents).catch(() => undefined);
        toOutside = !toOutside;
        // Each state is held for a random moment up to 2 ms (sometimes none), so loads land in both and the flips also fall mid-load.
        await new Promise<void>((done) => { const wait = Math.random() * 2; if (wait < 0.4) setImmediate(done); else setTimeout(done, wait); });
      }
    })();
    // The control: reading the path the way the old code did does reach the secret while it flips.
    let naiveLeaks = 0;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if ((await readFile(agents, "utf8").catch(() => "")) === "WORKER-SIDE-SECRET") naiveLeaks += 1;
    }
    expect(naiveLeaks).toBeGreaterThan(0);
    const loaded: Array<Awaited<ReturnType<typeof loadRepositoryContextFiles>>> = [];
    const real = () => loaded.filter(({ files }) => files.length === 1 && files[0]!.content.includes("real guidance")).length;
    // At least 300 loads, and on until a few caught the real file: a load is quick, so the flips fall on it unevenly.
    for (let attempt = 0; attempt < 5_000 && (attempt < 300 || real() < 3); attempt += 1) loaded.push(await loadRepositoryContextFiles(rootPath, repositories));
    flipping = false;
    await flipper;
    const everything = JSON.stringify(loaded);
    expect(everything).not.toContain("WORKER-SIDE-SECRET");
    expect(everything).not.toContain(secret);
    // Some loads got the real file, some were refused as outside: the flips really fell both ways.
    expect(real()).toBeGreaterThan(0);
  }, 60_000);

  it("reads a link that stays inside the repository, and refuses one into a sibling repository", async () => {
    const rootPath = await workspace();
    await mkdir(join(rootPath, "repo/api/docs"), { recursive: true });
    await writeFile(join(rootPath, "repo/api/docs/GUIDE.md"), "guide inside\n");
    await symlink("docs/GUIDE.md", join(rootPath, "repo/api/AGENTS.md"));
    const inside = await loadRepositoryContextFiles(rootPath, repositories);
    expect(inside.files[0]?.content).toContain("guide inside");
    await rm(join(rootPath, "repo/api/AGENTS.md"));
    await writeFile(join(rootPath, "repo/personal-website/AGENTS.md"), "sibling guidance\n");
    await symlink("../personal-website/AGENTS.md", join(rootPath, "repo/api/AGENTS.md"));
    const sibling = await loadRepositoryContextFiles(rootPath, [repositories[1]!]);
    expect(sibling.files).toEqual([]);
    expect(sibling.diagnostics).toEqual(["skipped repo/api/AGENTS.md: it resolves outside the repository"]);
  });
});

describe("pi sessions carry each repository's context file", () => {

  it("passes them to a reopened session, including edits made since the last task", async () => {
    const rootPath = await workspace();
    const capture = capturingAdapter();
    const first = await createWorkspacePiSession({ rootPath, model: fixtureModel }, capture.adapter);
    expect(contents(capture.inputs[0]?.contextFiles)).toEqual([workspaceNote(repositories)]);

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
      workspaceNote(repositories),
      expect.stringContaining("guidance added later"),
    ]);
  });
});

describe("pi sessions carry AgentX's workspace note (#155)", () => {
  it("tells the model where a repository without a context file is checked out", async () => {
    const only = [{ name: "the-mentor-test", path: "repo/The-Mentor-test" }];
    const rootPath = await workspace(only);
    const capture = capturingAdapter();

    await createWorkspacePiSession({ rootPath, model: fixtureModel }, capture.adapter);

    expect(capture.inputs[0]?.contextFiles).toEqual([
      {
        path: WORKSPACE_NOTE_PATH,
        content: [
          "AgentX workspace note (written by AgentX, not by any repository):",
          'The repository "the-mentor-test" is checked out at repo/The-Mentor-test in this workspace. Make every change inside it; files outside it are not part of the repository or its pull request.',
        ].join("\n"),
      },
    ]);
  });

  it("leaves out a manifest entry whose name or path project settings would refuse", async () => {
    const rootPath = await workspace([
      { name: "api", path: "repo/api" },
      { name: "escapee", path: "../x" },
      { name: "Bad Name", path: "repo/bad" },
    ]);
    const capture = capturingAdapter();

    await createWorkspacePiSession({ rootPath, model: fixtureModel }, capture.adapter);

    expect(contents(capture.inputs[0]?.contextFiles)).toEqual([
      workspaceNote([{ name: "api", path: "repo/api" }]),
    ]);
  });

});

const fixtureModel = { provider: "fixture", modelId: "fixture" };

function workspaceNote(listed: typeof repositories): string {
  if (listed.length === 1) {
    return [
      "AgentX workspace note (written by AgentX, not by any repository):",
      `The repository "${listed[0]!.name}" is checked out at ${listed[0]!.path} in this workspace. Make every change inside it; files outside it are not part of the repository or its pull request.`,
    ].join("\n");
  }
  return [
    "AgentX workspace note (written by AgentX, not by any repository):",
    ...listed.map(({ name, path }) => `The repository "${name}" is checked out at ${path} in this workspace.`),
    "Make each change inside the repository it belongs to; files outside them are not part of any repository or its pull request.",
  ].join("\n");
}

async function workspace(prepared: typeof repositories = repositories): Promise<string> {
  const rootPath = await realpath(await mkdtemp(join(tmpdir(), "agentx-context-")));
  await mkdir(join(rootPath, ".agentx"), { recursive: true });
  for (const repository of prepared) {
    // A tampered entry that escapes the workspace is only recorded, never created.
    if (!repository.path.startsWith("..")) await mkdir(join(rootPath, repository.path), { recursive: true });
  }
  await writeFile(
    join(rootPath, ".agentx/preparation-manifest.json"),
    JSON.stringify({
      projectName: "payments",
      projectRevision: 1,
      environmentDigest: `registry.example.test/worker@sha256:${"a".repeat(64)}`,
      repositories: prepared.map((repository) => ({
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
      getModel: () => ({ provider: input.model.provider, modelId: input.model.modelId }),
      getSessionStats: () => ({
        sessionFile,
        sessionId: conversationId,
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
      }),
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
