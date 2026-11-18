// L4-EVP: when the change touched likely-AI code and no eval ran, the layout hands the verdict the reason. Never silent where it should speak, never loud where an eval ran or the checks are still going.
import { describe, expect, it } from "vitest";
import type { WorkflowSnapshot } from "@agentx/contracts";
import { noEvalOf } from "../../packages/broker/src/core/proof/pull-request-layout.js";

const flowWith = (...codes: string[]) => ({ flow: { tier: { reasons: codes.map((code) => ({ code, path: "deskbot/agent.py" })) } } }) as unknown as WorkflowSnapshot;
const ai = (label: string, notRunReason?: string, promptWithoutEval = false) => ({ eval: { label, ...(notRunReason === undefined ? {} : { notRunReason }) }, promptWithoutEval });

describe("noEvalOf", () => {
  it("says nothing when no AI code was touched (today's description)", () => {
    expect(noEvalOf(flowWith(), undefined, true)).toBeUndefined();
    expect(noEvalOf(flowWith("api_change"), undefined, true)).toBeUndefined();
    expect(noEvalOf({} as WorkflowSnapshot, undefined, true)).toBeUndefined();
  });
  it("AI code touched, no prompt location or prompt file, so no eval is ever asked for: known at once, even before the checks finish", () => {
    expect(noEvalOf(flowWith("ai_code_touched"), undefined, false)).toEqual({ reason: "not_a_prompt_change" });
    expect(noEvalOf(flowWith("ai_code_touched"), undefined, true)).toEqual({ reason: "not_a_prompt_change" });
  });
  it("an eval was asked for: silent while the checks are still going, 'not connected' once they finished with no eval result", () => {
    expect(noEvalOf(flowWith("eval_hint"), undefined, false)).toBeUndefined();
    expect(noEvalOf(flowWith("eval_hint"), undefined, true)).toEqual({ reason: "not_connected" });
  });
  it("an eval that ran is not 'no eval ran'", () => {
    for (const label of ["No regression measured (eval)", "Improved on eval", "Worse on eval", "newer"]) expect(noEvalOf(flowWith("eval_hint"), ai(label), true), label).toBeUndefined();
  });
  it("an eval that did not run gives its reason in fixed words", () => {
    expect(noEvalOf(flowWith("eval_hint"), ai("Not run", "no_eval_configured"), true)).toEqual({ reason: "no_eval_configured" });
    for (const why of ["not_connected", "spend_not_approved", "no_product_key"]) expect(noEvalOf(flowWith("eval_hint"), ai("Not run", why), true), why).toEqual({ reason: "not_connected" });
    expect(noEvalOf(flowWith("eval_hint"), ai("Not run", "no_changed_prompt_call"), true)).toEqual({ reason: "not_a_prompt_change" });
    expect(noEvalOf(flowWith("eval_hint"), ai("Not run", "checks_failed"), true)).toEqual({ reason: "other", detail: "the tests did not pass, so the eval was not run" });
    expect(noEvalOf(flowWith("eval_hint"), ai("Not run", "made up <b>"), true)).toEqual({ reason: "other" });
    expect(noEvalOf(flowWith("eval_hint"), ai("Not run"), true)).toEqual({ reason: "other" });
  });
  it("leaves the existing 'prompt changed and no evaluation ran' case to its own item", () => {
    expect(noEvalOf(flowWith("eval_hint"), ai("Not run", "no_eval_configured", true), true)).toBeUndefined();
  });
});
