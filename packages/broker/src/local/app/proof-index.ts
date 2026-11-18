// The task's proof index (`GET /v1/dev/tasks/{id}/evidence`, Cloud's contract v0 `tasks.evidence.list`): one item per thing the proof page shows as checked for the task's CURRENT code, and the failing tests
// with the change that most likely broke each (TE-A6, DEC 254zt/254zzf) for Cloud's task page. It reads only what the proof page reads (`proofReportOf`): the workflow's recorded verification results and reviews
// for the current candidate, and the evidence pack kept for exactly that code (or none). Nothing is invented: a check with no stored output has no `sha256`, no criterion is named (Code does not map checks to
// criteria), and a pack that cannot be read leaves only what Rovara recorded itself.
// Every text is the proof page's own plain words (`proofWords`: redacted, one line, made inert); ids are fixed shapes made here, never input. Bounded: at most `PROOF_INDEX_ITEMS_MAX` items and
// `PROOF_INDEX_FAILURES_MAX` failing tests, the rest counted.
import { FAILURE_CAUSES_LISTED_MAX, workflowSelectedChecks, type EvidencePack, type WorkflowSnapshot } from "@agentx/contracts";
import { failuresOf, proofWords } from "./proof-report.js";

/** The most items one index answers (a pack has at most 64 checks; a candidate's results and two reviews come on top). */
export const PROOF_INDEX_ITEMS_MAX = 100;
/** The most failing tests one index lists, across all checks (the proof page's and the pull request's limit); the rest are counted in `failuresNotListed`. */
export const PROOF_INDEX_FAILURES_MAX = FAILURE_CAUSES_LISTED_MAX;

export type ProofIndexVerdict = "pass" | "fail" | "unknown";
export interface ProofIndexItem {
  /** A fixed-shape id, unique in the index: `check:<n>` (a recorded result), `evidence:<n>` (a check of the kept pack) or `review:code` / `review:security`. */
  id: string;
  /** The digest of the check's stored output, when the pack kept one. */
  sha256?: string;
  title: string;
  kind: "check_result" | "test_report" | "review";
  verdict: ProofIndexVerdict;
  /** Code does not tie a check to a criterion: always empty (an "also checked" item). */
  criterionIds: string[];
}
export interface ProofIndexFailure { check: string; test: string; cause: string }
export interface ProofIndexResponse {
  taskId: string;
  items: ProofIndexItem[];
  /** TE-A6: the failing tests of the failed checks, each with its likely cause or "unknown (...)". Absent when there is none to show. */
  failures?: ProofIndexFailure[];
  /** How many failing tests with a cause are not listed. Present with `failures` only when more than the limit exist. */
  failuresNotListed?: number;
}

const RESULT_VERDICT: Record<string, ProofIndexVerdict> = { PASS: "pass", FAILED: "fail" };
const REVIEW_VERDICT: Record<string, ProofIndexVerdict> = { PASS: "pass", FINDINGS: "fail" };
const PACK_VERDICT: Record<string, ProofIndexVerdict> = { passed: "pass", failed: "fail", timed_out: "fail" };
const SHA256 = /^[a-f0-9]{64}$/u;

/** The proof index of one task. `pack` is the pack kept for the workflow's current candidate (the proof page's `packOf`), or undefined. */
export function proofIndexOf(taskId: string, workflow: WorkflowSnapshot | undefined, pack: EvidencePack | undefined): ProofIndexResponse {
  const items: ProofIndexItem[] = [];
  const current = workflow?.candidate?.digest;
  // A pack for other code than the current candidate is never shown (the loader already checks it; this keeps the rule here too).
  const kept = pack !== undefined && current !== undefined && pack.candidateDigest === current ? pack : undefined;
  const packChecks = new Set((kept?.checks ?? []).map((check) => check.checkId));
  const verification = workflow?.verification;
  if (workflow !== undefined && verification !== undefined && current !== undefined && verification.candidateDigest === current) {
    const labels = new Map(workflowSelectedChecks(workflow.checkPolicy).map((check) => [check.id, check.label]));
    verification.results.forEach((result, index) => {
      // The kept pack's own entry for the same check says more (its stored output): it stands for the check instead.
      if (packChecks.has(result.checkId)) return;
      items.push({ id: `check:${String(index)}`, title: proofWords(labels.get(result.checkId) ?? result.checkId, 200), kind: "check_result", verdict: RESULT_VERDICT[result.status] ?? "unknown", criterionIds: [] });
    });
  }
  for (const review of (workflow?.reviews ?? []).filter((entry) => current !== undefined && entry.candidateDigest === current)) {
    const security = review.role === "SECURITY";
    const id = security ? "review:security" : "review:code";
    if (items.some((item) => item.id === id)) continue;
    items.push({ id, title: security ? "Security review" : "Code review", kind: "review", verdict: REVIEW_VERDICT[review.status] ?? "unknown", criterionIds: [] });
  }
  (kept?.checks ?? []).forEach((check, index) => {
    const sha256 = check.outputTailRef?.sha256;
    items.push({
      id: `evidence:${String(index)}`, ...(typeof sha256 === "string" && SHA256.test(sha256) ? { sha256 } : {}), title: proofWords(check.label, 200),
      kind: check.tests === undefined ? "check_result" : "test_report", verdict: PACK_VERDICT[check.after] ?? "unknown", criterionIds: [],
    });
  });
  // The proof page's own list (`failuresOf`): only failed checks, causes that read as the contract says, `PROOF_INDEX_FAILURES_MAX` tests across all checks and the rest counted.
  const listed = failuresOf(kept);
  const failures: ProofIndexFailure[] = (listed?.checks ?? []).flatMap((check) => check.tests.map((test) => ({ check: check.check, test: test.test, cause: test.cause })));
  const notListed = listed?.more ?? 0;
  return {
    taskId, items: items.slice(0, PROOF_INDEX_ITEMS_MAX),
    ...(failures.length === 0 && notListed === 0 ? {} : { failures, ...(notListed > 0 ? { failuresNotListed: notListed } : {}) }),
  };
}
