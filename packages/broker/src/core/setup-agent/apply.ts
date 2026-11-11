// "Use this setup": turning what a setup run found into the project's own setup and test commands, and nothing more. The hard rule: a setup run's proposal is applied only after
//   (1) the broker re-read every citation from the code host (`verifiedView`, final), and
//   (2) a passing check on a NEW workspace the broker prepares, never the agent's: the candidate check of this file, run on a stored revision that is not yet the project's latest, and
//   (3) the owner's approval, proved by the owner's page through the Approvers seam and bound to exactly the commands the check ran (`createSetupProposalSubject`).
// Step 1 and the hand-over to step 2 are `confirmSetupAgent`: it saves no setting, starts no task and approves nothing. It stores the verified commands as a CANDIDATE revision of the project (the next revision number,
// written but not made the project's latest, so no task can start on it), starts the check on it and keeps a proposal row. The approval, and only the approval, makes the candidate the project's latest revision, in one
// transaction with the decision; a rejection removes it. Until then a project with a waiting proposal accepts no other new revision (`registerProject` says so).
//
//   - an item whose citation FAILED the re-read is left out, and so is any command that fetches and runs code or holds a secret-shaped value (`refusedCommand`);
//   - only setup and test commands are applied here: a repository, a dev container, a source, an intake trigger, a website and a secret are shown with the proposal and left to the owner's own settings (a website is the
//     host ask's).
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ProjectDefinitionSchema, SETUP_TIMEOUT, TEST_TIMEOUT, agentXError, canonicalJson, change, formatCommandLine, orgProjectCatalogKey, parseCommandLine, projectMetaKey, projectRevisionKey, setupItemsOf, when,
  type DocumentKey, type DocumentStore, type OrgId, type Principal, type ProjectCommand, type SetupVerification, type TransactItem,
} from "@agentx/contracts";
import { SubjectRefusal, type AppliedDecision, type DecisionAttempt, type DecisionSubject, type LoadedSubject } from "../decisions/approval-gate.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { readState, verifiedView, type SetupAgentDeps } from "./agent.js";
import { buildSetupCheck, relayCheck, setupStateOfCheck, type SetupCheckMark } from "./check.js";
import { setupPartition } from "./keys.js";
import { refusedCommand } from "./refused-command.js";

export const SETUP_APPLY_KIND = "setup-proposal";
/** The longest a command may be, as the approval page shows it: whole. */
export const SETUP_COMMAND_SHOWN_MAX = 2_000;
export const SetupConfirmBodySchema = z.object({
  requestId: z.string().uuid(),
  /** The project revision the person looked at. */
  expectedRevision: z.number().int().min(0),
  /** Items to use, by id (setup and tests items only). Absent: every item that passed. */
  itemIds: z.array(z.string().min(1).max(100)).max(64).optional(),
}).strict();

export const SETUP_CONFIRM_WORDS = {
  notReady: "There is no setup from Rovara to use. Ask Rovara to set the project up first.",
  old: "Rovara found this setup for an earlier version of the project's settings. Set the project up again.",
  notChecked: "Rovara could not finish checking where each suggestion came from. Try again in a minute.",
  nothing: "None of the suggestions can be used: each one failed its check, or is a command Rovara does not carry into a project's setup.",
  unknownItem: "That suggestion is not part of this setup.",
  noTest: "The setup has no test command to prove, so there is nothing to use yet.",
  invalid: "The commands could not be made into the project's setup.",
  waiting: "Another setup is waiting for your approval. Decide it, or discard it, first.",
  tooLong: "A command in this setup is too long to show whole, so it cannot be approved.",
} as const;

export type SetupConfirmLeftOut = "unverified" | "refused_command" | "not_a_command_item" | "too_many" | "invalid_command";

/** The proposal row's key: one per project, beside the run's pointer. */
export const setupApplyKey = (orgId: OrgId, project: string): DocumentKey => ({ pk: setupPartition(orgId, project), sk: "APPLY" });

export const SETUP_APPLY_STATES = ["checking", "approved", "rejected", "discarded"] as const;
export interface SetupApplyRow {
  entityType: "SETUP_APPLY"; orgId: OrgId; project: string; taskId: string; requestId: string; by: string;
  /** What the owner is shown and approves: the digest of the commands the candidate check ran. */
  digest: string; baseRevision: number; candidateRevision: number;
  state: (typeof SETUP_APPLY_STATES)[number];
  check: SetupCheckMark;
  reply: Record<string, unknown>;
  createdAt: string; decidedAt?: string; decidedBy?: string;
}

