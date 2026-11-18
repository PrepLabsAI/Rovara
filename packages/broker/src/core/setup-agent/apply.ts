// "Use this setup": turning what a setup run found into the project's own setup and test commands, and nothing more. The hard rule: a setup run's proposal is applied only after
//   (1) the broker re-read every citation from the code host (`verifiedView`, final), and
//   (2) a passing check on a NEW workspace the broker prepares, never the agent's: the candidate check of this file, run on a stored revision that is not yet the project's latest, and
//   (3) the approval, proved through the Approvers seam and bound to exactly the commands the check ran and the candidate revision (`createSetupProposalSubject`): on the laptop the owner's page;
//       on hosted Code (L4-D, DEC 254z b) a person whose live standing fits the risk the candidate's diff carries (setup-risk.ts: low and medium a project maintainer, high a company admin).
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
  PROMPT_LOCATIONS_MAX, ProjectDefinitionSchema, SETUP_TIMEOUT, TEST_TIMEOUT, agentXError, canonicalJson, change, formatCommandLine, orgProjectCatalogKey, parseCommandLine, projectMetaKey, projectRevisionKey, promptLocationKey, promptLocationsOf, setupItemsOf, when,
  type DocumentKey, type DocumentStore, type OrgId, type Principal, type ProjectCommand, type PromptLocation, type SetupVerification, type TransactItem,
} from "@agentx/contracts";
import { SubjectRefusal, type AppliedDecision, type DecisionAttempt, type DecisionSubject, type LoadedSubject } from "../decisions/approval-gate.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { readState, verifiedView, type SetupAgentDeps } from "./agent.js";
import { buildSetupCheck, relayCheck, setupStateOfCheck, type SetupCheckMark } from "./check.js";
import { setupPartition } from "./keys.js";
import { refusedCommand } from "./refused-command.js";
import { classifySetupChange, type SetupChangeRisk, type SetupRisk } from "./setup-risk.js";

