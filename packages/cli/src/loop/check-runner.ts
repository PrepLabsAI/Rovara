// rovara loop (#356): the repository's checks, run in the item's worktree after the agent codes. Each runs through
// the shell, as CI runs it, in its own process group, so a timeout stops everything it started. What a failure
// shows is the end of its output, with secrets redacted.
import { spawn } from "node:child_process";
import { redactText } from "@agentx/contracts";
import type { LoopRepoConfig } from "./config.js";

/** How much of a failing check's output is kept: its last lines matter most. */
const OUTPUT_TAIL = 4_000;

export interface CheckResult { name: string; passed: boolean; detail: string; seconds: number }

export type CheckRun = (command: string, options: { cwd: string; timeoutMs: number }) => Promise<{ code: number | null; timedOut: boolean; output: string }>;

export const shellCheckRun: CheckRun = (command, options) => new Promise((resolve) => {
  const child = spawn("/bin/sh", ["-c", command], { cwd: options.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const keep = (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(-OUTPUT_TAIL * 4); };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  let timedOut = false;
  const stopAll = (signal: NodeJS.Signals) => { try { if (child.pid !== undefined) process.kill(-child.pid, signal); } catch { /* already gone */ } };
  const timer = setTimeout(() => {
    timedOut = true;
    stopAll("SIGTERM");
    setTimeout(() => { stopAll("SIGKILL"); }, 5_000).unref();
  }, options.timeoutMs);
  child.on("error", (error) => { clearTimeout(timer); resolve({ code: 127, timedOut: false, output: `${output}${error.message}` }); });
  child.on("close", (code) => { clearTimeout(timer); stopAll("SIGKILL"); resolve({ code, timedOut, output }); });
});

/** Runs every check in order; all run, so one report says everything that failed. */
export async function runChecks(checks: LoopRepoConfig["checks"], cwd: string, run: CheckRun = shellCheckRun, now: () => number = Date.now): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    const started = now();
    const result = await run(check.run, { cwd, timeoutMs: check.timeoutSeconds * 1_000 });
    const seconds = Math.round((now() - started) / 1_000);
    const passed = !result.timedOut && result.code === 0;
    const tail = redactText(result.output).trimEnd().slice(-OUTPUT_TAIL);
    const detail = passed ? "" : result.timedOut ? `timed out after ${check.timeoutSeconds}s\n${tail}` : `exited ${result.code ?? "on a signal"}\n${tail}`;
    results.push({ name: check.name, passed, detail, seconds });
  }
  return results;
}

/** The checks as Markdown: one line each, then each failure's output. */
export function checksReport(results: readonly CheckResult[]): string {
  if (results.length === 0) return "No checks are configured for this repository (`checks` in `.rovara/loop.yaml`), so none ran.";
  const lines = results.map((result) => `- ${result.passed ? "✅" : "❌"} **${result.name}** (${result.seconds}s)`);
  const failures = results.filter((result) => !result.passed).map((result) => `<details><summary>${result.name}</summary>\n\n\`\`\`\n${result.detail}\n\`\`\`\n\n</details>`);
  return [...lines, ...(failures.length === 0 ? [] : ["", ...failures])].join("\n");
}
