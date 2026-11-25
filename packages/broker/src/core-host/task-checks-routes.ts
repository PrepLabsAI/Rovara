// RD-2b1: the task page's checks read, `GET /v1/dev/tasks/{taskId}/checks` (row `tasks.checks`, schema `TaskChecksReadSchema` in packages/code-api). It answers `{ checks }`, built by `checksViewOf` (core/task-view/checks.ts) from what the core
// stores: the workflow snapshot, the plan the owner approved, and the evidence pack kept for the current code (its output tails and screenshots as links, each one checked against the store: a file that is gone reads "expired", never a dead link).
//
// ACCESS: the task read's own rule first (`loadReadableTask`: the member company, then the company's access rule), before anything else is read. Another company's task, a colleague who may not read the task and a missing task all answer
// the same `TASK_NOT_FOUND`. A script token never gets here (dev-routes answers it before the mount). The reader a task's owner shared it with under the OLD rule (`sharedReaderTask`, private to dev-routes.ts) is NOT admitted here: such a
// reader reads a missing task until the lanes decide to hand that rule in through the mount's context (RD-2.0 note); the reads stay out of F2-E's reduced admin view because this goes through the person's own read rule only.
import { AgentXError, type ArtifactRef, type ObjectStorage, type PlanDocument } from "@agentx/contracts";
import { readTaskPlanDocument } from "../aws/task-plan-document.js";
import { textReaderOf } from "../core/build-step/plan-input.js";
import { evidenceArtifactKey } from "../core/proof/evidence-artifacts.js";
import { evidenceViewOf, type EvidenceArtifactState } from "../core/proof/evidence-pack.js";
import { loadEvidencePack } from "../core/proof/evidence-keep.js";
import { checksViewOf } from "../core/task-view/checks.js";
import { loadReadableTask } from "../core/task-flow/reads.js";
import type { TaskRecord } from "../core/task-flow/records.js";
import type { BrokerResponse } from "../handler.js";
import { hostedEvidenceBlobs } from "./hosted-evidence.js";
import type { TaskScreenContext } from "./task-screen-routes.js";

/**
 * The plan to read the claims from: the newest version the owner approved, else the latest. A task with no plan document (a Quick task) or one written before structured plans has none (an empty member, never an error); a plan that cannot be
 * read or fails its digest is `unreadable` (the answer says so in its not-tested list instead of showing no mapping silently).
 */
async function planOf(record: TaskRecord, blobs: ObjectStorage): Promise<{ plan?: PlanDocument; unreadable?: true }> {
  const workflow = record.workflow;
  const documents = (workflow?.artifacts ?? []).filter((artifact) => artifact.type === "plan");
  if (documents.length === 0) return {};
  const approvedDigests = new Set((workflow?.decisions ?? []).filter((decision) => decision.decision === "APPROVE" && decision.artifactDigest !== undefined).map((decision) => decision.artifactDigest));
  const approved = documents.filter((artifact) => approvedDigests.has(artifact.sha256)).sort((left, right) => left.version - right.version).at(-1);
  try {
    const view = await readTaskPlanDocument(record, textReaderOf(blobs), { document: "plan", ...(approved === undefined ? {} : { version: approved.version }) });
    return { plan: view.content };
  } catch (error) {
    return error instanceof AgentXError && error.code === "NOT_FOUND" ? {} : { unreadable: true };
  }
}

/** The artifacts of the pack that this read links (the output tails and the screenshots of a strip), each once. */
function linkedRefs(pack: { checks: ReadonlyArray<{ outputTailRef?: ArtifactRef | undefined }>; browser: ReadonlyArray<{ strip: { before: readonly ArtifactRef[]; after: readonly ArtifactRef[] } }> }): ArtifactRef[] {
  const all = [...pack.checks.flatMap((check) => (check.outputTailRef === undefined ? [] : [check.outputTailRef])), ...pack.browser.flatMap((scenario) => [...scenario.strip.before, ...scenario.strip.after])];
  return [...new Map(all.map((ref) => [ref.sha256, ref])).values()];
}

export async function readTaskChecks(context: TaskScreenContext): Promise<BrokerResponse> {
  const { flow, blobs, caller, taskId } = context;
  // First, and before anything is built: the task read's own rule (throws the missing task's answer for anyone who may not read it).
  const record = await loadReadableTask(flow.deps, caller, taskId);
  const evidence = hostedEvidenceBlobs({ blobs, store: flow.deps.store, companyId: flow.deps.companyId });
  const owner = { ownerKey: record.ownerKey, workspaceId: record.workspaceId, taskId: record.taskId };
  const [planned, pack] = await Promise.all([planOf(record, blobs), loadEvidencePack(evidence, owner, record.workflow?.candidate?.digest)]);
  // Retention: an artifact is a link only while the store still holds exactly the bytes the pack names; a file past its retention reads "expired", a store fault or other bytes read "withheld" (no link either way).
  const states = new Map<string, EvidenceArtifactState>();
  for (const ref of pack === undefined ? [] : linkedRefs(pack)) {
    try {
      const held = await evidence.stat(evidenceArtifactKey(record.ownerKey, record.workspaceId, record.taskId, ref.sha256));
      states.set(ref.sha256, held === undefined ? "expired" : held.bytes === ref.bytes ? "available" : "withheld");
    } catch {
      states.set(ref.sha256, "withheld");
    }
  }
  const links = pack === undefined ? undefined : evidenceViewOf(pack, record.taskId, (ref) => states.get(ref.sha256) ?? "withheld");
  const view = checksViewOf({ taskId: record.taskId, workflow: record.workflow, plan: planned.plan, planUnreadable: planned.unreadable === true, pack, links });
  return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ checks: view }) };
}
