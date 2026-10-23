import { z } from "zod";

/**
 * When a qualified browser and API runtime registration stops being good, and what an operator does about it (evaluation fix RUN-3).
 *
 * A registration lives at most seven days (`min(challenge + 30 d, qualifiedAt + 7 d)`) and is not good any more once the executor or worker image changes, and only an operator
 * running the qualification script renews it. Nothing renewed it on a schedule, so every project's browser and API checks stopped at once. `agentx doctor` and the TEST deploy check
 * now say so ahead of time, in these words, naming the expiry time and the exact command.
 */

/** A registration that expires within this long is warned about (a warning never fails a check). */
export const E2E_RUNTIME_EXPIRY_WARNING_MS = 48 * 3_600_000;
/** Within this long the TEST deploy check fails (it always did): a round that long from now would be refused. */
export const E2E_RUNTIME_EXPIRY_ERROR_MS = 24 * 3_600_000;

/** The command that qualifies the runtime again and registers it (run from a Rovara checkout, with the operator's AWS profile). */
export function e2eRuntimeRenewCommand(input: { env: string; profile: string }): string {
  return `npx tsx scripts/test-qualify-runtime.ts --env ${input.env} --profile ${input.profile} --apply`;
}
/** The same command with the two values this caller cannot know left for the reader to fill in. */
export const E2E_RUNTIME_GENERIC_RENEW_COMMAND = e2eRuntimeRenewCommand({ env: "<env>", profile: "<aws-profile>" });

/** `message` is `problem` and the renew command in one line; a caller with a separate place for the fix uses the two parts. */
export type E2ERuntimeExpiryNotice = { severity: "error" | "warning"; problem: string; renewCommand: string; message: string };

/**
 * What to say about a registration that expires at `expiresAt`, or undefined when it is good for 48 hours or more. `subject` opens the sentence (for example the catalog row or
 * `the web runtime`). Already expired and under 24 hours are `error` (the TEST deploy check fails on them; `agentx doctor` shows every notice as a warning); under 48 hours is `warning`.
 * An expiry that cannot be read is an error, never silence.
 */
export function e2eRuntimeExpiryNotice(input: { subject: string; expiresAt: string; now: number; renewCommand?: string | undefined }): E2ERuntimeExpiryNotice | undefined {
  const renewCommand = input.renewCommand ?? E2E_RUNTIME_GENERIC_RENEW_COMMAND;
  const notice = (severity: "error" | "warning", problem: string): E2ERuntimeExpiryNotice => ({ severity, problem, renewCommand, message: `${problem}; renew it with: ${renewCommand}` });
  const expiry = Date.parse(input.expiresAt);
  if (Number.isNaN(expiry)) return notice("error", `${input.subject} has an unreadable expiry ${input.expiresAt}`);
  const left = expiry - input.now;
  if (left <= 0) return notice("error", `${input.subject} expired at ${input.expiresAt}, so browser and API checks cannot run`);
  if (left >= E2E_RUNTIME_EXPIRY_WARNING_MS) return undefined;
  return notice(left < E2E_RUNTIME_EXPIRY_ERROR_MS ? "error" : "warning",
    `${input.subject} expires at ${input.expiresAt}, in ${(left / 3_600_000).toFixed(1)} hours, and browser and API checks stop then`);
}

/**
 * What the control plane answers an administrator who asks about the runtime registrations (`GET /v1/admin/runtime-installation/status`): for each of the web and API kinds of the
 * qualified profile that has a row, its state and when it was qualified and expires. Nothing else of the row (endpoints, digests, evidence) is in it.
 */
export const E2ERuntimeStatusSchema = z.object({
  rows: z.array(z.object({
    kind: z.enum(["web", "api"]), profileId: z.string().min(1).max(120), state: z.string().min(1).max(40),
    qualifiedAt: z.string().min(1).max(40), expiresAt: z.string().min(1).max(40),
  }).strict()).max(8),
  // The control plane adds its request id to every answer.
}).loose();
export type E2ERuntimeStatus = z.infer<typeof E2ERuntimeStatusSchema>;
