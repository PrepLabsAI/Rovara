// System-started runs (lead 4 L4-P1; owner DEC 254zzl; design designs-2026-11-17/system-started-runs.md). One closed list of what a project's system owner ("Rovara (project: X)", system-owner.ts) may start, and the
// words and numbers every part of the hosted system starter shares. The system owner never starts a task request or free text: it starts one of FOUR fixed kinds, each built by Rovara from stored facts.
//
//   setup_check    free   a project's existing setup check on a fresh machine (the re-check at task start, or the night's)
//   nightly_check  free   a night's check of a project whose upkeep is ON: the same setup check, started by the night
//   repair_draft   AI     (P2) a setup-agent run drafting a fix after a check ended "setup broken"
//   wiki_refresh   AI     (P2) a refresh of the stale wiki pages
//
// P1 starts only the two FREE kinds. The AI kinds are named here so the access rule and the origin stamp are written once; the starter refuses them until P2 turns them on.
import { createHash } from "node:crypto";
import { z } from "zod";
import { AGENTX_NAME_PATTERN } from "./names.js";
import { UPKEEP_ORIGIN } from "./upkeep.js";
import type { AutomaticJob } from "./system-owner.js";

export const SYSTEM_RUN_KINDS = ["setup_check", "nightly_check", "repair_draft", "wiki_refresh"] as const;
export const SystemRunKindSchema = z.enum(SYSTEM_RUN_KINDS);
export type SystemRunKind = z.infer<typeof SystemRunKindSchema>;

/** The kinds that spend no AI: no model key, no model token. The only kinds P1 starts. */
export const SYSTEM_RUN_FREE_KINDS = ["setup_check", "nightly_check"] as const satisfies readonly SystemRunKind[];
export type FreeSystemRunKind = (typeof SYSTEM_RUN_FREE_KINDS)[number];
/** The kinds that spend the customer's AI under the upkeep cap (P2). */
export const SYSTEM_RUN_AI_KINDS = ["repair_draft", "wiki_refresh"] as const satisfies readonly SystemRunKind[];

/** Whether a value (anything at all) is one of the four kinds. A string that merely looks like one, or any other type, is not. */
export const isSystemRunKind = (value: unknown): value is SystemRunKind => typeof value === "string" && (SYSTEM_RUN_KINDS as readonly string[]).includes(value);
/** Whether a value is a kind that spends no AI. */
export const isFreeSystemRunKind = (value: unknown): value is FreeSystemRunKind => typeof value === "string" && (SYSTEM_RUN_FREE_KINDS as readonly string[]).includes(value);

/**
 * The work origin a kind's run carries. Every AI kind carries `nightly` (`UPKEEP_ORIGIN`): it is what makes the gateway hold the call to the project's upkeep cap (Cloud #125 reads the token's `src`). A free kind
 * spends no AI and carries `automatic`, which the gateway does not cap because it never sees a call.
 */
export function systemRunOrigin(kind: SystemRunKind): typeof UPKEEP_ORIGIN | "automatic" {
  return (SYSTEM_RUN_AI_KINDS as readonly string[]).includes(kind) ? UPKEEP_ORIGIN : "automatic";
}

/** The automatic job a FREE kind is counted under (the project's monthly count of automatic runs, system-owner.ts). */
export const SYSTEM_RUN_JOB: Readonly<Record<FreeSystemRunKind, AutomaticJob>> = { setup_check: "scheduled_check", nightly_check: "nightly" };

/** The kinds as a person reads them (the run's sentence, the history list, the audit log). */
export const SYSTEM_RUN_KIND_WORDS: Readonly<Record<SystemRunKind, string>> = { setup_check: "setup check", nightly_check: "nightly check", repair_draft: "repair draft", wiki_refresh: "wiki refresh" };

