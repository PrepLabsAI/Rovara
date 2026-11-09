// Playbook P1: the requirement-to-evidence table of a Rovara Code (version 2) pull request. One row per claim of the approved plan; its evidence is the plan's checks whose `proves` names the claim
// (a check that proves a child also covers its ancestors, as the plan self-check counts it) and the browser/API scenarios `scenarioProves` names. A pure function: it reads nothing, writes
// nothing and calls no model. Every string it returns is redacted and inert (`inertLine`), because the claims, check labels and scenario titles are a model's words and the description is public to
// the repository's readers.
//
// A claim is NOT static-only when the plan self-check says so: `planQualityFindings` gives a `claim-static-only` finding for a claim proved only by checks that read files (`grep`, `cat`, `test`) and
// by no check or scenario that runs the code. That finding is the plan's own notion; this module asks it and does not guess. (The finding names at most 32 claims and only leaf claims; a parent is
// static-only when all its leaves are.)
import { TestProofSchema, type PlanClaim, type PlanDocument, type TestProof } from "@agentx/contracts";
import { planQualityFindings } from "../../developer/plan-quality.js";
import { testProofPullRequestLines } from "../../developer/test-proof-lines.js";
import { inertLine } from "./inert-text.js";

const CLAIM_TEXT_MAX = 300;
const LABEL_MAX = 120;
const TEST_PROOF_LINE_MAX = 300;

/** One check's recorded result for the current code, as the workflow holds it. `couldNotRun`: the command was broken, its program missing, or it never started: the code is not at fault. */
export interface ProofCheckResult {
  checkId: string;
  label?: string | undefined;
  status: "PASS" | "FAILED" | "UNKNOWN";
  couldNotRun?: boolean | undefined;
}

/** A browser or API scenario's row (`E2EDisplayScenario`), cut to what the table reads. */
export interface ProofScenarioRow {
  scenarioId: string;
  title: string;
  kind?: "web" | "api" | undefined;
  status: "PASSED" | "FAILED" | "UNKNOWN";
}

/** `partly_tested`: some evidence, but a part of the claim (a child claim, or a linked check or scenario) is not tested. */
export type ProofResult = "proven" | "passed" | "failed" | "partly_tested" | "not_tested";
/** `proven`: a check that also fails on the original code (a test proof). `not_checked`: no result, or it could not run. */
export type ProofEvidenceState = "proven" | "passed" | "failed" | "not_checked";

export interface ProofEvidence {
  kind: "check" | "scenario";
  /** Inert and cut; a scenario's label is its title. */
  label: string;
  state: ProofEvidenceState;
}

export interface ProofRow {
  claimId: string;
  /** The claim's text, inert and cut to 300 characters. */
  requirement: string;
  evidence: ProofEvidence[];
  result: ProofResult;
  /** Design review (DR12): the `§3.N` subsections of the approved design that name this requirement. Present only when there are some; absent when design review is off or no section names the claim. */
  designSections?: string[];
}

/** What was not tested, in fixed words: `reason` is one of a short list, never model text. */
export interface NotTestedItem {
  kind: "claim" | "scenario" | "check";
  id: string;
  /** The claim's text, the scenario's title or the check's label, inert and cut. */
  text: string;
  reason: string;
}

export interface ProofTable {
  rows: ProofRow[];
  notTested: NotTestedItem[];
}

export interface ProofTableInput {
  plan: PlanDocument;
  checkResults: readonly ProofCheckResult[];
  scenarioRows: readonly ProofScenarioRow[];
  /** Used only when its `candidateDigest` equals `candidateDigest`; otherwise ignored, as if absent. */
  testProof: TestProof | undefined;
  candidateDigest: string | undefined;
  /**
   * The check ids recorded with the check results the test proof belongs to (`workflow.verification.results[i].checkId`, in selection order, for the current code): what the worker's `readiness:<index>` ids in the proof stand for.
   * Absent or empty, or a different number than the proof's checks: the proof marks nothing proven.
   */
  recordedCheckIds?: readonly string[] | undefined;
  /** Design review (DR12): claim id to the existing `§3.N` subsections of the approved design that name it (`designLinksByClaim`). Absent: rows are exactly as before. */
  designLinks?: ReadonlyMap<string, readonly string[]> | undefined;
}

