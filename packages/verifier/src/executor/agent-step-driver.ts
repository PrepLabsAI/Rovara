import { E2E_AGENT_STOP_CODES, type E2EModelChannelClient } from "@agentx/contracts";
import { AgentError, isAgentError } from "e2e/agent";
import type { E2EWebAgentPorts } from "../web-runtime.js";
import { createE2EAgentLedgerWriter, type E2EAgentLedgerWriter } from "./agent-ledger.js";
import type { E2EAgentModelAdapter } from "./agent-model-adapter.js";

/**
 * The agent step driver's step lifecycle (Task 4.3b): what happens around one `agent.act` call.
 *
 * 1. The worker is told the step begins (the begin marker, with the session values the browser holds, so a page that shows one is refused before a model sees it). A marker is sent
 *    once per step, so a value the application sets during the step reaches the worker only at the next step's begin; the model adapter's own scan (`scan`, the host's redactor,
 *    which learns every session value as it arrives) refuses a request that carries one in the meantime. A marker the worker
 *    refuses ends the step here: no model call may be made for a step the worker does not know.
 * 2. The step's ledger is opened and the step is made current, so the adapter and the executor can attribute calls and actions to it.
 * 3. `act` runs. An `AgentError` is an outcome (`failed`, with its stop code), not a throw; anything else is recorded as a failed step and thrown again, because it is the executor's own
 *    fault and not something the case can go on from. An action the ledger could not write fails the step with `ENVIRONMENT_UNAVAILABLE` whatever `act` answered: the executor's
 *    tool tells the model a fixed sentence (never the file system's words or a path) and stops the loop, and the step never concludes with an unrecorded action.
 * 4. Whatever happened, the step is no longer current, the ledger records how it ended with the worker's receipt ids, and the worker is told the step ended.
 */
export interface E2EAgentStepDriverOptions {
  client: E2EModelChannelClient;
  adapter: Pick<E2EAgentModelAdapter, "takeReceiptIds">;
  /** The step now running; the adapter and the executor read it. */
  current: { position: { caseId: string; stepIndex: number } | null; ledger: E2EAgentLedgerWriter | null };
  runId: string;
  valueKey: string;
  outDir: string;
  /** The session values this process has learned so far (cookies and tokens); at most the newest 32 go to the worker. */
  sessionSecrets: () => readonly string[];
  /** Test seam: how the case's ledger is made. */
  ledgerFor?: (caseId: string) => E2EAgentLedgerWriter;
}

const STOP_CODES: ReadonlySet<string> = new Set(E2E_AGENT_STOP_CODES);
const END_MARKER_TIMEOUT_MS = 10_000;
const LEDGER_FAULT_MESSAGE = "the action ledger could not be written";

export function createE2EAgentStepDriver(options: E2EAgentStepDriverOptions): E2EWebAgentPorts["runStep"] {
  const ledgers = new Map<string, E2EAgentLedgerWriter>();
  const ledgerOf = (caseId: string): E2EAgentLedgerWriter => {
    let ledger = ledgers.get(caseId);
    if (ledger === undefined) {
      ledger = options.ledgerFor?.(caseId) ?? createE2EAgentLedgerWriter({ outDir: options.outDir, runId: options.runId, caseId, valueKey: options.valueKey });
      ledgers.set(caseId, ledger);
    }
    return ledger;
  };
  return async (request) => {
    const position = { caseId: request.caseId, stepIndex: request.stepIndex };
    const ledger = ledgerOf(request.caseId);
    const cookieValues = options.sessionSecrets().slice(-32);
    await options.client.beginStep({ ...position, ...(cookieValues.length === 0 ? {} : { cookieValues }) }, request.signal);
    let verdict: "concluded" | "failed" = "concluded";
    let stopCode: string | null = null;
    let thrown: unknown;
    let receiptIds: string[] | undefined;
    let begun = false;
    // An action the ledger could not record: the step fails with a fixed code whatever `act` answers, because the ledger no longer says what the agent did.
    let ledgerFault = false;
    const recording: E2EAgentLedgerWriter = { directory: ledger.directory, beginStep: (stepIndex, goal) => ledger.beginStep(stepIndex, goal), endStep: (stepIndex, end) => ledger.endStep(stepIndex, end),
      recordAction(action: Parameters<E2EAgentLedgerWriter["recordAction"]>[0]): void {
        try { ledger.recordAction(action); }
        catch { ledgerFault = true; throw new AgentError("ENVIRONMENT_UNAVAILABLE", LEDGER_FAULT_MESSAGE); }
      } };
    try {
      ledger.beginStep(position.stepIndex, request.goal);
      begun = true;
      options.current.position = position;
      options.current.ledger = recording;
      try { await request.act(request.goal, { maxSteps: request.maxActions, maxModelCalls: request.maxActions + 4, timeout: request.timeoutMs }); }
      catch (error) {
        verdict = "failed";
        if (isAgentError(error)) stopCode = STOP_CODES.has(error.code) ? error.code : "ACTION_FAILED";
        else { stopCode = "ACTION_FAILED"; thrown = error; }
      }
      if (ledgerFault) { verdict = "failed"; stopCode = "ENVIRONMENT_UNAVAILABLE"; }
    } finally {
      options.current.position = null;
      options.current.ledger = null;
      receiptIds = options.adapter.takeReceiptIds(position);
      // The step is over for the worker whatever happened to it, and the ledger says how it ended.
      let endFailure: unknown;
      try { if (begun) ledger.endStep(position.stepIndex, { verdict, stopCode: stopCode as never, receiptIds }); } catch (error) { endFailure = error; }
      try { await options.client.endStep(position, AbortSignal.timeout(END_MARKER_TIMEOUT_MS)); } catch (error) { endFailure ??= error; }
      if (endFailure !== undefined) thrown ??= endFailure;
    }
    if (thrown !== undefined) throw thrown instanceof Error ? thrown : new Error("the agent step failed");
    return { verdict, stopCode, receiptIds: receiptIds ?? [] };
  };
}
