// Issue #218: the admin sign-in lasts an hour and is never refreshed (Q4). One that expired says
// so, and when, with the exact command; one about to expire says so a few minutes before. The CLI
// and the MCP server share these words.
//
// This package never decides whether to show that command as `agentx ...` or as
// `npx @charterarc/agentx@<version> ...` (that depends on the running CLI process, which only
// packages/cli can see: owner decision 2026-10-02). Every caller here passes a `CommandLineFormatter`
// that already knows the answer.
import { ToolError } from "./errors.js";

/** How long before the admin sign-in expires the tools start to say so. */
export const ADMIN_EXPIRY_WARNING_MS = 5 * 60_000;

/** Turns `login --admin`-style arguments into the exact command line this computer's caller should run. */
export type CommandLineFormatter = (args: string) => string;

const pad = (value: number) => String(value).padStart(2, "0");

/** `ms` as this computer's local time: "12:31" on the same local day as `now`, else "2026-09-30 09:05". */
export function localClockTime(ms: number, now: number): string {
  const at = new Date(ms);
  const today = new Date(now);
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const sameDay = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate();
  return sameDay ? clock : `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clock}`;
}

/** The command that signs this computer in as an admin of `env` again. */
export const adminSignInCommand = (env: string, commandFor: CommandLineFormatter): string => commandFor(`--env ${env} login --admin`);

/** The admin sign-in for `env` has expired: when, and what to run. */
export function adminSignInExpiredText(env: string, expiresAt: number, now: number, commandFor: CommandLineFormatter): string {
  return `Your admin sign-in for ${env} expired at ${localClockTime(expiresAt, now)}. Run ${adminSignInCommand(env, commandFor)}.`;
}

/** The admin sign-in for `env` expires soon: when, and what to run. */
export function adminSignInExpiringText(env: string, expiresAt: number, now: number, commandFor: CommandLineFormatter): string {
  return `Your admin sign-in for ${env} expires at ${localClockTime(expiresAt, now)}; run ${adminSignInCommand(env, commandFor)} to sign in again.`;
}

/** True for adminSignInNotice's text when the sign-in has expired, not merely about to. */
export function isExpiredNotice(notice: string | undefined): boolean {
  return notice !== undefined && notice.startsWith("Your admin sign-in for ") && / expired at /.test(notice);
}

/** ADMIN_REQUIRED for an admin sign-in that expired, with its time and the exact command. */
export function adminSignInExpiredError(env: string, expiresAt: number, now: number, commandFor: CommandLineFormatter): ToolError {
  return new ToolError("ADMIN_REQUIRED", `Your admin sign-in for ${env} expired at ${localClockTime(expiresAt, now)}`, `run ${adminSignInCommand(env, commandFor)}`);
}

/**
 * What a tool result says about the stored admin sign-in: that it expired, or that it expires
 * within ADMIN_EXPIRY_WARNING_MS; undefined while it is further off, or when none is stored.
 */
export function adminSignInNotice(stored: { env: string; expiresAt: number } | undefined, now: number, commandFor: CommandLineFormatter): string | undefined {
  if (stored === undefined) return undefined;
  if (stored.expiresAt <= now) return adminSignInExpiredText(stored.env, stored.expiresAt, now, commandFor);
  if (stored.expiresAt - now <= ADMIN_EXPIRY_WARNING_MS) return adminSignInExpiringText(stored.env, stored.expiresAt, now, commandFor);
  return undefined;
}
