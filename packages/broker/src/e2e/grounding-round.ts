// The parts of `aws/workflow-e2e-grounding.ts` that touch no cloud client (types, constants, the pure checks and views). `aws/workflow-e2e-grounding.ts` and `core/e2e` both import them from here, so the ports
// version loads no cloud SDK.
import { WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX, WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX, type E2EDisplayBaseline, type PlanQualityFinding } from "@agentx/contracts";
import { groundingFindingsOf } from "../developer/plan-grounding-findings.js";
import { baselineOf, scrubScenarioResults, type DisplayArtifact } from "./application-display.js";
import { ApplicationBaselineSkipped, ApplicationDispatchRefusal } from "./application-dispatch-check.js";
import { verifyApplicationE2EEvidence, type ApplicationEvidenceInput } from "./application-evidence.js";

export const E2E_GROUNDING_PURPOSE = "grounding" as const;
/** The first grounding round of a plan version; the second (of the corrected plan) is a different artifact and so a different record, but the attempt is signed too. */
export const E2E_GROUNDING_ATTEMPT = 1;
/** How long after its deadline a started grounding round is waited for before it is read as one that could not be run. */
export const E2E_GROUNDING_RUN_GRACE_MS = 5 * 60_000;

export type GroundingState = "REQUESTED" | "STARTED" | "RECORDED" | "UNAVAILABLE";
/**
 * Why a grounding round has no result, as a fixed code. These are the only reasons that are ever stored or shown; free text from a worker, git or an error never is.
 * `worker-too-old` / `not-exported` / `runtime-not-ready` / `accounts-not-ready` / `refused` / `start-failed` / `run-failed` / `unverified` / `timed-out` / `ai-only` / `disabled` are the
 * design's codes; `stopped` is a round someone stopped.
 */
export const GROUNDING_UNAVAILABLE_REASONS = ["worker-too-old", "not-exported", "runtime-not-ready", "accounts-not-ready", "refused", "start-failed", "run-failed", "unverified", "timed-out", "ai-only", "disabled", "stopped"] as const;
export type GroundingUnavailableReason = (typeof GROUNDING_UNAVAILABLE_REASONS)[number];

/** The reason a grounding round could not be started, from what building its admission threw. Only a fixed code comes out; the error's text is never kept. */
export function groundingStartFailureReason(error: unknown): GroundingUnavailableReason {
  if (error instanceof ApplicationBaselineSkipped) return "ai-only";
  if (error instanceof ApplicationDispatchRefusal) {
    // The scope of a refusal is its fixed prefix (the rest of the message is never kept).
    return error.message.startsWith(WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX) ? "runtime-not-ready" : error.message.startsWith(WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX) ? "accounts-not-ready" : "refused";
  }
  return "start-failed";
}

/** What a grounding record is keyed by: the task, the proposed plan artifact (by digest) and the attempt. */
export type GroundingRef = Readonly<{ taskId: string; planArtifactSha256: string; attempt: number }>;

export type GroundingRecord = Readonly<{
  taskId: string; planArtifactSha256: string; planArtifactId: string; attempt: number; state: GroundingState; requestedAt: string; scenarioIds: string[];
  baseCommitSha?: string; operationId?: string; roundId?: string; admissionSha256?: string; startedAt?: string; deadlineAt?: string; selectionDigest?: string;
  recordedAt?: string; reason?: GroundingUnavailableReason; results?: E2EDisplayBaseline; findings?: PlanQualityFinding[];
}>;

export const VERIFIED_GROUNDING = Symbol("verified-grounding");
/** What the broker made of the evidence of a grounding round; only `verifyGroundingEvidence` makes one. */
export type VerifiedGrounding = Readonly<{ [VERIFIED_GROUNDING]: true; roundId: string; admissionSha256: string; results: E2EDisplayBaseline; findings: PlanQualityFinding[]; artifacts: readonly DisplayArtifact[] }>;

/**
 * Verifies the evidence of a grounding round exactly as a candidate round's is verified (the admission the broker stored, the evidence it accepted, recollected and requalified by the
 * broker), for the purpose it was signed with: the plan digest and base commit the caller recomputed from the record. The rows are the verification's own display and nothing a worker
 * says about itself. Undefined when the evidence verifies to no rows at all.
 */
export function verifyGroundingEvidence(input: Omit<ApplicationEvidenceInput, "purpose" | "grounding"> & { grounding: NonNullable<ApplicationEvidenceInput["grounding"]> }): VerifiedGrounding | undefined {
  const verification = verifyApplicationE2EEvidence({ ...input, purpose: E2E_GROUNDING_PURPOSE });
  const display = verification.display;
  if (display === undefined || display.scenarios.length === 0 || verification.round === undefined) return undefined;
  const scrubbed = scrubScenarioResults({ scenarios: [], baseline: baselineOf(display.scenarios) })?.baseline;
  if (scrubbed === undefined) return undefined;
  return { [VERIFIED_GROUNDING]: true, roundId: verification.round.roundId, admissionSha256: input.subject.admissionSha256, results: scrubbed, findings: groundingFindingsOf(scrubbed).findings, artifacts: display.artifacts };
}

/** Whether a started round has run out of time (its deadline plus the grace); a started record whose deadline cannot be read is late (it fails open). */
export function groundingRoundLapsed(record: GroundingRecord, nowMs: number): boolean {
  if (record.state !== "STARTED") return false;
  const limit = Date.parse(record.deadlineAt ?? "") + E2E_GROUNDING_RUN_GRACE_MS;
  return !Number.isFinite(limit) || nowMs > limit;
}

