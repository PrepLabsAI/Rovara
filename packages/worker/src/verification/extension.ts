// Spec 051 (FR-006, FR-007): the inline Pi extension that checks the agent's work. It records the agent's test commands
// as they run, and when the agent tries to finish (Pi's agent_before_settle) it reruns the checks. On a regression it
// gives the agent the failing checks and exactly one more turn; after that turn, or when there is no regression, it
// reports AgentX's result.
import {
  AGENTX_PREAMBLE_VERSION,
  agentxPreambleSha256,
  lastAssistantResponse,
  parseAgentClaim,
  reportStatus,
  type CheckEntry,
  type CheckOutcome,
  type CheckReport,
} from "@agentx/contracts";
import type { CustomMessageEntryDraft, InlineExtension } from "@earendil-works/pi-coding-agent";
import { redactedTail } from "../collected-process.js";
import { ownBefore, runChecks, type CheckPlan, type CheckRunners } from "./checks.js";
import { AgentFilesRestoreError, type OriginalCode } from "./original-code.js";
import type { RecordedCommand } from "./recorder.js";
import type { CommandRecorder } from "./recorder.js";

export const VERIFICATION_EXTENSION_NAME = "agentx-verification";
/** The custom message that carries the failing checks to the agent's extra turn. */
export const CHECKS_MESSAGE_TYPE = "agentx_checks";

export interface VerificationOptions {
  /** Read at settle time, after the agent's commands are recorded. */
  plan: () => CheckPlan;
  runners: CheckRunners;
  /** Production: 30 minutes per round (P-3); eval: the agent time remaining. */
  budgetMs: () => number;
  /** Fires on cancel, loop-guard stop or eval limit: a running check stops, and no new one starts. */
  signal: AbortSignal;
  recorder: CommandRecorder;
  /** AgentX's result. Called again if Pi settles again later (a queued message); the last call is the result. */
  onReport: (report: CheckReport) => void;
  /**
   * Called when the agent is given its extra try, with the first round's report (`regression`, extraTry `given`). It is
   * the result if no second settle follows and the signal did not fire (Ruling N); a stopped run reports stopped.
   */
  onExtraTry?: (firstRound: CheckReport) => void;
  /** Where a fault in the extension itself is reported. Messages arrive redacted by the session's sink. */
  onDiagnostic?: (message: string) => void;
  /**
   * D-16 (#290): the code as it was before the task. With it, an agent command that has no before result of its own is
   * also run there, so AgentX knows whether it passed before the change. Without it, such a command's before is unknown.
   */
  originalCode?: OriginalCode;
}

/** The share of a round's budget the before runs may use, so the after runs always have time left. */
const BEFORE_BUDGET_SHARE = 0.5;

/** A report for a run AgentX could not check: stopped (P-4), a model error, or nothing to check. */
export function notVerifiedReport(
  reason: NonNullable<CheckReport["notVerifiedReason"]>,
  details: { source?: CheckReport["source"]; checks?: CheckEntry[]; extraTry?: CheckReport["extraTry"]; agentClaim?: CheckReport["agentClaim"] } = {},
): CheckReport {
  return {
    status: "not_verified",
    notVerifiedReason: reason,
    source: details.source ?? "none",
    preambleVersion: AGENTX_PREAMBLE_VERSION,
    preambleSha256: agentxPreambleSha256(),
    checks: details.checks ?? [],
    extraTry: details.extraTry ?? "not_needed",
    agentClaim: details.agentClaim ?? "none",
  };
}

/**
 * What a task reports at its end when the extension's last report is missing or stale. Ruling Y: once a round found a
 * regression, nothing but a later round that reruns it clears it, so a stop, a cancel, a model error or a loop-guard
 * stop on the extra turn keeps the regression (Ruling N: so does an extra try that never settled again). With no
 * regression behind it, a stop reads `stopped`, a model error `error`. One definition for the coding task and the eval.
 */
