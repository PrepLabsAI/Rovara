import { createHash } from "node:crypto";
import { E2EAgentTraceFileSchema, E2E_AGENT_TRACES_PER_GROUP_MAX, E2E_AGENT_TRACE_FILE_MAX_BYTES, parseVerifiedE2EAgentActionLedger, reviewCapturedE2EAgentTrace,
  type E2EAgentTraceBinding, type VerifiedE2EAgentActionLedger } from "@agentx/contracts";
import { agentCaseDirectoryName } from "./executor/evidence-paths.js";

/**
 * The captured recording of an AI navigation step, bound to the ledger (Task 4.6a, CAPTURE46). One implementation for the Docker host (which reads the executor's trace files and decides
 * which to upload) and the broker (which decides again, from what was uploaded, and is the only one that gates): the same bytes, the same ledger rules, the same answer.
 *
 * A recording is kept only when it is a file of the right shape and size, belongs to a step of a case whose ledger verified, and matches that ledger one action at a time
 * (`reviewCapturedE2EAgentTrace`). Everything else is dropped, and a drop loses a replay input and nothing else.
 */

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** One trace as a group uploads it: the file's bytes (base64) and the claim about which step it is and what the review made of it. */
export type E2EAgentTraceUpload = Readonly<{ caseDirectory: string; stepIndex: number; keyHash: string; traceBase64: string; binding: E2EAgentTraceBinding }>;

/** e2e's own normalisation of an instruction before it is digested into a cache key (`cache/identity.ts`): line ends, NFC and trimmed. */
export const normalizeAgentInstruction = (instruction: string): string => instruction.replace(/\r\n?/gu, "\n").normalize("NFC").trim();
/** The digest of an instruction as e2e's trace provenance carries it. */
export const agentInstructionDigest = (instruction: string): string => sha256(normalizeAgentInstruction(instruction));

/** A case of the group with an AI navigation step: its approved agent steps (by their index in the scenario) and its ledger when that verified. */
export type E2EAgentTraceCase = Readonly<{ caseId: string; steps: ReadonlyArray<Readonly<{ stepIndex: number; goal: string }>>; ledger: VerifiedE2EAgentActionLedger | null }>;

/** The ledger of a case from the bytes the executor left, held to the run, the case, the approved goals and the run's key; null when it is not that ledger. */
export function verifiedAgentCaseLedger(input: { ledgerBytes: Uint8Array | null; valueKey: string; runId: string; caseId: string; steps: E2EAgentTraceCase["steps"] }): VerifiedE2EAgentActionLedger | null {
  if (input.ledgerBytes === null) return null;
  try {
    const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.ledgerBytes));
    const parsed = parseVerifiedE2EAgentActionLedger(raw, { goals: new Map(input.steps.map((step) => [step.stepIndex, step.goal] as const)), valueKey: input.valueKey, runId: input.runId, caseId: input.caseId });
    return parsed.ok ? parsed.ledger : null;
  } catch { return null; }
}

/**
 * Which step of which case a recording was made for, from the provenance e2e wrote into it: the test it belongs to names the case, and the digest of the instruction with the number of
 * earlier calls of the same instruction name the step (two steps with one goal are told apart by `callIndex`). Undefined when the provenance is absent or fits no step.
 */
export function mapAgentTraceToStep(trace: unknown, cases: readonly E2EAgentTraceCase[]): { caseId: string; stepIndex: number } | undefined {
  if (!isRec(trace) || !isRec(trace["recordedFor"])) return undefined;
  const provenance = trace["recordedFor"];
  const testId = provenance["testId"];
  const instructionDigest = provenance["instructionDigest"];
  const callIndex = provenance["callIndex"];
  if (typeof testId !== "string" || typeof instructionDigest !== "string" || typeof callIndex !== "number" || !Number.isInteger(callIndex) || callIndex < 0) return undefined;
  const owners = cases.filter((item) => testId.endsWith(`::${item.caseId}`));
  if (owners.length !== 1) return undefined;
  const owner = owners[0]!;
  const same = owner.steps.filter((step) => agentInstructionDigest(step.goal) === instructionDigest);
  const step = same[callIndex];
  return step === undefined ? undefined : { caseId: owner.caseId, stepIndex: step.stepIndex };
}

