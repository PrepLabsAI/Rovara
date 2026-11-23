// The close guard: what stops a close nobody previewed from deleting a workspace that may hold work no pull request has. It decides from POSITIVE proof only: a close is allowed when the workspace never had a
// machine, or when the machine's session is provably gone (no session item, or one that is DELETED / NONE / a first provisioning that never reached READY). Every other state of a machine-backed workspace is
// refused in a person's hands (G3 a retained preview exists; G4a a check is queued or running; G4b no check can be started) and SKIPPED, never deleted, in the system's. Unknown is a refusal: a read that throws,
// a session item that does not read, a provider that throws never becomes an allowance.
//
// This module only decides. The close itself (close.ts) writes it, under the conditions the proof carries, so the decision still holds at the commit: a dispatch that records a machine, or a session that is
// created again, between the read and the commit makes the close conflict instead of closing a workspace that had work. There is NO force path: the bound, previewed discard is the only way to close with
// unpublished work.
import { when, workspaceSessionKey, type Condition, type JsonValue, type TransactItem } from "@agentx/contracts";
import { wikiBuildRunKey } from "../wiki-build/keys.js";
import { SYSTEM_CLOSE_PROVIDER } from "./close-acceptance-record.js";
import { closeRefusalWords, type CloseRefusalReason } from "./close-words.js";
import { readCloseSnapshot, type CloseSnapshot } from "./close-inspection.js";
import type { TaskCaller, TaskFlowDeps } from "./deps.js";
import { readTask } from "./reads.js";
import type { TaskRecord, WorkspaceRecord } from "./records.js";
import { isTerminalStatus, readOperation } from "./results.js";
import { readWorkspace } from "./stage-machine.js";
import { log } from "./support.js";

/** Turning the guard on. It carries no switch: an install is given the guard together with the retention provider, or neither (`assertCloseGuardComposition`). */
export interface CloseGuardPort { readonly enforce: true }

/** The one guard value both roots wire (it carries no setting: an install has the guard with the provider or neither). */
export const CLOSE_GUARD: CloseGuardPort = { enforce: true };

/** Asks for a check of a workspace's unpublished work. The guard never starts a machine: the implementation enqueues ONE preparation per fence (idempotent), which wakes a stopped machine and inspects it. */
export interface CloseCheckPort {
  request(task: TaskRecord, workspace: WorkspaceRecord, deps: TaskFlowDeps): Promise<"queued" | "already" | "unsupported">;
}

/** Why a close is allowed without a preview. */
export type CloseBasis = "no_machine" | "machine_gone" | "forgotten_machine" | "exempt_setup_run" | "exempt_wiki_build";

/** The facts an allowed close commits under, so the allowance still holds when it is written. */
export interface CloseProof {
  basis: CloseBasis;
  /** Added to the workspace's own update (beside the fence). */
  workspaceConditions: Condition[];
  /** A check on the session item, in the same transaction. */
  sessionCheck?: TransactItem;
}

export type CloseMode = "person" | "system";

export type CloseDecision =
  /** Close it, under this proof. */
  | { kind: "close"; proof: CloseProof }
  /** SYSTEM only: a retained inspection says it is safe, so the close goes through the bound path with that digest (never a discard). */
  | { kind: "bound"; snapshot: CloseSnapshot }
  /** A person's close is refused with these exact words; nothing was closed. */
  | { kind: "refuse"; reason: CloseRefusalReason; words: string }
  /** The system's close is skipped with these words: nothing written, nothing terminated; the caller keeps the task and tries again later. */
  | { kind: "skip"; reason: CloseRefusalReason; words: string };

/** What the session item says about the machine's compute. `unknown` never allows a close. */
type SessionEvidence =
  | { kind: "gone"; condition: Condition }
  /** The session may hold the work (any state with a volume, or about to have one). */
  | { kind: "kept" }
  /** A first provisioning FAILED is proven empty (`gone`); any other FAILED cannot be proven: no wake would help, and a wake would build a fresh empty volume. */
  | { kind: "unproven_failed" }
  | { kind: "unknown" };

const SESSION_STATES = new Set(["NONE", "PROVISIONING", "READY", "STOPPING", "STOPPED", "FAILED", "DELETING", "DELETED"]);

