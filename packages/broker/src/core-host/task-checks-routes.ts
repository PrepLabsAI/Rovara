// RD-2b1: the task page's checks read, `GET /v1/dev/tasks/{taskId}/checks` (row `tasks.checks`, schema `TaskChecksReadSchema` in packages/code-api). It answers `{ checks }`, built by `checksViewOf` (core/task-view/checks.ts) from what the core
// stores: the workflow snapshot, the plan the owner approved, and the evidence pack kept for the current code (its output tails and screenshots as links, each one checked against the store: a file that is gone reads "expired", never a
// dead link; and while Code does not serve the files, `EVIDENCE_FILES_SERVED`, a link carries no address and says so).
//
// ACCESS: the task read's own rule first (`loadReadableTask`: the member company, then the company's access rule), before anything else is read. Another company's task, a colleague who may not read the task and a missing task all answer
// the same `TASK_NOT_FOUND`. A script token never gets here (dev-routes answers it before the mount). The reader a task's owner shared it with under the OLD rule (`sharedReaderTask`, private to dev-routes.ts) is NOT admitted here: such a
// reader reads a missing task until the one "may read this task" function (lane RD-2.0-READ-RULE) replaces that one call; the reads stay out of F2-E's reduced admin view because this goes through the person's own read rule only.
// Whether the reader may also see code and facts about code (test names, findings, scan items, file links) is ONE question, `mayReadCodeDetails`, asked once.
import { type ArtifactRef, type ObjectStorage, type PlanDocument } from "@agentx/contracts";
import { loadWorkflowDocument } from "../developer/plan-document-reader.js";
import { textReaderOf } from "../core/build-step/plan-input.js";
import { evidenceArtifactKey } from "../core/proof/evidence-artifacts.js";
import { evidenceViewOf, type EvidenceArtifactState } from "../core/proof/evidence-pack.js";
import { evidencePackKey, loadEvidencePack } from "../core/proof/evidence-keep.js";
import { EVIDENCE_FILES_SERVED, checksViewOf, unavailableChecksView, type PlanNote } from "../core/task-view/checks.js";
import type { TaskCaller } from "../core/task-flow/deps.js";
import { loadReadableTask } from "../core/task-flow/reads.js";
import type { TaskRecord } from "../core/task-flow/records.js";
import type { BrokerResponse } from "../handler.js";
import { hostedEvidenceBlobs } from "./hosted-evidence.js";
import type { TaskScreenContext } from "./task-screen-routes.js";

/** The most files one read checks against the store, and how many at a time (a pack may name hundreds; the page shows a few per row). A file beyond the most is "withheld", not checked. */
const STAT_MAX = 200;
const STAT_AT_ONCE = 8;

/**
 * Whether this reader may see code and facts about code in the answer: failing test names and the files a failure points at, review findings' files and text, the security scan's items, and the links to output and screenshots.
 * ONE place. Today every reader that passed the task read rule may (it is the same company's task; the checks are what the task page of that reader already shows in the task view). The read rule that admits readers with limits
 * (RD-2.0-READ-RULE) decides here; a reader who may not still gets every state, count and id.
 */
export function mayReadCodeDetails(reader: TaskCaller, task: Pick<TaskRecord, "companyId">): boolean {
  return reader.principal.companyId === task.companyId;
}

/**
 * The plan to read the claims from: the newest version the owner APPROVED. No approved version is no plan (a draft is not what the owner accepted, so no claim, mapping or scenario is read from it) and says so; an approved version with
 * no structured form (written before structured plans) says so; one that cannot be read or fails its digest says so. A task with no plan document at all has none and no note. Only the document is read (no self-check, no summary).
 */
async function planOf(record: TaskRecord, blobs: ObjectStorage): Promise<{ plan?: PlanDocument; note?: PlanNote }> {
  const workflow = record.workflow;
  const documents = (workflow?.artifacts ?? []).filter((artifact) => artifact.type === "plan");
  if (documents.length === 0) return {};
  const approvedDigests = new Set((workflow?.decisions ?? []).filter((decision) => decision.decision === "APPROVE" && decision.artifactDigest !== undefined).map((decision) => decision.artifactDigest));
  const approved = documents.filter((artifact) => approvedDigests.has(artifact.sha256)).sort((left, right) => left.version - right.version).at(-1);
  if (approved === undefined) return { note: "unapproved" };
  if (approved.format !== "structured") return { note: "markdown" };
  if (!approved.objectKey.startsWith(`private/${record.ownerKey}/${record.workspaceId}/`)) return { note: "unreadable" };
  const loaded = await loadWorkflowDocument(textReaderOf(blobs), approved, {}).catch(() => undefined);
  return loaded?.format === "structured" ? { plan: loaded.plan } : { note: "unreadable" };
}

