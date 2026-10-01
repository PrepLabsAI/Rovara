// The step runner for `agentx init`: runs steps under the environment lock, records each outcome
// in SSM as soon as it is known, skips a done step on every later run (FR-019), never records a
// failed step (so the next run retries it), and records but stops on a waiting step (FR-035).
import { describe, expect, it, vi } from "vitest";
import { agentXError } from "@agentx/contracts";
import { initSteps } from "../../packages/cli/src/init/commands.js";
import { installProgressParameterName, INIT_STEP_IDS, readInstallProgress, type InitStepId } from "../../packages/cli/src/init/install-state.js";
import { runInitSteps, type InitEvent, type InitStep, type StepOutcome } from "../../packages/cli/src/init/steps.js";
import { STEP_PLAN } from "../../packages/cli/src/init/ui/journey.js";
import { fakeGitHubApi, fakeSlackApi } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const ENV = "staging";
const HOLDER = "arn:aws:sts::123456789012:assumed-role/Admin/alice";
const T0 = Date.parse("2026-09-27T00:00:00.000Z");
const LOCK = "/agentx/staging/lock";

/** A step whose `run` is a plain property (not a method signature), so `expect(step.run)` never
 * trips `@typescript-eslint/unbound-method` (rulings.md Task 3, F4). It is still structurally an
 * `InitStep<unknown>`: fewer parameters on `run` are fine to pass where more are expected. */
interface TestStep {
  id: InitStepId;
  title: string;
  run: ReturnType<typeof vi.fn>;
}

function step(id: InitStepId, run: () => Promise<StepOutcome> = async () => ({ status: "done" })): TestStep {
  return { id, title: `step ${id}`, run: vi.fn(run) };
}

const run = (store: MemoryParameterStore, steps: ReadonlyArray<InitStep<unknown>>, extra: Partial<Parameters<typeof runInitSteps>[0]> = {}) =>
  runInitSteps({ env: ENV, region: "us-east-1", store, holder: HOLDER, steps, context: {}, now: () => T0, ...extra });

