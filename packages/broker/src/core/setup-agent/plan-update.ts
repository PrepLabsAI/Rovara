// L4-SC (DEC 254z c, DEC 254zw): "Update setup" after a merge. A task whose plan carried setup changes (a mock, a command; plan-setup.ts and contracts/plan-setup-changes.ts) and whose pull request MERGED leaves ONE
// offer for the project's maintainers. The offer is a row, written in the same transaction that records the merge (so it exists exactly when the merge does, once, and never for a pull request that closed unmerged).
// A maintainer presses "Update setup": that makes a setup CANDIDATE from the plan-approved items and starts its check on a new workspace (`storeSetupCandidate`, the same tail as "Use this setup"), and from there it is
// the existing flow: the check must pass, then a person approves at the risk the candidate's diff carries (setup-risk.ts: a mock is medium, a command low or, with an environment entry, high), through the approval gate.
//
// States: offered (waiting for a maintainer), applied (its candidate was approved), dismissed. A candidate that is rejected or discarded leaves the offer offered, so the maintainer can try again or dismiss it. The offer
// is retired only AFTER an approval, best effort (`markSetupUpdateApplied`); if that write fails the offer shows again and pressing it finds every change already there, which says so.
//
// What never happens here:
//   - nothing is approved: this file writes no decision and moves no project to a revision (the catalog row is only CHECKED, as for every candidate); a mock in a plan was approved for ONE task, and an update of the
//     project's setup is a different act, by a person, on a different card;
//   - nothing starts by itself: the offer waits for a maintainer's press (the unattended start is a separate decision: Question 1 of the PR);
//   - nothing is taken from the offer's words at press time: the items are re-read and re-validated, and their digest must still be the one recorded;
//   - no model, no network.
// The offer holds only what the approved plan held (names, spec file names, commands) and the pull requests' own addresses; never a secret value (a variable is a name, and not carried).
import {
  INDEX_EXPIRY_ATTRIBUTE, PLAN_SETUP_MOCKS_MAX, PlanSetupChangesSchema, ProjectDefinitionSchema, SETUP_CHANGE_CARRIED_KINDS, SETUP_TIMEOUT, TEST_TIMEOUT, agentXError, change, parseCommandLine, queryAll, setupChangeLines, setupChangesDigest,
  when, GENERAL_FAKES_MAX_SERVICES,
  type DocumentKey, type OrgId, type PlanSetupChangeItem, type PlanSetupChanges, type ProjectCommand, type TransactItem, type WorkflowSnapshot,
} from "@agentx/contracts";
import { approvedCodingPlan } from "../build-step/plan-input.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { waitingSetupApply, storeSetupCandidate, type SetupApplyDeps } from "./apply.js";
import { setupPartition } from "./keys.js";
import { refusedCommand } from "./refused-command.js";

export const SETUP_UPDATE_KEEP_SECONDS = 90 * 86_400;
export const SETUP_UPDATE_STATES = ["offered", "applied", "dismissed"] as const;
export type SetupUpdateState = (typeof SETUP_UPDATE_STATES)[number];

/** The words of the card and its refusals (fixed; the plan's own short text is shown only as the item lines the plan card already showed). */
export const SETUP_UPDATE_WORDS = {
  title: "Update setup",
  summary: (count: number): string => `A pull request merged that changed the test setup (${String(count)} ${count === 1 ? "change" : "changes"}). Update the project's setup to include ${count === 1 ? "it" : "them"}; it is checked on a fresh machine and then approved like any setup change.`,
  gone: "That setup update is no longer offered.",
  changed: "That setup update changed since the plan was approved, so it was not used.",
  nothing: "None of the changes can be added to the project's setup: each is already there, is not a setup or test command or mock Rovara carries, or is a command it does not carry into a project.",
  waiting: "Another setup is waiting for approval. Decide it, or discard it, first.",
} as const;

export interface SetupUpdateOffer {
  entityType: "SETUP_UPDATE_OFFER"; orgId: OrgId; project: string; taskId: string;
  /** The approved plan's artifact digest, and the digest of the items (setupChangesDigest): the candidate is made only from items that still hash to this. */
  planDigest: string; itemsDigest: string; items: PlanSetupChangeItem[];
  pullRequests: Array<{ repository: string; number: number; url: string }>;
  state: SetupUpdateState; offeredAt: string; decidedAt?: string; decidedBy?: string;
  [INDEX_EXPIRY_ATTRIBUTE]?: number;
}