export function finalCheckReport(input: {
  reported: CheckReport | undefined;
  firstRound: CheckReport | undefined;
  stopped: boolean;
  errored: boolean;
  agentClaim: CheckReport["agentClaim"];
}): CheckReport {
  if (input.reported !== undefined) return input.reported;
  if (input.firstRound !== undefined) return { ...input.firstRound, agentClaim: input.agentClaim };
  return notVerifiedReason(input);
}

function notVerifiedReason(input: { stopped: boolean; errored: boolean; agentClaim: CheckReport["agentClaim"] }): CheckReport {
  return notVerifiedReport(!input.stopped && input.errored ? "error" : "stopped", { agentClaim: input.agentClaim });
}

/** The final assistant message's text, as the agent's account is read (lastAssistantResponse), or undefined. */
export function assistantText(message: unknown): string | undefined {
  return lastAssistantResponse([{ payload: { type: "message_end", message } }]);
}

/**
 * The extension. It acts on `agent_before_settle` only when the agent's last turn completed. It continues at most once
 * (FR-006): after the extra try, every later settle reports and returns `{}`, so there is never a third round.
 */
export function verificationExtension(options: VerificationOptions): InlineExtension {
  return {
    name: VERIFICATION_EXTENSION_NAME,
    factory: (pi) => {
      const { recorder } = options;
      let extraTry: CheckReport["extraTry"] = "not_needed";
      // The round that gave the extra try: its regressions stand until a later round reruns them (I-2, M-2).
      let firstRound: { source: CheckReport["source"]; entries: CheckEntry[] } | undefined;
      // Ruling Y: what an end that is not a verdict reports: the regression that stands, or the reason there is no check.
      const unverified = (reason: NonNullable<CheckReport["notVerifiedReason"]>, claim: CheckReport["agentClaim"], details: { source?: CheckReport["source"]; checks?: CheckEntry[] } = {}): CheckReport => {
        if (firstRound === undefined) return notVerifiedReport(reason, { extraTry, agentClaim: claim, ...details });
        return {
          status: "regression", source: firstRound.source, preambleVersion: AGENTX_PREAMBLE_VERSION, preambleSha256: agentxPreambleSha256(),
          checks: firstRound.entries, extraTry: "given", agentClaim: claim,
        };
      };
      // Only the last assistant message counts: after the extra try, the extra turn's own message (Review Focus 4).
      let finalText: string | undefined;
      // D-16: before results measured on the original code, kept for the extra try's round.
      const measuredBefore = new Map<string, CheckOutcome>();

      pi.on("tool_call", async (event, context) => { await recorder.observeCall(event, context.signal); });
      pi.on("tool_result", (event) => { recorder.observe(event); });
      pi.on("tool_execution_end", (event) => { recorder.observeExecutionEnd(event.toolCallId); });
      pi.on("turn_end", () => { recorder.observeTurnEnd(); });
      pi.on("message_end", (event) => {
        if ((event.message as { role?: unknown }).role === "assistant") finalText = assistantText(event.message);
      });

      pi.on("agent_before_settle", async (event) => {
        const claim = parseAgentClaim(finalText);
        const report = (value: CheckReport): Record<string, never> => {
          options.onReport(value);
          return {};
        };
        try {
          // Review Focus 3: a model error is no finish to check; Pi skips this hook on an abort, but not on every one.
          if (event.outcome === "error") {
            return report(unverified("error", claim));
          }
          if (event.outcome !== "completed" || options.signal.aborted) return report(unverified("stopped", claim));
          await recorder.settled();
          const plan = options.plan();
          if (plan.source === "none") return report(unverified("no_checks", claim));
          const budgetMs = options.budgetMs();
          const started = Date.now();
          if (plan.source === "agent_commands" && options.originalCode !== undefined) {
            await measureBefore(plan.agentRuns ?? [], measuredBefore, options, options.originalCode, budgetMs * BEFORE_BUDGET_SHARE);
          }
          const round = await runChecks(
            measuredBefore.size === 0 ? plan : { ...plan, measuredBefore },
            options.runners,
            { budgetMs: Math.max(0, budgetMs - (Date.now() - started)), signal: options.signal },
          );
          if (round.stopped || options.signal.aborted) {
            return report(unverified("stopped", claim, { source: plan.source, checks: round.entries }));
          }
          const entries = firstRound === undefined ? round.entries : withStandingRegressions(round.entries, firstRound.entries);
          const status = reportStatus(entries);
          const roundReport = (): CheckReport => ({
            status,
            // Every check unrerun (the budget, or a refused cd): the project has checks, so "no checks" would mislead.
            ...(status === "not_verified" ? { notVerifiedReason: "stopped" as const } : {}),
            source: plan.source,
            preambleVersion: AGENTX_PREAMBLE_VERSION,
            preambleSha256: agentxPreambleSha256(),
            checks: entries,
            extraTry,
            agentClaim: claim,
          });
          if (status === "regression" && extraTry === "not_needed") {
            extraTry = "given";
            firstRound = { source: plan.source, entries };
            options.onExtraTry?.(roundReport());
            const message: CustomMessageEntryDraft = {
              type: "custom_message",
              customType: CHECKS_MESSAGE_TYPE,
              content: checksFeedback(entries),
              display: false,
            };
            // A custom message reaches the model as a user message, so Pi can run the extra turn (canContinue).
            return { entries: [...event.entries, message], continue: true };
          }
          return report(roundReport());
        } catch (error) {
          try {
            options.onDiagnostic?.(`AgentX could not check the agent's work: ${error instanceof Error ? error.message : String(error)}`);
          } catch { /* Reporting must not break the settle. */ }
          return report(unverified("error", claim));
        }
      });
    },
  };
}

