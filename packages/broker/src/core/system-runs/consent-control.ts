// The company's ONE control over Rovara's automatic runs (L4-P3, owner 2026-11-17): read it, allow it, withdraw it, as a live company owner or admin (route: core-host/system-runs-routes.ts).
//
//   - ALLOWING needs the live role and the operator's ceiling (DEC 254zzz73: no step-up). WITHDRAWING needs only the live role (turning it off must be easy), and it works while the operator's ceiling is off.
//   - The audit record (naming the person and why they were allowed) is written BEFORE the row: an act whose record cannot be written is not done.
//   - A withdrawal changes ONLY the company's consent row. Projects keep their own switch (they read as off while the consent is off, `effectiveSystemRunsGate`), and the nightly job is not touched: the effective gate is
//     read on every use, so the next run is refused at once.
//   - The row changes only if it is still the row this act read (a concurrent change loses and is told to try again). The same choice again is no change and records nothing.
import { ON_THE_WEBSITE_MESSAGE, SystemRunsBodySchema, agentXError, type DocumentStore, type OrgId, type SystemRunsView } from "@agentx/contracts";
import { readSystemRunsConsentRow, seenRowFence, systemRunsConsentKey } from "./consent.js";

export const SYSTEM_RUNS_WORDS = {
  notAllowed: "Only company owners and admins can see or change whether Rovara's automatic runs are allowed for the company.",
  unavailable: "Rovara's automatic runs aren't available on this Rovara yet",
  unreadable: "The company's automatic-runs setting could not be read. Try again.",
  auditUnavailable: "That could not be recorded, so nothing was changed. Try again.",
} as const;

export interface SystemRunsControlDeps {
  store: DocumentStore;
  companyId: OrgId;
  now: () => number;
  /** The caller is, right now, a live owner or admin of this company (the host's membership read for this request). A throw or anything but `true` is a no. */
  isCompanyAdmin(): Promise<boolean>;
  /** Whether the operator's ceiling covers this company (`CoreSystemRuns`). Absent, a throw and anything but `true` read as not available. */
  available?: (() => boolean | Promise<boolean>) | undefined;
  /** Owner DEC 254zzz91: the request comes from the Rovara website's own client (`webApp`). Anything else may read and withdraw, never ALLOW. */
  webApp?: boolean | undefined;
  /** The audit record, written before the row. Throws when it could not write. `previous` names the row this act replaces (its `changedAt`, or "none"). */
  record(details: { requestId: string; on: boolean; previous: string }): Promise<void>;
}

async function availableOf(deps: Pick<SystemRunsControlDeps, "available">): Promise<boolean> {
  try { return deps.available === undefined ? false : (await deps.available()) === true; } catch { return false; }
}

async function adminOf(deps: Pick<SystemRunsControlDeps, "isCompanyAdmin">): Promise<boolean> {
  try { return (await deps.isCompanyAdmin()) === true; } catch { return false; }
}

async function view(deps: SystemRunsControlDeps): Promise<SystemRunsView> {
  const available = await availableOf(deps);
  const allowed = (await readSystemRunsConsentRow(deps)).enabled;
  return { available, allowed, systemRunsOn: available && allowed };
}

/** What the company's control shows: only a live owner or admin reads it. */
export async function systemRunsView(deps: SystemRunsControlDeps): Promise<SystemRunsView> {
  if (!(await adminOf(deps))) throw agentXError("FORBIDDEN", SYSTEM_RUNS_WORDS.notAllowed);
  return view(deps);
}

/** Allows or withdraws the company's consent. Order: role, body, (allow only: ceiling), then the read, the audit record and the fenced write. Answers the view after the change. */
export async function setSystemRunsConsent(deps: SystemRunsControlDeps, readBody: () => unknown): Promise<SystemRunsView> {
  if (!(await adminOf(deps))) throw agentXError("FORBIDDEN", SYSTEM_RUNS_WORDS.notAllowed);
  // The body is read only after the role check: a person who may not change this is refused for that, whatever they sent.
  const body = SystemRunsBodySchema.safeParse(readBody());
  if (!body.success) throw agentXError("CONFIG_INVALID", "the request is not valid");
  const { requestId, allowed } = body.data;
  if (allowed && deps.webApp !== true) throw agentXError("FORBIDDEN", ON_THE_WEBSITE_MESSAGE);
  if (allowed && !(await availableOf(deps))) throw agentXError("NOT_AVAILABLE_HERE", SYSTEM_RUNS_WORDS.unavailable);
  const key = systemRunsConsentKey(deps.companyId);
  const before = await deps.store.get(key).catch(() => { throw agentXError("RUNTIME_UNAVAILABLE", SYSTEM_RUNS_WORDS.unreadable); });
  // Only this company's own `enabled: true` row is a consent (the same rule as every reader): the same choice again changes nothing and records nothing.
  if ((await readSystemRunsConsentRow(deps)).enabled === allowed) return view(deps);
  try { await deps.record({ requestId, on: allowed, previous: typeof before?.["changedAt"] === "string" ? before["changedAt"] : "none" }); } catch { throw agentXError("AUDIT_UNAVAILABLE", SYSTEM_RUNS_WORDS.auditUnavailable); }
  const changedAt = new Date(deps.now()).toISOString();
  const written = await deps.store.transact([
    { kind: "put", item: { ...key, entityType: "SYSTEM_RUNS_CONSENT", orgId: deps.companyId, enabled: allowed, changedAt, requestId }, condition: seenRowFence(before) },
  ]).catch(() => ({ applied: false as const }));
  if (!written.applied) throw agentXError("RUNTIME_UNAVAILABLE", SYSTEM_RUNS_WORDS.unreadable);
  return view(deps);
}
