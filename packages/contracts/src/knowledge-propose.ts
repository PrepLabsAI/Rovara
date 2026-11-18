// Lead 4 L4-AK3: outside AI tools AND Rovara's own agents may only PROPOSE team knowledge (owner decision 2026-11-17, DEC 254zzz7). A proposal is a SUGGESTED lesson from a weak source: it lands in the weekly
// review and a person decides; nothing here can make a lesson live. The words below are fixed (nothing a caller sent is echoed back), and the numbers are the owner's start values. Not browser-safe on purpose: no
// page uses the request shapes (the lessons view's `proposedBy` field is the one thing a screen reads).
import { z } from "zod";
import { forwardReader } from "./forward-reader.js";
import { LOCAL_LESSONS_REMOTE_MAX } from "./lessons-local-tools.js";

/** Who proposed: an AI tool outside Rovara (the MCP `team_propose` tool) or one of Rovara's own agents (the worker's `knowledge_propose` tool). Shown on the card as "proposed by <agent|tool>". */
export const KNOWLEDGE_PROPOSERS = ["tool", "agent"] as const;
export type KnowledgeProposer = (typeof KNOWLEDGE_PROPOSERS)[number];

/** The company switch's one fixed sentence (owner decision 2026-11-17): every MCP knowledge and wiki tool answers exactly this while "Knowledge stays in Rovara" is on. Rovara's own agents are not affected. */
export const KNOWLEDGE_STAYS_SENTENCE = "Your company keeps team knowledge inside Rovara.";

/** At most this many proposals from one task (across its steps), and from one person's tools in one UTC day. */
export const KNOWLEDGE_PROPOSALS_PER_TASK_MAX = 3;
export const KNOWLEDGE_PROPOSALS_PER_PERSON_DAY_MAX = 10;

const NoControl = (value: string): boolean => !/[\p{Cc}\p{Cf}]/u.test(value);
/** The kinds a proposal may be. Never `review_check`: a check that reviewers enforce is decided by the people who own reviews, not suggested by a tool. A fact is a claim about the code; the rest are advice. */
export const KNOWLEDGE_PROPOSAL_TYPES = ["convention", "pitfall", "procedure", "preference", "fact"] as const;

/**
 * One suggestion. `advice` is the one imperative sentence (the lesson's title, 80), `why` the reason (160), `when` where or when it applies (200; the lesson's body reads "When <when>: <advice>"). `paths` are up to 5 globs
 * the advice is about; `repo` (the tool's checkout remote, for the MCP tool only) narrows it to one of the project's repositories. No field exists for a tool, a grant, a command, a budget or an approval.
 */
export const KnowledgeProposalSchema = z.object({
  advice: z.string().min(8).max(80).refine(NoControl, "must not contain control characters"),
  why: z.string().max(160).refine(NoControl, "must not contain control characters").optional(),
  when: z.string().max(200).refine(NoControl, "must not contain control characters").optional(),
  type: z.enum(KNOWLEDGE_PROPOSAL_TYPES).optional(),
  paths: z.array(z.string().min(1).max(200).refine(NoControl, "must not contain control characters")).max(5).optional(),
}).strict();
export type KnowledgeProposal = z.infer<typeof KnowledgeProposalSchema>;

/** `POST /v1/dev/projects/{project}/knowledge/propose`, the MCP tool's request: the suggestion and, optionally, the checkout's remote. */
export const KnowledgeProposeBodySchema = KnowledgeProposalSchema.extend({
  repo: z.string().min(1).max(LOCAL_LESSONS_REMOTE_MAX).refine(NoControl, "must not contain control characters").optional(),
}).strict();
export type KnowledgeProposeBody = z.infer<typeof KnowledgeProposeBodySchema>;

/** Why a proposal was not taken, in fixed codes (the words are `KNOWLEDGE_PROPOSE_MESSAGES`). */
export const KNOWLEDGE_PROPOSE_REFUSALS = ["not_valid", "asks_for_change", "has_command_or_link", "learning_off", "day_limit", "task_limit", "unavailable"] as const;
export type KnowledgeProposeRefusal = (typeof KNOWLEDGE_PROPOSE_REFUSALS)[number];
export const KNOWLEDGE_PROPOSE_MESSAGES: Readonly<Record<KnowledgeProposeRefusal, string>> = {
  not_valid: "A suggestion is one sentence of advice (8 to 80 characters), with an optional reason and where it applies. Check what you sent.",
  asks_for_change: "A suggestion cannot ask to change tools, access, checks, approvals, models or limits. Leave that to people.",
  has_command_or_link: "A suggestion is advice in words. It cannot hold a command, a link or encoded text.",
  learning_off: "Rovara is not learning for this project right now, so a suggestion cannot be kept.",
  day_limit: "You have sent as many team suggestions as are allowed today. Try again tomorrow.",
  task_limit: "This task has already sent as many team suggestions as are allowed.",
  unavailable: "Rovara can't take a suggestion right now. Try again.",
};
/** What a tool or an agent is told when a suggestion is kept: it does not say whether it was new, merged or held for a second sighting, and it promises nothing but a person's decision. */
export const KNOWLEDGE_PROPOSE_RECEIVED_MESSAGE = "Thank you. Your suggestion was sent to the team's weekly review. A person decides whether Rovara uses it.";

export const KnowledgeProposeResponseSchema = z.object({
  status: z.enum(["received", "off", "refused"]),
  reason: z.enum(KNOWLEDGE_PROPOSE_REFUSALS).optional(),
  message: z.string().max(400),
}).strict();
export type KnowledgeProposeResponse = z.infer<typeof KnowledgeProposeResponseSchema>;
export const KnowledgeProposeReaderSchema = forwardReader(KnowledgeProposeResponseSchema);
export type KnowledgeProposeRead = z.infer<typeof KnowledgeProposeReaderSchema>;

/** The progress-event field a worker carries its proposals in: `{ knowledgeProposals: [...] }`. Each proposal is checked again by the broker (it never trusts the worker's own count). */
export const KNOWLEDGE_PROPOSALS_FIELD = "knowledgeProposals";
export const KnowledgeProposalsReportSchema = z.array(KnowledgeProposalSchema).min(1).max(KNOWLEDGE_PROPOSALS_PER_TASK_MAX);

/** The proposals in a worker progress payload, or undefined for anything else (a malformed report is dropped whole, never partly used). */
export function knowledgeProposalsOfProgress(payload: unknown): KnowledgeProposal[] | undefined {
  if (payload === null || typeof payload !== "object" || !Object.hasOwn(payload, KNOWLEDGE_PROPOSALS_FIELD)) return undefined;
  const parsed = KnowledgeProposalsReportSchema.safeParse((payload as Record<string, unknown>)[KNOWLEDGE_PROPOSALS_FIELD]);
  return parsed.success ? parsed.data : undefined;
}
