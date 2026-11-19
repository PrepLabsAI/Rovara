// The parts of `aws/workflow-e2e-baseline.ts` that touch no cloud client (types, constants, the pure checks and views). `aws/workflow-e2e-baseline.ts` and `core/e2e` both import them from here, so the ports
// version loads no cloud SDK.
import { type E2EDisplayBaseline } from "@agentx/contracts";
import { z } from "zod";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import { AGENT_STEPS_ONLY_BASELINE, UNAVAILABLE_BASELINE, baselineOf, scrubScenarioResults, type DisplayArtifact } from "./application-display.js";
import { ApplicationBaselineSkipped, ApplicationDispatchRefusal, ApplicationPlanDefect } from "./application-dispatch-check.js";
import { verifyApplicationE2EEvidence, type ApplicationEvidenceInput } from "./application-evidence.js";

export const E2E_BASELINE_PURPOSE = "baseline" as const;
/** A plan's baseline is asked for once; the attempt is part of what the record, the admission and the operation sign, so a later retry can tell its own round from this one. */
export const E2E_BASELINE_ATTEMPT = 1;
/** How long after its deadline a started round is waited for before it is shown as one that could not be run. */
export const E2E_BASELINE_RUN_GRACE_MS = 5 * 60_000;

export type BaselineState = "REQUESTED" | "STARTED" | "RECORDED" | "UNAVAILABLE";
/** Why a baseline has no result, as a code for the record and the log; the owner reads one fixed sentence. */
/** `agent-steps-only` (Ruling DD): every scenario of the plan has an AI navigation step, which a baseline never runs, so there was nothing to run. */
export type BaselineUnavailableReason = "not-exported" | "refused" | "start-failed" | "run-failed" | "unverified" | "timed-out" | "stopped" | "cancel-unconfirmed" | "agent-steps-only";

/** Why a baseline round could not be started, from what building its admission threw: a plan that is only AI navigation scenarios is skipped (it gates nothing), a refused plan or input is `refused`, anything else `start-failed`. */
export function baselineStartFailureReason(error: unknown): BaselineUnavailableReason {
  if (error instanceof ApplicationBaselineSkipped) return error.reason;
  return error instanceof ApplicationDispatchRefusal || error instanceof ApplicationPlanDefect ? "refused" : "start-failed";
}

/** The AI-navigated scenarios a baseline round left out (Task 4.4c): ids and titles only, at most 64, kept on the record from the start of the round to its result. */
export const SkippedAiScenariosSchema = z.array(z.object({ scenarioId: z.string().min(1).max(120), title: z.string().min(1).max(120) }).strict()).max(64);
export type SkippedAiScenarios = z.infer<typeof SkippedAiScenariosSchema>;

export type BaselineRecord = Readonly<{
  taskId: string; contractDigest: string; attempt: number; state: BaselineState; requestedAt: string;
  baseCommitSha?: string; operationId?: string; roundId?: string; admissionSha256?: string; startedAt?: string; deadlineAt?: string;
  recordedAt?: string; reason?: string; baseline?: E2EDisplayBaseline; skippedAiScenarios?: SkippedAiScenarios;
}>;

/** The approved plan a baseline stands for; absent when the task has no approved application plan. */
export const baselinePlanDigestOf = (task: Pick<DeveloperTaskRecord, "workflow">): string | undefined =>
  task.workflow?.e2e?.required === true && task.workflow.e2e.applicationSelection !== undefined ? task.workflow.e2e.contractDigest : undefined;

/** Whether the project wants the baseline round: on unless its developer-task policy says `e2eBaselineRound: false`. */
export function projectE2EBaselineWanted(project: { definition: { developerTasks?: unknown } }): boolean {
  const policy = project.definition.developerTasks;
  return !(typeof policy === "object" && policy !== null && (policy as { e2eBaselineRound?: unknown }).e2eBaselineRound === false);
}

export const VERIFIED_BASELINE = Symbol("verified-baseline");
/** What the broker made of the evidence of a baseline round; only `verifyBaselineEvidence` makes one. */
export type VerifiedBaseline = Readonly<{ [VERIFIED_BASELINE]: true; roundId: string; admissionSha256: string; baseline: E2EDisplayBaseline; artifacts: readonly DisplayArtifact[] }>;

/**
 * Verifies the evidence of a baseline round exactly as a candidate round's is verified (the admission the broker stored, the evidence it accepted, recollected and requalified by the
 * broker), for the purpose it was signed with. The rows are the verification's own display and nothing a worker says about itself. Undefined when the evidence verifies to no rows
 * at all (a refused admission, evidence that could not be read): the baseline is then one that could not be checked.
 */
export function verifyBaselineEvidence(input: Omit<ApplicationEvidenceInput, "purpose"> & { skippedAiScenarios?: SkippedAiScenarios }): VerifiedBaseline | undefined {
  const { skippedAiScenarios, ...evidence } = input;
  const verification = verifyApplicationE2EEvidence({ ...evidence, purpose: E2E_BASELINE_PURPOSE });
  const display = verification.display;
  if (display === undefined || display.scenarios.length === 0 || verification.round === undefined) return undefined;
  const scrubbed = scrubScenarioResults({ scenarios: [], baseline: baselineOf(display.scenarios, skippedAiScenarios) })?.baseline;
  if (scrubbed === undefined) return undefined;
  return { [VERIFIED_BASELINE]: true, roundId: verification.round.roundId, admissionSha256: input.subject.admissionSha256, baseline: scrubbed, artifacts: display.artifacts };
}

/**
 * What the page shows of a record: the recorded rows; the sentence for a baseline that could not be run, whether it was marked so or its round never answered (past its deadline and
 * the grace); nothing while it is only asked for or still running.
 */
export function workflowE2EBaselineView(record: BaselineRecord, nowMs: number): E2EDisplayBaseline | undefined {
  if (record.state === "RECORDED") return record.baseline === undefined ? undefined : scrubScenarioResults({ scenarios: [], baseline: record.baseline })?.baseline;
  // BASEREASON (Task 4.4c): a plan that is all AI navigation says so; every other reason is the one generic sentence.
  if (record.state === "UNAVAILABLE") return record.reason === "agent-steps-only" ? AGENT_STEPS_ONLY_BASELINE : UNAVAILABLE_BASELINE;
  if (record.state === "STARTED" && record.deadlineAt !== undefined && nowMs > Date.parse(record.deadlineAt) + E2E_BASELINE_RUN_GRACE_MS) return UNAVAILABLE_BASELINE;
  return undefined;
}
