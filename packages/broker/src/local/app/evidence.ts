// Lane L12, slice 3: proof on a laptop. When a task's checks are recorded for a candidate (a coding run's report, or a rerun of the checks), the evidence of that run is assembled and kept (Cloud's
// `keepEvidenceAfterChecks`, `aws/broker/evidence-wiring.ts`), so the proof page and the pull request have something to show:
//   - what the worker saved as `evidence-raw.json` for that operation (a rerun of the checks asks for it; a coding run saves none, and the pack then holds only what the broker itself knows: its own verdict for each check);
//   - the data guard (the verifier's `scanText`) looks at everything before it is kept, and again at the built pack; a pack that fails it is not kept;
//   - the pack and the output tails go to the `object-storage` point. Objects there are WRITE-ONCE: the tails are content-addressed (writing the same bytes again changes nothing), and the pack is the one object a
//     re-check of the same code replaces, with the documented opt-in (`overwrite: true` in `evidence-keep.ts`: one pack per task and candidate digest).
// It is informational: a fault or a slow store only means there is no evidence for this code. It never changes a verdict and never holds a callback longer than `EVIDENCE_KEEP_MAX_MS`.
import { scanText } from "@agentx/verifier";
import { MODEL_HOSTS_ALLOWED_BY_SETTING_SENTENCE, SANDBOX_MODEL_HOSTS_ITEM_ID, workflowSelectedChecks, type CheckEntry, type EvidenceNotTested, type EvidencePack, type ObjectStorage, type WorkflowSnapshot } from "@agentx/contracts";
import { keepEvidence, loadEvidencePack, policyKindsOf, type KeepEvidenceResult } from "../../core/proof/evidence-keep.js";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";
import { workspaceKey } from "../../core/task-flow/keys.js";
import type { OperationRecord, TaskRecord } from "../../core/task-flow/records.js";
import { readVerifiedText } from "./documents.js";

/** How long keeping evidence may hold up the worker's callback. */
export const EVIDENCE_KEEP_MAX_MS = 6_000;

export interface LocalEvidence {
  /** Keeps the evidence of a run whose checks were just recorded. Never throws; undefined when it could not even start. */
  keepAfterChecks(input: { task: TaskRecord; operation: OperationRecord; workflow: WorkflowSnapshot; candidateDigest: string; checks: readonly CheckEntry[] }): Promise<KeepEvidenceResult | undefined>;
  /** The pack kept for exactly this code of this task, or undefined. */
  packOf(task: Pick<TaskRecord, "ownerKey" | "workspaceId" | "taskId">, candidateDigest: string | undefined): Promise<EvidencePack | undefined>;
}

/** FIX-0518: the pack's line when the owner let a project's sandboxes reach the model hosts: the fixed sentence, and the setting named (a name, never a value from the repository). */
export const MODEL_HOSTS_ALLOWED_ITEM: EvidenceNotTested = { kind: "environment", id: SANDBOX_MODEL_HOSTS_ITEM_ID, text: MODEL_HOSTS_ALLOWED_BY_SETTING_SENTENCE, reason: "sandboxModelHosts is allow in the Rovara config" };

export function createLocalEvidence(options: {
  flow: Pick<TaskFlowDeps, "store" | "companyId" | "log">;
  blobs: ObjectStorage;
  /** FIX-0518: whether the owner let this project's sandboxes reach the model hosts. Absent: the deny stands and the pack says nothing about it. */
  sandboxModelHostsAllowed?: ((project: string) => boolean) | undefined;
  /** FIX-0518 (L2): the state the task's worker machine was created with. Read first; the config setting above is only the answer when the machine cannot say (gone, Docker not answering, no machine on the record). */
  sandboxModelHostsOf?: ((machineId: string) => Promise<"denied" | "allowed" | undefined>) | undefined;
}): LocalEvidence {
  const { flow, blobs } = options;
  const log = (event: string, fields: Record<string, unknown>): void => flow.log?.({ component: "evidence", event, ...fields });
  // What applied to this task's sandboxes: the state its MACHINE was created with (a setting changed since then has not reached it). Only when the machine cannot say does the owner's setting for the task's project stand in, so the line is never left
  // out on a guess that it was denied; anything unreadable and no setting says nothing.
  const modelHostsAllowed = async (workspaceId: string): Promise<boolean> => {
    try {
      const record = await flow.store.get(workspaceKey(workspaceId));
      const machine = record?.["machine"];
      const machineId = typeof machine === "object" && machine !== null && typeof (machine as Record<string, unknown>)["machineId"] === "string" ? (machine as Record<string, string>)["machineId"] : undefined;
      if (machineId !== undefined && options.sandboxModelHostsOf !== undefined) {
        const state = await options.sandboxModelHostsOf(machineId).catch(() => undefined);
        if (state === "allowed") return true;
        if (state === "denied") return false;
      }
      return options.sandboxModelHostsAllowed !== undefined && typeof record?.["projectName"] === "string" && options.sandboxModelHostsAllowed(record["projectName"]) === true;
    } catch { return false; }
  };
  return {
    async keepAfterChecks(input) {
      const { task, operation } = input;
      let late = false;
      // The run's own artifacts, offered to the keeper under the names it reads them by (`private/<owner>/<workspace>/<operation>/<name>`): the keeper checks an artifact is under the operation's own prefix.
      const rows = new Map<string, { name: string; sha256: string; objectKey: string }>();
      const prefix = `private/${task.ownerKey}/${task.workspaceId}/${operation.id}/`;
      const run = keepEvidence({
        scan: scanText, store: { blobs }, late: () => late, log,
        actions: {
          async artifacts(workspaceId, operationId) {
            if (workspaceId !== task.workspaceId || operationId !== operation.id) return [];
            const found = await flow.store.query({ pk: `WORKSPACE#${workspaceId}`, sk: { op: "beginsWith", prefix: `ARTIFACT#${operationId}#` }, limit: 100 });
            const listed: Array<{ name: string; objectKey: string }> = [];
            for (const row of found.items) {
              if (typeof row["name"] !== "string" || typeof row["objectKey"] !== "string" || typeof row["sha256"] !== "string") continue;
              const virtual = `${prefix}${row["name"]}`;
              rows.set(virtual, { name: row["name"], sha256: row["sha256"], objectKey: row["objectKey"] });
              listed.push({ name: row["name"], objectKey: virtual });
            }
            return listed;
          },
          async readArtifact(objectKey, maxBytes) {
            const row = rows.get(objectKey);
            if (row === undefined) return "";
            const read = await readVerifiedText(blobs, row, maxBytes);
            return "text" in read ? read.text : "";
          },
        },
      }, {
        orgId: flow.companyId, task: { ownerKey: task.ownerKey, workspaceId: task.workspaceId, taskId: task.taskId }, operationId: operation.id, candidateDigest: input.candidateDigest,
        checks: input.checks.filter((entry) => entry.source === "project"), policyKinds: policyKindsOf(workflowSelectedChecks(input.workflow.checkPolicy)),
        ...(await modelHostsAllowed(task.workspaceId) ? { extraNotTested: [MODEL_HOSTS_ALLOWED_ITEM] } : {}),
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(() => { late = true; resolve(undefined); }, EVIDENCE_KEEP_MAX_MS); timer.unref(); });
      try { return await Promise.race([run, timeout]); } finally { clearTimeout(timer); }
    },
    packOf: (task, candidateDigest) => loadEvidencePack(blobs, { ownerKey: task.ownerKey, workspaceId: task.workspaceId, taskId: task.taskId }, candidateDigest),
  };
}

