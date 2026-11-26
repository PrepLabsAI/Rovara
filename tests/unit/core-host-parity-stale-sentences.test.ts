import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, agentXError } from "@agentx/contracts";
import { readFileSync } from "node:fs";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { runParityTaskAction } from "../../packages/broker/src/core-host/parity-task-actions.js";
import { uuidFrom } from "../../packages/broker/src/core/build-step/start.js";
import { commitWorkflow } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import type { ApplicationE2ESeams } from "../../packages/broker/src/core/e2e/application-seams.js";
import type { TaskTestEnvironment } from "../../packages/broker/src/core/test-env/seam.js";
import { definition } from "../support/task-flow-harness.js";
import { blockedReview, code, operationsOf, report, seed, stateOf, taskOf, TASK_ID } from "../support/task-actions-world.js";

// One sentence must mean one thing. "this retry is out of date; refresh the task and try again" and "the verification retry is stale; refresh the task and choose checks again"
// are final only because they were thrown before anything was written. Every refusal that comes after the retry was admitted or started (a block committed, a dispatch row resolved) says
// so in its own words, so a client can never read "nothing happened" into a retry that may already be running.
const NOW = "2026-11-10T10:00:00.000Z";
const OUT_OF_DATE = "this retry is out of date; refresh the task and try again";
const VERIFICATION_STALE = "the verification retry is stale; refresh the task and choose checks again";
const AFTER = {
  checks: "the verification retry may already have started; refresh the task and check its progress before choosing checks again",
  coding: "the coding retry may already have started; refresh the task and check its progress before trying again",
  planning: "the planning retry may already have started; refresh the task and check its progress before trying again",
  publication: "the publication retry may already have started; refresh the task and check its progress before trying again",
  review: "the review retry may already have started; refresh the task and check its progress before trying again",
} as const;

const body = (extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), instructions: "Retry the checked code", expectedRevision: 6, candidateDigest: code.digest, ...extra });
const refusedBy = (environment: string): TaskTestEnvironment => ({
  forStart: async () => ({}),
  stepPlan: async () => { throw agentXError("CONFIG_INVALID", environment); },
});
const ENVIRONMENT_REFUSAL = "the test environment cannot be built";
const messageOf = (error: unknown): string => String((error as { message?: unknown }).message).replace(/^[A-Z_]+: /u, "");
async function refusal(promise: Promise<unknown>): Promise<{ code: unknown; message: string }> {
  try { await promise; } catch (error) { return { code: (error as { code?: unknown }).code, message: messageOf(error) }; }
  throw new Error("the retry was not refused");
}

