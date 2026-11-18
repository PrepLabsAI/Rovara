// Nightly upkeep's switch (lead 4 N1; design setup-upkeep-plan.md 2.2): ONE setting per project, OFF by default.
//
//   - A project is ON only when its own row says `enabled: true` (the row is the project's own: company and project in its key AND in its body, and a row naming another company or project reads as OFF). No row, a damaged
//     row, an unreadable store: OFF. Nothing install-wide (an environment variable, a default) can turn it on for a project.
//   - Turning it ON or OFF is an act of a company owner or admin, or the project's administrator, on the setup PAGE (`fromPage`): a token, a script or an assistant cannot (the same rule as an automation trigger). The
//     audit record is written BEFORE the row (an act whose record cannot be written is not done), and a repeat of a request id is one act.
//   - The schedule follows the switch: ON puts the project's upkeep night on the scheduler, OFF removes it. A schedule that could not be changed is thrown AFTER the row is written (the switch is what is true; a retry of
//     the same request puts it right).
// The monthly dollar cap is NOT here: the gateway holds it (Cloud's `upkeep_month`), so no number written in Code can lift it.
import { UpkeepSwitchBodySchema, agentXError, type DocumentStore, type OrgId } from "@agentx/contracts";
import { upkeepSettingsKey, type UpkeepScope } from "./keys.js";

export const UPKEEP_WORDS = {
  notAllowed: "Only company owners and admins, or this project's admins, can switch nightly upkeep on or off.",
  onThePage: "Nightly upkeep is switched on or off on the project's setup page, by a person. A token or an assistant cannot.",
  projectNotFound: "project not found",
  unavailable: "Nightly upkeep isn't available on this Rovara yet",
  unreadable: "Nightly upkeep could not be read. Try again.",
  auditUnavailable: "That could not be recorded, so nothing was changed. Try again.",
} as const;

export type UpkeepAccess = "manage" | "view" | "none";
export interface UpkeepSettingsDeps {
  store: DocumentStore;
  companyId: OrgId;
  now: () => number;
  /** The caller's standing on the project, read live. Throws when it cannot be read (the act is refused). */
  standing(personId: string, project: string): Promise<{ access: UpkeepAccess }>;
  /**
   * The audit record of the act, written BEFORE it. Throws when it could not write. `previous` names the row this act replaces (its `changedAt`, or "none"): a host builds its event id from it, so the same
   * request id used for on, then off, then on again is three records and never one that the sink drops as a repeat.
   */
  record?: ((action: "upkeep_switched", project: string, details: { requestId: string; on: boolean; previous: string }) => Promise<void>) | undefined;
  /** The project's upkeep night on the scheduler: put when ON, removed when OFF. Absent: no schedule (a laptop with no scheduler). */
  schedule?: { put(scope: UpkeepScope): Promise<void>; remove(scope: UpkeepScope): Promise<void> } | undefined;
  /** Whether nightly runs really happen on this install (a system starter AND a schedule are wired). Absent: not available, and the page hides the switch (`upkeepView`, `upkeepSwitchControl`). */
  available?: (() => boolean | Promise<boolean>) | undefined;
}

export interface UpkeepSetting { enabled: boolean; changedAt?: string }

/** The project's switch as the store says now. Anything that is not exactly this company's and project's `enabled: true` row is OFF. Never throws. */
export async function readUpkeepSetting(deps: Pick<UpkeepSettingsDeps, "store" | "companyId">, project: string): Promise<UpkeepSetting> {
  try {
    const row = await deps.store.get(upkeepSettingsKey({ orgId: deps.companyId, project }));
    if (row === undefined || row["entityType"] !== "UPKEEP_SETTINGS" || row["orgId"] !== deps.companyId || row["project"] !== project) return { enabled: false };
    return { enabled: row["enabled"] === true, ...(typeof row["changedAt"] === "string" ? { changedAt: row["changedAt"] } : {}) };
  } catch {
    return { enabled: false };
  }
}

