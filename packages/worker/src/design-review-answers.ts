// The answer tools of a design review (structured-answer.ts): a reviewer's findings and the merge step's groups, delivered as one tool call that Pi checks against the schema. The accepted arguments
// reach the orchestration (design-review.ts) as the same fenced block its reader already reads, so the review's contract and its text retry are unchanged; the retry only runs when no answer was
// accepted. The check is the contract's reader, with the same rule the orchestration applies to a readable block that lost findings.
import {
  DESIGN_FINDING_SEVERITIES, DESIGN_MERGE_INFO_STRING, DESIGN_REVIEW_FINDINGS_MAX, DESIGN_REVIEW_FINDINGS_PER_REVIEWER_MAX, DESIGN_REVIEW_INFO_STRING, DesignCitationSchema, DesignSectionSchema,
  readDesignMerge, readDesignReview, type ReviewerRole,
} from "@agentx/contracts";
import { z } from "zod";
import { DESIGN_REVIEW_LOST_FINDINGS_PROBLEM } from "./design-review.js";
import { answerSchemaOf, fencedBlock, type AnswerChannelSpec } from "./structured-answer.js";

const PLAIN_ID = /^[A-Za-z0-9._-]{1,32}$/u;
const MODEL_TEXT_MAX = 4_000;

/** A reviewer's answer: findings (each with 1 to 5 citations of the allowed shapes), and for the reviewer that must write one, the paraphrase. */
export function designReviewAnswerSpec(role: ReviewerRole, options: { withParaphrase?: boolean } = {}): AnswerChannelSpec {
  const writesParaphrase = role === "comprehension" || options.withParaphrase === true;
  const paraphrase = z.object({ proposes: z.string().min(1).max(MODEL_TEXT_MAX), today: z.string().min(1).max(MODEL_TEXT_MAX) }).strict();
  const shape = z.object({
    ...(writesParaphrase ? { paraphrase } : {}),
    findings: z.array(z.object({
      id: z.string().regex(PLAIN_ID).optional(),
      severity: z.enum(DESIGN_FINDING_SEVERITIES),
      section: DesignSectionSchema,
      text: z.string().min(1).max(MODEL_TEXT_MAX),
      citations: z.array(DesignCitationSchema).min(1).max(5),
    }).strict()).max(DESIGN_REVIEW_FINDINGS_PER_REVIEWER_MAX),
  }).strict();
  return {
    name: "submit_design_review",
    description: `Submit your design review, once: put what you would have written in the ${DESIGN_REVIEW_INFO_STRING} block into the arguments (the findings, each with its severity, section, text and 1 to 5 citations${writesParaphrase ? ", and the paraphrase" : ""}). An empty list means you found nothing.`,
    parameters: answerSchemaOf(shape),
    render: (args) => fencedBlock(DESIGN_REVIEW_INFO_STRING, args),
    check: (text) => {
      const read = readDesignReview(text, role, { withParaphrase: options.withParaphrase === true });
      if (!read.ok) return read.error;
      // The same rule as the text path: a block that lost findings (no valid citation, an unreadable field) is not an answer, and a lost finding must not read as "found nothing".
      return read.dropped.length + read.unusable > 0 ? DESIGN_REVIEW_LOST_FINDINGS_PROBLEM : undefined;
    },
  };
}

/** The merge step's answer: groups of raw findings. It has no field for a citation, so it cannot add one. */
export function designMergeAnswerSpec(): AnswerChannelSpec {
  const shape = z.object({
    merged: z.array(z.object({
      rawIds: z.array(z.string().min(1).max(64)).min(1).max(5 * DESIGN_REVIEW_FINDINGS_PER_REVIEWER_MAX),
      severity: z.enum(DESIGN_FINDING_SEVERITIES),
      section: DesignSectionSchema,
      text: z.string().min(1).max(MODEL_TEXT_MAX),
    }).strict()).max(DESIGN_REVIEW_FINDINGS_MAX),
  }).strict();
  return {
    name: "submit_design_merge",
    description: `Submit the merged findings, once: put what you would have written in the ${DESIGN_MERGE_INFO_STRING} block into the arguments.`,
    parameters: answerSchemaOf(shape),
    render: (args) => fencedBlock(DESIGN_MERGE_INFO_STRING, args),
    check: (text) => {
      const read = readDesignMerge(text);
      return read.ok ? undefined : read.error;
    },
  };
}
