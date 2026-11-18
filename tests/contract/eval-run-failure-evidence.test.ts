// L4-EVS: a Not run that says why. The cause (a fixed code, one allow-listed name, a redacted tail) rides the eval round artifact, the AI evidence and the pull request line; a public view keeps the code only.
import { describe, expect, it } from "vitest";
import {
  EvalRoundArtifactSchema, EvidenceAiSchema, evalResultFromArtifact, evalNotTestedEntry, evidenceAiFromArtifact, publicEvidenceAi, readEvalRoundArtifact,
  type EvalRunDiagnostic,
} from "../../packages/contracts/src/index.js";
import { renderAiEvidence, renderPublicAi } from "../../packages/contracts/src/evidence-ai-render.js";

const digest = "a".repeat(64);
const failure = (over: Partial<EvalRunDiagnostic> = {}): EvalRunDiagnostic => ({ code: "missing_package", phase: "run", name: "yaml", exitCode: 1, tail: "Traceback (most recent call last):\nModuleNotFoundError: No module named 'yaml'", ...over });
const artifact = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, candidateDigest: digest, roundKind: "check_unsealed", evalPass: 1, outcome: "not_run", notRunReason: "eval_run_failed", runFailure: failure(),
  context: { aiChange: true, discovery: "configured", previousPasses: 0 }, excluded: [], notices: [], usage: { calls: 0, costMicros: 0 }, cache: "not_used", feedback: { notRun: true }, fixRequested: false, evalConfigured: true, ...over,
});

describe("the artifact carries a run failure only where it belongs", () => {
  it("accepts one with eval_run_failed on a not_run round; refuses it anywhere else (mutants: each consistency rule)", () => {
    expect(EvalRoundArtifactSchema.safeParse(artifact()).success).toBe(true);
    expect(readEvalRoundArtifact(artifact())?.runFailure).toMatchObject({ code: "missing_package", name: "yaml" });
    for (const bad of [
      artifact({ notRunReason: "provider_error" }),
      artifact({ outcome: "done", notRunReason: undefined, questions: undefined }),
      artifact({ roundKind: "check_sealed", outcome: "not_run", notRunReason: "eval_run_failed", privateSet: true, context: undefined, excluded: undefined, notices: undefined, usage: undefined, cache: undefined, feedback: undefined, fixRequested: undefined, evalConfigured: undefined }),
      artifact({ runFailure: failure({ tail: "x".repeat(4097) }) }),
      artifact({ runFailure: { ...failure(), code: "made_up" } }),
      artifact({ runFailure: { ...failure(), extra: 1 } }),
      artifact({ runFailure: failure({ code: "exited", name: "yaml" }) }),
      artifact({ runFailure: failure({ name: "../../etc/passwd" }) }),
      artifact({ runFailure: failure({ exitCode: 300 }) }),
    ]) expect(EvalRoundArtifactSchema.safeParse(bad).success).toBe(false);
    // A reason with no diagnostic is still fine: the fixed sentence says it.
    expect(EvalRoundArtifactSchema.safeParse(artifact({ runFailure: undefined })).success).toBe(true);
  });

  it("reads as a Not run whose sentence names the cause, and the evidence entry says the same", () => {
    const result = evalResultFromArtifact(artifact());
    expect(result).toMatchObject({ outcome: "not_run", label: "Not run" });
    expect(result.notRun).toMatchObject({ reason: "eval_run_failed", sentence: "not run: the eval couldn't import 'yaml' (missing package)" });
    expect(evalNotTestedEntry(result)?.reason).toBe("the eval couldn't import 'yaml' (missing package)");
    expect(evalNotTestedEntry(evalResultFromArtifact(artifact({ runFailure: undefined })))?.reason).toBe("the eval could not run");
  });
});

describe("the evidence and the lines", () => {
  const ai = () => evidenceAiFromArtifact(artifact(), digest)!;

  it("projects the diagnostic with an inert tail (no link, mention or image survives), and only for this reason", () => {
    const hostile = failure({ tail: "see [click](https://evil.example/x) ![i](https://evil.example/a.png) @everyone <script>alert(1)</script> #123" });
    const projected = evidenceAiFromArtifact(artifact({ runFailure: hostile }), digest)!;
    expect(EvidenceAiSchema.safeParse(projected).success).toBe(true);
    const tail = projected.eval.runFailure!.tail;
    expect(tail).not.toMatch(/https?:\/\/(?!‍)/u);
    expect(tail).not.toContain("<script>");
    expect(tail).not.toContain("![");
    expect(tail).toContain("click");
    expect(ai().eval.notRunReason).toBe("eval_run_failed");
    // An evidence record that claims a failure on a label that ran is refused.
    const done = { ...ai(), eval: { ...ai().eval, label: "No regression measured (eval)" } };
    expect(EvidenceAiSchema.safeParse(done).success).toBe(false);
    expect(EvidenceAiSchema.safeParse({ ...ai(), eval: { ...ai().eval, notRunReason: "provider_error" } }).success).toBe(false);
  });

  it("the private line names the cause and shows the redacted tail; the public line says the fixed sentence with no name, no exit code and no output", () => {
    const privateLines = renderAiEvidence(ai()).lines.join("\n");
    expect(privateLines).toContain("Eval: Not run: the eval couldn't import 'yaml' (missing package).");
    expect(privateLines).toContain("Eval output (last lines, secrets removed):");
    expect(privateLines).toContain("No module named");
    const pub = publicEvidenceAi(ai())!;
    expect(JSON.stringify(pub)).not.toContain("yaml");
    expect(JSON.stringify(pub)).not.toContain("exitCode");
    const publicLines = renderPublicAi(pub).lines.join("\n");
    expect(publicLines).toContain("Eval: Not run: the eval couldn't import a package that is not installed (missing package).");
    expect(publicLines).not.toContain("yaml");
    expect(publicLines).not.toContain("No module named");
    expect(publicLines).not.toContain("Eval output");
  });

  it("a Not run with another reason renders exactly as before (the fixed sentence, no output line)", () => {
    const plain = evidenceAiFromArtifact(artifact({ notRunReason: "provider_error", runFailure: undefined }), digest)!;
    const lines = renderAiEvidence(plain).lines.join("\n");
    expect(lines).toContain("Eval: Not run: provider error.");
    expect(lines).not.toContain("Eval output");
  });

  it("every code has a sentence a person can read, with and without a name", async () => {
    const { EVAL_RUN_FAILURE_CODES, evalRunFailureSentence } = await import("../../packages/contracts/src/index.js");
    for (const code of EVAL_RUN_FAILURE_CODES) {
      for (const named of [true, false]) {
        const sentence = evalRunFailureSentence({ code, name: "thing", exitCode: 2 }, { named });
        expect(sentence.length).toBeGreaterThan(10);
        expect(sentence).not.toMatch(/\n|undefined|null/u);
      }
    }
  });
});
