import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runAgentCase } from "../support/agent-executor-run.js";
import { runReplayCase } from "../support/agent-replay-run.js";
import { withExecutorRunLock } from "../support/executor-run-lock.js";
import { createOrdersM14AgentPlan } from "../support/orders-m14-agent.js";
import type * as ExecutorRunLock from "../support/executor-run-lock.js";
import type * as OrdersAgent from "../support/orders-m14-agent.js";
import { runE2EExecutor } from "../../packages/verifier/src/executor/run.js";
import { readExecutorResultFile, snapshotExecutorOutput } from "../../packages/verifier/src/host/executor-readback.js";
import type { WebApiProbePlan } from "../../packages/verifier/src/host/web-api-probe-plan.js";

const state = vi.hoisted(() => ({ directory: "" }));

// Use the real lock, but never contend with another lane's executor port.
vi.mock("../support/executor-run-lock.js", async (original) => {
  const actual = await original<typeof ExecutorRunLock>();
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  state.directory = await mkdtemp(path.join(tmpdir(), "replay-collection-admission-"));
  const lock = actual.createExecutorRunLock({ path: path.join(state.directory, "executor.lock"), pollMs: 1 });
  return { ...actual, withExecutorRunLock: lock.withLock.bind(lock) };
});

class AdmissionProbe extends Error {
  readonly slotHeld = existsSync(join(state.directory, "executor.lock"));
  constructor(readonly fixture: WebApiProbePlan) { super("stop before starting the fixture app"); }
}

// Compilation, admission signing and locking stay real. Stop at the first socket boundary.
vi.mock("../support/orders-m14-agent.js", async (original) => ({
  ...await original<typeof OrdersAgent>(),
  startOrdersM14App: (fixture: WebApiProbePlan) => { throw new AdmissionProbe(fixture); },
}));

afterEach(() => { vi.useRealTimers(); });
afterAll(async () => { await rm(state.directory, { recursive: true, force: true }); });

describe("agent fixtures admit only after acquiring the executor slot", () => {
  it.each(["candidate", "replay"] as const)("does not spend the %s admission deadline waiting for another executor", async (kind) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-11-22T03:00:00.000Z");
    let release!: () => void;
    let entered!: () => void;
    const holding = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const blocker = withExecutorRunLock(async () => { entered(); await held; });
    await holding;
    const attempt = (kind === "candidate" ? runAgentCase({ script: [] }) : runReplayCase({ traces: [] }))
      .catch((error: unknown) => error);
    try {
      // Longer than the replay's unchanged 60 s budget, with no sleep or timeout increase.
      vi.setSystemTime("2026-11-22T03:02:00.000Z");
      release();
      await blocker;
      const error = await attempt;
      expect(error).toBeInstanceOf(AdmissionProbe);
      const fixture = (error as AdmissionProbe).fixture;
      expect(fixture.plan.admission.round.admittedAt).toBe("2026-11-22T03:02:00.000Z");
      expect(fixture.plan.deadlineAt).toBeGreaterThan(Date.now());
      if (kind === "replay") expect(fixture.plan.deadlineAt).toBe(Date.now() + 60_000);
      // Acquiring and releasing before the run preserves admission timing but loses exclusion.
      expect(error).toHaveProperty("slotHeld", true);
    } finally {
      release();
      await blocker;
      await attempt;
    }
  });

  it("an expired replay leaves no observations even though nobody cleaned its output directory", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-11-22T03:00:00.000Z");
    const fixture = createOrdersM14AgentPlan({ replay: { traces: [] } });
    const planPath = join(state.directory, "expired-plan.json");
    const outDir = join(state.directory, "expired-out");
    await writeFile(planPath, JSON.stringify(fixture.plan));
    vi.setSystemTime("2026-11-22T03:02:00.000Z");
    // The real executor refuses before opening any socket; readback then reproduces the host's ENOENT.
    expect(await runE2EExecutor({ planPath, outDir, signal: new AbortController().signal }))
      .toEqual({ exitCode: 2, reason: "deadline-exceeded" });
    const result = await readExecutorResultFile(outDir);
    expect(result.shards).toEqual([]);
    await expect(snapshotExecutorOutput(outDir, result)).rejects.toMatchObject({ code: "ENOENT", path: join(outDir, "observations") });
  });
});
