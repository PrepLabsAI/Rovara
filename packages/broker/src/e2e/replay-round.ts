// The parts of `aws/workflow-e2e-replay.ts` that touch no cloud client (types, constants, the pure checks and views). `aws/workflow-e2e-replay.ts` and `core/e2e` both import them from here, so the ports
// version loads no cloud SDK.
import { E2EReplayResultSchema, type E2EApplicationReplay, type E2EReplayReason, type E2EReplayResult, type E2EReplaySourceCase } from "@agentx/contracts";
import { verifyApplicationE2EEvidence, type ApplicationEvidenceInput, type ApplicationEvidenceVerification } from "./application-evidence.js";

export const E2E_REPLAY_PURPOSE = "replay" as const;
/** How long after its deadline a started replay is waited for before it is read as one that could not be run. */
export const E2E_REPLAY_RUN_GRACE_MS = 5 * 60_000;

export type ReplayState = "REQUESTED" | "STARTED" | "RECORDED" | "UNAVAILABLE";
/** Why a replay has no result, as a code for the record and the log. */
export type ReplayUnavailableReason = "start-failed" | "run-failed" | "unverified" | "timed-out" | "stopped" | "cancel-unconfirmed";

export type ReplayRecord = Readonly<{
  taskId: string; sourceRoundId: string; attempt: number; state: ReplayState; requestedAt: string;
  /** The administrator who asked for it (their owner key), kept for the audit trail; absent on a record written before it was kept. */
  requestedBy?: string;
  operationId?: string; roundId?: string; admissionSha256?: string; startedAt?: string; deadlineAt?: string; recordedAt?: string; reason?: string; replay?: E2EReplayResult;
}>;

/** What the broker made of the evidence of a replay round: its verdict, the facts of each case, and the result to record. */
export const VERIFIED_REPLAY = Symbol("verified-replay");
export type VerifiedReplay = Readonly<{ [VERIFIED_REPLAY]: true; roundId: string; admissionSha256: string; replay: E2EReplayResult }>;

type CaseView = Readonly<{ caseId: string; assertionOutcomes: ReadonlyArray<"passed" | "failed" | "unavailable">; csvSha256: string | null; reason: string;
  steps: ReadonlyArray<Readonly<{ whole: boolean }>> }>;

/** The cases of a verification as the replay compares them: each assertion's outcome from the qualified result, the CSV hash and the steps from the collector's facts. */
function caseViewsOf(verification: ApplicationEvidenceVerification): CaseView[] {
  const facts = new Map(verification.groups.flatMap((group) => group.caseFacts ?? []).map((item) => [item.caseId, item] as const));
  return verification.results.flatMap((result) => result.cases.map((item) => ({ caseId: item.caseId, reason: item.reason,
    assertionOutcomes: item.assertionReceipts.map((receipt) => (receipt.status === "passed" || receipt.status === "failed" ? receipt.status : "unavailable" as const)), csvSha256: facts.get(item.caseId)?.csvSha256 ?? null,
    steps: (facts.get(item.caseId)?.agentSteps ?? []).map((step) => ({ whole: step.whole })) })));
}

/**
 * What a verified round showed, per case, for a replay to be judged against: the outcome of each assertion and the SHA-256 of the CSV bytes the case downloaded (null when it has none).
 * Taken from the broker's own verification of the source round; the replay admission signs it.
 */
export function replaySourceCasesOf(verification: ApplicationEvidenceVerification): E2EReplaySourceCase[] {
  return caseViewsOf(verification).map((item) => ({ caseId: item.caseId, assertionOutcomes: [...item.assertionOutcomes], csvSha256: item.csvSha256 }));
}

/**
 * The replay's result from the broker's verification of its evidence and the source round's cases it signed:
 *  - `status` is the replay's own verdict (PASS, FAILED, UNKNOWN), informational;
 *  - `reproduced` only when the replay is PASS, every AI navigation step was replayed whole, every assertion came out as in the source round and every CSV has the source's bytes;
 *  - `downloadSha256Match` is whether the CSV bytes match (it compares nothing else), true only when at least one case has a CSV and every one of them matches;
 *  - `reason` is a fixed code for why it did not reproduce (the step needed a model, a value the model chose, a model was called, an outcome or the download differs).
 */
export function replayResultOf(verification: ApplicationEvidenceVerification, sourceCases: ReadonlyArray<E2EReplaySourceCase>): E2EReplayResult {
  const views = caseViewsOf(verification);
  const status = verification.verdict;
  const csvCases = sourceCases.filter((source) => source.csvSha256 !== null);
  const downloadMatches = csvCases.length > 0 && csvCases.every((source) => views.find((item) => item.caseId === source.caseId)?.csvSha256 === source.csvSha256);
  const outcomesMatch = views.length === sourceCases.length && sourceCases.every((source) => {
    const seen = views.find((item) => item.caseId === source.caseId);
    return seen !== undefined && seen.assertionOutcomes.length === source.assertionOutcomes.length && seen.assertionOutcomes.every((outcome, index) => outcome === source.assertionOutcomes[index]);
  });
  const stepsWhole = views.every((item) => item.steps.every((step) => step.whole));
  const reproduced = status === "PASS" && outcomesMatch && stepsWhole && csvCases.every((source) => views.find((item) => item.caseId === source.caseId)?.csvSha256 === source.csvSha256);
  const caseReasons = new Set(views.map((item) => item.reason));
  const modelCalled = verification.groups.some((group) => group.reason.startsWith("replay-model-called")) || verification.reason.startsWith("replay-model-called");
  const reason: E2EReplayReason | undefined = reproduced ? undefined
    : modelCalled ? "replay-model-called"
    : caseReasons.has("typed-value-not-replayable") ? "typed-value-not-replayable"
    : caseReasons.has("replay-needs-model") ? "replay-needs-model"
    : status === "UNKNOWN" ? "replay-unverified"
    : status === "FAILED" || !outcomesMatch ? "replay-outcome-differs"
    : "replay-download-differs";
  return E2EReplayResultSchema.parse({ status, reproduced, downloadSha256Match: downloadMatches && status !== "UNKNOWN", ...(reason === undefined ? {} : { reason }) });
}

/**
 * Verifies the evidence of a replay round exactly as a candidate round's is verified (the admission the broker stored, the evidence it accepted, recollected and requalified by the
 * broker), for the purpose it was signed with, and records nothing it did not derive. Undefined when the admission itself could not be verified at all (no plan came out of it): the
 * replay is then one that could not be checked.
 */
export function verifyReplayEvidence(input: Omit<ApplicationEvidenceInput, "purpose"> & { replay: Pick<E2EApplicationReplay, "sourceCases"> }): VerifiedReplay | undefined {
  const { replay, ...evidence } = input;
  const verification = verifyApplicationE2EEvidence({ ...evidence, purpose: E2E_REPLAY_PURPOSE });
  if (verification.round === undefined) return undefined;
  return { [VERIFIED_REPLAY]: true, roundId: verification.round.roundId, admissionSha256: input.subject.admissionSha256, replay: replayResultOf(verification, replay.sourceCases) };
}