/** Why Rovara started a run: a fixed code, so a reader never meets free text. */
export const SYSTEM_RUN_REASONS = ["task_start", "nightly", "check_failed"] as const;
export const SystemRunReasonCodeSchema = z.enum(SYSTEM_RUN_REASONS);
export type SystemRunReasonCode = z.infer<typeof SystemRunReasonCodeSchema>;
export const SYSTEM_RUN_REASON_WORDS: Readonly<Record<SystemRunReasonCode, string>> = {
  task_start: "a task started on code whose setup files changed", nightly: "it is the project's night for upkeep", check_failed: "the project's setup check ended broken",
};
/** The reason of one start: a fixed code and at most one short fact (a file name or a class of change). Strict, so a field nobody planned for is refused. */
export const SystemRunReasonSchema = z.object({ code: SystemRunReasonCodeSchema, fact: z.string().regex(/^[A-Za-z0-9._/@+-]{1,100}$/u).optional() }).strict();
export type SystemRunReason = z.infer<typeof SystemRunReasonSchema>;

/** The audit actions of a system start. The actor is the project's system owner. */
export const SYSTEM_RUN_AUDIT = { started: "system_run.started" } as const;

/** Why a start did not happen (fixed words; nothing from a repository or a request is echoed). */
export const SYSTEM_RUN_REFUSALS = ["kind_not_allowed", "system_runs_off", "upkeep_off", "project_unavailable", "invalid_request", "audit_unavailable"] as const;
export type SystemRunRefusal = (typeof SYSTEM_RUN_REFUSALS)[number];

// ---- the install flag

/**
 * The per-company flag of system runs: `off` (the default), `on` (every company the core serves) or `on:<company id>[:<company id>]`, the shape the core switch reads. The stack parameter `CoreSystemRuns` sets
 * the variable. It is SEPARATE from the hidden Automation feature (triggers, chains, custom agents), which stays off on hosted: this flag opens only the four fixed kinds.
 */
export const SYSTEM_RUNS_VARIABLE = "ROVARA_CORE_SYSTEM_RUNS";
export const SYSTEM_RUNS_PARAMETER = "CoreSystemRuns";
export const SYSTEM_RUNS_PARAMETER_PATTERN = "^(off|on|on:org_[0-9a-z]{20}(:org_[0-9a-z]{20})?)$";
export const SYSTEM_RUNS_DEFAULT = "off";

// ---- the night

/** The core job that fires hourly and starts each project that is due (core-host/jobs.ts, CORE_JOB_SCHEDULES). */
export const UPKEEP_NIGHT_JOB = "upkeep-night" as const;
/** The night window, UTC (owner DEC 254zzl 6): each project's hour is inside it. */
export const UPKEEP_NIGHT_WINDOW = { startHourUtc: 7, endHourUtc: 11 } as const;

/** The hour (UTC, inside the window) a project's night starts: a hash of company and project, so it is stable, spread out and needs no stored schedule. */
export function upkeepHourOf(orgId: string, project: string): number {
  if (!AGENTX_NAME_PATTERN.test(project)) throw new Error("not a project name");
  const span = UPKEEP_NIGHT_WINDOW.endHourUtc - UPKEEP_NIGHT_WINDOW.startHourUtc;
  const digest = createHash("sha256").update("rovara-upkeep-hour\0").update(orgId).update("\0").update(project).digest();
  return UPKEEP_NIGHT_WINDOW.startHourUtc + (digest.readUInt32BE(0) % span);
}

/** Whether a project's night is due at this moment: inside the window, and at or after the project's own hour. (Once per day is the pass's own claim.) */
export function upkeepNightDue(orgId: string, project: string, nowMs: number): boolean {
  const hour = new Date(nowMs).getUTCHours();
  return hour >= upkeepHourOf(orgId, project) && hour < UPKEEP_NIGHT_WINDOW.endHourUtc;
}

// ---- machine time attribution (owner DEC 254zzl 4: the COMPANY pays machine time for system runs)

/** One system run's machine time, attributed to the company and project that pay for it. The minutes are measured from the run's own workspace, not stated by the caller. */
export const SystemRunUsageSchema = z.object({
  orgId: z.string().min(1), project: z.string().regex(AGENTX_NAME_PATTERN), kind: SystemRunKindSchema, workspaceId: z.string().min(1), requestId: z.string().min(1),
  month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u), startedAt: z.string(),
}).strict();
export type SystemRunUsage = z.infer<typeof SystemRunUsageSchema>;
