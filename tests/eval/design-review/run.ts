// Design review stage: the replay eval hook. It runs a frozen set of designs (cases.ts) through the REAL design review code at each tier and counts, per tier:
//   - planted defects CAUGHT (and missed),
//   - FALSE POSITIVES (a blocker or major that matches no planted defect; on a clean design every blocker or major is one),
//   - the quality suite's pilot metric as a PLACEHOLDER: "merged-equivalent with at most one send-back" (quality-suite.md 3.4, "Pilot metric (replay)"). It is only counted when a pipeline-outcome port is given;
//     without one the report says `measured: false` and counts nothing, so a report can never show a number nobody measured.
//
// What is real here: the reviewers for the tier (`reviewersForRound`), the packet each is given (`buildReviewerPacket` over the case's repository files), the exact messages (`reviewerMessagesOf`), the strict answer reader
// (`readDesignReview`), the citation check against that reviewer's own packet (`filterReviewerCitations`), the merge checks (`mergeDesignFindings`, with the code-only fallback), Rovara's own findings (`ownDesignFindings`) and
// the way they are combined (`withOwnFindings`). What is a port: the three models. Offline they are the fakes of fake-models.ts, which answer from a frozen script and see only the packet.
//
// HOW THE REAL EVAL PLUGS IN. The quality suite (the quality suite design) will call `runDesignReviewEval` with:
//   - `reviewer`: a function that sends `{ system, user }` (exactly what `reviewerMessagesOf` made; the worker sends the same two strings) to the arm's model and returns the model's last answer text. In production that is a read-only
//     session of packages/worker/src/design-review-sessions.ts (`createReviewSessionOpener`) on the arm's `plan_check` stage model; here nothing about tools or keys is needed because the packet already holds everything.
//   - `merge`: the same for the merge step (prompt `MERGE_PROMPT`, material = the raw findings), or omitted to measure the code-only merge.
//   - `outcomes`: after the findings of a case are known, the whole-pipeline replay (Understand, Plan, design review, send-back, Build, Review) reports whether the task was accepted, merged-equivalent, and how many send-backs it
//     took. That fills the pilot-metric placeholder with the real number; the stage score above does not depend on it.
//   - `cases`: `DESIGN_REVIEW_EVAL_CASES` as the `design-review@1` task set, or a set harvested from a customer's own merged PRs with the defects labelled by their reviewers.
// A model answer that cannot be read counts as `unreadable` for that reviewer (it contributes no findings, as in production); nothing here throws on a model's words.
import {
  DESIGN_REVIEW_TIERS, filterReviewerCitations, lightCriticWritesParaphrase, mergeDesignFindings, readDesignReview, reviewerMessagesOf,
  type DesignFinding, type DesignReviewTier, type RawDesignFinding, type ReviewerRole,
} from "../../../packages/contracts/src/index.js";
import { TIER_HAS_MERGE_MODEL, reviewersForRound } from "../../../packages/core/src/core/design-review/estimate.js";
import { ownDesignFindings, withOwnFindings } from "../../../packages/core/src/core/design-review/own-findings.js";
import { buildReviewerPacket, type PacketReaders } from "../../../packages/core/src/core/design-review/packet.js";
import { designSourcesOf, requirementIdsOf } from "../../../packages/core/src/core/design-review/round-inputs.js";
import { DESIGN_REVIEW_EVAL_CASES, type DesignReviewEvalCase, type PlantedDefect } from "./cases.js";

/** The pinned commit every case's repository is read at. */
export const EVAL_COMMIT = "c".repeat(40);

export interface ReviewerCall { caseId: string; role: ReviewerRole; tier: DesignReviewTier; round: 1 | 2; system: string; user: string }
/** Sends one reviewer's first request to a model and answers the model's last message. */
export type ReviewerModel = (call: ReviewerCall) => Promise<string>;
export interface MergeCall { caseId: string; tier: DesignReviewTier; round: 1 | 2; raw: readonly RawDesignFinding[] }
/** The merge model's answer text, or undefined when it did not answer. */
export type MergeModel = (call: MergeCall) => Promise<string | undefined>;
export interface PipelineOutcome { accepted: boolean; mergedEquivalent: boolean; sendBacks: number }
/** The whole-pipeline replay of one case at one tier, given the design review's findings. Undefined: it was not run for this case. */
export type PipelineOutcomes = (call: { caseId: string; tier: DesignReviewTier; findings: readonly DesignFinding[] }) => Promise<PipelineOutcome | undefined>;

