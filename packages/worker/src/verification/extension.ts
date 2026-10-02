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
  type CheckReport,
} from "@agentx/contracts";
import type { CustomMessageEntryDraft, InlineExtension } from "@earendil-works/pi-coding-agent";
import { redactedTail } from "../collected-process.js";
import { runChecks, type CheckPlan, type CheckRunners } from "./checks.js";
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
}

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
      // Only the last assistant message counts: after the extra try, the extra turn's own message (Review Focus 4).
      let finalText: string | undefined;

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
          if (event.outcome === "error") return report(notVerifiedReport("error", { extraTry, agentClaim: claim }));
          if (event.outcome !== "completed" || options.signal.aborted) return report(notVerifiedReport("stopped", { extraTry, agentClaim: claim }));
          await recorder.settled();
          const plan = options.plan();
          if (plan.source === "none") return report(notVerifiedReport("no_checks", { extraTry, agentClaim: claim }));
          const round = await runChecks(plan, options.runners, { budgetMs: options.budgetMs(), signal: options.signal });
          if (round.stopped || options.signal.aborted) {
            return report(notVerifiedReport("stopped", { source: plan.source, checks: round.entries, extraTry, agentClaim: claim }));
          }
          const status = reportStatus(round.entries);
          const roundReport = (): CheckReport => ({
            status,
            ...(status === "not_verified" ? { notVerifiedReason: "no_checks" as const } : {}),
            source: plan.source,
            preambleVersion: AGENTX_PREAMBLE_VERSION,
            preambleSha256: agentxPreambleSha256(),
            checks: round.entries,
            extraTry,
            agentClaim: claim,
          });
          if (status === "regression" && extraTry === "not_needed") {
            extraTry = "given";
            options.onExtraTry?.(roundReport());
            const message: CustomMessageEntryDraft = {
              type: "custom_message",
              customType: CHECKS_MESSAGE_TYPE,
              content: checksFeedback(round.entries),
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
          return report(notVerifiedReport("error", { extraTry, agentClaim: claim }));
        }
      });
    },
  };
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
const COMPACT_LABEL_CHARS = 1_024;

/**
 * The report as the task result and the result event carry it: the same report, with each check's label and output
 * cut so that 64 checks stay well under DynamoDB's 400 KB item limit. checks.json keeps the full report.
 */
export function compactCheckReport(report: CheckReport): CheckReport {
  if (report.checks.length === 0) return report;
  const perCheck = Math.floor(COMPACT_OUTPUT_TOTAL_BYTES / report.checks.length);
  return {
    ...report,
    checks: report.checks.map((entry) => ({
      ...entry,
      label: entry.label.length <= COMPACT_LABEL_CHARS ? entry.label : entry.label.slice(0, COMPACT_LABEL_CHARS).replace(/[\uD800-\uDBFF]$/, ""),
      output: Buffer.byteLength(entry.output) <= perCheck ? entry.output : redactedTail(entry.output, perCheck),
    })),
  };
}
