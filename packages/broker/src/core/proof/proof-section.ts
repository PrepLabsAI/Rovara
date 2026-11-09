// Playbook P1: the "### Proof" section of a Rovara Code (version 2) pull request description: a requirement-to-evidence table (Requirement | Evidence | Result), and "What wasn't tested". (The test-proof lines are in the Tests section, once; this table only uses the per-check verdicts to mark a row "proven".)
// `buildProofTable` (proof-table.ts) decides the rows and has already made every string inert and redacted; this module only lays them out in Markdown, in plain words, and shrinks them to fit.
//
// The shrink order, level by level (`proofSection(...)(level)`): 0 full evidence; 1 fewer and shorter evidence entries; 2 evidence as counts; 3 the same, and the proven and passed rows folded into one
// count line; 4 shorter requirement text and bullets without text. A failed row, a partly tested row and a not-tested item are listed at every level: they are what a reader must not miss.
import { TestProofSchema, workflowCheckResultBroken, workflowSelectedChecks, type PlanClaim, type PlanDocument, type TestProof, type WorkflowSnapshot } from "@agentx/contracts";
import { evidenceLines, type ProofEvidenceContext } from "./evidence-lines.js";
import { buildProofTable, type ProofCheckResult, type ProofEvidence, type ProofResult, type ProofRow, type ProofScenarioRow } from "./proof-table.js";

/**
 * What the Proof section reads about design review, already resolved by the design-review code (port lane L9: `designProofLine` and `designLinksByClaim` over the approved design). `line` is the one
 * design line of the section (inert, counts and fixed words only); `linksFor` gives, for the plan's claim ids, the `§3.N` subsections of the APPROVED design that name each (a claim no section names is
 * absent). Absent from the context (design review off, or no approved design): the section is exactly what it was, byte for byte.
 */
export interface ProofDesignContext {
  line: string;
  linksFor(claimIds: readonly string[]): ReadonlyMap<string, readonly string[]>;
}

/** What the Proof section needs beyond the workflow; absent, or without a plan with claims, the section is left out. */
export interface ProofContext {
  /** The owner-approved coding plan (a structured one). */
  plan?: PlanDocument | undefined;
  /** The rows of the task's browser and API round for this code, when it had one. */
  scenarioRows?: readonly ProofScenarioRow[] | undefined;
  /** The test proof read for this code; the table ignores it unless it is bound to the workflow's candidate digest. */
  testProof?: TestProof | undefined;
  /** Proof and evidence P8: the evidence pack for this code and how much of it the pull request shows (see evidence-lines.ts). Used only when the pack is bound to the workflow's candidate digest. */
  evidence?: ProofEvidenceContext | undefined;
  /** The description already had a Proof section but the inputs above could not be read in time (see proof-keep.ts): the section shows `PROOF_STALE_LINE` instead of the old table. Used instead of `plan`. */
  stale?: boolean | undefined;
  /** Design review (DR12): the approved design and how it was reviewed and approved. Absent (design review off, or no approved design): the section is exactly as it was, byte for byte. */
  design?: ProofDesignContext | undefined;
}

/** The whole body of a Proof section whose table is out of date and could not be rebuilt in time. */
export const PROOF_STALE_LINE = "Proof is being updated for the latest change.";

/** The last shrink level (0 is the full section). */
export const PROOF_LEVEL_LAST = 4;

const RESULT_WORDS: Record<ProofResult, string> = { proven: "✅ proven", passed: "✅ passed", failed: "❌ failed", partly_tested: "⚠ partly tested", not_tested: "⚠ not tested" };
const STATE_WORDS: Record<ProofEvidence["state"], string> = { proven: "passed, fails on the original code", passed: "passed", failed: "failed", not_checked: "not checked" };

/** The check ids recorded with the workflow's check results for its current code, in the order the worker numbers its checks `readiness:<index>` (see `checkIdOfProofItem`); none when the results are for other code or there are none. */
export const recordedCheckIdsOf = (workflow: WorkflowSnapshot): string[] => proofCheckResults(workflow).map((result) => result.checkId);

/** The workflow's recorded check results as the table reads them. */
function recordedCheckResults(workflow: WorkflowSnapshot, recorded: NonNullable<WorkflowSnapshot["verification"]>): ProofCheckResult[] {
  const labels = new Map(workflowSelectedChecks(workflow.checkPolicy).map((check) => [check.id, check.label]));
  return recorded.results.map((result) => ({
    checkId: result.checkId, label: labels.get(result.checkId), status: result.status,
    couldNotRun: workflowCheckResultBroken(result) || result.neverStarted === true,
  }));
}

/** The check results recorded for the workflow's current code; none for results recorded for other code or a review-only task. */
export function proofCheckResults(workflow: WorkflowSnapshot): ProofCheckResult[] {
  const digest = workflow.candidate?.digest;
  const recorded = digest !== undefined && workflow.verification?.candidateDigest === digest ? workflow.verification : undefined;
  return recorded === undefined ? [] : recordedCheckResults(workflow, recorded);
}

/** The results recorded for code that is no longer the candidate (the task page shows them, labelled as earlier); none when the results are for the current code or there are none. */
export function earlierProofCheckResults(workflow: WorkflowSnapshot): ProofCheckResult[] {
  const recorded = workflow.verification;
  return recorded === undefined || recorded.candidateDigest === workflow.candidate?.digest ? [] : recordedCheckResults(workflow, recorded);
}

const flatClaimIds = (claims: readonly PlanClaim[]): string[] => claims.flatMap((claim) => [claim.id, ...flatClaimIds(claim.children ?? [])]);

