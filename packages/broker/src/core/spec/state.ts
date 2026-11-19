// One task's spec, as the broker keeps it. The state decides what the code pull request does: open together with a link to the spec pull request, wait for a person to approve the spec first
// (`spec_first`), or be HELD when the spec could not be written or published. Everything here is a pure function of the state; the writes that store it are conditional on its revision (specStateItem), so two
// writers cannot both move it.
import { SpecFileSchema, SpecTargetSchema, canonicalJson, type SpecFile, type SpecKind, type SpecTarget } from "@agentx/contracts";
import { createHash } from "node:crypto";
import { z } from "zod";

export const SPEC_STATE_SK = "SPEC#STATE";
export const SPEC_STATUSES = ["due", "writing", "written", "published", "failed", "skipped"] as const;
export type SpecStatus = (typeof SPEC_STATUSES)[number];

/** Fixed reasons a spec stops. Never model text, never a git or GitHub message. */
export const SPEC_FAILURES = {
  write_failed: "Rovara could not write the spec from the approved plan.",
  unreadable: "The spec Rovara wrote could not be read.",
  plan_changed: "The approved plan changed while the spec was being written.",
  render_failed: "Rovara could not lay the spec out in the team's format.",
  template_missing: "Rovara could not read the team's spec template.",
  publish_failed: "Rovara could not open the spec pull request.",
  worker_outdated: "The machine that runs Rovara is out of date and cannot write specs yet.",
  unsupported: "The project's spec format is not one Rovara has.",
  spec_closed: "The spec pull request was closed without being merged.",
} as const;
export type SpecFailureCode = keyof typeof SPEC_FAILURES;
/** Failures a second try can mend. The others need a different plan, format or template, so the owner's choices are to change that or to continue without the spec. */
const RETRYABLE: ReadonlySet<SpecFailureCode> = new Set<SpecFailureCode>(["write_failed", "unreadable", "render_failed", "publish_failed", "worker_outdated", "spec_closed"]);

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const Commit = z.string().regex(/^[a-f0-9]{40}$/u);

export const SpecPullRequestSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url().max(500),
  repositoryUrl: z.string().url().max(500),
  headBranch: z.string().regex(/^agentx\/[0-9a-f-]{36}$/iu),
  /** The spec commit the review reads: the head Rovara pushed, or the head a person's edit was kept at. */
  commit: Commit,
}).strict();
export type SpecPullRequest = z.infer<typeof SpecPullRequestSchema>;

export const SpecStateSchema = z.object({
  pk: z.string(),
  sk: z.literal(SPEC_STATE_SK),
  entityType: z.literal("SPEC_STATE"),
  revision: z.number().int().positive(),
  taskId: z.string().uuid(),
  planDigest: Sha256,
  kind: z.enum(["feature", "bugfix"]),
  /** The target as it was when the plan was approved: a later settings change does not move a task already underway. */
  target: SpecTargetSchema,
  /** The meta repo commit the spec is built on and the template is read at: the task's `knowledgeCommit`. */
  knowledgeCommit: Commit,
  status: z.enum(SPEC_STATUSES),
  attempt: z.number().int().min(0).max(5),
  writeOperationId: z.string().uuid().optional(),
  title: z.string().max(200).optional(),
  /** The rendered files, kept between the write and the publish so a retry of the publish writes exactly them. */
  files: z.array(SpecFileSchema).max(12).optional(),
  filesDigest: Sha256.optional(),
  /** The requirement labels the files hold when published (the review's list is read again from the commit). */
  requirementCount: z.number().int().min(0).max(200).optional(),
  specPullRequest: SpecPullRequestSchema.optional(),
  approvedAt: z.string().optional(),
  approvedBy: z.string().max(200).optional(),
  failure: z.object({ code: z.enum(Object.keys(SPEC_FAILURES) as [SpecFailureCode, ...SpecFailureCode[]]), at: z.string() }).strict().optional(),
  continuedWithoutSpec: z.object({ by: z.string().max(200), at: z.string() }).strict().optional(),
  /** How many times in a row a step could not be tried because GitHub (or the broker's own store) failed in a way that may pass; the step waits until `retryAfter`, and fails after SPEC_TRANSIENT_MAX. */
  transient: z.number().int().min(0).max(20).optional(),
  retryAfter: z.string().optional(),
  /** A person changed the spec pull request: the owner is asked "re-plan or keep?" (D4). */
  editPrompt: z.object({ headSha: Commit, at: z.string(), status: z.enum(["open", "kept", "replan"]), by: z.string().max(200).optional() }).strict().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();
export type SpecState = z.infer<typeof SpecStateSchema>;

export function specStateKey(taskId: string): { pk: string; sk: string } {
  return { pk: `DEVTASK#${taskId}`, sk: SPEC_STATE_SK };
}

/** The index row that lets a GitHub event on the spec pull request find its task: `owner/name` of the meta repository (lower case) and the number. */
export function specPullRequestKey(repositoryFullName: string, number: number): { pk: string; sk: string } {
  return { pk: `SPECPR#${repositoryFullName.toLowerCase()}#${String(number)}`, sk: "META" };
}

/** Failures that may pass (GitHub 5xx or 429, a network error, the store) before a step gives up and the owner chooses. */
export const SPEC_TRANSIENT_MAX = 6;
/** The wait after the n-th such failure: 30 seconds, doubling, at most 15 minutes. */
export function transientWaitMs(count: number): number {
  return Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, count - 1));
}

