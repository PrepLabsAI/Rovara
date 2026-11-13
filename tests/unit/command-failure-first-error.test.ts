// Bug F: a setup failure showed only the last lines, so a "not found" line above them (the useful one) was lost behind the
// tail of an installer's chatter. The first error-looking line is shown too, when the tail does not already show it.
import { DEVELOPER_FAILURE_MESSAGE_MAX, type ProjectCommand } from "@rovara-code/contracts";
import { describe, expect, it } from "vitest";
import { describeCommandFailure } from "../../packages/worker/src/command-failure.js";

const command: ProjectCommand = { cwd: "repo/app", executable: "npm", args: ["test"], timeoutSeconds: 60 };
const lines = (count: number, make: (index: number) => string) => Array.from({ length: count }, (_, index) => make(index + 1)).join("\n");
const failed = (stdout: string, stderr = "") => describeCommandFailure("readiness check", 0, command, { exitCode: 127, stdout, stderr });

describe("the first error line of a failed setup step or readiness check", () => {
  it("is shown above the last lines when the tail does not contain it", () => {
    const output = `sh: 1: vitest: not found\n${lines(60, (n) => `npm notice line ${n}`)}`;
    const message = failed("", output);
    expect(message).toMatch(/^readiness check 0 \(npm test in repo\/app\) exited 127\nFirst error line: sh: 1: vitest: not found\nLast lines:\nnpm notice line 41\n/u);
    expect(message.endsWith("npm notice line 60")).toBe(true);
  });

  it("finds the first of several errors, in the printed output too, and matches npm's and the shell's words", () => {
    expect(failed(`npm ERR! code E404\nnpm ERR! 404 gone\n${lines(40, (n) => `x ${n}`)}`)).toContain("First error line: npm ERR! code E404");
    expect(failed(`${lines(40, (n) => `x ${n}`)}`, "Error: Cannot find module 'vite'\n" + lines(40, (n) => `y ${n}`))).toContain("First error line: Error: Cannot find module 'vite'");
    expect(failed("make: gcc: command not found\n" + lines(40, (n) => `z ${n}`))).toContain("First error line: make: gcc: command not found");
  });

  it("is left out when the last lines already show it, or no line looks like an error", () => {
    expect(failed("", "sh: 1: vitest: not found")).toBe("readiness check 0 (npm test in repo/app) exited 127\nLast lines:\nsh: 1: vitest: not found");
    expect(failed(lines(60, (n) => `step ${n} ok`))).not.toContain("First error line");
  });

  it("is cut to one bounded line, redacted, and the whole message still fits the task view's failure message", () => {
    const secret = `ghp_${"Q1w2E3r4T5".repeat(4)}`;
    const message = failed("", `error: ${"x".repeat(2_000)} ${secret}\n${lines(80, (n) => `${"w".repeat(80)} ${n}`)}`);
    const first = message.split("\n").find((line) => line.startsWith("First error line: "))!;
    expect(first.length).toBeLessThanOrEqual("First error line: ".length + 200);
    expect(first.endsWith("...")).toBe(true);
    expect(message).not.toContain(secret);
    expect(message.length).toBeLessThanOrEqual(DEVELOPER_FAILURE_MESSAGE_MAX);
    expect(message).toContain("\nLast lines:\n");
  });
});
