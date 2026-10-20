import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { E2EApplicationPlanIntentSchema, E2EApplicationSelectionRecordSchema, canonicalJson, canonicalPlanJson, readCanonicalPlan } from "@agentx/contracts";
import { disposeRealCandidates } from "../support/e2e-application-candidate.js";
import { planDocument } from "../support/plan-documents.js";
import { sha, startApplicationRound, type ApplicationRound } from "../support/e2e-application-round-harness.js";
import { applicationIntentDigest, applicationRoundIntent } from "../../packages/broker/src/e2e/application-plan-approval.js";

// The plan a planner writes leaves out what its schema makes optional (portableOperationRefs, mockFixtureRefs, unavailableTargetRefs). The broker stores that plan as it is,
// and the admission it builds holds the intent derived for the round, with those members written out as empty lists. Verification must hold the stored plan to that
// admission by deriving the round's intent from the stored one, never by comparing the stored bytes' shape with the derived one.

afterEach(disposeRealCandidates);
// The broker module reads its environment when it loads, so it is imported only once the harness (which sets that environment up) has started.
const brokerModule = () => import("../../packages/broker/src/aws/broker.js");

type StoredTask = { ownerKey: string; workflow: Record<string, unknown> & { artifacts: Array<Record<string, unknown>>; decisions: Array<Record<string, unknown>>; e2e: Record<string, unknown> } };

/** The round's task as a task whose current approved plan holds `intent`, the way the broker stores a plan it approved: a new canonical artifact with its own decision. */
function taskStoring(round: ApplicationRound, intent: unknown) {
  const task = round.taskNow() as unknown as StoredTask;
  const plan = Buffer.from(canonicalPlanJson(planDocument({ title: "Check the orders services", claims: [{ id: "1", text: "The orders services answer their health checks." }], e2e: intent as never })));
  const id = randomUUID();
  const digest = sha(plan);
  const objectKey = `private/${task.ownerKey}/${round.workspaceId}/plan-documents/${id}.json`;
  round.harness.s3.objects.set(objectKey, plan.toString("utf8"));
  const approval = task.workflow.decisions.at(-1)!;
  return { ...task, workflow: { ...task.workflow,
    artifacts: [...task.workflow.artifacts, { id, type: "plan", version: 2, sha256: digest, producer: "agentx-worker-untrusted", objectKey, createdAt: new Date().toISOString(), format: "structured" }],
    decisions: [...task.workflow.decisions, { ...approval, requestId: randomUUID(), artifactDigest: digest }],
    e2e: { ...task.workflow.e2e, contractDigest: digest } } };
}

/** The intent exactly as the approved canonical plan artifact holds it. */
function storedIntentOf(round: ApplicationRound): Record<string, unknown> {
  const task = round.taskNow() as unknown as StoredTask;
  const artifact = task.workflow.artifacts.filter((entry) => entry.type === "plan").at(-1)!;
  const plan = readCanonicalPlan(round.harness.s3.objects.get(String(artifact.objectKey))!);
  return JSON.parse(JSON.stringify(plan!.e2e)) as Record<string, unknown>;
}

