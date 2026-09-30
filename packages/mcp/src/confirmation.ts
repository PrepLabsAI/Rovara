// Spec 025 FR-041, E13, E15: confirm a planned change in the client's own pop-up when it can show
// one, else by the Slack Confirm button; apply it, decline it, or report that it waits. One trace
// ID runs through every call of one change (FR-052). Answers are read loosely (R1): a status this
// CLI does not know is neither applied nor pending.
import { ADMIN_CHANGE_PROGRESS_MS, ADMIN_CHANGE_SLACK_WAIT_MS, type AdminChangeViewWire } from "@agentx/contracts";
import type { AdminControlPlaneClient } from "./admin-client.js";
import { ToolError, plainText, type ToolErrorCode } from "./errors.js";
import type { ToolCall } from "./tools.js";

export const SLACK_POLL_MS = 5_000;
/** The pop-up gets at most this long, and always ends before the change's own 10 minutes. */
const ELICITATION_MAX_MS = 9 * 60_000;
/** The pop-up closes at least this long before the change expires, so its answer still counts. */
const ELICITATION_MARGIN_MS = 30_000;

export interface ConfirmationRun {
  admin: AdminControlPlaneClient;
  change: AdminChangeViewWire;
  traceId: string;
  elicit?: ToolCall["elicit"];
  progress?: ToolCall["progress"];
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
  signal: AbortSignal;
  log?(entry: Record<string, unknown>): void;
}
export type ConfirmationOutcome = { outcome: "applied" | "awaiting_confirmation"; change: AdminChangeViewWire };

/** Codes a failed change's error keeps as they are: FR-049's own. */
const CODES = new Set<ToolErrorCode>(["CONFIRMATION_UNAVAILABLE", "CONFIRMATION_DECLINED", "CONFIRMATION_EXPIRED", "CHANGE_STALE", "SLACK_UNAVAILABLE", "ADMIN_REQUIRED"]);
const KNOWN_STATUSES = new Set(["pending", "applying", "applied", "declined", "expired", "failed"]);

/** E15: why a change did not apply, as FR-049's code, naming the change. */
export function changeError(change: AdminChangeViewWire): ToolError {
  const named = (text: string) => `change ${change.changeId}: ${text}`;
  if (change.status === "declined") return new ToolError("CONFIRMATION_DECLINED", named("it was declined, so nothing changed"));
  if (change.status === "expired") return new ToolError("CONFIRMATION_EXPIRED", named(`it expired at ${change.expiresAt} without a confirmation, so nothing changed`));
  if (!KNOWN_STATUSES.has(change.status)) {
    // R1: a newer control plane's status. Neither applied nor pending, so say what is known.
    const status = plainText(change.status, "unknown").slice(0, 40);
    return new ToolError("UPGRADE_REQUIRED", named(`AgentX reports its status as ${status}, which this version of the CLI does not know; list it with agentx_admin_changes to see its outcome`));
  }
  const code = change.error?.code;
  const message = named(plainText(change.error?.message, "it was not applied"));
  if (code !== undefined && CODES.has(code as ToolErrorCode)) return new ToolError(code as ToolErrorCode, message);
  if (code === "RUNTIME_UNAVAILABLE") return new ToolError("CONTROL_PLANE_UNAVAILABLE", message);
  return new ToolError("INVALID_REQUEST", message);
}

const iso = (ms: number) => new Date(ms).toISOString();
const waiting = (change: AdminChangeViewWire) => change.status === "pending" || change.status === "applying";

/** R4: the planning admin's view may name a private channel they are a member of. */
function shownEffect(change: AdminChangeViewWire): string {
  const planner = (change as { confirmationEffect?: unknown }).confirmationEffect;
  return typeof planner === "string" && planner !== "" ? planner : change.effect;
}

