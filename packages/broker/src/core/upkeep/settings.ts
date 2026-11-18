// Nightly upkeep's switch (lead 4 N1; design setup-upkeep-plan.md 2.2): ONE setting per project, OFF by default.
//
//   - A project is ON only when its own row says `enabled: true` (the row is the project's own: company and project in its key AND in its body, and a row naming another company or project reads as OFF). No row, a damaged
//     row, an unreadable store: OFF. Nothing install-wide (an environment variable, a default) can turn it on for a project.
//   - Turning it ON or OFF is an act of a company owner or admin, or the project's administrator, on the setup PAGE (`fromPage`): a token, a script or an assistant cannot (the same rule as an automation trigger). The
//     audit record is written BEFORE the row (an act whose record cannot be written is not done), and a repeat of a request id is one act.
//   - The schedule follows the switch: ON puts the project's upkeep night on the scheduler, OFF removes it. A schedule that could not be changed is thrown AFTER the row is written (the switch is what is true; a retry of
//     the same request puts it right).
// The monthly dollar cap is NOT here: the gateway holds it (Cloud's `upkeep_month`), so no number written in Code can lift it.
import { SYSTEM_RUNS_CONSENT_WORDS, UpkeepSwitchBodySchema, agentXError, type DocumentStore, type OrgId, type UpkeepView } from "@agentx/contracts";
import { readSystemRunsConsentRow, systemRunsConsentKey } from "../system-runs/consent.js";
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
  standing(personId: string, project: string): Promise<{ access: UpkeepAccess; /** L4-P2: the person is, right now, a company owner or admin (not only a project administrator). Absent: no. */ companyAdmin?: boolean }>;
  /**
   * The audit record of the act, written BEFORE it. Throws when it could not write. `previous` names the row this act replaces (its `changedAt`, or "none"): a host builds its event id from it, so the same
   * request id used for on, then off, then on again is three records and never one that the sink drops as a repeat.
   */
  record?: ((action: "upkeep_switched", project: string, details: { requestId: string; on: boolean; previous: string }) => Promise<void>) | undefined;
  /** The project's upkeep night on the scheduler: put when ON, removed when OFF. Absent: no schedule (a laptop with no scheduler). */
  schedule?: { put(scope: UpkeepScope): Promise<void>; remove(scope: UpkeepScope): Promise<void> } | undefined;
  /** Whether nightly runs really happen on this install (a system starter AND a schedule are wired). Absent: not available, and the page hides the switch (`upkeepView`, `upkeepSwitchControl`). */
  available?: (() => boolean | Promise<boolean>) | undefined;
  /**
   * L4-P2 (owner DEC 254zzt, "two locks"): the company's consent row is read from `store` (the company's own). `recordConsent` is the audit record of a change of it, written BEFORE the change (throws when it
   * could not write). `cap` reads the project's monthly upkeep cap from the gateway when the host can; absent or throwing: null (Code stores no cap).
   */
  recordConsent?: ((details: { requestId: string; on: boolean; previous: string }) => Promise<void>) | undefined;
  cap?: (() => Promise<number | null>) | undefined;
  /** The laptop has ONE person and no operator ceiling: nothing is consented to, so the switch alone decides (`systemRunsOn` follows `available`). Hosted never sets this. */
  noConsentNeeded?: true | undefined;
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

/**
 * The switch as the page reads it: any role on the project reads it; a person with none reads "project not found". Contract: `UpkeepViewSchema` (contracts/upkeep.ts). `available` is the operator CEILING;
 * `systemRunsOn` is EFFECTIVE (ceiling AND the company's consent, read now).
 */
export async function upkeepView(deps: UpkeepControlDeps, personId: string, project: string): Promise<UpkeepView> {
  let standing: Awaited<ReturnType<UpkeepSettingsDeps["standing"]>>;
  try { standing = await deps.standing(personId, project); } catch { throw agentXError("RUNTIME_UNAVAILABLE", UPKEEP_WORDS.unreadable); }
  if (standing.access === "none") throw agentXError("PROJECT_NOT_FOUND", UPKEEP_WORDS.projectNotFound);
  const available = await availableOf(deps);
  const companyAdmin = standing.access === "manage" && standing.companyAdmin === true;
  let monthlyUsd: number | null = null;
  try {
    const read = deps.cap === undefined ? null : await deps.cap();
    monthlyUsd = typeof read === "number" && Number.isFinite(read) && read >= 0 ? read : null;
  } catch { monthlyUsd = null; }
  return {
    enabled: (await readUpkeepSetting(deps, project)).enabled, canManage: standing.access === "manage", available,
    systemRunsOn: available && (deps.noConsentNeeded === true || (await readSystemRunsConsentRow(deps)).enabled), canEnableSystemRuns: available && companyAdmin, cap: { monthlyUsd, canRaise: companyAdmin },
  };
}

/**
 * The page's switch: a strict body ({ requestId, on, allowSystemRuns? }), the standing and the audit rules of `setUpkeepEnabled`, answering the view. `fromPage` is true here: this is the setup page's own route
 * (the dev routes refuse a script token before it). Who first (no role is the uniform 404, a reader is 403), then whether the install runs nightly upkeep at all (the ceiling): while it does not, nothing is changed
 * and nothing is recorded. With `allowSystemRuns` (the SETUP step) only a live company owner or admin may, and the consent and the switch change in ONE transaction. Without it, turning ON needs the consent given already.
 */
