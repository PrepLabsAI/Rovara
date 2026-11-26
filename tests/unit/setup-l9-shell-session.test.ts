// SETUP-L9-SHELL (DEC 254zzz562): the lines of one group (a project's setup commands, or its test commands) run in ONE shell session: `source .venv/bin/activate`, `cd`, `export`, a function, `nvm use` on one line are still
// there on the next. These tests run the real in-container wrapper (`runContainerCommand`) through bash on this machine, a "container" with its own small environment, so what they show is what the wrapper does in one.
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCommandLine, type ProjectCommand } from "@agentx/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runContainerCommand, type ContainerExec } from "../../packages/worker/src/devcontainer.js";
import { closeShellSession, groupLimitSeconds, newShellSession, SHELL_GROUP_TIMEOUT_SECONDS, type ShellSession } from "../../packages/worker/src/shell-session.js";

let root: string;
let stubBin: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agentx-l9-session-")));
  stubBin = join(root, "..", `l9-stub-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`);
  await mkdir(stubBin, { recursive: true });
  // A stand-in for `npm`: it says where it ran.
  await writeFile(join(stubBin, "npm"), '#!/bin/sh\necho "npm $* in $(basename "$PWD")"\n');
  await chmod(join(stubBin, "npm"), 0o755);
  await mkdir(join(root, "repo/app/sub"), { recursive: true });
  await mkdir(join(root, "repo/other"), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(stubBin, { recursive: true, force: true });
});

/**
 * A container that is this machine with a small environment of its own: PATH, HOME and what the exec passes, and nothing of this process's (a test's own AWS_ variable must never reach a saved line's shell).
 */
const container = (extra: Record<string, string> = {}): ContainerExec => (command, options) => new Promise((resolve) => {
  const env = { PATH: `${stubBin}:${process.env["PATH"] ?? ""}`, HOME: root, ...extra, ...options.env };
  const child = spawn(command[0]!, command.slice(1), { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); options.onStdout?.(chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); options.onStderr?.(chunk); });
  child.on("close", (code) => resolve({ exitCode: code, stdout, stderr }));
});

const line = (text: string, cwd = "repo/app", timeoutSeconds = 30, extra: Partial<ProjectCommand> = {}): ProjectCommand => ({ ...parseCommandLine(text, cwd, timeoutSeconds), ...extra });
const exec = container();
const run = (command: ProjectCommand, session?: ShellSession, signal?: AbortSignal) => runContainerCommand(exec, root, command, signal, session === undefined ? {} : { session });
const out = async (command: ProjectCommand, session?: ShellSession): Promise<string> => { const result = await run(command, session); return `${result.stdout}${result.stderr}`.trim(); };