const READINESS_ID = /^readiness:(0|[1-9]\d{0,5})$/u;

/**
 * The check a test-proof item is about. The worker numbers the project checks it runs `readiness:<index>`, in the order of the task's selected checks at the time (required, proposed, selected optional), and
 * the broker records the check results in that same order. The index is read through those recorded results, not through the policy as it is now: a verification retry can change the selection and keep the results. An id
 * that is not exactly `readiness:` and a canonical index, or whose index is past the recorded checks, is about no check: undefined, never matched to one by accident.
 */
export function checkIdOfProofItem(itemCheckId: string, recordedCheckIds: readonly string[] | undefined): string | undefined {
  const index = READINESS_ID.exec(itemCheckId)?.[1];
  return index === undefined ? undefined : recordedCheckIds?.[Number(index)];
}

/** Whether the proof's checks are the recorded results' checks: the worker writes an item for each of its checks, so for n recorded results the proof names `readiness:0` to `readiness:<n-1>`, no more and no fewer. */
function proofMatchesRecorded(proof: TestProof, recordedCheckIds: readonly string[] | undefined): boolean {
  if (recordedCheckIds === undefined || recordedCheckIds.length === 0) return false;
  const indexes = new Set<number>();
  for (const item of proof.items) {
    const index = READINESS_ID.exec(item.checkId)?.[1];
    if (index !== undefined) indexes.add(Number(index));
  }
  return indexes.size === recordedCheckIds.length && [...indexes].every((index) => index < recordedCheckIds.length);
}

export const NOT_TESTED_REASONS = {
  claimNothingLinked: "no check or scenario names it",
  claimPartLinkedDidNotRun: "a linked check or scenario did not run",
  claimStaticOnly: "only checks that read files prove it",
  claimDidNotRun: "its checks or scenarios did not run",
  scenarioNotExercised: "it was not exercised",
  checkCouldNotRun: "it could not run",
} as const;

function flatClaims(claims: readonly PlanClaim[]): PlanClaim[] {
  return claims.flatMap((claim) => [claim, ...flatClaims(claim.children ?? [])]);
}

function leafIds(claim: PlanClaim): string[] {
  const children = claim.children ?? [];
  return children.length === 0 ? [claim.id] : children.flatMap(leafIds);
}

/** The claims the plan self-check says are proved only by checks that read files. A parent counts when all its leaves do. Anything the rules cannot read gives none. */
function staticOnlyClaimIds(plan: PlanDocument): Set<string> {
  let named: Set<string>;
  try {
    named = new Set(planQualityFindings(plan, { kind: "plan" }).filter((finding) => finding.code === "claim-static-only").flatMap((finding) => finding.claimIds ?? []));
  } catch {
    return new Set();
  }
  return new Set(flatClaims(plan.claims).filter((claim) => leafIds(claim).every((id) => named.has(id))).map((claim) => claim.id));
}

/** The test proof when it parses and is bound to the current candidate digest; otherwise nothing. */
function boundTestProof(testProof: unknown, candidateDigest: string | undefined): TestProof | undefined {
  if (candidateDigest === undefined || testProof === undefined) return undefined;
  const parsed = TestProofSchema.safeParse(testProof);
  return parsed.success && parsed.data.candidateDigest === candidateDigest ? parsed.data : undefined;
}

const oneLine = (text: string, max: number) => inertLine(text, max);

/**
 * The test-proof lines (#412's, from `testProofPullRequestLines`) for a proof bound to `candidateDigest`, made inert; none for any other proof. The pull request's Tests section lists them (once) and so does the task page's
 * proof block; the Proof table does not repeat them.
 */
export function testProofLinesOf(testProof: unknown, candidateDigest: string | undefined): string[] {
  const proof = boundTestProof(testProof, candidateDigest);
  return proof === undefined ? [] : testProofPullRequestLines(proof, candidateDigest, (line) => inertLine(line, TEST_PROOF_LINE_MAX));
}

