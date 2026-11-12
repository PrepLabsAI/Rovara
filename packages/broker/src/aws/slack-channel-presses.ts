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
  ADMIN_CHANGE_CONFIRM_ACTION,
  formOfSlackModal,
  slackModalOf,
  slackStateOfFormValues,
  slackThreadOf,
  type ChannelAction,
  type ChannelActionAnswer,
  type ChannelForm,
  type SlackThread,
} from "@agentx/contracts";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { checkEndpointAddresses } from "@agentx/gateway";
import { builtInAdapterFromEnvironment } from "./channel-adapters.js";
import { sendChannelCommand } from "./channel-commands.js";
import { slackAdapterSecretReader } from "./slack-adapter.js";
import { chatGptSubmission, runHandedOffChatGptFinish, type HandedOffChatGptFinish } from "./slack-chatgpt.js";
import { detailsActionHandler, dynamoTurnDetailsReader } from "./slack-details.js";
import type { SlackIngressLog } from "./slack-ingress.js";
import { queueItemIdentity, type ChannelActionSurface } from "./channel-ingress.js";
import { requiredEnvironment } from "./lambda.js";
import { slackChannelTransport } from "./slack-channel-router.js";
import { threadPendingCounter } from "./slack-ingress.js";
import {
  ADMIN_CHANGE_CANCEL_RECEIVED_TEXT, ADMIN_CHANGE_PRESS_FAILED_TEXT, ADMIN_CHANGE_RECEIVED_TEXT, awsAdminChangePress, awsWorkflowSlackHandlers, chatGptActionHandler, createSlackPressDispatcher,
  createSlackSubmissionHandler, type SlackBlockAction, type SlackPressTransport,
} from "./slack-interactivity.js";
import { slackNoticeChannelForCurrentTeam, slackNoticeChannelFromEnvironment, type SlackNoticeChannel } from "./slack-notice-channel.js";
import { ADMIN_CHANGE_PRESSES, FORM_SLACK_PRESSES, ROUTED_SLACK_PRESSES, SLACK_FORM_SUBMISSIONS } from "./slack-press-routing.js";
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
    // The adapter keeps Slack's trigger and opens the form the press answers; handlers only need to know there is one.
    triggerId: "channel", actionTs,
  };
}

