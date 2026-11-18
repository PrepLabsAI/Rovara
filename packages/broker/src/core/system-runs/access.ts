// The access rule for a project's SYSTEM OWNER on a hosted install (lead 4 L4-P1; owner DEC 254zzl 1). Members' rules are NOT here and do not change: a person is still a live member with a project grant. This file decides
// one thing, whether a task started by "Rovara (project: X)" may start and go on, and it answers yes only when ALL of these hold:
//   - the company's SystemRuns flag is on (read now, by the caller);
//   - the principal is exactly the system owner of THIS company and THIS project (its id is derived from both, so another project's or company's system owner never matches, whatever it claims) and no one signed in as it;
//   - the task is for one of the closed list of system purposes (`SYSTEM_TASK_PURPOSES`) that this phase has switched on: today only the model-free nightly run. The AI purposes (a repair draft is a `setup_agent` task, a
//     wiki refresh a `wiki_build` task) are named so P2 flips one line, and are refused until then, flag or no flag.
// A step of a task whose developer is a system owner takes this rule and no other (it never falls through to the member rules, which it could not pass), and reads the task's own stored row, never the caller's word.
import { SYSTEM_OWNER_PROVIDER, SYSTEM_RUN_FREE_KINDS, UPKEEP_ORIGIN, isSystemOwnerId, systemOwnerIdOf, type OrgId, type Principal, type SystemRunKind } from "@agentx/contracts";

export const SYSTEM_OWNER_NOT_ALLOWED = "Rovara's own runs are not allowed here.";

/** Each task purpose a system owner could ever be given, and the kind it is. A purpose that is not here is never a system owner's. */
export const SYSTEM_TASK_PURPOSES: Readonly<Record<string, SystemRunKind>> = { nightly_run: "nightly_check", setup_agent: "repair_draft", wiki_build: "wiki_refresh" };

/**
 * The purposes this phase accepts: the free ones, and (L4-P2) the wiki refresh, the one AI kind whose money is held (the night's refresh goes through `startUnattendedRun`: an enforced dollar cap, admission, and the
 * gateway's upkeep cap on its `nightly` origin). The repair draft (`setup_agent`) stays NAMED AND REFUSED: nothing starts it on hosted yet. A system owner is not given an AI purpose by a flag alone: the wiki refresh
 * needs the marks below.
 */
export const SYSTEM_RUN_KINDS_LIVE: readonly SystemRunKind[] = [...SYSTEM_RUN_FREE_KINDS, "wiki_refresh"];

/**
 * The marks a wiki refresh carries, which a wiki build by anyone else does not (L4-P2, REVIEW-1 L4 of P1: the purpose `wiki_build` alone is not enough, a person's build has it too):
 *   - AT THE START, the work origin `nightly`: set only by `createUpkeepWikiStarter` (a person's starter refuses it);
 *   - AT EVERY STEP, the project's build pointer: it names THIS task, says `unattended` and names the project's system owner as who it runs for. Only `prepareUnattendedWikiRefresh` writes `unattended`.
 */
export interface WikiRefreshMark { taskId: string; unattended: boolean; requestedBy: string }
const isWikiPurpose = (purpose: unknown): boolean => purpose === "wiki_build";

/** The kind a task purpose is, when this phase accepts a system owner for it. Anything else (an ordinary task, an unknown purpose, an AI purpose before P2): undefined. */
export function liveSystemKindOf(purpose: unknown): SystemRunKind | undefined {
  if (typeof purpose !== "string" || !Object.prototype.hasOwnProperty.call(SYSTEM_TASK_PURPOSES, purpose)) return undefined;
  const kind = SYSTEM_TASK_PURPOSES[purpose]!;
  return SYSTEM_RUN_KINDS_LIVE.includes(kind) ? kind : undefined;
}

/** The principal a system start is made as: the project's system owner, which signs in nowhere. */
export function systemPrincipalOf(orgId: OrgId, project: string, displayName: string): Principal {
  return { companyId: orgId, personId: systemOwnerIdOf(orgId, project), displayName, roles: [], provider: SYSTEM_OWNER_PROVIDER };
}

export type SystemAccessVerdict = { allowed: true } | { allowed: false };

export interface SystemAccessInputs {
  companyId: OrgId;
  /** The build pointer's mark of this task, read by the host from the task's own project (step only). Absent or any other task: no mark. */
  wikiRefreshMark?: WikiRefreshMark | undefined;
  /** The company's SystemRuns flag, read now. Absent: a system owner is never accepted. */
  systemRunsOn?: (() => boolean) | undefined;
}

/** Whether this principal is a system owner at all (by its id shape and its provider). A person's principal never is. */
export const isSystemPrincipal = (principal: Pick<Principal, "personId" | "provider">): boolean => isSystemOwnerId(principal.personId) || principal.provider === SYSTEM_OWNER_PROVIDER;

/** A start by a system principal. A principal that is not one is not decided here (the member rule decides it). */
export function systemStartVerdict(inputs: SystemAccessInputs, principal: Principal, project: string, purpose: string | undefined, origin?: string): SystemAccessVerdict {
  if (inputs.systemRunsOn?.() !== true) return { allowed: false };
  if (principal.companyId !== inputs.companyId || principal.provider !== SYSTEM_OWNER_PROVIDER) return { allowed: false };
  if (principal.personId !== systemOwnerIdOf(inputs.companyId, project)) return { allowed: false };
  if (liveSystemKindOf(purpose) === undefined) return { allowed: false };
  // A wiki refresh is started only by the wiki-refresh starter, which alone sets the origin `nightly`.
  if (isWikiPurpose(purpose) && origin !== UPKEEP_ORIGIN) return { allowed: false };
  return { allowed: true };
}

/** What a stored task row says, as read by the hosted rule from the task's own META row. */
export type StoredSystemTask = Readonly<Record<string, unknown>>;

/**
 * A step of a task whose developer is a system owner. The stored row must agree with the step on company, project and developer; the developer must be exactly this project's system owner; the row's own purpose must be
 * a live system purpose (the nightly run's mark is on the row as `automatic.purpose`, the setup and wiki runs' is `purpose`).
 */
export function systemStepVerdict(inputs: SystemAccessInputs, task: { taskId?: string; developerId: string; project: string }, stored: StoredSystemTask | undefined): SystemAccessVerdict {
  if (inputs.systemRunsOn?.() !== true || stored === undefined) return { allowed: false };
  if (stored["companyId"] !== inputs.companyId || stored["developerId"] !== task.developerId || stored["project"] !== task.project) return { allowed: false };
  if (task.developerId !== systemOwnerIdOf(inputs.companyId, task.project)) return { allowed: false };
  const automaticPurpose = typeof stored["automatic"] === "object" && stored["automatic"] !== null ? (stored["automatic"] as { purpose?: unknown }).purpose : undefined;
  const purpose = stored["purpose"] ?? automaticPurpose;
  if (liveSystemKindOf(purpose) === undefined) return { allowed: false };
  // A wiki refresh's steps go on only while the project's build pointer still names THIS task as the unattended run for this project's system owner.
  if (isWikiPurpose(purpose)) {
    const mark = inputs.wikiRefreshMark;
    if (mark === undefined || task.taskId === undefined || mark.taskId !== task.taskId || mark.unattended !== true || mark.requestedBy !== task.developerId) return { allowed: false };
  }
  return { allowed: true };
}