export const SETUP_APPLY_KIND = "setup-proposal";
/** The most item ids one confirm may name: every setup and tests item a proposal may hold, and every prompt location. */
export const SETUP_CONFIRM_ITEM_IDS_MAX = 128;
/** The longest a command may be, as the approval page shows it: whole. */
export const SETUP_COMMAND_SHOWN_MAX = 2_000;
export const SetupConfirmBodySchema = z.object({
  requestId: z.string().uuid(),
  /** The project revision the person looked at. */
  expectedRevision: z.number().int().min(0),
  /** Items to use, by id (setup, tests and prompt-location items). Absent: every item that passed. At most the proposal's own item limits in all (32 + 32 commands, 40 locations). */
  itemIds: z.array(z.string().min(1).max(100)).max(SETUP_CONFIRM_ITEM_IDS_MAX).optional(),
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

/**
 * L4-EVP: the prompt locations the proposal's usable `prompt_location` items carry, added to the ones the project already has (a location is removed only by a person's own edit, never by an agent's proposal that
 * leaves it out). An item that failed its re-read, names a repository the project does not have, or would take the list past its limit is left out, each with its reason. Pure.
 */
export interface CandidatePromptLocations { locations: PromptLocation[]; used: string[]; unchecked: string[]; left: CandidateCommands["left"] }
export function promptLocationsFromProposal(
  proposal: Parameters<typeof setupItemsOf>[0], verification: Readonly<Record<string, SetupVerification>>, definition: { repositories: ReadonlyArray<{ name: string }>; promptLocations?: unknown }, only?: ReadonlySet<string>,
): CandidatePromptLocations {
  const existing = promptLocationsOf(definition.promptLocations);
  const out: CandidatePromptLocations = { locations: [...existing], used: [], unchecked: [], left: [] };
  const known = new Set(existing.map(promptLocationKey));
  for (const item of setupItemsOf(proposal)) {
    if (item.kind !== "prompt_location" || (only !== undefined && !only.has(item.id))) continue;
    const verdict = verification[item.id] ?? "unchecked";
    if (verdict === "unverified") { out.left.push({ id: item.id, reason: "unverified" }); continue; }
    // Like a command: with no choice made, only what the code host confirmed is used; a person's choice may add one that could not be checked against a file.
    if (only === undefined && verdict !== "verified") continue;
    if (verdict === "unchecked") out.unchecked.push(item.id);
    const value = item.proposed.value as PromptLocation;
    if (!definition.repositories.some((repository) => repository.name === value.repo)) { out.left.push({ id: item.id, reason: "unverified" }); continue; }
    const key = promptLocationKey(value);
    // A location the project already has adds nothing: it is not "used", so a confirm of only such items is refused as "nothing" instead of making a candidate equal to the base.
    if (known.has(key)) continue;
    if (out.locations.length >= PROMPT_LOCATIONS_MAX) { out.left.push({ id: item.id, reason: "too_many" }); continue; }
    known.add(key);
    out.locations.push(value);
    out.used.push(item.id);
  }
  return out;
}

/**
 * L4-EVP: what a confirm takes from the proposal. The person's choice (`itemIds`) may name prompt-location items as well as command items; an id of neither kind is unknown and refuses the whole confirm. Nothing usable at all
 * (an empty choice, only unverified or already-held locations, only failed commands) is refused as "nothing"; commands with nothing usable are no refusal while a prompt location is usable. Pure, so it is tested without a store.
 */
export function chooseCandidateItems(
  proposal: Parameters<typeof setupItemsOf>[0], verification: Readonly<Record<string, SetupVerification>>, definition: { repositories: ReadonlyArray<{ name: string; path: string }>; promptLocations?: unknown }, itemIds: readonly string[] | undefined,
): { made: CandidateCommands; locations: CandidatePromptLocations } {
  const items = setupItemsOf(proposal);
  const chosen = itemIds === undefined ? undefined : new Set(itemIds);
  const kindOf = (id: string) => items.find((item) => item.id === id)?.kind;
  const commandChoice = chosen === undefined ? undefined : new Set([...chosen].filter((id) => kindOf(id) !== "prompt_location"));
  const onlyLocations = chosen !== undefined && chosen.size > 0 && commandChoice!.size === 0;
  const locations = promptLocationsFromProposal(proposal, verification, definition, chosen);
  const commands = onlyLocations ? { used: [], unchecked: [], left: [] } as CandidateCommands : commandsFromProposal(proposal, verification, definition, commandChoice);
  if ("error" in commands && (commands.error !== "nothing" || locations.used.length === 0)) throw agentXError("CONFIG_INVALID", commands.error === "unknown_item" ? SETUP_CONFIRM_WORDS.unknownItem : SETUP_CONFIRM_WORDS.nothing);
  const made: CandidateCommands = "error" in commands ? { used: [], unchecked: [], left: [] } : commands;
  if (made.used.length === 0 && locations.used.length === 0) throw agentXError("CONFIG_INVALID", SETUP_CONFIRM_WORDS.nothing);
  return { made, locations };
}

/** What the owner approves: the commands (and, when the candidate holds prompt locations, those), as a digest. The candidate check ran exactly these, and the approval names this digest. Without locations the digest is the commands' alone, as it always was. */
export const setupApplyDigest = (setup: readonly ProjectCommand[], readiness: readonly ProjectCommand[], promptLocations?: readonly PromptLocation[]): string =>
  createHash("sha256").update(canonicalJson(promptLocations === undefined || promptLocations.length === 0 ? { setup, readiness } : { setup, readiness, promptLocations })).digest("hex");

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
  const { made, locations } = chooseCandidateItems(view.proposal!, view.verification, full.definition, body.itemIds);
  const setup = made.setup ?? full.definition.setup;
  const readiness = made.readiness ?? full.definition.readiness;
  if (readiness.length === 0) throw agentXError("CONFIG_INVALID", SETUP_CONFIRM_WORDS.noTest);
  const candidateRevision = full.definition.revision + 1;
  const withLocations = locations.used.length > 0 ? { promptLocations: locations.locations } : {};
  const candidate = ProjectDefinitionSchema.safeParse({
    ...full.definition, revision: candidateRevision, setup, readiness, ...withLocations,
    origins: { ...(full.definition.origins ?? {}), ...(made.setup === undefined ? {} : { setup: "agent" }), ...(made.readiness === undefined ? {} : { readiness: "agent" }) },
  });
  if (!candidate.success) throw agentXError("CONFIG_INVALID", SETUP_CONFIRM_WORDS.invalid);
  // The approver reads every command whole: one too long to show is refused, never cut.
  if ([...candidate.data.setup, ...candidate.data.readiness].some((command) => formatCommandLine(command).length > SETUP_COMMAND_SHOWN_MAX)) throw agentXError("CONFIG_INVALID", SETUP_CONFIRM_WORDS.tooLong);
  const digest = setupApplyDigest(candidate.data.setup, candidate.data.readiness, candidate.data.promptLocations);
  const started = buildSetupCheck(deps.flow, { project, revision: candidateRevision, startedBy: by, requestId: body.requestId, candidate: true });
  const reply = { digest, used: [...made.used, ...locations.used], unchecked: [...made.unchecked, ...locations.unchecked], left: [...made.left, ...locations.left], candidateRevision, proved: false, next: "check" };
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
export async function readSetupApply(deps: Pick<SetupApplyDeps, "flow" | "store" | "companyId" | "now">, project: string): Promise<(SetupApplyRow & { checkState: Awaited<ReturnType<typeof setupStateOfCheck>>; setup: string[]; readiness: string[]; promptLocations: string[] }) | undefined> {
  const raw = await deps.store.get(setupApplyKey(deps.companyId, project));
  if (raw === undefined || raw["entityType"] !== "SETUP_APPLY") return undefined;
  const row = raw as unknown as SetupApplyRow;
  const revision = await deps.store.get(projectRevisionKey(deps.companyId, project, row.candidateRevision));
  const definition = ProjectDefinitionSchema.safeParse((revision as { definition?: unknown } | undefined)?.definition);
  if (!definition.success) return undefined;
  const checkState = await setupStateOfCheck(deps.flow, row.check, definition.data);
  // Each command as the person would type it (quoted where it needs it) and whole: the approver must see all of what will run.
  const text = (commands: readonly ProjectCommand[]): string[] => commands.map((command) => formatCommandLine(command));
  // L4-EVP: the approver sees every prompt location the candidate holds, whole (repository, file, kind and name).
  const locations = (definition.data.promptLocations ?? []).map((location) => `${location.repo}/${location.path}: ${location.kind === "file" ? "the whole file" : `${location.kind.replace("_", " ")} ${location.symbol ?? ""}`}`);
  return { ...row, checkState, setup: text(definition.data.setup), readiness: text(definition.data.readiness), promptLocations: locations };
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

/** The laptop's words when someone other than the install's owner answers. */
export const SETUP_OWNER_ONLY = "Only the owner approves a project's setup.";

/**
 * Who decides a setup candidate, and at what risk. The laptop passes nothing: the risk is high and only the install's owner decides (`SETUP_OWNER_ONLY`). A host (L4-D, DEC 254z b: hosted Code) passes
 * its own rule: the risk read from the candidate's diff against the project's approved revision (`classifySetupChange`), and the approver's LIVE standing checked against that risk.
 */
export interface SetupProposalApproval {
  /** Reads the risk from the candidate's diff (setup-risk.ts). Absent: high. */
  riskFromDiff?: boolean;
  /** Whether this verified approver may give this answer at this risk, read now. A throw or anything but `true` is a refusal. */
  mayDecide: (approver: Principal, input: { project: string; risk: SetupRisk; outcome: "approve" | "reject" }) => Promise<boolean>;
  /** The fixed words of a refusal, by the risk the candidate is at and the answer. */
  refusal: (risk: SetupRisk, outcome: "approve" | "reject") => string;
}

/** The candidate's risk and its changes, from its stored revision against the project's approved (base) revision. A row it cannot read is high. */
export async function setupCandidateRisk(store: Pick<DocumentStore, "get">, orgId: OrgId, row: Pick<SetupApplyRow, "project" | "baseRevision" | "candidateRevision">): Promise<SetupChangeRisk> {
  const [base, candidate] = await Promise.all([store.get(projectRevisionKey(orgId, row.project, row.baseRevision)), store.get(projectRevisionKey(orgId, row.project, row.candidateRevision))]);
  return classifySetupChange((base as { definition?: unknown } | undefined)?.definition, (candidate as { definition?: unknown } | undefined)?.definition);
}

/**
 * The gate's subject for a setup proposal. It is waiting for a decision only once the candidate check PASSED on exactly the commands the digest names; before that, or after it failed, a decision is `not_waiting`.
 * Approving makes the candidate the project's latest revision (the catalog row moves from the base revision to it, and the project's own setup check mark is the check that passed) in the decision's transaction;
 * rejecting removes the candidate. The approver is the owner on the page's own session (the laptop), or whoever the host's `approval` rule allows at the candidate's risk: a repository collaborator's comment is never one.
 */
export function createSetupProposalSubject(options: { flow: Pick<TaskFlowDeps, "store" | "now" | "companyId">; approval?: SetupProposalApproval }): DecisionSubject {
  const { flow, approval } = options;
  return {
    kind: SETUP_APPLY_KIND,
    async load(companyId, project): Promise<LoadedSubject | undefined> {
      if (companyId !== flow.companyId) return undefined;
      const read = await readSetupApply({ flow: flow as TaskFlowDeps, store: flow.store, companyId, now: () => (flow.now?.() ?? new Date()).getTime() }, project);
      if (read === undefined) return undefined;
      // The laptop: the candidate runs code the repository holds, so high, and only the owner's own page session decides it. A host's rule: the risk the candidate's diff carries (unknown = high).
      const risk: SetupRisk = approval?.riskFromDiff === true ? (await setupCandidateRisk(flow.store, companyId, read)).risk : "high";
      return {
        key: setupApplyKey(companyId, project),
        guard: when.and(when.eq("state", "checking"), when.eq("digest", read.digest), when.eq("candidateRevision", read.candidateRevision)),
        waiting: read.state === "checking" && read.checkState.status === "ready",
        request: { kind: "setup", subject: { type: "setup_proposal", id: project }, projectName: project, revision: read.candidateRevision, artifactDigest: read.digest, risk },
        state: { row: read, risk },
      };
    },
    async apply(loaded, attempt: DecisionAttempt, approvers: readonly Principal[], at: string): Promise<AppliedDecision> {
      const { row, risk } = loaded.state as { row: SetupApplyRow; risk: SetupRisk };
      if (approval === undefined) {
        if (!approvers.every((approver) => approver.roles.includes("owner"))) throw new SubjectRefusal("not_the_approver", SETUP_OWNER_ONLY);
      } else {
        if (attempt.outcome !== "approve" && attempt.outcome !== "reject") throw new SubjectRefusal("invalid_outcome", "A setup is approved or rejected.");
        // Every approver, read live against the candidate's risk; a read that fails is a refusal.
        for (const approver of approvers) {
          let allowed: unknown;
          try { allowed = await approval.mayDecide(approver, { project: row.project, risk, outcome: attempt.outcome }); } catch { allowed = false; }
          if (allowed !== true) throw new SubjectRefusal("not_the_approver", approval.refusal(risk, attempt.outcome));
        }
      }
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
