// Saved project images: the rebuild as an ordinary SYSTEM RUN (design SAVED-IMAGES 2.1, SI-2). The system starter (`core/system-runs/starter.ts`) calls this for the kind `saved_env_rebuild`; it is the start variant that
// `startSavedEnvRebuild` (the older start, which the pass lane deletes) is not. What is the same: the job the registry queued, every guard of its start (`readRebuildFacts`), and the preparation it makes (read only,
// pinned to the job's commits, the job in its payload, no credential). What changes:
//   - it runs as the project's SYSTEM OWNER (`taskOwnerKey(systemOwnerIdOf(company, project), workspace)`, as a project's setup check does): there is no approver to look up and no person's id on the run;
//   - it is WATCHED like every preparation (`prepareWatchItem`, with `SAVED_ENV_BUILD_WATCH_MS`, shorter than the job lease) and has the record that makes the flow close the workspace and terminate its machine when the
//     preparation ends (`setupCheckRecordItem` with `purpose: "saved_env_rebuild"`), so there is no marker and no sweep;
//   - it writes NOTHING on the project's own setup mark: a rebuild never changes the project's setup state;
//   - ONE start per job, in ONE transaction with everything else: a start record keyed by the job id put only while absent (beside a `check` that the registry row is still at the version this start read, with the same
//     job, not handed to a worker; the row itself is not written, so a release that still parses it strictly reads it unchanged), and the two slots (`saved-env-slots.ts`) taken by conditional puts. A second start
//     for the same job fails the transaction and answers `already_started`; a lost race for a slot is tried once more with the slots then free, and then answers `no_slot`.
// The start record holds the ids the pass needs to read the operation of a job (`workspaceId`, `operationId`) and the request id that made it (a repeat of the request answers the first start). It is a sibling row of the
// registry row, never a field on it: older releases parse the registry row strictly, so a new fact goes beside it.
// Money: the run is started only through the system starter, which holds it to the install flag and the company's consent, takes a place of the project's monthly count of automatic runs (the cap), writes the audit
// record first and the machine-time usage row after; the machine is admitted when the dispatcher starts it (`machine.start`), as for every workspace.
import { randomUUID } from "node:crypto";
import { INDEX_EXPIRY_ATTRIBUTE, OrgIdSchema, PREPARE_SAVED_ENV_BUILD_FEATURE, SAVED_ENV_BUILD_WATCH_MS, orgPk, systemOwnerIdOf, when, type DocumentKey, type StoredDocument, type TransactItem } from "@agentx/contracts";
import { taskOwnerKey } from "../../developer/task-records.js";
import { setupCheckRecordItem, setupStateOf } from "../setup-agent/check.js";
import { buildOperation } from "../task-flow/accept.js";
import { OPERATION_SK_PREFIX, workspaceKey } from "../task-flow/keys.js";
import { UPKEEP_KEEP_SECONDS } from "../upkeep/keys.js";
import { legacyWorkspaceKey } from "../task-flow/legacy-keys.js";
import { prepareWatchItem } from "../task-flow/prepare-watch.js";
import { documentOf } from "./deps.js";
import { readRebuildFacts, rebuildPreparation, type RebuildFactsRefusal, type RebuildStartDeps } from "./saved-env-rebuild.js";
import { startMarkerItem, startMarkerKey } from "./saved-env-markers.js";
import { savedEnvRowKey } from "./saved-env-store.js";
import { pickSlots, slotClaimItems, type SlotPick } from "./saved-env-slots.js";

/** Why a rebuild was not started: the start's own refusals (fixed codes, nothing read from a repository), and the two that say "not now". */
export type SavedEnvRunNot = RebuildFactsRefusal | "already_started" | "no_slot" | "setup_check_running" | "lease_too_short";

export type SavedEnvRunStart = { started: true; workspaceId: string; operationId: string; duplicate: boolean } | { started: false; why: SavedEnvRunNot };

/** What the system starter needs of a rebuild: the reads that say it can start (before a place of the month is taken or an audit record written), and the start. */
export interface SavedEnvRebuildRun {
  /** Reads only. Undefined: nothing in the way. A repeat of the request that started the job's run is not in the way (the start answers it). */
  precheck(project: string, requestId: string): Promise<SavedEnvRunNot | undefined>;
  start(project: string, requestId: string): Promise<SavedEnvRunStart>;
}

/** The start record of a job: one per job, keyed by the job id, in the company's partition. It expires 30 days after the start. */
export const savedEnvStartKey = (orgId: string, jobId: string): DocumentKey => ({ pk: orgPk(OrgIdSchema.parse(orgId)), sk: `SAVED_ENV_START#${jobId}` });
const START_KEEP_SECONDS = 30 * 86_400;
/** How long a rebuild's workspace, pointer and operation are kept: as long as the usage rows (`upkeepExpiryOf`, 62 days) that read the workspace to measure the run's minutes. */
const RUN_KEEP_SECONDS = UPKEEP_KEEP_SECONDS;

