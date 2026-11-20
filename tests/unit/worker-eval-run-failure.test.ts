// L4-EVS: a failed install step or eval command carries its diagnostic from the sandbox, through the runner, to the final check, and turns the consequences of a run that could not finish into the ONE cause.
// It never replaces a stop, a budget stop or a provider's own reason.
import { describe, expect, it } from "vitest";
import type { EvalMeterCall, EvalRunDiagnostic } from "@agentx/contracts";
import { createEvalRunner, type EvalSandboxExec } from "../../packages/worker/src/verification/eval-runner.js";
import type { EvalFinalCheckPorts } from "../../packages/worker/src/verification/eval-final-check.js";
import { EvalSandboxRunFailure, diagnoseEvalFailure, runFailureOf } from "../../packages/worker/src/verification/eval-run-diagnostic.js";
import { answer } from "../support/eval-model-access.js";

const diagnostic = (): EvalRunDiagnostic => diagnoseEvalFailure({ phase: "run", exitCode: 1, output: "ModuleNotFoundError: No module named 'yaml'" });
const request = (call: Parameters<EvalFinalCheckPorts["runner"]>[0]["call"], signal = new AbortController().signal) => ({ side: "new" as const, ids: ["q1"], runs: 1 as const, call, signal });
const okCall = async (): Promise<EvalMeterCall> => ({ class: "ok", calls: 1, costMicros: 10, events: answer() });

describe("the runner passes the diagnostic on", () => {
  it("rethrows an eval failure with its diagnostic, and a plain error stays plain", async () => {
    const failing: EvalSandboxExec = { run: async () => { throw new EvalSandboxRunFailure(diagnostic()); } };
    const error = await createEvalRunner(failing)(request(okCall)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EvalSandboxRunFailure);
    expect(runFailureOf(error)).toEqual(diagnostic());
    const plain: EvalSandboxExec = { run: async () => { throw new Error("secret words from the sandbox"); } };
    const plainError = await createEvalRunner(plain)(request(okCall)).catch((e: unknown) => e) as Error;
    expect(runFailureOf(plainError)).toBeUndefined();
    expect(plainError.message).toBe("eval run failed");
  });

});
