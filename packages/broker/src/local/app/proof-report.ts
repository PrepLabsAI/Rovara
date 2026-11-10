// Lane L12, slice 3: the local proof page's report for a task, from what the broker itself recorded about the checked code: the verification results of the approved checks, the reviews, the risk it judged, and the
// evidence pack kept for this very code (if one was). Every line is the broker's own words; a name from the repository or a worker is made inert (`inertPlanLine`) and redacted, and nothing here repeats a
// claim the broker could not check (a missing pack says "no evidence was kept", it never fills the gap).
import { redactText, workflowSelectedChecks, type EvidencePack, type WorkflowSnapshot } from "@agentx/contracts";
import type { ProofReportView, ProofRowView } from "../../core/local-pages/views.js";
import { inertPlanLine } from "../../core/proof/inert-text.js";
import type { TaskRecord } from "../../core/task-flow/records.js";

const words = (text: string, max = 200): string => Array.from(inertPlanLine(redactText(text).replace(/\s+/gu, " ")).trim()).slice(0, max).join("");
const OUTCOME: Record<EvidencePack["checks"][number]["after"], ProofRowView["status"]> = { passed: "passed", failed: "failed", timed_out: "failed", unknown: "not_run", not_run: "not_run" };
const KIND_WORDS: Record<string, string> = { test: "tests", lint: "lint", types: "types", build: "build", security: "security scan", migration: "migration", other: "check" };

/** The test counts of a pack check as one phrase ("12 passed, 1 failed; 2 new"). */
function testsDetail(check: EvidencePack["checks"][number]): string | undefined {
  const tests = check.tests;
  if (tests === undefined) return undefined;
  return [`${String(tests.passed)} passed`, ...(tests.failed > 0 ? [`${String(tests.failed)} failed`] : []), ...(tests.errored > 0 ? [`${String(tests.errored)} errored`] : []), ...(tests.skipped > 0 ? [`${String(tests.skipped)} skipped`] : []),
    ...(tests.newTests.length > 0 ? [`${String(tests.newTests.length)} new`] : [])].join(", ");
}

/** A short list of file names, redacted, with the count of the rest. */
function fileList(files: ReadonlyArray<{ path: string }>): string {
  const listed = files.slice(0, 5).map((file) => words(file.path, 80));
  return `${listed.join(", ")}${files.length > listed.length ? ` and ${String(files.length - listed.length)} more` : ""}`;
}

/** The files read from the code host (what the risk is judged from), and what the worker reported it changed (never believed, never used for the risk). */
export interface ChangedFilesFacts {
  verified?: { files: ReadonlyArray<{ path: string }>; complete: boolean } | undefined;
  reported?: { files: ReadonlyArray<{ path: string }>; complete: boolean } | undefined;
}

export function proofReportOf(task: TaskRecord, workflow: WorkflowSnapshot, pack: EvidencePack | undefined, changed: ChangedFilesFacts = {}): ProofReportView {
  const rows: ProofRowView[] = [];
  const verification = workflow.verification;
  const labels = new Map(workflowSelectedChecks(workflow.checkPolicy).map((check) => [check.id, check.label]));
  if (verification !== undefined && verification.candidateDigest === workflow.candidate?.digest) {
    if (verification.reviewOnly === true) rows.push({ claim: "No automated check applies to this change", check: "review only", status: "not_run", detail: workflow.checkPolicy?.noneReason === undefined ? "The plan and the project selected no check." : words(workflow.checkPolicy.noneReason) });
    for (const result of verification.results) {
      rows.push({
        claim: words(labels.get(result.checkId) ?? result.checkId, 200), check: "recorded by Rovara", status: result.status === "PASS" ? "passed" : result.status === "FAILED" ? "failed" : "not_run",
        ...(result.status === "FAILED" && result.programNotFound === true ? { detail: "the program is not installed on the worker" } : {}),
      });
    }
  }
  // The reviews of this code.
  for (const review of (workflow.reviews ?? []).filter((entry) => entry.candidateDigest === workflow.candidate?.digest)) {
    const accepted = (workflow.acceptedFindings ?? []).filter((finding) => finding.candidateDigest === workflow.candidate?.digest && finding.role === review.role).length;
    rows.push({
      claim: review.role === "SECURITY" ? "Security review" : "Code review", check: "independent review", status: review.status === "PASS" ? "passed" : review.status === "FINDINGS" ? "failed" : "not_run",
      ...(review.findings.length === 0 ? {} : { detail: `${String(review.findings.length)} finding${review.findings.length === 1 ? "" : "s"}${accepted > 0 ? `, ${String(accepted)} accepted by the owner` : ""}` }),
    });
  }
  // What the evidence pack kept for this code adds: the test counts, and what was not tested.
  if (pack !== undefined) {
    for (const check of pack.checks) {
      rows.push({ claim: words(check.label, 200), check: KIND_WORDS[check.kind] ?? "check", status: OUTCOME[check.after], ...(testsDetail(check) === undefined ? {} : { detail: testsDetail(check)! }) });
    }
    for (const item of pack.notTested.slice(0, 20)) rows.push({ claim: words(item.text), check: "not tested", status: "not_run", detail: words(item.reason, 100) });
  }
  const risk = workflow.risk !== undefined && workflow.risk.candidateDigest === workflow.candidate?.digest ? workflow.risk : undefined;
  const summary = [
    pack === undefined ? "No evidence was kept for this code, so only what Rovara recorded itself is shown." : `Evidence kept for this code: ${pack.environment.tier} environment${pack.environment.envRevision === 0 ? ", no approved test environment" : ""}.`,
    ...(risk === undefined ? [] : [`Risk: ${risk.level}${risk.reasons.length === 0 ? "" : ` (${risk.reasons.slice(0, 3).map((reason) => words(reason, 100)).join("; ")})`}.`]),
    changed.verified === undefined ? "The changed files have not been checked against the code host yet, so the risk stays high."
      : `Changed files, read from the code host: ${String(changed.verified.files.length)}${changed.verified.complete ? "" : " or more"} (${fileList(changed.verified.files)}).`,
    ...(changed.reported === undefined ? [] : [`The worker reported ${String(changed.reported.files.length)} changed file${changed.reported.files.length === 1 ? "" : "s"} (${fileList(changed.reported.files)}); Rovara has not checked that list and does not use it.`]),
    ...(rows.length === 0 ? ["Nothing has been checked yet."] : []),
  ].join(" ");
  return {
    taskId: task.taskId, title: task.title, revision: workflow.revision, summary, rows,
    pullRequests: (workflow.pullRequests ?? []).map((pullRequest) => ({ url: pullRequest.url, number: pullRequest.number, state: pullRequest.state.toLowerCase() })),
  };
}
