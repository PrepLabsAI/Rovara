// The answer tools of the judging steps (structured-answer.ts): what each one's schema is, how its accepted arguments become the text the step's own reader reads, and that reader as the check.
// Where a step's result contract has a zod schema in packages/contracts, the tool's schema IS that schema (so it cannot drift); where the contract is a hand-written reader (the plan check's block, a
// spec walk's rows), the schema here lists exactly the fields that reader takes, and the reader still runs on every accepted answer.
import {
  INTENT_BLOCK_INFO_STRING, IntentAssessmentSchema, PLAN_CRITIC_POINTS_MAX, PLAN_CRITIQUE_INFO_STRING, PLAN_CRITIQUE_POINT_MAX_CHARS, SPEC_VERDICTS, WorkflowReviewFindingSchema,
  parseWorkflowReviewerResponse, readIntentBlock, readPlanCritique, reviewJsonShape,
} from "@agentx/contracts";
import { z } from "zod";
import { PLAN_CRITIQUE_ANSWER_MAX_BYTES } from "./plan-critic.js";
import { answerSchemaOf, fencedBlock, type AnswerChannelSpec } from "./structured-answer.js";

/** The most findings a review answer may list: the reader's own limit. */
const REVIEW_ENTRIES_MAX = 50;

const REVIEW_PROBLEMS = {
  RESPONSE_TOO_LARGE: "Your review is too large. Keep it under 20,000 characters.",
  INVALID_JSON: "Your review could not be read as the required object.",
  INVALID_SHAPE: "Your review does not match the required shape.",
} as const;

/** The code or security review's answer: `{"findings":[...]}`, and for a version 2 code review a `risk` beside it. The findings are the contract's own finding schema. */
export function reviewAnswerSpec(role: "CRITIC" | "SECURITY", options: { risk?: boolean } = {}): AnswerChannelSpec {
  const risk = options.risk === true && role === "CRITIC";
  const shape = z.object({
    findings: z.array(WorkflowReviewFindingSchema).max(REVIEW_ENTRIES_MAX),
    ...(risk ? { risk: z.enum(["low", "medium", "high"]).optional() } : {}),
  }).strict();
  return {
    name: "submit_review",
    description: `Submit the ${role === "CRITIC" ? "code" : "security"} review. Call it once, with every finding in "findings" (an empty list when you found nothing). ${reviewJsonShape(role, { risk })}`,
    parameters: answerSchemaOf(shape),
    render: (args) => JSON.stringify(args),
    check: (text) => {
      const read = parseWorkflowReviewerResponse(text, { role, risk });
      return read.failureReason === undefined ? undefined : `${REVIEW_PROBLEMS[read.failureReason]} ${reviewJsonShape(role, { risk })}`;
    },
  };
}

/** The code review's follow-up about the spec: one verdict per requirement. Any row that is not usable is left out by the contract's reader (fail closed), so there is nothing more to check. */
export function specWalkAnswerSpec(): AnswerChannelSpec {
  const shape = z.object({
    specVerdicts: z.array(z.object({
      id: z.string(),
      verdict: z.enum(SPEC_VERDICTS),
      reason: z.string(),
      evidence: z.array(z.string()).max(12).optional(),
    }).strict()),
  }).strict();
  return {
    name: "submit_spec_verdicts",
    description: "Submit your verdict for each requirement of the spec, once, after the code review: \"met\" (with evidence), \"not_met\" or \"not_applicable\", each with a one-line reason. Include every requirement id exactly once.",
    parameters: answerSchemaOf(shape),
    render: (args) => JSON.stringify(args),
    check: () => undefined,
  };
}

/** Understand's answer: the contract's IntentAssessment, in one field (the schema is a union, and a tool's arguments must be an object). It reaches the step as the same `rovara-intent` block the text answer ends with. */
export function understandAnswerSpec(): AnswerChannelSpec {
  const shape = z.object({ assessment: IntentAssessmentSchema }).strict();
  return {
    name: "submit_understanding",
    description: `Submit your understanding of the request, once: put the answer you would have written in the ${INTENT_BLOCK_INFO_STRING} block into "assessment".`,
    parameters: answerSchemaOf(shape),
    render: (args) => fencedBlock(INTENT_BLOCK_INFO_STRING, (args as { assessment?: unknown }).assessment),
    check: (text) => {
      const read = readIntentBlock(text);
      return read.ok ? undefined : read.errors.join(" ");
    },
  };
}

const PLAIN_ID = /^[A-Za-z0-9._-]{1,32}$/u;
const PLAIN_CLAIM_ID = /^[1-9][0-9]{0,2}(\.[1-9][0-9]{0,2}){0,2}$/u;

/** The plan check's answer: a verdict and points, in the fields `readPlanCritique` takes. It reaches the step as the same `rovara-plan-critique` block, which is what the broker reads from the saved answer. */
export function planCritiqueAnswerSpec(): AnswerChannelSpec {
  const shape = z.object({
    verdict: z.enum(["ok", "revise"]),
    // The reader keeps the first PLAN_CRITIC_POINTS_MAX points (blocking first) and cuts each text to PLAN_CRITIQUE_POINT_MAX_CHARS; the schema allows a little more than it keeps and no more than the saved
    // answer can hold (PLAN_CRITIQUE_ANSWER_MAX_BYTES), so an answer is never cut at its start, which would lose the opening fence.
    points: z.array(z.object({
      id: z.string().regex(PLAIN_ID).optional(),
      severity: z.enum(["blocking", "note"]),
      text: z.string().trim().min(1).max(PLAN_CRITIQUE_POINT_MAX_CHARS),
      claimId: z.string().regex(PLAIN_CLAIM_ID).optional(),
    }).strict()).max(PLAN_CRITIC_POINTS_MAX * 2),
  }).strict();
  return {
    name: "submit_plan_check",
    description: `Submit the plan check, once: put what you would have written in the ${PLAN_CRITIQUE_INFO_STRING} block into the arguments: the verdict, and the points (blocking ones first).`,
    parameters: answerSchemaOf(shape),
    render: (args) => fencedBlock(PLAN_CRITIQUE_INFO_STRING, args),
    check: (text) => {
      if (Buffer.byteLength(text, "utf8") > PLAN_CRITIQUE_ANSWER_MAX_BYTES) return "Your plan check is too long. Give fewer and shorter points.";
      const read = readPlanCritique(text);
      return read.ok ? undefined : read.error;
    },
  };
}
