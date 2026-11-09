// Proof and evidence (wire-proof): the data guard on what is about to be kept or posted. Evidence never carries secrets or production data, so before anything is stored, shown on the task page or put on a pull
// request, every text a person or a repository wrote in it (test names, output tails, labels, paths) is scanned with the synthetic data guard (`scan`, the verifier's `scanText`: personal data, card numbers, credentials, hosts, ARNs and
// accounts on the company's production deny list). A part that holds a finding is DROPPED, whole, and counted; the matched text is never kept, logged or returned (only a fixed kind). The guard fails closed: a text
// too large to scan, or a scan that throws, is a finding.
//
// Digests (64 hex characters) and ISO timestamps (exact shape) are skipped: a run of digits inside a hash is not a card number, and scanning them would block about one pack in a hundred for nothing. Text is
// normalised (NFKC) before it is scanned.
import type { DataGuardReport, EvidencePack, EvidenceRaw, TestEnvProdDeny } from "@agentx/contracts";
import type { NewArtifact } from "./evidence-pack.js";
import { fixedToolName } from "./evidence-risk.js";

export type DataGuardFindingKind = DataGuardReport["findings"][number]["kind"];

/**
 * The synthetic data guard's text scan (`scanText` of the verifier package, lane L5): the kinds of finding in a text, each once, never the matched text. It is a parameter so this module does not depend on the
 * verifier; the caller MUST pass the real scan, and there is no default that skips it (a missing scan would keep evidence unscanned). It may throw on input it refuses (too large): that is a finding.
 */
export type DataGuardScan = (text: string, deny: TestEnvProdDeny) => readonly DataGuardFindingKind[];

/**
 * Whether a scan is a working data guard: it must find a card number, a credential and an email address in fixed canary texts (the credential is built at run time). A stub that finds nothing for everything,
 * or one that throws, is not one. `keepEvidence` refuses to keep anything with a scan that fails this.
 */
export function dataGuardScanWorks(scan: DataGuardScan): boolean {
  const canaries = ["charged 4111 1111 1111 1111 ok", `key ${"AKIA"}${"ABCDEFGHIJKLMNOP"}`, "mail jane.doe@gmail.com"];
  try { return canaries.every((text) => scan(text, NO_PROD_DENY).length > 0); } catch { return false; }
}

/** The production deny list when no approved test environment names one: personal data, credentials and card numbers are still refused. */
export const NO_PROD_DENY: TestEnvProdDeny = { accountIds: [], hosts: [], arnPrefixes: [] };

const DIGEST = /^[a-f0-9]{64}$/u;
// A real ISO instant, with its fixed field widths: only a value of exactly this shape is exempt, so a run of digits after the T (a card number) is scanned.
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const SCAN_LIMIT = 4 * 1024 * 1024;

/** Every string a person or a repository wrote in a value, one per line, without digests and timestamps; keys are fixed words and are not scanned. */
export function evidenceTexts(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") { if (!DIGEST.test(value) && !TIMESTAMP.test(value)) out.push(value); }
  else if (Array.isArray(value)) for (const item of value) evidenceTexts(item, out);
  else if (value !== null && typeof value === "object") for (const item of Object.values(value)) evidenceTexts(item, out);
  return out;
}

/** The fixed kinds of finding in a value's texts; `[]` means clean. A text too large to scan, or a scan that fails, is reported as `secret` (it is not kept). */
export function evidenceFindings(value: unknown, deny: TestEnvProdDeny, scan: DataGuardScan): DataGuardFindingKind[] {
  // NFKC first: full-width digits and letters (４１１１, ｍａｙａ@acme.com) and other compatibility forms read as the ASCII they imitate, which is what the scanner's patterns know.
  const text = evidenceTexts(value).join("\n").normalize("NFKC");
  if (Buffer.byteLength(text, "utf8") > SCAN_LIMIT) return ["secret"];
  try { return [...scan(text, deny)]; } catch { return ["secret"]; }
}

export interface GuardCount { parts: number; kinds: DataGuardFindingKind[] }
const merge = (into: GuardCount, kinds: readonly DataGuardFindingKind[]): void => { into.parts += 1; for (const kind of kinds) if (!into.kinds.includes(kind)) into.kinds.push(kind); };

