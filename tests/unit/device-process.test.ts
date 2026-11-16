// Device testing slice 2: the real command port. A file and its arguments (no shell), a time limit and an output limit on every run, the whole process group ended with the program, and no environment
// but the one given.
import { describe, expect, it } from "vitest";
import { createNodeCommandPort } from "../../packages/verifier/src/executor/device-process.js";

const NODE = process.execPath;
const port = createNodeCommandPort();
const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
const waitGone = async (pid: number, ms = 4_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (gone(pid)) return true; await new Promise((resolve) => { setTimeout(resolve, 50); }); } return gone(pid); };
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

describe("createNodeCommandPort.run", () => {
  it("runs a program with its arguments and no shell, and returns its exit code and output", async () => {
    const ok = await port.run(NODE, ["-e", "process.stdout.write(process.argv.slice(1).join('|'))", "a b", "$HOME", "`x`", ";"], { timeoutMs: 10_000, maxStdoutBytes: 1_000 });
    expect(ok).toMatchObject({ exitCode: 0, timedOut: false, tooLarge: false });
    expect(text(ok.stdout)).toBe("a b|$HOME|`x`|;");
    const failed = await port.run(NODE, ["-e", "process.exit(3)"], { timeoutMs: 10_000, maxStdoutBytes: 10 });
    expect(failed.exitCode).toBe(3);
  });

  it("gives the program exactly the environment it was given, and nothing of the parent's", async () => {
    process.env["ROVARA_DEVICE_TEST_PARENT_ONLY"] = "leak";
    try {
      const result = await port.run(NODE, ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env).filter((k) => k.startsWith('ROVARA_') || k === 'GIVEN')))"], { timeoutMs: 10_000, maxStdoutBytes: 1_000, env: { GIVEN: "1" } });
      expect(text(result.stdout)).toBe('["GIVEN"]');
    } finally { delete process.env["ROVARA_DEVICE_TEST_PARENT_ONLY"]; }
  });

  it("stops a program that runs past its time, with the programs it started, and says so", async () => {
    const script = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(String(c.pid)+'\\n');setInterval(()=>{},1000)";
    // the child's pid is printed before the time runs out; it is read from the output of a run that is allowed to finish writing first
    const started = Date.now();
    const result = await port.run(NODE, ["-e", script], { timeoutMs: 1_500, maxStdoutBytes: 1_000 });
    expect(result).toMatchObject({ timedOut: true, exitCode: null });
    expect(Date.now() - started).toBeLessThan(6_000);
    const childPid = Number(text(result.stdout).trim());
    expect(Number.isInteger(childPid) && childPid > 1).toBe(true);
    expect(await waitGone(childPid)).toBe(true);
  });

  it("stops a program that prints more than its limit, keeps none of it, and says so", async () => {
    const result = await port.run(NODE, ["-e", "const big=Buffer.alloc(100000,65);const t=setInterval(()=>process.stdout.write(big),1);setTimeout(()=>clearInterval(t),20000)"], { timeoutMs: 10_000, maxStdoutBytes: 50_000 });
    expect(result.tooLarge).toBe(true);
    expect(result.stdout.byteLength).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("answers for a program that cannot start, never throws", async () => {
    const missing = await port.run("/nonexistent/program", [], { timeoutMs: 5_000, maxStdoutBytes: 100 });
    expect(missing).toMatchObject({ exitCode: null, timedOut: false, tooLarge: false });
  });

  it("merges the error output only when asked", async () => {
    const script = "process.stdout.write('out');process.stderr.write('err')";
    expect(text((await port.run(NODE, ["-e", script], { timeoutMs: 10_000, maxStdoutBytes: 100 })).stdout)).toBe("out");
    expect(text((await port.run(NODE, ["-e", script], { timeoutMs: 10_000, maxStdoutBytes: 100, mergeStderr: true })).stdout)).toMatch(/^(outerr|errout)$/u);
    // the limit counts the error output too
    const loud = await port.run(NODE, ["-e", "process.stderr.write('x'.repeat(5000))"], { timeoutMs: 10_000, maxStdoutBytes: 1_000, mergeStderr: true });
    expect(loud.tooLarge).toBe(true);
  });

  it("ends what the program left running in its group when it exits", async () => {
    const script = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(String(c.pid));process.exit(0)";
    const result = await port.run(NODE, ["-e", script], { timeoutMs: 10_000, maxStdoutBytes: 100 });
    expect(result.exitCode).toBe(0);
    expect(await waitGone(Number(text(result.stdout)))).toBe(true);
  });
});

