// While automatic go-live is not enabled, a stored tier0 "auto" from ANY source is never honoured. The clamp is in `resolveLearning` (the one place every
// consumer of the settings goes through), so no reader, present or future, can bypass it.
import { afterEach, describe, expect, it } from "vitest";
import { approversRequired, resolveLearning, setAutoApplyGate } from "../../../packages/broker/src/lessons/policy.js";
import { processDraft, type ProcessDeps } from "../../../packages/broker/src/lessons/process.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, ScriptedModel, Spend, WS, PROJECT, draft, embedder, facts, settings, verifier } from "./lesson-helpers.js";

afterEach(() => setAutoApplyGate(() => true));
const raw = (value: Parameters<typeof settings>[0]) => settings({ mode: "On", ...value });

describe("the clamp in resolveLearning", () => {
  it("a stored auto becomes one while auto-apply is off, in every place it can be set; enabled, it is left alone", async () => {
    for (const value of [{ tier0Approval: "auto" as const }, { approval: { tier0: "auto" as const, tier1: "one" as const } }, { tier0Approval: "auto" as const, companyApproval: { tier0: "auto" as const } }]) {
      setAutoApplyGate(() => false);
      expect(approversRequired(0, (await resolveLearning(raw(value), WS, PROJECT)).approval)).toBe(1);
      setAutoApplyGate(() => true);
      expect(approversRequired(0, (await resolveLearning(raw(value), WS, PROJECT)).approval)).toBe(0);
    }
    setAutoApplyGate(() => false);
    expect(approversRequired(0, (await resolveLearning(raw({ tier0Approval: "two" }), WS, PROJECT)).approval)).toBe(2);
  });
  it("the gate is asked at every resolve, so switching it off takes effect at once; the default is off", async () => {
    let enabled = true;
    setAutoApplyGate(() => enabled);
    expect(approversRequired(0, (await resolveLearning(raw({ tier0Approval: "auto" }), WS, PROJECT)).approval)).toBe(0);
    enabled = false;
    expect(approversRequired(0, (await resolveLearning(raw({ tier0Approval: "auto" }), WS, PROJECT)).approval)).toBe(1);
  });
  it("a reader that fails still fails closed", async () => {
    expect((await resolveLearning({ read: async () => { throw new Error("down"); } }, WS, PROJECT)).mode).toBe("Off");
  });
  it("at settle time: a cited, corroborated fact that a stored auto would have gone live waits for a person", async () => {
    const run = async (enabled: boolean) => {
      setAutoApplyGate(() => enabled);
      const store = new InMemoryLessonStore();
      const clock = new Clock();
      const deps: ProcessDeps = {
        store, embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), audit: new Audit(), alerts: new Alerts(), now: clock.now,
        verifier: verifier("valid"), coldStartLessons: 0, facts: facts(), settings: raw({ tier0Approval: "auto" }), newId: () => "les_0001",
      };
      return (await processDraft(deps, KEY, draft({ provenance: { ...draft().provenance, sourceKinds: ["send_back"], measured: true } }))).lesson;
    };
    expect(await run(true)).toMatchObject({ status: "active" });
    expect(await run(false)).toMatchObject({ status: "pending" });
  });
});