/** The most write attempts (plus publish retries) one task's spec gets, so a person pressing Retry cannot loop a paid run. */
export const SPEC_ATTEMPTS_MAX = 3;

export function newSpecState(input: { taskId: string; planDigest: string; kind: SpecKind; target: SpecTarget; knowledgeCommit: string; now: string }): SpecState {
  return SpecStateSchema.parse({
    ...specStateKey(input.taskId), entityType: "SPEC_STATE", revision: 1, taskId: input.taskId, planDigest: input.planDigest, kind: input.kind, target: input.target,
    knowledgeCommit: input.knowledgeCommit, status: "due", attempt: 0, createdAt: input.now, updatedAt: input.now,
  });
}

/** The next state: `change` applied (a key set to undefined is removed), the revision moved on, and the whole thing parsed again, so a transition can never store a shape the schema refuses. */
const touch = (state: SpecState, now: string, change: { [Key in keyof SpecState]?: SpecState[Key] | undefined }): SpecState => {
  const next: Record<string, unknown> = { ...state, ...change, revision: state.revision + 1, updatedAt: now };
  for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
  return SpecStateSchema.parse(next);
};

// ---------------------------------------------------------------------------------------------------------------------
// What the code pull request does.
// ---------------------------------------------------------------------------------------------------------------------

export type SpecHoldReason = "writing" | "publishing" | "waiting_approval" | "failed" | "edited";
export type SpecGate =
  | { action: "proceed"; link?: SpecPullRequest }
  | { action: "start_write" }
  | { action: "start_publish" }
  | { action: "hold"; reason: SpecHoldReason; message: string; ownerActions: Array<"retry" | "continue_without_spec" | "keep" | "replan"> };

/**
 * What the code pull request does given the spec state. Fail closed: a state that cannot be read is a hold, never a proceed; only "no spec due", "continued without the spec by a person" and "published (and approved,
 * when the target waits for it)" proceed.
 */