export async function upkeepIsOn(deps: Pick<UpkeepSettingsDeps, "store" | "companyId">, project: string): Promise<boolean> {
  return (await readUpkeepSetting(deps, project)).enabled;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Switches nightly upkeep on or off for one project. `fromPage`: set only by the setup page's own route (never a token's or a script's). */
export async function setUpkeepEnabled(deps: UpkeepSettingsDeps, input: { personId: string; project: string; requestId: string; on: boolean; fromPage: boolean }): Promise<UpkeepSetting & { changed: boolean }> {
  if (typeof input.on !== "boolean" || !UUID.test(input.requestId)) throw agentXError("CONFIG_INVALID", "the request is not valid");
  let access: UpkeepAccess;
  try { access = (await deps.standing(input.personId, input.project)).access; } catch { throw agentXError("FORBIDDEN", UPKEEP_WORDS.notAllowed); }
  if (access === "none") throw agentXError("PROJECT_NOT_FOUND", UPKEEP_WORDS.projectNotFound);
  if (access !== "manage") throw agentXError("FORBIDDEN", UPKEEP_WORDS.notAllowed);
  if (input.fromPage !== true) throw agentXError("FORBIDDEN", UPKEEP_WORDS.onThePage);
  const scope = { orgId: deps.companyId, project: input.project };
  const key = upkeepSettingsKey(scope);
  const before = await deps.store.get(key).catch(() => { throw agentXError("RUNTIME_UNAVAILABLE", UPKEEP_WORDS.unreadable); });
  // A repeat of this request (the same id AND the same choice) is one act: nothing more is recorded or written. The same id with the other choice is a new act.
  if (before?.["requestId"] === input.requestId && before["enabled"] === input.on && before["orgId"] === deps.companyId && before["project"] === input.project) return { enabled: before["enabled"] === true, ...(typeof before["changedAt"] === "string" ? { changedAt: before["changedAt"] } : {}), changed: false };
  if (deps.record !== undefined) {
    try { await deps.record("upkeep_switched", input.project, { requestId: input.requestId, on: input.on, previous: typeof before?.["changedAt"] === "string" ? before["changedAt"] : "none" }); } catch { throw agentXError("AUDIT_UNAVAILABLE", UPKEEP_WORDS.auditUnavailable); }
  }
  const changedAt = new Date(deps.now()).toISOString();
  await deps.store.put({ item: { ...key, entityType: "UPKEEP_SETTINGS", orgId: deps.companyId, project: input.project, enabled: input.on, changedAt, requestId: input.requestId } });
  if (deps.schedule !== undefined) {
    if (input.on) await deps.schedule.put(scope); else await deps.schedule.remove(scope);
  }
  return { enabled: input.on, changedAt, changed: true };
}

export type UpkeepControlDeps = UpkeepSettingsDeps;

/** Whether this install runs nightly upkeep: only an explicit true from the seam. Absent, false and a seam that throws are all "not available". */
async function availableOf(deps: Pick<UpkeepSettingsDeps, "available">): Promise<boolean> {
  try { return deps.available === undefined ? false : (await deps.available()) === true; } catch { return false; }
}

/** The switch as the page reads it: any role on the project reads it; a person with none reads "project not found". */
export async function upkeepView(deps: UpkeepControlDeps, personId: string, project: string): Promise<{ enabled: boolean; canManage: boolean; available: boolean }> {
  let access: UpkeepAccess;
  try { access = (await deps.standing(personId, project)).access; } catch { throw agentXError("RUNTIME_UNAVAILABLE", UPKEEP_WORDS.unreadable); }
  if (access === "none") throw agentXError("PROJECT_NOT_FOUND", UPKEEP_WORDS.projectNotFound);
  const available = await availableOf(deps);
  return { enabled: (await readUpkeepSetting(deps, project)).enabled, canManage: access === "manage", available };
}

/** The page's switch: a strict body ({ requestId, on }), the standing and the audit rules of `setUpkeepEnabled`, answering the view. `fromPage` is true here: this is the setup page's own route (the dev routes refuse a script token before it). */
export async function upkeepSwitchControl(deps: UpkeepControlDeps, personId: string, project: string, rawBody: unknown): Promise<{ enabled: boolean; canManage: boolean; available: boolean }> {
  const body = UpkeepSwitchBodySchema.safeParse(rawBody);
  if (!body.success) throw agentXError("CONFIG_INVALID", "the request is not valid");
  // Who first (no role is the uniform 404, a reader is 403), then whether this install runs nightly upkeep at all: while it does not, nothing is changed and nothing is recorded.
  const seen = await upkeepView(deps, personId, project);
  if (!seen.canManage) throw agentXError("FORBIDDEN", UPKEEP_WORDS.notAllowed);
  if (!seen.available) throw agentXError("NOT_AVAILABLE_HERE", UPKEEP_WORDS.unavailable);
  await setUpkeepEnabled(deps, { personId, project, requestId: body.data.requestId, on: body.data.on, fromPage: true });
  return upkeepView(deps, personId, project);
}
