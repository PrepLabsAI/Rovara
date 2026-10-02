// Spec 051 Ruling E: in the worker's real Pi session, a test run's "before" is valid only while the workspace
// fingerprint still equals its state at the agent's first tool call. Real bash, real git, the faux model. Offline.
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { recorderFingerprint, repositoriesFingerprint, workspaceFingerprint } from "../../packages/worker/src/artifacts.js";
import { createDefaultPiSessionAdapter, createWorkspacePiSession } from "../../packages/worker/src/pi-session.js";
import { CommandRecorder } from "../../packages/worker/src/verification/recorder.js";
import { createFixtureDirectory } from "../fixtures/index.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

const run = promisify(execFile);
const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });

/** A workspace root with one prepared repository, repos/web: a tracked src.py, and .pytest_cache ignored. */
async function workspace(): Promise<{ rootPath: string; repository: string }> {
  const rootPath = await createFixtureDirectory("agentx-recorder-session-");
  const repository = join(rootPath, "repos/web");
  await mkdir(repository, { recursive: true });
  await mkdir(join(rootPath, ".agentx"));
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({
    schemaVersion: 2, projectName: "rec", projectRevision: 1, repositories: [{ name: "web", path: "repos/web" }], completedSetupSteps: [],
    readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: new Date().toISOString(),
  }));
  await writeFile(join(repository, "src.py"), "a\n");
  await writeFile(join(repository, ".gitignore"), ".pytest_cache/\n");
  // The test script writes a cache the repository ignores, as pytest does.
  await writeFile(join(repository, "package.json"), JSON.stringify({ scripts: { test: "mkdir -p .pytest_cache && date +%s%N > .pytest_cache/v && exit 1" } }));
  const git = (...args: string[]) => run("git", ["-C", repository, ...args]);
  await git("init", "-q");
  await git("add", ".");
  await git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
  return { rootPath, repository };
}

async function recordedSession(commands: Array<string | string[]>, fingerprint?: (signal?: AbortSignal) => Promise<string>) {
  const { rootPath, repository } = await workspace();
  const diagnostics: string[] = [];
  const recorder = new CommandRecorder({
    fingerprint: fingerprint ?? ((signal) => recorderFingerprint([{ name: "web", directory: repository }], signal)),
    onDiagnostic: (message) => { diagnostics.push(message); },
  });
  const extension: ExtensionFactory = (pi) => {
    pi.on("tool_call", async (event, context) => { await recorder.observeCall(event, context.signal); });
    pi.on("tool_result", (event) => { recorder.observe(event); });
    pi.on("tool_execution_end", (event) => { recorder.observeExecutionEnd(event.toolCallId); });
    pi.on("turn_end", () => { recorder.observeTurnEnd(); });
  };
  const { modelRuntime, faux } = await fauxModelRuntime();
  // A string is one call in its own turn; an array is one assistant message with several calls, which Pi runs as a batch.
  const steps: FauxResponseStep[] = commands.map((step, index) => toolUse(...(Array.isArray(step) ? step : [step])
    .map((command, call) => fauxToolCall("bash", { command }, { id: `call-${index}-${call}` }))));
  faux.setResponses([...steps, fauxAssistantMessage("Done.")]);
  const adapter = createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) });
  const handle = await createWorkspacePiSession({ rootPath, model: FAUX_MODEL, extensionFactories: [extension] }, adapter);
  try {
    await handle.prompt("go");
  } finally { handle.dispose(); }
  await recorder.settled();
  return { runs: recorder.firstRuns().map(({ replay, exitCode, afterFirstEdit }) => ({ replay, exitCode, afterFirstEdit })), diagnostics };
}