const PARTLY_IDS_MAX = 30;
/** Which part of a partly tested claim is missing, in fixed words and the plan's claim IDs (inert), within the contract's 100 characters. */
function partlyReason(childIds: readonly string[], linkedDidNotRun: boolean): string {
  const parts: string[] = [];
  if (childIds.length > 0) {
    let named = "";
    let count = 0;
    for (const id of childIds) {
      const next = `${named}${count === 0 ? "" : ", "}${oneLine(id, 20)}`;
      if (next.length > PARTLY_IDS_MAX) break;
      named = next;
      count += 1;
    }
    parts.push(count === 0 ? "part of it is not tested" : `part not tested: ${named}${count < childIds.length ? ` and ${childIds.length - count} more` : ""}`);
  }
  if (linkedDidNotRun) parts.push(NOT_TESTED_REASONS.claimPartLinkedDidNotRun);
  return parts.join("; ");
}

type CheckState = "passed" | "failed" | "not_checked";

export function buildProofTable(input: ProofTableInput): ProofTable {
  const { plan } = input;
  const proof = boundTestProof(input.testProof, input.candidateDigest);
  const proposed = plan.checks?.proposed ?? [];
  const proves = plan.checks?.proves ?? {};
  const labelOfCheck = new Map<string, string>();
  for (const result of input.checkResults) if (result.label !== undefined) labelOfCheck.set(result.checkId, result.label);
  for (const check of proposed) labelOfCheck.set(check.id, check.label);
  const resultOf = new Map(input.checkResults.map((result) => [result.checkId, result]));
  const stateOfCheck = (checkId: string): CheckState => {
    const result = resultOf.get(checkId);
    if (result === undefined || result.couldNotRun === true) return "not_checked";
    return result.status === "PASS" ? "passed" : result.status === "FAILED" ? "failed" : "not_checked";
  };
  const provesChange = new Set((proof !== undefined && proofMatchesRecorded(proof, input.recordedCheckIds) ? proof.items : []).filter((item) => item.verdict === "proves_change").flatMap((item) => checkIdOfProofItem(item.checkId, input.recordedCheckIds) ?? []));
  const checkOrder = [...new Set([...proposed.map((check) => check.id), ...Object.keys(proves)])];

  const rowOfScenario = new Map(input.scenarioRows.map((row) => [row.scenarioId, row]));
  const scenarioProves = plan.scenarioProves ?? {};
  const scenarioState = (scenarioId: string): CheckState => {
    const row = rowOfScenario.get(scenarioId);
    return row === undefined ? "not_checked" : row.status === "PASSED" ? "passed" : row.status === "FAILED" ? "failed" : "not_checked";
  };
  const titleOfScenario = (scenarioId: string) => rowOfScenario.get(scenarioId)?.title ?? scenarioId.replace(/[-_]+/gu, " ");

  const staticOnly = staticOnlyClaimIds(plan);
  const rows: ProofRow[] = [];
  const notTested: NotTestedItem[] = [];

  // A claim's result is no better than its weakest part: computed from the leaves up, so a parent reads the results of its children. Each claim is listed in `notTested` once; its children are listed on their own.
  const evaluate = (claim: PlanClaim): ProofResult => {
    const childResults = (claim.children ?? []).map((child) => ({ child, result: evaluate(child) }));
    // The claim's own ID and its descendants': a proof of a child also covers its ancestors, never the reverse.
    const covered = new Set([claim.id, ...flatClaims(claim.children ?? []).map((child) => child.id)]);
    const evidence: ProofEvidence[] = [];
    for (const checkId of checkOrder) {
      if (!(proves[checkId] ?? []).some((id) => covered.has(id))) continue;
      const state = stateOfCheck(checkId);
      evidence.push({ kind: "check", label: oneLine(labelOfCheck.get(checkId) ?? checkId, LABEL_MAX), state: state === "passed" && provesChange.has(checkId) ? "proven" : state });
    }
    for (const [scenarioId, ids] of Object.entries(scenarioProves)) {
      if (!ids.some((id) => covered.has(id))) continue;
      evidence.push({ kind: "scenario", label: oneLine(titleOfScenario(scenarioId), LABEL_MAX), state: scenarioState(scenarioId) });
    }
    const has = (state: ProofEvidenceState) => evidence.some((item) => item.state === state);
    // A failure is never hidden by a proof beside it.
    const base: ProofResult = has("failed") || childResults.some((entry) => entry.result === "failed") ? "failed"
      : has("proven") ? "proven"
        : evidence.length > 0 && staticOnly.has(claim.id) ? "not_tested"
          : has("passed") ? "passed" : "not_tested";
    // Some evidence is not enough to call the whole claim tested: a child that is not (fully) tested, or a linked check or scenario that did not run, leaves it partly tested.
    const partChildren = childResults.filter((entry) => entry.result === "not_tested" || entry.result === "partly_tested");
    const linkedDidNotRun = has("not_checked");
    const result: ProofResult = (base === "proven" || base === "passed") && (partChildren.length > 0 || linkedDidNotRun) ? "partly_tested" : base;
    const requirement = oneLine(claim.text, CLAIM_TEXT_MAX);
    const designSections = input.designLinks?.get(claim.id);
    rows.push({ claimId: claim.id, requirement, evidence, result, ...(designSections === undefined || designSections.length === 0 ? {} : { designSections: [...designSections] }) });
    if (result === "not_tested") {
      notTested.push({
        kind: "claim", id: claim.id, text: requirement,
        reason: evidence.length === 0 ? NOT_TESTED_REASONS.claimNothingLinked : staticOnly.has(claim.id) ? NOT_TESTED_REASONS.claimStaticOnly : NOT_TESTED_REASONS.claimDidNotRun,
      });
    } else if (result === "partly_tested") {
      notTested.push({ kind: "claim", id: claim.id, text: requirement, reason: partlyReason(partChildren.map((entry) => entry.child.id), linkedDidNotRun) });
    }
    return result;
  };
  for (const claim of plan.claims) evaluate(claim);
  // Rows and not-tested items read in the plan's order (a parent before its children), though they were computed leaves first. Only claims are in `notTested` so far.
  const order = new Map(flatClaims(plan.claims).map((claim, index) => [claim.id, index]));
  const byPlan = (left: string, right: string) => (order.get(left) ?? 0) - (order.get(right) ?? 0);
  rows.sort((left, right) => byPlan(left.claimId, right.claimId));
  notTested.sort((left, right) => byPlan(left.id, right.id));

  // Scenarios the plan declares that were skipped or not exercised on this code: no row, or a row that could not tell.
  for (const scenario of plan.e2e?.scenarios ?? []) {
    if (scenarioState(scenario.scenarioId) === "not_checked") notTested.push({ kind: "scenario", id: oneLine(scenario.scenarioId, 60), text: oneLine(titleOfScenario(scenario.scenarioId), LABEL_MAX), reason: NOT_TESTED_REASONS.scenarioNotExercised });
  }
  for (const scenarioId of Object.keys(scenarioProves)) {
    if ((plan.e2e?.scenarios ?? []).some((scenario) => scenario.scenarioId === scenarioId)) continue;
    if (scenarioState(scenarioId) === "not_checked") notTested.push({ kind: "scenario", id: oneLine(scenarioId, 60), text: oneLine(titleOfScenario(scenarioId), LABEL_MAX), reason: NOT_TESTED_REASONS.scenarioNotExercised });
  }
  // Checks that could not run: the plan's proposed checks and every other result, none recorded or one that says it could not run.
  for (const checkId of [...new Set([...checkOrder, ...input.checkResults.map((result) => result.checkId)])]) {
    if (stateOfCheck(checkId) === "not_checked") notTested.push({ kind: "check", id: oneLine(checkId, 60), text: oneLine(labelOfCheck.get(checkId) ?? checkId, LABEL_MAX), reason: NOT_TESTED_REASONS.checkCouldNotRun });
  }

  return { rows, notTested };
}