/**
 * D-16 (#290): runs each agent command that has no before result of its own on the original code, and records the
 * outcome. A failure to show the original code leaves those commands without a before result and is reported; a failure
 * to restore the agent's files is not survivable and is rethrown, so the settle reports an error.
 */
async function measureBefore(
  runs: readonly RecordedCommand[],
  measured: Map<string, CheckOutcome>,
  options: VerificationOptions,
  originalCode: OriginalCode,
  budgetMs: number,
): Promise<void> {
  const missing = runs.filter((run) => ownBefore(run) === "unknown" && !measured.has(run.replay));
  if (missing.length === 0 || options.signal.aborted) return;
  try {
    const round = await originalCode.run(() => runChecks(
      { source: "agent_commands", agentRuns: missing },
      options.runners,
      { budgetMs, signal: options.signal },
    ));
    round.entries.forEach((entry, index) => {
      if (entry.after !== "not_run") measured.set(missing[index]!.replay, entry.after);
    });
  } catch (error) {
    if (error instanceof AgentFilesRestoreError) throw error;
    try {
      options.onDiagnostic?.(`AgentX could not run the agent's test commands on the original code, so they have no before result: ${error instanceof Error ? error.message : String(error)}`);
    } catch { /* Reporting must not break the settle. */ }
  }
}

/**
 * Ruling O (I-2): a check that was a regression in the round that gave the extra try, and that this round did not rerun
 * (the budget, or a refusal), keeps that round's entry. AgentX saw it regress and never saw it fixed.
 */
function withStandingRegressions(entries: readonly CheckEntry[], earlier: readonly CheckEntry[]): CheckEntry[] {
  return entries.map((entry) => {
    if (entry.class !== "not_rerun") return entry;
    return earlier.find((before) => before.id === entry.id && before.label === entry.label && before.class === "regression") ?? entry;
  });
}

/** Each failing check's output in the agent's message: its last lines, at most this many bytes. */
const FEEDBACK_OUTPUT_BYTES = 8_192;
const FEEDBACK_TOTAL_BYTES = 32_768;