export const setupUpdateKey = (orgId: OrgId, project: string, taskId: string): DocumentKey => ({ pk: setupPartition(orgId, project), sk: `UPDATE#${taskId}` });
const UPDATE_PREFIX = "UPDATE#";

const isMergedTask = (workflow: WorkflowSnapshot): boolean => workflow.stage === "MERGED" && workflow.state === "COMPLETE" && workflow.outcome === "MERGED";
const carried = (item: PlanSetupChangeItem): boolean => (SETUP_CHANGE_CARRIED_KINDS as readonly string[]).includes(item.kind);

/**
 * The items that leave the offer, for the transaction that records a task's MERGE: none unless `after` is the move to MERGED (and `before` was not), the task's org is known, and the plan a person approved (read back by
 * digest) carried at least one change Rovara can add to the setup (a mock or a command). A plan that cannot be read, an unreadable store, anything else: none, and the merge is recorded without it (never blocked by it).
 */
export async function setupUpdateOfferItems(
  deps: Pick<TaskFlowDeps, "artifacts" | "companyId">, task: { taskId: string; orgId?: OrgId | undefined; project: string }, before: WorkflowSnapshot, after: WorkflowSnapshot, now: string,
): Promise<TransactItem[]> {
  if (!isMergedTask(after) || isMergedTask(before) || task.orgId === undefined || task.orgId !== deps.companyId) return [];
  let plan;
  try { plan = await approvedCodingPlan(deps.artifacts, after); } catch { return []; }
  const items = plan.setupChanges;
  if (items === undefined || !items.some(carried) || !PlanSetupChangesSchema.safeParse(items).success) return [];
  const merged = (after.pullRequests ?? []).filter((pullRequest) => pullRequest.state === "MERGED").slice(0, 8);
  const offer: SetupUpdateOffer = {
    entityType: "SETUP_UPDATE_OFFER", orgId: task.orgId, project: task.project, taskId: task.taskId, planDigest: plan.sha256, itemsDigest: setupChangesDigest(items), items: [...items],
    pullRequests: merged.map((pullRequest) => ({ repository: pullRequest.repositoryId, number: pullRequest.number, url: pullRequest.url })),
    state: "offered", offeredAt: now, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(Date.parse(now) / 1000) + SETUP_UPDATE_KEEP_SECONDS,
  };
  return [{ kind: "put", item: { ...setupUpdateKey(task.orgId, task.project, task.taskId), ...(JSON.parse(JSON.stringify(offer)) as Record<string, never>) } }];
}

/** An offer row read back: only a row of this company and project with a state this code knows and items that still check. Anything else is not an offer. */
function offerOf(raw: Record<string, unknown> | undefined, orgId: OrgId, project: string): SetupUpdateOffer | undefined {
  if (raw === undefined || raw["entityType"] !== "SETUP_UPDATE_OFFER" || raw["orgId"] !== orgId || raw["project"] !== project) return undefined;
  if (!(SETUP_UPDATE_STATES as readonly unknown[]).includes(raw["state"]) || typeof raw["taskId"] !== "string") return undefined;
  const items = PlanSetupChangesSchema.safeParse(raw["items"]);
  if (!items.success || typeof raw["itemsDigest"] !== "string" || setupChangesDigest(items.data) !== raw["itemsDigest"]) return undefined;
  return { ...(raw as unknown as SetupUpdateOffer), items: items.data };
}

export interface SetupUpdateView {
  taskId: string; state: SetupUpdateState; offeredAt: string; title: string; summary: string;
  /** One line per change, as the plan card showed it. */
  lines: string[];
  /** How many of the changes Rovara adds to the setup, and which kinds it leaves to a person (a variable's value, a dependency). */
  carried: number; leftToYou: string[];
  pullRequests: Array<{ repository: string; number: number; url: string }>;
}