describe("the lines of one group share one shell session", () => {
  it("`source .venv/bin/activate` on one line is still in effect on the next (a real venv)", async () => {
    const session = newShellSession();
    const made = await run(line("python3 -m venv .venv"), session);
    expect(made.exitCode).toBe(0);
    expect((await run(line("source .venv/bin/activate"), session)).exitCode).toBe(0);
    // A later line, with no `source` of its own: the interpreter is the venv's, so is PATH, and so is `pip`.
    expect(await out(line(`python3 -c "import sys; print(sys.prefix != sys.base_prefix)"`), session)).toBe("True");
    expect(await out(line("command -v python3"), session)).toBe(join(root, "repo/app/.venv/bin/python3"));
    expect(await out(line("echo $VIRTUAL_ENV"), session)).toBe(join(root, "repo/app/.venv"));
    await closeShellSession(session);
  });

  it("the owner's case runs green in one session: venv, `source ... && pip install`, `source ... && python3 -m src.db`", async () => {
    await mkdir(join(root, "repo/app/src"), { recursive: true });
    await writeFile(join(root, "repo/app/requirements.txt"), "# nothing to install\n");
    await writeFile(join(root, "repo/app/src/__init__.py"), "");
    await writeFile(join(root, "repo/app/src/db.py"), "import os, sys\nassert sys.prefix != sys.base_prefix, 'not in the venv'\nprint('db ok', os.path.basename(os.environ['VIRTUAL_ENV']))\n");
    const session = newShellSession({ limitSeconds: 600 });
    const lines = ["python3 -m venv .venv", "source .venv/bin/activate && pip install -r requirements.txt", "source .venv/bin/activate && python3 -m src.db"];
    const results = [];
    for (const text of lines) results.push(await run(line(text, "repo/app", 120), session));
    expect(results.map((result) => result.exitCode), results.map((result) => result.stderr).join("\n")).toEqual([0, 0, 0]);
    expect(results[2]!.stdout.trim()).toBe("db ok .venv");
  }, 120_000);

  it("`cd` does not persist: every line starts at the root; `cd sub && npm ci` is one line in sub; a `cd sub` line followed by `ls` lists the root", async () => {
    await writeFile(join(root, "repo/app/at-root.txt"), "");
    await writeFile(join(root, "repo/app/sub/in-sub.txt"), "");
    const session = newShellSession();
    expect(await out(line("cd sub"), session)).toBe("");
    expect(await out(line("ls"), session)).toBe("at-root.txt\nsub");
    expect(await out(line("pwd"), session)).toBe(join(root, "repo/app"));
    expect(await out(line("cd sub && npm ci"), session)).toBe("npm ci in sub");
    expect(await out(line("npm ci"), session)).toBe("npm ci in app");
  });

  it("`cd frontend && ...` then `cd backend && ...` both work: each line starts at the root", async () => {
    await mkdir(join(root, "repo/app/frontend"), { recursive: true });
    await mkdir(join(root, "repo/app/backend"), { recursive: true });
    const session = newShellSession();
    expect(await out(line("cd frontend && npm ci"), session)).toBe("npm ci in frontend");
    expect(await out(line("cd backend && npm ci"), session)).toBe("npm ci in backend");
  });

  it("a bare `source .venv/bin/activate` line, then a bare `pip install -r requirements.txt` line, works through the carried environment", async () => {
    await writeFile(join(root, "repo/app/requirements.txt"), "# nothing to install\n");
    const session = newShellSession();
    expect((await run(line("python3 -m venv .venv"), session)).exitCode).toBe(0);
    expect((await run(line("source .venv/bin/activate"), session)).exitCode).toBe(0);
    expect(await out(line("echo $VIRTUAL_ENV; command -v pip"), session)).toBe(`${join(root, "repo/app/.venv")}\n${join(root, "repo/app/.venv/bin/pip")}`);
    const installed = await run(line("pip install -r requirements.txt"), session);
    expect(installed.exitCode, installed.stderr).toBe(0);
    await closeShellSession(session);
  }, 120_000);

  it("a variable that is not exported does not carry (as in CI an `export` is needed); an exported one and a function do", async () => {
    const session = newShellSession();
    await run(line("PLAIN=1; export EXPORTED=2; fn() { echo fn-ran; }"), session);
    expect(await out(line(`echo "[\${PLAIN-}][\${EXPORTED-}]"; fn`), session)).toBe("[][2]\nfn-ran");
  });

  it("exported variables, functions and `unset` carry over; a line's own `exit` ends only that line", async () => {
    const session = newShellSession();
    await run(line("export FOO=bar; greet() { echo hello-$FOO; }"), session);
    expect(await out(line("greet; printenv FOO"), session)).toBe("hello-bar\nbar");
    await run(line("unset FOO"), session);
    expect(await out(line(`echo "[\${FOO-unset}]"`), session)).toBe("[unset]");
    const ended = await run(line("export LAST=1; exit 3"), session);
    expect(ended.exitCode).toBe(3);
    expect(await out(line("echo $LAST"), session)).toBe("1");
  });

  it("a command that is one program also sees the session once a shell line has run (a program on the next line is run by the same shell)", async () => {
    const session = newShellSession();
    await run(line("export FOO=bar"), session);
    const plain: ProjectCommand = { cwd: "repo/app", executable: "printenv", args: ["FOO"], timeoutSeconds: 30 };
    expect(await out(plain, session)).toBe("bar");
    // With no session, or in another one, it does not.
    expect((await run(plain)).exitCode).toBe(1);
    expect((await run(plain, newShellSession())).exitCode).toBe(1);
  });

  it("a group of programs alone runs exactly as before: no shell reads its words again", async () => {
    const session = newShellSession();
    const result = await run({ cwd: "repo/app", executable: "echo", args: ["$HOME", "&&", "a b"], timeoutSeconds: 30 }, session);
    expect(result.stdout.trim()).toBe("$HOME && a b");
    expect(session.stateful).toBe(false);
    // Not read by a shell at all: the wrapper that started it is the `exec "$@"` one, and the session's script was never sent.
    const sent: string[] = [];
    await runContainerCommand((argv, options) => { sent.push(argv.join("\u0000")); return exec(argv, options); }, root, { cwd: "repo/app", executable: "echo", args: ["a b"], timeoutSeconds: 30 }, undefined, { session });
    expect(sent[0]).toContain('exec "$@"');
    expect(sent[0]).not.toContain("__rv_");
  });

  it("a command's own `env` is for that command only, and what it changes in its own line is not carried by the session", async () => {
    const session = newShellSession();
    expect(await out(line("echo $ONLY_HERE", "repo/app", 30, { env: { ONLY_HERE: "yes" } }), session)).toBe("yes");
    expect(await out(line("echo [$ONLY_HERE]"), session)).toBe("[]");
  });

  it("a second group does not see the first's lines", async () => {
    const first = newShellSession();
    await run(line("export FOO=bar"), first);
    const second = newShellSession();
    expect(await out(line("echo [$FOO]"), second)).toBe("[]");
  });

  it("each line runs under `set -e -o pipefail`: it stops at its first failing command, and a failing pipe fails", async () => {
    const stopped = await run(line("false; echo not-reached"));
    expect(stopped.exitCode).toBe(1);
    expect(stopped.stdout).not.toContain("not-reached");
    expect((await run(line("false | cat"))).exitCode).toBe(1);
    // The options belong to the line: the next line is not still under `set -e` unless it says so.
    const session = newShellSession();
    await run(line("set +e"), session);
    const next = await run(line("false; echo after"), session);
    expect(next.exitCode).toBe(1);
    expect(next.stdout).not.toContain("after");
  });

  it("closing a session removes its state file", async () => {
    const session = newShellSession();
    await run(line("export FOO=1"), session);
    const had = (await readdir("/tmp")).includes(session.stateFile.slice("/tmp/".length));
    expect(had).toBe(true);
    await closeShellSession(session);
    expect((await readdir("/tmp")).includes(session.stateFile.slice("/tmp/".length))).toBe(false);
  });
});

