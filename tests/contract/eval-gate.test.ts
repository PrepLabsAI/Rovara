// tests/contract/eval-gate.test.ts
import { describe, expect, it } from "vitest";
import { EvalCaseSchema, loadCases, loadProject, type EvalCase } from "../eval/case.js";
import { gateClassifierModel, liveGateClassifier } from "../eval/command.js";
import { scriptExpectedAnswers } from "../eval/offline.js";
import { runEvaluation, scoreRun } from "../eval/runner.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

const GATE_CASES = [
  "gate-placeholder-target", "gate-clear-create", "gate-clear-change", "gate-close-always-asks", "gate-jira-transition",
  "gate-jira-clear-edit", "gate-jira-clear-create", "gate-admin-deny",
];
const change: EvalCase = { id: "gate-check", project: "fixtures/linear-payments.yaml", prompt: "x", expect: { tool: "linear__save_issue", gate: "allow" } };

describe("gate evaluation cases (spec 014 SC-004, SC-005)", () => {
  it("accepts a gate expectation only with an expected tool, and only allow, ask or deny", () => {
    expect(EvalCaseSchema.safeParse(change).success).toBe(true);
    expect(EvalCaseSchema.safeParse({ ...change, expect: { tool: null, refusal: "no", gate: "ask" } }).success).toBe(false);
    expect(EvalCaseSchema.safeParse({ ...change, expect: { ...change.expect, gate: "maybe" } }).success).toBe(false);
  });

  it("reads a fixture's action policy", async () => {
    expect(await loadProject("fixtures/payments.yaml")).not.toHaveProperty("actionPolicy");
    expect((await loadProject("fixtures/linear-gate.yaml")).actionPolicy).toEqual({ rules: [{ tool: "delete_comment", connector: "linear", outcome: "deny", reason: "Deleting comments is turned off." }] });
  });

  it("scores the gate's decision on the first call, and only when the gate ran", () => {
    const run = { tool: "linear__save_issue", args: {}, response: "Done." };
    expect(scoreRun(change, { ...run, gate: "allow" })).toMatchObject({ gate: "allow", gateOk: true });
    expect(scoreRun(change, { ...run, gate: "ask" })).toMatchObject({ gate: "ask", gateOk: false });
    expect(scoreRun(change, { ...run, gate: null })).toMatchObject({ gate: null, gateOk: false });
    expect(scoreRun(change, run)).not.toHaveProperty("gateOk");
    expect(scoreRun({ ...change, expect: { tool: "linear__save_issue" } }, { ...run, gate: "ask" })).not.toHaveProperty("gateOk");
  });

  it("passes every gate case offline through the real gate, with its rules deciding what they settle", async () => {
    const { modelRuntime, faux } = await fauxModelRuntime();
    const cases = (await loadCases()).filter((entry) => entry.expect.gate !== undefined);
    expect(cases.map((entry) => entry.id)).toEqual(GATE_CASES);
    const report = await runEvaluation(cases, { model: FAUX_MODEL, modelRuntime, presentation: "new", repeat: 1, beforeRun: scriptExpectedAnswers(faux) });
    expect(report.summary).toMatchObject({ cases: GATE_CASES.length, passed: GATE_CASES.length, errors: 0 });
    expect(Object.fromEntries(report.cases.map((result) => [result.id, result.runs[0]!.gate]))).toEqual(Object.fromEntries(cases.map((entry) => [entry.id, entry.expect.gate])));
  }, 120_000);

  it("fails a case whose gate decides otherwise, and settles creates, destructive and administrator calls without the classifier", async () => {
    const { modelRuntime, faux } = await fauxModelRuntime();
    const cases = (await loadCases()).filter((entry) => ["gate-clear-create", "gate-clear-change", "gate-close-always-asks", "gate-admin-deny"].includes(entry.id));
    let asked = 0;
    const report = await runEvaluation(cases, {
      model: FAUX_MODEL, modelRuntime, presentation: "new", repeat: 1, beforeRun: scriptExpectedAnswers(faux),
      gateClassifier: async () => { asked += 1; return { decision: "ask", reason: "Not sure the member asked for this." }; },
    });
    // A create is told apart from a change only through the connector's item argument, which the gate case's presentation carries.
    expect(report.cases.map((result) => [result.id, result.passed, result.runs[0]!.gate])).toEqual([
      ["gate-clear-create", true, "allow"], ["gate-clear-change", false, "ask"], ["gate-close-always-asks", true, "ask"], ["gate-admin-deny", true, "deny"],
    ]);
    expect(asked).toBe(1);
  }, 60_000);

  it("reports every gate case as not applicable to the legacy presentation, which has no gate", async () => {
    const { modelRuntime, faux } = await fauxModelRuntime();
    const cases = (await loadCases()).filter((entry) => entry.expect.gate !== undefined);
    const legacy = await runEvaluation(cases, { model: FAUX_MODEL, modelRuntime, presentation: "legacy", repeat: 1, beforeRun: scriptExpectedAnswers(faux) });
    expect(legacy.notApplicable?.map((entry) => entry.id)).toEqual(GATE_CASES);
    expect(legacy.cases).toEqual([]);
  }, 60_000);

  it("gives a live run the deployment's classifier model, Claude Haiku 4.5 unless overridden", () => {
    expect(gateClassifierModel({})).toEqual({ provider: "amazon-bedrock", modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0" });
    expect(gateClassifierModel({ AGENTX_GATE_CLASSIFIER_MODEL: "us.anthropic.claude-haiku-4-5-20251001-v1:0", AGENTX_GATE_CLASSIFIER_PROVIDER: "amazon-bedrock" }))
      .toEqual({ provider: "amazon-bedrock", modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0" });
  });

  it("stops a live run at startup when its classifier model is unavailable, naming the model, and calls no model", async () => {
    const { modelRuntime } = await fauxModelRuntime();
    await expect(liveGateClassifier({ AGENTX_GATE_CLASSIFIER_PROVIDER: FAUX_MODEL.provider, AGENTX_GATE_CLASSIFIER_MODEL: "no-such-model" }, modelRuntime))
      .rejects.toThrow(`the gate classifier model ${FAUX_MODEL.provider}/no-such-model is not available; set AGENTX_GATE_CLASSIFIER_PROVIDER and AGENTX_GATE_CLASSIFIER_MODEL to a model this runtime offers`);
    await expect(liveGateClassifier({ AGENTX_GATE_CLASSIFIER_PROVIDER: FAUX_MODEL.provider, AGENTX_GATE_CLASSIFIER_MODEL: FAUX_MODEL.modelId }, modelRuntime))
      .resolves.toBeTypeOf("function");
  });
});
