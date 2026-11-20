// The step runner for `agentx init`: runs steps under the environment lock, records each outcome
// in SSM as soon as it is known, skips a done step on every later run (FR-019), never records a
// failed step (so the next run retries it), and records but stops on a waiting step (FR-035).
import { describe, expect, it, vi, type Mock } from "vitest";
import { type InitStepId } from "../../packages/cli/src/init/install-state.js";
import { runInitSteps, type InitStep, type StepOutcome } from "../../packages/cli/src/init/steps.js";
import { isOperatorStop, markOperatorStop } from "../../packages/cli/src/init/stop.js";
import { HOLDER } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const ENV = "staging";
const T0 = Date.parse("2026-09-27T00:00:00.000Z");
const LOCK = "/agentx/staging/lock";

/** A step whose `run` is a plain property (not a method signature), so `expect(step.run)` never
 * trips `@typescript-eslint/unbound-method` (rulings.md Task 3, F4). It is still structurally an
 * `InitStep<unknown>`: fewer parameters on `run` are fine to pass where more are expected. */
interface TestStep {
  id: InitStepId;
  title: string;
  run: Mock<InitStep<unknown>["run"]>;
}

function step(id: InitStepId, run: () => Promise<StepOutcome> = async () => ({ status: "done" })): TestStep {
  return { id, title: `step ${id}`, run: vi.fn<InitStep<unknown>["run"]>(run) };
}

const run = (store: MemoryParameterStore, steps: ReadonlyArray<InitStep<unknown>>, extra: Partial<Parameters<typeof runInitSteps>[0]> = {}) =>
  runInitSteps({ env: ENV, region: "us-east-1", store, holder: HOLDER, steps, context: {}, now: () => T0, ...extra });

describe("init step runner", () => {

  it("turns expired AWS credentials into AUTH_REQUIRED that says how to refresh and that init resumes", async () => {
    const store = new MemoryParameterStore();
    const expired = Object.assign(new Error("The security token included in the request is expired"), { name: "ExpiredTokenException" });
    await expect(run(store, [step("core", async () => { throw expired; })])).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      message: expect.stringContaining('init stopped at "step core": AWS credentials missing or expired') as unknown,
    });
  });

  it("offers to take over the caller's own lock left by a killed run, and refuses without asking for someone else's (Review Focus 1)", async () => {
    const own = new MemoryParameterStore();
    own.values.set(LOCK, JSON.stringify({ holder: HOLDER, command: "init", acquiredAt: new Date(T0 - 5 * 60_000).toISOString() }));
    const confirmTakeover = vi.fn(async () => true);
    expect(await run(own, [step("access")], { confirmTakeover })).toMatchObject({ status: "complete" });
    expect(confirmTakeover).toHaveBeenCalledOnce();

    const other = new MemoryParameterStore();
    other.values.set(LOCK, JSON.stringify({ holder: "arn:aws:sts::123456789012:assumed-role/Admin/bob", command: "init", acquiredAt: new Date(T0 - 5 * 60_000).toISOString() }));
    const notAsked = vi.fn(async () => true);
    await expect(run(other, [step("access")], { confirmTakeover: notAsked })).rejects.toThrow(`locked by arn:aws:sts::123456789012:assumed-role/Admin/bob running "init" since ${new Date(T0 - 5 * 60_000).toISOString()}; wait for it to finish, then run the same agentx command again`);
    expect(notAsked).not.toHaveBeenCalled();
  });

  // Fix round 1 (Plan ruling 8): a stop the step's own run chose (declining a "check again"
  // question inside it, say) keeps that status through the wrap initStepFailure builds, so a
  // catch further up (runInit's) still reads it as a stop, not a new failure, however
  // onStepFailure answers.
  it("spec 048 FR-060 fix: a stop the step's run already chose keeps that status through the thrown error", async () => {
    const stopping: InitStep<null> = { id: "access", title: "Set up AWS permissions", run: async () => { throw markOperatorStop(new Error("said no to continuing")); } };
    const thrown = await runInitSteps({ env: "staging", region: "us-east-1", store: new MemoryParameterStore(), holder: HOLDER, steps: [stopping], context: null, onStepFailure: async () => "stop" })
      .then(() => undefined, (error: unknown) => error);
    expect(isOperatorStop(thrown)).toBe(true);
    expect(thrown).toMatchObject({ message: expect.stringContaining("said no to continuing") as unknown });
  });

});

