// F4-0 pinning tests: a task ready to publish its pull request (stage PULL_REQUEST, ready), on the fake code host of `service-host`, with no application E2E seam (ordinary CHECKED_TREE publication).
// Used to read what the description's inputs do when a second review or the merge-order seam throws. The second review and the merge-order seams are the test's to set on `w.h.deps`.
import { createHash } from "node:crypto";
import { createCandidateManifest, type WorkflowSnapshot } from "@agentx/contracts";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { readTask, workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { toDocument, type WorkspaceRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { startPublication } from "../../packages/broker/src/core/build-step/publish.js";
import { host, ORG } from "./service-host.js";

const at = "2026-11-09T10:00:00.000Z";

export async function publicationWorld() {
  const w = await host();
  const task = (await readTask(w.h.deps, w.state.facts.taskId))!;
  const model = w.world.prs[0]!.model;
  const base = model.headOf("main");
  const commit = model.commit("candidate", { "src/a.ts": "export const a = 2;\n" });
  const candidate = createCandidateManifest([{ repositoryId: "app", commitSha: commit, treeSha: model.revision(commit).tree, baseCommitSha: base }]);
  const planBytes = Buffer.from("# Approved plan\n");
  const planSha = createHash("sha256").update(planBytes).digest("hex");
  const artifact: WorkflowSnapshot["artifacts"][number] = { id: "plan", type: "plan", version: 1, objectKey: "plan.md", sha256: planSha, producer: "op-plan", createdAt: at };
  const workflow: WorkflowSnapshot = { ...task.workflow!, stage: "PULL_REQUEST", state: "READY", candidate, artifacts: [artifact],
    decisions: [{ requestId: "11111111-1111-4111-8111-111111111111", workflowRevision: 2, decision: "APPROVE", actorId: task.developerId, actorRole: "TASK_OWNER", reason: "Approved", artifactDigest: planSha, at }],
    verification: { ...task.workflow!.verification!, candidateDigest: candidate.digest }, reviews: task.workflow!.reviews!.map((review) => ({ ...review, candidateDigest: candidate.digest })),
    reviewBase: [{ repositoryId: "app", baseCommitSha: base }],
    pullRequests: [],
  };
  const readyTask = { ...task, title: "Add retry", ownerKey: "owner", preparedBase: [{ repositoryId: "app", baseCommitSha: base }], workflow };
  await w.h.store.put({ item: toDocument(readyTask) });
  const workspace: WorkspaceRecord = { ...workspaceKey(ORG, task.workspaceId), sk: "META", entityType: "WORKSPACE", companyId: ORG, orgId: ORG, id: task.workspaceId, ownerKey: "owner", projectName: "web", projectRevision: 1, status: "READY", activeOperationId: null, fence: 1, workspaceProject: "web", workspaceCreatedAt: at, createdAt: at, updatedAt: at };
  await w.h.store.put({ item: toDocument(workspace) });
  await w.h.store.put({ item: { pk: workspace.pk, sk: "DEVELOPER_TASK", taskId: task.taskId } });
  w.h.deps.codeHosts = w.registry;
  w.h.deps.artifacts = { get: async () => planBytes };
  const row = { taskId: task.taskId, workflowRevision: workflow.revision };
  /** The publication step starts; returns the step's answer and the publish operation it accepted (undefined when none was). */
  const started = async () => {
    const result = await startPublication(w.h.deps, row);
    const operation = (await workspaceOperations(w.h.deps, task.workspaceId)).find((entry) => entry.kind === "publish");
    return { result, operation };
  };
  return { ...w, task: readyTask, workspace, row, model, commit, candidate, started };
}
