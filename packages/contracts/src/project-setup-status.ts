// Guided onboarding PR 8 (DEC 254j/254k/254l, design section 1 "Project setup checklist"): ONE project setup-status read for the resumable checklist, and the small
// per-project record of skipped optional rows. Browser-safe: it imports only zod.
//
//   GET /v1/dev/client/projects/{project}/setup-status          any member of the project's company (full access)
//   PUT /v1/dev/client/projects/{project}/setup-status/skips    a company owner or admin, or the project's administrator (full access)
//   PUT /v1/dev/client/projects/{project}/setup-status/eval-none  the same people: "no evals" for the latest finished setup run, or take it back (full access; L2-5 c)
//
// "Progress is read from the real state, not a saved wizard position": every row below is derived on each request from records Code already keeps (the project's revision, the setup
// run's pointer and task, the run's eval report, the company's and the project's settings, the project's channel bindings, the project's tasks). The only thing stored for the checklist is
// which OPTIONAL rows a person chose to skip. Nothing here carries a secret, a token, a raw error text or a model's words: the failure sentences are the broker's fixed ones.
import { z } from "zod";

/** The checklist's rows, in the order the screen shows them. */
export const SETUP_STATUS_ROWS = ["repos", "setupRun", "evalConfirm", "aiAndSpend", "slackChannel", "linear", "invites", "firstTask"] as const;
export type SetupStatusRow = (typeof SETUP_STATUS_ROWS)[number];

/** The rows a person may mark "Set up later" (DEC 254k). Skipped rows count toward 100%. */
export const SETUP_SKIPPABLE_ROWS = ["slackChannel", "linear", "invites"] as const;
export type SetupSkippableRow = (typeof SETUP_SKIPPABLE_ROWS)[number];

/** done: complete. needs_you: a person must act. running: Rovara is working. optional: not set up, and not required. skipped: an optional row set aside. failed: it ran and did not work. */
export const SETUP_ROW_STATES = ["done", "needs_you", "running", "optional", "skipped", "failed"] as const;
export type SetupRowState = (typeof SETUP_ROW_STATES)[number];
const State = z.enum(SETUP_ROW_STATES);

/**
 * L4-T2 (setup review D1, G1): where the project's setup stands in the approval, which is what makes the "Setup run" row done.
 * none: no setup of Rovara's has been turned into a candidate (no run yet, a run still going, a proposal nobody has used, or one a person rejected or discarded).
 * candidate: a setup was made into a candidate revision and waits for a person's decision (its check is ready, or it failed or went stale: `check` says which).
 * checking: that candidate's check is running on a fresh machine.
 * approved: a person approved a candidate revision. The row is done only when its check is also ready. A newer proposal (a re-run's) never takes it away: the approved setup is what tasks use until another is approved (`newerProposal`).
 */
export const SETUP_APPROVALS = ["none", "candidate", "checking", "approved"] as const;
export type SetupApproval = (typeof SETUP_APPROVALS)[number];
/** L4-T2b: with `approval: "approved"`, a newer proposal that has not replaced it. needs_you: it waits for a person (a run's proposal nobody used, or a candidate waiting for its decision). checking: its check is running. rejected: it was rejected or discarded. */
export const SETUP_NEWER_PROPOSALS = ["needs_you", "checking", "rejected"] as const;
/** The status of a setup check, as the project's setup state words it (`setupStateOf`). */
export const SETUP_CHECK_STATUSES = ["unchecked", "outdated", "checking", "failed", "ready"] as const;

/**
 * DEC 254zc(1): what GitHub's signed webhooks said about a repository since the project was set up. transferred: it moved to another owner (`repository` transferred). removed: it left the
 * GitHub App's repository list (`installation_repositories` removed; a transfer out looks the same, so the word stays "removed" unless GitHub said "transferred"). Absent: GitHub said nothing.
 */
export const REPOSITORY_ACCESS_STATES = ["transferred", "removed"] as const;
export type RepositoryAccessState = (typeof REPOSITORY_ACCESS_STATES)[number];

