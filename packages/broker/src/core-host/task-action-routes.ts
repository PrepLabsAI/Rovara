// S1: the task action registry on the hosted core, in process (no HTTP request is made or faked). `CoreDevRoutes.taskActions` answers what one task offers a person now; `CoreDevRoutes.taskAction` takes a press (or the describe of one)
// that a chat surface made, as a request for the registry to judge again (`core/task-actions`): the chat account is the caller's own NOW (the same person resolver and workspace checks as the chat decision), the surface is bound HERE
// (the audit names the chat, never anything the press says), and the move is made under the chat link's own fence where the chat account is a link.
//
// What this file adds to the registry, and nothing else: the host's capabilities (the plan's card facts and its decision through the approval gate with the chat's method, the merge core's own press, the People moves) and the chat account
// checks. Every right is still the registry's `who` rule and the engine's own.
import {
  AgentXError, type ActionDescription, type ActionOffer, type ActionResult, type ActionValues, type ActorRef, type ConversationRef, type OrgId, type OrgRole,
} from "@agentx/contracts";
import { channelLinkFence } from "../core/channel/links.js";
import { tenantIsCompanys } from "../core/channel/company.js";
import { auditViaCaller } from "../core/audit-read/index.js";
import type { DecisionGate } from "../core/decisions/approval-gate.js";
import { WORKFLOW_DOCUMENT_CARD_KINDS } from "../core/decisions/performer.js";
import { projectDecisionCards } from "../core/decisions/project.js";
import { WORKFLOW_DOCUMENT_KIND } from "../core/decisions/workflow-subject.js";
import { developerIdOf } from "../core/sessions/create.js";
import { describeAction, performRegistryAction, type ActionCaller, type ActionEnv, type MergeHost, type PeopleHost, type PlanFacts, type PlanHost } from "../core/task-actions/index.js";
import { refusal } from "../core/task-actions/judge.js";
import type { TaskFlowDeps } from "../core/task-flow/deps.js";
import { readTask } from "../core/task-flow/reads.js";
import { taskStandingFor, type TaskStanding } from "../core/task-view/index.js";
import type { TaskRecord } from "../core/task-flow/records.js";
import type { ChatThreads } from "./chat-threads.js";
import { chatApprovalMethod, chatPressToken } from "./hosted-chat-approval.js";
import { fencedFlow } from "./parity-task-actions.js";
import { hostedMergePressAsPerson, hostedMergeReadiness, hostedMergeStanding, type HostedMergeInput } from "./hosted-merge-routes.js";
import type { CompanyMembership, CoreDevWiring, DeployedCaller, DeployedDecisionCaller } from "./dev-routes.js";
import type { CoreRuntime } from "./core-runtime.js";
import { orIfNotMembershipFailure } from "../core/membership-read.js";

/** What the hosted install gives the registry for a chat: the chat seam (which company a workspace is, which person an account is), the install's proof key, and the company's approval gate. */
export interface TaskActionChat {
  threads: Pick<ChatThreads, "companyOf" | "adapterFor" | "personOf">;
  proofKey: Buffer;
  /** The company's decision gate (the web's, with the chat's method offered): rebuilt per press, as the chat decision's is. */
  gateFor(runtime: CoreRuntime, companyId: OrgId): Promise<DecisionGate> | DecisionGate;
}

/** The chat account that pressed, with the conversation (the thread's own workspace) the card is in. Set only by the broker's Slack event, never copied from a body. */
export interface ChatPresser { conversation: ConversationRef; actor: ActorRef }

export type TaskActionInput =
  | ({ mode: "describe"; actionId: string; taskId: string; binding: unknown; values?: ActionValues | undefined } & ChatPresser)
  | ({ mode: "perform"; actionId: string; taskId: string; binding: unknown; values?: ActionValues | undefined; confirmDigest?: string | undefined; requestKey: string } & ChatPresser);

export type TaskActionAnswer = { mode: "describe"; description: ActionDescription } | { mode: "perform"; result: ActionResult };

