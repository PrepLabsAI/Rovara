// Proof and evidence P4: what the evidence says about a pull request's RISK. The design's rule: a new HIGH or CRITICAL finding from a security scan sets the risk to high (risk.ts reads this signal). The
// signal comes from the evidence pack only when the pack is for exactly this code, and only from checks of kind `security`: a linter's "error" is a finding, not a security finding, and never raises the level.
// Findings are the broker-verified part of the pack (counts checked against the check's own outcome, data guard applied), and a worker can only ever raise the level this way, never lower it.
import { evidenceIsFor, type CheckKind, type EvidencePack, type EvidenceRaw } from "@rovara-code/contracts";

/** What risk.ts reads: the number of new findings a security scan rated high or critical on this code. */
export interface EvidenceRiskSignal {
  highNewFindings: number;
  /** High or critical findings of a security scan that could not be compared with the original code (no usable baseline): the change needs a look, it is never silently low. */
  unverifiedHighFindings?: number | undefined;
  /** The approved check policy has a security check but no pack for exactly this code could be read (never kept, the read timed out, or the store failed): a scan could not be checked, so the change is at least medium, never silently low. */
  evidenceUnavailable?: true | undefined;
}

/** Scanner names (SARIF `tool.driver.name`, case-insensitive prefix) treated as security scanners when the approved check policy gave the check no kind. */
const SECURITY_TOOL_PREFIXES = ["bandit", "semgrep", "codeql", "snyk", "trivy", "gitleaks", "trufflehog", "checkov", "tfsec", "gosec", "brakeman", "njsscan", "grype", "anchore", "dependency-check", "owasp", "kics", "horusec"] as const;

/** The scanner's name as a fixed word: the known scanner it starts with, else "scanner". Used when the tool's own text is dropped, so the check is still told for what it is. */
export function fixedToolName(tool: string): string {
  const lower = tool.toLowerCase();
  return SECURITY_TOOL_PREFIXES.find((prefix) => lower.startsWith(prefix)) ?? "scanner";
}

/** The kind of a check the approved policy named no kind for, from what its raw part carries: migrations are migration evidence; findings are a security scan's when the tool is a known scanner, else a lint check's. */
export function kindOfRawCheck(entry: EvidenceRaw["checks"][number]): CheckKind | undefined {
  if (entry.tests !== undefined) return "test";
  if (entry.migrations !== undefined) return "migration";
  if (entry.findings !== undefined) {
    const tool = entry.findings.tool.toLowerCase();
    return SECURITY_TOOL_PREFIXES.some((prefix) => tool.startsWith(prefix)) ? "security" : "lint";
  }
  return undefined;
}

/** The risk signal for `candidateDigest`, or undefined when there is no pack for exactly this code or nothing in it to raise the level. */
export function evidenceRiskSignal(pack: EvidencePack | undefined, candidateDigest: string | undefined): EvidenceRiskSignal | undefined {
  if (pack === undefined || candidateDigest === undefined || !evidenceIsFor(pack, candidateDigest)) return undefined;
  let high = 0;
  let unverified = 0;
  for (const check of pack.checks) {
    if (check.kind !== "security" || check.findings === undefined) continue;
    high += check.findings.bySeverity.critical + check.findings.bySeverity.high;
    unverified += check.findings.unverified ?? 0;
  }
  return high > 0 || unverified > 0 ? { highNewFindings: high, ...(unverified > 0 ? { unverifiedHighFindings: unverified } : {}) } : undefined;
}
