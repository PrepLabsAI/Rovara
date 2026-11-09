// Decision cards (design proof-test-env, section 3.7): one card holds one decision, with its evidence on the front. A card is a PROJECTION of a pending item that exists today (a workflow
// gate, an approval, a spend request, a question, an autofix ask), not a new state machine: each action carries the existing endpoint's href and method, and a client follows it and never
// builds a request from a button's words. Browser-safe: nothing here imports a Node module.
//
// What the schema itself guarantees (so no projector or client can build a card that breaks the rules):
//   - the risk tier is one of three words and decides the friction: low is one tap, medium keeps Approve disabled until the evidence was opened, high has NO approve action on the card at all
//     ("Open" goes to the card on its task page, decided there with a recent sign-in, or to a confirmation page);
//   - nothing can be bulk-approved: there is no bulk field, no bulk body and every shape is strict;
//   - a high-risk card is never answered by a standing rule;
//   - a company lock raises a tier and never lowers it (`raiseRisk`).
import { z } from "zod";
import { forwardReader } from "./forward-reader.js";
import { EvidenceHrefSchema } from "./evidence.js";

const NO_HIDDEN = /^[^\p{Cc}\p{Cf}]*$/u;
function line(max: number, min = 1) {
  return z.string().min(min).max(max).regex(NO_HIDDEN, "one plain line");
}

/** The decisions a card can hold (the touchpoint table, 3.7). One kind per decision; a Full-path requirements and design pair is still two cards (or one card with two tabs that records two approvals). */
export const DECISION_KINDS = [
  "approve_plan",
  "approve_requirements",
  "approve_design",
  "merge",
  "answer_question",
  "choose_checks",
  "approve_dependency",
  "approve_e2e_plan",
  "review_feedback",
  "autofix_ask",
  "approve_setting",
  "approve_spend",
  "approve_test_env",
  "confirm_env_change",
  "spec_choice",
  /** Setup and test health (SH17): the test environment, not the code, kept a task's checks from giving a verdict. One card per project per cause; later tasks join it. Exists only while `vx` is on. */
  "fix_setup",
  // A website the setup run needs (SH12): one card per host per project. Approving goes through the project's own website change, which has its own second-person rule and, on Cloud, the staff step.
  "setup_host",
  // Second review (lane cr-settings, `cr`): the model that gives the second opinion stopped qualifying. An information card for the company's owners and admins; it opens the settings page, where "I've seen it" puts it away.
  "second_review_notice",
  // Test services (TS24, design test-services.md 7.4): a recorded or written fake (a fixture set) for a dependency, pinned by digest. Medium; high when the fake answers unrecorded requests from the schema or was
  // recorded from a customer test account for the first time. The card shows counts, the schema, three redacted sample pairs, the personal-data scan, the ignored paths and the faults.
  "approve_fixture_set",
  // Decision journey slice 3b: an outside approval (an agent's approval `apr_`, a spend request `spr_`) decided on its card by the people the confirmation page let decide it, with the same checks (a recent
  // sign-in, always: high).
  "approve_request",
] as const;
export const DecisionKindSchema = z.enum(DECISION_KINDS);
export type DecisionKind = z.infer<typeof DecisionKindSchema>;

export const DECISION_RISKS = ["low", "medium", "high"] as const;
export const DecisionRiskSchema = z.enum(DECISION_RISKS);
export type DecisionRisk = z.infer<typeof DecisionRiskSchema>;

const RISK_ORDER: Record<DecisionRisk, number> = { low: 0, medium: 1, high: 2 };
/** The higher of two tiers. A company lock or a later finding can only raise a card's tier: this is the only way two tiers are combined. */
export function raiseRisk(...tiers: readonly DecisionRisk[]): DecisionRisk {
  return tiers.reduce<DecisionRisk>((highest, tier) => (RISK_ORDER[tier] > RISK_ORDER[highest] ? tier : highest), "low");
}

/** The tier a kind starts at, before the projector reads the item (paths, size, money, IaC, security findings, environment changes), which can only raise it. */
export const DECISION_KIND_FLOOR_RISK: Record<DecisionKind, DecisionRisk> = {
  approve_plan: "low",
  approve_requirements: "low",
  approve_design: "low",
  merge: "low",
  answer_question: "low",
  choose_checks: "low",
  approve_dependency: "medium",
  approve_e2e_plan: "medium",
  review_feedback: "low",
  autofix_ask: "medium",
  approve_setting: "high",
  approve_spend: "low",
  approve_test_env: "medium",
  confirm_env_change: "medium",
  spec_choice: "low",
  fix_setup: "medium",
  setup_host: "medium",
  second_review_notice: "low",
  approve_fixture_set: "medium",
  approve_request: "high",
};

