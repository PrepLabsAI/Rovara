// The system owner of automatic runs (owner decision 2026-11-02). Each project has ONE non-person owner, "Rovara (project: X)", used only for automatic jobs: the nightly run, a saved image's rebuild, a scheduled
// check. It is NOT a developer: its id has a shape no developer id has, so every place that takes a developer id from a stored row, a token or a request refuses it (a developer id is 64 hex characters), and the
// places that take an id from a task row read it with `isSystemOwnerId` first. It signs in nowhere, holds no personal task slot, no model key and no standing in any person-facing route.
import { createHash } from "node:crypto";
import { z } from "zod";

/** What a system owner's id starts with. A developer's id never does (it is 64 hex characters). */
export const SYSTEM_OWNER_ID_PREFIX = "sysowner_" as const;
export const SystemOwnerIdSchema = z.string().regex(/^sysowner_[a-f0-9]{64}$/u);

/** The system owner of one project in one company: derived, so there is nothing to create, store or look up, and two projects never share one. */
export function systemOwnerIdOf(orgId: string, project: string): string {
  return `${SYSTEM_OWNER_ID_PREFIX}${createHash("sha256").update("rovara-system-owner\0").update(orgId).update("\0").update(project).digest("hex")}`;
}

/** Whether an id is a system owner's. Anything that is not a string is not. */
export const isSystemOwnerId = (id: unknown): id is `${typeof SYSTEM_OWNER_ID_PREFIX}${string}` => SystemOwnerIdSchema.safeParse(id).success;

/** How the system owner is named wherever a name is shown. */
export const systemOwnerName = (project: string): string => `Rovara (project: ${project})`;

/** The sign-in method a system owner's task record carries: no person signs in this way, and no sign-in record can have it (`DeveloperSignInMethodSchema` does not list it). */
export const SYSTEM_OWNER_PROVIDER = "system" as const;
/** The session id of a system owner's start: no browser or token session ever has it. */
export const SYSTEM_OWNER_SESSION_ID = "system-owner" as const;

/** The jobs that run as a system owner. Each is an automatic job nobody started at a keyboard. */
export const AUTOMATIC_JOBS = ["nightly", "image_rebuild", "scheduled_check"] as const;
export const AutomaticJobSchema = z.enum(AUTOMATIC_JOBS);
export type AutomaticJob = z.infer<typeof AutomaticJobSchema>;

/** The job as a person reads it, in "Started by Rovara (nightly)". */
export const AUTOMATIC_JOB_WORDS: Readonly<Record<AutomaticJob, string>> = { nightly: "nightly", image_rebuild: "image rebuild", scheduled_check: "scheduled check" };
export const startedByAutomaticWords = (job: AutomaticJob): string => `Started by Rovara (${AUTOMATIC_JOB_WORDS[job]})`;
/** The audit actor text of an automatic job: "automatic: nightly". */
export const automaticAuditActor = (job: AutomaticJob): string => `automatic: ${job}`;

/**
 * What an automatic run is FOR. Every system start declares one, and it is a model-free purpose: an automatic run is given no model key, so a start that could become a model-using workflow is refused.
 * `nightly_run`: the nightly test run (a verification-mode operation with its own payload; needs `nightlyRun`). `saved_env_rebuild`: a saved image's rebuild, which prepares the workspace and queues no model prompt (the
 * saved-environments lane adds what runs after the preparation, on its own operation).
 */
export const AUTOMATIC_RUN_PURPOSES = ["nightly_run", "saved_env_rebuild"] as const;
export const AutomaticRunPurposeSchema = z.enum(AUTOMATIC_RUN_PURPOSES);
export type AutomaticRunPurpose = z.infer<typeof AutomaticRunPurposeSchema>;

/** What a system-owned task keeps of why it exists: the job, its model-free purpose, and the person who approved the setup it runs (a setup approval is a person's; the run is not). */
export const AutomaticRunMarkSchema = z.object({ job: AutomaticJobSchema, purpose: AutomaticRunPurposeSchema, approvedBy: z.string().min(1).max(200).optional() }).strict();
export type AutomaticRunMark = z.infer<typeof AutomaticRunMarkSchema>;

/** How many automatic runs of one project may hold a workspace at once (the project's own limit; no personal slot is used). */
export const AUTOMATIC_RUNS_AT_ONCE = 1;
/** The default monthly cap on automatic runs of a project: a night a day, each with its one same-day retry, and room for image rebuilds and checks. A maintainer can change it. */
export const DEFAULT_AUTOMATIC_RUNS_PER_MONTH = 100;
export const MAX_AUTOMATIC_RUNS_PER_MONTH = 2000;
/** How long an automatic run may hold the project's one automatic slot: past it, the session sweep ends the run, gives the slot back and audits it (the nightly's own limit is 90 minutes, with room). */
export const AUTOMATIC_RUN_MAX_MS = 2 * 60 * 60_000;
/** Why Rovara ended an automatic run itself: its project or company stopped standing, or it ran past `AUTOMATIC_RUN_MAX_MS`. */
export const AUTOMATIC_RUN_END_REASONS = ["project_stopped", "too_old"] as const;
export type AutomaticRunEndReason = (typeof AUTOMATIC_RUN_END_REASONS)[number];