export function specGate(state: SpecState | undefined, corrupt = false, now: string | undefined = undefined): SpecGate {
  if (corrupt) return { action: "hold", reason: "failed", message: "The spec's record could not be read.", ownerActions: ["continue_without_spec"] };
  if (state === undefined || state.status === "skipped" || state.continuedWithoutSpec !== undefined) return { action: "proceed" };
  // A step that GitHub (or the store) could not do yet waits out its back-off; the owner can still go on without the spec.
  const waiting = now !== undefined && state.retryAfter !== undefined && Date.parse(state.retryAfter) > Date.parse(now);
  if (waiting && state.status === "written") return { action: "hold", reason: "publishing", message: "Rovara is opening the spec pull request; GitHub could not be reached just now, so it will try again shortly.", ownerActions: ["continue_without_spec"] };
  if (waiting && state.status === "due") return { action: "hold", reason: "writing", message: "Rovara will start writing the spec shortly; the last try did not work.", ownerActions: ["continue_without_spec"] };
  if (state.status === "due") return { action: "start_write" };
  if (state.status === "written") return { action: "start_publish" };
  if (state.status === "writing") return { action: "hold", reason: "writing", message: "Rovara is writing the spec from the approved plan.", ownerActions: ["continue_without_spec"] };
  if (state.status === "failed") {
    const reason = state.failure === undefined ? "The spec could not be made." : SPEC_FAILURES[state.failure.code];
    return { action: "hold", reason: "failed", message: `Spec pull request failed: ${reason}`, ownerActions: state.attempt < SPEC_ATTEMPTS_MAX && (state.failure === undefined || RETRYABLE.has(state.failure.code)) ? ["retry", "continue_without_spec"] : ["continue_without_spec"] };
  }
  // published
  if (state.specPullRequest === undefined) return { action: "hold", reason: "failed", message: "The spec pull request is not recorded.", ownerActions: ["continue_without_spec"] };
  if (state.editPrompt?.status === "open") return { action: "hold", reason: "edited", message: "The spec changed. Re-plan or keep?", ownerActions: ["keep", "replan"] };
  if (state.editPrompt?.status === "replan") return { action: "hold", reason: "edited", message: "The owner asked for a re-plan; the code pull requests wait for the new plan.", ownerActions: ["continue_without_spec"] };
  if (state.target.linkStyle === "spec_first" && state.approvedAt === undefined) {
    return { action: "hold", reason: "waiting_approval", message: "Waiting for a person to approve the spec pull request before the code pull requests open.", ownerActions: ["continue_without_spec"] };
  }
  return { action: "proceed", link: state.specPullRequest };
}

/**
 * The same decision for the code REVIEW, which needs the spec published (it reads the requirements at the recorded commit) but does not wait for a person to approve it or to answer an edit: those
 * hold the code pull request, not the review of the code.
 */
export function specGateForReview(state: SpecState | undefined, corrupt = false, now: string | undefined = undefined): SpecGate {
  if (state === undefined) return specGate(state, corrupt, now);
  const { editPrompt: _edit, ...rest } = state;
  void _edit;
  return specGate({ ...rest, target: { ...state.target, linkStyle: "together" } }, corrupt, now);
}

// ---------------------------------------------------------------------------------------------------------------------
// Transitions. Each returns the next state, or undefined when the state is not where the event expects it (a late or repeated event changes nothing).
// ---------------------------------------------------------------------------------------------------------------------

export function startWriting(state: SpecState, operationId: string, now: string): SpecState | undefined {
  if (state.status !== "due" || state.attempt >= SPEC_ATTEMPTS_MAX) return undefined;
  return touch(state, now, { status: "writing", writeOperationId: operationId, attempt: state.attempt + 1, transient: undefined, retryAfter: undefined });
}

export function writeSucceeded(state: SpecState, input: { operationId: string; title: string; files: readonly SpecFile[]; requirementCount: number }, now: string): SpecState | undefined {
  if (state.status !== "writing" || state.writeOperationId !== input.operationId) return undefined;
  const files = [...input.files];
  return touch(state, now, { status: "written", title: input.title.slice(0, 200), files, filesDigest: filesDigestOf(files), requirementCount: input.requirementCount, failure: undefined, transient: undefined, retryAfter: undefined });
}

/** A SPEC_WRITE run that ended without its result being applied (failed, cancelled, never delivered), or ended and left the state behind: the state fails, with the code the caller names. */
export function stepFailed(state: SpecState, input: { operationId: string; code: SpecFailureCode }, now: string): SpecState | undefined {
  if (!(state.status === "writing" && state.writeOperationId === input.operationId)) return undefined;
  return touch(state, now, { status: "failed", failure: { code: input.code, at: now } });
}

/** The spec pull request could not be made (the broker's own publication): the files are kept for a retry. */
export function publishFailed(state: SpecState, now: string): SpecState | undefined {
  if (state.status !== "written") return undefined;
  return touch(state, now, { status: "failed", failure: { code: "publish_failed", at: now }, transient: undefined, retryAfter: undefined });
}

export function publishSucceeded(state: SpecState, input: { pullRequest: SpecPullRequest }, now: string): SpecState | undefined {
  if (state.status !== "written") return undefined;
  return touch(state, now, { status: "published", specPullRequest: input.pullRequest, failure: undefined, transient: undefined, retryAfter: undefined });
}