export const DecisionFrictionSchema = z.object({ expandEvidenceFirst: z.boolean(), freshSignIn: z.boolean(), secondPerson: z.boolean() }).strict();
export type DecisionFriction = z.infer<typeof DecisionFrictionSchema>;

/** The friction a tier carries. `secondPerson` is an extra a high card may add (a less-safe setting, a spend over the admin threshold); it is never set below high. */
export function decisionFriction(risk: DecisionRisk, secondPerson = false): DecisionFriction {
  if (risk === "low") return { expandEvidenceFirst: false, freshSignIn: false, secondPerson: false };
  if (risk === "medium") return { expandEvidenceFirst: true, freshSignIn: false, secondPerson: false };
  return { expandEvidenceFirst: true, freshSignIn: true, secondPerson };
}

/**
 * What an action does. `approve` is the only one that decides in favour; there is none on a high card. `request_changes` (decision journey slice 2) sends the document back with the person's reason, through
 * the same workflow decision Slack and the task page use; it never approves.
 */
export const DECISION_ACTION_KINDS = ["approve", "reject", "open", "answer", "choose", "request_changes"] as const;
export const DecisionActionKindSchema = z.enum(DECISION_ACTION_KINDS);
export type DecisionActionKind = z.infer<typeof DecisionActionKindSchema>;

/**
 * An action goes to an existing endpoint or page of THIS server: a path under `/app/` or `/v1/app/`, with only URL-safe characters (so no backslash, which a browser reads as a slash, no space, no colon and no
 * `@`), no empty or `..` segment (no `//`), and an optional plain query. An absolute address (any scheme or host) and a protocol-relative one are refused.
 */
const ActionHrefSchema = z
  .string()
  .max(2048)
  .regex(/^\/(?:v1\/)?app\/[A-Za-z0-9/_.~-]+(?:\?[A-Za-z0-9=&_.~%-]*)?$/u, "a path of this server")
  .refine((href) => !href.split("?")[0]!.split("/").slice(1).some((segment) => segment === "" || segment === "." || segment === ".."), "no empty or dot segments");

export const CardActionSchema = z
  .object({ kind: DecisionActionKindSchema, label: line(60), href: ActionHrefSchema, method: z.enum(["GET", "POST"]) })
  .strict()
  // Only opening a page may be a GET: approving, rejecting, answering and choosing change state, so they are POSTs and never a link a crawler, a prefetch or an image tag can follow.
  .refine((action) => action.kind === "open" || action.method === "POST", { message: "only an open action may be a GET", path: ["method"] });
export type CardAction = z.infer<typeof CardActionSchema>;

/** Why a person rejects, in one tap. */
export const DECISION_REJECT_REASONS = ["wrong_problem", "wrong_approach", "too_big", "missing_test", "not_now", "other"] as const;
export const DecisionRejectReasonSchema = z.enum(DECISION_REJECT_REASONS);
export type DecisionRejectReason = z.infer<typeof DecisionRejectReasonSchema>;

export const DECISION_EVIDENCE_CHIP_KINDS = ["test_proof", "review", "risk", "track_record", "thumbnail", "checks", "cost", "environment", "other"] as const;
export const EvidenceChipSchema = z
  .object({
    kind: z.enum(DECISION_EVIDENCE_CHIP_KINDS),
    label: line(60),
    value: line(80),
    state: z.enum(["good", "warning", "bad", "unknown"]),
    /** A `thumbnail` chip names the route that serves its image (a screenshot behind sign-in); no other chip has one. */
    href: EvidenceHrefSchema.optional(),
  })
  .strict()
  .refine((chip) => (chip.kind === "thumbnail") === (chip.href !== undefined), { message: "only a thumbnail has an href", path: ["href"] });
export type EvidenceChip = z.infer<typeof EvidenceChipSchema>;

export const DECISION_CARD_STATUSES = ["pending", "approved", "rejected", "answered_by_rule", "expired", "cancelled"] as const;
export const DECISION_CARD_ID_PATTERN = new RegExp(`^(?:${DECISION_KINDS.join("|")}):[A-Za-z0-9_-]{1,150}$`, "u");
export const DecisionCardIdSchema = z.string().regex(DECISION_CARD_ID_PATTERN);