export type E2EAgentTraceReview =
  | { keep: true; caseId: string; caseDirectory: string; stepIndex: number; keyHash: string; binding: E2EAgentTraceBinding }
  | { keep: false; reason: "trace-file-malformed" | "trace-file-too-large" | "trace-unmapped" | "trace-step-mismatch" | "ledger-not-verified" | "trace-review-failed" };

/**
 * The review of one trace file. `expect` is what an upload claims (the broker holds it to what the file itself says); without it the mapping alone decides (the host, which reads the
 * executor's files). The binding it returns is the review's own: an upload's claimed binding is compared to it by the caller.
 */
export function reviewAgentTraceFile(input: { bytes: Uint8Array; cases: readonly E2EAgentTraceCase[]; valueKey: string; expect?: { caseDirectory: string; stepIndex: number; keyHash: string } }): E2EAgentTraceReview {
  if (input.bytes.byteLength > E2E_AGENT_TRACE_FILE_MAX_BYTES) return { keep: false, reason: "trace-file-too-large" };
  let file: ReturnType<typeof E2EAgentTraceFileSchema.safeParse>;
  try { file = E2EAgentTraceFileSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.bytes))); } catch { return { keep: false, reason: "trace-file-malformed" }; }
  if (!file.success) return { keep: false, reason: "trace-file-malformed" };
  const mapped = mapAgentTraceToStep(file.data.trace, input.cases);
  if (mapped === undefined) return { keep: false, reason: "trace-unmapped" };
  const caseDirectory = agentCaseDirectoryName(mapped.caseId);
  if (input.expect !== undefined && (input.expect.caseDirectory !== caseDirectory || input.expect.stepIndex !== mapped.stepIndex || input.expect.keyHash !== file.data.keyHash)) return { keep: false, reason: "trace-step-mismatch" };
  const owner = input.cases.find((item) => item.caseId === mapped.caseId);
  if (owner?.ledger == null) return { keep: false, reason: "ledger-not-verified" };
  // Owner decision Q4: an anchor's input value is text of the step's own goal or a keyed digest, never text the model chose.
  const goal = owner.steps.find((step) => step.stepIndex === mapped.stepIndex)?.goal;
  const anchorValues = [...(file.data.trace.endAnchors ?? []), ...(file.data.trace.goneAnchors ?? [])].flatMap((anchor) => (anchor.value === undefined ? [] : [anchor.value]));
  if (goal === undefined || anchorValues.some((value) => !/^hmac-sha256:[a-f0-9]{64}$/.test(value) && !(value.length <= 256 && goal.includes(value)))) return { keep: false, reason: "trace-review-failed" };
  const review = reviewCapturedE2EAgentTrace({ stepIndex: mapped.stepIndex, trace: file.data.trace, ledger: owner.ledger, valueKey: input.valueKey, credentialScanHit: false });
  if (!review.keep) return { keep: false, reason: "trace-review-failed" };
  return { keep: true, caseId: mapped.caseId, caseDirectory, stepIndex: mapped.stepIndex, keyHash: file.data.keyHash, binding: review.binding };
}

/**
 * The traces a group uploads: those of the executor's files that review clean, at most one per step and at most the group's agent step cap, in a fixed order (case directory, step).
 * Each carries the file's bytes and the binding the review made of them.
 */
export function selectAgentTraceUploads(input: { files: ReadonlyArray<Readonly<{ bytes: Uint8Array }>>; cases: readonly E2EAgentTraceCase[]; valueKey: string }): E2EAgentTraceUpload[] {
  const kept = new Map<string, E2EAgentTraceUpload>();
  const twice = new Set<string>();
  for (const file of input.files) {
    const review = reviewAgentTraceFile({ bytes: file.bytes, cases: input.cases, valueKey: input.valueKey });
    if (!review.keep) continue;
    const key = `${review.caseDirectory}:${review.stepIndex}`;
    // Two recordings for one step cannot both be the step's: neither is kept.
    if (kept.has(key)) { twice.add(key); continue; }
    kept.set(key, { caseDirectory: review.caseDirectory, stepIndex: review.stepIndex, keyHash: review.keyHash, traceBase64: Buffer.from(file.bytes).toString("base64"), binding: review.binding });
  }
  return [...kept.entries()].filter(([key]) => !twice.has(key)).map(([, upload]) => upload).sort((left, right) => (left.caseDirectory === right.caseDirectory ? left.stepIndex - right.stepIndex : left.caseDirectory.localeCompare(right.caseDirectory)))
    .slice(0, E2E_AGENT_TRACES_PER_GROUP_MAX);
}
