// Opus delta review of the F2-A follow-up (56ae3f275): edges of the new stoppedByPerson fact and the decision -> needs_you status agreement.
import { describe, expect, it } from "vitest";
import { TaskStatusSchema, statusNeedsSomeone } from "@agentx/contracts";
import { stateOf, type StandingFacts, type StandingWorkflow } from "../../packages/broker/src/core/task-view/index.js";

const wf = (stage: string, state: string, extra: Record<string, unknown> = {}): StandingWorkflow => ({ stage, state, path: "QUICK", definitionVersion: "1.1.0", revision: 5, ...extra }) as StandingWorkflow;
const base: Omit<StandingFacts, "workflow"> = { closed: false, budgetPaused: false, failedPrepare: false, needsPerson: false, planRevisionsUsed: 0, failedChecks: false };

describe("stoppedByPerson never outranks an end or a money stop", () => {
  it("a closed task keeps a closed status line, not finished_run", () => {
    const state = stateOf({ ...base, workflow: wf("IMPLEMENT", "BLOCKED"), closed: true, stoppedByPerson: true });
    expect(state.pill).toBe("closed");
    expect(state.status.state).toBe("closed");
  });
  it("an answered task stays closed", () => {
    expect(stateOf({ ...base, workflow: wf("PLAN_REVIEW", "COMPLETE", { outcome: "ANSWERED" }), stoppedByPerson: true }).status.state).toBe("closed");
  });
  it("the budget pause keeps its own line", () => {
    const state = stateOf({ ...base, workflow: wf("IMPLEMENT", "RUNNING"), budgetPaused: true, stoppedByPerson: true });
    expect(state.pill).toBe("stopped");
    expect(state.status.state).toBe("paused_budget");
  });
  it("a prepare that failed keeps its own line", () => {
    expect(stateOf({ ...base, workflow: wf("UNDERSTAND", "RUNNING"), failedPrepare: true, stoppedByPerson: true }).status.state).toBe("failed");
  });
  it("a person's Stop leaves the needs-you list (the person chose it), and the line parses strictly", () => {
    const state = stateOf({ ...base, workflow: wf("REVIEW", "WAITING"), needsPerson: true, stoppedByPerson: true });
    expect(state.pill).toBe("stopped");
    expect(TaskStatusSchema.safeParse(state.status).success).toBe(true);
    expect(statusNeedsSomeone(state.status)).toBe(false);
  });
});

describe("a decision pill always carries a needs_you line, with the others' sentence", () => {
  for (const [name, workflow] of [["review findings wait", wf("REVIEW", "WAITING")], ["a feedback card waits on the pull request", wf("WAIT_FOR_MERGE", "WAITING")], ["review findings while running", wf("REVIEW", "RUNNING")]] as const) {
    it(name, () => {
      const state = stateOf({ ...base, workflow, needsPerson: true });
      expect(state.pill).toBe("decision");
      expect(state.status).toMatchObject({ state: "needs_you", reason: "a decision is waiting", nextOthers: "Waiting for the task owner." });
    });
  }
  it("without a person needed, WAIT_FOR_MERGE stays In review / ready_to_merge", () => {
    const state = stateOf({ ...base, workflow: wf("WAIT_FOR_MERGE", "WAITING") });
    expect(state.pill).toBe("in_review");
    expect(state.status.state).toBe("ready_to_merge");
  });
  it("a system wait still outranks a waiting decision (unchanged order)", () => {
    expect(stateOf({ ...base, workflow: wf("REVIEW", "WAITING"), needsPerson: true, wait: "no_machine" }).pill).toBe("waiting");
  });
});
