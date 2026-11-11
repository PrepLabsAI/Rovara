// A project's setup check: the owner asks for the project's setup commands and then its test commands to run on a fresh workspace at a revision of the project. No model runs and no budget is asked.
//
// Starting a check writes, in ONE transaction, the workspace and its preparation (what a task start writes for its own) and the check's own record. The preparation runs the revision's setup commands and then its
// readiness (test) commands on a worker; the check ends with the preparation. The status is never stored: `setupStateOf` derives it on every read from the project's `setupCheck` mark and the check's workspace:
//   no mark -> unchecked; a newer revision exists -> outdated; the workspace is PREPARING -> checking (failed after 50 minutes: the limit a stalled check fails at); PREPARATION_FAILED -> failed, with the failing step read
//   from the preparation's recorded error; anything else -> ready. A workspace the check closed reads as the status it had when it closed (`closedFrom`).
// When the check ends, the flow closes its workspace and its machine (`closeSetupCheck`), so a check keeps no worker running.
//
// A CANDIDATE check is the proof a setup proposal needs before it can be applied (`apply.ts`): it runs on a revision of the project that is stored but not yet the project's latest, so what is being proved reaches
// no task until the owner approves it, and its mark is kept on the proposal, not on the project.
import {
  INDEX_EXPIRY_ATTRIBUTE, agentXError, change, formatCommandLine, projectMetaKey, redactText, when, workspaceProjectIndexAttributes,
  type DocumentKey, type ProjectDefinition, type TransactItem,
} from "@agentx/contracts";
import { taskOwnerKey } from "../../developer/task-records.js";
import { buildOperation } from "../task-flow/accept.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { workspaceKey } from "../task-flow/keys.js";
import { fromDocument, toDocument, type WorkspaceRecord } from "../task-flow/records.js";
import { iso, log, newId } from "../task-flow/support.js";
import { releaseAdmission } from "../task-flow/admission.js";

/** The longest a preparation may be PREPARING before the check reads as failed. */
export const SETUP_CHECK_STUCK_MS = 50 * 60_000;
export const STALLED_STEP = "setup did not finish";
const FAILED_REASON_MAX = 300;
const COMMAND_SHOWN_MAX = 160;

export interface SetupCheckMark { workspaceId: string; revision: number; startedAt: string; startedBy: string }

export interface SetupState {
  status: "unchecked" | "outdated" | "checking" | "failed" | "ready";
  checkedRevision?: number;
  checkedAt?: string;
  failedStep?: string;
}

type CheckedDefinition = Pick<ProjectDefinition, "revision" | "setup" | "readiness">;

const first = (text: string, limit: number): string => [...text].slice(0, limit).join("").trimEnd();
/** Text for a person's screen: redacted, on one line, with every control and format character (escapes, direction overrides) turned into a space. */
const oneLine = (text: string): string => redactText(text).replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();

/**
 * The failing step as the page shows it: `"setup: npm ci - <reason>"` or `"test: npm test - <reason>"`. The stage and command come from the failure the worker recorded (`setup step 0 (...)`, `readiness check 1 (...)`),
 * looked up in the revision that was checked; a failure that names neither (a clone, a devcontainer) is `"setup: <reason>"`. The reason is the first 300 characters of the recorded, redacted error, on one line.
 */