export interface TaskActionMount { runtime: CoreRuntime; wiring: CoreDevWiring }

export interface TaskActionRoutesOptions {
  companyOf(caller: DeployedCaller): Promise<CompanyMembership | undefined>;
  mount(companyId: string): Promise<TaskActionMount>;
  chat: TaskActionChat | undefined;
  now: () => number;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

const ORG_ID = /^org_[0-9a-z]{20}$/u;

function callerOf(deployed: DeployedCaller, role: OrgRole): ActionCaller {
  return { principal: deployed.principal, ...(deployed.slackUserId === undefined ? {} : { slackUserId: deployed.slackUserId }), ...(deployed.client === undefined ? {} : { client: deployed.client }), companyRole: role };
}

const decisionCallerOf = (caller: ActionCaller, companyId: string): DeployedDecisionCaller => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- legacy sign-in claims are dropped
  const { authTime: _authTime, methods: _methods, ...principal } = caller.principal;
  return { orgId: companyId, developerId: developerIdOf(caller.principal), principal };
};

/** The plan's card facts for this person, and the decision through the approval gate with the chat's method (`hosted-chat-approval.ts`): the same gate, the same approvers, the same refusals as the web. */
function planHostFor(input: { runtime: CoreRuntime; wiring: CoreDevWiring; chat: TaskActionChat; presser: ChatPresser; fence: ReturnType<typeof channelLinkFence>[] }): PlanHost {
  // The gate builds its audit on the runtime's own sink: it is stamped with the surface (`via`, from the verified chat) so the decision's audit row says Slack as every other move of this entry does.
  const stamped = (runtime: CoreRuntime): CoreRuntime => ({ ...runtime, flow: { ...runtime.flow, deps: { ...runtime.flow.deps, audit: auditViaCaller(runtime.flow.deps.audit, input.presser.actor.channel) } } });
  const { runtime, wiring, chat, presser } = input;
  const companyId = runtime.companyId;
  return {
    async facts(caller, task): Promise<PlanFacts | undefined> {
      const sources = wiring.decisions?.sources;
      if (sources === undefined) return undefined;
      const decisionCaller = decisionCallerOf(caller, companyId);
      const [items, locks] = await Promise.all([sources.list(decisionCaller), sources.locks(decisionCaller)]);
      const item = items.find((candidate) => candidate.taskId === task.taskId && WORKFLOW_DOCUMENT_CARD_KINDS.includes(candidate.kind));
      if (item === undefined) return undefined;
      const card = projectDecisionCards([item], { locks }).cards[0];
      if (card === undefined) return undefined;
      const reasonRequired = item.kind === "approve_design" && (item.review?.blockers.length ?? 0) > 0;
      const files = "files" in item ? item.files.length : undefined;
      return {
        risk: card.risk, riskReasons: card.riskReasons, reasonRequired, next: card.next.text,
        ...(card.runLimit === undefined ? {} : { runLimit: card.runLimit }), ...(files === undefined ? {} : { filesTouched: files }),
      };
    },
    async decide(decision) {
      if (decision.binding.digest === undefined) return { status: "refused", reason: "stale" };
      const gate = await chat.gateFor(stamped(runtime), companyId);
      const outcome = decision.outcome;
      const token = chatPressToken(chat.proofKey, {
        companyId, requestId: decision.requestId, revision: decision.binding.revision, artifactDigest: decision.binding.digest, outcome, tenant: presser.actor.tenant, userId: presser.actor.userId,
      });
      const details = {
        ...(decision.selectedOptionalCheckIds === undefined ? {} : { selectedOptionalCheckIds: decision.selectedOptionalCheckIds }),
        ...(decision.acknowledgedRunLimitUsd === undefined ? {} : { acknowledgedRunLimitUsd: decision.acknowledgedRunLimitUsd }),
      };
      const result = await gate.decide({
        companyId, kind: WORKFLOW_DOCUMENT_KIND, subjectId: decision.task.taskId, requestId: decision.requestId, outcome, seen: { revision: decision.binding.revision, artifactDigest: decision.binding.digest },
        credentials: [{ method: chatApprovalMethod(presser.conversation.channel), token, claimedAccount: { provider: presser.conversation.channel, tenant: presser.actor.tenant, accountId: presser.actor.userId } }],
        ...(decision.reason === undefined ? {} : { reason: decision.reason }), fence: input.fence, details,
      });
      if (result.status === "refused") return { status: "refused", reason: result.reason };
      return { status: result.status === "replayed" ? "replayed" : "decided" };
    },
  };
}

