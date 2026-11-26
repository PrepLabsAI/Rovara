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
import { projectIncarnationUpdate } from "../project-incarnation.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  PROMPT_LOCATIONS_MAX, ProjectDefinitionSchema, SETUP_TIMEOUT, TEST_TIMEOUT, agentXError, canonicalJson, change, formatCommandLine, noAutomatedTestsOf, noAutomatedTestsOfRow, orgProjectCatalogKey, parseCommandLine, projectMetaKey, projectRevisionKey, promptLocationKey, promptLocationsOf, readStoredProject, setupItemsOf, when,
  type DocumentKey, type DocumentStore, type NoAutomatedTests, type OrgId, type Principal, type ProjectCommand, type ProjectDefinition, type PromptLocation, type SetupVerification, type TransactItem, type UpdateOp,
} from "@agentx/contracts";
import { SubjectRefusal, type AppliedDecision, type DecisionAttempt, type DecisionSubject, type LoadedSubject } from "../decisions/approval-gate.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { readState, verifiedView, type SetupAgentDeps } from "./agent.js";
import { testPlacesLooked } from "./end-summary.js";
import { readSetupJournal } from "./journal.js";
import { buildSetupCheck, relayCheck, setupStateOfCheck, type SetupCheckMark } from "./check.js";
import { setupPartition } from "./keys.js";
import { BROWSER_TESTING_WORDS, type BrowserCandidateFacts } from "./browser-testing-state.js";
import type { BrowserApprovalSteps } from "./browser-testing-approval.js";
import { commitsOf, readCurrentSetupFiles, snapshotItem, takeSetupSnapshot } from "./snapshot.js";
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
  /** Command items (a subset of `itemIds`) the person ticked although the page said they do not match the code, after its warning. Such an item is used like one that could not be checked against a file (listed as `unchecked`); the refused-command rules and the second-machine check apply as for any item. Never used for any other kind of item. */
  useAnyway: z.array(z.string().min(1).max(100)).max(SETUP_CONFIRM_ITEM_IDS_MAX).optional(),
}).strict();

/** The verdicts with the command items a person ticked anyway (`useAnyway`, and also named in `itemIds`) moved from `unverified` to `unchecked`: the person's own explicit choice, counted as such and nothing more. Pure. */
export function verdictsWithUseAnyway(
  proposal: Parameters<typeof setupItemsOf>[0], verification: Readonly<Record<string, SetupVerification>>, itemIds: readonly string[] | undefined, useAnyway: readonly string[] | undefined,
): Readonly<Record<string, SetupVerification>> {
  if (itemIds === undefined || useAnyway === undefined || useAnyway.length === 0) return verification;
  const allowed = new Set(setupItemsOf(proposal).filter((item) => item.kind === "setup" || item.kind === "tests").map((item) => item.id));
  const moved: Record<string, SetupVerification> = { ...verification };
  for (const id of useAnyway) if (itemIds.includes(id) && allowed.has(id) && verification[id] === "unverified") moved[id] = "unchecked";
  return moved;
}

export const SETUP_CONFIRM_WORDS = {
  notReady: "There is no setup from Rovara to use. Ask Rovara to set the project up first.",
  old: "Rovara found this setup for an earlier version of the project's settings. Set the project up again.",
  notChecked: "Rovara could not finish checking where each suggestion came from. Try again in a minute.",
  nothing: "None of the suggestions can be used: each one failed its check, or is a command Rovara does not carry into a project's setup.",
  unknownItem: "That suggestion is not part of this setup.",
  invalid: "The commands could not be made into the project's setup.",
  /** DEC 254zzz495 (N3): "use without setup or tests" on a project that already has test commands changes nothing, so no candidate is made. */
  nothingChanges: "Nothing changes: this project already has setup and test commands, and none of Rovara's suggestions was chosen.",
  /** L4-T5: the sentence when the check cannot be read (the neutral one); `waitingSetupWords` picks the exact one. */
  waiting: "Another setup is waiting. If its check passed, approve or reject it; otherwise discard it. Then use this one.",
  tooLong: "A command in this setup is too long to show whole, so it cannot be approved.",
} as const;