/** The project's offers still waiting, newest first. While a setup proposal waits for its decision, none is offered: that proposal is what the maintainer acts on. */
export async function readSetupUpdates(deps: Pick<SetupApplyDeps, "store" | "companyId">, project: string): Promise<SetupUpdateView[]> {
  if ((await waitingSetupApply(deps.store, deps.companyId, project)) !== undefined) return [];
  const rows = await queryAll(deps.store, { pk: setupPartition(deps.companyId, project), sk: { op: "beginsWith", prefix: UPDATE_PREFIX } });
  const views: SetupUpdateView[] = [];
  for (const raw of rows) {
    const offer = offerOf(raw, deps.companyId, project);
    if (offer === undefined || offer.state !== "offered") continue;
    const left = offer.items.filter((item) => !carried(item));
    views.push({
      taskId: offer.taskId, state: offer.state, offeredAt: offer.offeredAt, title: SETUP_UPDATE_WORDS.title, summary: SETUP_UPDATE_WORDS.summary(offer.items.length), lines: setupChangeLines(offer.items),
      carried: offer.items.length - left.length, leftToYou: setupChangeLines(left), pullRequests: offer.pullRequests,
    });
  }
  return views.sort((a, b) => b.offeredAt.localeCompare(a.offeredAt));
}

type Definition = NonNullable<Awaited<ReturnType<SetupApplyDeps["flow"]["projects"]["latest"]>>>["definition"];
export type SetupUpdateLeftOut = "already_there" | "refused_command" | "invalid_command" | "too_many" | "unknown_repository" | "not_carried";

/**
 * The candidate definition for these items: the approved definition plus each carried item that is not already there. Commands are ADDED (never replacing one) and carry no environment; a mock is a service of the
 * project's `generalFakes` (the fakes are switched on, and no service is replaced or dropped). An item that cannot be added is left out with its reason, never half-added. Pure.
 */
export function candidateFromPlanItems(definition: Definition, items: PlanSetupChanges): { candidate: Record<string, unknown>; used: string[]; left: Array<{ id: string; reason: SetupUpdateLeftOut }> } | undefined {
  const left: Array<{ id: string; reason: SetupUpdateLeftOut }> = [];
  const used: string[] = [];
  const setup: ProjectCommand[] = [...definition.setup];
  const readiness: ProjectCommand[] = [...definition.readiness];
  const services = [...(definition.generalFakes?.services ?? [])];
  const sameCommand = (a: ProjectCommand, b: ProjectCommand): boolean => a.cwd === b.cwd && a.executable === b.executable && JSON.stringify(a.args) === JSON.stringify(b.args);
  let mocks = 0;
  for (const item of items) {
    if (item.kind === "command") {
      const repository = definition.repositories.find((entry) => entry.name === item.repo);
      if (repository === undefined) { left.push({ id: item.id, reason: "unknown_repository" }); continue; }
      let command: ProjectCommand;
      try { command = parseCommandLine(item.line, repository.path, item.area === "setup" ? SETUP_TIMEOUT : TEST_TIMEOUT); } catch { left.push({ id: item.id, reason: "invalid_command" }); continue; }
      if (refusedCommand(command)) { left.push({ id: item.id, reason: "refused_command" }); continue; }
      const target = item.area === "setup" ? setup : readiness;
      if (target.some((existing) => sameCommand(existing, command))) { left.push({ id: item.id, reason: "already_there" }); continue; }
      if (target.length >= (item.area === "setup" ? 20 : 32)) { left.push({ id: item.id, reason: "too_many" }); continue; }
      target.push(command);
      used.push(item.id);
    } else if (item.kind === "mock") {
      if (services.some((service) => service.variable === item.variable)) { left.push({ id: item.id, reason: "already_there" }); continue; }
      if (services.length >= GENERAL_FAKES_MAX_SERVICES || mocks >= PLAN_SETUP_MOCKS_MAX) { left.push({ id: item.id, reason: "too_many" }); continue; }
      services.push({ variable: item.variable, spec: item.spec });
      mocks += 1;
      used.push(item.id);
    } else left.push({ id: item.id, reason: "not_carried" });
  }
  if (used.length === 0) return undefined;
  const addedMocks = items.some((item) => item.kind === "mock" && used.includes(item.id));
  const addedSetup = items.some((item) => item.kind === "command" && item.area === "setup" && used.includes(item.id));
  const addedTests = items.some((item) => item.kind === "command" && item.area === "test" && used.includes(item.id));
  return {
    candidate: {
      ...definition, revision: definition.revision + 1, setup, readiness,
      ...(addedMocks ? { generalFakes: { enabled: true, services } } : {}),
      origins: { ...(definition.origins ?? {}), ...(addedSetup ? { setup: "agent" } : {}), ...(addedTests ? { readiness: "agent" } : {}) },
    },
    used, left,
  };
}

