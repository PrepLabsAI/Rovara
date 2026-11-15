// The CheckRunner port: external build and check results (GitHub Actions, CodeBuild, a customer's build system). Only this layer is new.
// The in-sandbox checks the worker runs itself (setup and test commands, measured before and after) are not part of it.
import { z } from "zod";
import { ChangeRequestRefSchema, CheckSchema, type Check } from "./code-host.js";
import { BranchNameSchema, ExternalIdSchema, ISO_TIME, PluginKindSchema, RepositoryRefSchema, RevisionSchema, type HostScope, type PluginKind, type ReadBudget, type RepositoryRef, type UntrustedText } from "./common.js";

export const CheckRunnerCapabilitiesSchema = z.object({
  /** `listChecks` answers for a change request. */
  listByChangeRequest: z.boolean(),
  /** `listChecks` answers for a bare revision. */
  listByRevision: z.boolean(),
  logTail: z.boolean(),
  /** `start` is offered (CodeBuild gates today). */
  start: z.boolean(),
  rerun: z.boolean(),
}).strict();
export type CheckRunnerCapabilities = z.infer<typeof CheckRunnerCapabilitiesSchema>;

/** One run the runner started or knows by id: which runner, and its own id. */
export const CheckRunRefSchema = z.object({ runner: PluginKindSchema, id: ExternalIdSchema }).strict();
export type CheckRunRef = z.infer<typeof CheckRunRefSchema>;

/** What a listing is asked about. */
export const CheckTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("change-request"), ref: ChangeRequestRefSchema }).strict(),
  z.object({ kind: z.literal("revision"), repository: RepositoryRefSchema, revision: RevisionSchema }).strict(),
  /** One run already known by id (a build the broker started). */
  z.object({ kind: z.literal("run"), repository: RepositoryRefSchema, revision: RevisionSchema, run: CheckRunRefSchema, gate: z.string().min(1).max(200), project: z.string().min(1).max(200).optional() }).strict(),
]);
export type CheckTarget = z.infer<typeof CheckTargetSchema>;

/** What `start` is asked to run: one named gate of a repository at one revision, once (the idempotency key makes a retry the same run). */
export const CheckStartRequestSchema = z.object({
  repository: RepositoryRefSchema,
  revision: RevisionSchema,
  gate: z.string().min(1).max(200),
  /** The runner's own project or pipeline name. */
  project: z.string().min(1).max(200),
  timeoutMinutes: z.number().int().min(1).max(480),
  idempotencyKey: z.string().min(1).max(200),
}).strict();
export type CheckStartRequest = z.infer<typeof CheckStartRequestSchema>;

/**
 * TE-E0 option A: what a runner knows about one run beyond its result: when it started and finished, which attempt it was (1 for the first run, 2 for a re-run: the evidence says "passed on run 2",
 * never a plain pass, and says nothing when the attempt is not known), and the run it belongs to (where its reports are). Every field is present only when the runner read it.
 */
export const CheckRunFactsSchema = z.object({
  startedAt: ISO_TIME.optional(),
  completedAt: ISO_TIME.optional(),
  attempt: z.number().int().min(1).max(1_000).optional(),
  workflowRunId: ExternalIdSchema.optional(),
}).strict();
export type CheckRunFacts = z.infer<typeof CheckRunFactsSchema>;

/** Where to look for a check's latest run: a commit (the base commit) or a branch's head (the main branch's latest run). */
export const CheckLookupSchema = z.union([z.object({ revision: RevisionSchema }).strict(), z.object({ branch: BranchNameSchema }).strict()]);
export type CheckLookup = z.infer<typeof CheckLookupSchema>;

/** The latest run of a named check, with the commit it ran on. */
export const LatestCheckSchema = z.object({ revision: RevisionSchema, check: CheckSchema }).strict();
export type LatestCheck = z.infer<typeof LatestCheckSchema>;

/** A check name a runner has seen reported, with the reporting app when there is one: what the setup screen lists for a customer to mark. */
export const SeenCheckSchema = z.object({ name: z.string().min(1).max(200), source: z.string().min(1).max(200).optional() }).strict();
export type SeenCheck = z.infer<typeof SeenCheckSchema>;

export interface CheckRunner {
  readonly kind: PluginKind;
  readonly capabilities: CheckRunnerCapabilities;
  /** The checks on a target. A runner that cannot list the kind of target it is given throws; it never answers an empty list for it. */
  listChecks(target: CheckTarget, scope: HostScope, budget?: ReadBudget): Promise<Check[]>;
  /** The tail of a run's log. Untrusted text: it reaches a model only inside a labelled block. Undefined when the log is gone. */
  logTail(target: CheckTarget, check: Check, scope: HostScope, budget?: ReadBudget): Promise<UntrustedText | undefined>;
  start?(request: CheckStartRequest, scope: HostScope): Promise<{ run: CheckRunRef; check: Check }>;
  /** Reads one started run again. */
  getRun?(target: Extract<CheckTarget, { kind: "run" }>, scope: HostScope): Promise<Check>;
  rerun?(target: CheckTarget, check: Check, scope: HostScope): Promise<void>;
  /** TE-E0 option A: the facts of one listed run (times, attempt). Undefined when the runner has none for it. */
  runFacts?(target: CheckTarget, check: Check, scope: HostScope, budget?: ReadBudget): Promise<CheckRunFacts | undefined>;
  /** TE-E0 option A: the latest run of a named check (and app, when `source` is given) at a commit or a branch's head. Undefined when there is none; a read that fails throws. */
  latestCheck?(repository: RepositoryRef, at: CheckLookup, check: { name: string; source?: string | undefined }, scope: HostScope, budget?: ReadBudget): Promise<LatestCheck | undefined>;
  /**
   * TE-E0 option B: the per-test report files of one workflow run (`CheckRunFacts.workflowRunId`): `none` when the run has none, `unreadable` when one could not be read whole. Report text only; never
   * logs or other artifacts.
   */
  reportFiles?(repository: RepositoryRef, workflowRunId: string, scope: HostScope, budget?: ReadBudget): Promise<{ kind: "read"; files: Array<{ name: string; text: string }> } | { kind: "none" } | { kind: "unreadable" }>;
  /** TE-E0 option A, setup: the check names seen on recent change requests, for a customer to mark. `complete` is false when part could not be read: the list is then not everything seen. */
  seenChecks?(repository: RepositoryRef, scope: HostScope, budget?: ReadBudget): Promise<{ checks: SeenCheck[]; complete: boolean }>;
}
