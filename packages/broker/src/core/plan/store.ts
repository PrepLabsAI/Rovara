// Structured plans: where a stored plan lives, on the object-storage and document-store ports. The key layout is Cloud's, so Cloud can read a plan Code
// stored and the other way round: `private/<owner>/<workspace>/plan-documents/<artifactId>.json` holds the canonical JSON, `<prefix>.evidence.<sha256>.json` the cited code read afterwards (named by a
// pointer item `DEVTASK#<task>/PLAN_EVIDENCE#<artifactId>`, so the workflow's digests never move), and `planSelfCheckKey(prefix)` the self-check's record.
import { createHash } from "node:crypto";
import { ObjectConflictError, when, type DocumentStore, type ObjectStorage, type PlanDocument, type PlanEvidenceBundle, type WorkflowArtifact, type WorkflowSnapshot } from "@agentx/contracts";
import { codeHostForRecord } from "../../plugins/routing.js";
import { resolvePlanEvidence, unavailablePlanEvidence } from "../../developer/plan-evidence.js";
import { planEvidencePointerKey, planEvidenceSources, type PlanEvidencePointer } from "../../developer/plan-evidence-keys.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { fromDocument, toDocument, type TaskRecord } from "../task-flow/records.js";
import { iso, log } from "../task-flow/support.js";

/** A retention class the object-storage adapters do not know, so a task's documents are kept until deleted (a plan can wait for its owner for longer than evidence is kept). */
export const PLAN_RETENTION = "task-document";
const encoder = new TextEncoder();
export const sha256Of = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Where a task's plan documents are kept (Cloud's `private/<owner>/<workspace>/plan-documents/<artifact>`). */
export const planDocumentPrefix = (task: Pick<TaskRecord, "ownerKey" | "workspaceId">, artifactId: string): string => `private/${task.ownerKey}/${task.workspaceId}/plan-documents/${artifactId}`;

/** Puts one object. An object already there is kept (objects are immutable, and every reader checks the bytes against the digest it was told). */
export async function putOnce(blobs: Pick<ObjectStorage, "put">, key: string, text: string, contentType: string): Promise<void> {
  try {
    await blobs.put(key, encoder.encode(text), { contentType, metadata: {}, retention: PLAN_RETENTION });
  } catch (error) {
    if (!(error instanceof ObjectConflictError)) throw error;
  }
}

/** The workflow artifact record of a stored structured plan. */
export function structuredArtifactOf(input: { artifactId: string; type: WorkflowArtifact["type"]; version: number; canonical: string; prefix: string; createdAt: string }): WorkflowArtifact {
  return {
    id: input.artifactId, type: input.type, version: input.version, sha256: sha256Of(input.canonical), producer: "agentx-worker-untrusted",
    objectKey: `${input.prefix}.json`, createdAt: input.createdAt, format: "structured",
  };
}

export interface PlanEvidenceDeps {
  store: Pick<DocumentStore, "get" | "put">;
  blobs: Pick<ObjectStorage, "put" | "get">;
  now(): Date;
}

/**
 * Saves the cited code beside the plan and records where it is, as Cloud's `attachEvidence` does: the record is its own item, written once, so it never touches the workflow (its revision, the
 * document's digest, any decision). "gone": the plan is not (or no longer) the task's; "already": evidence was attached before.
 */
export async function attachPlanEvidence(
  deps: PlanEvidenceDeps, task: Pick<TaskRecord, "taskId" | "workflow">,
  input: { artifactId: string; artifactSha256: string; bundle: PlanEvidenceBundle; prefix: string },
): Promise<"attached" | "already" | "gone"> {
  const artifact = task.workflow?.artifacts.find((entry) => entry.id === input.artifactId);
  if (artifact === undefined || artifact.sha256 !== input.artifactSha256 || artifact.format !== "structured") return "gone";
  const key = planEvidencePointerKey(task.taskId, input.artifactId);
  if (artifact.evidence !== undefined || await deps.store.get(key) !== undefined) return "already";
  const evidenceJson = JSON.stringify(input.bundle);
  const sha256 = sha256Of(evidenceJson);
  const objectKey = `${input.prefix}.evidence.${sha256}.json`;
  await putOnce(deps.blobs, objectKey, evidenceJson, "application/json");
  const pointer: PlanEvidencePointer = { ...key, entityType: "PLAN_EVIDENCE_POINTER", artifactId: input.artifactId, artifactSha256: input.artifactSha256, objectKey, sha256, attachedAt: deps.now().toISOString() };
  const written = await deps.store.put({ item: toDocument(pointer), condition: when.absent() });
  return written.applied ? "attached" : "already";
}

/** The pointer a plan's evidence was recorded under, or undefined. */
export async function planEvidencePointer(store: Pick<DocumentStore, "get">, taskId: string, artifactId: string): Promise<PlanEvidencePointer | undefined> {
  return fromDocument<PlanEvidencePointer>(await store.get(planEvidencePointerKey(taskId, artifactId)));
}

/**
 * Reads the code a stored plan cites, from the code host of each cited repository at the commit the task started on, and attaches it. Never throws and never holds the plan up: a host that is not set up,
 * a slow one or a repository that cannot be read leaves those places `unavailable` (the plan page then says so), and nothing falls back to another host. Called after the plan is committed.
 */
export async function attachCitedCode(
  deps: TaskFlowDeps, blobs: Pick<ObjectStorage, "put" | "get">,
  input: { task: TaskRecord; workflow: WorkflowSnapshot; artifactId: string; artifactSha256: string; plan: PlanDocument; prefix: string },
): Promise<void> {
  try {
    const project = await deps.projects.revision(input.task.project, input.task.startingRevision);
    if (project === undefined) return;
    const repositories = project.definition.repositories;
    let bundle: PlanEvidenceBundle;
    try {
      bundle = await resolvePlanEvidence(input.plan, {
        ...planEvidenceSources(project, { workflow: input.workflow, preparedBase: input.task.preparedBase }),
        // Each cited repository is read through the code host its RECORD names; a record naming a host this install has not registered is refused and its places stay unavailable.
        readFile: async (url, path, commit, options) => {
          const record = repositories.find((repository) => repository.url === url);
          if (record === undefined || deps.codeHosts === undefined) throw new Error("the cited repository cannot be read");
          return codeHostForRecord(deps.codeHosts, record).fileAtRevision({ url }, path, commit, { orgId: deps.companyId }, options);
        },
      });
    } catch {
      bundle = unavailablePlanEvidence(input.plan);
    }
    await attachPlanEvidence({ store: deps.store, blobs, now: () => new Date(iso(deps)) }, { taskId: input.task.taskId, workflow: input.workflow }, { artifactId: input.artifactId, artifactSha256: input.artifactSha256, bundle, prefix: input.prefix });
  } catch (error) {
    log(deps, { event: "plan.evidence_failed", taskId: input.task.taskId, error: error instanceof Error ? error.name : "unknown" });
  }
}