const cut = (text: string, max: number) => {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`;
};
/** A table cell: one line, and a pipe cannot add a column. */
const cell = (text: string) => text.replaceAll("|", "¦");
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function evidenceCell(row: ProofRow, level: number): string {
  const design = row.designSections === undefined ? undefined : `design ${row.designSections.join(", ")}`;
  const own = evidenceCellOf(row, level);
  return design === undefined ? own : `${design}; ${own}`;
}

function evidenceCellOf(row: ProofRow, level: number): string {
  if (row.evidence.length === 0) return "none";
  const entry = (item: ProofEvidence, max: number) => `${item.kind === "scenario" ? "Scenario: " : ""}${cut(item.label, max)} (${STATE_WORDS[item.state]})`;
  if (level === 0) return row.evidence.slice(0, 4).map((item) => entry(item, 80)).join("; ") + (row.evidence.length > 4 ? ` and ${row.evidence.length - 4} more` : "");
  if (level === 1) return row.evidence.slice(0, 2).map((item) => entry(item, 40)).join("; ") + (row.evidence.length > 2 ? ` and ${row.evidence.length - 2} more` : "");
  const checks = row.evidence.filter((item) => item.kind === "check").length;
  const scenarios = row.evidence.length - checks;
  return [...(checks > 0 ? [plural(checks, "check")] : []), ...(scenarios > 0 ? [plural(scenarios, "scenario")] : [])].join(", ");
}

/** The names of the tests the broker's own TestProof, bound to this code's digest, says fail on the original code (per-test verdicts only); undefined when there is no such proof or it has no per-test verdicts. */
export function provenTestNames(testProof: unknown, candidateDigest: string | undefined): ReadonlySet<string> | undefined {
  if (candidateDigest === undefined || testProof === undefined) return undefined;
  const parsed = TestProofSchema.safeParse(testProof);
  if (!parsed.success || parsed.data.candidateDigest !== candidateDigest) return undefined;
  const items = parsed.data.items.filter((item) => item.granularity === "test" && item.test !== undefined);
  return items.length === 0 ? undefined : new Set(items.filter((item) => item.verdict === "proves_change").map((item) => item.test!));
}

/**
 * The section's builder, or undefined when there is no approved plan with claims (the section is then left out and the description is exactly as it was). The table is computed once; call the
 * returned function with a shrink level (0..PROOF_LEVEL_LAST) for the lines at that level, without the blank line that separates the section from Tests.
 */
export function proofSection(workflow: WorkflowSnapshot, proof: ProofContext | undefined, resultLabel?: string): ((level: number) => string[]) | undefined {
  if (proof?.stale === true) return () => ["### Proof", "", PROOF_STALE_LINE];
  const plan = proof?.plan;
  if (plan === undefined || !Array.isArray(plan.claims) || plan.claims.length === 0) return undefined;
  // Design review (DR12): links to sections that exist in the APPROVED design only; with no design context the table is built exactly as before.
  const design = proof?.design;
  const designLinks = design === undefined ? undefined : design.linksFor(flatClaimIds(plan.claims));
  const table = buildProofTable({
    plan, checkResults: proofCheckResults(workflow), scenarioRows: proof?.scenarioRows ?? [], testProof: proof?.testProof, candidateDigest: workflow.candidate?.digest, recordedCheckIds: recordedCheckIdsOf(workflow),
    ...(designLinks === undefined ? {} : { designLinks }),
  });
  return (level) => {
    const requirementMax = level >= 4 ? 60 : level >= 3 ? 120 : level >= 2 ? 160 : level === 1 ? 200 : 300;
    const folded = level >= 3 ? table.rows.filter((row) => row.result === "proven" || row.result === "passed") : [];
    const shown = table.rows.filter((row) => !folded.includes(row));
    // Setup and test health SH18: with the four results on, the table starts with the result (one of four fixed words), the same as the Testing section's heading.
    const lines = ["### Proof", "", ...(resultLabel === undefined ? [] : [`Result: ${resultLabel}`, ""]), ...(design === undefined ? [] : [design.line, ""])];
    if (shown.length > 0) {
      lines.push("| Requirement | Evidence | Result |", "| --- | --- | --- |",
        ...shown.map((row) => `| ${cell(`${row.claimId}: ${cut(row.requirement, requirementMax)}`)} | ${cell(evidenceCell(row, level))} | ${RESULT_WORDS[row.result]} |`));
    }
    if (folded.length > 0) {
      const proven = folded.filter((row) => row.result === "proven").length;
      lines.push("", `${plural(folded.length, "more requirement")} proven or passed${proven > 0 ? ` (${proven} also fail${proven === 1 ? "s" : ""} on the original code)` : ""}; their rows are left out to keep this description short.`);
    }
    // Proof and evidence P8: counts per kind and coverage (levels 0 and 1 only), then Environment, what was not run and the link, then the mocked and not-selected items under "What wasn't tested".
    const evidence = evidenceLines(proof?.evidence, workflow.candidate?.digest, level, { proven: provenTestNames(proof?.testProof, workflow.candidate?.digest), alreadyListed: new Set(table.notTested.map((item) => `${item.kind}:${item.id}`)) });
    if (evidence.lines.length > 0) lines.push("", ...evidence.lines.map((line) => `- ${line}`));
    if (table.notTested.length > 0 || evidence.notTested.length > 0) {
      lines.push("", "What wasn't tested:", ...evidence.notTested, ...table.notTested.map((item) => {
        // Level 4 names the item by its ID only; the others by its words, cut.
        const noun = item.kind === "claim" ? "Requirement" : item.kind === "scenario" ? "Scenario" : "Check";
        const name = level >= 4 ? item.id : item.kind === "claim" ? `${item.id}: ${cut(item.text, level >= 2 ? 80 : 120)}` : cut(item.text, 80);
        return `- ${noun} ${name} (${item.reason})`;
      }));
    }
    return lines;
  };
}