describe("the retry refusals say whether anything was written", () => {
  it("the sentences all differ", () => {
    expect(new Set([OUT_OF_DATE, VERIFICATION_STALE, ...Object.values(AFTER)]).size).toBe(7);
  });

  it.each([
    ["verification", { stage: "VERIFY" }],
    ["coding", { stage: "IMPLEMENT", candidate: undefined, verification: undefined, reviews: undefined }],
    ["planning", { stage: "PLAN", definitionVersion: "1.0.0", candidate: undefined, verification: undefined, reviews: undefined }],
  ] as const)("a %s retry at a revision the owner did not see is refused before any write, with the original sentence", async (_name, extra) => {
    const { h, caller } = await seed({ workflow: blockedReview(extra) });
    const before = await stateOf(h);
    const refused = await refusal(runParityTaskAction(h.deps, {}, caller, TASK_ID, "workflow/retry", body({ expectedRevision: 5 })));
    expect(refused).toEqual({ code: "IDEMPOTENCY_CONFLICT", message: OUT_OF_DATE });
    expect(await stateOf(h)).toEqual(before);
  });

  it("a publication retry at a revision the owner did not see is refused before any write, with the original sentence", async () => {
    const { h, caller } = await seed({ workflow: blockedReview({ stage: "PULL_REQUEST", blockReason: WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, reviews: [report("CRITIC", "PASS", []), report("SECURITY", "PASS", [])] }) });
    const before = await stateOf(h);
    const refused = await refusal(runParityTaskAction(h.deps, {}, caller, TASK_ID, "workflow/publish-retry", { requestId: randomUUID(), expectedRevision: 5 }));
    expect(refused).toEqual({ code: "IDEMPOTENCY_CONFLICT", message: OUT_OF_DATE });
    expect(await stateOf(h)).toEqual(before);
  });

  it("a verification retry the core committed and then found stale says so in its own sentence, and its effects are visible", async () => {
    const { h, caller } = await seed({ workflow: blockedReview({ stage: "VERIFY" }) });
    h.deps.testEnvironment = refusedBy(ENVIRONMENT_REFUSAL);
    const before = await stateOf(h);
    const refused = await refusal(runParityTaskAction(h.deps, {}, caller, TASK_ID, "workflow/retry", body()));
    expect(refused).toEqual({ code: "IDEMPOTENCY_CONFLICT", message: AFTER.checks });
    expect(refused.message).not.toBe(VERIFICATION_STALE);
    expect(refused.message).not.toBe(OUT_OF_DATE);
    // The retry was applied: a re-read shows the block it wrote (revision 6 to 7).
    expect(await stateOf(h)).not.toEqual(before);
    expect((await taskOf(h)).workflow).toMatchObject({ revision: 7, state: "BLOCKED", blockReason: ENVIRONMENT_REFUSAL });
  });

  it("a coding retry the core committed and then found stale says so in its own sentence, and its effects are visible", async () => {
    const { h, caller } = await seed({ workflow: blockedReview({ stage: "IMPLEMENT", candidate: undefined, verification: undefined, reviews: undefined }) });
    h.deps.testEnvironment = refusedBy(ENVIRONMENT_REFUSAL);
    const before = await stateOf(h);
    const refused = await refusal(runParityTaskAction(h.deps, {}, caller, TASK_ID, "workflow/retry", body()));
    expect(refused).toEqual({ code: "IDEMPOTENCY_CONFLICT", message: AFTER.coding });
    expect(refused.message).not.toBe(OUT_OF_DATE);
    expect(await stateOf(h)).not.toEqual(before);
    expect((await taskOf(h)).workflow).toMatchObject({ revision: 7, state: "BLOCKED", blockReason: ENVIRONMENT_REFUSAL });
  });

  it("a planning retry the core committed and then found stale says so in its own sentence, and its effects are visible", async () => {
    const { h, caller } = await seed({ workflow: blockedReview({ stage: "PLAN", definitionVersion: "1.0.0", candidate: undefined, verification: undefined, reviews: undefined }) });
    // The first ask (the admission check) passes; the planning step's own check, made after the admission, refuses and blocks the task.
    let asked = 0;
    h.deps.access = { ...h.deps.access, checkStep: async () => (++asked === 1 ? { allowed: true } : { allowed: false, message: "the person this task runs for may no longer have it run" }) };
    const before = await stateOf(h);
    const refused = await refusal(runParityTaskAction(h.deps, {}, caller, TASK_ID, "workflow/retry", body()));
    expect(refused).toEqual({ code: "IDEMPOTENCY_CONFLICT", message: AFTER.planning });
    expect(refused.message).not.toBe(OUT_OF_DATE);
    expect(await stateOf(h)).not.toEqual(before);
    expect((await taskOf(h)).workflow).toMatchObject({ state: "BLOCKED", blockReason: "the person this task runs for may no longer have it run" });
    expect(await operationsOf(h)).toEqual([]);
  });

  it("a publication retry the core found stale after it started says so in its own sentence", async () => {
    const { h, caller } = await seed({ workflow: blockedReview({ stage: "PULL_REQUEST", blockReason: WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, reviews: [report("CRITIC", "PASS", []), report("SECURITY", "PASS", [])] }) });
    const registry = createAdapterRegistry();
    registry.register("code-host", "fake", new FakeCodeHost(new FakeHostModel({ url: definition.repositories[0]!.url, id: "1", fullName: "example/demo" })));
    h.deps.codeHosts = registry;
    // No project repository matches the candidate's, so the start settles STALE after it resolved its dispatch row.
    await h.registerProject({ ...definition, repositories: [{ ...definition.repositories[0]!, name: "other" }] });
    const refused = await refusal(runParityTaskAction(h.deps, {}, caller, TASK_ID, "workflow/publish-retry", { requestId: randomUUID(), expectedRevision: 6 }));
    expect(refused).toEqual({ code: "IDEMPOTENCY_CONFLICT", message: AFTER.publication });
    expect(refused.message).not.toBe(OUT_OF_DATE);
  });

  it("a review retry the core found stale after it was admitted says so in its own sentence", async () => {
    // The review service throws WORKSPACE_BUSY when its start does not return STARTED (here the workspace is held), after the round was admitted.
    const { h, caller } = await seed({ workspace: { status: "BUSY", activeOperationId: "op-held" } });
    const refused = await refusal(runParityTaskAction(h.deps, {}, caller, TASK_ID, "workflow/retry", body()));
    expect(refused).toEqual({ code: "IDEMPOTENCY_CONFLICT", message: AFTER.review });
    expect(refused.message).not.toBe(OUT_OF_DATE);
    expect(refused.message).not.toBe("the review retry is stale; refresh the task and try again");
  });
});