/** L4-T5: what a waiting setup (a candidate with no decision) lets a person do, by where its check on a fresh machine stands. Only a check that PASSED can be approved or rejected; any other waiting setup can only be discarded. */
export const SETUP_WAITING_WORDS = {
  ready: "Another setup is waiting for your approval. Approve or reject it, or discard it, first.",
  checking: "Another setup is still being checked on a fresh machine. Wait for the check to finish, or discard it, first.",
  failed: "Another setup can't be approved: its check on a fresh machine did not pass. Discard it, then use this one.",
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
  /** L4-DR: the commit of each repository when the candidate's check was started (the code the check prepares), so the snapshot saved at approval is of THAT code and not of whatever landed meanwhile. Absent: no snapshot is saved. */
  baseCommits?: Record<string, string>;
  /**
   * L4-T2b: the last setup a person APPROVED for this project, kept when a newer candidate replaces this row (the one row per project is overwritten by every new candidate). `revision` is the revision the approval made the
   * project's latest; `at` is when. Tasks keep using that revision after a later candidate is rejected or discarded (its candidate revision is deleted, and the catalog still names this one), so the checklist reads the approval from here.
   */
  earlierApproval?: { revision: number; at: string };
  /**
   * Browser testing (owner decision 421): present when this candidate is a project's browser testing setup, not a setup run's commands. What the approval writes beside the catalog move comes from it
   * (browser-testing-approval.ts), and only a LIVE company owner or admin may decide it (the host's `approval.browserTesting`), whatever the candidate's risk reads as.
   */
  browserTesting?: BrowserCandidateFacts;
  /** The candidate's commands (as typed) that were used with no file evidence behind them: a ticked row that did not match the code, or one that could not be checked against a file. The approval card marks them. Absent: none (or a row made before this was kept). */
  usedWithoutMatch?: string[];
}

/** The approval a replaced row leaves behind: its own when it was approved, else the one it was itself carrying. Pure; a malformed value is no approval. */
export function earlierApprovalOf(previous: Record<string, unknown> | undefined): SetupApplyRow["earlierApproval"] {
  if (previous === undefined || previous["entityType"] !== "SETUP_APPLY") return undefined;
  const own = previous["state"] === "approved" ? { revision: previous["candidateRevision"], at: previous["decidedAt"] } : previous["earlierApproval"];
  const found = own as { revision?: unknown; at?: unknown } | null | undefined;
  return typeof found?.revision === "number" && Number.isInteger(found.revision) && found.revision >= 0 && typeof found.at === "string" && found.at.length > 0 ? { revision: found.revision, at: found.at } : undefined;
}

/** Whether the project has a proposal waiting (its candidate revision exists and no decision was made). Another new revision is refused meanwhile. */
export async function waitingSetupApply(store: Pick<DocumentStore, "get">, orgId: OrgId, project: string): Promise<SetupApplyRow | undefined> {
  const row = await store.get(setupApplyKey(orgId, project));
  return row !== undefined && row["entityType"] === "SETUP_APPLY" && row["state"] === "checking" ? (row as unknown as SetupApplyRow) : undefined;
}

/** L4-T5: the sentence for "another setup is waiting", by what that setup's check says now. Never throws: a check that cannot be read gets the neutral sentence. */
export async function waitingSetupWords(deps: Pick<SetupApplyDeps, "flow" | "store" | "companyId" | "now">, project: string): Promise<string> {
  try {
    const row = await readSetupApply(deps, project);
    // Only a setup that is waiting (no decision yet) has anything to say; any other row is the neutral sentence.
    const status = row?.state === "checking" ? row.checkState.status : undefined;
    return status === "ready" ? SETUP_WAITING_WORDS.ready : status === "checking" ? SETUP_WAITING_WORDS.checking : status === "failed" ? SETUP_WAITING_WORDS.failed : SETUP_CONFIRM_WORDS.waiting;
  } catch {
    return SETUP_CONFIRM_WORDS.waiting;
  }
}

const pathOf = (definition: { repositories: ReadonlyArray<{ name: string; path: string }> }, repo: string): string | undefined => definition.repositories.find((repository) => repository.name === repo)?.path;

/** Lane F: the limit a proposal's command gets: the one its item recorded, else today's (900 s for setup, 1,800 s for tests). */
const timeoutOf = (kind: string, recorded: number | undefined): number => recorded ?? (kind === "setup" ? SETUP_TIMEOUT : TEST_TIMEOUT);

export interface CandidateCommands {
  setup?: ProjectCommand[]; readiness?: ProjectCommand[]; used: string[]; unchecked: string[]; left: Array<{ id: string; reason: SetupConfirmLeftOut }>;
  /** The commands (as typed, one line each) of the used items whose verdict was `unchecked`: used with no file evidence behind them, so the approval card can say so. Absent when there are none. */
  uncheckedLines?: string[];
}

/**
 * The setup and test commands the proposal's usable items carry. Setup items become the project's setup commands; test items its readiness commands. An item that failed its re-read, a flagged or secret-shaped command
 * and a command that does not parse are left out, each with its reason. Pure.
 */