export const DecisionCardSchema = z
  .object({
    /** `<kind>:<subjectId>`. */
    id: DecisionCardIdSchema,
    kind: DecisionKindSchema,
    taskId: z.string().uuid().optional(),
    /** The project's name. */
    project: line(100),
    title: line(80),
    question: line(160),
    /** The recommended answer comes first: which action, and why in fixed words (never a model's or a repository's). */
    recommended: z.object({ action: DecisionActionKindSchema, why: line(120) }).strict(),
    /** What happens next, in plain words: "builds in about 25 minutes, about $2.10, opens a pull request". */
    next: z.object({ text: line(160), costUsd: z.number().min(0).max(1_000_000).optional(), minutes: z.number().int().min(0).max(100_000).optional() }).strict(),
    evidence: z.array(EvidenceChipSchema).max(6),
    /** Deterministic only: no model output sets a tier. */
    risk: DecisionRiskSchema,
    riskReasons: z.array(line(100)).max(5),
    friction: DecisionFrictionSchema,
    actions: z.array(CardActionSchema).max(4),
    /**
     * A coding plan's card (slice 2): approving it sets the task's run limit. `currentUsd` is the limit now (absent: none yet), `proposedUsd` the one approving sets. When it raises the limit, the card asks for a
     * tick and the approve carries `acknowledgedRunLimitUsd` (the server refuses a raise without it, whoever asks).
     */
    runLimit: z.object({ currentUsd: z.number().min(0).max(100_000).optional(), proposedUsd: z.number().min(0).max(100_000) }).strict().optional(),
    rejectReasons: z.array(DecisionRejectReasonSchema).max(6),
    /** Set exactly when a standing rule answered the card (recorded in history; never for a high card). */
    answeredByRule: z.object({ ruleId: line(64), at: z.string().datetime() }).strict().optional(),
    status: z.enum(DECISION_CARD_STATUSES),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict()
  .superRefine((card, context) => {
    const problem = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", path, message });
    if (!card.id.startsWith(`${card.kind}:`)) problem(["id"], "the id starts with the card's kind");
    const wanted = decisionFriction(card.risk, card.friction.secondPerson);
    if (card.friction.expandEvidenceFirst !== wanted.expandEvidenceFirst || card.friction.freshSignIn !== wanted.freshSignIn || (card.friction.secondPerson && card.risk !== "high")) {
      problem(["friction"], "the friction is the one the risk tier carries");
    }
    if (RISK_ORDER[card.risk] < RISK_ORDER[DECISION_KIND_FLOOR_RISK[card.kind]]) problem(["risk"], "a card is at least as risky as its kind's floor");
    if (card.risk === "high" && card.actions.some((action) => action.kind === "approve")) problem(["actions"], "a high-risk card has no approve action: it opens the full page");
    if (card.actions.filter((action) => action.kind === "approve").length > 1) problem(["actions"], "a card has at most one approve action");
    if (card.status === "pending" && !card.actions.some((action) => action.kind === card.recommended.action)) problem(["recommended", "action"], "the recommended action is one of the card's actions");
    if (card.risk === "high" && card.answeredByRule !== undefined) problem(["answeredByRule"], "a high-risk card is never answered by a rule");
    if ((card.status === "answered_by_rule") !== (card.answeredByRule !== undefined)) problem(["answeredByRule"], "answeredByRule is there exactly when a rule answered the card");
    if (card.status !== "pending" && card.actions.length > 0) problem(["actions"], "an answered card has no actions");
    if (card.runLimit !== undefined && card.kind !== "approve_plan") problem(["runLimit"], "only a coding plan's card carries a run limit");
    if (card.actions.some((action) => action.kind === "reject") && card.rejectReasons.length === 0) problem(["rejectReasons"], "a card that can be rejected lists its reject reasons");
    if (new Set(card.rejectReasons).size !== card.rejectReasons.length) problem(["rejectReasons"], "reject reasons are unique");
  });
export type DecisionCard = z.infer<typeof DecisionCardSchema>;
export const DecisionCardReaderSchema = forwardReader(DecisionCardSchema);

/** The most cards one read returns; `total` is how many the person has now. */
export const DECISION_CARDS_MAX = 50;
export const DecisionCardsResponseSchema = z.object({ cards: z.array(DecisionCardSchema).max(DECISION_CARDS_MAX), total: z.number().int().min(0) }).strict();
export type DecisionCardsResponse = z.infer<typeof DecisionCardsResponseSchema>;
export const DecisionCardsResponseReaderSchema = forwardReader(DecisionCardsResponseSchema);

/**
 * Bodies of the card routes (the broker's `decisions/routes.ts` mounts them). Server-side friction: an approve of a medium card without a recorded evidence-opened event is refused (409),
 * and a high-risk card has no approve route. There is no bulk body.
 */
export const DecisionEvidenceOpenedBodySchema = z.object({ requestId: z.string().uuid() }).strict();
export type DecisionEvidenceOpenedBody = z.infer<typeof DecisionEvidenceOpenedBodySchema>;
export const DecisionRejectBodySchema = z.object({ requestId: z.string().uuid(), reason: DecisionRejectReasonSchema }).strict();
export type DecisionRejectBody = z.infer<typeof DecisionRejectBodySchema>;