/** One more failure that may pass: the step waits (back-off) and counts. At the cap the caller fails the step instead. */
export function noteTransient(state: SpecState, now: string): SpecState {
  const count = (state.transient ?? 0) + 1;
  return touch(state, now, { transient: count, retryAfter: new Date(Date.parse(now) + transientWaitMs(count)).toISOString() });
}

/** The write could not be started for good (or kept failing): the state fails, and the attempt is counted so Retry runs out. */
export function writeNotStarted(state: SpecState, now: string): SpecState {
  return touch(state, now, { status: "failed", failure: { code: "write_failed", at: now }, attempt: state.attempt + 1, transient: undefined, retryAfter: undefined });
}

/** The spec pull request's branch for this attempt: `agentx/<uuid>`, the same every time for the same task and attempt, so a publication that was cut short is found again and not repeated. */
export function specBranchName(taskId: string, attempt: number): string {
  const hex = createHash("sha256").update(`agentx-spec-branch:${taskId}:${String(attempt)}`).digest("hex");
  return `agentx/${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The owner presses Retry after a failure: a failure in the publish retries the publish (the files are kept); any other starts the write again. Bounded by SPEC_ATTEMPTS_MAX. */
export function retry(state: SpecState, now: string): SpecState | undefined {
  if (state.status !== "failed" || state.attempt >= SPEC_ATTEMPTS_MAX || (state.failure !== undefined && !RETRYABLE.has(state.failure.code))) return undefined;
  const publishFailed = state.failure?.code === "publish_failed" && state.files !== undefined;
  return touch(state, now, { status: publishFailed ? "written" : "due", failure: undefined, transient: undefined, retryAfter: undefined, ...(publishFailed ? { attempt: state.attempt + 1 } : {}) });
}

/** The owner presses "Continue without spec". Any state before a published, approved spec; the choice is recorded with who made it. */
export function continueWithoutSpec(state: SpecState, by: string, now: string): SpecState | undefined {
  if (state.continuedWithoutSpec !== undefined) return undefined;
  return touch(state, now, { continuedWithoutSpec: { by: by.slice(0, 200), at: now } });
}

/** A person approved the spec pull request (`spec_first`). Only the pull request Rovara opened, at the head it was approved on. */
export function approved(state: SpecState, input: { headSha: string; by: string }, now: string): SpecState | undefined {
  if (state.status !== "published" || state.specPullRequest === undefined || state.approvedAt !== undefined) return undefined;
  if (input.headSha !== state.specPullRequest.commit) return undefined;
  return touch(state, now, { approvedAt: now, approvedBy: input.by.slice(0, 200) });
}

/** A person changed the spec pull request: a new head that is not the one recorded. Asks the owner; the code pull requests wait for the answer. */
export function edited(state: SpecState, input: { headSha: string }, now: string): SpecState | undefined {
  if (state.status !== "published" || state.specPullRequest === undefined) return undefined;
  if (input.headSha === state.specPullRequest.commit) return undefined;
  if (state.editPrompt?.headSha === input.headSha) return undefined;
  // An edit after an approval withdraws the approval: the people who approved did not see this.
  return touch(state, now, { approvedAt: undefined, approvedBy: undefined, editPrompt: { headSha: input.headSha, at: now, status: "open" } });
}

/** The owner keeps the spec as the person edited it: the review will read the spec at the new head. */
export function keepEdited(state: SpecState, by: string, now: string): SpecState | undefined {
  if (state.status !== "published" || state.specPullRequest === undefined || state.editPrompt?.status !== "open") return undefined;
  return touch(state, now, { specPullRequest: { ...state.specPullRequest, commit: state.editPrompt.headSha }, editPrompt: { ...state.editPrompt, status: "kept", by: by.slice(0, 200) } });
}

/** The owner asks for a re-plan: the spec is written again from the re-approved plan (the caller sends the task back to plan review). */
export function replanEdited(state: SpecState, by: string, now: string): SpecState | undefined {
  if (state.status !== "published" || state.editPrompt?.status !== "open") return undefined;
  return touch(state, now, { editPrompt: { ...state.editPrompt, status: "replan", by: by.slice(0, 200) } });
}

export function filesDigestOf(files: readonly SpecFile[]): string {
  return createHash("sha256").update(canonicalJson([...files].sort((left, right) => left.path.localeCompare(right.path)))).digest("hex");
}
