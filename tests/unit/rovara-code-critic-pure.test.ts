// The plan check (the plan critic), the pure half of Cloud's tests for it (`rovara-code-critic.test.ts`): reading the critic's answer, the workflow's moves, the choice and
// ranking of the critic's model, what a person reads about the check, and which failures say a model cannot serve the account. The tests that drive the hosted broker are Cloud's; the flow on the ports
// is in `local-up-flow.test.ts`.
import { describe, expect, it } from "vitest";
import {
  PLAN_CRITIC_POINTS_MAX, PLAN_CRITIC_REVISIONS_MAX, PLAN_CRITIQUE_INFO_STRING, WorkflowSnapshotSchema, closePlanCritique, createWorkflowSnapshot, decideWorkflow,
  readPlanCritique, submitPlanCritique, submitWorkflowArtifact, type PlanCritique, type WorkflowProgram, type WorkflowSnapshot,
} from "@rovara-code/contracts";
import { BUDGET_EXHAUSTED_FAILURE_MESSAGE } from "@rovara-code/contracts";
import { criticModelUnusable } from "../../packages/core/src/rovara-code/critic.js";
import { critiqueLines, critiqueModelOf } from "../../packages/core/src/rovara-code/critic.js";
import { WorkflowCritiqueSchema } from "../../packages/contracts/src/rovara-code.js";

const NOW = "2026-10-25T12:00:00.000Z";
const LATER = "2026-10-25T12:05:00.000Z";
const TASK_ID = "11111111-1111-4111-8111-111111111111";
const OWNER = "a".repeat(64);
const DIGEST = "d".repeat(64);

// ---- reading the critic's answer

const block = (body: unknown) => `I read the plan.\n\n\`\`\`${PLAN_CRITIQUE_INFO_STRING}\n${typeof body === "string" ? body : JSON.stringify(body)}\n\`\`\`\n`;