/** The handlers' answers through the adapter's commands; a Quick or Full start runs here, already after Slack's answer. */
export function channelPressTransport(deps: {
  notices: SlackNoticeChannel;
  enqueueAnswer: SlackPressTransport["enqueueAnswer"];
  runStart: (event: HandedOffWorkflowStart) => Promise<unknown>;
  /** Phase 7c3b: keeps a form a handler opens, for the press's answer. Absent: no form can be opened. */
  openView?: SlackPressTransport["openView"];
}): SlackPressTransport {
  return {
    async openView(triggerId, view) {
      // The adapter opens the form, with its own trigger, from the press's answer.
      if (deps.openView === undefined) throw new Error("forms are opened by the Slack adapter");
      await deps.openView(triggerId, view);
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

/** A form a handler opened, kept for the press's synchronous answer. */
export function formCapture() {
  const opened = new AsyncLocalStorage<{ form?: ChannelForm }>();
  return {
    openView: async (_triggerId: string, view: object): Promise<void> => {
      const store = opened.getStore();
      const form = formOfSlackModal(view);
      if (store === undefined) throw new Error("no press is being answered");
      // Every modal the core opens reads as a form (tests/support/strict-slack.ts checks each one).
      if (form === undefined) throw new Error("the form cannot be shown through the channel API");
      store.form = form;
    },
    run: async (work: () => Promise<void>): Promise<ChannelForm | undefined> => {
      const store: { form?: ChannelForm } = {};
      await opened.run(store, work);
      return store.form;
    },
  };
}

/** A submitted form as the view_submission payload Slack's interactivity reads. */
export function slackSubmissionPayloadOf(action: ChannelAction): Record<string, unknown> {
  if (action.formSubmission === undefined) throw new Error("not a form submission");
  const { form, handle, values } = action.formSubmission;
  return {
    type: "view_submission",
    team: { id: action.actor.tenant },
    user: { id: action.actor.userId, team_id: action.actor.tenant },
    view: { ...slackModalOf(form), ...(handle === undefined ? {} : { id: handle }), state: { values: slackStateOfFormValues(values) } },
  };
}

/** Slack's response to a submission as the channel's answer: close the form, show errors on it, or replace it. */
export function formAnswerOf(response: Record<string, unknown>): ChannelActionAnswer {
  if (response.response_action === "errors" && typeof response.errors === "object" && response.errors !== null) {
    return { status: "handled", form: { kind: "errors", errors: response.errors as Record<string, string> } };
  }
  if (response.response_action === "update") {
    const form = formOfSlackModal(response.view);
    if (form !== undefined) return { status: "handled", form: { kind: "update", form } };
  }
  return { status: "handled", form: { kind: "close" } };
}

const answer = (body: ChannelActionAnswer) => ({ statusCode: 200, body: JSON.stringify(body) });

export function createAwsSlackChannelPresses(): ChannelActionSurface {
  const clientConfiguration = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
  // Phase 7d: as the presser's own team, so a deployment that names none (the legacy one) still answers.
  const team = new AsyncLocalStorage<string>();
  const notices = slackNoticeChannelForCurrentTeam(new SecretsManagerClient(clientConfiguration), () => team.getStore());
  const sqs = new SQSClient(clientConfiguration);
  const lambda = new LambdaClient(clientConfiguration);
  const requestQueueUrl = requiredEnvironment("CHANNEL_REQUEST_QUEUE_URL");
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(clientConfiguration), { marshallOptions: { removeUndefinedValues: true } });
  const project = new AsyncLocalStorage<string>();
  const log: SlackIngressLog = (event, fields) => console.log(JSON.stringify({ component: "slack-channel-presses", event, ...fields }));
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
  const forms = formCapture();
  // The start runner comes from the same handlers it serves, so it is looked up when a start is handed on.
  const late: { runStart?: (event: HandedOffWorkflowStart) => Promise<unknown> } = {};
  const transport = channelPressTransport({ notices, enqueueAnswer: (entry) => queue.enqueueAnswer(entry), runStart: (event) => late.runStart!(event), openView: forms.openView });
  const { workflow, chosenStart } = awsWorkflowSlackHandlers(transport);
  late.runStart = chosenStart;
  const respondEphemeral = (token: string, text: string) => transport.respondEphemeral(token, text);
  const turnRecordsTableName = process.env.TURN_RECORDS_TABLE_NAME;
  const handlers = [
    chatGptActionHandler({ openView: forms.openView, respondEphemeral }),
    detailsActionHandler({
      readDetails: turnRecordsTableName ? dynamoTurnDetailsReader(documentClient, turnRecordsTableName) : async () => { throw new Error("TURN_RECORDS_TABLE_NAME is not set"); },
      openView: forms.openView, respondEphemeral, log,
    }),
  ];
  const dispatch = createSlackPressDispatcher({ handlers, ...(workflow === undefined ? {} : { workflow }), respondEphemeral, log });
  // A ChatGPT connection finishes in an asynchronous invoke of this Lambda, as it does in Slack's interactivity.
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  const submit = createSlackSubmissionHandler({
    ...(workflow === undefined ? {} : { workflow }), log,
    chatgptSubmission: (payload) => chatGptSubmission({
      async handOff(event) {
        if (functionName === undefined) throw new Error("AWS_LAMBDA_FUNCTION_NAME is not set");
        const response = await lambda.send(new InvokeCommand({ FunctionName: functionName, InvocationType: "Event", Payload: Buffer.from(JSON.stringify(event)) }));
        if (response.StatusCode !== 202) throw Object.assign(new Error("the finish was not handed over"), { name: "HandOffRefused" });
      },
    }, payload),
  });
  const adminChange = process.env.ADMIN_CHANGES === "enabled" ? awsAdminChangePress(clientConfiguration, documentClient) : undefined;
  return (action, context) => team.run(action.actor.tenant, () => press(action, context));
  async function press(action: ChannelAction, context: { projectName?: string }): Promise<{ statusCode: number; body: string } | undefined> {
    const pressed = () => slackPressOfChannelAction(action, Date.now());
    const inProject = <T>(work: () => Promise<T>) => (context.projectName === undefined ? work() : project.run(context.projectName, work));
    if (ROUTED_SLACK_PRESSES.has(action.actionId)) {
      await inProject(() => dispatch(pressed()));
      return answer({ status: "handled" });
    }
    if (FORM_SLACK_PRESSES.has(action.actionId) && action.conversation !== undefined) {
      const open = await forms.run(() => inProject(() => dispatch(pressed())));
      return answer({ status: "handled", ...(open === undefined ? {} : { open }) });
    }
    if (SLACK_FORM_SUBMISSIONS.has(action.actionId) && action.formSubmission !== undefined) {
      return answer(formAnswerOf(await submit(slackSubmissionPayloadOf(action))));
    }
    if (ADMIN_CHANGE_PRESSES.has(action.actionId) && adminChange !== undefined) {
      const click = action.actionId === ADMIN_CHANGE_CONFIRM_ACTION ? "confirm" : "cancel";
      let text: string;
      try {
        await adminChange.press({ changeId: action.value, click, slackUserId: action.actor.userId, teamId: action.actor.tenant });
        text = click === "confirm" ? ADMIN_CHANGE_RECEIVED_TEXT : ADMIN_CHANGE_CANCEL_RECEIVED_TEXT;
      } catch (error) {
        log("admin_change.press_failed", { changeId: action.value, errorName: error instanceof Error ? error.name : "unknown" });
        text = ADMIN_CHANGE_PRESS_FAILED_TEXT;
      }
      // The press was in the admin's direct message with Rovara; the answer goes there.
      await notices.post({ channel: action.actor.userId, text }).catch(() => log("admin_change.answer_failed", { changeId: action.value }));
      return answer({ status: "handled" });
    }
    return undefined;
  }
}

/** Phase 7c3b: a ChatGPT connection finished in an asynchronous invoke of the channel API, its form updated through the adapter. */
export function createAwsSlackChatGptFinish(): (event: HandedOffChatGptFinish) => Promise<"connected" | "refused"> {
  const clientConfiguration = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
  const secretsManager = new SecretsManagerClient(clientConfiguration);
  const adapter = builtInAdapterFromEnvironment(process.env);
  if (adapter === undefined) throw new Error("the Slack adapter is not configured");
  const secret = slackAdapterSecretReader(secretsManager, adapter.secretName);
  const commandDeps = { getSecret: () => secret(), fetch, checkAddresses: (url: URL) => checkEndpointAddresses(url), now: Date.now };
  const lambda = new LambdaClient(clientConfiguration);
  const brokerFunctionName = requiredEnvironment("BROKER_FUNCTION_NAME");
  return (event) => runHandedOffChatGptFinish({
    async finish(input) {
      const response = await lambda.send(new InvokeCommand({ FunctionName: brokerFunctionName, InvocationType: "RequestResponse",
        Payload: Buffer.from(JSON.stringify({ source: "agentx.slack-ingress", action: "chatgpt-finish", ...input })) }), { abortSignal: AbortSignal.timeout(20_000) });
      if (response.FunctionError !== undefined || response.Payload === undefined) throw new Error("broker chatgpt-finish failed");
      return JSON.parse(Buffer.from(response.Payload).toString("utf8")) as Awaited<ReturnType<Parameters<typeof runHandedOffChatGptFinish>[0]["finish"]>>;
    },
    async updateView(viewId, view) {
      const form = formOfSlackModal(view);
      if (form === undefined) throw new Error("the form cannot be shown through the channel API");
      await sendChannelCommand(commandDeps, adapter, "update_form", { handle: viewId, form });
    },
    // As the connecting person's own team (Phase 7d: the legacy deployment names none).
    async postEphemeral(input) {
      const notices = slackNoticeChannelFromEnvironment(secretsManager, event.teamId);
      if (notices === undefined) throw new Error("the Slack adapter is not configured");
      await notices.postEphemeral(input);
    },
    log: (name, fields) => console.log(JSON.stringify({ component: "slack-channel-presses", event: name, ...fields })),
  }, event);
}
