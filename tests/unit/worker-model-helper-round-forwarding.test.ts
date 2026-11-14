// TE-F2 part B: `withModelHelperRound` wraps a round's `CheckRunners` and must forward EVERY member of the runners it wraps. A member it drops silently changes the round: `scopeRound` and `reportRoot` (multi-repo scoping),
// `originalCode` (before results), `prepareRound` (setup) and `kind` (how an unconfirmed stop is recorded) were once lost behind the wrapper. The members are enumerated from a fully populated fake, and the fake is typed
// `Required<CheckRunners>`, so a member added to the interface later fails the typecheck here until the fake (and so this test) holds it too.
import { describe, expect, it, vi } from "vitest";
import type { CheckRunners } from "../../packages/worker/src/verification/checks.js";
import { UNTRUSTED_MODEL_SUMMARY } from "../../packages/worker/src/model-helper-ledger.js";
import { withModelHelperRound, type ModelHelperRoundPlan, type StartedModelHelper } from "../../packages/worker/src/model-helper-round.js";

const signal = new AbortController().signal;
const helper: StartedModelHelper = { pinnedDigest: "a".repeat(64), commandEnvironment: {}, unsetEnvironment: [], readSummary: () => Promise.resolve(UNTRUSTED_MODEL_SUMMARY), stop: () => Promise.resolve() };
const plan: ModelHelperRoundPlan = { blockList: [], start: () => Promise.resolve(helper), onResult: () => undefined };

const SENTINELS = [{ sentinel: "first" }, { sentinel: "second" }, { sentinel: "third" }, { sentinel: "fourth" }];
const RESULT = { forwarded: "result" };
function populatedFake(): Required<CheckRunners> {
  const method = () => vi.fn().mockResolvedValue(RESULT);
  return {
    kind: "sandbox",
    beginCheck: vi.fn(),
    reportRoot: vi.fn(() => "/worker-owned/reports"),
    scopeRound: method(),
    originalCode: vi.fn().mockReturnValue(RESULT),
    prepareRound: method(),
    runProjectCommand: method(),
    runAgentCommand: method(),
    freshServices: method(),
    resetBetweenChecks: method(),
    endRound: method(),
  };
}

describe("withModelHelperRound forwards every member of the runners it wraps", () => {
  it("each member of a fully populated fake is present on the wrapper, and each method reaches the wrapped one and returns its result", async () => {
    const fake = populatedFake();
    const members = Object.keys(fake);
    expect(members.length).toBeGreaterThanOrEqual(10);
    const wrapped = withModelHelperRound(plan, fake);
    expect(wrapped).not.toBe(fake);
    const missing = members.filter((name) => !(name in wrapped) || (wrapped as unknown as Record<string, unknown>)[name] === undefined);
    expect(missing).toEqual([]);
    for (const name of members) {
      const original = (fake as unknown as Record<string, unknown>)[name];
      const forwarded = (wrapped as unknown as Record<string, unknown>)[name];
      if (typeof original !== "function") {
        // a plain value (`kind`) is the same value
        expect(forwarded, name).toBe(original);
        continue;
      }
      expect(typeof forwarded, name).toBe("function");
      const spy = original as ReturnType<typeof vi.fn>;
      spy.mockClear();
      // endRound last: it ends the round and clears the started helper; the other members run with it up
      if (name === "endRound") continue;
      const argsFor = name === "beginCheck" ? ["readiness:0"] : name === "runProjectCommand" ? [{ cwd: ".", executable: "node", args: [], timeoutSeconds: 1, env: {} }, signal] : name === "runAgentCommand" ? ["replay", 1000, signal] : SENTINELS;
      const result: unknown = await (forwarded as (...args: unknown[]) => unknown).apply(wrapped, argsFor);
      expect(spy, name).toHaveBeenCalledTimes(1);
      // the wrapped member's own answer comes back (reportRoot and originalCode answer directly, the rest through a promise)
      expect(result, name).toEqual(name === "beginCheck" ? undefined : name === "reportRoot" ? "/worker-owned/reports" : RESULT);
      if (name === "scopeRound") expect(spy.mock.calls[0], name).toEqual([SENTINELS[0], SENTINELS[1], expect.any(Function), SENTINELS[3]]);
      else if (name !== "runProjectCommand") expect(spy.mock.calls[0], name).toEqual(argsFor);
    }
    const end = (fake as unknown as { endRound: ReturnType<typeof vi.fn> }).endRound;
    end.mockClear();
    await wrapped.endRound?.();
    expect(end).toHaveBeenCalledTimes(1);
  });
  it("a runner object with only the two required methods wraps to the same two (no member is invented)", () => {
    const bare: CheckRunners = { runProjectCommand: () => Promise.reject(new Error("x")), runAgentCommand: () => Promise.reject(new Error("x")) };
    const wrapped = withModelHelperRound(plan, bare);
    expect(Object.keys(wrapped).sort()).toEqual(["beginCheck", "endRound", "runAgentCommand", "runProjectCommand"]);
  });
});
