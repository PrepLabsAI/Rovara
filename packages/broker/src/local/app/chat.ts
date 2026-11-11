// Chat on a laptop (owner decision 58: a chat tool is an ordinary `channel` adapter). This is what `rovara up` adds around the adapters the registry holds:
//
//   the owner's own acts   linking a chat account to the owner, binding a space to a project, choosing where notices go and muting them. They are made on the local chat page only (`core/local-pages`): each one lets a chat
//                          account act as the owner or sends task titles to a place, so none is reachable with the API token an AI tool may hold. The reads (what is set up) are open to that token and show no code and no token.
//   what a chat may do     a message from a linked account in a bound space starts work on the space's project, the same start as `rovara session start`, with the conversation remembered so what the task later needs is told there
//                          too; a decision that comes back from a card is handed to the approval gate as a credential of the chat's own method (`chat-<channel>`), which Code's approvers do not offer: the plan is decided on its page.
import { createHash } from "node:crypto";
import {
  AgentXError, ChannelSpaceRefSchema, agentXError, maskChannelUserId, type AdapterRegistry, type ChannelAdapter, type ChannelDecision, type DocumentStore, type OrgId, type Principal,
} from "@agentx/contracts";
import { bindChannelSpace, listAllChannelBindings, unbindChannelSpace } from "../../core/channel/bindings.js";
import type { ApprovalCard } from "../../core/channel/cards.js";
import { listChannelLinks, previewChannelLinkCode, redeemChannelLinkCode, removeChannelLink } from "../../core/channel/links.js";
import type { ChannelDecisionAnswer, ChannelWork } from "../../core/channel/sink.js";
import { recordTaskThread } from "../../core/channel/threads.js";
import type { DecisionGate, DecisionOutcome } from "../../core/decisions/approval-gate.js";
import { CHAT_METHOD_PREFIX } from "../../core/decisions/strong-methods.js";
import type { ChatPageView, LocalActionResult, LocalPageActions } from "../../core/local-pages/index.js";
import { NOTIFY_TARGETS_MAX, readNotifyPrefs, writeNotifyPrefs, type NotifyTarget } from "../../core/notify/index.js";
import { developerIdOf, taskSessionId } from "../../core/sessions/create.js";
import type { TaskFlow } from "../../core/task-flow/flow.js";
import type { BrokerRequest, BrokerResponse } from "../../handler.js";
import { listProjects } from "./projects.js";

type Log = (entry: Record<string, unknown>) => void;

export interface LocalChatDeps {
  registry: Pick<AdapterRegistry, "get" | "names">;
  flow: TaskFlow;
  store: DocumentStore;
  companyId: OrgId;
  owner: Principal;
  now: () => number;
  /** The approval gate, for the decision of a card. */
  gate: Pick<DecisionGate, "decide">;
  log?: Log | undefined;
}

/** The credential method a chat adapter's decision carries: `chat-<channel>`. An approvers plug-in that wants to take chat decisions names it; Code's does not. */
export const chatDecisionMethod = (channel: string): string => `${CHAT_METHOD_PREFIX}${channel}`;

const OUTCOME_OF: Readonly<Record<ChannelDecision["decision"], DecisionOutcome | undefined>> = { APPROVE: "approve", REJECT: "reject", REQUEST_CHANGES: "request_changes", SKIP: undefined };

