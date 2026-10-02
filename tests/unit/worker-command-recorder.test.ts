// Spec 051: the worker records the agent's test commands, with exit codes and their order relative to edits.
import { describe, expect, it } from "vitest";
import { CommandRecorder } from "../../packages/worker/src/verification/recorder.js";

const bash = (command: string, options: { exitCode?: number; structured?: boolean; isError?: boolean; text?: string } = {}) => ({
  toolName: "bash",
  input: { command },
  ...(options.structured === false ? {} : { structuredContent: { output: options.text ?? "", truncated: false, exit_code: options.exitCode ?? 0, wall_time_seconds: 0.1 } }),
  isError: options.isError ?? (options.exitCode ?? 0) !== 0,
  content: [{ type: "text", text: options.text ?? "out" }],
});
const tool = (toolName: "edit" | "write", isError = false) => ({
  toolName, input: { path: "a.ts" }, isError, content: [{ type: "text", text: isError ? "failed" : "ok" }],
});

describe("CommandRecorder", () => {
  it("records a bash test command with its exit code, before any edit", () => {
    const recorder = new CommandRecorder();
    recorder.observe(bash("pytest -k x", { exitCode: 1, text: "1 failed" }));
    expect(recorder.firstRuns()).toEqual([
      { order: 0, command: "pytest -k x", replay: "pytest -k x", exitCode: 1, afterFirstEdit: false, output: "1 failed" },
    ]);
    expect(recorder.edited).toBe(false);
  });

  it("keeps only the first run of each replay string", () => {
    const recorder = new CommandRecorder();
    recorder.observe(bash("pytest -k x", { exitCode: 1 }));
    recorder.observe(tool("edit"));
    recorder.observe(bash("pytest -k x", { exitCode: 0 }));
    expect(recorder.edited).toBe(true);
    expect(recorder.firstRuns().map(({ replay, exitCode, afterFirstEdit }) => ({ replay, exitCode, afterFirstEdit })))
      .toEqual([{ replay: "pytest -k x", exitCode: 1, afterFirstEdit: false }]);
  });

  it("marks a command first run after an edit or write", () => {
    const recorder = new CommandRecorder();
    recorder.observe(bash("pytest -k x"));
    recorder.observe(tool("write"));
    recorder.observe(bash("npm test"));
    expect(recorder.firstRuns().map(({ order, replay, afterFirstEdit }) => ({ order, replay, afterFirstEdit }))).toEqual([
      { order: 0, replay: "pytest -k x", afterFirstEdit: false },
      { order: 1, replay: "npm test", afterFirstEdit: true },
    ]);
  });

  it("never records a piped command or a non-test command, nor another tool's result", () => {
    const recorder = new CommandRecorder();
    recorder.observe(bash("pytest | tail"));
    recorder.observe(bash("npm install"));
    recorder.observe({ toolName: "read", input: { command: "pytest" }, isError: false, content: [{ type: "text", text: "x" }] });
    recorder.observe({ toolName: "bash", input: {}, isError: false, content: [] });
    expect(recorder.firstRuns()).toEqual([]);
  });

  it("does not count a failed edit as an edit", () => {
    const recorder = new CommandRecorder();
    recorder.observe(tool("edit", true));
    recorder.observe(bash("npm test"));
    expect(recorder.edited).toBe(false);
    expect(recorder.firstRuns()[0]?.afterFirstEdit).toBe(false);
  });

  it("reads the exit code from the text marker without structuredContent, else 0 on success, else unknown", () => {
    const recorder = new CommandRecorder();
    recorder.observe(bash("npm test", { structured: false, isError: true, text: "boom\n\nCommand exited with code 2" }));
    recorder.observe(bash("pytest", { structured: false, isError: false, text: "1 passed" }));
    recorder.observe(bash("go test ./...", { structured: false, isError: true, text: "killed" }));
    expect(recorder.firstRuns().map(({ replay, exitCode }) => ({ replay, exitCode }))).toEqual([
      { replay: "npm test", exitCode: 2 },
      { replay: "pytest", exitCode: 0 },
      { replay: "go test ./...", exitCode: undefined },
    ]);
  });

  it("keeps the output as is, and replays a cd-prefixed command exactly", () => {
    const recorder = new CommandRecorder();
    recorder.observe({ ...bash("cd pkg && npm test -- -t foo"), content: [{ type: "text", text: "line 1\n" }, { type: "image" }, { type: "text", text: "line 2\n" }] });
    expect(recorder.firstRuns()[0]).toMatchObject({ command: "cd pkg && npm test -- -t foo", replay: "cd pkg && npm test -- -t foo", output: "line 1\nline 2\n" });
  });
});
