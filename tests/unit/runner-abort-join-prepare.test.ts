// FIX-RUNNER-ABORT-JOIN: the host runner (prepare.ts runProjectCommand, and createCheckRunners over it) turns a stop that could not
// be confirmed into RunnerKillUnconfirmedError, and the check round does not mask it as "aborted".
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type * as CollectedProcessModule from "../../packages/worker/src/collected-process.js";

const killUnconfirmed = vi.hoisted(() => ({ on: true }));
vi.mock("../../packages/worker/src/collected-process.js", async (importOriginal) => {
  const original = await importOriginal<typeof CollectedProcessModule>();
  return {
    ...original,
    runCollected: async (...args: Parameters<typeof original.runCollected>) => {
      if (killUnconfirmed.on) return { exitCode: null, stdout: "", stderr: "", killUnconfirmed: true as const };
      return original.runCollected(...args);
    },
  };
});

const { RunnerKillUnconfirmedError } = await import("../../packages/worker/src/collected-process.js");
const { runProjectCommand } = await import("../../packages/worker/src/prepare.js");
const { createCheckRunners } = await import("../../packages/worker/src/verification/checks.js");

describe("host runners and an unconfirmed stop", () => {
  const roots: string[] = [];
  afterAll(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); });
  async function root(): Promise<string> {
    const made = realpathSync(await mkdtemp(join(tmpdir(), "abort-join-prepare-")));
    roots.push(made);
    return made;
  }
  const command = { cwd: ".", executable: "make", args: ["test"], timeoutSeconds: 60 };

  it("runProjectCommand throws instead of returning an exit code", async () => {
    killUnconfirmed.on = true;
    await expect(runProjectCommand(command, 0, await root(), undefined, true)).rejects.toBeInstanceOf(RunnerKillUnconfirmedError);
  });

  it("createCheckRunners passes it through on an aborted signal, never as 'aborted'", async () => {
    killUnconfirmed.on = true;
    const controller = new AbortController();
    const runners = createCheckRunners({ rootPath: await root(), local: true });
    const running = runners.runProjectCommand(command, controller.signal);
    controller.abort();
    await expect(running).rejects.toBeInstanceOf(RunnerKillUnconfirmedError);
  });

  it("createCheckRunners passes an unconfirmed stop of the agent's shell through on an aborted signal, never as 'aborted'", async () => {
    killUnconfirmed.on = false;
    const controller = new AbortController();
    const bashOperations = { exec: async () => { controller.abort(); throw new RunnerKillUnconfirmedError({ kind: "local" }); } };
    const runners = createCheckRunners({ rootPath: await root(), bashOperations });
    await expect(runners.runAgentCommand("make test", 60_000, controller.signal)).rejects.toBeInstanceOf(RunnerKillUnconfirmedError);
  });

  it("a confirmed abort of the agent's shell is still 'aborted'", async () => {
    killUnconfirmed.on = false;
    const controller = new AbortController();
    const bashOperations = { exec: async () => { controller.abort(); throw new Error("aborted"); } };
    const runners = createCheckRunners({ rootPath: await root(), bashOperations });
    await expect(runners.runAgentCommand("make test", 60_000, controller.signal)).rejects.toThrow("aborted");
  });

  it("an ordinary result still returns an ordinary result", async () => {
    killUnconfirmed.on = false;
    await expect(runProjectCommand({ ...command, executable: "true", args: [] }, 0, await root(), undefined, true)).resolves.toMatchObject({ exitCode: 0 });
  });
});
