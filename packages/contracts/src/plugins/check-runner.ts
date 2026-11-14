// The CheckRunner port: external build and check results (GitHub Actions, CodeBuild, a customer's build system). Only this layer is new.
// The in-sandbox checks the worker runs itself (setup and test commands, measured before and after) are not part of it.
import { z } from "zod";
import { ChangeRequestRefSchema, type Check } from "./code-host.js";
import { ExternalIdSchema, PluginKindSchema, RepositoryRefSchema, RevisionSchema, type HostScope, type PluginKind, type ReadBudget, type UntrustedText } from "./common.js";

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
}