export interface EvalOptions {
  cases?: readonly DesignReviewEvalCase[];
  tiers?: readonly DesignReviewTier[];
  round?: 1 | 2;
  reviewer: ReviewerModel;
  merge?: MergeModel;
  outcomes?: PipelineOutcomes;
}

export interface CaseResult {
  caseId: string;
  caught: string[];
  missed: string[];
  falsePositives: string[];
  findings: number;
  unreadableReviewers: ReviewerRole[];
  mergeSource: "model" | "code";
}

export interface TierReport {
  tier: DesignReviewTier;
  reviewers: readonly ReviewerRole[];
  cases: number;
  planted: number;
  caught: number;
  missed: number;
  /** Blockers and majors that match no planted defect. */
  falsePositives: number;
  /** Clean designs with at least one false positive. */
  cleanCasesWithFalsePositive: number;
  unreadableReviewers: number;
  mergeSource: { model: number; code: number };
  /** The pilot metric's placeholder. `measured` is false (and the counts 0) unless an outcome port answered for at least one case. */
  mergedWithinOneSendBack: { measured: boolean; count: number; accepted: number; of: number };
  perCase: CaseResult[];
}

export interface DesignReviewEvalReport {
  version: 1;
  set: string;
  round: 1 | 2;
  tiers: Record<DesignReviewTier, TierReport | undefined>;
}

