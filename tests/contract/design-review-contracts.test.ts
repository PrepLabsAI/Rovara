// Design review stage: the stored shapes. Strict everywhere; old intents, playbooks and stage lists still parse.
import { describe, expect, it } from "vitest";
import {
  DESIGN_REVIEW_DEFAULT_SETTING, DESIGN_REVIEW_HIGH_RISK_REASONS, LIGHT_CRITIC_PROMPT_ID, DESIGN_REVIEW_ROUNDS_MAX, DesignFindingSchema, FILES_READ_LABEL, INPUT_PROOFS, INPUT_PROOF_SENTENCES, inputProofSentence, DesignQuestionSchema, DesignReviewSettingSchema, IntentAssessmentSchema,
  ProjectPlaybookBodySchema, ProjectPlaybookSchema, ReviewerRunSchema, STAGE_IDS, WorkflowDesignReviewSchema, designReviewSettingOf, isHighRiskDesign,
} from "../../packages/contracts/src/index.js";

const sha = "a".repeat(40);
const digest = "b".repeat(64);
const run = {
  role: "critic", promptId: "design-critic", promptVersion: 1, promptDigest: digest, model: { provider: "anthropic", modelId: "claude-opus-5-5" }, sourceId: "src_1",
  sessionId: "ses_1", modelKeyId: "key_1", packetDigest: digest,
  packet: [{ kind: "design", ref: "design.md", commitOrFetchedAt: sha, digest, bytes: 1200 }],
  filesRead: ["packages/a.ts"], verified: true, inputProof: "proxy_first_call", tokensIn: 1000, tokensOut: 200, costUsd: 0.01, startedAt: "2026-11-03T10:00:00Z", endedAt: "2026-11-03T10:01:00Z",
};
const finding = { id: "f1", severity: "major", section: "§3", text: "Retries are not bounded.", citations: [{ kind: "design", section: "§3" }], fromReviewers: ["critic"], rawIds: ["critic-1"], fingerprint: digest };