/** Whether the project has a proposal waiting (its candidate revision exists and no decision was made). Another new revision is refused meanwhile. */
export async function waitingSetupApply(store: Pick<DocumentStore, "get">, orgId: OrgId, project: string): Promise<SetupApplyRow | undefined> {
  const row = await store.get(setupApplyKey(orgId, project));
  return row !== undefined && row["entityType"] === "SETUP_APPLY" && row["state"] === "checking" ? (row as unknown as SetupApplyRow) : undefined;
}

const pathOf = (definition: { repositories: ReadonlyArray<{ name: string; path: string }> }, repo: string): string | undefined => definition.repositories.find((repository) => repository.name === repo)?.path;

export interface CandidateCommands { setup?: ProjectCommand[]; readiness?: ProjectCommand[]; used: string[]; unchecked: string[]; left: Array<{ id: string; reason: SetupConfirmLeftOut }> }

/**
 * The setup and test commands the proposal's usable items carry. Setup items become the project's setup commands; test items its readiness commands. An item that failed its re-read, a flagged or secret-shaped command
 * and a command that does not parse are left out, each with its reason. Pure.
 */
export function commandsFromProposal(
  proposal: Parameters<typeof setupItemsOf>[0], verification: Readonly<Record<string, SetupVerification>>, definition: { repositories: ReadonlyArray<{ name: string; path: string }> }, only?: ReadonlySet<string>,
): CandidateCommands | { error: "nothing" | "unknown_item" | "no_test"; id?: string } {
  const wanted = setupItemsOf(proposal).filter((item) => item.kind === "setup" || item.kind === "tests");
  if (only !== undefined) for (const id of only) if (!wanted.some((item) => item.id === id)) return { error: "unknown_item", id };
  const left: CandidateCommands["left"] = [];
  const used: string[] = [];
  const unchecked: string[] = [];
  const setup: ProjectCommand[] = [];
  const readiness: ProjectCommand[] = [];
  for (const item of wanted) {
    if (only !== undefined && !only.has(item.id)) continue;
    const verdict = verification[item.id] ?? "unchecked";
    if (verdict === "unchecked") unchecked.push(item.id);
    if (verdict === "unverified") { left.push({ id: item.id, reason: "unverified" }); continue; }
    // With no choice made, only what the code host confirmed is used. A person's choice may add an item that could not be checked against a file (it is listed as unchecked), never one that failed.
    if (only === undefined && verdict !== "verified") continue;
    const value = item.proposed.value as { repo: string; commands: string[] };
    const cwd = pathOf(definition, value.repo);
    if (cwd === undefined) { left.push({ id: item.id, reason: "invalid_command" }); continue; }
    let kept = 0;
    for (const line of value.commands) {
      let command: ProjectCommand;
      try { command = parseCommandLine(line, cwd, item.kind === "setup" ? SETUP_TIMEOUT : TEST_TIMEOUT); } catch { left.push({ id: item.id, reason: "invalid_command" }); continue; }
      if (refusedCommand(command)) { left.push({ id: item.id, reason: "refused_command" }); continue; }
      const target = item.kind === "setup" ? setup : readiness;
      if (target.length >= (item.kind === "setup" ? 20 : 32)) { left.push({ id: item.id, reason: "too_many" }); continue; }
      target.push(command);
      kept += 1;
    }
    if (kept > 0) used.push(item.id);
  }
  if (used.length === 0) return { error: "nothing" };
  return { ...(setup.length === 0 ? {} : { setup }), ...(readiness.length === 0 ? {} : { readiness }), used, unchecked, left };
}

/** What the owner approves: the commands, as a digest. The candidate check ran exactly these, and the approval names this digest. */
export const setupApplyDigest = (setup: readonly ProjectCommand[], readiness: readonly ProjectCommand[]): string => createHash("sha256").update(canonicalJson({ setup, readiness })).digest("hex");

export interface SetupApplyDeps extends SetupAgentDeps { flow: TaskFlowDeps }

/**
 * `POST /v1/app/projects/{name}/setup-agent/confirm`: makes the run's verified setup commands a candidate of the project and starts the check on it. The run must be `ready`, written for the revision the person looked at,
 * with its citations re-read from the code host and final. Nothing is applied: see the file header. The answer names what was used, what was left out and why, and `proved: false`.
 */
