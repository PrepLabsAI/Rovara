// TIER-GROWTH-MERGE: where a task stands while a change that grew still owes the higher level's reviews (the pill and the status line), in the one words table. In review while they run, Needs you when a person has to act,
// and never "Ready to merge" while the merge is owed. The reader of what is owed is `growthOwedOf` (tested with the gate in change-tier-merge-gate.test.ts).
import { describe, expect, it } from "vitest";
import { GROWTH_WORDS } from "../../packages/contracts/src/index.js";
import { stateOf, type StandingFacts } from "../../packages/broker/src/core/task-view/state.js";

const workflow = { stage: "WAIT_FOR_MERGE", state: "WAITING", path: "QUICK", definitionVersion: "1.1.0", revision: 9 } as StandingFacts["workflow"];
const facts = (extra: Partial<StandingFacts> = {}): StandingFacts => ({ workflow, closed: false, budgetPaused: false, failedPrepare: false, needsPerson: false, planRevisionsUsed: 0, failedChecks: false, ...extra });
const reviewing = { level: "standard", state: "reviewing", words: GROWTH_WORDS.running("standard"), reason: GROWTH_WORDS.runningReason("standard"), next: GROWTH_WORDS.nextRunning } as const;
const stuck = { level: "risky", state: "needs_you", words: GROWTH_WORDS.couldNotRun("risky"), reason: GROWTH_WORDS.couldNotRun("risky"), next: GROWTH_WORDS.nextNeedsYou } as const;

describe("the standing of a task whose grown change owes the higher level's reviews", () => {
  it("is In review with the fixed reason while they run, and never 'Ready to merge'", () => {
    const state = stateOf(facts({ growthOwed: reviewing }));
    expect(state.pill).toBe("in_review");
    expect(state.status).toEqual({ state: "checking", reason: "This change grew, so Rovara is running the standard checks", next: GROWTH_WORDS.nextRunning });
    expect(GROWTH_WORDS.running("standard")).toBe("This change grew to standard. Rovara is running the standard reviews before it can merge.");
  });

  it("is a decision (Needs you for the owner) with the reason when they cannot run or found problems", () => {
    const state = stateOf(facts({ growthOwed: stuck, needsPerson: true }));
    expect(state.pill).toBe("decision");
    expect(state.status).toEqual({ state: "needs_you", reason: GROWTH_WORDS.couldNotRun("risky"), next: GROWTH_WORDS.nextNeedsYou });
    expect(state.step?.state).toBe("needs");
  });

  it("is unchanged for a change that owes nothing: In review and ready to merge", () => {
    const state = stateOf(facts());
    expect(state.pill).toBe("in_review");
    expect(state.status.state).toBe("ready_to_merge");
  });

  it("says nothing of growth once the task is merged or closed", () => {
    expect(stateOf(facts({ workflow: { ...workflow!, stage: "MERGED", state: "COMPLETE", outcome: "MERGED" }, growthOwed: reviewing })).pill).toBe("merged");
    expect(stateOf(facts({ closed: true, growthOwed: reviewing })).pill).toBe("closed");
  });
});

describe("the words of a grown change", () => {
  it("fit the status line's limits, name the level, and never carry a file count", () => {
    for (const level of ["standard", "risky"]) {
      for (const words of [GROWTH_WORDS.running(level), GROWTH_WORDS.runningReason(level), GROWTH_WORDS.foundProblems(level), GROWTH_WORDS.couldNotRun(level), GROWTH_WORDS.cap(level), GROWTH_WORDS.earlier(level)]) {
        expect(words.length, words).toBeLessThanOrEqual(200);
        expect(words).toContain(level);
        expect(words).not.toMatch(/\d/u);
      }
    }
  });
});