/** The artifacts of the pack that this read links (the output tails, then each scenario's screenshots as a row shows them), each once, at most `STAT_MAX`. */
function linkedRefs(pack: { checks: ReadonlyArray<{ outputTailRef?: ArtifactRef | undefined }>; browser: ReadonlyArray<{ strip: { before: readonly ArtifactRef[]; after: readonly ArtifactRef[] } }> }): ArtifactRef[] {
  const tails = pack.checks.flatMap((check) => (check.outputTailRef === undefined ? [] : [check.outputTailRef]));
  const shots = pack.browser.flatMap((scenario) => [...scenario.strip.before, ...scenario.strip.after].slice(0, 12));
  return [...new Map([...tails, ...shots].map((ref) => [ref.sha256, ref])).values()].slice(0, STAT_MAX);
}

/** Runs `run` over `items`, `size` at a time. */
async function inBatches<T>(items: readonly T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  for (let start = 0; start < items.length; start += size) await Promise.all(items.slice(start, start + size).map(run));
}

/**
 * The state of each linked file: available only while the store holds a file of the pack's size AND digest (the store's own record of the digest it was written under), "expired" when the store no longer holds it (past its
 * retention), "withheld" for any other bytes, a store fault, and a file beyond the most checked.
 */
async function statesOf(evidence: ObjectStorage, record: TaskRecord, refs: readonly ArtifactRef[]): Promise<Map<string, EvidenceArtifactState>> {
  const states = new Map<string, EvidenceArtifactState>();
  await inBatches(refs, STAT_AT_ONCE, async (ref) => {
    try {
      const held = await evidence.stat(evidenceArtifactKey(record.ownerKey, record.workspaceId, record.taskId, ref.sha256));
      states.set(ref.sha256, held === undefined ? "expired" : held.bytes === ref.bytes && held.metadata["sha256"] === ref.sha256 ? "available" : "withheld");
    } catch {
      states.set(ref.sha256, "withheld");
    }
  });
  return states;
}

/** The pack is in the store but `loadEvidencePack` gave none: it could not be read (a fault, or a version this build does not read), which is not the same as none kept. A store that cannot answer counts as unreadable. */
async function packIsUnreadable(evidence: ObjectStorage, record: TaskRecord, digest: string | undefined): Promise<boolean> {
  if (digest === undefined) return false;
  try {
    return (await evidence.stat(evidencePackKey({ ownerKey: record.ownerKey, workspaceId: record.workspaceId, taskId: record.taskId }, digest))) !== undefined;
  } catch {
    return true;
  }
}

const answer = (view: unknown): BrokerResponse => ({ statusCode: 200, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify({ checks: view }) });

export async function readTaskChecks(context: TaskScreenContext): Promise<BrokerResponse> {
  const { flow, blobs, caller, taskId } = context;
  // First, and before anything is built: the task read's own rule (throws the missing task's answer for anyone who may not read it).
  const record = await loadReadableTask(flow.deps, caller, taskId);
  try {
    const evidence = hostedEvidenceBlobs({ blobs, store: flow.deps.store, companyId: flow.deps.companyId });
    const digest = record.workflow?.candidate?.digest;
    const [planned, pack] = await Promise.all([planOf(record, blobs), loadEvidencePack(evidence, { ownerKey: record.ownerKey, workspaceId: record.workspaceId, taskId: record.taskId }, digest)]);
    const codeDetails = mayReadCodeDetails(caller, record);
    // Retention is asked only of a reader who may see the links; each file is a link only while the store holds it.
    const states = pack === undefined || !codeDetails ? new Map<string, EvidenceArtifactState>() : await statesOf(evidence, record, linkedRefs(pack));
    const links = pack === undefined || !codeDetails ? undefined : evidenceViewOf(pack, record.taskId, (ref) => states.get(ref.sha256) ?? "withheld");
    const packUnreadable = pack === undefined && await packIsUnreadable(evidence, record, digest);
    return answer(checksViewOf({ taskId: record.taskId, workflow: record.workflow, plan: planned.plan, planNote: planned.note, pack, packUnreadable, links, codeDetails, evidenceLinks: EVIDENCE_FILES_SERVED }));
  } catch {
    // The join could not be made: one fixed sentence instead of a failure (access was settled above, so this says nothing about who may read).
    return answer(unavailableChecksView(record.taskId));
  }
}