describe("createNodeCommandPort.start", () => {
  it("keeps a program running until it is stopped, then ends it and its group", async () => {
    const marker = `${String(process.pid)}-${String(Date.now())}`;
    const background = port.start(NODE, ["-e", `process.title='${marker}';const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000)`], { env: {} });
    expect(background.running()).toBe(true);
    await new Promise((resolve) => { setTimeout(resolve, 600); });
    expect(background.running()).toBe(true);
    const stopped = Date.now();
    await background.stop(1_500);
    expect(background.running()).toBe(false);
    expect(Date.now() - stopped).toBeLessThan(6_000);
    await expect(background.stop(500)).resolves.toBeUndefined();
  });

  it("reports a program that exits by itself as no longer running", async () => {
    const background = port.start(NODE, ["-e", "process.exit(0)"], { env: {} });
    for (let i = 0; i < 100 && background.running(); i += 1) await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(background.running()).toBe(false);
  });

  it("keeps the last of a program's output and errors only when asked to (for the CI log), at most 2,000 characters", async () => {
    const program = "process.stdout.write('a'.repeat(5000) + 'the end\\n')";
    const asked = port.start(NODE, ["-e", program], { env: {}, capture: true });
    for (let i = 0; i < 100 && asked.running(); i += 1) await new Promise((resolve) => { setTimeout(resolve, 50); });
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    expect(asked.tail?.().length).toBe(2_000);
    expect(asked.tail?.().endsWith("the end\n")).toBe(true);
    const quiet = port.start(NODE, ["-e", program], { env: {} });
    expect(quiet.tail).toBeUndefined();
    await quiet.stop(200);
  });

  it("says how a captured program ended: its exit code and signal, or that it could not be started at all", async () => {
    const exits = port.start(NODE, ["-e", "process.exit(3)"], { env: {}, capture: true });
    for (let i = 0; i < 100 && exits.running(); i += 1) await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(exits.how?.()).toBe("exit code 3 signal null");
    const missing = port.start("/nonexistent/program", [], { env: {}, capture: true });
    for (let i = 0; i < 100 && missing.running(); i += 1) await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(missing.how?.()).toContain("spawn error ENOENT");
  });

  it("is not running for a program that cannot start", async () => {
    const background = port.start("/nonexistent/program", [], { env: {} });
    for (let i = 0; i < 100 && background.running(); i += 1) await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(background.running()).toBe(false);
  });
});

describe("createNodeCommandPort.run: the host build's options (slice 4)", () => {
  it("starts the program in the folder it is given, and in the parent's own folder when it is given none", async () => {
    const dir = Buffer.from(process.cwd()).toString("utf8");
    const here = await port.run(NODE, ["-e", "process.stdout.write(process.cwd())"], { timeoutMs: 10_000, maxStdoutBytes: 1_000 });
    expect(text(here.stdout)).toBe(dir);
    const there = await port.run(NODE, ["-e", "process.stdout.write(require('fs').realpathSync(process.cwd()))"], { timeoutMs: 10_000, maxStdoutBytes: 1_000, cwd: "/" });
    expect(text(there.stdout)).toBe("/");
  });
  it("keeps none of the output of a program asked to discard it, sets no limit on it, and still answers its exit code", async () => {
    const loud = "process.stdout.write('x'.repeat(2_000_000));process.stderr.write('y'.repeat(2_000_000));process.exit(4)";
    const result = await port.run(NODE, ["-e", loud], { timeoutMs: 20_000, maxStdoutBytes: 1, discardOutput: true, mergeStderr: true });
    expect(result).toMatchObject({ exitCode: 4, timedOut: false, tooLarge: false });
    expect(result.stdout.byteLength).toBe(0);
    const limited = await port.run(NODE, ["-e", loud], { timeoutMs: 20_000, maxStdoutBytes: 1_000 });
    expect(limited.tooLarge).toBe(true);
  });
  it("still stops a program that discards its output when it runs past its time", async () => {
    const result = await port.run(NODE, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 700, maxStdoutBytes: 1, discardOutput: true });
    expect(result).toMatchObject({ timedOut: true, exitCode: null });
  });
});
