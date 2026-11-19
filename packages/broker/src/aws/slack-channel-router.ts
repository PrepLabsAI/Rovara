import type { SlackCompanyDependencies } from "./slack-person.js";
// Spec 062 Phase 7c2: Slack's request routing, run by the channel API for the built-in Slack adapter. The router is the
// one Slack's own ingress runs (slack-ingress.ts): stops, ChatGPT commands, task threads' notes, Quick or Full answers,
// new tasks, the per-thread limit, and requests for the orchestrator. Here what it says goes through the adapter's
// commands, and what it queues goes on the channel request queue, in the conversation's order.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  conversationFromSlackThread,
  inboundFromSlackRequest,
  slackThreadSubject,
  type ChannelQueueItem,
  type DirectoryUser,
  type QueuedRouting,
  type SlackRequestMessage,
} from "@agentx/contracts";
import { checkEndpointAddresses } from "@agentx/gateway";
import { builtInAdapterFromEnvironment } from "./channel-adapters.js";
import { sendChannelCommand } from "./channel-commands.js";
import { conversationGroupId, queueItemIdentity, type ChannelSurface } from "./channel-ingress.js";
import { requiredEnvironment } from "./lambda.js";
import { slackAdapterSecretReader } from "./slack-adapter.js";
import { awsSlackRouterDependencies, createSlackMentionRouter, slackMentionOfInbound, threadPendingCounter, type SlackRouterTransport } from "./slack-ingress.js";
import type { SlackMemberCheck } from "./slack-members.js";
import { slackNoticeChannelForCurrentTeam, type SlackNoticeChannel } from "./slack-notice-channel.js";

const MEMBER_TTL_MS = 60 * 60 * 1_000;
const MEMBER_CACHE_CAP = 5_000;

export interface SlackChannelTransportDependencies {
  notices: SlackNoticeChannel;
  /** A person as the adapter's directory knows them, or undefined for someone it does not know. */
  user(userId: string): Promise<DirectoryUser | undefined>;
  /** Queues an item on the channel request queue, in its conversation's group. */
  enqueue(item: ChannelQueueItem, groupId: string): Promise<void>;
  changePending(threadSubject: string, delta: 1 | -1): Promise<number>;
  /** The bound project of the message being routed. */
  projectName(): string;
  teamId?: () => string | undefined;
  now?: () => number;
}

/** The router's transport through the Slack adapter and the channel request queue. */
export function slackChannelTransport(deps: SlackChannelTransportDependencies): SlackRouterTransport {
  const now = deps.now ?? Date.now;
  const members = new Map<string, { check: SlackMemberCheck; at: number }>();
  const queue = async (message: SlackRequestMessage, extra: { queuedBehind?: number; routing?: QueuedRouting }) => {
    const item: ChannelQueueItem = { kind: "message", message: inboundFromSlackRequest(message), projectName: deps.projectName(), stepUp: [], ...extra };
    await deps.enqueue(item, conversationGroupId(conversationFromSlackThread(message.thread)));
  };
  return {
    async postMessage(input) {
      return { ts: (await deps.notices.post(input)).ts };
    },
    update: (input) => deps.notices.update(input),
    postEphemeral: (input) => deps.notices.postEphemeral(input),
    // Spec 014 FR-008, as Slack's own check: a person is a known user who is not a bot, not deleted and not Slackbot.
    async checkMember(userId) {
      const memberKey = deps.teamId === undefined ? userId : `${deps.teamId()}/${userId}`;
      const cached = members.get(memberKey);
      if (cached !== undefined && now() - cached.at < MEMBER_TTL_MS) return cached.check;
      let user: DirectoryUser | undefined;
      try {
        user = await deps.user(userId);
      } catch {
        return { outcome: "failed", error: "request_failed" };
      }
      if (user === undefined || user.userId !== userId) return { outcome: "failed", error: "user_not_found" };
      const check: SlackMemberCheck = !user.bot && !user.deleted && userId !== "USLACKBOT" ? { outcome: "person" } : { outcome: "not_person" };
      if (members.size >= MEMBER_CACHE_CAP) members.delete(members.keys().next().value as string);
      members.set(memberKey, { check, at: now() });
      return check;
    },
    enqueue: (message, _groupId, queuedBehind) => queue(message, { queuedBehind }),
    route: (message, _groupId, taskQuestion) => queue(message, {
      routing: taskQuestion === undefined ? { kind: "suggest" } : { kind: "task_question", taskId: taskQuestion.taskId, noteId: taskQuestion.noteTs, chat: taskQuestion.chat },
    }),
    // Task 21: the requester's `answer`, counted as the ingress counts any request it queues.
    async enqueueAnswer(answer) {
      const message: SlackRequestMessage = { version: 1, eventId: answer.eventId, thread: answer.thread, userId: answer.userId, text: answer.text, receivedAt: new Date(now()).toISOString() };
      const subject = slackThreadSubject(answer.thread);
      await deps.changePending(subject, 1);
      try {
        await queue(message, {});
      } catch (error) {
        await deps.changePending(subject, -1).catch(() => undefined);
        throw error;
      }
    },
  };
}

