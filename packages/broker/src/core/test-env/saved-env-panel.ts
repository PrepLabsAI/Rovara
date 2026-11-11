// What the project's Environment panel shows of the saved environment image, and its Reset. The panel carries fixed words, counts and times only (contracts `app-saved-env.ts`): no
// digest, repository, command or secret. Reset is for a maintainer of the project: the role is checked HERE, from the role the route read for the caller, before any row is written; a viewer or a contributor
// changes nothing and is not audited as having asked. With the saved-environments switch off the panel does not exist (`disabled`).
import { SAVED_ENV_PANEL_FAILURES, projectAllows, type ProjectRole, type SavedEnvPanel } from "@agentx/contracts";
import { requestReset, type SavedEnvDeps, type SavedEnvState } from "./saved-env.js";

const DAY_MS = 86_400_000;

/** The fixed word of a failure, or "failed" for anything else (a stored reason is never passed on as text). */
function failureWord(stored: string): (typeof SAVED_ENV_PANEL_FAILURES)[number] {
  return SAVED_ENV_PANEL_FAILURES.find((word) => word === stored) ?? "failed";
}

/** The panel for a project row (or none yet). Pure. */
export function panelView(state: SavedEnvState | undefined, nowMs: number, role: ProjectRole): SavedEnvPanel {
  const image = state?.images[0];
  const job = state?.job;
  const live = job !== undefined && Date.parse(job.leaseUntil) > nowMs;
  const failure = state?.lastFailureAt !== undefined && state.lastFailure !== undefined ? { at: state.lastFailureAt, reason: failureWord(state.lastFailure) } : undefined;
  const rebuild = live ? { state: job.dispatchedAt === undefined ? "queued" as const : "running" as const, reason: job.reason } : state?.resetRequested === true ? { state: "queued" as const, reason: "reset" as const } : undefined;
  return {
    health: state?.health ?? "never_proved",
    ...(image === undefined ? {} : { image: { builtAt: image.recordedAt, ageDays: Math.max(0, Math.floor((nowMs - Date.parse(image.recordedAt)) / DAY_MS)), status: image.status } }),
    ...(rebuild === undefined ? {} : { rebuild }),
    ...(state?.lastRebuildReason === undefined ? {} : { lastRebuildReason: state.lastRebuildReason }),
    ...(failure === undefined ? {} : { lastFailure: failure }),
    canReset: projectAllows(role, "edit_settings") && state?.archived !== true && state?.deleted !== true,
    // SV-1l: the project's own setting (on until a maintainer turns it off, as `setProjectEnabled` reads it), and whether to offer its control: the same right the setting route checks.
    enabled: state?.enabled ?? true,
    canChangeSetting: projectAllows(role, "edit_settings"),
  };
}

export type PanelResult = { ok: true; panel: SavedEnvPanel } | { ok: false; reason: "disabled" };

export async function savedEnvPanel(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }, caller: { projectRole: ProjectRole }): Promise<PanelResult> {
  if (!deps.session.config.enabled) return { ok: false, reason: "disabled" };
  return { ok: true, panel: panelView(await deps.store.get(ids.orgId, ids.projectId), deps.now(), caller.projectRole) };
}

export type ResetResult = { ok: true; status: "queued" | "in_flight" | "cooldown" | "nothing_to_do"; panel: SavedEnvPanel } | { ok: false; reason: "disabled" | "not_maintainer" | "stale_write" };

/** A maintainer pressed Reset: a rebuild is queued now (a fresh backoff does not apply), unless one is already waiting or running, a Reset was asked in the last 15 minutes, or this very press was already seen (`requestId`). `actorId` is the person, recorded in the audit entry. */
export async function resetFromPanel(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }, caller: { actorId: string; projectRole: ProjectRole; requestId: string }): Promise<ResetResult> {
  if (!deps.session.config.enabled) return { ok: false, reason: "disabled" };
  if (!projectAllows(caller.projectRole, "edit_settings")) return { ok: false, reason: "not_maintainer" };
  const checked = await requestReset(deps, ids, caller.actorId, caller.requestId);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  const panel = panelView(await deps.store.get(ids.orgId, ids.projectId), deps.now(), caller.projectRole);
  const status = checked.queued || checked.why === "duplicate" ? "queued" : checked.why === "in_flight" || checked.why === "cooldown" ? checked.why : "nothing_to_do";
  return { ok: true, status, panel };
}