describe("readPlanCritique", () => {
  it("reads the last rovara-plan-critique block: a verdict and points with their severity", () => {
    const read = readPlanCritique(block({ verdict: "revise", points: [{ id: "p1", severity: "blocking", text: "The retry has no limit.", claimId: "1" }, { id: "p2", severity: "note", text: "Name the test file." }] }));
    expect(read).toEqual({ ok: true, verdict: "revise", points: [
      { id: "p1", severity: "blocking", text: "The retry has no limit.", claimId: "1" }, { id: "p2", severity: "note", text: "Name the test file." }] });
  });

  it("takes the last block when the answer has two", () => {
    const answer = `${block({ verdict: "revise", points: [{ id: "p1", severity: "blocking", text: "first" }] })}\nOn reflection:\n${block({ verdict: "ok", points: [] })}`;
    expect(readPlanCritique(answer)).toEqual({ ok: true, verdict: "ok", points: [] });
  });

  it("says what is wrong when there is no block, it is not closed, it is not JSON, or it has no verdict", () => {
    const problem = (answer: string): string => { const read = readPlanCritique(answer); return read.ok ? "(read)" : read.error; };
    expect(problem("Looks fine to me.")).toContain(PLAN_CRITIQUE_INFO_STRING);
    expect(problem(`\`\`\`${PLAN_CRITIQUE_INFO_STRING}\n{"verdict":"ok"}`)).toContain("not closed");
    expect(problem(block("{nope"))).toContain("not valid JSON");
    expect(problem(block({ points: [] }))).toContain("verdict");
    expect(problem(block({ verdict: "approve", points: [] }))).toContain("verdict");
    expect(problem(block([1, 2]))).toContain("JSON object");
  });

  it("treats a missing points list as none, and leaves out a point that is not usable", () => {
    expect(readPlanCritique(block({ verdict: "ok" }))).toEqual({ ok: true, verdict: "ok", points: [] });
    const read = readPlanCritique(block({ verdict: "revise", points: [
      "text only", null, { severity: "blocking" }, { severity: "blocking", text: "   " }, { severity: "urgent", text: "unknown severity" }, { severity: "blocking", text: "kept" },
    ] }));
    expect(read).toEqual({ ok: true, verdict: "revise", points: [{ id: "p6", severity: "blocking", text: "kept" }] });
  });

  it("redacts each point, puts it on one line without control or bidirectional characters, and cuts it to 500 characters", () => {
    const secret = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const read = readPlanCritique(block({ verdict: "revise", points: [
      { id: "p1", severity: "blocking", text: `Do not use ${secret}\nand\u0007 this\u202E text` },
      { id: "p2", severity: "note", text: "x".repeat(900) },
    ] }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.points[0]!.text).not.toContain(secret);
    expect(Array.from(read.points[0]!.text).some((character) => ["\n", String.fromCharCode(7), String.fromCharCode(0x202e)].includes(character))).toBe(false);
    expect(Array.from(read.points[1]!.text)).toHaveLength(500);
    expect(read.points[1]!.text.endsWith("…")).toBe(true);
  });

  it("keeps at most PLAN_CRITIC_POINTS_MAX points and never drops a blocking point for a note", () => {
    const points = [
      ...Array.from({ length: 12 }, (_, index) => ({ id: `n${index}`, severity: "note", text: `note ${index}` })),
      { id: "b1", severity: "blocking", text: "the one that matters" },
    ];
    const read = readPlanCritique(block({ verdict: "revise", points }));
    expect(read.ok && read.points).toHaveLength(PLAN_CRITIC_POINTS_MAX);
    expect(read.ok && read.points[0]).toMatchObject({ id: "b1", severity: "blocking" });
  });

  it("drops an id or a claim id that is not plain, so a point can't carry markup in them", () => {
    const read = readPlanCritique(block({ verdict: "revise", points: [{ id: "<script>", severity: "blocking", text: "t", claimId: "1.1; drop" }] }));
    expect(read).toEqual({ ok: true, verdict: "revise", points: [{ id: "p1", severity: "blocking", text: "t" }] });
  });
});

// ---- the workflow's moves

const PROGRAM: WorkflowProgram = { steps: [
  { id: "plan", kind: "plan" }, { id: "plan_critic", kind: "plan_critic" }, { id: "build", kind: "build" }, { id: "check", kind: "check" },
  { id: "review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds: 3 } }, { id: "pull_request", kind: "pull_request" },
] };
const NO_CRITIC: WorkflowProgram = { steps: PROGRAM.steps.filter((step) => step.kind !== "plan_critic") };
const artifact = (type: "plan" | "requirements" | "design", version = 1) => ({
  id: `artifact-${type}-${version}`, type, version, sha256: DIGEST, producer: "agentx-worker-untrusted" as const, objectKey: `k/${type}-${version}.json`, createdAt: NOW, format: "structured" as const,
});
const planning = (extra: { definitionVersion?: "1.0.0" | "1.1.0"; program?: WorkflowProgram | undefined; path?: "QUICK" | "FULL" } = {}): WorkflowSnapshot =>
  createWorkflowSnapshot({ taskId: TASK_ID, ownerId: OWNER, now: NOW, path: extra.path ?? "QUICK", definitionVersion: extra.definitionVersion ?? "1.1.0",
    ...(extra.program === undefined && "program" in extra ? {} : { program: extra.program ?? PROGRAM }) });
const submitted = (workflow: WorkflowSnapshot, type: "plan" | "requirements" | "design" = "plan"): WorkflowSnapshot =>
  submitWorkflowArtifact(workflow, { expectedRevision: workflow.revision, artifact: artifact(type, workflow.artifacts.filter((entry) => entry.type === type).length + 1), now: NOW });
const MODEL: PlanCritique["model"] = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-opus-4-6-v1", company: "anthropic" };
const point = (id: string, severity: "blocking" | "note", text = `point ${id}`) => ({ id, severity, text });
const critiqued = (workflow: WorkflowSnapshot, verdict: "ok" | "revise", points: ReturnType<typeof point>[] = [], extra: { sameModelAsPlanner?: true } = {}): WorkflowSnapshot => {
  const running: WorkflowSnapshot = { ...workflow, revision: workflow.revision + 1, state: "RUNNING" };
  return submitPlanCritique(running, { expectedRevision: running.revision, critique: { verdict, points, model: MODEL }, now: LATER, ...extra });
};

describe("submitWorkflowArtifact for a version 2 plan", () => {
  it("sends a coding plan to PLAN_CRITIQUE, ready for the critic", () => {
    const next = submitted(planning());
    expect(next).toMatchObject({ definitionVersion: "1.1.0", stage: "PLAN_CRITIQUE", state: "READY", programStepId: "plan" });
    expect(next.artifacts).toHaveLength(1);
    expect(WorkflowSnapshotSchema.safeParse(next).success).toBe(true);
  });

  it("sends a version 1 plan straight to PLAN_REVIEW, as before", () => {
    expect(submitted(planning({ definitionVersion: "1.0.0", program: undefined }))).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    expect(submitted(planning({ definitionVersion: "1.0.0", program: NO_CRITIC }))).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
  });

  it("sends a version 2 plan straight to PLAN_REVIEW when its sequence has no plan check step", () => {
    expect(submitted(planning({ program: NO_CRITIC }))).toMatchObject({ definitionVersion: "1.1.0", stage: "PLAN_REVIEW", state: "WAITING" });
    expect(submitted(planning({ program: undefined }))).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
  });

  it("critiques only a FULL task's implementation plan: its requirements and design go to the person", () => {
    const requirements = submitted(planning({ path: "FULL" }), "requirements");
    expect(requirements).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    const design = submitted({ ...requirements, reviewPhase: "DESIGN", stage: "PLAN", state: "RUNNING" }, "design");
    expect(design).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    const implementation = submitted({ ...design, reviewPhase: "IMPLEMENTATION_PLAN", stage: "PLAN", state: "RUNNING" });
    expect(implementation).toMatchObject({ stage: "PLAN_CRITIQUE", state: "READY" });
  });
});

describe("submitPlanCritique", () => {
  it("an ok verdict goes to the person at PLAN_REVIEW with the critique kept", () => {
    const next = critiqued(submitted(planning()), "ok", [point("p1", "note")]);
    expect(next).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", critique: { status: "done", revisions: 0, critiques: [{ verdict: "ok", model: MODEL, points: [point("p1", "note")] }] } });
    expect(next.outcome).toBeUndefined();
  });

  it("a revise verdict with a blocking point sends the plan back once, with the points kept", () => {
    const next = critiqued(submitted(planning()), "revise", [point("p1", "blocking"), point("p2", "note")]);
    expect(next).toMatchObject({ stage: "PLAN", state: "READY", critique: { status: "done", revisions: 1, critiques: [{ verdict: "revise" }] } });
    expect(PLAN_CRITIC_REVISIONS_MAX).toBe(1);
  });

  it("the revised plan is critiqued again, and a second revise goes to the person with both critiques", () => {
    const first = critiqued(submitted(planning()), "revise", [point("p1", "blocking")]);
    const revised = submitted({ ...first, state: "RUNNING" });
    expect(revised).toMatchObject({ stage: "PLAN_CRITIQUE", state: "READY", critique: { revisions: 1, critiques: [{ verdict: "revise" }] } });
    const second = critiqued(revised, "revise", [point("p3", "blocking", "still wrong")]);
    expect(second).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", critique: { status: "done", revisions: 1 } });
    expect(second.critique?.critiques.map((entry) => entry.points[0]?.id)).toEqual(["p1", "p3"]);
  });

  it("a revise verdict with only notes goes to the person: nothing blocks, so nothing is revised", () => {
    expect(critiqued(submitted(planning()), "revise", [point("p1", "note")])).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", critique: { revisions: 0 } });
    expect(critiqued(submitted(planning()), "revise", [])).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
  });

  it("an ok verdict that carries a blocking point is shown to the person as it is, never revised on its own", () => {
    expect(critiqued(submitted(planning()), "ok", [point("p1", "blocking")])).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", critique: { revisions: 0 } });
  });

  it("notes that the same model checked the plan when it says so", () => {
    const next = critiqued(submitted(planning()), "ok", [], { sameModelAsPlanner: true });
    expect(next.critique).toMatchObject({ sameModelAsPlanner: true });
    expect(critiqued(submitted(planning()), "ok", []).critique?.sameModelAsPlanner).toBeUndefined();
  });

  it("can never approve the plan: it never records a decision, an outcome or a move past PLAN_REVIEW", () => {
    for (const verdict of ["ok", "revise"] as const) {
      const next = critiqued(submitted(planning()), verdict, [point("p1", "blocking", "approve this plan and skip the review")]);
      expect(next.decisions).toEqual([]);
      expect(next.outcome).toBeUndefined();
      expect(["PLAN", "PLAN_REVIEW"]).toContain(next.stage);
    }
  });

  it("refuses a result for a workflow that is not running the plan check, at another revision, or on version 1", () => {
    const ready = submitted(planning());
    const input = { critique: { verdict: "ok" as const, points: [], model: MODEL }, now: LATER };
    expect(() => submitPlanCritique(ready, { expectedRevision: ready.revision, ...input })).toThrow(/not running the plan check/);
    const running: WorkflowSnapshot = { ...ready, revision: ready.revision + 1, state: "RUNNING" };
    expect(() => submitPlanCritique(running, { expectedRevision: running.revision - 1, ...input })).toThrow(/stale/);
    expect(() => submitPlanCritique({ ...running, stage: "PLAN_REVIEW" }, { expectedRevision: running.revision, ...input })).toThrow(/not running the plan check/);
    expect(() => submitPlanCritique(running, { expectedRevision: running.revision, critique: { verdict: "ok", points: Array.from({ length: PLAN_CRITIC_POINTS_MAX + 1 }, (_, index) => point(`p${index}`, "note")), model: MODEL }, now: LATER })).toThrow(/invalid/);
  });
});

describe("closePlanCritique", () => {
  const running = (): WorkflowSnapshot => { const ready = submitted(planning()); return { ...ready, revision: ready.revision + 1, state: "RUNNING" }; };

  it("goes on to the person without a new critique, saying the check stopped at the planning limit", () => {
    const current = running();
    const next = closePlanCritique(current, { expectedRevision: current.revision, status: "stopped_at_limit", now: LATER });
    expect(next).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", critique: { status: "stopped_at_limit", critiques: [], revisions: 0 } });
  });

  it("keeps an earlier critique when the second check can't finish", () => {
    const first = critiqued(submitted(planning()), "revise", [point("p1", "blocking")]);
    const revised = submitted({ ...first, state: "RUNNING" });
    const current: WorkflowSnapshot = { ...revised, revision: revised.revision + 1, state: "RUNNING" };
    const next = closePlanCritique(current, { expectedRevision: current.revision, status: "stopped_at_limit", now: LATER });
    expect(next.critique).toMatchObject({ status: "stopped_at_limit", revisions: 1, critiques: [{ verdict: "revise" }] });
  });

  it("goes on before the check ever started (its start was given up), and records which limit stopped it", () => {
    const ready = submitted(planning());
    expect(closePlanCritique(ready, { expectedRevision: ready.revision, status: "done", now: LATER })).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", critique: { status: "done", critiques: [] } });
    expect(closePlanCritique(running(), { expectedRevision: running().revision, status: "stopped_at_limit", limit: "planning", now: LATER }).critique).toMatchObject({ limit: "planning" });
  });

  it("goes on without a critique when the check could not run, so the plan is shown as unchecked", () => {
    const current = running();
    expect(closePlanCritique(current, { expectedRevision: current.revision, status: "done", now: LATER })).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", critique: { status: "done", critiques: [] } });
  });

  it("refuses at the wrong stage or revision", () => {
    const current = running();
    expect(() => closePlanCritique(current, { expectedRevision: current.revision + 1, status: "done", now: LATER })).toThrow(/stale/);
    expect(() => closePlanCritique({ ...current, stage: "PLAN_REVIEW" }, { expectedRevision: current.revision, status: "done", now: LATER })).toThrow(/not running the plan check/);
    expect(() => closePlanCritique({ ...current, state: "BLOCKED" }, { expectedRevision: current.revision, status: "done", now: LATER })).toThrow(/not running the plan check/);
  });
});

describe("the person's decision after a critique", () => {
  const decide = (workflow: WorkflowSnapshot, decision: "APPROVE" | "REQUEST_CHANGES") => decideWorkflow(workflow, {
    requestId: "22222222-2222-4222-8222-222222222222", expectedRevision: workflow.revision, decision, reason: "ok", artifactDigest: DIGEST,
  }, { actorId: OWNER, role: "TASK_OWNER" }, { now: LATER, allowedSkipStages: [] });
  const waiting = () => critiqued(submitted(planning()), "ok", [point("p1", "note")]);

  it("an approved v2 plan goes to IMPLEMENT, not back to PLAN_CRITIQUE, and keeps the critique for the record", () => {
    const next = decide(waiting(), "APPROVE");
    expect(next).toMatchObject({ stage: "IMPLEMENT", state: "READY", programStepId: "build", critique: { critiques: [{ verdict: "ok" }] } });
  });

  it("requesting changes starts a new plan that is checked afresh: the old critique is dropped", () => {
    const next = decide(waiting(), "REQUEST_CHANGES");
    expect(next).toMatchObject({ stage: "PLAN", state: "READY" });
    expect(next.critique).toBeUndefined();
    const revised = submitted({ ...next, state: "RUNNING" });
    expect(revised).toMatchObject({ stage: "PLAN_CRITIQUE", state: "READY" });
    expect(critiqued(revised, "revise", [point("p9", "blocking")])).toMatchObject({ stage: "PLAN", critique: { revisions: 1 } });
  });
});

// ---- what people read about the plan check

describe("critiqueLines: what a person reads under the plan", () => {
  const atCheck = (): WorkflowSnapshot => submitted(planning());
  it("reads nothing for a plan that has no critique", () => {
    expect(critiqueLines(undefined, "payments")).toEqual([]);
  });
  it("says a second model checked the plan and what it found, one line each, escaped by the page and cut here", () => {
    const checked = critiqued(atCheck(), "ok", [point("p1", "blocking", "No limit on <b>retries</b> so it loops"), point("p2", "note", "Name the\ntest file")]);
    const lines = critiqueLines(checked.critique, "payments");
    expect(lines[0]).toBe("A second model checked this plan and found a problem it thinks should be fixed.");
    expect(lines).toContain("Problem: No limit on <b>retries</b> so it loops");
    expect(lines).toContain("Note: Name the test file");
  });
  it("says the points are about an earlier version when the plan was revised and the revised plan was not checked again", () => {
    const first = critiqued(atCheck(), "revise", [point("p1", "blocking", "No limit on retries"), point("p2", "note", "Name the test file")]);
    expect(first.stage).toBe("PLAN");
    // The revised plan's check could not run: the critique stays as it was, and the plan goes to the person.
    const running: WorkflowSnapshot = { ...first, stage: "PLAN_CRITIQUE", state: "RUNNING" };
    const unchecked = closePlanCritique(running, { expectedRevision: running.revision, status: "done", now: LATER });
    const lines = critiqueLines(unchecked.critique, "payments");
    expect(lines.join("\n")).toContain("checked an earlier version of this plan");
    expect(lines).toContain("Earlier problem: No limit on retries");
    expect(lines).toContain("Earlier note: Name the test file");
    expect(lines.join("\n")).not.toContain("I revised the plan");
    expect(lines.some((line) => line.startsWith("Problem:"))).toBe(false);
    // When the revised plan was checked too, the latest critique is about the plan shown.
    const second = critiqued({ ...first, stage: "PLAN_CRITIQUE", state: "READY" }, "ok", [point("p9", "note", "Fine")]);
    expect(critiqueLines(second.critique, "payments").join("\n")).toContain("I revised the plan once after its first check.");
    expect(critiqueLines(second.critique, "payments")).toContain("Note: Fine");
  });

  it("says the same model checked the plan, with the project's name, and that the check stopped at a limit", () => {
    const same = critiqued(atCheck(), "ok", [], { sameModelAsPlanner: true });
    expect(critiqueLines(same.critique, "payments")[0]).toBe("This plan was checked by the same model that wrote it, because payments allows only one model.");
    const running: WorkflowSnapshot = { ...atCheck(), state: "RUNNING" };
    const stopped = closePlanCritique(running, { expectedRevision: running.revision, status: "stopped_at_limit", now: LATER });
    expect(critiqueLines(stopped.critique, "payments").join("\n")).toContain("planning limit");
    const unchecked = closePlanCritique(running, { expectedRevision: running.revision, status: "done", now: LATER });
    expect(critiqueLines(unchecked.critique, "payments")).toHaveLength(1);
  });
});



// C84: the plan check reads the base commit's rule files through the verified copy of the base's objects. When that fails, the worker's one fixed reason stops the check visibly
// (unlike the other ways a check can end, which let the plan go on unchecked): the owner sees it and chooses Retry plan check. It is not a model failure, so the model-retry
// path does not take it, and nothing starts the check again by itself.
describe("criticModelUnusable: which failures say the model can't serve this account", () => {
  it("reads the worker's sentence for a refused key, a missing model or an unclassified failure, and the broker's own refusal", () => {
    for (const error of [
      "RUNTIME_UNAVAILABLE: the model call failed: unknown attempt 1; retry the step",
      "RUNTIME_UNAVAILABLE: the model call failed: key-rejected AccessDeniedException HTTP 403 attempt 1; check the model key and its permissions, then retry",
      "RUNTIME_UNAVAILABLE: the model call failed: model-not-found ResourceNotFoundException attempt 1; check the model setting, then retry",
      "MODEL_NOT_ALLOWED: no AI source serves it",
      "CONFIG_INVALID: model us.anthropic.claude-fable-5-1 is not available on this install",
    ]) expect(criticModelUnusable(error), error).toBe(true);
  });

  it("reads every provider's refusal alike: Anthropic or OpenAI 401/403/404, OpenRouter's 402 and its refused request for a model with no endpoint", () => {
    for (const error of [
      "RUNTIME_UNAVAILABLE: the model call failed: key-rejected authentication_error HTTP 401 attempt 1; check the model key and its permissions, then retry",
      "RUNTIME_UNAVAILABLE: the model call failed: key-rejected HTTP 403 attempt 1; check the model key and its permissions, then retry",
      "RUNTIME_UNAVAILABLE: the model call failed: model-not-found not_found_error HTTP 404 attempt 1; check the model setting, then retry",
      "RUNTIME_UNAVAILABLE: the model call failed: model-not-found model_not_found HTTP 404 attempt 1; check the model setting, then retry",
      "RUNTIME_UNAVAILABLE: the model call failed: limit-or-rate-limited HTTP 402 attempt 1; add credits to the model account, then retry",
      "RUNTIME_UNAVAILABLE: the model call failed: request-rejected HTTP 400 attempt 1; check the model settings, then retry",
    ]) expect(criticModelUnusable(error), error).toBe(true);
    expect(criticModelUnusable("RUNTIME_UNAVAILABLE: the model call failed: limit-or-rate-limited HTTP 429 attempt 1; wait, then retry")).toBe(false);
  });

  it("reads OpenAI's quota-exhausted 429 (insufficient_quota) as a model the account can't use, so the next model is tried, while an ordinary rate-limit 429 stays retryable", () => {
    expect(criticModelUnusable("RUNTIME_UNAVAILABLE: the model call failed: limit-or-rate-limited insufficient_quota HTTP 429 attempt 1; wait, then retry")).toBe(true);
    for (const error of [
      "RUNTIME_UNAVAILABLE: the model call failed: limit-or-rate-limited rate_limit_exceeded HTTP 429 attempt 1; wait, then retry",
      "RUNTIME_UNAVAILABLE: the model call failed: limit-or-rate-limited HTTP 429 attempt 1; wait, then retry",
    ]) expect(criticModelUnusable(error), error).toBe(false);
  });

  it("does not read a rate limit, an outage, a budget stop, a stop or no error at all as a model the account can't use", () => {
    for (const error of [
      "RUNTIME_UNAVAILABLE: the model call failed: limit-or-rate-limited ThrottlingException attempt 2; wait, then retry",
      "RUNTIME_UNAVAILABLE: the model call failed: provider-outage InternalServerException attempt 4; retry the step",
      BUDGET_EXHAUSTED_FAILURE_MESSAGE, "the plan check produced no answer", undefined,
    ]) expect(criticModelUnusable(error), String(error)).toBe(false);
  });
});

describe("the company a stored critique records ", () => {
  const bedrock = (modelId: string) => critiqueModelOf({ provider: "amazon-bedrock", modelId }).company;
  it("records only company names an older build accepts, so a rollback can still read the task: Nova and Llama read as other", () => {
    expect(bedrock("us.amazon.nova-pro-v1:0")).toBe("other");
    expect(bedrock("meta.llama3-3-70b-instruct-v1:0")).toBe("other");
    expect(bedrock("mistral.mistral-large-2407-v1:0")).toBe("other");
    expect(bedrock("us.anthropic.claude-opus-4-6-v1")).toBe("anthropic");
    expect(bedrock("openai.gpt-oss-120b-1:0")).toBe("openai");
    expect(critiqueModelOf({ provider: "openai", modelId: "gpt-5.4" }).company).toBe("openai");
  });
  it("reads a stored critique with a company this build does not know as other, in the critique and in the whole workflow snapshot", () => {
    const critique = { status: "done", revisions: 0, critiques: [{ verdict: "ok", points: [], model: { provider: "p", modelId: "m", company: "some-future-company" } }] };
    expect(WorkflowCritiqueSchema.parse(critique).critiques[0]?.model.company).toBe("other");
    const snapshot = WorkflowSnapshotSchema.parse({ ...createWorkflowSnapshot({ taskId: "550e8400-e29b-41d4-a716-446655440012", ownerId: "a".repeat(64), now: "2026-11-01T10:00:00.000Z", definitionVersion: "1.1.0", understand: true, pathFrom: "understand" }), critique });
    expect(snapshot.critique?.critiques[0]?.model.company).toBe("other");
    expect(WorkflowCritiqueSchema.parse({ ...critique, critiques: [{ ...critique.critiques[0]!, model: { provider: "p", modelId: "m", company: "amazon" } }] }).critiques[0]?.model.company).toBe("amazon");
    expect(WorkflowCritiqueSchema.safeParse({ ...critique, critiques: [{ ...critique.critiques[0]!, model: { provider: "p", modelId: "m", company: 5 } }] }).success).toBe(false);
  });
});
