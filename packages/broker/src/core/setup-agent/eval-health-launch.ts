// L4-EVH (DEC 254zzz20 D5): hands a claimed health run to a worker. It makes ONE read-only preparation of the project's repositories at the main heads the broker read and claimed (`pins`, which the worker refuses if its own
// resolution differs), carrying `evalHealth: { requestId, claimId }`. The preparation's capability names only what the run needs (`eval-plan` for its plan and grant, `eval-health-result` for its one result, and model access,
// which the broker describes from the claim, core/model-gateway/health.ts). Like a saved image's rebuild, the workspace is in no list of workspaces: it belongs to no one's work.
//   - the workspace belongs to the person who asked (their id is only the owner key; it gives them no access to the run);
//   - every repository of the project has a head in the claim, and the claim names no other: the pins are the project's, whole;
//   - one start per claim: the workspace and the operation are written together or not at all, and the ids are the broker's own.
// When the preparation ends, the flow closes the workspace and its machine (the same rule as a project's setup check: a workspace with no task).
// A worker that does not list `PREPARE_EVAL_HEALTH_FEATURE` is never sent the run (the dispatch says `requires`). Fails closed: a project that cannot be read or is archived, heads that do not match the project's
// repositories, or a store that refuses start nothing and answer false (the claim then ends as "could not be started": nothing was spent).
import { randomUUID } from "node:crypto";
import { EVAL_HEALTH_RESULT_PATH, EVAL_PLAN_DELIVERY_ACTION, PREPARE_EVAL_HEALTH_FEATURE, when, workerProjectDefinition, type StoredDocument } from "@agentx/contracts";
import { taskOwnerKey } from "../../developer/task-records.js";
import { buildOperation } from "../task-flow/accept.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { workspaceKey } from "../task-flow/keys.js";
import { legacyWorkspaceKey } from "../task-flow/legacy-keys.js";
import { setupCheckRecordItem } from "./check.js";

const documentOf = <T extends object>(value: T): StoredDocument => JSON.parse(JSON.stringify(value)) as StoredDocument;

export interface EvalHealthLaunch { project: string; requestId: string; claimId: string; bases: ReadonlyArray<{ repositoryId: string; baseCommitSha: string }>; owner: string }

export async function launchEvalHealthRun(flow: TaskFlowDeps, job: EvalHealthLaunch): Promise<boolean> {
  try {
    const project = await flow.projects.latest(job.project);
    if (project === undefined || project.archived === true) return false;
    const names = workerProjectDefinition(project.definition).repositories.map((repository) => repository.name);
    const heads = new Map(job.bases.map((base) => [base.repositoryId, base.baseCommitSha] as const));
    // Every repository of the project has exactly one head in the claim, and the claim names no other.
    if (names.length === 0 || heads.size !== job.bases.length || heads.size !== names.length || names.some((name) => !heads.has(name))) return false;
    const nowMs = (flow.now?.() ?? new Date()).getTime();
    const now = new Date(nowMs).toISOString();
    const workspaceId = (flow.newId ?? randomUUID)();
    const operationId = (flow.newId ?? randomUUID)();
    const ownerKey = taskOwnerKey(job.owner, `eval-health-${job.requestId}`);
    const workspace: StoredDocument = documentOf({
      ...workspaceKey(flow.companyId, workspaceId), entityType: "WORKSPACE", id: workspaceId, companyId: flow.companyId, orgId: flow.companyId, ownerKey, projectName: job.project, projectRevision: project.definition.revision,
      status: "PREPARING", activeOperationId: operationId, fence: 1, createdAt: now, updatedAt: now,
    });
    const pins = names.map((repository) => ({ repository, commit: heads.get(repository)! }));
    const prepare = buildOperation(flow, {
      workspace: { pk: workspace.pk, id: workspaceId, fence: 1, ownerKey }, kind: "prepare", requestId: job.claimId, operationId, now, recordRequest: false,
      dispatch: {
        kind: "prepare", projectRevision: project.definition.revision,
        payload: JSON.parse(JSON.stringify({ readOnly: true, pins, evalHealth: { requestId: job.requestId, claimId: job.claimId } })) as Record<string, never>,
        extraActions: [EVAL_PLAN_DELIVERY_ACTION, EVAL_HEALTH_RESULT_PATH], requires: [PREPARE_EVAL_HEALTH_FEATURE],
      },
      requester: { personId: job.owner, provider: "eval-health" },
    });
    const written = await flow.store.transact([
      { kind: "put", item: workspace, condition: when.absent() },
      { kind: "put", item: { ...legacyWorkspaceKey(workspaceId), entityType: "WORKSPACE_COMPANY_POINTER", workspaceId, companyId: workspace["companyId"]! }, condition: when.absent() },
      ...prepare.items,
      // A workspace with no task is closed, with its machine, when its preparation ends (`closeSetupCheck`, read from this record): a finished health run keeps nothing running.
      setupCheckRecordItem(flow, { project: job.project, workspaceId, revision: project.definition.revision, nowMs }),
    ]);
    if (!written.applied) return false;
    // The message is handed to its queue now; a relay from a timer does it too if this one is lost, so a failure here never fails the start.
    await flow.outbox.relay({ companyId: flow.companyId, ids: [prepare.operation.id] }).catch(() => undefined);
    return true;
  } catch { return false; }
}