describe("init step runner", () => {
  it("runs steps in order and records each as done in SSM", async () => {
    const store = new MemoryParameterStore();
    const events: InitEvent[] = [];
    const steps = [step("prerequisites"), step("access"), step("core")];
    const result = await run(store, steps, { onEvent: (event) => events.push(event) });
    expect(result).toEqual({ status: "complete", ran: ["prerequisites", "access", "core"], skipped: [] });
    const progress = await readInstallProgress(store, ENV);
    expect(Object.keys(progress!.steps)).toEqual(["prerequisites", "access", "core"]);
    expect(progress!.steps.access).toEqual({ status: "done", at: "2026-09-27T00:00:00.000Z" });
    expect(events.map((event) => event.kind)).toEqual(["step-started", "step-done", "step-started", "step-done", "step-started", "step-done"]);
  });

  it("resumes at the first incomplete step and never re-runs a completed one", async () => {
    const store = new MemoryParameterStore();
    const first = [step("prerequisites"), step("access"), step("core", async () => { throw new Error("network lost"); })];
    await expect(run(store, first)).rejects.toThrow('init stopped at "step core": network lost. Run agentx init --env staging --region us-east-1 again to continue from this step.');
    const second = [step("prerequisites"), step("access"), step("core")];
    const result = await run(store, second);
    expect(result).toEqual({ status: "complete", ran: ["core"], skipped: ["prerequisites", "access"] });
    expect(second[0]!.run).not.toHaveBeenCalled();
    expect(second[1]!.run).not.toHaveBeenCalled();
  });

  // Fix round 1, item 7: resuming past an already-done step must emit step-skipped for it, and that
  // event must come before the next (not-yet-done) step's own step-started.
  it("emits step-skipped for an already-done step, before the next step's step-started, on resume", async () => {
    const store = new MemoryParameterStore();
    await run(store, [step("prerequisites"), step("access")]);
    const events: InitEvent[] = [];
    const resumed = [step("prerequisites"), step("access"), step("core")];
    const result = await run(store, resumed, { onEvent: (event) => events.push(event) });
    expect(result).toEqual({ status: "complete", ran: ["core"], skipped: ["prerequisites", "access"] });
    expect(events).toEqual([
      { kind: "step-skipped", id: "prerequisites", title: "step prerequisites" },
      { kind: "step-skipped", id: "access", title: "step access" },
      { kind: "step-started", id: "core", title: "step core" },
      { kind: "step-done", id: "core", title: "step core" },
    ]);
  });

  it("changes nothing when every step is already done", async () => {
    const store = new MemoryParameterStore();
    await run(store, [step("prerequisites"), step("access")]);
    const before = store.values.get(installProgressParameterName(ENV));
    store.calls.length = 0;
    const again = [step("prerequisites"), step("access")];
    const result = await run(store, again);
    expect(result).toEqual({ status: "complete", ran: [], skipped: ["prerequisites", "access"] });
    expect(store.values.get(installProgressParameterName(ENV))).toBe(before);
    expect(store.calls.filter((call) => call.op === "put" && call.name !== LOCK)).toEqual([]);
    expect(again.every((s) => s.run.mock.calls.length === 0)).toBe(true);
  });

  it("does not record a failed step, runs nothing after it, and releases the lock", async () => {
    const store = new MemoryParameterStore();
    const later = step("core");
    await expect(run(store, [step("access", async () => { throw agentXError("CONFIG_INVALID", "bad input"); }), later])).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect((await readInstallProgress(store, ENV))?.steps.access).toBeUndefined();
    expect(later.run).not.toHaveBeenCalled();
    expect(store.values.has(LOCK)).toBe(false);
  });

  it("records a waiting step, stops, and runs it again next time", async () => {
    const store = new MemoryParameterStore();
    const later = step("slack-service");
    const result = await run(store, [step("slack-app", async () => ({ status: "waiting", message: "waiting for a Slack admin" })), later]);
    expect(result).toEqual({ status: "waiting", step: "slack-app", message: "waiting for a Slack admin", ran: [], skipped: [] });
    expect((await readInstallProgress(store, ENV))?.steps["slack-app"]).toEqual({ status: "waiting", at: "2026-09-27T00:00:00.000Z", note: "waiting for a Slack admin" });
    expect(later.run).not.toHaveBeenCalled();
    const retried = step("slack-app");
    expect(await run(store, [retried, step("slack-service")])).toMatchObject({ status: "complete", ran: ["slack-app", "slack-service"] });
    expect(retried.run).toHaveBeenCalledOnce();
  });

  it("turns expired AWS credentials into AUTH_REQUIRED that says how to refresh and that init resumes", async () => {
    const store = new MemoryParameterStore();
    const expired = Object.assign(new Error("The security token included in the request is expired"), { name: "ExpiredTokenException" });
    await expect(run(store, [step("core", async () => { throw expired; })])).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      message: expect.stringContaining('init stopped at "step core": AWS credentials missing or expired') as unknown,
    });
  });

  it("writes github facts the moment a step records them, so a crash afterwards keeps them", async () => {
    const store = new MemoryParameterStore();
    const github = { account: "acme", appId: "42", slug: "agentx-acme", privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbC" };
    const crashing: InitStep<unknown> = {
      id: "github-app",
      title: "GitHub App",
      async run(_context, progress) {
        await progress.update({ github });
        throw new Error("terminal closed");
      },
    };
    await expect(run(store, [crashing])).rejects.toThrow("terminal closed");
    expect((await readInstallProgress(store, ENV))?.github).toEqual(github);
  });

  it("holds the lock as init while steps run", async () => {
    const store = new MemoryParameterStore();
    await run(store, [step("access", async () => {
      expect(JSON.parse(store.values.get(LOCK)!)).toMatchObject({ holder: HOLDER, command: "init" });
      return { status: "done" };
    })]);
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

  // F14: agentx init saves its answers here, so two first runs cannot overwrite each other's.
  it("runs beforeSteps under the lock, before any step, and runs no step when it fails", async () => {
    const store = new MemoryParameterStore();
    const order: string[] = [];
    const access = step("access", async () => { order.push("access"); return { status: "done" }; });
    await run(store, [access], {
      beforeSteps: async () => {
        expect(JSON.parse(store.values.get(LOCK)!)).toMatchObject({ holder: HOLDER, command: "init" });
        order.push("before");
      },
    });
    expect(order).toEqual(["before", "access"]);

    const failing = new MemoryParameterStore();
    const never = step("access");
    await expect(run(failing, [never], { beforeSteps: async () => { throw agentXError("CONFIG_INVALID", "answers changed meanwhile"); } })).rejects.toThrow("answers changed meanwhile");
    expect(never.run).not.toHaveBeenCalled();
    expect(failing.values.has(LOCK)).toBe(false);
    expect(failing.values.has(installProgressParameterName(ENV))).toBe(false);
  });
});

describe("step names", () => {
  it("spec 048 FR-080: every step is named in plain words, from the journey's one list", () => {
    expect(initSteps({ github: fakeGitHubApi(), slack: fakeSlackApi() }).map((step) => [step.id, step.title]))
      .toEqual(INIT_STEP_IDS.map((id) => [id, STEP_PLAN[id].title]));
  });
});