export async function upkeepSwitchControl(deps: UpkeepControlDeps, personId: string, project: string, rawBody: unknown): Promise<UpkeepView> {
  const raw = typeof rawBody === "object" && rawBody !== null ? (rawBody as Record<string, unknown>) : undefined;
  const body = UpkeepSwitchBodySchema.safeParse(rawBody);
  if (!body.success) throw agentXError("CONFIG_INVALID", raw?.["allowSystemRuns"] === false && raw["on"] === true ? SYSTEM_RUNS_CONSENT_WORDS.contradiction : "the request is not valid");
  const seen = await upkeepView(deps, personId, project);
  if (!seen.canManage) throw agentXError("FORBIDDEN", UPKEEP_WORDS.notAllowed);
  if (body.data.allowSystemRuns !== undefined && !seen.cap.canRaise) throw agentXError("FORBIDDEN", SYSTEM_RUNS_CONSENT_WORDS.notAllowed);
  if (!seen.available) throw agentXError("NOT_AVAILABLE_HERE", UPKEEP_WORDS.unavailable);
  if (body.data.allowSystemRuns !== undefined) {
    await setSystemRunsAndUpkeep(deps, { personId, project, requestId: body.data.requestId, on: body.data.on, allow: body.data.allowSystemRuns });
    return upkeepView(deps, personId, project);
  }
  // A maintainer's plain switch: ON only where the company has consented (a switch that records "on" and runs nothing is worse than none). OFF always works.
  if (body.data.on && !seen.systemRunsOn) throw agentXError("FORBIDDEN", SYSTEM_RUNS_CONSENT_WORDS.needsConsent);
  await setUpkeepEnabled(deps, { personId, project, requestId: body.data.requestId, on: body.data.on, fromPage: true });
  return upkeepView(deps, personId, project);
}

/**
 * The SETUP step (L4-P2): a LIVE company owner or admin sets the company's consent AND the project's upkeep switch. Both audit records are written BEFORE any change (an act whose records cannot be written is not
 * done), then the two rows change in ONE store transaction (both or neither). The standing is read again here, not taken from the caller's view. A repeat of the same request id with the same choices is one act.
 */
export async function setSystemRunsAndUpkeep(deps: UpkeepSettingsDeps, input: { personId: string; project: string; requestId: string; on: boolean; allow: boolean }): Promise<{ changed: boolean }> {
  if (typeof input.on !== "boolean" || typeof input.allow !== "boolean" || !UUID.test(input.requestId) || (input.on && !input.allow)) throw agentXError("CONFIG_INVALID", "the request is not valid");
  let standing: Awaited<ReturnType<UpkeepSettingsDeps["standing"]>>;
  try { standing = await deps.standing(input.personId, input.project); } catch { throw agentXError("FORBIDDEN", SYSTEM_RUNS_CONSENT_WORDS.notAllowed); }
  if (standing.access === "none") throw agentXError("PROJECT_NOT_FOUND", UPKEEP_WORDS.projectNotFound);
  if (standing.access !== "manage" || standing.companyAdmin !== true) throw agentXError("FORBIDDEN", SYSTEM_RUNS_CONSENT_WORDS.notAllowed);
  const scope = { orgId: deps.companyId, project: input.project };
  const settingsKey = upkeepSettingsKey(scope);
  const consentKey = systemRunsConsentKey(deps.companyId);
  const unreadable = (): never => { throw agentXError("RUNTIME_UNAVAILABLE", UPKEEP_WORDS.unreadable); };
  const beforeSettings = await deps.store.get(settingsKey).catch(unreadable);
  const beforeConsent = await deps.store.get(consentKey).catch(unreadable);
  const mine = (row: Record<string, unknown> | undefined, enabled: boolean, own: Record<string, unknown>): boolean =>
    row?.["requestId"] === input.requestId && row["enabled"] === enabled && Object.entries(own).every(([key, value]) => row[key] === value);
  if (mine(beforeSettings, input.on, { orgId: deps.companyId, project: input.project }) && mine(beforeConsent, input.allow, { orgId: deps.companyId })) return { changed: false };
  const previousOf = (row: Record<string, unknown> | undefined): string => (typeof row?.["changedAt"] === "string" ? row["changedAt"] : "none");
  if (deps.recordConsent === undefined || deps.record === undefined) throw agentXError("AUDIT_UNAVAILABLE", UPKEEP_WORDS.auditUnavailable);
  try {
    await deps.recordConsent({ requestId: input.requestId, on: input.allow, previous: previousOf(beforeConsent) });
    await deps.record("upkeep_switched", input.project, { requestId: input.requestId, on: input.on, previous: previousOf(beforeSettings) });
  } catch { throw agentXError("AUDIT_UNAVAILABLE", UPKEEP_WORDS.auditUnavailable); }
  const changedAt = new Date(deps.now()).toISOString();
  const written = await deps.store.transact([
    { kind: "put", item: { ...consentKey, entityType: "SYSTEM_RUNS_CONSENT", orgId: deps.companyId, enabled: input.allow, changedAt, requestId: input.requestId } },
    { kind: "put", item: { ...settingsKey, entityType: "UPKEEP_SETTINGS", orgId: deps.companyId, project: input.project, enabled: input.on, changedAt, requestId: input.requestId } },
  ]).catch(() => ({ applied: false as const }));
  if (!written.applied) throw agentXError("RUNTIME_UNAVAILABLE", UPKEEP_WORDS.unreadable);
  if (deps.schedule !== undefined) {
    if (input.on) await deps.schedule.put(scope); else await deps.schedule.remove(scope);
  }
  return { changed: true };
}