// A request id that already committed is answered as a replay BEFORE the revision comparisons, so the pre-write sentences keep meaning only "nothing was written".
describe("a replay of a committed retry is answered as a replay, never as stale", () => {
  it("an e2e checks retry (its operation runs under a derived id) answers its replay with no new write and no second paid round", async () => {
    const e2e = { required: true, contractDigest: "a".repeat(64), policyDigest: "b".repeat(64), bundleDigest: "c".repeat(64), executionPlanDigest: "d".repeat(64), currentGroupRunIds: [], resultRefs: [] };
    const { h, caller } = await seed({ workflow: blockedReview({ stage: "VERIFY", e2e }) });
    let rounds = 0;
    // What the real e2e retry commits (application-rounds.ts): the retry's request id as a UUID, the revision moved, the round under its own derived operation id.
    const retry: ApplicationE2ESeams["rounds"]["retry"] = async (task, input) => {
      rounds += 1;
      const workflow = task.workflow;
      const next = { ...workflow, revision: workflow.revision + 1, state: "WAITING" as const, updatedAt: NOW,
        verificationRetries: [...(workflow.verificationRetries ?? []), { requestId: uuidFrom(input.requestId), actorId: input.actorId, at: NOW, selectedOptionalCheckIds: [], selectedProposedCheckIds: [] }] };
      await commitWorkflow(h.deps, task, next);
      return "STARTED";
    };
    h.deps.applicationE2E = { rounds: { retry } } as unknown as ApplicationE2ESeams;
    const request = body();
    await runParityTaskAction(h.deps, {}, caller, TASK_ID, "workflow/retry", request);
    expect(rounds).toBe(1);
    expect((await taskOf(h)).workflow).toMatchObject({ revision: 7 });
    const after = await stateOf(h);
    await runParityTaskAction(h.deps, {}, caller, TASK_ID, "workflow/retry", request);
    expect(rounds).toBe(1);
    expect(await stateOf(h)).toEqual(after);
  });

  it("a checks retry whose test plan was refused (it wrote a block) answers its replay as a replay, and writes nothing", async () => {
    const { h, caller } = await seed({ workflow: blockedReview({ stage: "VERIFY" }) });
    h.deps.testEnvironment = refusedBy(ENVIRONMENT_REFUSAL);
    const request = body();
    expect(await refusal(runParityTaskAction(h.deps, {}, caller, TASK_ID, "workflow/retry", request))).toEqual({ code: "IDEMPOTENCY_CONFLICT", message: AFTER.checks });
    const after = await stateOf(h);
    expect((await taskOf(h)).workflow).toMatchObject({ revision: 7, state: "BLOCKED", blockReason: ENVIRONMENT_REFUSAL });
    await runParityTaskAction(h.deps, {}, caller, TASK_ID, "workflow/retry", request);
    expect(await stateOf(h)).toEqual(after);
    expect(await operationsOf(h)).toEqual([]);
    // Only a different request id at the old revision is a pre-write refusal.
    const refused = await refusal(runParityTaskAction(h.deps, {}, caller, TASK_ID, "workflow/retry", body()));
    expect(refused).toEqual({ code: "IDEMPOTENCY_CONFLICT", message: OUT_OF_DATE });
    expect(await stateOf(h)).toEqual(after);
  });

  it("a publication retry that committed answers its replay as a replay: no second operation, no new write", async () => {
    const { h, caller } = await seed({ workflow: blockedReview({ stage: "PULL_REQUEST", blockReason: WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, reviews: [report("CRITIC", "PASS", []), report("SECURITY", "PASS", [])] }) });
    const registry = createAdapterRegistry();
    registry.register("code-host", "fake", new FakeCodeHost(new FakeHostModel({ url: definition.repositories[0]!.url, id: "1", fullName: "example/demo" })));
    h.deps.codeHosts = registry;
    await h.registerProject({ ...definition, repositories: [{ ...definition.repositories[0]!, host: { kind: "fake" } }] });
    const request = { requestId: randomUUID(), expectedRevision: 6 };
    await runParityTaskAction(h.deps, {}, caller, TASK_ID, "workflow/publish-retry", request);
    const published = (await operationsOf(h)).filter((operation) => operation.kind === "publish");
    expect(published).toHaveLength(1);
    expect((await taskOf(h)).workflow?.revision).toBe(7);
    const after = await stateOf(h);
    await runParityTaskAction(h.deps, {}, caller, TASK_ID, "workflow/publish-retry", request);
    expect(await stateOf(h)).toEqual(after);
    expect((await operationsOf(h)).filter((operation) => operation.kind === "publish")).toHaveLength(1);
  });

  it("review: a publish-retry at the seen revision is NOT a replay once the candidate changed (no silent success)", async () => {
    const { h, caller } = await seed({ workflow: blockedReview({ stage: "PULL_REQUEST", blockReason: WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, reviews: [report("CRITIC", "PASS", []), report("SECURITY", "PASS", [])] }) });
    const registry = createAdapterRegistry();
    registry.register("code-host", "fake", new FakeCodeHost(new FakeHostModel({ url: definition.repositories[0]!.url, id: "1", fullName: "example/demo" })));
    h.deps.codeHosts = registry;
    await h.registerProject({ ...definition, repositories: [{ ...definition.repositories[0]!, host: { kind: "fake" } }] });
    await runParityTaskAction(h.deps, {}, caller, TASK_ID, "workflow/publish-retry", { requestId: randomUUID(), expectedRevision: 6 });
    const task = await taskOf(h);
    await commitWorkflow(h.deps, task, { ...task.workflow!, candidate: { ...task.workflow!.candidate!, digest: "e".repeat(64) } });
    const after = await stateOf(h);
    const refused = await refusal(runParityTaskAction(h.deps, {}, caller, TASK_ID, "workflow/publish-retry", { requestId: randomUUID(), expectedRevision: 6 }));
    expect(refused.code).not.toBeUndefined();
    expect(await stateOf(h)).toEqual(after);
  });
});

