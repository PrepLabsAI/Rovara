// Spec 051: the worker records the agent's test commands, with exit codes and whether the workspace had changed.
import { describe, expect, it } from "vitest";
import { CommandRecorder } from "../../packages/worker/src/verification/recorder.js";

let ids = 0;
const nextId = () => `call-${++ids}`;
const bashResult = (toolCallId: string, command: string, options: { exitCode?: number; structured?: boolean; isError?: boolean; text?: string } = {}) => ({
  toolCallId,
  toolName: "bash",
  input: { command },
  ...(options.structured === false ? {} : { structuredContent: { output: options.text ?? "", truncated: false, exit_code: options.exitCode ?? 0, wall_time_seconds: 0.1 } }),
  isError: options.isError ?? (options.exitCode ?? 0) !== 0,
  content: [{ type: "text", text: options.text ?? "out" }],
});

/** A recorder over a fake workspace whose state the test changes, as a bash command would. */
function harness(fingerprint?: () => Promise<string>) {
  const workspace = { state: "clean" };
  const diagnostics: string[] = [];
  const recorder = new CommandRecorder({
    fingerprint: fingerprint ?? (async () => workspace.state),
    onDiagnostic: (message) => { diagnostics.push(message); },
  });
  /** One bash call: tool_call (awaited, as Pi awaits the handler), then the command's effect, then tool_result. */
  const bash = async (command: string, options: Parameters<typeof bashResult>[2] & { effect?: () => void } = {}) => {
    const id = nextId();
    await recorder.observeCall({ toolCallId: id, toolName: "bash", input: { command } });
    options.effect?.();
    recorder.observe(bashResult(id, command, options));
  };
  const tool = async (toolName: "edit" | "write" | "read", isError = false) => {
    const id = nextId();
    await recorder.observeCall({ toolCallId: id, toolName, input: { path: "a.ts" } });
    if (!isError && toolName !== "read") workspace.state = `edited-${id}`;
    recorder.observe({ toolCallId: id, toolName, input: { path: "a.ts" }, isError, content: [{ type: "text", text: isError ? "failed" : "ok" }] });
  };
  const runs = async () => { await recorder.settled(); return recorder.firstRuns(); };
  return { recorder, workspace, diagnostics, bash, tool, runs };
}

describe("CommandRecorder", () => {
  it("records a bash test command with its exit code, before any edit", async () => {
    const { recorder, bash, runs } = harness();
    await bash("pytest -k x", { exitCode: 1, text: "1 failed" });
    expect(await runs()).toEqual([
      { order: 0, command: "pytest -k x", replay: "pytest -k x", exitCode: 1, afterFirstEdit: false, output: "1 failed" },
    ]);
    expect(recorder.edited).toBe(false);
  });

  it("keeps only the first run of each replay string", async () => {
    const { recorder, bash, tool, runs } = harness();
    await bash("pytest -k x", { exitCode: 1 });
    await tool("edit");
    await bash("pytest -k x", { exitCode: 0 });
    expect(recorder.edited).toBe(true);
    expect((await runs()).map(({ replay, exitCode, afterFirstEdit }) => ({ replay, exitCode, afterFirstEdit })))
      .toEqual([{ replay: "pytest -k x", exitCode: 1, afterFirstEdit: false }]);
  });

  it("marks a command first run after an edit or write", async () => {
    const { bash, tool, runs } = harness();
    await bash("pytest -k x");
    await tool("write");
    await bash("npm test");
    expect((await runs()).map(({ order, replay, afterFirstEdit }) => ({ order, replay, afterFirstEdit }))).toEqual([
      { order: 0, replay: "pytest -k x", afterFirstEdit: false },
      { order: 1, replay: "npm test", afterFirstEdit: true },
    ]);
  });

  it("never records a piped command or a non-test command, nor another tool's result", async () => {
    const { recorder, bash, runs } = harness();
    await bash("pytest | tail");
    await bash("npm install");
    recorder.observe({ toolCallId: "r", toolName: "read", input: { command: "pytest" }, isError: false, content: [{ type: "text", text: "x" }] });
    recorder.observe({ toolCallId: "b", toolName: "bash", input: {}, isError: false, content: [] });
    expect(await runs()).toEqual([]);
  });

  it("does not count a failed edit as an edit", async () => {
    const { recorder, bash, tool, runs } = harness();
    await tool("edit", true);
    await bash("npm test");
    expect(recorder.edited).toBe(false);
    expect((await runs())[0]?.afterFirstEdit).toBe(false);
  });

  it("reads the exit code from the last text marker without structuredContent, else 0 on success, else unknown", async () => {
    const { bash, runs } = harness();
    await bash("npm test", { structured: false, isError: true, text: "prints Command exited with code 9\nboom\n\nCommand exited with code 2" });
    await bash("pytest", { structured: false, isError: false, text: "1 passed" });
    await bash("go test ./...", { structured: false, isError: true, text: "killed" });
    expect((await runs()).map(({ replay, exitCode }) => ({ replay, exitCode }))).toEqual([
      { replay: "npm test", exitCode: 2 },
      { replay: "pytest", exitCode: 0 },
      { replay: "go test ./...", exitCode: undefined },
    ]);
  });

  it("replaces a first run with an unknown exit code by a later known run made before any edit", async () => {
    const { bash, tool, runs } = harness();
    await bash("pytest", { structured: false, isError: true, text: "Command timed out" });
    await bash("npm test", { exitCode: 0 });
    await bash("pytest", { exitCode: 1 });
    await tool("edit");
    await bash("npm test", { structured: false, isError: true, text: "aborted" });
    expect((await runs()).map(({ order, replay, exitCode }) => ({ order, replay, exitCode }))).toEqual([
      { order: 0, replay: "pytest", exitCode: 1 },
      { order: 1, replay: "npm test", exitCode: 0 },
    ]);
  });

  it("keeps the output as is, and replays a cd-prefixed command exactly", async () => {
    const { recorder, runs } = harness();
    await recorder.observeCall({ toolCallId: "cd", toolName: "bash", input: { command: "cd pkg && npm test -- -t foo" } });
    recorder.observe({ ...bashResult("cd", "cd pkg && npm test -- -t foo"), content: [{ type: "text", text: "line 1\n" }, { type: "image" }, { type: "text", text: "line 2\n" }] });
    expect((await runs())[0]).toMatchObject({ command: "cd pkg && npm test -- -t foo", replay: "cd pkg && npm test -- -t foo", output: "line 1\nline 2\n" });
  });
});