/** The merge core's own press, as the person: its WHO rule, its lock, its audit and its gates, bound to the heads and risk the confirm showed. */
function mergeHostFor(input: { runtime: CoreRuntime; flow: TaskFlowDeps; wiring: CoreDevWiring; membership: CompanyMembership; now: () => number; audit: TaskFlowDeps["audit"]; log: TaskActionRoutesOptions["log"] }): MergeHost | undefined {
  const { wiring, membership } = input;
  const merge = wiring.merge;
  if (merge === undefined) return undefined;
  const inputFor = (caller: ActionCaller, taskId: string): HostedMergeInput => ({
    request: { method: "POST", path: `/v1/app/tasks/${taskId}/merge`, headers: {} }, path: `/v1/app/tasks/${taskId}/merge`, principal: caller.principal, companyId: membership.companyId, role: membership.role,
    flow: input.flow, wiring: merge, audit: input.audit, now: input.now, ...(input.log === undefined ? {} : { log: input.log }),
  });
  return {
    async standing(caller, task) {
      const found = await hostedMergeStanding(inputFor(caller, task.taskId), merge, task.taskId).catch(() => undefined);
      return { may: found?.may !== undefined };
    },
    async readiness(caller, task) {
      return await hostedMergeReadiness(inputFor(caller, task.taskId), merge.merge(input.audit), task);
    },
    async press(caller, task, body) {
      const found = await hostedMergeStanding(inputFor(caller, task.taskId), merge, task.taskId);
      if (found.may === undefined) throw new AgentXError("FORBIDDEN", "FORBIDDEN: only the task's owner, a co-owner, a project admin or a company admin can merge this task", 403, { reason: "not_yours", writes: "none" });
      await hostedMergePressAsPerson(inputFor(caller, task.taskId), merge, task.taskId, found.may, body);
    },
  };
}

/** The refusal of a move whose chat account was unlinked while the request ran. */
const unlinkedMidRequest = (): AgentXError => new AgentXError("SLACK_ACCOUNT_NOT_LINKED", "SLACK_ACCOUNT_NOT_LINKED: the chat account is no longer linked", 403, { reason: "not_linked", writes: "none" });

/**
 * The writes that cannot join the core store's transaction (the merge on GitHub, and the People write in the state table) read the chat link AGAIN, just before they are made, so an unlink that landed since the press was checked refuses them
 * (the window is that one call). Everything that does commit through the core store carries `channelLinkFence` itself.
 */
export function relinkedBefore(recheck: () => Promise<boolean>): { merge(host: MergeHost | undefined): MergeHost | undefined; people(host: PeopleHost | undefined): PeopleHost | undefined } {
  const guard = async (): Promise<void> => { if (!(await recheck())) throw unlinkedMidRequest(); };
  return {
    merge: (host) => host === undefined ? undefined : { ...host, press: async (caller, task, body) => { await guard(); await host.press(caller, task, body); } },
    people: (host) => host === undefined ? undefined : { ...host, takeOwnership: async (caller, task, body) => { await guard(); await host.takeOwnership(caller, task, body); } },
  };
}

