// Spec 062 Phase 7c3: Slack's button presses run by the channel API for the built-in Slack adapter. The adapter hands a
// press on as a channel action, after Slack has its answer; the channel API runs the same handlers Slack's interactivity
// runs (workflow retries, send back, keep the pull request, PR feedback decisions, Quick, Full and Just answer), and
// they answer through the adapter's commands: a private note to the presser, or the pressed card edited.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  slackThreadOf,
  type ChannelAction,
  type SlackThread,
} from "@agentx/contracts";
import { queueItemIdentity, type ChannelActionSurface } from "./channel-ingress.js";
import { requiredEnvironment } from "./lambda.js";
import { slackChannelTransport } from "./slack-channel-router.js";
import { threadPendingCounter } from "./slack-ingress.js";
import { awsWorkflowSlackHandlers, createSlackPressDispatcher, type SlackBlockAction, type SlackPressTransport } from "./slack-interactivity.js";
import { slackNoticeChannelFromEnvironment, type SlackNoticeChannel } from "./slack-notice-channel.js";
import { ROUTED_SLACK_PRESSES } from "./slack-press-routing.js";
import type { HandedOffWorkflowStart } from "./slack-workflow-choice.js";

/** Where a press's answers go once it left Slack: the thread, the presser and the pressed card, in place of a response URL. */
interface ReplyTarget { channel: string; threadTs: string; userId: string; messageTs: string }
const REPLY_PREFIX = "channel-reply:";

export function replyTargetToken(target: ReplyTarget): string {
  return `${REPLY_PREFIX}${Buffer.from(JSON.stringify(target), "utf8").toString("base64url")}`;
}

function replyTargetOf(token: string): ReplyTarget {
  if (!token.startsWith(REPLY_PREFIX)) throw new Error("not a channel reply target");
  return JSON.parse(Buffer.from(token.slice(REPLY_PREFIX.length), "base64url").toString("utf8")) as ReplyTarget;
}

/** The press as Slack's interactivity saw it: same workspace (the adapter checked), no trigger (no form), its replies by target. */
export function slackPressOfChannelAction(action: ChannelAction, nowMs: number): SlackBlockAction {
  if (action.conversation === undefined) throw new Error("a Slack press is in a conversation");
  const thread: SlackThread = slackThreadOf(action.conversation);
  const messageTs = action.messageId ?? thread.threadTs;
  const actionTs = action.eventId.split(":")[0] ?? messageTs;
  return {
    actionId: action.actionId, value: action.value, userId: action.actor.userId,
    userTeamId: action.actor.tenant, workspaceTeamId: action.actor.tenant, enterpriseId: "", userEnterpriseId: "",
    requestStartedAt: nowMs, thread, messageTs, messageText: action.messageText ?? "",
    responseUrl: replyTargetToken({ channel: thread.channelId, threadTs: thread.threadTs, userId: action.actor.userId, messageTs }),
    triggerId: "", actionTs,
  };
}

/** The handlers' answers through the adapter's commands; a Quick or Full start runs here, already after Slack's answer. */
export function channelPressTransport(deps: {
  notices: SlackNoticeChannel;
  enqueueAnswer: SlackPressTransport["enqueueAnswer"];
  runStart: (event: HandedOffWorkflowStart) => Promise<unknown>;
}): SlackPressTransport {
  return {
    async openView() {
      // Presses that open a form stay with Slack's interactivity until Phase 7c3b.
      throw new Error("forms are opened by the Slack adapter");
    },
    async respondEphemeral(token, text) {
      const target = replyTargetOf(token);
      await deps.notices.postEphemeral({ channel: target.channel, threadTs: target.threadTs, user: target.userId, text });
    },
    async respondReplace(token, message) {
      const target = replyTargetOf(token);
      await deps.notices.update({ channel: target.channel, ts: target.messageTs, text: message.text, blocks: message.blocks });
    },
    update: (input) => deps.notices.update(input),
    async handOff(event) {
      await deps.runStart(event);
    },
    enqueueAnswer: deps.enqueueAnswer,
  };
}

export function createAwsSlackChannelPresses(): ChannelActionSurface {
  const clientConfiguration = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
  const notices = slackNoticeChannelFromEnvironment(new SecretsManagerClient(clientConfiguration));
  if (notices === undefined) throw new Error("the Slack adapter is not configured for presses");
  const sqs = new SQSClient(clientConfiguration);
  const requestQueueUrl = requiredEnvironment("CHANNEL_REQUEST_QUEUE_URL");
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(clientConfiguration), { marshallOptions: { removeUndefinedValues: true } });
  const project = new AsyncLocalStorage<string>();
  const queue = slackChannelTransport({
    notices,
    user: async () => undefined,
    async enqueue(item, groupId) {
      await sqs.send(new SendMessageCommand({ QueueUrl: requestQueueUrl, MessageBody: JSON.stringify(item), MessageGroupId: groupId,
        MessageDeduplicationId: createHash("sha256").update(queueItemIdentity(item)).digest("hex") }));
    },
    changePending: threadPendingCounter(documentClient, requiredEnvironment("SLACK_THREADS_TABLE_NAME")),
    projectName() {
      const name = project.getStore();
      if (name === undefined) throw new Error("no project is bound for this press");
      return name;
    },
  });
  // The start runner comes from the same handlers it serves, so it is looked up when a start is handed on.
  const late: { runStart?: (event: HandedOffWorkflowStart) => Promise<unknown> } = {};
  const transport = channelPressTransport({ notices, enqueueAnswer: (answer) => queue.enqueueAnswer(answer), runStart: (event) => late.runStart!(event) });
  const { workflow, chosenStart } = awsWorkflowSlackHandlers(transport);
  late.runStart = chosenStart;
  const dispatch = createSlackPressDispatcher({ handlers: [], ...(workflow === undefined ? {} : { workflow }),
    respondEphemeral: (token, text) => transport.respondEphemeral(token, text),
    log: (event, fields) => console.log(JSON.stringify({ component: "slack-channel-presses", event, ...fields })) });
  return async (action, context) => {
    if (!ROUTED_SLACK_PRESSES.has(action.actionId)) return undefined;
    await project.run(context.projectName, () => dispatch(slackPressOfChannelAction(action, Date.now())));
    return { statusCode: 200, body: JSON.stringify({ status: "handled" }) };
  };
}