describe("CommandRecorder: an edit made through bash (Ruling E)", () => {
  it("marks a test run after a bash command that changed the workspace as after an edit", async () => {
    const { recorder, workspace, bash, runs } = harness();
    await bash("sed -i s/a/b/ src.py", { effect: () => { workspace.state = "sed"; } });
    await bash("pytest", { exitCode: 1 });
    expect(recorder.edited).toBe(false);
    expect((await runs())[0]).toMatchObject({ replay: "pytest", afterFirstEdit: true });
  });

  it("keeps a test run's before valid after a bash command that changed nothing", async () => {
    const { bash, runs } = harness();
    await bash("ls");
    await bash("pytest", { exitCode: 1 });
    expect((await runs())[0]).toMatchObject({ replay: "pytest", afterFirstEdit: false });
  });

  it("takes the baseline at the first tool call, before it runs, whatever the tool", async () => {
    const calls: string[] = [];
    const { workspace, bash, runs } = harness(async () => { calls.push("fingerprint"); return workspace.state; });
    await bash("sed -i s/a/b/ src.py", { effect: () => { calls.push("sed ran"); workspace.state = "sed"; } });
    await bash("pytest");
    expect(calls).toEqual(["fingerprint", "sed ran", "fingerprint"]);
    expect((await runs())[0]?.afterFirstEdit).toBe(true);
  });

  it("does not fingerprint once an edit tool has succeeded", async () => {
    let count = 0;
    const { workspace, bash, tool, runs } = harness(async () => { count += 1; return workspace.state; });
    await tool("edit");
    const before = count;
    await bash("pytest");
    expect(count).toBe(before);
    expect((await runs())[0]?.afterFirstEdit).toBe(true);
  });

  it("treats a run as after an edit when the fingerprint fails, and reports it", async () => {
    const { diagnostics, bash, runs } = harness(async () => { throw new Error("not a git repository"); });
    await bash("pytest", { exitCode: 1 });
    expect((await runs())[0]).toMatchObject({ replay: "pytest", afterFirstEdit: true });
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]).toContain("not a git repository");
  });

  it("treats a result whose tool_call it never saw as after an edit", async () => {
    const { recorder, runs } = harness();
    recorder.observe(bashResult("unseen", "pytest", { exitCode: 1 }));
    expect((await runs())[0]).toMatchObject({ replay: "pytest", afterFirstEdit: true });
  });
});