// The legacy AWS handler (developer-tasks.ts retryTaskWorkflow) throws the verification sentence after reads only, and no HTTP route reaches it any more (the core's parity route serves /workflow/retry), so it
// cannot be driven here without a race. Its words are pinned instead: exactly one pre-write site keeps the sentence, the core route no longer throws it, and the two out-of-date sites there stay in front of the write.
describe("only the pre-write sites keep the original sentences", () => {
  const source = (path: string): string => readFileSync(new URL(`../../packages/broker/src/${path}`, import.meta.url), "utf8");
  const count = (text: string, needle: string): number => text.split(needle).length - 1;
  it("the verification sentence is thrown nowhere any more: its one site, the legacy handler's read-only check, was deleted with the old workflow engine (D1-2), and the core route never threw it", () => {
    expect(count(source("aws/developer-tasks.ts"), VERIFICATION_STALE)).toBe(0);
    expect(count(source("core-host/parity-task-actions.ts"), VERIFICATION_STALE)).toBe(0);
  });

  it("the core route throws the out-of-date sentence only from its two revision comparisons", () => {
    const lines = source("core-host/parity-task-actions.ts").split("\n").filter((line) => line.includes(OUT_OF_DATE));
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toMatch(/Revision !== workflow\.revision\) stale\(|expectedRevision !== workflow\.revision\) stale\(/u);
  });
});
