import { z } from "zod";
import {
  E2EAgentTraceBindingSchema, E2EModelReceiptSchema, E2EModelRouteDefinitionSchema, E2E_AGENT_TRACES_PER_GROUP_MAX, E2E_AGENT_TRACE_FILE_MAX_BYTES, checkE2EGroupModelBudget, checkE2EStepModelAccounting, crossCheckE2EAgentLedgerReceipts, e2eModelRouteRevision,
  parseVerifiedE2EAgentActionLedger,
  type E2EModelReceipt, type E2EModelRouteDefinition, type E2ERoundScope, type VerifiedE2EAgentActionLedger,
} from "@agentx/contracts";

/**
 * The verdict of the AI-navigation part of a case (M1.4 Task 4.4a): the one place the plan's table of agent and model outcomes is implemented. It is a pure function over what the
 * worker kept (the receipts of the model calls, which it wrote itself), what the executor left (the action ledger and the e2e report's own account of the step) and the approved
 * goals, so the worker's collector and the broker's re-collection run the very same code and only the broker's answer gates.
 *
 * What it can say is "the agent part is clean, the deterministic assertions decide" or one fixed UNKNOWN code. It never says PASS and never says FAILED: a model cannot move a case
 * toward PASS, and a wrong click that leaves the CSV different stays an assertion failure (owner decision D3), decided by the assertions alone.
 */

export const E2E_AGENT_MODEL_EVIDENCE_SCHEMA_VERSION = "rovara-agent-model-evidence/v1" as const;
/** The most one case's action ledger may weigh (the contract's structural caps keep a real one far under it). Anything bigger is not a ledger of this run. */
export const E2E_AGENT_LEDGER_MAX_BYTES = 65_536;
export const E2E_AGENT_TRACE_BASE64_MAX = Math.ceil(E2E_AGENT_TRACE_FILE_MAX_BYTES * 4 / 3) + 4;
const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().min(0).max(1_000_000);

/**
 * What the worker hands the collector for a group that has an agent step, and uploads as a verdict input (bounded; no prompt, no answer, no page text). It is the worker's claim: the
 * broker holds it to the admission, to the route it reads from the registry and to the e2e report before it is believed.
 *
 * `route` is the definition the worker served the group under; it is null when the worker could not say (its channel failed to close), and a broker never reads it as the route.
 * `valueKey` is the run's HMAC key for the ledger's keyed digests: a verdict input held in private evidence only, never displayed.
 */
export const E2EAgentModelEvidenceSchema = z.object({
  schemaVersion: z.literal(E2E_AGENT_MODEL_EVIDENCE_SCHEMA_VERSION),
  route: E2EModelRouteDefinitionSchema.nullable(),
  valueKey: hex64,
  receipts: z.array(E2EModelReceiptSchema).max(300),
  channel: z.object({ droppedRequests: count, unscopedRequests: count, overrun: z.boolean(), evidenceErrors: count }).strict(),
  /** One action ledger per case that ran an agent step, as the executor wrote it, named by the 16 hex of the digest of the case id (as under `agent/`). */
  ledgers: z.array(z.object({ caseDirectory: z.string().regex(/^[a-f0-9]{16}$/), bytesBase64: z.string().max(Math.ceil(E2E_AGENT_LEDGER_MAX_BYTES * 4 / 3) + 4), sha256: hex64 }).strict()).max(64),
  /** One entry per receipt: the digests of the transcript bodies the worker kept (the bodies themselves are never uploaded) or why it kept none. */
  transcriptDigests: z.array(z.object({ receiptId: z.string().min(1).max(120), promptSha256: hex64.nullable(), responseSha256: hex64.nullable(),
    omitted: z.enum(["budget", "unparseable"]).nullable() }).strict()).max(300),
  /**
   * Task 4.6a (CAPTURE46): the cleaned recordings of the group's passed AI navigation steps, as the executor's trace files (base64, at most 128 KiB each, at most three), each with the
   * step it is for and the binding the host's review made of it. A claim like the rest: the broker reviews every one again against the ledger it verified, and keeps one only on a PASS
   * round. Absent on evidence from before Task 4.6a, which verifies exactly as it did.
   */
  traces: z.array(z.object({ caseDirectory: z.string().regex(/^[a-f0-9]{16}$/), stepIndex: z.number().int().min(0).max(255), keyHash: hex64, traceBase64: z.string().min(1).max(E2E_AGENT_TRACE_BASE64_MAX),
    binding: E2EAgentTraceBindingSchema }).strict()).max(E2E_AGENT_TRACES_PER_GROUP_MAX).optional(),
}).strict();
export type E2EAgentModelEvidence = z.infer<typeof E2EAgentModelEvidenceSchema>;
export type E2EAgentChannelFacts = E2EAgentModelEvidence["channel"];
export type E2EAgentTranscriptDigest = E2EAgentModelEvidence["transcriptDigests"][number];