/** What the agent reads before its extra turn: the regressions first, then any other failing check, trimmed. */
export function checksFeedback(entries: readonly CheckEntry[]): string {
  const failing = entries.filter((entry) => entry.after === "failed" || entry.after === "timed_out");
  const ordered = [...failing.filter((entry) => entry.class === "regression"), ...failing.filter((entry) => entry.class !== "regression")];
  const lines = [
    "AgentX reran the checks when you finished, and found a regression: a check that passed before your change fails now.",
    "You have one more turn. Fix the regression, run the check again, and then finish. AgentX reruns the checks once more after this turn.",
    "If a failing test checks the old behaviour the task asked you to change, it is not a regression: update the test to the new behaviour, or, if you were told not to modify tests, leave it and name it in your final message.",
    "End your final message with the AgentX result line, as before.",
  ];
  let used = 0;
  for (const entry of ordered) {
    const room = Math.min(FEEDBACK_OUTPUT_BYTES, FEEDBACK_TOTAL_BYTES - used);
    const output = room > 0 ? redactedTail(entry.output, room) : "";
    used += Buffer.byteLength(output);
    lines.push(
      "",
      `Check: ${entry.label}`,
      `Before your change: ${entry.before}. Now: ${entry.after}.${entry.class === "regression" ? " This is a regression." : ""}`,
      ...(output === "" ? [] : ["Output (last lines):", output]),
    );
  }
  return lines.join("\n");
}

/** The report's total output in the task result and the result event, which are stored as DynamoDB items. */
const COMPACT_OUTPUT_TOTAL_BYTES = 65_536;
const COMPACT_LABEL_BYTES = 1_024;

/**
 * The report as the task result and the result event carry it: the same report, with each check's label and output
 * cut so that 64 checks stay well under DynamoDB's 400 KB item limit (about 130 KB at most). Sizes are counted as the
 * JSON is stored, escaping included, so control characters cannot grow the item. checks.json keeps the full report.
 */
export function compactCheckReport(report: CheckReport): CheckReport {
  if (report.checks.length === 0) return report;
  const perCheck = Math.floor(COMPACT_OUTPUT_TOTAL_BYTES / report.checks.length);
  return {
    ...report,
    checks: report.checks.map((entry) => ({
      ...entry,
      label: headBytes(entry.label, COMPACT_LABEL_BYTES),
      output: tailWithinJson(entry.output, perCheck),
    })),
  };
}

/** The text's start, within `limit` UTF-8 bytes as stored in JSON. */
function headBytes(text: string, limit: number): string {
  if (jsonBytes(text) <= limit) return text;
  let kept = Buffer.from(text, "utf8").subarray(0, limit).toString("utf8").replace(/\uFFFD$/, "");
  while (kept.length > 0 && jsonBytes(kept) > limit) kept = kept.slice(0, Math.floor(kept.length * 0.9)).replace(/[\uD800-\uDBFF]$/, "");
  return kept;
}

/** The text's tail, within `limit` bytes as stored in JSON, cut at a line as readiness output is. */
function tailWithinJson(text: string, limit: number): string {
  let kept = Buffer.byteLength(text) <= limit ? text : redactedTail(text, limit);
  for (let attempt = 0; attempt < 8 && kept.length > 0 && jsonBytes(kept) > limit; attempt += 1) {
    kept = redactedTail(kept, Math.floor(Buffer.byteLength(kept) * limit / jsonBytes(kept) * 0.9));
  }
  return jsonBytes(kept) > limit ? "" : kept;
}

function jsonBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text)) - 2;
}

/** The checks.json artifact stays well below the broker's 5 MB limit: past 4 MB, the compact report is stored (M-4). */
const CHECKS_ARTIFACT_MAX_BYTES = 4_000_000;

export function checksArtifactContent(report: CheckReport): string {
  const full = JSON.stringify(report, null, 2);
  return Buffer.byteLength(full) <= CHECKS_ARTIFACT_MAX_BYTES ? full : JSON.stringify(compactCheckReport(report), null, 2);
}