describe("the command recorder in the worker's Pi session (spec 051 Ruling E)", () => {
  it("counts an edit made with sed -i through bash: the next test run has no valid before", async () => {
    const { runs } = await recordedSession(["cd repos/web && sed -i.orig 's/a/b/' src.py", "cd repos/web && npm test"]);
    expect(runs).toEqual([{ replay: "cd repos/web && npm test", exitCode: 1, afterFirstEdit: true }]);
  });

  it("keeps the before valid after a command that changed nothing", async () => {
    const { runs } = await recordedSession(["cd repos/web && ls", "cd repos/web && npm test"]);
    expect(runs).toEqual([{ replay: "cd repos/web && npm test", exitCode: 1, afterFirstEdit: false }]);
  });

  it("does not count a gitignored cache the test command itself wrote as an edit", async () => {
    const { runs } = await recordedSession(["cd repos/web && npm test", "cd repos/web && npm run test"]);
    expect(runs).toEqual([
      { replay: "cd repos/web && npm test", exitCode: 1, afterFirstEdit: false },
      { replay: "cd repos/web && npm run test", exitCode: 1, afterFirstEdit: false },
    ]);
  });

  it("voids the before of a test run batched with a sed -i in the same assistant message (Ruling G)", async () => {
    const { runs } = await recordedSession([["cd repos/web && sed -i.orig 's/a/b/' src.py", "cd repos/web && npm test"]]);
    expect(runs).toEqual([{ replay: "cd repos/web && npm test", exitCode: 1, afterFirstEdit: true }]);
  });

  it("treats a run as after an edit when the fingerprint fails, and reports it once", async () => {
    const { runs, diagnostics } = await recordedSession(["cd repos/web && npm test", "cd repos/web && npm run test"], () => repositoriesFingerprint([{ name: "web", directory: "/nonexistent-agentx-repo" }]));
    expect(runs.map((run) => run.afterFirstEdit)).toEqual([true, true]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("AgentX could not read the workspace state");
  });
});

describe("the fingerprints and the untracked-file cap (M-9, Ruling H)", () => {
  it("leaves run-task's workspaceFingerprint uncapped: it sees a change to an untracked file past 5,000 files", async () => {
    const { rootPath, repository } = await workspace();
    await mkdir(join(repository, "tree"));
    await Promise.all(Array.from({ length: 5_001 }, (_, index) => writeFile(join(repository, "tree", `f${String(index).padStart(5, "0")}.txt`), "x")));
    const first = await workspaceFingerprint(rootPath);
    expect(await workspaceFingerprint(rootPath)).toBe(first);
    await writeFile(join(repository, "tree", "f05000.txt"), "longer");
    expect(await workspaceFingerprint(rootPath)).not.toBe(first);
  });

  it("gives the recorder's fingerprint a new digest on every read once the cap is hit, and a stable one below it", async () => {
    const { repository } = await workspace();
    const read = () => repositoriesFingerprint([{ name: "web", directory: repository }], { maxUntrackedStats: 1 });
    await writeFile(join(repository, "u1.txt"), "1");
    expect(await read()).toBe(await read());
    await writeFile(join(repository, "u2.txt"), "2");
    expect(await read()).not.toBe(await read());
  });

  it("marks a test run as after an edit once the recorder's fingerprint hit the cap (Ruling H)", async () => {
    const { repository } = await workspace();
    await writeFile(join(repository, "u1.txt"), "1");
    await writeFile(join(repository, "u2.txt"), "2");
    const diagnostics: string[] = [];
    const recorder = new CommandRecorder({
      fingerprint: (signal) => recorderFingerprint([{ name: "web", directory: repository }], signal, 1),
      onDiagnostic: (message) => { diagnostics.push(message); },
    });
    await recorder.observeCall({ toolCallId: "t", toolName: "bash", input: { command: "pytest" } });
    recorder.observe({ toolCallId: "t", toolName: "bash", input: { command: "pytest" }, isError: true, content: [{ type: "text", text: "Command exited with code 1" }] });
    await recorder.settled();
    expect(recorder.firstRuns()[0]).toMatchObject({ replay: "pytest", afterFirstEdit: true });
    // The cap, not a failed read, decided it.
    expect(diagnostics).toEqual([]);
  });

  it("rejects promptly when its signal is aborted", async () => {
    const { repository } = await workspace();
    const controller = new AbortController();
    controller.abort();
    await expect(recorderFingerprint([{ name: "web", directory: repository }], controller.signal)).rejects.toThrow();
  });
});
