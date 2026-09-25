// The offline mode's scripted model: it answers every case as the case expects, so an offline run
// checks the harness, the fixtures and the real orchestrator wiring without calling a model.
import { fauxAssistantMessage, fauxToolCall, type FauxProviderHandle } from "@earendil-works/pi-ai";
import type { ActionClassifier } from "../../packages/orchestrator/src/action-gate.js";
import type { EvalCase } from "./case.js";
import type { EvalOptions } from "./runner.js";

export function expectedAnswer(evalCase: EvalCase): { tool: string; args: Record<string, unknown> } | { text: string } {
  const tool = Array.isArray(evalCase.expect.tool) ? evalCase.expect.tool[0] : evalCase.expect.tool;
  const phrase = [evalCase.expect.refusal ?? [], evalCase.expect.contains ?? []].flat()[0] ?? "";
  return tool === null || tool === undefined ? { text: `Sorry, ${phrase}.` } : { tool, args: evalCase.expect.argsSubset ?? {} };
}

/** Scripts the expected answer, named as the presentation under test offers it (legacy names in legacy mode). */
export function scriptExpectedAnswers(faux: FauxProviderHandle): NonNullable<EvalOptions["beforeRun"]> {
  return (evalCase, _run, present) => {
    const answer = expectedAnswer(evalCase);
    if ("text" in answer) {
      faux.setResponses([fauxAssistantMessage(answer.text)]);
      return;
    }
    const call = present(answer.tool, answer.args);
    faux.setResponses([fauxAssistantMessage([fauxToolCall(call.tool, call.args)], { stopReason: "toolUse" }), fauxAssistantMessage("Done.")]);
  };
}

/** Offline, the gate's classifier answers as the case expects: allow for an expected allow, ask otherwise. */
export function expectedVerdict(evalCase: EvalCase): ActionClassifier {
  return async () => ({ decision: evalCase.expect.gate === "allow" ? "allow" : "ask", reason: "offline run: answered as the case expects" });
}