export const E2E_AGENT_UNKNOWN_CODES = ["model-receipts-mismatch", "model-prompt-credential-match", "model-route-budget-exhausted", "model-unavailable", "agent-timeout",
  "agent-budget-exhausted", "agent-navigation-incomplete", "agent-no-download", "ambiguous-download"] as const;
export type E2EAgentUnknownCode = (typeof E2E_AGENT_UNKNOWN_CODES)[number];
export type E2EAgentCaseVerdict = { kind: "deterministic" } | { kind: "unknown"; code: E2EAgentUnknownCode };

export type E2EAgentStepReport = Readonly<{ modelCalls: number; actionSteps: number; status: string; errorCode: string | null }>;
export type E2EAgentCaseInput = Readonly<{
  roundScope: E2ERoundScope; runId: string; caseId: string; route: E2EModelRouteDefinition;
  /** The agent steps the case reached (those whose capture step exists), by their declared step index. `report` is the e2e report's own account of the step, null when it has none. */
  agentSteps: ReadonlyArray<Readonly<{ declaredStepIndex: number; goal: string; maxActions: number; report: E2EAgentStepReport | null }>>;
  /** The worker's receipts for this case. */
  receipts: readonly unknown[];
  /** Every receipt of the group, for the group's budget; defaults to this case's. */
  groupReceipts?: readonly unknown[];
  ledgerBytes: Uint8Array | null; valueKey: string;
  transcriptDigests: readonly E2EAgentTranscriptDigest[]; channel: E2EAgentChannelFacts;
  /** Whether the case's CSV download was captured (`captured`), is missing (`none`), came twice (`multiple`), or the case has no CSV assertion. Derived by the collector, not the executor. */
  csvDownload: "captured" | "none" | "multiple" | "not-applicable";
}>;
export type E2EAgentCaseResult = Readonly<{
  verdict: E2EAgentCaseVerdict;
  /** The verified ledger, present whenever the receipts and the ledger agreed, whatever the verdict; null when they did not. */
  ledger: VerifiedE2EAgentActionLedger | null;
  /** The ids of the case's receipts when the agent part is clean; empty otherwise. */
  verifiedReceiptIds: string[];
  /** Every code that applied, in precedence order (codes only). The first is the verdict's. */
  matched: E2EAgentUnknownCode[];
}>;

const PRECEDENCE: readonly E2EAgentUnknownCode[] = E2E_AGENT_UNKNOWN_CODES;
const MODEL_UNAVAILABLE_STOPS: ReadonlySet<string> = new Set(["MODEL_UNAVAILABLE", "MODEL_PROVIDER_FAILED"]);

const MISMATCH: E2EAgentCaseResult = Object.freeze({ verdict: Object.freeze({ kind: "unknown" as const, code: "model-receipts-mismatch" as const }), ledger: null, verifiedReceiptIds: [],
  matched: ["model-receipts-mismatch" as const] });

/** The first (highest precedence) code among those that applied. */
const firstOf = (codes: ReadonlySet<E2EAgentUnknownCode>): E2EAgentUnknownCode | undefined => PRECEDENCE.find((code) => codes.has(code));

