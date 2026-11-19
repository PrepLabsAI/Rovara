// Design review stage: the broker checks a worker's report against the packet it built, and voids a reviewer whose input it cannot prove.
//
// The report is what the worker says: `{ sessionId, packetDigest, firstRequestMessages, filesRead, tools }` (plus the id of the model key it used, which is required). It is read strictly. A failed check
// voids that reviewer only, with one fixed code from the contract (REVIEWER_VERIFY_FAILURES); the first failing check in the order below names the code. Nothing is guessed: a report that does
// not parse, a number that is not a number or a record that is missing is a failure, never a pass.
//
// What each check proves, and what it cannot:
//   - packet digest: the worker FETCHED the packet the broker built (it recomputes the digest from the packet it received, `packetDigestOf`). That is not proof of what the model was sent (the worker can lie, and
//     pi adds system text of its own); `sentDigest` in the report is the session's own word about that. Only the proxy check below proves anything about the first call.
//   - first request has two messages (system + one user): no history was sent.
//   - session id is new for the task (all rounds, and not shared by two reviewers of the same round).
//   - tools are all read-only (READ_ONLY_TOOLS).
//   - the model key was minted for this reviewer alone: it is not any other reviewer's key, and the worker, when it names a key, names this one.
//   - the model proxy's record of that key's FIRST call reads the input the packet predicts, within 10%. This is the only check the worker cannot fake, because the proxy counts the tokens.
//     It needs a reader of the proxy's per-call usage. When the install has none, the result says `inputProof: "digest_only"`; `runVerdictOf` carries it into `ReviewerRun.inputProof`,
//     and the card shows `inputProofSentence(...)`, which never claims the proxy checked anything.
import { READ_ONLY_TOOLS, type InputProof, type REVIEWER_VERIFY_FAILURES } from "@agentx/contracts";
import { z } from "zod";

export type ReviewerVerifyFailure = (typeof REVIEWER_VERIFY_FAILURES)[number];

/** How far the proxy's first-call input token count may be from the packet's estimate, as a fraction of the estimate. */
export const FIRST_CALL_TOLERANCE = 0.1;
/** The first request of a fresh session is the system message and one user message. */
export const FIRST_REQUEST_MESSAGES = 2;

const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

export const WorkerReportSchema = z.object({
  sessionId: z.string().min(1).max(200),
  packetDigest: z.string().regex(/^[a-f0-9]{64}$/),
  firstRequestMessages: z.number().int().min(0).max(1_000),
  /** The worker's own word. Control, bidi and other invisible characters are removed (an entry that is empty afterwards is dropped); never used as proof of what was read. */
  filesRead: z.array(z.string().min(1).max(500)).max(200).transform((files) => files.map((file) => file.replace(HIDDEN_CHARACTERS, "")).filter((file) => file !== "")),
  tools: z.array(z.string().min(1).max(64)).max(32),
  /**
   * The id (SHA-256) of the model key the session used. REQUIRED (N4): a report that names no key could have run on the install's own credential or on the operation's key, and a report cannot be
   * trusted to be about this reviewer's key unless it says so. The proxy check still reads the key the broker minted, not this one.
   */
  modelKeyId: z.string().min(1).max(200),
  /** SHA-256 of what the session SAYS its first request held (system text as pi holds it, harness additions included, and the user message). The worker's own word, kept as a record: never used as proof. */
  sentDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  /** How many characters of system text the harness added after the role prompt. A record, not a check. */
  harnessSystemChars: z.number().int().min(0).max(1_000_000).optional(),
}).strict();
export type WorkerReport = z.infer<typeof WorkerReportSchema>;

/**
 * The model proxy's record of one key's first call. `undefined` means the proxy has no record for the key. A reader that cannot answer throws; that counts as no record.
 * `firstCallInputTokens` is the prompt token count of the earliest call made with the key.
 */
export interface FirstCallUsageReader {
  firstCall(keyId: string): Promise<{ firstCallInputTokens: number; calls: number } | undefined>;
}

export type UsageCheck =
  | { kind: "proxy"; reader: FirstCallUsageReader }
  /** No reader is installed: the first-call check is not made, and the result says so. Chosen on purpose by the wiring, never by omission. */
  | { kind: "unavailable" };

export type VerifyResult =
  | {
    verified: true;
    sessionId: string;
    filesRead: string[];
    /** "proxy_first_call": the proxy confirmed the first call. "digest_only": the packet digest was the only proof of input (no usage reader). */
    inputProof: InputProof;
    firstCallInputTokens?: number;
  }
  | { verified: false; failure: ReviewerVerifyFailure };

export interface VerifyReviewerInput {
  packet: { packetDigest: string; estimatedInputTokens: number };
  /** The worker's report, as received. */
  report: unknown;
  /** Session ids already used in this task: every earlier round, and every other reviewer of this round that was run (voided ones too). */
  usedSessionIds: ReadonlySet<string>;
  /**
   * The key the broker minted for this reviewer's slot, every key it minted for another reviewer (or the merge step) of the task, and the key of the OPERATION itself. A reviewer's key must be none of the
   * others and not the operation's: a reviewer that ran on the operation's key shares it with every other session, and its spend and first call cannot be told apart (N4).
   */
  modelKey: { keyId: string; otherReviewerKeyIds: ReadonlySet<string>; operationKeyId: string };
  usage: UsageCheck;
  tolerance?: number;
}

const fail = (failure: ReviewerVerifyFailure): VerifyResult => ({ verified: false, failure });
const READ_ONLY: ReadonlySet<string> = new Set(READ_ONLY_TOOLS);
/**
 * The reviewer's answer tool (structured answers): the worker offers it beside the read-only file tools and lists it in the report. It reads and writes nothing in the workspace: its call is the reviewer's
 * answer. Named here, so an unknown tool is still refused. The merge step's tool is not listed: the merge step has no report.
 */