function peopleHostFor(wiring: CoreDevWiring, runtime: CoreRuntime): PeopleHost | undefined {
  const people = wiring.taskRules?.people;
  if (people === undefined) return undefined;
  const ofTask = (caller: ActionCaller, task: TaskRecord) => ({ person: { developerId: caller.principal.personId, name: caller.principal.displayName }, companyId: runtime.companyId, task: task as unknown as Record<string, unknown> });
  return {
    view: async (caller, task) => {
      const view = await people.view(ofTask(caller, task)).catch(() => undefined);
      return view === undefined ? undefined : { lines: view.people.map((person) => `${person.you ? "You" : person.name}: ${person.role}`).concat(view.orphaned ? ["Nobody owns this task now."] : []) };
    },
    canTakeOwnership: async (caller, task) => {
      const view = await people.view(ofTask(caller, task)).catch(() => undefined);
      return view !== undefined && view.canTakeOwnership ? { peopleRevision: view.revision } : undefined;
    },
    takeOwnership: async (caller, task, request) => { await people.takeOwnership({ ...ofTask(caller, task), ...request }); },
  };
}

export function createTaskActionRoutes(options: TaskActionRoutesOptions) {
  /** The registry's environment for one company, or undefined when the deployment does not serve the owner's moves there (they need the company's owner rule and the money cap). */
  function envOf(target: TaskActionMount, membership: CompanyMembership, deps: TaskFlowDeps, plan: PlanHost | undefined, relink?: ReturnType<typeof relinkedBefore>): ActionEnv | undefined {
    const roundCap = target.wiring.taskActions?.roundCap;
    if (roundCap === undefined || target.runtime.flow.deps.access.ownerActing === undefined) return undefined;
    const merge = (relink?.merge ?? ((host: MergeHost | undefined) => host))(mergeHostFor({ runtime: target.runtime, flow: deps, wiring: target.wiring, membership, now: options.now, audit: deps.audit, log: options.log }));
    const people = (relink?.people ?? ((host: PeopleHost | undefined) => host))(peopleHostFor(target.wiring, target.runtime));
    return { deps, options: { roundCap }, ...(plan === undefined ? {} : { plan }), ...(merge === undefined ? {} : { merge }), ...(people === undefined ? {} : { people }) };
  }

  async function standingOf(target: TaskActionMount, membership: CompanyMembership, deployed: DeployedCaller, task: TaskRecord): Promise<TaskStanding | undefined> {
    const env = envOf(target, membership, target.runtime.flow.deps, undefined);
    return env === undefined ? undefined : taskStandingFor(env, callerOf(deployed, membership.role), task);
  }

  async function membershipOf(deployed: DeployedCaller): Promise<CompanyMembership | undefined> {
    const membership = await options.companyOf(deployed).catch(orIfNotMembershipFailure(undefined));
    return membership !== undefined && typeof membership.companyId === "string" && ORG_ID.test(membership.companyId) && deployed.principal.companyId === membership.companyId ? membership : undefined;
  }

  /** The chat account is the caller's own, now, in a workspace that is the task's company's (step 1 of a press). Returns the link fence, or the refusal. */
  async function chatStanding(chat: TaskActionChat, companyId: OrgId, deployed: DeployedCaller, presser: ChatPresser) {
    const { conversation, actor } = presser;
    if (actor.channel !== conversation.channel || actor.tenant !== conversation.tenant || chat.threads.adapterFor(companyId, conversation.channel) === undefined) return refusal("TASK_NOT_FOUND", "not_found");
    if (!(await tenantIsCompanys(chat.threads.companyOf, companyId, conversation.channel, conversation.tenant))) return refusal("TASK_NOT_FOUND", "not_found");
    const found = chat.threads.personOf === undefined ? undefined : await chat.threads.personOf(companyId, actor).catch(() => undefined);
    if (found === undefined || found.personId !== deployed.principal.personId) return refusal("SLACK_ACCOUNT_NOT_LINKED", "not_linked");
    return { fence: found.via === "link" ? [channelLinkFence(companyId, actor, found.personId)] : [] };
  }

  return {
    /** What one task offers this person now (the registry's `actionsFor`), or undefined when the deployment does not serve the registry for this person's company. */
    async taskActions(deployed: DeployedCaller, taskId: string): Promise<ActionOffer[] | undefined> {
      const membership = await membershipOf(deployed);
      if (membership === undefined) return undefined;
      const target = await options.mount(membership.companyId);
      const task = await readTask(target.runtime.flow.deps, taskId);
      if (task === undefined || task.companyId !== membership.companyId) return undefined;
      // F2-B: the offers are the standing's own `actions` (the same call, not a copy); a person with no standing is offered nothing.
      const served = await standingOf(target, membership, deployed, task);
      return served === undefined ? (envOf(target, membership, target.runtime.flow.deps, undefined) === undefined ? undefined : []) : served.standing.actions;
    },

    /** F2-B: where one task stands for this person now (the one rule `taskStandingFor`: pill, step, the person-free status line, the offers), or undefined when the deployment does not serve the registry for this person's company or the person has no standing. */
    async taskStanding(deployed: DeployedCaller, taskId: string): Promise<TaskStanding | undefined> {
      const membership = await membershipOf(deployed);
      if (membership === undefined) return undefined;
      const target = await options.mount(membership.companyId);
      const task = await readTask(target.runtime.flow.deps, taskId);
      return task === undefined || task.companyId !== membership.companyId ? undefined : standingOf(target, membership, deployed, task);
    },

    /** F2-B: the same, for a task a route has already read, with the membership it already resolved (the web task read serves it with every answer). */
    standingFor: standingOf,

    /** A chat press, or the describe of one. Always an answer (a refusal is one); a throw means nothing was done and the chat may press again. */
    async taskAction(deployed: DeployedCaller, input: TaskActionInput): Promise<TaskActionAnswer> {
      const refused = (reason: ReturnType<typeof refusal>): TaskActionAnswer => input.mode === "describe"
        ? { mode: "describe", description: { status: "refused", code: reason.code, reason: reason.reason } }
        : { mode: "perform", result: { status: "refused", ...reason } };
      const membership = await membershipOf(deployed);
      if (membership === undefined || options.chat === undefined || !ORG_ID.test(membership.companyId)) return refused(refusal("TASK_NOT_FOUND", "not_found"));
      const companyId = membership.companyId;
      const standing = await chatStanding(options.chat, companyId, deployed, input);
      if ("reason" in standing) return refused(standing);
      const target = await options.mount(companyId);
      // The surface is bound here, from the verified chat; the link's fence joins every transaction of the move.
      const via = input.actor.channel;
      const fenced = standing.fence.length === 0 ? target.runtime.flow.deps : fencedFlow(target.runtime.flow.deps, standing.fence);
      const plan = planHostFor({ runtime: target.runtime, wiring: target.wiring, chat: options.chat, presser: input, fence: standing.fence });
      const deps: TaskFlowDeps = { ...fenced, audit: auditViaCaller(fenced.audit, via) };
      const relink = relinkedBefore(async () => !("reason" in await chatStanding(options.chat!, companyId, deployed, input)));
      const env = envOf(target, membership, deps, plan, relink);
      if (env === undefined) return refused(refusal("TASK_ACTION_NOT_OFFERED", "not_offered"));
      const caller = callerOf(deployed, membership.role);
      if (input.mode === "describe") return { mode: "describe", description: await describeAction(env, caller, input) };
      return { mode: "perform", result: await performRegistryAction(env, caller, { ...input, via }) };
    },
  };
}


/** The chat the registry takes presses from, when the install serves a chat that can name a person (the chat's own seam, the install's proof key and the company's approval gate); undefined otherwise. */
export function taskActionChatOf(approval: unknown, threads: TaskActionChat["threads"] | undefined, proofKey: Buffer, gateFor: TaskActionChat["gateFor"]): TaskActionChat | undefined {
  return approval === undefined || threads?.personOf === undefined ? undefined : { threads, proofKey, gateFor };
}