const Channel = z.object({ channelId: z.string().min(1).max(64), name: z.string().min(1).max(200).optional(), isPrivate: z.boolean().optional() }).passthrough();

/**
 * `GET .../setup-status`. Unknown fields are allowed (a newer server may add some); every field named here is fixed.
 * Rows with no Code state yet (linear, invites) are `optional`/`skipped` only; `linear.team` is the seam PR #838 (Linear OAuth team picks) fills.
 */
export const ProjectSetupChecklistSchema = z.object({
  project: z.string().min(1).max(128),
  /** What the caller may do here, from live records: `canSkip` is true for a company owner or admin and for the project's administrator. */
  viewer: z.object({ companyRole: z.enum(["owner", "admin", "member"]).nullable(), projectAdmin: z.boolean(), canSkip: z.boolean() }).passthrough(),
  /** `percent` counts done and skipped rows. `nextRequired` is the first required row (repos, setupRun, evalConfirm, aiAndSpend, firstTask) that is not done, else null. */
  progress: z.object({ done: z.number().int().min(0), total: z.number().int().min(1), percent: z.number().int().min(0).max(100), nextRequired: z.enum(SETUP_STATUS_ROWS).nullable() }).passthrough(),
  repos: z.object({
    state: State, count: z.number().int().min(0),
    items: z.array(z.object({ name: z.string().min(1).max(128), fullName: z.string().min(1).max(256).optional(), defaultBranch: z.string().min(1).max(256), access: z.enum(REPOSITORY_ACCESS_STATES).optional() }).passthrough()).max(32),
  }).passthrough(),
  setupRun: z.object({
    state: State,
    /** The run's own status: none (no run yet), running, ready (it ended with a proposal) or failed. A `ready` run that stopped at a limit (`partial`) is shown as failed. */
    status: z.enum(["none", "running", "ready", "failed"]),
    startedAt: z.string().max(40).optional(),
    elapsedMs: z.number().int().min(0).optional(),
    costCents: z.number().int().min(0).optional(),
    commandsRun: z.number().int().min(0).optional(),
    /** The setup and test commands the run found (the proposal's), counted. */
    commandsFound: z.object({ setup: z.number().int().min(0), tests: z.number().int().min(0) }).passthrough().optional(),
    /** `passed` only when a proposed test command is the run's own journal entry and it exited 0; `failed` when such an entry did not; else `unknown`. */
    testOutcome: z.enum(["passed", "failed", "unknown"]).optional(),
    partial: z.boolean().optional(),
    stop: z.string().max(60).optional(),
    /** The broker's fixed sentence (never a log line or a model's words). */
    failure: z.string().max(1_000).optional(),
    /**
     * L4-T2: the approval (see SETUP_APPROVALS). The row is `done` only with `approval: "approved"` and a `ready` check; a proposal nobody has used, a candidate waiting for a decision and a failed check are `needs_you`
     * (the check's own words are in `check.failedStep`); a check going on a fresh machine is `running`.
     */
    approval: z.enum(SETUP_APPROVALS),
    /** The check of the waiting candidate, or of the approved revision (absent with `approval: "none"`). `failedStep` is the broker's one-line, redacted, bounded failing step. */
    check: z.object({ status: z.enum(SETUP_CHECK_STATUSES), failedStep: z.string().max(300).optional() }).passthrough().optional(),
    /** With `approval: "approved"`: when the person approved it. */
    approvedAt: z.string().max(40).optional(),
    /** L4-T2b: with `approval: "approved"`, a newer proposal that waits or was rejected (see SETUP_NEWER_PROPOSALS). The row's state follows the approved setup's own check, not this. Absent: none. */
    newerProposal: z.enum(SETUP_NEWER_PROPOSALS).optional(),
    /** The command that failed and the last lines of its (redacted, bounded) output, as the run's journal shows them. Only on a failed run that kept a journal. */
    failedCommand: z.object({ n: z.number().int().min(1), command: z.string().max(2_000), exitCode: z.number().int().nullable(), timedOut: z.boolean(), lastLines: z.array(z.string().max(300)).max(20) }).passthrough().optional(),
  }).passthrough(),
  evalConfirm: z.object({
    state: State,
    /** none: the latest run reported no eval; reported: waiting for a person; confirmed; no_evals: a person confirmed the project runs no evals, for the latest finished setup run (done). */
    report: z.enum(["none", "reported", "confirmed", "no_evals"]),
    /** Set while the setup run is not done: the row cannot be acted on yet. */
    blockedBy: z.literal("setupRun").optional(),
    suites: z.array(z.object({ selection: z.string().max(512), questions: z.number().int().min(0) }).passthrough()).max(4).optional(),
    confirmedSelection: z.string().max(512).optional(),
    /** Set with report `no_evals`: when the person confirmed it (who is in the company log). */
    noEvals: z.object({ confirmedAt: z.string().max(40) }).passthrough().optional(),
  }).passthrough(),
  aiAndSpend: z.object({
    state: State,
    /** project: the project saved its own limit; company: the company saved a model choice; default: nothing is saved, so the install's defaults apply (they are prefilled, so the row is done). */
    source: z.enum(["project", "company", "default"]),
    companyModelSaved: z.boolean(),
    /** The project's own per-task model budget in dollars, when it saved one. */
    modelBudgetUsd: z.number().min(0).nullable(),
    /**
     * L4-T2 (G6): whether the company can run a model call. `none`: it cannot (the row is `needs_you`: connect an AI key or choose Rovara's AI). `possible`: it can. `unknown`: the gateway could not say (the row is not
     * blocked on a guess). Absent: this install has no gateway to ask (the install's own model setup applies).
     */
    modelCall: z.enum(["possible", "none", "unknown"]).optional(),
  }).passthrough(),
  slackChannel: z.object({ state: State, channels: z.array(Channel).max(32) }).passthrough(),
  linear: z.object({ state: State, team: z.object({ id: z.string().min(1).max(100), name: z.string().min(1).max(200).optional() }).passthrough().nullable() }).passthrough(),
  invites: z.object({ state: State }).passthrough(),
  firstTask: z.object({ state: State, hasTask: z.boolean(), canStart: z.boolean() }).passthrough(),
}).passthrough();
export type ProjectSetupChecklist = z.infer<typeof ProjectSetupChecklistSchema>;

