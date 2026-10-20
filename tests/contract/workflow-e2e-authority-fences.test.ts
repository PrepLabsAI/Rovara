import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalPlanJson } from "@agentx/contracts";
import { disposeRealCandidates } from "../support/e2e-application-candidate.js";
import { planDocument } from "../support/plan-documents.js";
import { sha, startApplicationRound, type ApplicationRound } from "../support/e2e-application-round-harness.js";

// The portable and the application current-authority checks stand on the same project, creator and fence code. A violation of one of those fences is refused
// by both, for the same reason, because both call the same helpers.

afterEach(disposeRealCandidates);
// The broker module reads its environment when it loads, so it is imported only once the harness (which sets that environment up) has started.
const brokerModule = () => import("../../packages/broker/src/aws/broker.js");

const v1Intent = { schemaVersion: 1 as const, requestedTargetIds: ["target-1"], accountContextRefs: [], portableOperationRefs: [], semanticExportDeltas: [],
  scenarios: [{ scenarioId: "scenario-1", requirementId: "requirement-1", requestedTargetIds: ["target-1"], required: true, accountProfileId: "synthetic",
    minimumEvidence: "source" as const, requiredRealComponentIds: [], steps: [], assertions: [{ kind: "state" as const, probeId: "result", equals: true, pollTimeoutMs: 1 }] }] };

/** The round's task as a task whose approved plan is a portable (v1) plan, so the portable authority check reaches the shared fences. */
function asPortableTask(round: ApplicationRound) {
  const task = round.taskNow() as { ownerKey: string; workflow: Record<string, unknown> & { artifacts: Array<Record<string, unknown>>; decisions: Array<Record<string, unknown>>; e2e: Record<string, unknown> } };
  const plan = Buffer.from(canonicalPlanJson(planDocument({ title: "Portable intent", claims: [{ id: "1", text: "Exercise the approved feature intent." }], e2e: v1Intent as never })));
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

describe("the portable and application current-authority checks share their fences", () => {
  const violations: Array<[string, (round: ApplicationRound) => void]> = [
    ["the latest project record lost its setup approval", (round) => {
      const rows = round.harness.db.find((row) => row.entityType === "PROJECT" && (row.definition as { name?: string } | undefined)?.name === "payments")
        .sort((left, right) => Number((right.definition as { revision: number }).revision) - Number((left.definition as { revision: number }).revision));
      const { setupApproval: _gone, ...rest } = rows[0]!;
      void _gone;
      round.harness.db.set(rest);
    }],
    ["the creator's account was revoked", (round) => {
      round.harness.db.set({ ...round.harness.db.get(`DEVELOPER#${(round.taskNow() as { developerId: string }).developerId}`, "META")!, revoked: true });
    }],
  ];
  for (const [label, violate] of violations) {
    it(`refuses, for the same reason on both paths, when ${label}`, async () => {
      const round = await startApplicationRound();
      const broker = await brokerModule();
      const dependencies = round.harness.brokerInput as never;
      const applicationTask = round.taskNow() as never;
      const portableTask = asPortableTask(round) as never;
      // With nothing violated the application check passes in full: the shared fences hold.
      const baseline: { reason?: string; authorityChecks?: Array<Record<string, unknown>> } = {};
      expect(await broker.workflowE2EApplicationAuthorityIsValid(dependencies, applicationTask, round.candidate, round.admission, baseline), baseline.reason).toBe(true);
      expect(baseline.authorityChecks?.length).toBeGreaterThan(0);
      violate(round);
      const application: { reason?: string } = {};
      const portable: { reason?: string } = {};
      expect(await broker.workflowE2EApplicationAuthorityIsValid(dependencies, applicationTask, round.candidate, round.admission, application)).toBe(false);
      expect(await broker.workflowE2ECurrentAuthorityIsValid(dependencies, portableTask, round.candidate, {}, { candidate: round.candidate, sources: [] } as never, portable)).toBe(false);
      expect(application.reason).toBeDefined();
      expect(portable.reason).toBe(application.reason);
    });
  }
});