export function failedStepOf(error: string, definition: Pick<CheckedDefinition, "setup" | "readiness">): string {
  const named = /^(setup step|readiness check) (\d{1,4}) \(/u.exec(error);
  const reason = first(oneLine(error), FAILED_REASON_MAX);
  if (named === null) return reason === "" ? "setup" : `setup: ${reason}`;
  const stage = named[1] === "setup step" ? "setup" : "test";
  const run = (stage === "setup" ? definition.setup : definition.readiness)[Number(named[2])];
  const shown = run === undefined ? "" : first(oneLine(formatCommandLine(run)), COMMAND_SHOWN_MAX);
  return `${stage}:${shown === "" ? "" : ` ${shown}`}${reason === "" ? "" : ` - ${reason}`}`;
}

/** The error the check's preparation recorded, or undefined when it recorded none. */
async function recordedFailure(deps: Pick<TaskFlowDeps, "store">, workspaceId: string): Promise<string | undefined> {
  const page = await deps.store.query({ pk: workspaceKey(workspaceId).pk, sk: { op: "beginsWith", prefix: "OPERATION#" } });
  const prepares = page.items.filter((item) => item["kind"] === "prepare" && typeof item["error"] === "string");
  const created = (item: { [attribute: string]: unknown }): string => (typeof item["createdAt"] === "string" ? item["createdAt"] : "");
  prepares.sort((a, b) => created(a).localeCompare(created(b)));
  const latest = prepares.at(-1);
  return typeof latest?.["error"] === "string" ? latest["error"] : undefined;
}

/** The status of one check (the project's own, or a proposal's candidate check): derived from the check's workspace on every read. */
export async function setupStateOfCheck(deps: Pick<TaskFlowDeps, "store" | "now">, check: SetupCheckMark | undefined, definition: CheckedDefinition): Promise<SetupState> {
  if (check === undefined) return { status: "unchecked" };
  const checked = { checkedRevision: check.revision, checkedAt: check.startedAt };
  if (check.revision < definition.revision) return { status: "outdated", ...checked };
  const workspace = await deps.store.get(workspaceKey(check.workspaceId));
  if (workspace === undefined || typeof workspace["status"] !== "string") return { status: "unchecked" };
  // A closed workspace reads as it did when it closed; one closed with no record of that (never PREPARING, or failed) reads ready.
  const status = workspace["status"] === "CLOSED" && typeof workspace["closedFrom"] === "string" ? workspace["closedFrom"] : workspace["status"];
  if (status === "PREPARING") {
    const started = Date.parse(check.startedAt);
    // A preparation nobody finished: it reads as failed, so the person is told and a new check may start.
    if (Number.isFinite(started) && (deps.now?.() ?? new Date()).getTime() - started > SETUP_CHECK_STUCK_MS) return { status: "failed", ...checked, failedStep: STALLED_STEP };
    return { status: "checking", ...checked };
  }
  if (status === "PREPARATION_FAILED") {
    const error = await recordedFailure(deps, check.workspaceId);
    return { status: "failed", ...checked, ...(error === undefined ? {} : { failedStep: failedStepOf(error, definition) }) };
  }
  return { status: "ready", ...checked };
}

/** The setup status of a project, derived from its META and the check's workspace on every read. */
export async function setupStateOf(deps: Pick<TaskFlowDeps, "store" | "now" | "companyId">, project: string, definition: CheckedDefinition): Promise<SetupState> {
  const meta = await deps.store.get(projectMetaKey(deps.companyId, project));
  const mark = meta?.["setupCheck"] as SetupCheckMark | undefined;
  return setupStateOfCheck(deps, mark, definition);
}

/** What a start is told when the project's last setup check failed; `step` is the status's own failing step (redacted, on one line, cut), or "setup" when none was recorded. */
export const setupFailedMessage = (step: string): string => `This project's setup failed its last check (${step}). Fix the setup and check it again, or ask Rovara to set it up, before starting work.`;

/** The record that ties a check's workspace to what started it: the flow reads it when the preparation ends, to close the workspace and the machine. */
export const setupCheckRecordKey = (workspaceId: string): DocumentKey => ({ pk: workspaceKey(workspaceId).pk, sk: "SETUP_CHECK" });

export interface StartedCheck { workspaceId: string; mark: SetupCheckMark; /** What the start must write in its own transaction. */ items: TransactItem[]; operationId: string }

/**
 * The items of a check's start, for the caller's transaction: the workspace, its preparation (and the staged dispatch message) and the check's record. `revision` must be stored (the preparation reads it). The caller
 * adds its own items (the project's mark, or a proposal's) and commits, then calls `relayCheck`.
 */
export function buildSetupCheck(deps: TaskFlowDeps, input: { project: string; revision: number; startedBy: string; requestId: string; candidate: boolean }): StartedCheck {
  const now = iso(deps);
  const workspaceId = newId(deps);
  const prepareOperationId = newId(deps);
  const ownerKey = taskOwnerKey(input.startedBy, workspaceId);
  const workspace: WorkspaceRecord = {
    ...workspaceKey(workspaceId), sk: "META", entityType: "WORKSPACE", id: workspaceId, companyId: deps.companyId, orgId: deps.companyId, ownerKey, projectName: input.project, projectRevision: input.revision,
    status: "PREPARING", activeOperationId: prepareOperationId, fence: 1,
    ...workspaceProjectIndexAttributes({ orgId: deps.companyId, projectName: input.project, createdAt: now }),
    createdAt: now, updatedAt: now,
  };
  const prepare = buildOperation(deps, {
    workspace, kind: "prepare", requestId: input.requestId, operationId: prepareOperationId, now, recordRequest: false,
    dispatch: { kind: "prepare", projectRevision: input.revision, payload: {} },
  });
  const mark: SetupCheckMark = { workspaceId, revision: input.revision, startedAt: now, startedBy: input.startedBy };
  const items: TransactItem[] = [
    { kind: "put", item: toDocument(workspace), condition: when.absent() },
    ...prepare.items,
    { kind: "put", item: { ...setupCheckRecordKey(workspaceId), entityType: "SETUP_CHECK", companyId: deps.companyId, project: input.project, workspaceId, revision: input.revision, candidate: input.candidate, createdAt: now, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(Date.parse(now) / 1000) + 31 * 86_400 }, condition: when.absent() },
  ];
  return { workspaceId, mark, items, operationId: prepare.operation.id };
}

/** Hands the check's dispatch message to its queue now; a relay from a timer does it too if this one is lost, so a failure here never fails the start. */
export async function relayCheck(deps: TaskFlowDeps, started: Pick<StartedCheck, "operationId">): Promise<void> {
  await deps.outbox.relay({ companyId: deps.companyId, ids: [started.operationId] }).catch((error: unknown) => log(deps, { event: "setup_check.relay_failed", error: error instanceof Error ? error.name : "unknown" }));
}

/**
 * Starts the project's own check at its latest revision. A repeat of the request answers the first check. A check already running for this revision is not started again (`WORKSPACE_BUSY`).
 * The project's `setupCheck` mark is written in the start's transaction and holds only while the mark is the one the start read.
 */
export async function startProjectSetupCheck(deps: TaskFlowDeps, input: { project: string; requestId: string; startedBy: string }): Promise<{ workspaceId: string; duplicate: boolean }> {
  const latest = await deps.projects.latest(input.project);
  if (latest === undefined) throw agentXError("PROJECT_NOT_FOUND", `project \`${input.project}\` doesn't exist`);
  if (latest.archived === true) throw agentXError("PROJECT_ARCHIVED", `project \`${input.project}\` is archived; unarchive it to start new work`);
  const metaKey = projectMetaKey(deps.companyId, input.project);
  const meta = await deps.store.get(metaKey);
  const seen = meta?.["setupCheck"] as SetupCheckMark | undefined;
  const requestKey: DocumentKey = { pk: metaKey.pk, sk: `SETUP_CHECK_REQUEST#${input.requestId}` };
  const replay = await deps.store.get(requestKey);
  if (replay !== undefined) {
    if (replay["by"] !== input.startedBy || typeof replay["workspaceId"] !== "string") throw agentXError("IDEMPOTENCY_CONFLICT", "this request id was already used for another check; use a new one");
    return { workspaceId: replay["workspaceId"], duplicate: true };
  }
  if (seen !== undefined) {
    const state = await setupStateOfCheck(deps, seen, latest.definition);
    if (state.status === "checking") throw agentXError("WORKSPACE_BUSY", "A setup check of this project is already running.");
  }
  const started = buildSetupCheck(deps, { project: input.project, revision: latest.definition.revision, startedBy: input.startedBy, requestId: input.requestId, candidate: false });
  const result = await deps.store.transact([
    ...started.items,
    { kind: "put", item: { ...requestKey, entityType: "SETUP_CHECK_REQUEST", by: input.startedBy, workspaceId: started.workspaceId, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor((deps.now?.().getTime() ?? Date.now()) / 1000) + 86_400 }, condition: when.absent() },
    seen === undefined
      ? { kind: "update", key: metaKey, ops: [change.set("setupCheck", { ...started.mark })], condition: when.notExists("setupCheck") }
      : { kind: "update", key: metaKey, ops: [change.set("setupCheck", { ...started.mark })], condition: when.eq(["setupCheck", "workspaceId"], seen.workspaceId) },
  ]);
  if (!result.applied) throw agentXError("WORKSPACE_BUSY", "The project's setup check changed just now; try again with the same request id.");
  await relayCheck(deps, started);
  return { workspaceId: started.workspaceId, duplicate: false };
}

/**
 * A check's preparation ended: the workspace is closed (it keeps the status it had, as `closedFrom`) and its machine is terminated, so a finished check keeps nothing running. Idempotent; a workspace that is not a
 * check's is left alone. Never throws into the flow.
 */
export async function closeSetupCheck(deps: TaskFlowDeps, workspaceId: string): Promise<boolean> {
  try {
    const record = await deps.store.get(setupCheckRecordKey(workspaceId));
    if (record === undefined || record["companyId"] !== deps.companyId) return false;
    const workspace = fromDocument<WorkspaceRecord>(await deps.store.get(workspaceKey(workspaceId)));
    if (workspace === undefined || workspace.status === "CLOSED" || workspace.status === "PREPARING") return false;
    const now = iso(deps);
    const closed = await deps.store.update({
      key: workspaceKey(workspaceId),
      ops: [change.set("closedFrom", workspace.status), change.set("status", "CLOSED"), change.set("activeOperationId", null), change.set("closedAt", now), change.set("fence", workspace.fence + 1), change.set("updatedAt", now)],
      condition: when.and(when.eq("fence", workspace.fence), when.eq("status", workspace.status)),
    });
    if (!closed.applied) return false;
    if (workspace.machine !== undefined) await deps.machines.terminate(workspace.machine.machineId).catch((error: unknown) => log(deps, { event: "setup_check.terminate_failed", error: error instanceof Error ? error.name : "unknown" }));
    await releaseAdmission(deps, workspace.machineReservationId);
    return true;
  } catch (error) {
    log(deps, { event: "setup_check.close_failed", error: error instanceof Error ? error.name : "unknown" });
    return false;
  }
}