const sameOrAbsent = (path: string, value: JsonValue | undefined): Condition => (value === undefined ? when.notExists(path) : when.eq(path, value));

/** Reads the session item as a stored document (the real table's item carries extra attributes, so it is never schema-parsed whole). */
export function sessionEvidenceOf(document: Record<string, unknown> | undefined): SessionEvidence {
  if (document === undefined) return { kind: "gone", condition: when.absent() };
  const state = document["state"], generation = document["generation"];
  if (typeof state !== "string" || !SESSION_STATES.has(state) || typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) return { kind: "unknown" };
  const exactly = [when.eq("state", state), when.eq("generation", generation)];
  if (state === "DELETED" || state === "NONE") return { kind: "gone", condition: when.and(...exactly) };
  if (state !== "FAILED") return { kind: "kept" };
  // FAILED only means provisioning failed. It proves nothing was ever held only for the FIRST generation that never reached READY: a later generation may sit on the volume of an earlier one that did work, and a
  // READY generation sets `readyAt`, `lastActivityAt` and the worker's feature list (a new generation clears only `readyAt`, so the generation number is part of the proof).
  const neverReady = generation === 1 && document["readyAt"] === undefined && document["lastActivityAt"] === undefined && document["workerFeatures"] === undefined;
  if (!neverReady) return { kind: "unproven_failed" };
  return { kind: "gone", condition: when.and(...exactly, when.notExists("readyAt"), when.notExists("lastActivityAt"), when.notExists("workerFeatures")) };
}

/** A machine, a reservation or a count of machines ever recorded: any of them proves a machine existed. A forgotten machine (`forgetMachine` removes the first two) keeps its count. */
const hadMachine = (workspace: WorkspaceRecord): boolean => workspace.machine !== undefined || workspace.machineReservationId !== undefined || (workspace.machineGeneration ?? 0) > 0;

function goneProof(task: TaskRecord, workspace: WorkspaceRecord | undefined, evidence: Extract<SessionEvidence, { kind: "gone" }>): CloseProof {
  const sessionCheck: TransactItem = { kind: "check", key: workspaceSessionKey(task.workspaceId), condition: evidence.condition };
  if (workspace === undefined) return { basis: "no_machine", workspaceConditions: [], sessionCheck };
  // The counts and the holder as they were read: a dispatch that records a machine (or records the next one) between the read and the commit changes them. The machine id alone proves nothing on
  // hosted (it is derived from the workspace id, so a re-created session has the same one): the generation and the session item do.
  const common = [sameOrAbsent("machineGeneration", workspace.machineGeneration), sameOrAbsent("activeOperationId", workspace.activeOperationId)];
  if (!hadMachine(workspace)) return { basis: "no_machine", workspaceConditions: [when.notExists("machine"), when.notExists("machineReservationId"), ...common], sessionCheck };
  const machine = workspace.machine === undefined ? when.notExists("machine") : when.eq("machine.machineId", workspace.machine.machineId);
  return { basis: workspace.machine === undefined ? "forgotten_machine" : "machine_gone", workspaceConditions: [machine, ...common], sessionCheck };
}

/**
 * A run that is over and has written its product before it closes (a setup run's `agentRunEnd`, a wiki build's end word): its scratch workspace holds nothing a person owns. Decided here from the task
 * and the run's own record, never from a flag a caller passes; without the proof the close is guarded like any other.
 */
async function exemptByType(deps: TaskFlowDeps, task: TaskRecord): Promise<"exempt_setup_run" | "exempt_wiki_build" | undefined> {
  if (task.purpose === "setup_agent") return (await readTask(deps, task.taskId))?.agentRunEnd === undefined ? undefined : "exempt_setup_run";
  if (task.purpose !== "wiki_build") return undefined;
  const pointer = await deps.store.get(wikiBuildRunKey({ orgId: deps.companyId, project: task.project }));
  return pointer?.["taskId"] === task.taskId && typeof pointer["end"] === "object" && pointer["end"] !== null ? "exempt_wiki_build" : undefined;
}

