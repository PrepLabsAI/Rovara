// Proof and evidence P4: the evidence's part of a pull request's risk, read where the risk is judged (publication, a pushed fix, a description rewrite). It reads the pack kept for exactly this code through a
// reader of kept packs (`loadEvidencePack` over the evidence blob store, with a time limit, is one). A fault only means no signal, except where a security scan was expected: then it is `evidenceUnavailable` and
// risk.ts makes the change at least medium, never silently low.
import { evidenceIsFor, workflowSelectedChecks, type EvidencePack, type WorkflowCheckPolicy } from "@agentx/contracts";
import { evidenceRiskSignal, type EvidenceRiskSignal } from "./evidence-risk.js";

export interface EvidenceTaskKey { ownerKey: string; workspaceId: string; taskId: string }

/** Reads the pack kept for exactly this code of this task; undefined when there is none. May throw (a store fault) or be slow: the caller bounds it. */
export interface EvidencePackReader { pack(task: EvidenceTaskKey, candidateDigest: string): Promise<EvidencePack | undefined> }

/** The ids (as the worker reports them, `readiness:<index>` in selected order) of the security checks the approved policy selects: a scan was expected from each. */
export function securityCheckIdsOf(policy: WorkflowCheckPolicy | undefined): string[] {
  return workflowSelectedChecks(policy).flatMap((check, index) => (check.kind === "security" ? [`readiness:${String(index)}`] : []));
}

/**
 * The risk signal for this code. `securityChecks` (see `securityCheckIdsOf`): with a security check in the approved policy, a scan that could not be checked is `evidenceUnavailable` and risk.ts makes the change at least
 * medium, never silently low. That is: no pack for exactly this code could be had (never kept, the read timed out, the store failed, a pack of other code), or the pack has no findings for one of those checks (they were
 * dropped as inconsistent or untrusted, or the scan wrote nothing that could be read), or the pack does not hold the check at all. A new high finding in another check still counts. Without a security check in the policy a
 * missing pack is no signal.
 *
 * `reader === undefined` means evidence is not kept in this install, or a caller that was never given a reader: with evidence on (`evidenceOn`) and a security check expected, that reading must not look Low.
 */
export async function evidenceRiskOfTask(reader: EvidencePackReader | undefined, task: EvidenceTaskKey, candidateDigest: string | undefined, securityChecks: readonly string[], evidenceOn: boolean): Promise<EvidenceRiskSignal | undefined> {
  if (candidateDigest === undefined) return undefined;
  const unavailable: EvidenceRiskSignal | undefined = securityChecks.length > 0 ? { highNewFindings: 0, evidenceUnavailable: true } : undefined;
  if (reader === undefined) return evidenceOn ? unavailable : undefined;
  try {
    const pack = await reader.pack(task, candidateDigest);
    if (pack === undefined || !evidenceIsFor(pack, candidateDigest)) return unavailable;
    const signal = evidenceRiskSignal(pack, candidateDigest);
    const unchecked = securityChecks.some((id) => pack.checks.find((check) => check.checkId === id)?.findings === undefined);
    return unchecked ? { highNewFindings: signal?.highNewFindings ?? 0, ...(signal?.unverifiedHighFindings === undefined ? {} : { unverifiedHighFindings: signal.unverifiedHighFindings }), evidenceUnavailable: true } : signal;
  } catch { return unavailable; }
}