describe("design review contracts", () => {
  it("keeps the stage list unchanged: reviewers resolve through plan_check, so existing model-choice approval digests stay valid", () => {
    expect(STAGE_IDS).toEqual(["understand", "plan", "plan_check", "build", "code_review", "security_review", "pull_request"]);
  });

  it("reads a ready intent with and without the design field", () => {
    const base = { kind: "ready", path: "FULL", restatement: "Add webhooks.", assumptions: [] };
    expect(IntentAssessmentSchema.parse(base)).toEqual(base);
    const withDesign = { ...base, design: { needed: true, reasons: ["new_api", "data_model"], note: "Adds a public API and a table." } };
    expect(IntentAssessmentSchema.parse(withDesign)).toEqual(withDesign);
  });

  it("refuses unknown design reasons, more than 4 reasons, a long note and extra keys", () => {
    const base = { kind: "ready", path: "FULL", restatement: "x", assumptions: [] };
    expect(IntentAssessmentSchema.safeParse({ ...base, design: { needed: true, reasons: ["vibes"], note: "n" } }).success).toBe(false);
    expect(IntentAssessmentSchema.safeParse({ ...base, design: { needed: true, reasons: ["auth", "money", "pii", "new_api", "data_model"], note: "n" } }).success).toBe(false);
    expect(IntentAssessmentSchema.safeParse({ ...base, design: { needed: true, reasons: [], note: "x".repeat(201) } }).success).toBe(false);
    expect(IntentAssessmentSchema.safeParse({ ...base, design: { needed: true, reasons: [], note: "n", approve: true } }).success).toBe(false);
  });

  it("refuses control characters in the note: it is shown to people", () => {
    const base = { kind: "ready", path: "FULL", restatement: "x", assumptions: [] };
    expect(IntentAssessmentSchema.safeParse({ ...base, design: { needed: false, reasons: ["bug_fix"], note: "ok‮evil" } }).success).toBe(false);
  });

  it("gives a playbook with no setting the owner's defaults (auto, standard, skip allowed, $15, maintainers)", () => {
    expect(DESIGN_REVIEW_DEFAULT_SETTING).toEqual({ mode: "auto", tier: "standard", allowSkip: true, capUsdPerTask: 15, highRiskApprover: { kind: "maintainers" } });
    const old = { revision: 3, defaultProcess: { kind: "builtin" } };
    expect(ProjectPlaybookSchema.parse(old)).toEqual(old);
    expect(designReviewSettingOf(ProjectPlaybookSchema.parse(old))).toEqual(DESIGN_REVIEW_DEFAULT_SETTING);
  });

  it("stores and puts a playbook with a design review setting", () => {
    const setting = { mode: "always", tier: "thorough", allowSkip: false, capUsdPerTask: 25, highRiskApprover: { kind: "people", memberIds: ["dev_1"] } };
    expect(designReviewSettingOf(ProjectPlaybookSchema.parse({ revision: 1, defaultProcess: { kind: "builtin" }, designReview: setting }))).toEqual(setting);
    expect(ProjectPlaybookBodySchema.parse({ expectedRevision: 1, defaultProcess: { kind: "builtin" }, designReview: setting }).designReview).toEqual(setting);
  });

  it("bounds the cap and the approver list", () => {
    const ok = DESIGN_REVIEW_DEFAULT_SETTING;
    expect(DesignReviewSettingSchema.safeParse({ ...ok, capUsdPerTask: 0.49 }).success).toBe(false);
    expect(DesignReviewSettingSchema.safeParse({ ...ok, capUsdPerTask: 100.01 }).success).toBe(false);
    expect(DesignReviewSettingSchema.safeParse({ ...ok, highRiskApprover: { kind: "people", memberIds: [] } }).success).toBe(false);
    expect(DesignReviewSettingSchema.safeParse({ ...ok, highRiskApprover: { kind: "people", memberIds: Array.from({ length: 11 }, (_, i) => `dev_${i}`) } }).success).toBe(false);
    expect(DesignReviewSettingSchema.safeParse({ ...ok, mode: "sometimes" }).success).toBe(false);
  });

  it("names the high-risk reasons once, and only those make a design high risk", () => {
    expect([...DESIGN_REVIEW_HIGH_RISK_REASONS].sort()).toEqual(["auth", "cross_repo_or_service", "data_model", "infrastructure", "money", "pii"]);
    expect(isHighRiskDesign(["new_api", "small_change"])).toBe(false);
    expect(isHighRiskDesign(["new_api", "pii"])).toBe(true);
  });

  it("requires at least one citation on a finding and refuses an unknown severity or section", () => {
    expect(DesignFindingSchema.parse(finding)).toEqual(finding);
    expect(DesignFindingSchema.safeParse({ ...finding, citations: [] }).success).toBe(false);
    expect(DesignFindingSchema.safeParse({ ...finding, severity: "critical" }).success).toBe(false);
    expect(DesignFindingSchema.safeParse({ ...finding, section: "§9" }).success).toBe(false);
    const code = { kind: "code", repo: "acme/web", path: "src/a.ts", startLine: 3, endLine: 4, anchor: "export function a()", commit: sha };
    expect(DesignFindingSchema.parse({ ...finding, citations: [code, { kind: "source", ref: "mcp:wiki/page-1", digest }] }).citations).toHaveLength(2);
  });

  it("carries a finding Rovara adds itself, naming no reviewer, and refuses a reviewer finding with none", () => {
    const own = { ...finding, origin: "rovara", fromReviewers: [], rawIds: [] };
    expect(DesignFindingSchema.parse(own)).toEqual(own);
    expect(DesignFindingSchema.safeParse({ ...own, fromReviewers: ["critic"] }).success).toBe(false);
    expect(DesignFindingSchema.safeParse({ ...finding, fromReviewers: [] }).success).toBe(false);
    expect(DesignFindingSchema.safeParse({ ...finding, rawIds: [] }).success).toBe(false);
  });

  it("records a reviewer run, and keeps the paraphrase for the comprehension reviewer only", () => {
    expect(ReviewerRunSchema.parse(run)).toEqual(run);
    expect(ReviewerRunSchema.safeParse({ ...run, paraphrase: "It adds webhooks." }).success).toBe(false);
    expect(ReviewerRunSchema.parse({ ...run, role: "comprehension", paraphrase: "It adds webhooks." }).paraphrase).toBe("It adds webhooks.");
    // minor 7: the Light tier's Critic is the one critic whose registered prompt asks for the paraphrase
    expect(ReviewerRunSchema.parse({ ...run, promptId: LIGHT_CRITIC_PROMPT_ID, paraphrase: "It adds webhooks." }).paraphrase).toBe("It adds webhooks.");
    expect(ReviewerRunSchema.safeParse({ ...run, role: "codebase", promptId: LIGHT_CRITIC_PROMPT_ID, paraphrase: "It adds webhooks." }).success).toBe(false);
    expect(ReviewerRunSchema.safeParse({ ...run, verified: false }).success).toBe(false);
    expect(ReviewerRunSchema.parse({ ...run, verified: false, verifyFailure: "packet_digest_mismatch", inputProof: undefined }).verified).toBe(false);
  });

  // Fix round B1: a "digest only" verification must be recordable, and must never read as proxy-confirmed.
  it("a verified run must say what proved its input; an unverified run must not", () => {
    expect(ReviewerRunSchema.safeParse({ ...run, inputProof: undefined }).success).toBe(false);
    expect(ReviewerRunSchema.safeParse({ ...run, inputProof: "digest_and_usage" }).success).toBe(false);
    expect(ReviewerRunSchema.parse({ ...run, inputProof: "digest_only" }).inputProof).toBe("digest_only");
    expect(ReviewerRunSchema.safeParse({ ...run, verified: false, verifyFailure: "timeout" }).success).toBe(false);
  });

  it("the fixed card sentences: digest_only never says the proxy confirmed anything", () => {
    expect(inputProofSentence("digest_only")).toBe("verified by the digest of the packet the worker fetched; what the model was sent and the proxy's first-call size were not checked");
    expect(inputProofSentence("proxy_first_call")).toBe("verified by the digest of the packet the worker fetched and the proxy's first call");
    // N2: the digest is the digest of the packet the worker FETCHED. Nothing that reads as "proved it sent exactly this" may appear unless the proxy checked the first call.
    expect(inputProofSentence("digest_only")).toContain("fetched");
    expect(inputProofSentence("digest_only")).toContain("not checked");
    expect(inputProofSentence("digest_only")).not.toMatch(/sent exactly|was sent the|proved|confirmed/iu);
    expect(inputProofSentence("digest_only")).not.toMatch(/confirm/iu);
    expect(inputProofSentence("digest_only")).not.toContain("and the proxy's first call");
    expect(Object.keys(INPUT_PROOF_SENTENCES).sort()).toEqual([...INPUT_PROOFS].sort());
  });

  it("filesRead holds plain text only (bidi and control characters are refused); the card labels it as the worker's word", () => {
    expect(ReviewerRunSchema.safeParse({ ...run, filesRead: ["\u202eevil"] }).success).toBe(false);
    expect(ReviewerRunSchema.safeParse({ ...run, filesRead: ["a\u0000b"] }).success).toBe(false);
    expect(FILES_READ_LABEL).toBe("reported by the worker");
  });

  it("bounds rounds to 2 and keeps a design question to 2-4 options with a recommended one", () => {
    expect(DESIGN_REVIEW_ROUNDS_MAX).toBe(2);
    const round = (n: number) => ({ round: n, designDigest: digest, reviewers: [run], findings: [finding], resolutions: [] });
    const review = { decidedBy: "auto", reasons: ["new_api"], status: "running", tier: "standard", spentUsd: 0.4, rounds: [round(1), round(2)] };
    expect(WorkflowDesignReviewSchema.parse(review).rounds).toHaveLength(2);
    expect(WorkflowDesignReviewSchema.safeParse({ ...review, rounds: [round(1), round(2), round(2)] }).success).toBe(false);
    expect(WorkflowDesignReviewSchema.safeParse({ ...review, rounds: [round(3)] }).success).toBe(false);
    const question = { id: "q1", unclear: "Which queue?", evidence: [], options: [{ id: "a", label: "SQS", consequence: "Managed." }, { id: "b", label: "Own table", consequence: "More code." }], recommended: "a", why: "Fewer parts." };
    expect(DesignQuestionSchema.parse(question)).toEqual(question);
    expect(DesignQuestionSchema.safeParse({ ...question, recommended: "c" }).success).toBe(false);
    expect(DesignQuestionSchema.safeParse({ ...question, options: [question.options[0]] }).success).toBe(false);
  });

  it("a round may carry the estimate it was started on; a round recorded before the field still reads, and a bad estimate is refused", () => {
    const round = { round: 1, designDigest: digest, reviewers: [run], findings: [finding], resolutions: [] };
    const review = { decidedBy: "auto", reasons: ["new_api"], status: "done", tier: "standard", spentUsd: 0.444, rounds: [round] };
    expect(WorkflowDesignReviewSchema.parse(review).rounds[0]).not.toHaveProperty("estimateUsd");
    expect(WorkflowDesignReviewSchema.parse({ ...review, rounds: [{ ...round, estimateUsd: 0.95 }] }).rounds[0]!.estimateUsd).toBe(0.95);
    expect(WorkflowDesignReviewSchema.safeParse({ ...review, rounds: [{ ...round, estimateUsd: -1 }] }).success).toBe(false);
    expect(WorkflowDesignReviewSchema.safeParse({ ...review, rounds: [{ ...round, estimateUsd: "0.95" }] }).success).toBe(false);
    expect(WorkflowDesignReviewSchema.safeParse({ ...review, rounds: [{ ...round, estimate: 1 }] }).success).toBe(false);
  });
});
