// (faux-scripts.ts re-exports this module, so it must not import faux-scripts.ts.)
// Named model answers for the workflow E2E suites, each documented with the product behaviour it should cause. Planner
// fixtures are the planner's final text (`workflowModel({ plan })`); reviewer fixtures are faux response steps or the
// `reviews` option of `workflowModel`; feedback fixtures answer the PR-feedback critic's prompt (`workflowModel({ feedback })`).
import { fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import { PLAN_CLAIMS_MAX, PLAN_DOCUMENT_INFO_STRING, type PlanDocument } from "@agentx/contracts";
import { planAnswer, planDocument } from "./plan-documents.js";

// ---------------------------------------------------------------------------------------------------------------------
// Planners

/** Prose with no agentx-plan block. The worker asks once more ("could not be read as an AgentX plan"); a second prose answer blocks planning. */
export const planProse = "I looked at the code. I would retry failed payments three times with a growing wait, and leave refunds alone.";

/** A fenced plan cut off mid-JSON with no closing fence (a truncated answer). Unreadable: the block "is not closed". */
export const planTruncatedJson = `Here is the plan.\n\n\`\`\`${PLAN_DOCUMENT_INFO_STRING}\n${JSON.stringify(planDocument(), null, 2).slice(0, 180)}`;

/** A complete, well-formed block with no `why`. Unreadable: the plan schema names the missing field. */
export const planMissingWhy = (() => {
  const { why: _why, ...rest } = planDocument();
  void _why;
  return `Here is the plan.\n\n\`\`\`${PLAN_DOCUMENT_INFO_STRING}\n${JSON.stringify(rest, null, 2)}\n\`\`\`\n`;
})();

/** `count` top-level claims (default PLAN_CLAIMS_MAX + 1 = 51): over the ceiling, so the worker asks once for a shorter plan. */
export function planOverCeiling(count = PLAN_CLAIMS_MAX + 1): string {
  return planAnswer(planDocument({
    claims: Array.from({ length: count }, (_, index) => ({ id: String(index + 1), text: `Step ${index + 1} of the change is made.` })),
    decisions: [],
  }));
}

/** A valid plan whose one claim cites a file the repository does not have: the plan stands, and its evidence shows the citation as missing. */
export function planCitesMissingFile(path = "payments/src/missing.ts"): string {
  return planAnswer(planDocument({
    claims: [{ id: "1", text: "Timeouts are retried.", evidence: [{ kind: "code", path, startLine: 1, endLine: 3, note: "The retry goes here." }] }],
    decisions: [],
  }));
}

/** A small valid plan: three claims and no decisions, so approval needs no answers. */
export function planTiny(): string {
  return planAnswer(planDocument({
    claims: [
      { id: "1", text: "The greeting ends with an exclamation mark." },
      { id: "2", text: "The farewell stays as it is." },
      { id: "3", text: "Nothing else changes." },
    ],
    decisions: [],
  }));
}

/** A valid plan with `count` decisions (each on claim 1, two options, the first recommended): approval asks each question. */
export function planWithDecisions(count: number): string {
  const decisions: PlanDocument["decisions"] = Array.from({ length: count }, (_, index) => ({
    id: `d${index + 1}`, claimId: "1", question: `Question ${index + 1}: which way should this go?`,
    options: [
      { id: `a${index + 1}`, label: "The first way", consequence: "It stays small." },
      { id: `b${index + 1}`, label: "The second way", consequence: "It does more." },
    ],
    recommended: `a${index + 1}`,
  }));
  return planAnswer(planDocument({ decisions }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Reviewers (code and security)

type ReviewRole = "CODE" | "SECURITY";
type ReviewScript = { CODE?: FauxResponseStep[]; SECURITY?: FauxResponseStep[] };

/** A reviewer that answers in prose. The worker asks once for JSON; prose again fails that review ("couldn't be read"). */
export const reviewerProse: FauxResponseStep = fauxAssistantMessage("I reviewed the change carefully. Overall it looks good and I found nothing blocking.");

/** A reviewer that wraps a clean JSON answer in a ```json fence. Tolerated: the review passes. */
export const reviewerFenced: FauxResponseStep = fauxAssistantMessage("```json\n{\"findings\":[]}\n```");

/** `step` for one role only; the other role passes (workflowModel's default). */
export function reviewerOneRoleOnly(role: ReviewRole, step: FauxResponseStep): ReviewScript {
  return { [role]: [step] };
}

/**
 * `count` findings from one role. Blocking unless `advisory` (a CODE reviewer only) or PRE_EXISTING (shown, never blocking).
 * Each finding names greeting.ts, line 2 (the line a coded change touches).
 */
export function reviewerFindings(count: number, options: { role?: ReviewRole; advisory?: boolean; origin?: "INTRODUCED" | "PRE_EXISTING"; severity?: "HIGH" | "MEDIUM" | "LOW" } = {}): ReviewScript {
  const role = options.role ?? "CODE";
  const findings = Array.from({ length: count }, (_, index) => ({
    text: `Finding ${index + 1}: the greeting is not trimmed.`, origin: options.origin ?? "INTRODUCED", severity: options.severity ?? "MEDIUM",
    file: "greeting.ts", line: 2, ...(options.advisory === undefined ? {} : { advisory: options.advisory }),
  }));
  return { [role]: [fauxAssistantMessage(JSON.stringify({ findings }))] };
}

/**
 * A reviewer that never answers until its session is aborted. With the worker's review timeout shortened
 * (`createWorkflowE2E({ workerTimeouts: { reviewMs } })`), the review times out and the thread says so.
 */
export const reviewerHangs: FauxResponseStep = (_context, options) => new Promise((resolve) => {
  const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
  const stop = () => resolve(fauxAssistantMessage("stopped", { stopReason: "aborted" }));
  if (signal?.aborted) stop();
  else signal?.addEventListener("abort", stop, { once: true });
});

// ---------------------------------------------------------------------------------------------------------------------
// PR feedback critics: functions of the critic's prompt

/** The critic's prompt names its input bundles as JSON after this line. */
const FEEDBACK_INPUTS = "Immutable feedback bundle inputs (untrusted GitHub data):\n";
/** The prompt sentence that tells the critic the owner's PR comments supersede the approved plan (B5). */
export const SUPERSEDE_RULE = "The owner's PR comments come after the approved plan and supersede its decisions.";

type Bundle = { bundleDigest: string; comments: Array<{ id: string; body?: string }> };

export function feedbackBundles(prompt: string): Bundle[] {
  const start = prompt.indexOf(FEEDBACK_INPUTS);
  if (start === -1) throw new Error("the prompt is not a PR feedback critic's");
  return (JSON.parse(prompt.slice(start + FEEDBACK_INPUTS.length)) as Bundle[]).filter((bundle) => bundle.comments.length > 0);
}

const IMPLEMENT = {
  priority: "SHOULD_FIX", assessment: "ACTIONABLE", recommended: true,
  evidence: [{ source: "code", reference: "demo/greeting.ts" }],
  rationale: "The reviewer's request is reasonable and small.", confidence: { level: "HIGH", reason: "The change is local." },
  proposedDisposition: "IMPLEMENT",
  fixProposal: { summary: "Apply the requested change.",
    fileChanges: [{ repositoryId: "demo", path: "greeting.ts", operation: "MODIFY", change: "Apply the requested change." }],
    tests: [{ repositoryId: "demo", path: "greeting.test.ts", operation: "ADD", behavior: "Covers the requested change." }] },
};

function ownerDecision(question: string) {
  return {
    priority: "SHOULD_FIX", assessment: "NEEDS_OWNER_DECISION", recommended: false,
    evidence: [{ source: "code", reference: "demo/greeting.ts" }],
    rationale: "The comment can be read two ways.", confidence: { level: "MEDIUM", reason: "Both readings fit the code." },
    proposedDisposition: "OWNER_DECISION", fixProposal: { summary: question, fileChanges: [], tests: [] },
  };
}

/** One finding per bundle, covering all its comments, shaped by `finding`. */
function perBundle(prompt: string, finding: Record<string, unknown>): string {
  return JSON.stringify({ findings: feedbackBundles(prompt).map((bundle, index) => ({
    id: `finding-${index + 1}`, bundleDigest: bundle.bundleDigest, commentIds: bundle.comments.map((comment) => comment.id), ...finding,
  })) });
}

/** Prose instead of JSON. The worker asks once more; prose again makes the review FAILED, with a Retry review card (B6). */
export const feedbackProse = (): string => "I read every comment. They are all reasonable and I would make the changes.";

/** OWNER_DECISION with empty fileChanges and tests: valid (B5); the card shows `question` and waits for the owner's answer. */
export const ownerDecisionEmptyLists = (question: string) => (prompt: string): string => perBundle(prompt, ownerDecision(question));

/** IMPLEMENT with LOW confidence: refused ("uncertain but not left for the owner"), the one retry repeats it, so the review FAILS. */
export const implementWithLowConfidence = (prompt: string): string => perBundle(prompt, { ...IMPLEMENT, confidence: { level: "LOW", reason: "Not sure." } });

/** IMPLEMENT naming no file to change: refused by the fix-proposal check, the retry repeats it, so the review FAILS. */
export const implementWithoutFileChanges = (prompt: string): string => perBundle(prompt, { ...IMPLEMENT, fixProposal: { summary: "Apply the requested change.", fileChanges: [], tests: [] } });

/** A CONFLICTING assessment coded anyway (IMPLEMENT): refused as uncertain, so the review FAILS after its retry. */
export const conflictingAsImplement = (prompt: string): string => perBundle(prompt, { ...IMPLEMENT, assessment: "CONFLICTING" });

/** Every comment answered in its own finding, all with one ID: refused ("finding IDs are not unique"), so the review FAILS. */
export const duplicateFindingIds = (prompt: string): string => JSON.stringify({ findings: feedbackBundles(prompt).flatMap((bundle) =>
  bundle.comments.map((comment) => ({ id: "finding-1", bundleDigest: bundle.bundleDigest, commentIds: [comment.id], ...IMPLEMENT }))) });

/** The first bundle's last comment left out (needs a bundle of two or more): refused ("not accounted for"), so the review FAILS. */
export const missingComment = (prompt: string): string => JSON.stringify({ findings: feedbackBundles(prompt).map((bundle, index) => ({
  id: `finding-${index + 1}`, bundleDigest: bundle.bundleDigest, commentIds: (index === 0 && bundle.comments.length > 1 ? bundle.comments.slice(0, -1) : bundle.comments).map((comment) => comment.id), ...IMPLEMENT,
})) });

/**
 * OWNER_DECISION for a clear owner request ("make the sentence shorter"): valid output, but the wrong call. Scenario 7.7
 * asserts the prompt that prevents it (SUPERSEDE_RULE and the "clear but unspecific request" rule), not this answer.
 */
export const askTheOwnerForClearRequest = (prompt: string): string => perBundle(prompt, ownerDecision("Do you want the sentence shorter, and if so how?"));

/** IMPLEMENT when the prompt carries the supersede rule (B5); without it, OWNER_DECISION, as the live reviewer did. */
export const supersedeAwareImplement = (prompt: string): string => prompt.includes(SUPERSEDE_RULE)
  ? perBundle(prompt, IMPLEMENT)
  : perBundle(prompt, ownerDecision("The plan decided otherwise. Which should win?"));