/** The channel API's surface for channel `slack`: each message is routed in its bound project, as its own team. */
export function slackChannelSurface(route: ReturnType<typeof createSlackMentionRouter>, project: AsyncLocalStorage<{ projectName: string; teamId: string }>): ChannelSurface {
  return async (message, context) => {
    const response = await project.run({ projectName: context.projectName, teamId: message.conversation.tenant }, () => route(slackMentionOfInbound(message)));
    return { statusCode: response.statusCode, body: response.body };
  };
}

/**
 * DEC 254y(3), L2-2 PR 18e: whether a channel item (a message, or a press) is the install's own: its actor's tenant, and its conversation's tenant where it has one (a message
 * always does), are each exactly the install's team. Read at run time, whatever the types say: a missing, non-string or different value is not the install's.
 */
export function channelItemOnInstallTeam(item: unknown, legacyTeamId: string, conversationRequired: boolean): boolean {
  if (item === null || typeof item !== "object") return false;
  const tenant = (ref: unknown) => (ref !== null && typeof ref === "object" ? (ref as { tenant?: unknown }).tenant : undefined);
  const { actor, conversation } = item as { actor?: unknown; conversation?: unknown };
  if (tenant(actor) !== legacyTeamId) return false;
  if (conversation === undefined) return !conversationRequired;
  return tenant(conversation) === legacyTeamId;
}

/** Two surfaces for channel `slack`: the install's team keeps today's; any other tenant, or one that cannot be read, goes to the company surface. No company surface: today's, as it is. */
export function splitChannelSurfaceByTenant(legacy: ChannelSurface, company: ChannelSurface | undefined, legacyTeamId: string): ChannelSurface {
  if (company === undefined) return legacy;
  return (message, context) => (channelItemOnInstallTeam(message, legacyTeamId, true) ? legacy : company)(message, context);
}

/** The AWS surface: the Slack adapter's commands, Slack's threads table, the broker, and the channel request queue. */
export function createAwsSlackChannelRouter(company: SlackCompanyDependencies = {}): ChannelSurface {
  const clientConfiguration = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
  const secretsManager = new SecretsManagerClient(clientConfiguration);
  const project = new AsyncLocalStorage<{ projectName: string; teamId: string }>();
  // Phase 7d: as the message's own team, so a deployment that names none (the legacy one) still answers.
  const notices = slackNoticeChannelForCurrentTeam(secretsManager, () => project.getStore()?.teamId);
  const adapter = builtInAdapterFromEnvironment(process.env);
  if (adapter === undefined) throw new Error("the Slack adapter is not configured for routing");
  const secret = slackAdapterSecretReader(secretsManager, adapter.secretName);
  const commandDeps = { getSecret: () => secret(), fetch, checkAddresses: (url: URL) => checkEndpointAddresses(url), now: Date.now };
  const sqs = new SQSClient(clientConfiguration);
  const requestQueueUrl = requiredEnvironment("CHANNEL_REQUEST_QUEUE_URL");
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(clientConfiguration), { marshallOptions: { removeUndefinedValues: true } });
  const transport = slackChannelTransport({
    notices,
    teamId: () => project.getStore()?.teamId,
    async user(userId) {
      const tenant = project.getStore()?.teamId;
      return (await sendChannelCommand(commandDeps, adapter, "user", { ...(tenant === undefined ? {} : { tenant }), userId })).user;
    },
    async enqueue(item, groupId) {
      await sqs.send(new SendMessageCommand({
        QueueUrl: requestQueueUrl, MessageBody: JSON.stringify(item), MessageGroupId: groupId,
        MessageDeduplicationId: createHash("sha256").update(queueItemIdentity(item)).digest("hex"),
      }));
    },
    changePending: threadPendingCounter(documentClient, requiredEnvironment("SLACK_THREADS_TABLE_NAME")),
    projectName() {
      const name = project.getStore()?.projectName;
      if (name === undefined) throw new Error("no project is bound for this message");
      return name;
    },
  });
  return slackChannelSurface(createSlackMentionRouter(awsSlackRouterDependencies(transport, company)), project);
}