export function commandsFromProposal(
  proposal: Parameters<typeof setupItemsOf>[0], verification: Readonly<Record<string, SetupVerification>>, definition: { repositories: ReadonlyArray<{ name: string; path: string }> }, only?: ReadonlySet<string>,
): CandidateCommands | { error: "nothing" | "unknown_item"; id?: string } {
  const wanted = setupItemsOf(proposal).filter((item) => item.kind === "setup" || item.kind === "tests");
  if (only !== undefined) for (const id of only) if (!wanted.some((item) => item.id === id)) return { error: "unknown_item", id };
  const left: CandidateCommands["left"] = [];
  const used: string[] = [];
  const unchecked: string[] = [];
  const uncheckedLines: string[] = [];
  const setup: ProjectCommand[] = [];
  const readiness: ProjectCommand[] = [];
  for (const item of wanted) {
    if (only !== undefined && !only.has(item.id)) continue;
    const verdict = verification[item.id] ?? "unchecked";
    if (verdict === "unchecked") unchecked.push(item.id);
    if (verdict === "unverified") { left.push({ id: item.id, reason: "unverified" }); continue; }
    // With no choice made, only what the code host confirmed is used. A person's choice may add an item that could not be checked against a file (it is listed as unchecked), never one that failed.
    if (only === undefined && verdict !== "verified") continue;
    const value = item.proposed.value as { repo: string; commands: string[]; timeoutSeconds?: number };
    const cwd = pathOf(definition, value.repo);
    if (cwd === undefined) { left.push({ id: item.id, reason: "invalid_command" }); continue; }
    let kept = 0;
    for (const line of value.commands) {
      let command: ProjectCommand;
      try { command = parseCommandLine(line, cwd, timeoutOf(item.kind, value.timeoutSeconds)); } catch { left.push({ id: item.id, reason: "invalid_command" }); continue; }
      if (refusedCommand(command)) { left.push({ id: item.id, reason: "refused_command" }); continue; }
      const target = item.kind === "setup" ? setup : readiness;
      if (target.length >= (item.kind === "setup" ? 20 : 32)) { left.push({ id: item.id, reason: "too_many" }); continue; }
      target.push(command);
      if (verdict === "unchecked") uncheckedLines.push(formatCommandLine(command));
      kept += 1;
    }
    if (kept > 0) used.push(item.id);
  }
  if (used.length === 0) return { error: "nothing" };
  return { ...(setup.length === 0 ? {} : { setup }), ...(readiness.length === 0 ? {} : { readiness }), used, unchecked, left, ...(uncheckedLines.length === 0 ? {} : { uncheckedLines }) };
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
  proposal: Parameters<typeof setupItemsOf>[0], checked: Readonly<Record<string, SetupVerification>>, definition: { repositories: ReadonlyArray<{ name: string; path: string }>; promptLocations?: unknown }, itemIds: readonly string[] | undefined,
  useAnyway?: readonly string[],
): { made: CandidateCommands; locations: CandidatePromptLocations } {
  // A command row the page said does not match the code, ticked by the person after that warning, counts as one that could not be checked against a file (see `verdictsWithUseAnyway`).
  const verification = verdictsWithUseAnyway(proposal, checked, itemIds, useAnyway);
  const items = setupItemsOf(proposal);
  // DEC 254zzz495 (N3): an empty setup can always be used. A person who ticked nothing ("Use without setup or tests"), or a run that found no setup, test or prompt-location item at all, has the empty choice: no commands change
  // (the project keeps the setup and tests it has) and nothing is refused. A choice that names items which all fail their checks is still refused as "nothing".
  const emptyChoice = itemIds === undefined ? !items.some((item) => item.kind === "setup" || item.kind === "tests" || item.kind === "prompt_location") : itemIds.length === 0;
  if (emptyChoice) return { made: { used: [], unchecked: [], left: [] }, locations: { locations: promptLocationsOf(definition.promptLocations), used: [], unchecked: [], left: [] } };
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

/**
 * What the owner approves: the commands, as a digest, plus whatever more of the candidate the approval must be bound to (`extra`: L4-SC's fakes, L4-EVP's prompt locations). The candidate check ran exactly these, and
 * the approval names this digest. With no extra the digest is the commands' alone, as it always was; with prompt locations only it is exactly L4-EVP's `{ setup, readiness, promptLocations }`.
 */
export const setupApplyDigest = (setup: readonly ProjectCommand[], readiness: readonly ProjectCommand[], extra: Record<string, unknown> = {}): string => createHash("sha256").update(canonicalJson({ setup, readiness, ...extra })).digest("hex");

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
  if ((await waitingSetupApply(deps.store, orgId, project)) !== undefined) throw agentXError("WORKSPACE_BUSY", await waitingSetupWords(deps, project));
  const state = await readState(deps, project, latest.revision);
  if (state.view.status !== "ready" || state.view.proposal === undefined) throw agentXError("CONFIG_INVALID", SETUP_CONFIRM_WORDS.notReady);
  if (state.view.proposal.basedOnRevision !== latest.revision) throw agentXError("PROJECT_REVISION_MISMATCH", SETUP_CONFIRM_WORDS.old);
  // Step 1 of the hard rule: the citations, read again from the code host NOW (or the verdicts kept once final). A re-read that could not finish is not a pass.
  const view = await verifiedView(deps, latest.definition, state.view);
  if (view.verified !== true || view.verification === undefined) throw agentXError("CHANGE_STALE", SETUP_CONFIRM_WORDS.notChecked);
  const full = await deps.flow.projects.latest(project);
  if (full === undefined) throw agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist`);
  const { made, locations } = chooseCandidateItems(view.proposal!, view.verification, full.definition, body.itemIds, body.useAnyway);
  const setup = made.setup ?? full.definition.setup;
  const readiness = made.readiness ?? full.definition.readiness;
  if (made.used.length === 0 && locations.used.length === 0 && readiness.length > 0) throw agentXError("CONFIG_INVALID", SETUP_CONFIRM_WORDS.nothingChanges);
  const candidateRevision = full.definition.revision + 1;
  const withLocations = locations.used.length > 0 ? { promptLocations: locations.locations } : {};
  // DEC 254zzz495 (N3): a candidate with no test command is a normal end ("Ready, no automated tests"): its revision ROW records the fact (when, and where the run looked for tests; not the definition: rollback safety) and it goes
  // through the same check on a fresh machine and the same approval; the fact is the project's from the approval on. A candidate that has test commands carries none (a later approved setup with a test command clears it).
  const fact = readiness.length === 0 ? { at: new Date(deps.now()).toISOString(), looked: await placesLookedOf(deps, project, view.taskId) } : undefined;
  const candidate = ProjectDefinitionSchema.safeParse({
    ...full.definition, revision: candidateRevision, setup, readiness, ...withLocations,
    origins: { ...(full.definition.origins ?? {}), ...(made.setup === undefined ? {} : { setup: "agent" }), ...(made.readiness === undefined ? {} : { readiness: "agent" }) },
  });
  if (!candidate.success) throw agentXError("CONFIG_INVALID", SETUP_CONFIRM_WORDS.invalid);
  return storeSetupCandidate(deps, { project, by, requestId: body.requestId, taskId: view.taskId ?? "", baseRevision: full.definition.revision, candidate: candidate.data, replyExtra: { used: [...made.used, ...locations.used], unchecked: [...made.unchecked, ...locations.unchecked], left: [...made.left, ...locations.left] }, alsoTransact: [], ...(made.uncheckedLines === undefined ? {} : { usedWithoutMatch: made.uncheckedLines }), ...(fact === undefined ? {} : { noAutomatedTests: fact }) });
}

/** Where the run looked for tests, as the fixed words (`testPlacesLooked` of the run's journal). A journal that cannot be read gives none: the candidate is made all the same. */
async function placesLookedOf(deps: Pick<SetupApplyDeps, "store" | "companyId">, project: string, taskId: string | undefined): Promise<ReturnType<typeof testPlacesLooked>> {
  if (taskId === undefined || taskId === "") return [];
  try {
    return testPlacesLooked((await readSetupJournal({ store: deps.store }, { orgId: deps.companyId, project, taskId })).map((entry) => entry.command));
  } catch {
    return [];
  }
}

/**
 * The fact the candidate's revision row carries, and only while the candidate has NO test command: the one the setup run's confirm named, else the base revision's own live fact (a plan update or a browser testing candidate that
 * keeps no tests keeps "Ready, no automated tests"). A candidate with a test command carries none, whatever its base held, so the fact can never come back without a setup a person approved.
 */
export async function noTestsOfCandidate(deps: Pick<SetupApplyDeps, "store" | "companyId">, input: StoreCandidateInput): Promise<NoAutomatedTests | undefined> {
  if (input.candidate.readiness.length > 0) return undefined;
  return input.noAutomatedTests ?? noAutomatedTestsOfRow(await deps.store.get(projectRevisionKey(deps.companyId, input.project, input.baseRevision)));
}

export interface StoreCandidateInput {
  project: string; by: string; requestId: string; taskId: string;
  /** The project's current approved revision the candidate was made from. */
  baseRevision: number;
  /** The candidate definition (already parsed, with the next revision number). */
  candidate: ProjectDefinition;
  /** Fields the reply carries between the digest and the candidate revision (what was used, left out, and so on). */
  replyExtra: Record<string, unknown>;
  /** Items written in the same transaction (a setup update offer marked prepared, say). */
  alsoTransact: readonly TransactItem[];
  /** More of the candidate the approval must be bound to (L4-SC: the fakes a plan's mock adds), folded into the digest the approver sees and approves. Absent: the digest is of the commands only, as before. */
  digestExtra?: Record<string, unknown>;
  /** DEC 254zzz495 (N3): the fact the candidate's revision ROW carries. Used only while the candidate has no test command; absent, the base revision's own fact is carried (a plan update that keeps no tests keeps "Ready, no automated tests"). */
  noAutomatedTests?: NoAutomatedTests;
  /** Browser testing: marks the proposal row as a browser testing candidate (the facts its approval writes from). Absent: an ordinary setup candidate. */
  rowExtra?: { browserTesting: BrowserCandidateFacts };
  /** The candidate's commands (as typed) used with no file evidence behind them (see `SetupApplyRow.usedWithoutMatch`). */
  usedWithoutMatch?: readonly string[];
}

/**
 * The shared tail of every way a setup CANDIDATE is made (a setup run's `confirmSetupAgent`, a merged plan's "Update setup", plan-update.ts): refuse a command too long to show whole, store the candidate as the next
 * revision (written, not the project's latest), start its check on a NEW workspace, and keep the one proposal row; all in one transaction that also requires the project to still be at `baseRevision` and no other
 * proposal to be waiting. Nothing is applied and nothing is approved: only the approval (`createSetupProposalSubject`) makes a candidate the project's latest.
 */
export async function storeSetupCandidate(deps: Pick<SetupApplyDeps, "flow" | "store" | "companyId" | "now">, input: StoreCandidateInput): Promise<Record<string, unknown>> {
  const { project, by, requestId, taskId, baseRevision, candidate } = input;
  const orgId = deps.companyId;
  const candidateRevision = candidate.revision;
  // The approver reads every command whole: one too long to show is refused, never cut.
  if ([...candidate.setup, ...candidate.readiness].some((command) => formatCommandLine(command).length > SETUP_COMMAND_SHOWN_MAX)) throw agentXError("CONFIG_INVALID", SETUP_CONFIRM_WORDS.tooLong);
  // L4-EVP (batch 17): the candidate's prompt locations are bound into the digest too, on every way a candidate is made (none: the digest is as before).
  const promptLocations = candidate.promptLocations ?? [];
  const digest = setupApplyDigest(candidate.setup, candidate.readiness, { ...(promptLocations.length === 0 ? {} : { promptLocations }), ...input.digestExtra });
  const noTests = await noTestsOfCandidate(deps, input);
  const started = buildSetupCheck(deps.flow, { project, revision: candidateRevision, startedBy: by, requestId, candidate: true });
  const reply = { digest, ...input.replyExtra, candidateRevision, proved: false, next: "check" };
  const now = new Date(deps.now()).toISOString();
  // L4-DR: the code the candidate's check is about to prepare, read just before it starts (best effort: none read, none saved at approval). The candidate keeps the base's repositories.
  const baseCommits = await readBaseCommits(deps.flow, candidate);
  // L4-T2b: the row about to be replaced may hold the project's approved setup; keep that fact on the new row (a row still waiting is refused below by the put's own condition, and an approval that lands first moves the catalog, which fails the check).
  const earlierApproval = earlierApprovalOf(await deps.store.get(setupApplyKey(orgId, project)));
  const row: SetupApplyRow = { entityType: "SETUP_APPLY", orgId, project, taskId, requestId, by, digest, baseRevision, candidateRevision, state: "checking", check: started.mark, reply, createdAt: now, ...(input.usedWithoutMatch === undefined || input.usedWithoutMatch.length === 0 ? {} : { usedWithoutMatch: [...input.usedWithoutMatch] }), ...(baseCommits === undefined ? {} : { baseCommits }), ...(earlierApproval === undefined ? {} : { earlierApproval }), ...(input.rowExtra ?? {}) };
  const result = await deps.store.transact([
    // The candidate revision: stored, not the project's latest (the catalog row still names the base), so no task starts on it.
    { kind: "put", item: { ...projectRevisionKey(orgId, project, candidateRevision), entityType: "PROJECT", candidate: true, definition: JSON.parse(JSON.stringify(candidate)) as never, ...(noTests === undefined ? {} : { noAutomatedTests: noTests }) }, condition: when.absent() },
    // The proposal row replaces a finished one, never a waiting one; the project must still be at the revision the person looked at.
    { kind: "put", item: { ...setupApplyKey(orgId, project), ...(JSON.parse(JSON.stringify(row)) as Record<string, never>) }, condition: when.or(when.absent(), when.not(when.eq("state", "checking"))) },
    { kind: "check", key: orgProjectCatalogKey(orgId, project), condition: when.eq("latestRevision", baseRevision) },
    ...started.items,
    ...input.alsoTransact,
  ] satisfies TransactItem[]);
  if (!result.applied) throw agentXError("WORKSPACE_BUSY", await waitingSetupWords(deps, project));
  await relayCheck(deps.flow, started);
  return reply;
}

/** What the page shows of the waiting proposal: the commands, and where the check on them stands. */
export async function readSetupApply(deps: Pick<SetupApplyDeps, "flow" | "store" | "companyId" | "now">, project: string): Promise<(SetupApplyRow & { checkState: Awaited<ReturnType<typeof setupStateOfCheck>>; setup: string[]; readiness: string[]; fakes?: unknown; promptLocations: string[]; noAutomatedTests?: NoAutomatedTests }) | undefined> {
  const raw = await deps.store.get(setupApplyKey(deps.companyId, project));
  if (raw === undefined || raw["entityType"] !== "SETUP_APPLY") return undefined;
  const row = raw as unknown as SetupApplyRow;
  const revision = await deps.store.get(projectRevisionKey(deps.companyId, project, row.candidateRevision));
  const definition = readStoredProject((revision as { definition?: unknown } | undefined)?.definition);
  if (!definition.success) return undefined;
  const checkState = await setupStateOfCheck(deps.flow, row.check, definition.data);
  // Each command as the person would type it (quoted where it needs it) and whole: the approver must see all of what will run.
  const text = (commands: readonly ProjectCommand[]): string[] => commands.map((command) => formatCommandLine(command));
  // L4-EVP: the approver sees every prompt location the candidate holds, whole (repository, file, kind and name).
  const locations = (definition.data.promptLocations ?? []).map((location) => `${location.repo}/${location.path}: ${location.kind === "file" ? "the whole file" : `${location.kind.replace("_", " ")} ${location.symbol ?? ""}`}`);
  // DEC 254zzz495 (N3): the candidate has no test command ("Ready, no automated tests"), as its own definition says.
  const noTests = noAutomatedTestsOf({ readiness: definition.data.readiness, noAutomatedTests: noAutomatedTestsOfRow(revision) });
  return { ...row, checkState, setup: text(definition.data.setup), readiness: text(definition.data.readiness), fakes: definition.data.generalFakes, promptLocations: locations, ...(noTests === undefined ? {} : { noAutomatedTests: noTests }) };
}

/**
 * The owner drops a waiting proposal: the candidate is removed and the project is free to change again. Not an approval: it applies nothing. With `onlyRequestId` (L4-RD: Rovara's own failed draft) it drops the
 * waiting proposal ONLY if it is that request's: a person's candidate that replaced it is never touched.
 */
export async function discardSetupApply(deps: Pick<SetupApplyDeps, "store" | "companyId" | "now">, project: string, by: string, onlyRequestId?: string, options: { mayDiscardBrowserTesting?: boolean } = {}): Promise<boolean> {
  const row = await waitingSetupApply(deps.store, deps.companyId, project);
  if (row === undefined || (onlyRequestId !== undefined && row.requestId !== onlyRequestId)) return false;
  // Browser testing: dropping its waiting change is the same outcome as rejecting it, so it is the same person: a live company owner or admin, whoever asks and by whichever route. The caller says so after
  // reading the person's standing now; a caller that does not is refused (a project's own administrator may drop a setup run's candidate, never this one).
  if (row.browserTesting !== undefined && options.mayDiscardBrowserTesting !== true) throw agentXError("FORBIDDEN", BROWSER_TESTING_WORDS.notAllowed);
  const at = new Date(deps.now()).toISOString();
  const result = await deps.store.transact([
    { kind: "update", key: setupApplyKey(deps.companyId, project), ops: [change.set("state", "discarded"), change.set("decidedAt", at), change.set("decidedBy", by)], condition: onlyRequestId === undefined ? when.eq("state", "checking") : when.and(when.eq("state", "checking"), when.eq("requestId", onlyRequestId)) },
    { kind: "delete", key: projectRevisionKey(deps.companyId, project, row.candidateRevision) },
  ]);
  return result.applied;
}

// ---- the approval

/** The commit of each repository now (L4-DR), or undefined when it cannot be read whole. Never throws. */
async function readBaseCommits(flow: Pick<TaskFlowDeps, "companyId"> & Partial<Pick<TaskFlowDeps, "codeHosts">>, definition: Parameters<typeof readCurrentSetupFiles>[1]): Promise<Record<string, string> | undefined> {
  try {
    const read = await readCurrentSetupFiles({ companyId: flow.companyId, ...(flow.codeHosts === undefined ? {} : { codeHosts: flow.codeHosts }) }, definition);
    return read.status === "read" ? commitsOf(read.repositories) : undefined;
  } catch {
    return undefined;
  }
}

const SNAPSHOT_DEADLINE_MS = 10_000;

/** The snapshot of the candidate being approved (L4-DR), or undefined when the install has no code host to read it from, it cannot be read whole, or the candidate cannot be read. Never throws. */
async function snapshotOfApproved(flow: Pick<TaskFlowDeps, "store" | "companyId"> & Partial<Pick<TaskFlowDeps, "codeHosts">>, row: Pick<SetupApplyRow, "project" | "candidateRevision" | "baseCommits">, at: string): Promise<Awaited<ReturnType<typeof takeSetupSnapshot>>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    // Without the commits the check prepared there is no honest baseline: none is saved, and the project's first re-check saves it.
    if (flow.codeHosts === undefined || row.baseCommits === undefined) return undefined;
    const deadline = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), SNAPSHOT_DEADLINE_MS); });
    return await Promise.race([readIt(), deadline]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  async function readIt(): Promise<Awaited<ReturnType<typeof takeSetupSnapshot>>> {
    const stored = await flow.store.get(projectRevisionKey(flow.companyId, row.project, row.candidateRevision));
    const definition = readStoredProject((stored as { definition?: unknown } | undefined)?.definition);
    if (!definition.success) return undefined;
    return await takeSetupSnapshot({ companyId: flow.companyId, codeHosts: flow.codeHosts }, { definition: definition.data, setupRevision: row.candidateRevision, at, commits: row.baseCommits! });
  }
}

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
  /**
   * L4-SF (c): more steps for the APPROVAL's transaction, for a host that keeps another copy of the project's revisions (the old broker's registry, aws/setup-registry-mirror.ts). Called only when approving;
   * it throws a `SubjectRefusal` when that copy no longer matches what the setup was made from. Absent: nothing more is written.
   */
  registryMirror?: { itemsFor: (row: { project: string; baseRevision: number; candidateRevision: number }, at: string) => Promise<readonly TransactItem[]> };
  /**
   * Browser testing: who may decide a browser testing candidate (a live company owner or admin, never a project maintainer) and what its approval writes. Absent: a browser testing candidate is refused
   * here, whoever asks (a host that cannot write the accounts and the approval must not move the project onto one).
   */
  browserTesting?: BrowserApprovalSteps;
}

/** The candidate's risk and its changes, from its stored revision against the project's approved (base) revision. A row it cannot read is high. */
export async function setupCandidateRisk(store: Pick<DocumentStore, "get">, orgId: OrgId, row: Pick<SetupApplyRow, "project" | "baseRevision" | "candidateRevision">): Promise<SetupChangeRisk> {
  const [base, candidate] = await Promise.all([store.get(projectRevisionKey(orgId, row.project, row.baseRevision)), store.get(projectRevisionKey(orgId, row.project, row.candidateRevision))]);
  return classifySetupChange((base as { definition?: unknown } | undefined)?.definition, (candidate as { definition?: unknown } | undefined)?.definition);
}

/**
 * A transaction names a key once, and a host's registry mirror may already update the candidate's row: the extra attributes join that update (an attribute the mirror sets itself keeps the mirror's value);
 * otherwise they are an update of their own.
 */
export function withCandidateOps(items: readonly TransactItem[], key: DocumentKey, ops: readonly UpdateOp[]): TransactItem[] {
  if (ops.length === 0) return [...items];
  const index = items.findIndex((item) => item.kind === "update" && item.key.pk === key.pk && item.key.sk === key.sk);
  if (index < 0) return [...items, { kind: "update", key, ops, condition: when.eq("entityType", "PROJECT") }];
  const found = items[index] as Extract<TransactItem, { kind: "update" }>;
  const have = new Set(found.ops.map((op) => op.path.join(".")));
  const merged: TransactItem = { ...found, ops: [...found.ops, ...ops.filter((op) => !have.has(op.path.join(".")))] };
  return items.map((item, at) => (at === index ? merged : item));
}

/**
 * Browser testing: a LIVE company owner or admin decides it, both answers, read now by the host. A host with no such rule refuses it (never the laptop's owner rule, never a maintainer's). An ordinary setup
 * candidate is not asked.
 */
async function requireBrowserApprovers(approval: SetupProposalApproval | undefined, row: SetupApplyRow, approvers: readonly Principal[]): Promise<void> {
  if (row.browserTesting === undefined) return;
  const steps = approval?.browserTesting;
  if (steps === undefined) throw new SubjectRefusal("not_the_approver", BROWSER_TESTING_WORDS.notHere);
  for (const approver of approvers) {
    let allowed: unknown;
    try { allowed = await steps.mayDecide(approver, { project: row.project }); } catch { allowed = false; }
    if (allowed !== true) throw new SubjectRefusal("not_the_approver", BROWSER_TESTING_WORDS.adminOnly);
  }
}

/**
 * The extra steps of an approval's own transaction: a host's other copy of the project's revisions (L4-SF c; it throws a `SubjectRefusal` when that copy has moved), and, for a browser testing candidate, the
 * approval's own writes read from its stored proposal. The candidate's row is one update however many want it (a transaction names a key once).
 */
async function approvalExtraItems(approval: SetupProposalApproval | undefined, row: SetupApplyRow, approver: Principal, at: string, store: Pick<DocumentStore, "get">): Promise<readonly TransactItem[]> {
  const mirrored = approval?.registryMirror === undefined ? [] : await approval.registryMirror.itemsFor({ project: row.project, baseRevision: row.baseRevision, candidateRevision: row.candidateRevision }, at);
  const candidateKey = projectRevisionKey(row.orgId, row.project, row.candidateRevision);
  const steps = approval?.browserTesting;
  if (row.browserTesting === undefined || steps === undefined) return withCandidateOps(mirrored, candidateKey, await approvedBrowserTestingCarried(store, row));
  const browser = await steps.itemsFor(row, approver, at);
  return [...withCandidateOps(mirrored, candidateKey, browser.candidateOps), ...browser.items];
}

/**
 * An ordinary setup candidate on top of an approved browser testing setup keeps the policy in its definition; the approval, the registrant and the runtime binding live on the revision's ROW, so they are carried
 * to the new revision (the host's registry mirror, when it has one, sets the registrant and binding itself and keeps its values). Carried only while the candidate's policy is exactly the base's: a changed
 * policy is not what was approved, and gets nothing. Without this the page would read "not set up", the 90-day renewal would stop, and the planning seam would lose the approved source.
 */
async function approvedBrowserTestingCarried(store: Pick<DocumentStore, "get">, row: Pick<SetupApplyRow, "project" | "orgId" | "baseRevision" | "candidateRevision">): Promise<UpdateOp[]> {
  // Never makes the approval fail for a read (like the snapshot above): a fault here carries nothing, and the next browser testing change or renewal says what is missing.
  const [base, candidate] = await Promise.all([store.get(projectRevisionKey(row.orgId, row.project, row.baseRevision)), store.get(projectRevisionKey(row.orgId, row.project, row.candidateRevision))]).catch(() => [undefined, undefined] as const);
  const baseE2e = (base?.["definition"] as { e2e?: unknown } | undefined)?.e2e;
  if (base === undefined || baseE2e === undefined || base["setupApproval"] === undefined || canonicalJson(baseE2e) !== canonicalJson((candidate?.["definition"] as { e2e?: unknown } | undefined)?.e2e)) return [];
  return (["setupApproval", "runtimeBinding", "registeredBy"] as const).filter((field) => base[field] !== undefined).map((field) => change.set(field, base[field] as never));
}

/**
 * The gate's subject for a setup proposal. It is waiting for a decision only once the candidate check PASSED on exactly the commands the digest names; before that, or after it failed, a decision is `not_waiting`.
 * Approving makes the candidate the project's latest revision (the catalog row moves from the base revision to it, and the project's own setup check mark is the check that passed) in the decision's transaction;
 * rejecting removes the candidate. The approver is the owner on the page's own session (the laptop), or whoever the host's `approval` rule allows at the candidate's risk: a repository collaborator's comment is never one.
 */
export function createSetupProposalSubject(options: { flow: Pick<TaskFlowDeps, "store" | "now" | "companyId"> & Partial<Pick<TaskFlowDeps, "codeHosts">>; approval?: SetupProposalApproval }): DecisionSubject {
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
      await requireBrowserApprovers(approval, row, approvers);
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
        // A host's other copy of the revisions moves in the same transaction (L4-SF c); a copy that has moved refuses the approval.
        // The host's other copy of the revisions, and (browser testing) the approval's own writes, joined without naming a key twice.
        const extraItems = await approvalExtraItems(approval, row, approver, at, flow.store);
        // L4-DR (DEC 254z c): what the setup was approved against, saved in the approval's own transaction (the files that decide whether it still works, by id, and the websites it allows). Read from the code host
        // BEFORE the transaction; one that cannot be read whole saves none, and the next re-check saves the baseline instead. It never makes the approval wait on, or fail for, the host.
        const snapshot = await snapshotOfApproved(flow, row, at);
        const meta = await flow.store.get(projectMetaKey(orgId, row.project));
        const identityCondition = projectIncarnationUpdate(orgId, row.project, meta);
        return {
          ops: [change.set("state", "approved"), change.set("decidedAt", at), change.set("decidedBy", approver.personId)],
          extra: [
            // The project moves to the candidate only if it is still at the revision the owner looked at.
            { kind: "update", key: orgProjectCatalogKey(orgId, row.project), ops: [change.set("latestRevision", row.candidateRevision)], condition: when.eq("latestRevision", row.baseRevision) },
            { kind: "update", key: projectMetaKey(orgId, row.project), ops: [change.set("setupCheck", { ...row.check })], condition: when.and(when.present(), identityCondition) },
            ...extraItems,
            ...(snapshot === undefined ? [] : [snapshotItem(orgId, row.project, snapshot)]),
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