/** The caller a retained read needs: its person only names who the digest is for (a system closer is its own actor). */
const callerOf = (deps: TaskFlowDeps, actorId: string): TaskCaller => ({ principal: { companyId: deps.companyId, personId: actorId, displayName: "Rovara", roles: [], provider: SYSTEM_CLOSE_PROVIDER } });

const refusal = (mode: CloseMode, reason: CloseRefusalReason, taskId: string): CloseDecision => ({ kind: mode === "person" ? "refuse" : "skip", reason, words: closeRefusalWords(reason, taskId) });

/** What holds the workspace: nothing (`idle`), a close operation (`check`: a check or an accepted close is running), a step of the task, or something unreadable (`unknown`). */
async function holderOf(deps: TaskFlowDeps, workspace: WorkspaceRecord): Promise<"idle" | "check" | "step" | "unknown"> {
  if (workspace.activeOperationId === null) return "idle";
  const holder = await readOperation(deps, workspace.id, workspace.activeOperationId);
  if (holder === undefined) return "unknown";
  if (isTerminalStatus(holder.status)) return "idle";
  return holder.kind === "close" ? "check" : "step";
}

async function decide(deps: TaskFlowDeps, task: TaskRecord, actorId: string, mode: CloseMode): Promise<CloseDecision> {
  const exempt = await exemptByType(deps, task);
  if (exempt !== undefined) return { kind: "close", proof: { basis: exempt, workspaceConditions: [] } };
  const workspace = await readWorkspace(deps, task.workspaceId);
  const evidence = sessionEvidenceOf(await deps.store.get(workspaceSessionKey(task.workspaceId)));
  if (evidence.kind === "gone") return { kind: "close", proof: goneProof(task, workspace, evidence) };
  if (evidence.kind === "unknown" || workspace === undefined) return refusal(mode, "cannot_check", task.taskId);
  // Machine-backed from here. A retained inspection is the preview's: only the bound path may destroy it.
  const snapshot = await readCloseSnapshot(deps, callerOf(deps, actorId), task, "close").catch(() => undefined);
  if (snapshot !== undefined) return mode === "system" && snapshot.inspection.safeToClose ? { kind: "bound", snapshot } : refusal(mode, "retained", task.taskId);
  if (evidence.kind === "unproven_failed" || deps.closeCheck === undefined) return refusal(mode, "cannot_check", task.taskId);
  const holder = await holderOf(deps, workspace);
  if (holder === "check") return refusal(mode, "checking", task.taskId);
  // A step is running (or the holder is unreadable): a check cannot start under it. Stop the task first.
  if (holder !== "idle") return refusal(mode, "cannot_check", task.taskId);
  // The ONE write a refusal may make: the single, idempotent request for a check (never a machine started here, never a write to the task, the workspace or the machine).
  const answer = await deps.closeCheck.request(task, workspace, deps);
  return refusal(mode, answer === "unsupported" ? "cannot_check" : "checking", task.taskId);
}

/** What a close of this task may do. Never throws: anything that cannot be read is a refusal (or a skip), never an allowance. */
export async function decideClose(deps: TaskFlowDeps, task: TaskRecord, actorId: string, mode: CloseMode): Promise<CloseDecision> {
  try {
    return await decide(deps, task, actorId, mode);
  } catch (error) {
    log(deps, { event: "task_flow.close_guard_unreadable", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
    return refusal(mode, "cannot_check", task.taskId);
  }
}

/**
 * Startup assertion (Q1): the guard and the retention provider are wired together or not at all. A guard without a provider leaves every machine-backed close stuck; a provider without the guard leaves the
 * unbound hole open. Throws when exactly one of them is set.
 */
export function assertCloseGuardComposition(options: { closeGuard?: unknown; closeInspection?: unknown; closeCheck?: unknown }): void {
  const guard = options.closeGuard !== undefined, provider = options.closeInspection !== undefined;
  if (guard !== provider) throw new Error(guard ? "closeGuard is wired without closeInspection: every machine-backed close would be refused" : "closeInspection is wired without closeGuard: an unbound close would still delete unchecked");
  // The guard without the check seam refuses every machine-backed close that has no preview for ever: nothing would ever ask for one.
  if (guard && options.closeCheck === undefined) throw new Error("closeGuard is wired without closeCheck: a task with no preview could never be checked, so its close would be refused for ever");
}