/** A UUID made from a text, so the same chat message always asks for the same start and a repeat starts nothing new. */
function uuidOf(text: string): string {
  const hex = createHash("sha256").update(`chat-start\0${text}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
const refusal = (error: unknown, fallback: string): LocalActionResult => {
  if (error instanceof AgentXError) return { ok: false, reason: error.code === "NOT_FOUND" ? "not_found" : error.code === "CHANGE_STALE" ? "stale" : "refused", message: error.message.slice(error.code.length + 2) };
  return { ok: false, reason: "invalid", message: fallback };
};

export interface LocalChat {
  /** The page's read side; undefined when no chat adapter is set up here. */
  view(): Promise<ChatPageView | undefined>;
  preview(code: string): Promise<{ channel: string; tenant: string; userId: string } | undefined>;
  /** The page's write side: the owner's own acts. */
  actions: Required<Pick<LocalPageActions, "linkChatAccount" | "unlinkChatAccount" | "bindChatSpace" | "unbindChatSpace" | "addNoticeTarget" | "removeNoticeTarget" | "muteNotices">>;
  /** What the adapters hand the core once the sink has checked it. */
  work(channel: string): ChannelWork;
  /** The read routes (`GET /v1/app/me/notifications`, `GET /v1/app/channel`). Nothing here changes anything. */
  routes(request: BrokerRequest): Promise<BrokerResponse | undefined>;
}

export function createLocalChat(deps: LocalChatDeps): LocalChat {
  const { store, companyId: orgId } = deps;
  const log: Log = deps.log ?? (() => undefined);
  const ownerId = developerIdOf(deps.owner);
  const links = { store, orgId, now: deps.now };
  const adapterOf = (channel: string): ChannelAdapter | undefined => deps.registry.get("channel", channel);

  const view = async (): Promise<ChatPageView | undefined> => {
    const names = deps.registry.names("channel");
    if (names.length === 0) return undefined;
    const prefs = await readNotifyPrefs(store, orgId, ownerId);
    return {
      adapters: names.flatMap((name) => {
        const adapter = adapterOf(name);
        return adapter === undefined ? [] : [{ name, projects: [...adapter.projects], proactive: adapter.capabilities.proactive, buttons: adapter.capabilities.buttons, ...(adapter.noThread === undefined ? {} : { noThread: adapter.noThread }) }];
      }),
      links: (await listChannelLinks(links, ownerId)).map((link) => ({ channel: link.actor.channel, tenant: link.actor.tenant, userId: link.actor.userId, maskedUserId: maskChannelUserId(link.actor.userId), linkedAt: link.linkedAt })),
      bindings: (await listAllChannelBindings({ store, orgId })).map((binding) => ({ channel: binding.channel, tenant: binding.tenant, space: binding.space, project: binding.projectName })),
      projects: (await listProjects(store, orgId)).map((project) => project.name),
      notify: { muted: prefs.muted, targets: prefs.targets.map((target) => ({ channel: target.channel, tenant: target.conversation.tenant, space: target.conversation.space, thread: target.conversation.thread })) },
    };
  };

  async function changeTargets(change: (targets: NotifyTarget[]) => NotifyTarget[] | undefined, muted?: boolean): Promise<LocalActionResult> {
    const prefs = await readNotifyPrefs(store, orgId, ownerId);
    const targets = change(prefs.targets);
    if (targets === undefined) return { ok: false, reason: "invalid", message: "That could not be added." };
    if (targets.length > NOTIFY_TARGETS_MAX) return { ok: false, reason: "refused", message: `You can be told in at most ${String(NOTIFY_TARGETS_MAX)} places.` };
    try {
      await writeNotifyPrefs({ store, now: () => new Date(deps.now()) }, orgId, ownerId, { targets, muted: muted ?? prefs.muted });
    } catch {
      return { ok: false, reason: "invalid", message: "That place is not valid for this chat." };
    }
    return { ok: true };
  }

  const actions: LocalChat["actions"] = {
    async linkChatAccount({ code }) {
      try {
        await redeemChannelLinkCode(links, ownerId, code);
        return { ok: true };
      } catch (error) {
        return refusal(error, "That code is not valid.");
      }
    },
    async unlinkChatAccount({ channel, tenant, userId }) {
      try {
        await removeChannelLink(links, { channel, tenant, userId }, ownerId);
        return { ok: true };
      } catch (error) {
        return refusal(error, "That account is not valid.");
      }
    },
    async bindChatSpace({ channel, tenant, space, project }) {
      const adapter = adapterOf(channel);
      if (adapter === undefined) return { ok: false, reason: "not_found", message: "No such chat is set up here." };
      if (!adapter.projects.includes(project)) return { ok: false, reason: "refused", message: "That chat does not serve that project. Name the project in the chat plug-in's settings first." };
      if (!(await listProjects(store, orgId)).some((entry) => entry.name === project)) return { ok: false, reason: "not_found", message: "No such project is registered." };
      if (!ChannelSpaceRefSchema.safeParse({ channel, tenant, space }).success) return { ok: false, reason: "invalid", message: "That is not a space of this chat." };
      try {
        await bindChannelSpace({ store, orgId, now: deps.now }, { channel, tenant, space }, project);
        return { ok: true };
      } catch (error) {
        return refusal(error, "That could not be bound.");
      }
    },
    async unbindChatSpace({ channel, tenant, space }) {
      if (!ChannelSpaceRefSchema.safeParse({ channel, tenant, space }).success) return { ok: false, reason: "invalid", message: "That is not a space of this chat." };
      return (await unbindChannelSpace({ store, orgId }, { channel, tenant, space })) ? { ok: true } : { ok: false, reason: "not_found", message: "That space was not bound." };
    },
    async addNoticeTarget({ channel, tenant, space, thread }) {
      const adapter = adapterOf(channel);
      if (adapter === undefined) return { ok: false, reason: "not_found", message: "No such chat is set up here." };
      const named = thread ?? adapter.noThread;
      if (named === undefined) return { ok: false, reason: "invalid", message: "Name the thread: this chat has no top of the space." };
      return changeTargets((targets) => [...targets.filter((target) => !(target.channel === channel && target.conversation.tenant === tenant && target.conversation.space === space && target.conversation.thread === named)), { channel, conversation: { channel, tenant, space, thread: named } }]);
    },
    async removeNoticeTarget({ channel, tenant, space, thread }) {
      return changeTargets((targets) => targets.filter((target) => !(target.channel === channel && target.conversation.tenant === tenant && target.conversation.space === space && target.conversation.thread === thread)));
    },
    async muteNotices({ muted }) {
      return changeTargets((targets) => targets, muted);
    },
  };

  const work = (channel: string): ChannelWork => ({
    async message({ message, projectName, personId }) {
      // One owner: a link to anyone else (a stale row from another install) starts nothing.
      if (personId !== ownerId) { log({ event: "chat.not_the_owner", channel }); return; }
      const started = await deps.flow.start({ principal: deps.owner, client: channel }, { project: projectName, instructions: message.text, requestId: uuidOf(`${channel}/${message.eventId}`), workflow: true });
      await recordTaskThread({ store, orgId, now: deps.now }, { sessionId: taskSessionId(started.task.taskId), conversation: message.conversation, personId });
    },
    async decide({ card, decision, personId }: { card: ApprovalCard; decision: ChannelDecision; personId: string; projectName: string }): Promise<ChannelDecisionAnswer> {
      const outcome = OUTCOME_OF[decision.decision];
      if (personId !== ownerId || outcome === undefined) return { status: "refused", reason: "invalid" };
      const result = await deps.gate.decide({
        companyId: orgId, kind: card.subject.type, subjectId: card.subject.id, requestId: card.requestId, outcome, seen: { revision: card.revision, artifactDigest: card.artifactDigest },
        // The credential names the account that pressed (the sink already matched it to the owner); it is a claim for the approvers plug-in to check against its own identity data, never believed by the gate. A `chat-*` method
        // can never be a strong method (`isCommentMethod`): the gate refuses it for a high-risk approval and a rejection whatever the plug-in names.
        credentials: [{ method: chatDecisionMethod(card.channel), token: decision.eventId, claimedAccount: { provider: card.channel, tenant: decision.actor.tenant, accountId: decision.actor.userId } }], reason: decision.reason,
      });
      return result.status === "refused" ? { status: "refused", reason: result.reason } : { status: "decided" };
    },
  });

  const routes = async (request: BrokerRequest): Promise<BrokerResponse | undefined> => {
    const path = request.path.split("?")[0] ?? request.path;
    if (path !== "/v1/app/me/notifications" && path !== "/v1/app/channel") return undefined;
    try {
      if (request.method !== "GET") throw agentXError("NOT_FOUND", "route not found");
      if (path === "/v1/app/me/notifications") {
        const prefs = await readNotifyPrefs(store, orgId, ownerId);
        return json(200, {
          targets: prefs.targets, muted: prefs.muted,
          channels: deps.registry.names("channel").flatMap((name) => { const adapter = adapterOf(name); return adapter === undefined ? [] : [{ channel: name, proactive: adapter.capabilities.proactive }]; }),
          changeOn: "the chat page: run `rovara chat`",
        });
      }
      const shown = await view();
      return json(200, shown === undefined ? { adapters: [], links: [], bindings: [], changeOn: "the chat page: run `rovara chat`" } : { adapters: shown.adapters, links: shown.links.map((link) => ({ channel: link.channel, tenant: link.tenant, maskedUserId: link.maskedUserId, linkedAt: link.linkedAt })), bindings: shown.bindings, changeOn: "the chat page: run `rovara chat`" });
    } catch (error) {
      if (error instanceof AgentXError) return json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
      throw error;
    }
  };

  return { view, preview: (code) => previewChannelLinkCode(links, code), actions, work, routes };
}