export async function confirmSetupAgent(deps: SetupApplyDeps, project: string, rawBody: unknown, by: string): Promise<Record<string, unknown>> {
  const parsed = SetupConfirmBodySchema.safeParse(rawBody);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `${parsed.error.issues[0]?.path.join(".") || "body"}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const body = parsed.data;
  const orgId = deps.companyId;
  const key = setupApplyKey(orgId, project);
  // A repeat of the same request answers the same thing and stores nothing again.
  const before = await deps.store.get(key);
  if (before !== undefined && before["requestId"] === body.requestId && before["by"] === by) return before["reply"] as Record<string, unknown>;
  const latest = await deps.latest(project);
  if (latest === undefined) throw agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist`);
  if (body.expectedRevision !== latest.revision) throw agentXError("PROJECT_REVISION_MISMATCH", SETUP_CONFIRM_WORDS.old);
  if ((await waitingSetupApply(deps.store, orgId, project)) !== undefined) throw agentXError("WORKSPACE_BUSY", SETUP_CONFIRM_WORDS.waiting);
  const state = await readState(deps, project, latest.revision);
  if (state.view.status !== "ready" || state.view.proposal === undefined) throw agentXError("CONFIG_INVALID", SETUP_CONFIRM_WORDS.notReady);
  if (state.view.proposal.basedOnRevision !== latest.revision) throw agentXError("PROJECT_REVISION_MISMATCH", SETUP_CONFIRM_WORDS.old);
  // Step 1 of the hard rule: the citations, read again from the code host NOW (or the verdicts kept once final). A re-read that could not finish is not a pass.
  const view = await verifiedView(deps, latest.definition, state.view);
  if (view.verified !== true || view.verification === undefined) throw agentXError("CHANGE_STALE", SETUP_CONFIRM_WORDS.notChecked);
  const full = await deps.flow.projects.latest(project);
  if (full === undefined) throw agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist`);
  const made = commandsFromProposal(view.proposal!, view.verification, full.definition, body.itemIds === undefined ? undefined : new Set(body.itemIds));
  if ("error" in made) throw agentXError("CONFIG_INVALID", made.error === "unknown_item" ? SETUP_CONFIRM_WORDS.unknownItem : SETUP_CONFIRM_WORDS.nothing);
  const setup = made.setup ?? full.definition.setup;
  const readiness = made.readiness ?? full.definition.readiness;
  if (readiness.length === 0) throw agentXError("CONFIG_INVALID", SETUP_CONFIRM_WORDS.noTest);
  const candidateRevision = full.definition.revision + 1;
  const candidate = ProjectDefinitionSchema.safeParse({
    ...full.definition, revision: candidateRevision, setup, readiness,
    origins: { ...(full.definition.origins ?? {}), ...(made.setup === undefined ? {} : { setup: "agent" }), ...(made.readiness === undefined ? {} : { readiness: "agent" }) },
  });
  if (!candidate.success) throw agentXError("CONFIG_INVALID", SETUP_CONFIRM_WORDS.invalid);
  // The approver reads every command whole: one too long to show is refused, never cut.
  if ([...candidate.data.setup, ...candidate.data.readiness].some((command) => formatCommandLine(command).length > SETUP_COMMAND_SHOWN_MAX)) throw agentXError("CONFIG_INVALID", SETUP_CONFIRM_WORDS.tooLong);
  const digest = setupApplyDigest(candidate.data.setup, candidate.data.readiness);
  const started = buildSetupCheck(deps.flow, { project, revision: candidateRevision, startedBy: by, requestId: body.requestId, candidate: true });
  const reply = { digest, used: made.used, unchecked: made.unchecked, left: made.left, candidateRevision, proved: false, next: "check" };
  const now = new Date(deps.now()).toISOString();
  const row: SetupApplyRow = { entityType: "SETUP_APPLY", orgId, project, taskId: view.taskId ?? "", requestId: body.requestId, by, digest, baseRevision: full.definition.revision, candidateRevision, state: "checking", check: started.mark, reply, createdAt: now };
  const result = await deps.store.transact([
    // The candidate revision: stored, not the project's latest (the catalog row still names the base), so no task starts on it.
    { kind: "put", item: { ...projectRevisionKey(orgId, project, candidateRevision), entityType: "PROJECT", candidate: true, definition: JSON.parse(JSON.stringify(candidate.data)) as never }, condition: when.absent() },
    // The proposal row replaces a finished one, never a waiting one; the project must still be at the revision the person looked at.
    { kind: "put", item: { ...setupApplyKey(orgId, project), ...(JSON.parse(JSON.stringify(row)) as Record<string, never>) }, condition: when.or(when.absent(), when.not(when.eq("state", "checking"))) },
    { kind: "check", key: orgProjectCatalogKey(orgId, project), condition: when.eq("latestRevision", full.definition.revision) },
    ...started.items,
  ] satisfies TransactItem[]);
  if (!result.applied) throw agentXError("WORKSPACE_BUSY", SETUP_CONFIRM_WORDS.waiting);
  await relayCheck(deps.flow, started);
  return reply;
}

/** What the page shows of the waiting proposal: the commands, and where the check on them stands. */
export async function readSetupApply(deps: Pick<SetupApplyDeps, "flow" | "store" | "companyId" | "now">, project: string): Promise<(SetupApplyRow & { checkState: Awaited<ReturnType<typeof setupStateOfCheck>>; setup: string[]; readiness: string[] }) | undefined> {
  const raw = await deps.store.get(setupApplyKey(deps.companyId, project));
  if (raw === undefined || raw["entityType"] !== "SETUP_APPLY") return undefined;
  const row = raw as unknown as SetupApplyRow;
  const revision = await deps.store.get(projectRevisionKey(deps.companyId, project, row.candidateRevision));
  const definition = ProjectDefinitionSchema.safeParse((revision as { definition?: unknown } | undefined)?.definition);
  if (!definition.success) return undefined;
  const checkState = await setupStateOfCheck(deps.flow, row.check, definition.data);
  // Each command as the person would type it (quoted where it needs it) and whole: the approver must see all of what will run.
  const text = (commands: readonly ProjectCommand[]): string[] => commands.map((command) => formatCommandLine(command));
  return { ...row, checkState, setup: text(definition.data.setup), readiness: text(definition.data.readiness) };
}

/** The owner drops a waiting proposal: the candidate is removed and the project is free to change again. Not an approval: it applies nothing. */
export async function discardSetupApply(deps: Pick<SetupApplyDeps, "store" | "companyId" | "now">, project: string, by: string): Promise<boolean> {
  const row = await waitingSetupApply(deps.store, deps.companyId, project);
  if (row === undefined) return false;
  const at = new Date(deps.now()).toISOString();
  const result = await deps.store.transact([
    { kind: "update", key: setupApplyKey(deps.companyId, project), ops: [change.set("state", "discarded"), change.set("decidedAt", at), change.set("decidedBy", by)], condition: when.eq("state", "checking") },
    { kind: "delete", key: projectRevisionKey(deps.companyId, project, row.candidateRevision) },
  ]);
  return result.applied;
}

// ---- the approval

/**
 * The gate's subject for a setup proposal. It is waiting for a decision only once the candidate check PASSED on exactly the commands the digest names; before that, or after it failed, a decision is `not_waiting`.
 * Approving makes the candidate the project's latest revision (the catalog row moves from the base revision to it, and the project's own setup check mark is the check that passed) in the decision's transaction;
 * rejecting removes the candidate. The approver is the owner on the page's own session: a repository collaborator's comment is never one.
 */
export function createSetupProposalSubject(options: { flow: Pick<TaskFlowDeps, "store" | "now" | "companyId"> }): DecisionSubject {
  const { flow } = options;
  return {
    kind: SETUP_APPLY_KIND,
    async load(companyId, project): Promise<LoadedSubject | undefined> {
      if (companyId !== flow.companyId) return undefined;
      const read = await readSetupApply({ flow: flow as TaskFlowDeps, store: flow.store, companyId, now: () => (flow.now?.() ?? new Date()).getTime() }, project);
      if (read === undefined) return undefined;
      return {
        key: setupApplyKey(companyId, project),
        guard: when.and(when.eq("state", "checking"), when.eq("digest", read.digest), when.eq("candidateRevision", read.candidateRevision)),
        waiting: read.state === "checking" && read.checkState.status === "ready",
        // The candidate runs code the repository holds: high, so only the owner's own page session decides it.
        request: { kind: "setup", subject: { type: "setup_proposal", id: project }, projectName: project, revision: read.candidateRevision, artifactDigest: read.digest, risk: "high" },
        state: { row: read },
      };
    },
    async apply(loaded, attempt: DecisionAttempt, approvers: readonly Principal[], at: string): Promise<AppliedDecision> {
      const { row } = loaded.state as { row: SetupApplyRow };
      if (!approvers.every((approver) => approver.roles.includes("owner"))) throw new SubjectRefusal("not_the_approver", "Only the owner approves a project's setup.");
      const approver = approvers[0]!;
      const orgId = row.orgId;
      if (attempt.outcome === "approve") {
        return {
          ops: [change.set("state", "approved"), change.set("decidedAt", at), change.set("decidedBy", approver.personId)],
          extra: [
            // The project moves to the candidate only if it is still at the revision the owner looked at.
            { kind: "update", key: orgProjectCatalogKey(orgId, row.project), ops: [change.set("latestRevision", row.candidateRevision)], condition: when.eq("latestRevision", row.baseRevision) },
            { kind: "update", key: projectMetaKey(orgId, row.project), ops: [change.set("setupCheck", { ...row.check })], condition: when.present() },
          ],
          result: { project: row.project, revision: row.candidateRevision },
        };
      }
      if (attempt.outcome === "reject") {
        return {
          ops: [change.set("state", "rejected"), change.set("decidedAt", at), change.set("decidedBy", approver.personId)],
          extra: [{ kind: "delete", key: projectRevisionKey(orgId, row.project, row.candidateRevision) }],
          result: { project: row.project, state: "rejected" },
        };
      }
      throw new SubjectRefusal("invalid_outcome", "A setup is approved or rejected.");
    },
  };
}
