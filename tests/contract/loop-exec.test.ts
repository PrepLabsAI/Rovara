import { describe, expect, it } from "vitest";
import { realExec } from "../../packages/cli/src/loop/exec.js";

describe("loop realExec stdin lifecycle", () => {
  it("preserves a successful fast child when empty stdin closes early", async () => {
    const result = await realExec(process.execPath, ["-e", "process.exit(0)"]);
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("delivers non-empty stdin to a child that reads it", async () => {
    const result = await realExec(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { input: "candidate-bound input\n" });
    expect(result).toEqual({ code: 0, stdout: "candidate-bound input\n", stderr: "" });
  });

  it("fails closed when a child closes stdin before non-empty input is delivered", async () => {
    const result = await realExec(process.execPath, ["-e", "process.stdin.destroy(); setTimeout(() => process.exit(0), 25)"], { input: "x".repeat(1_000_000) });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("stdin write failed");
    expect(result.stderr).not.toContain("x".repeat(32));
  });

  it("keeps the missing-executable result", async () => {
    const result = await realExec("/definitely-missing-agentx-executable", []);
    expect(result.code).toBe(127);
    expect(result.stderr).toContain("ENOENT");
  });

  it("preserves a real child's nonzero exit and captured output", async () => {
    const result = await realExec(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(7)"]);
    expect(result).toEqual({ code: 7, stdout: "out", stderr: "err" });
  });
});