export interface SetupUpdateAct { taskId: string; requestId: string }

/**
 * "Update setup": makes a CANDIDATE of the project's setup from the offer's items and starts its check (`storeSetupCandidate`). The caller (the route) has checked that this person manages the project's setup and has
 * recorded the act. The offer must still be offered, belong to this company and project, and hold items that still hash to the digest recorded; another waiting proposal refuses. The offer moves to `prepared` in the
 * candidate's own transaction. Nothing is approved here.
 */
export async function prepareSetupUpdate(deps: SetupApplyDeps, project: string, act: SetupUpdateAct, by: string): Promise<Record<string, unknown>> {
  const orgId = deps.companyId;
  const offer = offerOf(await deps.store.get(setupUpdateKey(orgId, project, act.taskId)), orgId, project);
  if (offer === undefined || offer.state !== "offered") throw agentXError("CHANGE_STALE", SETUP_UPDATE_WORDS.gone);
  if ((await waitingSetupApply(deps.store, orgId, project)) !== undefined) throw agentXError("WORKSPACE_BUSY", SETUP_UPDATE_WORDS.waiting);
  const latest = await deps.flow.projects.latest(project);
  if (latest === undefined) throw agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist`);
  const built = candidateFromPlanItems(latest.definition, offer.items);
  if (built === undefined) throw agentXError("CONFIG_INVALID", SETUP_UPDATE_WORDS.nothing);
  const parsed = ProjectDefinitionSchema.safeParse(built.candidate);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", SETUP_UPDATE_WORDS.nothing);
  return storeSetupCandidate(deps, {
    project, by, requestId: act.requestId, taskId: act.taskId, baseRevision: latest.definition.revision, candidate: parsed.data,
    replyExtra: { used: built.used, left: built.left, fromPlan: { taskId: act.taskId, changes: offer.items.length } },
    // The offer is only CHECKED: its row is not changed by making a candidate (see the file comment).
    alsoTransact: [{ kind: "check", key: setupUpdateKey(orgId, project, act.taskId), condition: when.eq("state", "offered") }],
  });
}

/** The task whose offer a waiting or decided candidate came from (the reply `prepareSetupUpdate` stored), or undefined for a candidate made another way. */
export function fromPlanTaskOf(reply: unknown): string | undefined {
  const from = typeof reply === "object" && reply !== null && !Array.isArray(reply) ? (reply as Record<string, unknown>)["fromPlan"] : undefined;
  const taskId = typeof from === "object" && from !== null && !Array.isArray(from) ? (from as Record<string, unknown>)["taskId"] : undefined;
  return typeof taskId === "string" && /^[A-Za-z0-9_-]{1,100}$/u.test(taskId) ? taskId : undefined;
}

/** After an approval of a candidate that came from an offer: the offer is applied (not offered again). Best effort and never throws; only an offer that is still offered changes. */
export async function markSetupUpdateApplied(deps: Pick<SetupApplyDeps, "store" | "companyId" | "now">, project: string, reply: unknown, by: string): Promise<void> {
  const taskId = fromPlanTaskOf(reply);
  if (taskId === undefined) return;
  try {
    await deps.store.transact([{ kind: "update", key: setupUpdateKey(deps.companyId, project, taskId), ops: [change.set("state", "applied"), change.set("decidedAt", new Date(deps.now()).toISOString()), change.set("decidedBy", by)], condition: when.eq("state", "offered") }]);
  } catch { /* the offer shows again and says every change is already there */ }
}

/** "Not now": the offer is dismissed (no candidate is made, nothing changes in the project). Answers whether an offer was dismissed. */
export async function dismissSetupUpdate(deps: Pick<SetupApplyDeps, "store" | "companyId" | "now">, project: string, act: Pick<SetupUpdateAct, "taskId">, by: string): Promise<boolean> {
  const orgId = deps.companyId;
  const offer = offerOf(await deps.store.get(setupUpdateKey(orgId, project, act.taskId)), orgId, project);
  if (offer === undefined || offer.state !== "offered") return false;
  const result = await deps.store.transact([
    { kind: "update", key: setupUpdateKey(orgId, project, act.taskId), ops: [change.set("state", "dismissed"), change.set("decidedAt", new Date(deps.now()).toISOString()), change.set("decidedBy", by)], condition: when.eq("state", "offered") },
  ]);
  return result.applied;
}
