// rovara loop (#355): every outside program the loop runs (gh, git, tmux, claude) goes through one
// function, so tests replace them all with fakes and nothing here ever builds a shell command line.
import { spawn } from "node:child_process";

export interface ExecResult { code: number; stdout: string; stderr: string }
export interface ExecOptions { cwd?: string; input?: string; timeoutMs?: number }
export type Exec = (command: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>;

/** Runs a program without a shell. A program that is not installed answers code 127, as a shell would. */
export const realExec: Exec = (command, args, options = {}) => new Promise((resolve) => {
  const child = spawn(command, [...args], { cwd: options.cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let stdinFailure: NodeJS.ErrnoException | undefined;
  let settled = false;
  const input = options.input ?? "";
  const finish = (result: ExecResult) => {
    if (settled) return;
    settled = true;
    resolve(result);
  };
  const timer = setTimeout(() => { child.kill("SIGTERM"); }, options.timeoutMs ?? 60_000);
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  child.on("error", (error: NodeJS.ErrnoException) => {
    clearTimeout(timer);
    finish({ code: error.code === "ENOENT" ? 127 : 1, stdout, stderr: `${stderr}${error.message}` });
  });
  child.stdin.on("error", (error: NodeJS.ErrnoException) => { stdinFailure = error; });
  child.on("close", (code) => {
    clearTimeout(timer);
    const childCode = code ?? 1;
    // EPIPE is an expected race when a command exits without reading an empty
    // input stream. A failed non-empty write, or any other stdin error, is a
    // failed execution even if the child happened to exit successfully.
    const failedInput = stdinFailure !== undefined && !(input.length === 0 && stdinFailure.code === "EPIPE");
    const failureText = failedInput ? `stdin write failed (${stdinFailure?.code ?? "unknown"})` : "";
    finish({ code: failedInput && childCode === 0 ? 1 : childCode, stdout, stderr: [stderr, failureText].filter(Boolean).join("\n") });
  });
  child.stdin.end(input);
});

/** The program's output, or an error naming the program and its first line of complaint. */
export async function run(exec: Exec, command: string, args: readonly string[], options?: ExecOptions): Promise<string> {
  const result = await exec(command, args, options);
  if (result.code === 127) throw new Error(`${command} is not installed or not on PATH`);
  // Named by its subcommand (git push, gh pr), not by an option before it such as git's -C <dir>.
  const subcommand = args.find((arg, index) => !arg.startsWith("-") && args[index - 1] !== "-C") ?? "";
  if (result.code !== 0) throw new Error(`${command} ${subcommand} failed: ${(result.stderr.trim().split("\n")[0] ?? "").slice(0, 300) || `exit ${result.code}`}`);
  return result.stdout;
}
