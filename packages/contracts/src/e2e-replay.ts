import { z } from "zod";
import { E2EAgentTraceBindingSchema, E2E_AGENT_TRACE_FILE_MAX_BYTES } from "./e2e-model-channel.js";

/**
 * The audit replay of a verified AI-navigated round (M1.4 Task 4.6b): the same candidate, scenarios and accounts run again with no model, a read-only store that serves only the
 * recordings the verified round left (each bound by digest to the ledger the broker verified), and an executor that holds no model. It is an operator's check. Its result is recorded
 * apart from the task and never touches the verdict, the qualified round, send-back or publication.
 */

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = (max = 120) => z.string().trim().min(1).max(max);

/** The feature a worker lists when it can run a replay round. A worker that does not list it is never handed one. */
export const E2E_REPLAY_CHECKS_FEATURE = "task.workflowE2EReplayChecks.v1" as const;
/** More traces than a round of four groups can have (three agent steps a group). */
export const E2E_REPLAY_TRACES_MAX = 12;
/** The most replays of one verified round that may have started (ran, or timed out); the record of each lives 30 days. */
export const E2E_REPLAY_ATTEMPTS_MAX = 5;
/**
 * The most records one verified round's replays may leave, whatever their end, and so the highest record number an admission carries. Starts that were refused before anything ran leave a
 * record but do not count toward `E2E_REPLAY_ATTEMPTS_MAX`, so the numbering goes further than the cap (Task FU2, REPLAYCAP). Admissions signed before this bound was raised carry 1 to 5.
 */
export const E2E_REPLAY_RECORDS_MAX = 20;
/** The base64 length of the largest recording file (canonical, padded). */
export const E2E_REPLAY_TRACE_BASE64_MAX = Math.ceil(E2E_AGENT_TRACE_FILE_MAX_BYTES / 3) * 4;

/**
 * A recording a replay serves: the file the verified round kept (`{ schemaVersion, keyHash, trace }`, base64), the case and step it is for, the cache key it is stored under and the
 * binding the broker computed when it reviewed the recording against the ledger it verified. The store serves it only when the digest of the file's trace is the binding's.
 */
export const E2EReplayTraceSchema = z.object({
  caseId: id(160), stepIndex: z.number().int().min(0).max(255), keyHash: digest,
  traceBase64: z.string().min(1).max(E2E_REPLAY_TRACE_BASE64_MAX).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  binding: E2EAgentTraceBindingSchema,
}).strict().superRefine((trace, context) => {
  if (trace.binding.caseId !== trace.caseId || trace.binding.stepIndex !== trace.stepIndex) {
    context.addIssue({ code: "custom", path: ["binding"], message: "a recording's binding is for another case or step than the recording" });
  }
});
export type E2EReplayTrace = z.infer<typeof E2EReplayTraceSchema>;

/** What the source round showed for one case: the broker's own verification of it, signed into the replay so a replay can be judged without reading the source again. */
export const E2EReplaySourceCaseSchema = z.object({
  caseId: id(160), assertionOutcomes: z.array(z.enum(["passed", "failed", "unavailable"])).max(20),
  /** SHA-256 of the bytes of the CSV the case downloaded; null when the case has no CSV assertion. */
  csvSha256: digest.nullable(),
}).strict();
export type E2EReplaySourceCase = z.infer<typeof E2EReplaySourceCaseSchema>;

/**
 * The part of an application admission that makes it a replay: signed into the admission (so its digest binds the recordings and what the source showed) and absent from every other
 * round. A replay admission names no model route.
 */
export const E2EApplicationReplaySchema = z.object({
  purpose: z.literal("replay"), sourceRoundId: z.string().uuid(), sourceAdmissionSha256: digest, sourceEvidenceSha256: digest, attempt: z.number().int().positive().max(E2E_REPLAY_RECORDS_MAX),
  sourceCases: z.array(E2EReplaySourceCaseSchema).max(64), traces: z.array(E2EReplayTraceSchema).max(E2E_REPLAY_TRACES_MAX),
}).strict().superRefine((replay, context) => {
  if (new Set(replay.traces.map((trace) => `${trace.caseId}\u0000${trace.stepIndex}`)).size !== replay.traces.length) {
    context.addIssue({ code: "custom", path: ["traces"], message: "a replay holds at most one recording for a step" });
  }
  if (new Set(replay.sourceCases.map((item) => item.caseId)).size !== replay.sourceCases.length) {
    context.addIssue({ code: "custom", path: ["sourceCases"], message: "a replay names each source case once" });
  }
});
export type E2EApplicationReplay = z.infer<typeof E2EApplicationReplaySchema>;

/**
 * Why a replay did not reproduce the round, as a code (the operator reads a fixed sentence; nothing free is ever stored).
 * - `typed-value-not-replayable`: a step needed a value the model chose, which Rovara never keeps (owner decision Q4).
 * - `replay-needs-model`: a step could not be replayed whole (the page changed, no recording matched) and only a model could go on.
 * - `replay-model-called`: the report showed a model call or tokens, which a replay can never have; the replay is UNKNOWN.
 * - `replay-outcome-differs`: an assertion came out otherwise than in the source round.
 * - `replay-download-differs`: the CSV bytes differ from the source round's.
 * - `replay-unverified`: the broker could not verify the replay's evidence as a replay.
 */
export const E2E_REPLAY_REASONS = ["typed-value-not-replayable", "replay-needs-model", "replay-model-called", "replay-outcome-differs", "replay-download-differs", "replay-unverified"] as const;
export type E2EReplayReason = (typeof E2E_REPLAY_REASONS)[number];

/** The stop codes an agent step of a replay can end with: the two ways a step cannot be replayed whole. The collector reads them from the step's retained observation. */
export const E2E_REPLAY_STOP_CODES = ["typed-value-not-replayable", "replay-needs-model"] as const;

/** The reasons the operator's request is refused before anything is started or recorded. */
export const E2E_REPLAY_REFUSALS = ["replay-not-qualified", "replay-source-not-pass", "replay-no-recording", "replay-source-unavailable", "replay-in-progress", "replay-attempts-exhausted", "replay-task-closed"] as const;
export type E2EReplayRefusal = (typeof E2E_REPLAY_REFUSALS)[number];

/** The record of a replay: apart from the task, the broker's own verification of the replay's evidence and never a row a caller supplied. */
export const E2EReplayResultSchema = z.object({
  status: z.enum(["PASS", "FAILED", "UNKNOWN"]), reproduced: z.boolean(), downloadSha256Match: z.boolean(), reason: z.enum(E2E_REPLAY_REASONS).optional(),
}).strict();
export type E2EReplayResult = z.infer<typeof E2EReplayResultSchema>;
