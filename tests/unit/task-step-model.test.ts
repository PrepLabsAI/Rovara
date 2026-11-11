// The model a task step is handed to a worker with: chosen once per operation, kept on it, and the same on a repeat delivery; a step with no model of its own, a design-review round and a step that is not a task
// step are left to the install's one model; a step no model fits ends with the reason in words.
import { describe, expect, it, vi } from "vitest";
import type { ModelIdentifier } from "@agentx/contracts";
import { chooseStepModel } from "../../packages/broker/src/core/task-flow/step-model.js";
import type { OperationRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { operationKey } from "../../packages/broker/src/core/task-flow/keys.js";
import type { StepChoice } from "../../packages/broker/src/core/model-selection/service.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const m = (provider: string, modelId: string): ModelIdentifier => ({ provider, modelId });
const SONNET = m("anthropic", "claude-sonnet-4-5");
const GPT = m("openai", "gpt-5");
const step = (model: ModelIdentifier, extra: Record<string, unknown> = {}): StepChoice => ({ ok: true, step: { model, thinkingLevel: null, reason: "BUILTIN_DEFAULT", sameModelAsChecked: false, route: { alias: `${model.provider}/${model.modelId}`, api: "anthropic-messages", catalog: model.modelId }, ...extra } as never });

let counter = 0;
function operation(extra: Partial<OperationRecord> = {}): OperationRecord {
  counter += 1;
  return {
    pk: `WORKSPACE#${WORKSPACE}`, sk: `OPERATION#${String(counter)}`, entityType: "OPERATION", companyId: "c", eventSequence: 0, id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`, workspaceId: WORKSPACE, kind: "task",
    requestId: "r", payloadHash: "h", status: "ACCEPTED", fence: counter, createdAt: new Date(Date.UTC(2026, 10, 10, 10, 0, counter)).toISOString(), updatedAt: "2026-11-10T10:00:00.000Z",
    dispatch: { kind: "task", payload: {} }, workflowMode: "PLAN", ...extra,
  } as unknown as OperationRecord;
}
const world = (answer: StepChoice) => {
  const store = new MemoryDocumentStore();
  const choose = vi.fn<(input: { stage: string; reference?: ModelIdentifier | undefined }) => Promise<StepChoice>>(async () => answer);
  return { store, choose, deps: { store, stepModels: { choose } } };
};

describe("the model a step is handed to a worker with", () => {
  it("is chosen for the stage of the step's workflow mode and kept as the choice to record, with the thinking level the worker is told", async () => {
    const w = world(step(GPT, { thinkingLevel: "high", reason: "COMPANY_DEFAULT" }));
    const outcome = await chooseStepModel(w.deps, operation({ workflowMode: "IMPLEMENT" }));
    expect(w.choose).toHaveBeenCalledWith({ stage: "build", reference: undefined });
    expect(outcome).toEqual({
      ok: true, fresh: true,
      choice: { stage: "build", model: GPT, route: { alias: "openai/gpt-5", api: "anthropic-messages", catalog: "gpt-5" }, reason: "COMPANY_DEFAULT", thinkingLevel: "high" },
      selection: { provider: "openai", modelId: "gpt-5", thinkingLevel: "high" },
    });
    // Without a thinking level the selection carries none (the route's own default stands).
    const plain = await chooseStepModel(world(step(SONNET)).deps, operation({ workflowMode: "PLAN" }));
    expect(plain).toMatchObject({ ok: true, selection: { provider: "anthropic", modelId: "claude-sonnet-4-5" } });
    expect((plain as { selection: object }).selection).not.toHaveProperty("thinkingLevel");
  });

  it("maps each workflow mode to its stage, and a step with no model of its own (the checks run) is left to the install's one model", async () => {
    const stages: Record<string, string | undefined> = { UNDERSTAND: "understand", PLAN: "plan", SPEC_WRITE: "plan", PLAN_CRITIQUE: "plan_check", IMPLEMENT: "build", REVIEW: "code_review", FEEDBACK_REVIEW: "pull_request", CHECKS: undefined };
    for (const [mode, stage] of Object.entries(stages)) {
      const w = world(step(SONNET));
      const outcome = await chooseStepModel(w.deps, operation({ workflowMode: mode as never }));
      if (stage === undefined) { expect(outcome).toBeUndefined(); expect(w.choose).not.toHaveBeenCalled(); } else expect(w.choose).toHaveBeenCalledWith(expect.objectContaining({ stage }));
    }
  });

  it("a repeat delivery keeps the model the operation already holds, whatever the setting says now", async () => {
    const w = world(step(GPT));
    const held = { stage: "plan" as const, model: SONNET, route: { alias: "anthropic/claude-sonnet-4-5", api: "anthropic-messages" as const, catalog: "claude-sonnet-4-5" }, reason: "BUILTIN_DEFAULT", thinkingLevel: "low" as const };
    const outcome = await chooseStepModel(w.deps, operation({ modelChoice: held }));
    expect(w.choose).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ok: true, fresh: false, choice: held, selection: { provider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: "low" } });
  });

  it("a design-review round, a step that is not a task step and an install with no per-step rule are left to the install's one model", async () => {
    const w = world(step(GPT));
    expect(await chooseStepModel(w.deps as never, operation({ designReview: {} as never }))).toBeUndefined();
    expect(await chooseStepModel(w.deps as never, operation({ dispatch: { kind: "publish", payload: {} } as never }))).toBeUndefined();
    expect(await chooseStepModel(w.deps as never, operation({ workflowMode: undefined }))).toBeUndefined();
    expect(w.choose).not.toHaveBeenCalled();
    expect(await chooseStepModel({ store: w.store }, operation())).toBeUndefined();
  });

  it("a checking step is told the model of the newest earlier operation of the step it checks, and none that never recorded one", async () => {
    const w = world(step(SONNET));
    const choice = (model: ModelIdentifier) => ({ stage: "plan" as const, model, route: { alias: "a", api: "anthropic-messages" as const, catalog: "m" }, reason: "x" });
    for (const earlier of [operation({ workflowMode: "PLAN", modelChoice: choice(GPT) }), operation({ workflowMode: "PLAN", modelChoice: choice(SONNET) }), operation({ workflowMode: "IMPLEMENT", modelChoice: choice(m("openai", "other")) }), operation({ workflowMode: "PLAN" })]) {
      await w.store.put({ item: { ...operationKey(WORKSPACE, earlier.id), ...(earlier as unknown as Record<string, never>) } });
    }
    await chooseStepModel(w.deps, operation({ workflowMode: "PLAN_CRITIQUE" }));
    // The newest PLAN operation that recorded a model is the second one (Sonnet); the later PLAN without one and the build's are not what the plan check checks.
    expect(w.choose).toHaveBeenLastCalledWith({ stage: "plan_check", reference: SONNET });
    await chooseStepModel(w.deps, operation({ workflowMode: "REVIEW" }));
    expect(w.choose).toHaveBeenLastCalledWith({ stage: "code_review", reference: m("openai", "other") });
    // A step that checks nothing is told no reference.
    await chooseStepModel(w.deps, operation({ workflowMode: "UNDERSTAND" }));
    expect(w.choose).toHaveBeenLastCalledWith({ stage: "understand", reference: undefined });
  });

  it("no model at all leaves the step to the install's one model, and any other refusal ends the step with its reason in words", async () => {
    expect(await chooseStepModel(world({ ok: false, code: "NO_MODEL", words: "No model can be called." }).deps as never, operation())).toBeUndefined();
    expect(await chooseStepModel(world({ ok: false, code: "MODEL_NOT_VERIFIED", words: "gw/m has no price, and a run limit is held." }).deps as never, operation())).toEqual({ ok: false, sentence: "gw/m has no price, and a run limit is held." });
  });
});