export const REVIEWER_ANSWER_TOOLS: ReadonlySet<string> = new Set(["submit_design_review"]);
const KEY_ID = /^[0-9a-f]{64}$/;

/** Verifies one reviewer's report. First failing check wins, in this order: unreadable report, packet digest, first request, session, tools, key, first call. */
export async function verifyReviewerReport(input: VerifyReviewerInput): Promise<VerifyResult> {
  const parsed = WorkerReportSchema.safeParse(input.report);
  if (!parsed.success) return fail("unreadable_output");
  const report = parsed.data;

  if (report.packetDigest !== input.packet.packetDigest) return fail("packet_digest_mismatch");
  // History in the first request means the session was not fresh. The contract has no code of its own for it; the first call did not read what the packet says it should.
  if (report.firstRequestMessages !== FIRST_REQUEST_MESSAGES) return fail("first_call_mismatch");
  if (input.usedSessionIds.has(report.sessionId)) return fail("session_reused");
  if (report.tools.some((tool) => !READ_ONLY.has(tool) && !REVIEWER_ANSWER_TOOLS.has(tool))) return fail("tool_not_read_only");

  const { keyId, otherReviewerKeyIds, operationKeyId } = input.modelKey;
  if (!KEY_ID.test(keyId) || !KEY_ID.test(operationKeyId) || keyId === operationKeyId || otherReviewerKeyIds.has(keyId) || report.modelKeyId !== keyId) return fail("model_key_mismatch");

  if (input.usage.kind === "unavailable") return { verified: true, sessionId: report.sessionId, filesRead: report.filesRead, inputProof: "digest_only" };

  let record: Awaited<ReturnType<FirstCallUsageReader["firstCall"]>>;
  try { record = await input.usage.reader.firstCall(keyId); } catch { return fail("no_usage_record"); }
  if (record === undefined || !Number.isFinite(record.firstCallInputTokens) || record.firstCallInputTokens <= 0 || !Number.isFinite(record.calls) || record.calls < 1) return fail("no_usage_record");
  const estimate = input.packet.estimatedInputTokens;
  if (!Number.isFinite(estimate) || estimate <= 0) return fail("first_call_mismatch");
  // A tolerance that is NaN, infinite or outside 0..1 would pass everything (NaN fails the comparison below) or nothing: it is a failure, never a pass.
  const tolerance = input.tolerance ?? FIRST_CALL_TOLERANCE;
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1) return fail("first_call_mismatch");
  if (!(Math.abs(record.firstCallInputTokens - estimate) <= estimate * tolerance)) return fail("first_call_mismatch");
  return { verified: true, sessionId: report.sessionId, filesRead: report.filesRead, inputProof: "proxy_first_call", firstCallInputTokens: record.firstCallInputTokens };
}

export interface RoundReviewer {
  role: string;
  packet: VerifyReviewerInput["packet"];
  report: unknown;
  keyId: string;
}

/**
 * Verifies every reviewer of one round together. Adds what a single check cannot see:
 *   - two reports of this round with the same session id void BOTH (neither can be called the fresh one);
 *   - a key is "this reviewer's alone" only if no other reviewer of the round, and no earlier run of the task, holds it.
 * Results come back in the order given. A reviewer whose report did not parse still has its keyId counted as taken.
 */
export async function verifyRound(input: {
  reviewers: readonly RoundReviewer[]; priorSessionIds: ReadonlySet<string>; priorKeyIds: ReadonlySet<string>;
  /** The key of the operation itself, which no slot key may equal. */
  operationKeyId: string;
  /** The merge step's key, which no reviewer may share. */
  mergeKeyId?: string;
  usage: UsageCheck; tolerance?: number;
}): Promise<VerifyResult[]> {
  const sessionOf = (report: unknown): string | undefined => {
    const parsed = WorkerReportSchema.safeParse(report);
    return parsed.success ? parsed.data.sessionId : undefined;
  };
  const sessions = input.reviewers.map((reviewer) => sessionOf(reviewer.report));
  const counts = new Map<string, number>();
  for (const id of sessions) if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1);
  const results: VerifyResult[] = [];
  for (const [index, reviewer] of input.reviewers.entries()) {
    const own = sessions[index];
    const sharedInRound = own !== undefined && (counts.get(own) ?? 0) > 1;
    const others = new Set(input.priorKeyIds);
    if (input.mergeKeyId !== undefined) others.add(input.mergeKeyId);
    for (const [other, peer] of input.reviewers.entries()) if (other !== index) others.add(peer.keyId);
    // A session id shared inside the round is handed to the single check as "already used", which gives it the matching code after the earlier checks have run.
    const used = sharedInRound ? new Set([...input.priorSessionIds, own]) : input.priorSessionIds;
    results.push(await verifyReviewerReport({
      packet: reviewer.packet, report: reviewer.report, usedSessionIds: used, modelKey: { keyId: reviewer.keyId, otherReviewerKeyIds: others, operationKeyId: input.operationKeyId }, usage: input.usage,
      ...(input.tolerance === undefined ? {} : { tolerance: input.tolerance }),
    }));
  }
  return results;
}

/** The fields of `ReviewerRun` that a result decides. A verified run always carries what proved its input (`inputProof`); the card words come from `inputProofSentence`. */
export function runVerdictOf(result: VerifyResult): { verified: true; inputProof: InputProof } | { verified: false; verifyFailure: ReviewerVerifyFailure } {
  return result.verified ? { verified: true, inputProof: result.inputProof } : { verified: false, verifyFailure: result.failure };
}
