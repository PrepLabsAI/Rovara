// The agent's shell runs a test command piped into `tail` with pipefail, so its exit code is the test's and the
// recorder can take that run as a before result (spec 051). Any other pipe keeps the shell's default.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentShellSpawn, agentShellTool } from "../../packages/worker/src/pi-session.js";
import { AGENTX_GIT_IDENTITY_ENVIRONMENT } from "../../packages/worker/src/git.js";

type Run = (id: string, params: { command: string }, signal?: AbortSignal) => Promise<{ structuredContent?: { exit_code?: number }; isError?: boolean }>;

describe("the agent's shell and a test command piped into tail", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function shell(): Promise<Run> {
    const cwd = await mkdtemp(join(tmpdir(), "agentx-pipefail-"));
    cleanup.push(cwd);
    await writeFile(join(cwd, "Makefile"), "test:\n\t@echo 1 failed\n\t@exit 3\n");
    return (agentShellTool(cwd) as unknown as { execute: Run }).execute;
  }

  it("reports the failing test's exit code, not tail's", async () => {
    const run = await shell();
    const piped = await run("t1", { command: "make test 2>&1 | tail -5" });
    expect(piped.structuredContent?.exit_code).not.toBe(0);
    expect(piped.isError).toBe(true);
  });

  /**
   * Feature: AgentX checks the agent's test commands (spec 051, #299)
   * Scenario: the agent shell runs cd <dir>; <test> | tail with pipefail
   *   Given a workspace whose `make test` fails, in a sub-folder
   *   When the agent runs `cd sub; make test 2>&1 | tail -5`
   *   Then the run's exit code is the test's, not tail's
   * Requirement: docs/specs/issue-299/requirements.md#requirement-1-cd-dir-test-reads-as-cd-dir--test (1.3)
   */
  it("reports the failing test's exit code for cd <dir>; <test> | tail, as for cd <dir> && (#299)", async () => {
    const run = await shell();
    const piped = await run("t3", { command: "mkdir -p sub && cp Makefile sub/" });
    expect(piped.structuredContent?.exit_code ?? 0).toBe(0);
    const result = await run("t4", { command: "cd sub; make test 2>&1 | tail -5" });
    expect(result.structuredContent?.exit_code).not.toBe(0);
    expect(result.isError).toBe(true);
  });

  it("leaves any other pipe to the shell's default, where tail's status is the pipeline's", async () => {
    const run = await shell();
    const other = await run("t2", { command: "false | tail -5" });
    expect(other.structuredContent?.exit_code).toBe(0);
  });

  it("adds pipefail only to a piped test command, and the AgentX git identity to every command", () => {
    const context = { command: "cd /testbed && python -m pytest a -q 2>&1 | tail -20", cwd: "/w", env: { PATH: "/bin" } };
    expect(agentShellSpawn(context)).toEqual({
      ...context,
      command: "set -o pipefail; cd /testbed && python -m pytest a -q 2>&1 | tail -20",
      env: { PATH: "/bin", ...AGENTX_GIT_IDENTITY_ENVIRONMENT },
    });
    expect(agentShellSpawn({ ...context, command: "cd /testbed; pytest -q | tail -5" }).command).toBe("set -o pipefail; cd /testbed; pytest -q | tail -5");
    for (const command of ["pytest -q", "make test | head -5", "ls | tail -5", "make build && make test | tail -5"]) {
      expect(agentShellSpawn({ ...context, command }).command).toBe(command);
    }
  });
});