/** `PUT .../setup-status/skips`: strict; a row that is not skippable, or a missing flag, is refused. */
export const ProjectSetupSkipBodySchema = z.object({ row: z.enum(SETUP_SKIPPABLE_ROWS), skipped: z.boolean() }).strict();
export type ProjectSetupSkipBody = z.infer<typeof ProjectSetupSkipBodySchema>;

/** The answer of the skip PUT: the row, its new flag (a repeat answers the same, writes nothing) and every skipped row now. */
export const ProjectSetupSkipResponseSchema = z.object({
  project: z.string().min(1).max(128), row: z.enum(SETUP_SKIPPABLE_ROWS), skipped: z.boolean(), skippedRows: z.array(z.enum(SETUP_SKIPPABLE_ROWS)).max(SETUP_SKIPPABLE_ROWS.length),
}).passthrough();
export type ProjectSetupSkipResponse = z.infer<typeof ProjectSetupSkipResponseSchema>;

/** `PUT .../setup-status/eval-none` (L2-5 c): strict. `true` confirms that the project runs no evals for its latest finished setup run; `false` takes that back. `viewer.canSkip` says who may. */
export const ProjectSetupEvalNoneBodySchema = z.object({ noEvals: z.boolean() }).strict();
export type ProjectSetupEvalNoneBody = z.infer<typeof ProjectSetupEvalNoneBodySchema>;

/** Its answer: the flag now and the setup run it is bound to (null when taken back). A repeat answers the same and writes nothing. */
export const ProjectSetupEvalNoneResponseSchema = z.object({ project: z.string().min(1).max(128), noEvals: z.boolean(), taskId: z.string().min(1).max(160).nullable() }).passthrough();
export type ProjectSetupEvalNoneResponse = z.infer<typeof ProjectSetupEvalNoneResponseSchema>;