export function evaluateE2EAgentCase(input: E2EAgentCaseInput): E2EAgentCaseResult {
  try { return evaluate(input); } catch { return MISMATCH; }
}

function evaluate(input: E2EAgentCaseInput): E2EAgentCaseResult {
  const { channel, route } = input;
  // Rule 1 (integrity). The channel's own tally: any request it could not give a receipt, a call out of turn, a charge over its limit or a record it failed to write.
  if (channel.droppedRequests !== 0 || channel.unscopedRequests !== 0 || channel.overrun || channel.evidenceErrors !== 0) return MISMATCH;
  const parsedReceipts: E2EModelReceipt[] = [];
  for (const raw of input.receipts) {
    const parsed = E2EModelReceiptSchema.safeParse(raw);
    if (!parsed.success) return MISMATCH;
    parsedReceipts.push(parsed.data);
  }
  const stepIndexes = new Set(input.agentSteps.map((step) => step.declaredStepIndex));
  if (stepIndexes.size !== input.agentSteps.length || input.agentSteps.length === 0) return MISMATCH;
  // A receipt for another run or case, or for a step that is not an agent step this case reached, is not this case's.
  if (parsedReceipts.some((receipt) => receipt.runId !== input.runId || receipt.caseId !== input.caseId || !stepIndexes.has(receipt.stepIndex))) return MISMATCH;
  if (new Set(parsedReceipts.map((receipt) => receipt.receiptId)).size !== parsedReceipts.length) return MISMATCH;

  // The ledger: bounded, the executor's, and held to this run, this case, the approved goals and the run's key.
  if (input.ledgerBytes === null || input.ledgerBytes.byteLength > E2E_AGENT_LEDGER_MAX_BYTES) return MISMATCH;
  let rawLedger: unknown;
  try { rawLedger = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.ledgerBytes)); } catch { return MISMATCH; }
  const goals = new Map(input.agentSteps.map((step) => [step.declaredStepIndex, step.goal] as const));
  const verified = parseVerifiedE2EAgentActionLedger(rawLedger, { goals, valueKey: input.valueKey, runId: input.runId, caseId: input.caseId });
  if (!verified.ok) return MISMATCH;
  const ledger = verified.ledger;
  if (!crossCheckE2EAgentLedgerReceipts(ledger, parsedReceipts).ok) return MISMATCH;

  const routeRevision = e2eModelRouteRevision(route);
  let stepBudgetRefused = false;
  for (const step of input.agentSteps) {
    const report = step.report;
    if (report === null) return MISMATCH;
    const ledgerStep = ledger.steps.find((item) => item.stepIndex === step.declaredStepIndex);
    if (ledgerStep === undefined || ledgerStep.actions.length > step.maxActions) return MISMATCH;
    // The report's count of the step's actions and the ledger's are two accounts of one list, so they agree both ways (Task FU2, AGENTCOUNT): a ledger that shows fewer actions than the
    // report counted hides some, and one that shows more adds some. The SDK counts a dispatched action even when it failed, and the executor writes a ledger row for each. The only rows it
    // writes for an action the SDK never counted are a navigation to another origin, refused before it is dispatched (row: navigate, policy-denied, path "/"), and the one action that
    // met an exhausted action budget (the last row of a step that ended STEP_BUDGET_EXHAUSTED, failed): at most those may be more than the report.
    const uncounted = ledgerStep.actions.filter((action) => action.tool === "navigate" && action.outcome === "policy-denied" && action.url === "/").length
      + (ledgerStep.stopCode === "STEP_BUDGET_EXHAUSTED" && ledgerStep.actions.at(-1)?.outcome === "action-failed" ? 1 : 0);
    if (report.actionSteps > ledgerStep.actions.length || ledgerStep.actions.length - uncounted > report.actionSteps) return MISMATCH;
    // The ledger and the e2e report are two accounts of one step by the same executor; they must tell the same story.
    const reportPassed = report.status === "passed";
    if (ledgerStep.verdict === "concluded" ? !reportPassed || report.errorCode !== null
      : ledgerStep.verdict === "failed" ? reportPassed || report.errorCode !== ledgerStep.stopCode : reportPassed) return MISMATCH;
    const accounting = checkE2EStepModelAccounting({ roundScope: input.roundScope,
      identity: { runId: input.runId, caseId: input.caseId, stepIndex: step.declaredStepIndex, routeId: route.routeId, routeRevision, provider: route.provider, modelId: route.modelId },
      reportModelCalls: report.modelCalls, receipts: parsedReceipts.filter((receipt) => receipt.stepIndex === step.declaredStepIndex),
      maxModelCallsPerStep: route.budgets.maxActionsPerStep + route.budgets.extraModelCallsPerStep });
    if (!accounting.ok) { if (accounting.code === "budget-refused") stepBudgetRefused = true; else return MISMATCH; }
  }

  // The transcripts: one record per receipt, and where a body was kept its digests are the receipt's.
  const byId = new Map(parsedReceipts.map((receipt) => [receipt.receiptId, receipt] as const));
  if (input.transcriptDigests.length !== parsedReceipts.length || new Set(input.transcriptDigests.map((item) => item.receiptId)).size !== input.transcriptDigests.length) return MISMATCH;
  for (const digest of input.transcriptDigests) {
    const receipt = byId.get(digest.receiptId);
    if (receipt === undefined) return MISMATCH;
    if (receipt.outcome !== "ok" || digest.omitted !== null) continue;
    if (digest.promptSha256 !== null && digest.promptSha256 !== receipt.promptSha256) return MISMATCH;
    if (digest.responseSha256 !== null && digest.responseSha256 !== receipt.responseSha256) return MISMATCH;
  }

  const group = checkE2EGroupModelBudget({ receipts: input.groupReceipts ?? parsedReceipts, budgets: route.budgets });
  if (!group.ok && group.code === "receipt-malformed") return MISMATCH;

  // The facts are consistent. Which of the table's outcomes, if any, they show.
  const codes = new Set<E2EAgentUnknownCode>();
  if (parsedReceipts.some((receipt) => receipt.outcome === "refused-credential-match")) codes.add("model-prompt-credential-match");
  if (stepBudgetRefused || !group.ok) codes.add("model-route-budget-exhausted");
  const stops = ledger.steps.map((step) => step.stopCode);
  if (parsedReceipts.some((receipt) => receipt.outcome === "provider-error" || receipt.outcome === "timeout") || stops.some((stop) => stop !== null && MODEL_UNAVAILABLE_STOPS.has(stop))) codes.add("model-unavailable");
  if (stops.includes("STEP_TIMEOUT")) codes.add("agent-timeout");
  if (stops.includes("STEP_BUDGET_EXHAUSTED")) codes.add("agent-budget-exhausted");
  const otherStop = stops.some((stop) => stop !== null && !MODEL_UNAVAILABLE_STOPS.has(stop) && stop !== "STEP_TIMEOUT" && stop !== "STEP_BUDGET_EXHAUSTED");
  // A step that did not conclude is incomplete navigation whatever its receipts show (a model answer that was invalid, a request refused as out of protocol or while busy): a stop
  // code that is none of the above, or no end reported at all (`cut-short`). One that did conclude is not held against such a receipt: the model was asked again and finished.
  const cutShort = ledger.steps.some((step) => step.verdict === "cut-short");
  if (otherStop || cutShort) codes.add("agent-navigation-incomplete");
  // Rule 8 applies only to a case whose agent part is otherwise clean: why there is no download to read.
  if (codes.size === 0) {
    if (input.csvDownload === "none") codes.add("agent-no-download");
    else if (input.csvDownload === "multiple") codes.add("ambiguous-download");
  }
  const matched = PRECEDENCE.filter((code) => codes.has(code));
  const first = firstOf(codes);
  if (first !== undefined) return { verdict: { kind: "unknown", code: first }, ledger, verifiedReceiptIds: [], matched };
  return { verdict: { kind: "deterministic" }, ledger, verifiedReceiptIds: parsedReceipts.map((receipt) => receipt.receiptId).sort(), matched: [] };
}