describe("time limits and failures of a line", () => {
  it("a line that runs past its own limit is stopped and says it timed out", async () => {
    const started = Date.now();
    const result = await run(line("sleep 30", "repo/app", 1));
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  it("a group's time is a limit too: a line is stopped when the group's time runs out, and the next is not started", async () => {
    expect(SHELL_GROUP_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(2_700);
    expect(groupLimitSeconds([{ timeoutSeconds: 900 }])).toBe(SHELL_GROUP_TIMEOUT_SECONDS);
    expect(groupLimitSeconds([{ timeoutSeconds: 9_000 }])).toBe(9_000);
    const session = newShellSession({ limitSeconds: 2 });
    const slow = await run(line("sleep 30", "repo/app", 600), session);
    expect(slow).toMatchObject({ timedOut: true, stoppedBy: "group_limit" });
    const next = await run(line("echo should-not-run"), session);
    expect(next).toMatchObject({ timedOut: true, stoppedBy: "group_limit", stdout: "" });
    expect(next.stderr).toContain("did not start");
  }, 30_000);

  it("a failing line reports its exit code and what it printed, and a line with a secret-shaped value is not echoed back by the runner", async () => {
    const result = await run(line("echo before; echo oops >&2; exit 7"));
    expect(result).toMatchObject({ exitCode: 7 });
    expect(result.stdout).toContain("before");
    expect(result.stderr).toContain("oops");
  });
});

describe("what the shell can see", () => {
  it("is the container's own environment plus the command's: nothing of this process's credentials", async () => {
    process.env["AWS_SECRET_ACCESS_KEY"] = "worker-secret-value";
    process.env["AWS_SESSION_TOKEN"] = "worker-session-token";
    process.env["ANTHROPIC_API_KEY"] = "worker-api-key";
    try {
      const session = newShellSession();
      const seen = await out(line(`echo "[\${AWS_SECRET_ACCESS_KEY-}][\${AWS_SESSION_TOKEN-}][\${ANTHROPIC_API_KEY-}]"; env | grep -c -i -E 'secret|token|api_key' || true`), session);
      expect(seen).toBe("[][][]\n0");
      // And not through the state a line leaves for the next.
      expect(await out(line("env | grep -c -i -E 'worker-' || true"), session)).toBe("0");
    } finally {
      delete process.env["AWS_SECRET_ACCESS_KEY"];
      delete process.env["AWS_SESSION_TOKEN"];
      delete process.env["ANTHROPIC_API_KEY"];
    }
  });

  it("the wrapper's own words are not in the line's environment or its positional parameters", async () => {
    const seen = await out(line('echo "[$#][$0]"; env | grep -c "__rv_" || true'));
    expect(seen).toBe("[0][bash]\n0");
  });

  // PRE-REVIEW MUST 1 (SETUP-L9-SHELL-PRE-REVIEW-SONNET.md): a line that turns on `set -x` (a common CI idiom) leaves xtrace on while `__rv_save` runs, so the wrapper's own code traces every exported variable's value (and its
  // `__rv_` internals) to stderr, after the line's own output: it shows values the line never printed, and buries the failing line's last lines (what `describeCommandFailure` keeps) under the trace. Expected to FAIL until `__rv_save` turns xtrace off.
  it("a line that turns on `set -x` does not make the session code trace the environment or bury the line's own last lines", async () => {
    const probe = "env-value-the-line-never-printed-4711";
    const session = newShellSession();
    const result = await runContainerCommand(container({ SESSION_PROBE_VALUE: probe }), root, line("set -x; export FOO=1; echo traced-line >&2; false"), undefined, { session });
    expect(result.exitCode).not.toBe(0);
    const stderr = result.stderr;
    expect(stderr).toContain("echo traced-line");
    expect(stderr).not.toContain(probe);
    expect(stderr).not.toContain("__rv_");
    expect(stderr.trim().split("\n").at(-1)).not.toMatch(/__rv_|set \+e/);
  });
});
