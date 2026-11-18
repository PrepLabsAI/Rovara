// The company's CONSENT to Rovara's automatic runs (lead 4 L4-P2; owner DEC 254zzt, option A "two locks"). Effective system runs = the operator's CEILING (stack parameter `CoreSystemRuns`) AND this stored consent.
//
//   - ONE row per company, `ORG#<company>#SYSTEM_RUNS` / `CONSENT` (companyScoped: the company purge removes it by key, and no read of one company reaches another's). No row, a damaged row, a row naming another
//     company, an unreadable store: NO consent. Nothing install-wide can give it (the ceiling only ALLOWS; it never consents for a company).
//   - Only a LIVE company owner or admin writes it (the setup PUT, core/upkeep/settings.ts), after an audit record, in ONE transaction with the project's upkeep switch. No person's id is kept on the row (the audit
//     record names the person), so the person erase has no step here.
//   - The gate every system run stands behind reads it NOW, on every use (never remembered), and fails closed: a read that throws is "off".
import { OrgIdSchema, companyScoped, type DocumentKey, type DocumentStore, type OrgId } from "@agentx/contracts";

export const systemRunsConsentKey = (orgId: OrgId): DocumentKey => ({ pk: companyScoped(OrgIdSchema.parse(orgId), "SYSTEM_RUNS"), sk: "CONSENT" });

export interface SystemRunsConsentRow { enabled: boolean; changedAt?: string; requestId?: string }

/** The company's consent row as the store says now. Anything that is not exactly this company's `enabled: true` row is no consent. Never throws. */
export async function readSystemRunsConsentRow(deps: { store: Pick<DocumentStore, "get">; companyId: OrgId }): Promise<SystemRunsConsentRow> {
  try {
    const row = await deps.store.get(systemRunsConsentKey(deps.companyId));
    if (row === undefined || row["entityType"] !== "SYSTEM_RUNS_CONSENT" || row["orgId"] !== deps.companyId) return { enabled: false };
    return { enabled: row["enabled"] === true, ...(typeof row["changedAt"] === "string" ? { changedAt: row["changedAt"] } : {}), ...(typeof row["requestId"] === "string" ? { requestId: row["requestId"] } : {}) };
  } catch {
    return { enabled: false };
  }
}

export async function systemRunsConsentGiven(deps: { store: Pick<DocumentStore, "get">; companyId: OrgId }): Promise<boolean> {
  return (await readSystemRunsConsentRow(deps)).enabled;
}

/** What the system runs of one company stand behind: read on every use, never throws, and `false` unless BOTH locks are open. */
export interface SystemRunsGate { enabled(): boolean | Promise<boolean> }

/**
 * The EFFECTIVE gate: the operator's ceiling (a function, read now) AND the company's consent (the stored row, read now). The ceiling is checked first, so a company the ceiling does not cover never reads anything.
 * A consent read that fails is "off" (`systemRunsConsentGiven` never throws).
 */
export function effectiveSystemRunsGate(inputs: { ceiling: () => boolean; store: Pick<DocumentStore, "get">; companyId: OrgId }): { enabled(): Promise<boolean> } {
  return {
    enabled: async () => {
      let ceiling: boolean;
      try { ceiling = inputs.ceiling() === true; } catch { return false; }
      return ceiling && (await systemRunsConsentGiven(inputs)) === true;
    },
  };
}

/** Whether a gate (anything at all) says on: only an explicit `true`; a throw, a rejection and every other answer is off. An ABSENT gate is the caller's own rule (the laptop's: on). */
export async function systemRunsGateSaysOn(gate: SystemRunsGate): Promise<boolean> {
  try { return (await gate.enabled()) === true; } catch { return false; }
}