/** Positions of the steps every start puts first in its transaction (the ones whose failure means something). */
const STEP = { row: 0, start: 1, marker: 2 } as const;

/** Whether the job's lease outlives the build's watch: a machine started with less lease left than the watch gives could outlive the lease, and its result would then be refused as expired. */
const leaseCoversWatch = (job: { leaseUntil: string }, at: number): boolean => Date.parse(job.leaseUntil) - at >= SAVED_ENV_BUILD_WATCH_MS;

export function createSavedEnvRebuildRun(deps: Omit<RebuildStartDeps, "ownerFor">): SavedEnvRebuildRun {
  const { flow, saved } = deps;
  const orgId = flow.companyId;
  const nowMs = (): number => (flow.now?.() ?? new Date()).getTime();
  const read = async (project: string): ReturnType<typeof readRebuildFacts> => readRebuildFacts(deps, { orgId, projectId: project });
  /** The start record of the job, as a start by this request id (a repeat) or as another's. */
  const startOf = async (jobId: string, requestId: string): Promise<{ workspaceId: string; operationId: string } | "other" | undefined> => {
    const row = await flow.store.get(savedEnvStartKey(orgId, jobId));
    if (row === undefined) return undefined;
    return row["requestId"] === requestId && row["orgId"] === orgId && typeof row["workspaceId"] === "string" && typeof row["operationId"] === "string" ? { workspaceId: row["workspaceId"], operationId: row["operationId"] } : "other";
  };
  /** The transaction of one start: the steps in the order `STEP` names (the first two), then the slots, the workspace, the operation, the watch and the close record. */
  const transactionOf = (project: string, requestId: string, found: Extract<Awaited<ReturnType<typeof readRebuildFacts>>, { ok: true }>["facts"], picked: SlotPick, at: number) => {
    const { job, state, project: latest } = found;
    const now = new Date(at).toISOString();
    const workspaceId = (flow.newId ?? randomUUID)();
    const operationId = (flow.newId ?? randomUUID)();
    const ownerKey = taskOwnerKey(systemOwnerIdOf(orgId, project), workspaceId);
    // The workspace is written WITHOUT the project index attributes: it is in no list of workspaces, the project's or a person's.
    // The workspace, its pointer and its operation expire (62 days, as long as the usage rows that meter them): the operation holds the approved environment body, and a closed rebuild has no one to read it.
    const expires = { [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(at / 1000) + RUN_KEEP_SECONDS };
    const workspace: StoredDocument = documentOf({
      ...workspaceKey(orgId, workspaceId), entityType: "WORKSPACE", id: workspaceId, companyId: orgId, orgId, ownerKey, projectName: project, projectRevision: latest.definition.revision,
      status: "PREPARING", activeOperationId: operationId, fence: 1, createdAt: now, updatedAt: now, ...expires,
    });
    const { pins, savedEnvBuild } = rebuildPreparation(saved, { orgId, projectId: project }, found);
    // No requester: a rebuild has no model run (the requester only feeds the model-payer rule), and no person started it.
    const prepare = buildOperation(flow, {
      workspace: { pk: workspace.pk, id: workspaceId, fence: 1, ownerKey }, kind: "prepare", requestId: (flow.newId ?? randomUUID)(), operationId, now, recordRequest: false,
      dispatch: {
        kind: "prepare", projectRevision: latest.definition.revision, payload: JSON.parse(JSON.stringify({ readOnly: true, pins, savedEnvBuild })) as Record<string, never>,
        // The push login and the result are this preparation's alone; a worker that cannot build is refused the job, never sent it without the field.
        extraActions: ["saved-env-push-login", "saved-env-result"], requires: [PREPARE_SAVED_ENV_BUILD_FEATURE],
      },
    });
    const items: TransactItem[] = [
      // STEP.row: the registry row is still the one this start read, with this job, which no worker has been given the lease of. Checked, not written.
      { kind: "check", key: savedEnvRowKey(orgId, project), condition: when.and(when.eq("version", state.version), when.eq(["job", "jobId"], job.jobId), when.notExists(["job", "dispatchedAt"])) },
      // STEP.start: one start per job.
      { kind: "put", item: { ...savedEnvStartKey(orgId, job.jobId), entityType: "SAVED_ENV_START", orgId, project, jobId: job.jobId, workspaceId, operationId, requestId, createdAt: now, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(at / 1000) + START_KEEP_SECONDS }, condition: when.absent() },
      // STEP.marker: the older start's own marker, so the same job never gets a second preparation from it (it puts the same marker only while absent).
      { kind: "put", item: startMarkerItem({ orgId, projectId: project, jobId: job.jobId, workspaceId, operationId, createdAt: now, nowMs: at }), condition: when.absent() },
      ...slotClaimItems(orgId, picked, { project, jobId: job.jobId, nowMs: at }),
      { kind: "put", item: workspace, condition: when.absent() },
      { kind: "put", item: { ...legacyWorkspaceKey(workspaceId), entityType: "WORKSPACE_COMPANY_POINTER", workspaceId, companyId: orgId, ...expires }, condition: when.absent() },
      ...prepare.items.map((item) => (item.kind === "put" && item.item.pk === workspace.pk && item.item.sk.startsWith(OPERATION_SK_PREFIX) ? { ...item, item: { ...item.item, ...expires } } : item)),
      // Watched like every preparation, with the rebuild's own limit (2 h 45 min), which is shorter than the job's lease: the flow always ends a hung preparation (and closes its workspace and machine) before a pass may
      // treat the lease as run out and queue the next job.
      prepareWatchItem(orgId, now, workspaceId, operationId, undefined, SAVED_ENV_BUILD_WATCH_MS),
      // What closes the workspace and terminates its machine when the preparation ends. The project's setup mark is NOT written.
      setupCheckRecordItem(flow, { project, workspaceId, revision: latest.definition.revision, nowMs: at, purpose: "saved_env_rebuild", jobId: job.jobId }),
    ];
    return { items, workspaceId, operationId, relayId: prepare.operation.id };
  };
  /** One try at a start: its answer, or "retry" when a slot was taken or the registry row was written again between the read and the write. */
  const attempt = async (project: string, requestId: string): Promise<SavedEnvRunStart | "retry"> => {
    const found = await read(project);
    if (!found.ok) return { started: false, why: found.why };
    const jobId = found.facts.job.jobId;
    const prior = await startOf(jobId, requestId);
    if (prior === "other") return { started: false, why: "already_started" };
    if (prior !== undefined) return { started: true, ...prior, duplicate: true };
    const at = nowMs();
    if (!leaseCoversWatch(found.facts.job, at)) return { started: false, why: "lease_too_short" };
    const picked = await pickSlots(flow.store, orgId, jobId, at);
    if (!picked.ok) return { started: false, why: "no_slot" };
    const built = transactionOf(project, requestId, found.facts, picked, at);
    const written = await flow.store.transact(built.items);
    if (written.applied) {
      // The message is handed to its queue now; a relay from a timer does it too if this one is lost, so a failure here never fails the start.
      await flow.outbox.relay({ companyId: orgId, ids: [built.relayId] }).catch(() => undefined);
      return { started: true, workspaceId: built.workspaceId, operationId: built.operationId, duplicate: false };
    }
    // Which condition failed. A start record is there: someone started this job first (a repeat of this very request answers that start). Otherwise it is tried once more from the reads: a slot was taken, or the registry row
    // was written again (a push, a task or a poll bumps its version while the job waits), and the second look says whether the job is still this one, queued and not handed to a worker (`nothing_queued` if not).
    if (written.failed.includes(STEP.start) || written.failed.includes(STEP.marker)) {
      const first = await startOf(jobId, requestId);
      return first === undefined || first === "other" ? { started: false, why: "already_started" } : { started: true, ...first, duplicate: true };
    }
    return "retry";
  };
  return {
    async precheck(project, requestId) {
      const found = await read(project);
      if (!found.ok) return found.why;
      const prior = await startOf(found.facts.job.jobId, requestId);
      if (prior === "other") return "already_started";
      if (prior !== undefined) return undefined;
      // The older start (still wired to the registry's `onQueued` until the pass lane removes it) leaves its marker: a job it started is not started again here.
      if ((await flow.store.get(startMarkerKey(found.facts.job.jobId))) !== undefined) return "already_started";
      if (!leaseCoversWatch(found.facts.job, nowMs())) return "lease_too_short";
      // The project's own setup check is running: a rebuild waits (read here, before any place of the month is taken, so a pass that meets a running check every hour writes nothing).
      if ((await setupStateOf(flow, project, found.facts.project.definition)).status === "checking") return "setup_check_running";
      const picked = await pickSlots(flow.store, orgId, found.facts.job.jobId, nowMs());
      return picked.ok ? undefined : "no_slot";
    },

    async start(project, requestId) {
      // A lost race (a slot taken, or the registry row written again, between the reads and the write) is tried once more from the reads; everything else answers at once. A second lost race is "not now".
      const first = await attempt(project, requestId);
      if (first !== "retry") return first;
      const second = await attempt(project, requestId);
      return second === "retry" ? { started: false, why: "no_slot" } : second;
    },
  };
}