describe("an application plan stored the way the planner writes it", () => {
  it("is the plan the round was admitted on: the stored intent omits what the admission writes out as empty lists", async () => {
    const round = await startApplicationRound();
    const stored = storedIntentOf(round);
    // The shape of the live failure: the stored plan has no such members, the admission has them empty.
    expect(Object.keys(stored)).not.toContain("mockFixtureRefs");
    expect(Object.keys(stored)).not.toContain("portableOperationRefs");
    expect(round.admission.intent.mockFixtureRefs).toEqual([]);
    expect(round.admission.intent.portableOperationRefs).toEqual([]);
    expect(canonicalJson(stored)).not.toBe(canonicalJson(round.admission.intent));

    const broker = await brokerModule();
    const diagnostic: { reason?: string } = {};
    const valid = await broker.workflowE2EApplicationAuthorityIsValid(round.harness.brokerInput as never, round.taskNow() as never, round.candidate, round.admission, diagnostic);
    expect(diagnostic.reason).toBeUndefined();
    expect(valid).toBe(true);
  });

  it("is still refused, for the same reason as ever, when one scenario of the stored plan is not the admitted one", async () => {
    const round = await startApplicationRound();
    const stored = storedIntentOf(round) as { scenarios: Array<{ assertions: Array<Record<string, unknown>> }> };
    const changed = { ...stored, scenarios: stored.scenarios.map((scenario, index) => (index === 0
      ? { ...scenario, assertions: scenario.assertions.map((assertion) => ({ ...assertion, equals: 201 })) } : scenario)) };
    expect(canonicalJson(changed)).not.toBe(canonicalJson(stored));
    const broker = await brokerModule();
    const diagnostic: { reason?: string } = {};
    const valid = await broker.workflowE2EApplicationAuthorityIsValid(round.harness.brokerInput as never, taskStoring(round, changed) as never, round.candidate, round.admission, diagnostic);
    expect(valid).toBe(false);
    expect(diagnostic.reason).toBe("approved-plan-is-not-the-admitted-intent");
  });

  it("is also refused when the stored intent is the admitted one with a member of it written in, for the same reason", async () => {
    const round = await startApplicationRound();
    const stored = storedIntentOf(round);
    const reference = { componentId: "orders-db", requestedTargetId: (stored.requestedTargetIds as string[])[0], operationId: "list", sourcePath: "src/orders.js", sourceSha256: "a".repeat(64) };
    const broker = await brokerModule();
    const diagnostic: { reason?: string } = {};
    expect(await broker.workflowE2EApplicationAuthorityIsValid(round.harness.brokerInput as never, taskStoring(round, { ...stored, mockFixtureRefs: [reference] }) as never,
      round.candidate, round.admission, diagnostic)).toBe(false);
    expect(diagnostic.reason).toBe("approved-plan-is-not-the-admitted-intent");
  });

  it("gives approval, dispatch and verification one intent digest, which is that of the stored plan's parsed intent", async () => {
    const round = await startApplicationRound();
    const stored = storedIntentOf(round);
    const parsed = E2EApplicationPlanIntentSchema.parse(stored);
    // Approval recorded it; the round was dispatched only because dispatch derived the same one again and the admission builder held it to the record.
    const recorded = E2EApplicationSelectionRecordSchema.parse((round.workflowNow().e2e as { applicationSelection?: unknown }).applicationSelection);
    expect(recorded.intentDigest).toBe(applicationIntentDigest(parsed));
    // The admission carries the intent derived for the round, and its own digest is that intent's.
    expect(canonicalJson(round.admission.intent)).toBe(canonicalJson(applicationRoundIntent(parsed)));
    expect(round.admission.intentDigest).toBe(sha(canonicalJson(round.admission.intent)));
    // The two digests name two intents (the plan's, and the one derived for the round), which differ exactly by the members the planner left out.
    expect(round.admission.intentDigest).not.toBe(recorded.intentDigest);
    // Verification binds the stored plan to the record with the same digest and the admission to its own intent: nothing it checks here fails for this plan.
    const broker = await brokerModule();
    const diagnostic: { reason?: string } = {};
    expect(await broker.workflowE2EApplicationAuthorityIsValid(round.harness.brokerInput as never, round.taskNow() as never, round.candidate, round.admission, diagnostic)).toBe(true);
    expect(diagnostic.reason).toBeUndefined();
  });

  it("is dispatched, and verified, the same when the plan was stored with its optional members written out as empty lists", async () => {
    const round = await startApplicationRound({ storedIntent: "normalized" });
    expect(Object.keys(storedIntentOf(round))).toContain("mockFixtureRefs");
    const broker = await brokerModule();
    const diagnostic: { reason?: string } = {};
    expect(await broker.workflowE2EApplicationAuthorityIsValid(round.harness.brokerInput as never, round.taskNow() as never, round.candidate, round.admission, diagnostic)).toBe(true);
  });
});
