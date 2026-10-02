// Issue #218: the admin sign-in lasts an hour and is never refreshed (Q4). One that expired says
// so, and when, with the exact command; one about to expire says so a few minutes before. The CLI
// and the MCP server share these words.
import { ToolError } from "./errors.js";

/** How long before the admin sign-in expires the tools start to say so. */
export const ADMIN_EXPIRY_WARNING_MS = 5 * 60_000;

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
export const adminSignInCommand = (env: string): string => `agentx --env ${env} login --admin`;

/** The admin sign-in for `env` has expired: when, and what to run. */
export function adminSignInExpiredText(env: string, expiresAt: number, now: number): string {
  return `Your admin sign-in for ${env} expired at ${localClockTime(expiresAt, now)}. Run ${adminSignInCommand(env)}.`;
}

/** The admin sign-in for `env` expires soon: when, and what to run. */
export function adminSignInExpiringText(env: string, expiresAt: number, now: number): string {
  return `Your admin sign-in for ${env} expires at ${localClockTime(expiresAt, now)}; run ${adminSignInCommand(env)} to sign in again.`;
}

/** ADMIN_REQUIRED for an admin sign-in that expired, with its time and the exact command. */
export function adminSignInExpiredError(env: string, expiresAt: number, now: number): ToolError {
  return new ToolError("ADMIN_REQUIRED", `Your admin sign-in for ${env} expired at ${localClockTime(expiresAt, now)}`, `run ${adminSignInCommand(env)}`);
}

/**
 * What a tool result says about the stored admin sign-in: that it expired, or that it expires
 * within ADMIN_EXPIRY_WARNING_MS; undefined while it is further off, or when none is stored.
 */
export function adminSignInNotice(stored: { env: string; expiresAt: number } | undefined, now: number): string | undefined {
  if (stored === undefined) return undefined;
  if (stored.expiresAt <= now) return adminSignInExpiredText(stored.env, stored.expiresAt, now);
  if (stored.expiresAt - now <= ADMIN_EXPIRY_WARNING_MS) return adminSignInExpiringText(stored.env, stored.expiresAt, now);
  return undefined;
}