async function waitForSlack(run: ConfirmationRun, note: string): Promise<ConfirmationOutcome> {
  let change = await run.admin.startSlackConfirmation(run.change.changeId, run.traceId);
  const started = run.now();
  let lastProgress = -ADMIN_CHANGE_PROGRESS_MS;
  const total = ADMIN_CHANGE_SLACK_WAIT_MS / 1_000;
  while (waiting(change) && !run.signal.aborted && run.now() - started < ADMIN_CHANGE_SLACK_WAIT_MS) {
    const elapsed = run.now() - started;
    if (elapsed - lastProgress >= ADMIN_CHANGE_PROGRESS_MS) {
      lastProgress = elapsed;
      await run.progress?.(Math.floor(elapsed / 1_000), total, `${note}Waiting for your Confirm in Slack: ${Math.ceil((ADMIN_CHANGE_SLACK_WAIT_MS - elapsed) / 1_000)} seconds left`);
    }
    try {
      await run.sleep(SLACK_POLL_MS, run.signal);
    } catch {
      // A cancelled tool call ends the wait; the change keeps its button (D7).
      if (run.signal.aborted) break;
    }
    if (run.signal.aborted) break;
    try {
      change = await run.admin.getChange(run.change.changeId, run.traceId);
    } catch (error) {
      // A failed check is tried again at the next poll; the press still applies server side (D7).
      run.log?.({ event: "change.poll_failed", changeId: run.change.changeId, code: error instanceof ToolError ? error.code : "unknown" });
    }
  }
  if (change.status === "applied") return { outcome: "applied", change };
  if (!waiting(change)) throw changeError(change);
  return { outcome: "awaiting_confirmation", change };
}

export async function confirmChange(run: ConfirmationRun): Promise<ConfirmationOutcome> {
  const offered = run.change.methodsOffered;
  const slack = offered.includes("slack");
  if (offered.includes("elicitation") && run.elicit !== undefined) {
    const requestedAt = iso(run.now());
    const timeout = Math.max(1_000, Math.min(ELICITATION_MAX_MS, Date.parse(run.change.expiresAt) - run.now() - ELICITATION_MARGIN_MS));
    const answer = await run.elicit(`${shownEffect(run.change)}\n\nApply this change? It expires at ${run.change.expiresAt}.`, timeout, run.signal);
    const answeredAt = iso(run.now());
    if (answer === "accept") {
      const applied = await run.admin.applyChange(run.change.changeId, { method: "elicitation", requestedAt, answeredAt }, run.traceId);
      if (applied.status === "applied") return { outcome: "applied", change: applied };
      throw changeError(applied);
    }
    if (answer === "decline" || answer === "cancel") {
      const declined = await run.admin.declineChange(run.change.changeId, { method: "elicitation", reason: answer === "decline" ? "declined" : "cancelled", answeredAt }, run.traceId);
      throw changeError(declined);
    }
    // Review Focus 3: the pop-up could not be shown or answered (an error, or its 9 minutes ran
    // out). Slack if it was offered, and the progress says so; else the change is declined.
    run.log?.({ event: "change.elicitation_failed", changeId: run.change.changeId });
    if (!slack) {
      try {
        await run.admin.declineChange(run.change.changeId, { method: "elicitation", reason: "failed", answeredAt }, run.traceId);
      } catch (error) {
        // Nothing applied either way: the change expires on its own at its 10 minutes.
        run.log?.({ event: "change.decline_failed", changeId: run.change.changeId, code: error instanceof ToolError ? error.code : "unknown" });
      }
      throw new ToolError("CONFIRMATION_DECLINED", `change ${run.change.changeId}: the confirmation pop-up could not be shown, so nothing changed`);
    }
    return waitForSlack(run, "the pop-up could not be shown, so confirm in Slack instead. ");
  }
  if (slack) return waitForSlack(run, "");
  throw new ToolError("CONFIRMATION_UNAVAILABLE", `change ${run.change.changeId}: no confirmation method is available in this session`);
}