/**
 * A scan's findings with every text taken out and only the numbers kept (the counts by severity, and the high findings that could not be compared). Numbers cannot hold personal data, and they are what the risk rule
 * reads: a file name the agent chose, or a message that interpolates a card-like number, must not be a way to make the scan's high findings disappear. The tool is a fixed word.
 */
export function countsOnly<F extends { tool: string; newCount: number; bySeverity: { critical: number; high: number; medium: number; low: number; info: number }; unverified?: number | undefined }>(findings: F): { tool: string; newCount: number; bySeverity: F["bySeverity"]; items: never[]; unverified?: number } {
  return { tool: fixedToolName(findings.tool), newCount: findings.newCount, bySeverity: findings.bySeverity, items: [], ...(findings.unverified === undefined ? {} : { unverified: findings.unverified }) };
}

/** The worker's raw file with each check that holds a finding removed (its test names and output tail with it); a scan's counts survive without their texts. */
export function guardRaw(raw: EvidenceRaw, deny: TestEnvProdDeny, scan: DataGuardScan): { raw: EvidenceRaw; dropped: GuardCount } {
  const dropped: GuardCount = { parts: 0, kinds: [] };
  const checks = raw.checks.flatMap((check) => {
    const found = evidenceFindings(check, deny, scan);
    if (found.length > 0) merge(dropped, found);
    if (found.length === 0) return [check];
    return check.findings === undefined ? [] : [{ checkId: check.checkId, findings: countsOnly(check.findings) }];
  });
  return { raw: { ...raw, checks }, dropped };
}

/**
 * The built pack, checked again (defence in depth: the builder adds labels and paths of its own). A check's details that hold a finding lose the details (tests, coverage, findings, migrations, output tail and the
 * stored tail), keeping the broker's own verdict; a label that holds one becomes "Check <n>". Anything in the rest of the pack (environment, selection, not-tested items, scenarios) that holds a finding withholds the
 * whole pack, which is then not kept at all.
 */
export function guardPack(pack: EvidencePack, newArtifacts: readonly NewArtifact[], deny: TestEnvProdDeny, scan: DataGuardScan): { pack: EvidencePack | undefined; newArtifacts: NewArtifact[]; dropped: GuardCount } {
  const dropped: GuardCount = { parts: 0, kinds: [] };
  const { checks, ...rest } = pack;
  const restFound = evidenceFindings(rest, deny, scan);
  if (restFound.length > 0) { merge(dropped, restFound); return { pack: undefined, newArtifacts: [], dropped }; }
  const lostTails = new Set<string>();
  const kept = checks.map((check, index) => {
    const { label, tests, coverage, findings, migrations, outputTailRef, ...base } = check;
    const labelFound = evidenceFindings(label, deny, scan);
    if (labelFound.length > 0) merge(dropped, labelFound);
    const tail = outputTailRef === undefined ? undefined : newArtifacts.find((artifact) => artifact.ref.sha256 === outputTailRef.sha256);
    const detailFound = evidenceFindings({ tests, coverage, findings, migrations, tail: tail?.text }, deny, scan);
    if (detailFound.length > 0) {
      merge(dropped, detailFound);
      if (outputTailRef !== undefined) lostTails.add(outputTailRef.sha256);
      return { ...base, label: labelFound.length > 0 ? `Check ${String(index + 1)}` : label, ...(findings === undefined ? {} : { findings: countsOnly(findings) }) };
    }
    return { ...base, label: labelFound.length > 0 ? `Check ${String(index + 1)}` : label, ...(tests === undefined ? {} : { tests }), ...(coverage === undefined ? {} : { coverage }), ...(findings === undefined ? {} : { findings }), ...(migrations === undefined ? {} : { migrations }), ...(outputTailRef === undefined ? {} : { outputTailRef }) };
  });
  return { pack: { ...rest, checks: kept }, newArtifacts: newArtifacts.filter((artifact) => !lostTails.has(artifact.ref.sha256)), dropped };
}