/** Whether a finding catches a planted defect: a blocker or major, in the defect's section, whose words contain a keyword. */
export function catches(finding: Pick<DesignFinding, "severity" | "section" | "text">, defect: PlantedDefect): boolean {
  if (finding.severity === "nit" || finding.section !== defect.section) return false;
  const text = finding.text.toLowerCase();
  return defect.keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

export function scoreFindings(planted: readonly PlantedDefect[], findings: readonly DesignFinding[]): { caught: string[]; missed: string[]; falsePositives: DesignFinding[] } {
  const caught = planted.filter((defect) => findings.some((finding) => catches(finding, defect))).map((defect) => defect.id);
  const matchesAny = (finding: DesignFinding): boolean => planted.some((defect) => catches(finding, defect));
  return {
    caught, missed: planted.filter((defect) => !caught.includes(defect.id)).map((defect) => defect.id),
    falsePositives: findings.filter((finding) => finding.severity !== "nit" && !matchesAny(finding)),
  };
}

const readersOf = (evalCase: DesignReviewEvalCase): PacketReaders => ({
  readRepoFile: async ({ path }) => evalCase.files[path],
  readMetaFile: async () => undefined,
  fetchMcpItem: async () => ({ ok: false }),
});

async function runCaseAtTier(evalCase: DesignReviewEvalCase, tier: DesignReviewTier, options: EvalOptions): Promise<CaseResult & { all: DesignFinding[] }> {
  const round = options.round ?? 1;
  const roles = reviewersForRound(tier, round);
  const pins = { [evalCase.repo]: EVAL_COMMIT };
  const input = {
    tier, design: { ref: "design-v1", revision: "r1", text: evalCase.design }, requirements: { ref: "requirements-v1", revision: "r1", text: evalCase.requirements },
    baseCommits: pins, sources: designSourcesOf(evalCase.design, [evalCase.repo]),
  };
  const raw: RawDesignFinding[] = [];
  const unreadable: ReviewerRole[] = [];
  const verifiedRoles = new Set<ReviewerRole>();
  const items = new Map<ReviewerRole, ReturnType<typeof itemsOf>>();
  const itemsOf = (built: Awaited<ReturnType<typeof buildReviewerPacket>>) => built.items.map((item) => ({ kind: item.kind, ref: item.ref, commitOrFetchedAt: item.commitOrFetchedAt, digest: item.digest }));
  for (const role of roles) {
    const built = await buildReviewerPacket({ ...input, role }, readersOf(evalCase));
    items.set(role, itemsOf(built));
    const { system, user } = reviewerMessagesOf(built);
    const answer = await options.reviewer({ caseId: evalCase.id, role, tier, round, system, user });
    const read = readDesignReview(answer, role, { withParaphrase: lightCriticWritesParaphrase(role, built.rolePrompt.id) });
    if (!read.ok) { unreadable.push(role); continue; }
    verifiedRoles.add(role);
    raw.push(...read.findings);
  }
  const cited = filterReviewerCitations(raw, items, pins);
  const mergeAnswer = TIER_HAS_MERGE_MODEL[tier] ? await options.merge?.({ caseId: evalCase.id, tier, round, raw: cited.findings }) : undefined;
  const merged = mergeDesignFindings(cited.findings, mergeAnswer, { verifiedRoles });
  const own = ownDesignFindings({ design: evalCase.design, requirementIds: requirementIdsOf(evalCase.requirements) });
  const all = withOwnFindings(merged.findings, own).findings;
  const scored = scoreFindings(evalCase.planted, all);
  return {
    caseId: evalCase.id, caught: scored.caught, missed: scored.missed, falsePositives: scored.falsePositives.map((finding) => finding.id), findings: all.length, unreadableReviewers: unreadable, mergeSource: merged.source, all,
  };
}

/** Runs every case at every tier asked for and counts. Deterministic when the models are. */
export async function runDesignReviewEval(options: EvalOptions): Promise<DesignReviewEvalReport> {
  const cases = options.cases ?? DESIGN_REVIEW_EVAL_CASES;
  const round = options.round ?? 1;
  const tiers: DesignReviewEvalReport["tiers"] = { light: undefined, standard: undefined, thorough: undefined };
  for (const tier of options.tiers ?? DESIGN_REVIEW_TIERS) {
    const perCase: CaseResult[] = [];
    const pilot = { measured: false, count: 0, accepted: 0, of: 0 };
    for (const evalCase of cases) {
      const { all, ...result } = await runCaseAtTier(evalCase, tier, options);
      perCase.push(result);
      const outcome = await options.outcomes?.({ caseId: evalCase.id, tier, findings: all });
      if (outcome !== undefined) {
        pilot.measured = true;
        pilot.of += 1;
        if (outcome.accepted) {
          pilot.accepted += 1;
          if (outcome.mergedEquivalent && outcome.sendBacks <= 1) pilot.count += 1;
        }
      }
    }
    tiers[tier] = {
      tier, reviewers: reviewersForRound(tier, round), cases: cases.length,
      planted: cases.reduce((sum, evalCase) => sum + evalCase.planted.length, 0),
      caught: perCase.reduce((sum, result) => sum + result.caught.length, 0), missed: perCase.reduce((sum, result) => sum + result.missed.length, 0),
      falsePositives: perCase.reduce((sum, result) => sum + result.falsePositives.length, 0),
      cleanCasesWithFalsePositive: cases.filter((evalCase, index) => evalCase.planted.length === 0 && perCase[index]!.falsePositives.length > 0).length,
      unreadableReviewers: perCase.reduce((sum, result) => sum + result.unreadableReviewers.length, 0),
      mergeSource: { model: perCase.filter((result) => result.mergeSource === "model").length, code: perCase.filter((result) => result.mergeSource === "code").length },
      mergedWithinOneSendBack: pilot, perCase,
    };
  }
  return { version: 1, set: "design-review@1", round, tiers };
}

/** One line per tier for a Slack summary or a log: "Standard: caught 5/7, false positives 1, merged with at most one send-back: not measured". */
export function summaryLines(report: DesignReviewEvalReport): string[] {
  return DESIGN_REVIEW_TIERS.flatMap((tier) => {
    const entry = report.tiers[tier];
    if (entry === undefined) return [];
    const pilot = entry.mergedWithinOneSendBack;
    return [`${tier}: caught ${String(entry.caught)}/${String(entry.planted)}, false positives ${String(entry.falsePositives)}, merged with at most one send-back: ${pilot.measured ? `${String(pilot.count)}/${String(pilot.accepted)} accepted` : "not measured"}`];
  });
}
