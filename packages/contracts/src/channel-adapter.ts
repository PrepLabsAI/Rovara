import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ActorRefSchema, ChannelIdSchema, ChannelOpaqueIdSchema, ConversationRefSchema, InboundMessageSchema, SLACK_CHANNEL, type ActorRef, type ConversationRef } from "./conversation.js";
import { orgScoped, type OrgId, type OrgKey } from "./company-scope.js";
import { publicHttpsUrlSchema } from "./mcp-connector.js";
import { ChannelFormSchema, ChannelFormSubmissionSchema } from "./channel-forms.js";
import { AgentXNameSchema } from "./names.js";

/**
 * Spec 062 Phase 3: the channel adapter protocol. An administrator registers an adapter; the adapter signs what it
 * posts to Rovara and Rovara signs what it sends back, both with Standard Webhooks (https://www.standardwebhooks.com).
 */

/**
 * An adapter's channel: any channel ID, `slack` included (owner decision 58: a chat tool is an ordinary adapter, and the id of the chat tool Rovara shipped first is not special). An in-process adapter of
 * any id is named by the plug-in config; the hosted product's own path for that tool is a separate matter (`RegisteredChannelIdSchema`).
 */
export const AdapterChannelIdSchema = ChannelIdSchema;

/**
 * The channel of an adapter REGISTERED OVER HTTP (a webhook adapter, `ChannelAdapterRecord`): any ID except `slack`. The hosted product still serves that chat tool on its own built-in path, whose rows and
 * workspace owner keys a registered webhook adapter must not be able to pose as; until the hosted product moves onto the in-process adapter, a registration cannot take the id.
 */
export const RegisteredChannelIdSchema = ChannelIdSchema.refine((channel) => channel !== SLACK_CHANNEL, "slack is served by its own adapter and cannot be registered over HTTP");

/** FR-023: what the adapter's surface can show. The core never sends a part it cannot. */
export const ChannelCapabilitiesSchema = z.object({
  threads: z.boolean(),
  /** Most buttons in one message; 0 means none, so a choice is named as a reply such as "reply 1 to approve". */
  buttons: z.number().int().min(0).max(10),
  edits: z.boolean(),
  maxTextLength: z.number().int().min(200).max(100_000),
  /** Whether the adapter may message a conversation first, as a reminder or a finished task does. */
  proactive: z.boolean(),
  /** Spec 062 Phase 7 (FR-070 to FR-072); each is off unless the adapter says so, as on an older registration. */
  /** A message shown only to one person in the conversation. */
  ephemeral: z.boolean().optional(),
  /** A message to a person outside any conversation. */
  direct: z.boolean().optional(),
  /** Forms a button opens, posted back as one action. */
  forms: z.boolean().optional(),
  /** `create_document` and `delete_document` commands. */
  documents: z.boolean().optional(),
  /** `space_members`, `user` and `user_by_email` commands. */
  directory: z.boolean().optional(),
  /** `start_conversation` commands. */
  startConversations: z.boolean().optional(),
}).strict();
export type ChannelCapabilities = z.infer<typeof ChannelCapabilitiesSchema>;

/** FR-032: decision kinds that must be made by a signed-in developer on the task page, not through the adapter. */
export const StepUpKindSchema = z.enum(["plan_approval", "admin"]);
export type StepUpKind = z.infer<typeof StepUpKindSchema>;
export const DEFAULT_STEP_UP: readonly StepUpKind[] = ["plan_approval", "admin"];

const uniqueList = <T extends z.ZodTypeAny>(item: T, max: number, label: string) =>
  z.array(item).max(max).refine((values) => new Set(values).size === values.length, `${label} must be unique`);

/** FR-020: what an administrator sends to register or replace an adapter. The channel is in the path. */
export const ChannelAdapterRegistrationSchema = z.object({
  callbackUrl: publicHttpsUrlSchema("callbackUrl"),
  /** FR-072: where the core sends commands and waits for the answer; without it the adapter takes none. */
  commandsUrl: publicHttpsUrlSchema("commandsUrl").optional(),
  capabilities: ChannelCapabilitiesSchema,
  projects: uniqueList(AgentXNameSchema, 64, "projects").refine((projects) => projects.length > 0, "an adapter must be registered for at least one project"),
  stepUp: uniqueList(StepUpKindSchema, 2, "stepUp").default([...DEFAULT_STEP_UP]),
}).strict();
export type ChannelAdapterRegistration = z.infer<typeof ChannelAdapterRegistrationSchema>;

/** A registered adapter as the state table stores it. The signing secret is in Secrets Manager under `secretName`. */
export const ChannelAdapterRecordSchema = z.object({
  channel: RegisteredChannelIdSchema,
  callbackUrl: publicHttpsUrlSchema("callbackUrl"),
  commandsUrl: publicHttpsUrlSchema("commandsUrl").optional(),
  capabilities: ChannelCapabilitiesSchema,
  projects: uniqueList(AgentXNameSchema, 64, "projects"),
  stepUp: uniqueList(StepUpKindSchema, 2, "stepUp"),
  secretName: z.string().min(1).max(512),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  updatedBy: z.string().min(1).max(512),
  /**
   * FR-073: the deployment's own adapter (Slack), never stored or registered. Its actors keep the surface's verified
   * identity: no linking, any bound space, no step-up.
   */
  builtIn: z.literal(true).optional(),
}).strict();
export type ChannelAdapterRecord = z.infer<typeof ChannelAdapterRecordSchema>;

/**
 * FR-073: what the built-in adapter can show and do: threads, buttons, edits, private and direct messages, documents
 * and the directory (Phase 7c).
 */
export const BUILT_IN_ADAPTER_CAPABILITIES: ChannelCapabilities = {
  threads: true, buttons: 5, edits: true, maxTextLength: 40_000, proactive: true, ephemeral: true, direct: true, documents: true, directory: true, forms: true,
};

/** FR-073: the built-in adapter's record, made from the deployment's settings rather than read from the registry. */
export function builtInAdapterRecord(input: { channel: string; callbackUrl: string; commandsUrl?: string | undefined; secretName: string; deployedAt?: string }): ChannelAdapterRecord {
  const at = input.deployedAt ?? "1970-01-01T00:00:00.000Z";
  return {
    channel: ChannelIdSchema.parse(input.channel), callbackUrl: publicHttpsUrlSchema("callbackUrl").parse(input.callbackUrl),
    ...(input.commandsUrl === undefined ? {} : { commandsUrl: publicHttpsUrlSchema("commandsUrl").parse(input.commandsUrl) }),
    capabilities: { ...BUILT_IN_ADAPTER_CAPABILITIES }, projects: [], stepUp: [], secretName: input.secretName,
    createdAt: at, updatedAt: at, updatedBy: "deployment", builtIn: true,
  };
}

export const CHANNEL_ADAPTERS_PK = "CHANNEL_ADAPTERS";
export function channelAdapterKey(channel: string): { pk: string; sk: string } {
  return { pk: CHANNEL_ADAPTERS_PK, sk: `CHANNEL#${RegisteredChannelIdSchema.parse(channel)}` };
}
/** The adapter's signing secret's name, under this deployment's secret prefix (for example `agentx/prod/`). */
export function channelAdapterSecretName(prefix: string, channel: string): string {
  return `${prefix}channel-adapter/${RegisteredChannelIdSchema.parse(channel)}`;
}

/** What an adapter sees once, at registration: the record and the secret it signs with. */
export interface ChannelAdapterRegistered { adapter: ChannelAdapterRecord; signingSecret: string }

/** Workflow decisions an adapter can post (the same set the task page and Slack buttons use). */
export const ChannelDecisionValueSchema = z.enum(["APPROVE", "REQUEST_CHANGES", "REJECT", "SKIP"]);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * FR-021: a person's answer to an `approval_request` event. `requestId`, `expectedRevision` and `artifactDigest` are
 * echoed from that event, so the decision applies only to the exact revision the person saw.
 */
export const ChannelDecisionSchema = z.object({
  version: z.literal(1),
  channel: ChannelIdSchema,
  eventId: ChannelOpaqueIdSchema,
  conversation: ConversationRefSchema,
  actor: ActorRefSchema,
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  artifactDigest: DigestSchema,
  decision: ChannelDecisionValueSchema,
  reason: z.string().trim().min(1).max(500),
  receivedAt: z.string().datetime(),
}).strict().superRefine((decision, context) => {
  if (decision.conversation.channel !== decision.channel) context.addIssue({ code: "custom", path: ["conversation", "channel"], message: "must equal channel" });
  if (decision.actor.channel !== decision.channel) context.addIssue({ code: "custom", path: ["actor", "channel"], message: "must equal channel" });
});
export type ChannelDecision = z.infer<typeof ChannelDecisionSchema>;

/**
 * What channel ingress queues for the core once a message or decision has passed every check: signed by its adapter,
 * in a bound space of one of the adapter's projects, from a linked actor. Carries the project and developer it was
 * checked against, so the consumer does not re-derive them from the adapter's claims.
 */
/** The adapter's step-up set when the item was accepted; an item without one is stepped up for every kind. */
const QueuedStepUp = uniqueList(StepUpKindSchema, 2, "stepUp").default([...DEFAULT_STEP_UP]);

/**
 * FR-071: a person's press of a button or select, or a form's submission, on a message Rovara sent. `messageKey` names
 * that message when it had one. A direct message's action has no conversation.
 */
export const ChannelActionSchema = z.object({
  version: z.literal(1),
  channel: ChannelIdSchema,
  eventId: ChannelOpaqueIdSchema,
  conversation: ConversationRefSchema.optional(),
  actor: ActorRefSchema,
  actionId: z.string().regex(/^[a-z][a-z0-9_.:-]{0,127}$/),
  value: z.string().max(2_000),
  form: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.string().max(3_000)).refine((form) => Object.keys(form).length <= 20, "at most 20 fields").optional(),
  messageKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
  /** Phase 7c3: the pressed message's own ID in its space, and its text as shown, where the surface has them. */
  messageId: ChannelOpaqueIdSchema.optional(),
  messageText: z.string().max(40_000).optional(),
  /** Phase 7c3b (FR-080): a submitted form the core opened; `actionId` is the form's ID. */
  formSubmission: ChannelFormSubmissionSchema.optional(),
  receivedAt: z.string().datetime(),
}).strict().superRefine((action, context) => {
  if (action.conversation !== undefined && action.conversation.channel !== action.channel) context.addIssue({ code: "custom", path: ["conversation", "channel"], message: "must equal channel" });
  if (action.actor.channel !== action.channel) context.addIssue({ code: "custom", path: ["actor", "channel"], message: "must equal channel" });
});
export type ChannelAction = z.infer<typeof ChannelActionSchema>;

/**
 * Phase 7c2: what the core's router decided before queueing a message. `suggest`: a plain new request, to be routed
 * to an answer or a suggested task. `task_question`: a mention saved as a task's note, answered if it is a question.
 */
export const QueuedRoutingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("suggest") }).strict(),
  z.object({ kind: z.literal("task_question"), taskId: z.string().min(1).max(100), noteId: ChannelOpaqueIdSchema, chat: z.boolean() }).strict(),
]);
export type QueuedRouting = z.infer<typeof QueuedRoutingSchema>;

export const ChannelQueueItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("action"), action: ChannelActionSchema, projectName: AgentXNameSchema.optional(), developerId: z.string().min(1).max(200).optional(), stepUp: QueuedStepUp }).strict(),
  // FR-073: the built-in adapter's items carry no developer; its actors keep the surface's verified identity.
  z.object({
    kind: z.literal("message"), message: InboundMessageSchema, projectName: AgentXNameSchema, developerId: z.string().min(1).max(200).optional(), stepUp: QueuedStepUp,
    /** Phase 7c2: how many earlier requests the conversation was told this one waits behind. */
    queuedBehind: z.number().int().min(0).max(10_000).optional(),
    routing: QueuedRoutingSchema.optional(),
  }).strict(),
  z.object({ kind: z.literal("decision"), decision: ChannelDecisionSchema, projectName: AgentXNameSchema, developerId: z.string().min(1).max(200).optional(), stepUp: QueuedStepUp }).strict(),
]);
export type ChannelQueueItem = z.infer<typeof ChannelQueueItemSchema>;

// ---- Events Rovara sends to an adapter (FR-022) ----

const Text = z.string().min(1).max(40_000);
const HttpsUrl = z.string().url().max(2_048).refine((url) => url.startsWith("https://"), "must be an https URL");
const ApprovalAction = z.object({ decision: ChannelDecisionValueSchema, label: z.string().min(1).max(80) }).strict();

// ---- Rich messages (FR-070) ----

const Label = z.string().trim().min(1).max(75);
/** Names a message, so a later one with the same key replaces it where the adapter can edit. */
export const MessageKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
/** An action's ID, which comes back with a press or a form (FR-071). */
export const ActionIdSchema = z.string().regex(/^[a-z][a-z0-9_.:-]{0,127}$/);
/** The button on a reply that followed tool calls; its value names the turn record (spec 014 FR-024). */
export const TURN_DETAILS_ACTION_ID = "turn.details";
const ActionValue = z.string().max(2_000);
const Choice = z.object({ label: Label, value: ActionValue }).strict();

export const FormFieldSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  label: Label,
  kind: z.enum(["text", "multiline", "select"]),
  required: z.boolean().default(true),
  initial: z.string().max(3_000).optional(),
  maxLength: z.number().int().min(1).max(3_000).optional(),
  options: z.array(Choice).min(1).max(100).optional(),
}).strict().superRefine((field, context) => {
  if (field.kind === "select" && field.options === undefined) context.addIssue({ code: "custom", path: ["options"], message: "a select needs options" });
  if (field.kind !== "select" && field.options !== undefined) context.addIssue({ code: "custom", path: ["options"], message: "only a select has options" });
});
export type FormField = z.infer<typeof FormFieldSchema>;

/** What a person can do on a message. A form is opened by the adapter itself, and its submission comes back as one action. */
export const MessageActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("button"), actionId: ActionIdSchema, value: ActionValue, label: Label, style: z.enum(["primary", "danger"]).optional() }).strict(),
  // A link's own action ID, where the surface reports its press too (Slack does).
  z.object({ type: z.literal("link"), label: Label, url: HttpsUrl, actionId: ActionIdSchema.optional() }).strict(),
  z.object({ type: z.literal("select"), actionId: ActionIdSchema, placeholder: Label, options: z.array(Choice).min(1).max(100) }).strict(),
  z.object({
    type: z.literal("form"), actionId: ActionIdSchema, value: ActionValue, label: Label,
    form: z.object({ title: z.string().trim().min(1).max(24), submitLabel: z.string().trim().min(1).max(24), fields: z.array(FormFieldSchema).min(1).max(10) }).strict(),
  }).strict(),
]);
export type MessageAction = z.infer<typeof MessageActionSchema>;

/**
 * A message's rich form, in order. When a message has parts they are all of it: its `text` is the plain form, which an
 * adapter shows where it cannot show parts, and the notification. An `actions` part places buttons among the parts.
 */
export const MessagePartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("section"), text: Text }).strict(),
  z.object({ type: z.literal("fields"), fields: z.array(z.object({ label: Label, value: z.string().min(1).max(2_000) }).strict()).min(1).max(10) }).strict(),
  z.object({ type: z.literal("context"), text: z.string().min(1).max(3_000) }).strict(),
  z.object({ type: z.literal("divider") }).strict(),
  z.object({ type: z.literal("image"), url: HttpsUrl, alt: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal("actions"), actions: z.array(MessageActionSchema).min(1).max(25) }).strict(),
]);
export type MessagePart = z.infer<typeof MessagePartSchema>;

/** Who sees a message in its conversation: everyone (the default), or one person only (needs `ephemeral`). */
export const MessageAudienceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("conversation") }).strict(),
  z.object({ kind: z.literal("ephemeral"), actor: ActorRefSchema }).strict(),
]);

const richMessage = {
  text: Text,
  key: MessageKeySchema.optional(),
  parts: z.array(MessagePartSchema).max(50).optional(),
  actions: z.array(MessageActionSchema).max(25).optional(),
};

/**
 * Issue #438: the Rovara task (operation) an event is about, so an adapter can tell two tasks in one conversation apart.
 * Optional everywhere, so an adapter registered before these fields reads every event as before.
 */
const EventTaskId = z.string().min(1).max(100);
const CommitSha = z.string().regex(/^[a-f0-9]{40,64}$/);
/** owner/name on GitHub. */
const RepositoryFullName = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/);
export const ChannelCheckStatusSchema = z.enum(["passed", "failed", "timed_out", "unknown", "not_run"]);
const ErrorCode = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

const eventData = {
  ack: z.object({ inReplyTo: ChannelOpaqueIdSchema }).strict(),
  /**
   * A message from Rovara in the conversation: a reply, a notice or a question it asks in prose. FR-070: it may carry
   * parts, actions, a key that a later message replaces, and an audience of one.
   */
  message: z.object({ ...richMessage, audience: MessageAudienceSchema.optional() }).strict(),
  /**
   * `onlyTo`: the id of the one account (of the conversation's tenant) that may see the text, for what must not be read by the others in the conversation (a one-use link code). An adapter that cannot show a message to one
   * person must not post it at all.
   */
  progress: z.object({ text: Text, onlyTo: ChannelOpaqueIdSchema.optional() }).strict(),
  question: z.object({ text: Text, choices: z.array(z.string().min(1).max(200)).max(10).optional() }).strict(),
  approval_request: z.object({
    text: Text,
    kind: z.enum(["plan_approval", "admin", "other"]),
    requestId: z.string().uuid(),
    expectedRevision: z.number().int().positive(),
    artifactDigest: DigestSchema,
    /** The task page, for a request about a task; an action confirmation in a conversation has none. */
    taskUrl: HttpsUrl.optional(),
    /** Absent when the adapter steps this kind up (FR-032): the person approves on `taskUrl`. */
    actions: z.array(ApprovalAction).min(1).max(4).optional(),
  }).strict(),
  /** #438: `commits` names what the checks ran on (one per repository) and `checks` each check's result. */
  check_report: z.object({
    text: Text, status: z.enum(["passed", "failed", "unknown"]),
    taskId: EventTaskId.optional(),
    commits: z.array(z.object({ repository: RepositoryFullName, sha: CommitSha }).strict()).max(20).optional(),
    checks: z.array(z.object({ name: z.string().min(1).max(200), status: ChannelCheckStatusSchema }).strict()).max(64).optional(),
  }).strict(),
  /** #438: the typed facts of a pull request a task opened or changed; `headSha` is the commit now at its head. */
  pr: z.object({
    url: HttpsUrl, title: z.string().min(1).max(300),
    taskId: EventTaskId.optional(),
    repository: RepositoryFullName.optional(),
    number: z.number().int().positive().optional(),
    headSha: CommitSha.optional(),
    baseBranch: z.string().min(1).max(255).optional(),
    draft: z.boolean().optional(),
    action: z.enum(["opened", "updated", "replaced", "closed", "reopened"]).optional(),
  }).strict(),
  /**
   * The request finished; everything it said came before as `message` events. `text` is an optional closing line.
   * #438: `outcome` says how it ended, `taskId` names the last task it ran, and `code` says why it failed.
   */
  done: z.object({
    inReplyTo: ChannelOpaqueIdSchema.optional(), text: Text.optional(),
    outcome: z.enum(["succeeded", "failed", "cancelled", "no_change"]).optional(),
    taskId: EventTaskId.optional(),
    code: ErrorCode.optional(),
  }).strict(),
  error: z.object({ code: ErrorCode, text: Text, taskId: EventTaskId.optional() }).strict(),
  link_required: z.object({ linkUrl: HttpsUrl, expiresAt: z.string().datetime(), actor: ActorRefSchema }).strict(),
} as const;
export type ChannelEventType = keyof typeof eventData | "direct";
export const CHANNEL_EVENT_TYPES = [...Object.keys(eventData), "direct"] as ChannelEventType[];

const eventBase = {
  version: z.literal(1),
  /** Stable across retries, so the adapter drops a repeat (it is also the `webhook-id`). */
  id: z.string().regex(/^evt_[A-Za-z0-9_-]{16,64}$/),
  // Any channel, the built-in adapter's included (FR-073).
  channel: ChannelIdSchema,
  conversation: ConversationRefSchema,
  createdAt: z.string().datetime(),
};
export const ChannelEventSchema = z.discriminatedUnion("type", [
  z.object({ ...eventBase, type: z.literal("ack"), data: eventData.ack }).strict(),
  z.object({ ...eventBase, type: z.literal("message"), data: eventData.message }).strict(),
  z.object({ ...eventBase, type: z.literal("progress"), data: eventData.progress }).strict(),
  z.object({ ...eventBase, type: z.literal("question"), data: eventData.question }).strict(),
  z.object({ ...eventBase, type: z.literal("approval_request"), data: eventData.approval_request }).strict(),
  z.object({ ...eventBase, type: z.literal("check_report"), data: eventData.check_report }).strict(),
  z.object({ ...eventBase, type: z.literal("pr"), data: eventData.pr }).strict(),
  z.object({ ...eventBase, type: z.literal("done"), data: eventData.done }).strict(),
  z.object({ ...eventBase, type: z.literal("error"), data: eventData.error }).strict(),
  z.object({ ...eventBase, type: z.literal("link_required"), data: eventData.link_required }).strict(),
  /** FR-070: a message to one person outside any conversation (needs `direct`). */
  z.object({
    version: eventBase.version, id: eventBase.id, channel: eventBase.channel, createdAt: eventBase.createdAt,
    type: z.literal("direct"), to: ActorRefSchema, data: z.object(richMessage).strict(),
  }).strict(),
]).superRefine((event, context) => {
  if (event.type === "direct") {
    if (event.to.channel !== event.channel) context.addIssue({ code: "custom", path: ["to", "channel"], message: "must equal channel" });
    return;
  }
  if (event.conversation.channel !== event.channel) context.addIssue({ code: "custom", path: ["conversation", "channel"], message: "must equal channel" });
  if (event.type === "message" && event.data.audience?.kind === "ephemeral" && event.data.audience.actor.channel !== event.channel) {
    context.addIssue({ code: "custom", path: ["data", "audience", "actor", "channel"], message: "must equal channel" });
  }
});
export type ChannelEvent = z.infer<typeof ChannelEventSchema>;

export function channelEventId(): string {
  return `evt_${randomBytes(18).toString("base64url")}`;
}

/**
 * The FIFO group an event is delivered in: one per conversation (or per person, for a direct message), so the
 * conversation's events reach its adapter in the order they were sent.
 */
export function channelEventGroupId(event: Pick<ChannelEvent, "channel" | "type"> & { conversation?: ConversationRef; to?: ActorRef }): string {
  const scope = event.type === "direct" && event.to !== undefined
    ? ["direct", event.to.channel, event.to.tenant, event.to.userId]
    : ["conversation", event.channel, event.conversation?.tenant ?? "", event.conversation?.space ?? "", event.conversation?.thread ?? ""];
  return createHash("sha256").update(scope.join("/")).digest("hex");
}

/** FR-023: an approval request shaped for the adapter. A stepped-up kind carries no actions; a buttonless adapter gets numbered replies in the text. */
export function shapeApprovalRequest(
  adapter: Pick<ChannelAdapterRecord, "capabilities" | "stepUp">,
  data: Omit<z.infer<typeof eventData.approval_request>, "actions">,
  actions: ReadonlyArray<z.infer<typeof ApprovalAction>>,
): z.infer<typeof eventData.approval_request> {
  const steppedUp = data.kind !== "other" && adapter.stepUp.includes(data.kind);
  if (steppedUp) return { ...data, text: `${data.text}\n\n${steppedUpNote(data.taskUrl)}` };
  if (adapter.capabilities.buttons >= actions.length) return { ...data, actions: [...actions] };
  const replies = actions.map((action, index) => `reply ${index + 1} to ${action.label.toLowerCase()}`).join(", ");
  return { ...data, text: `${data.text}\n\n${replies.charAt(0).toUpperCase()}${replies.slice(1)}.`, actions: [...actions] };
}

/** What a stepped-up approval request says in place of its actions: where to approve, or that it can't be approved here. */
export function steppedUpNote(taskUrl: string | undefined): string {
  return taskUrl === undefined ? "This needs a signed-in approval, which this channel can't give." : `Approve on the task page: ${taskUrl}`;
}

/** Whether an adapter may post a decision for a request of this kind (FR-032). */
export function adapterMayDecide(adapter: Pick<ChannelAdapterRecord, "stepUp">, kind: "plan_approval" | "admin" | "other"): boolean {
  return kind === "other" || !adapter.stepUp.includes(kind);
}

// ---- Commands the core sends an adapter and waits for (FR-072) ----

/** The command kinds, and the capability an adapter must declare to be sent each. */
export const COMMAND_CAPABILITY = {
  start_conversation: "startConversations",
  post_message: "proactive",
  direct_message: "direct",
  update_message: "edits",
  update_form: "forms",
  create_document: "documents",
  delete_document: "documents",
  space_members: "directory",
  user: "directory",
  user_by_email: "directory",
  space: "directory",
  spaces: "directory",
  check: "directory",
} as const;
export type ChannelCommandKind = keyof typeof COMMAND_CAPABILITY;

const commandBase = {
  version: z.literal(1),
  /** Unique per command; also its `webhook-id`, which the answer's signature repeats. */
  id: z.string().regex(/^cmd_[A-Za-z0-9_-]{16,64}$/),
  channel: ChannelIdSchema,
  createdAt: z.string().datetime(),
};

export const ChannelCommandSchema = z.discriminatedUnion("kind", [
  /** Posts the first message in a space; answers the new conversation's thread. */
  z.object({ ...commandBase, kind: z.literal("start_conversation"), tenant: ChannelOpaqueIdSchema, space: ChannelOpaqueIdSchema, message: z.object(richMessage).strict() }).strict(),
  /**
   * Phase 7c: posts a message in a space, in a thread or as a new one, or privately to one person there; answers the
   * message's ID and its thread. Used where the core must know what was posted, such as a card it edits later.
   */
  z.object({
    ...commandBase, kind: z.literal("post_message"), tenant: ChannelOpaqueIdSchema.optional(), space: ChannelOpaqueIdSchema, thread: ChannelOpaqueIdSchema.optional(),
    message: z.object(richMessage).strict(), audience: MessageAudienceSchema.optional(),
  }).strict(),
  /** A message to one person outside any conversation; answers where it went and its ID. */
  z.object({ ...commandBase, kind: z.literal("direct_message"), to: ActorRefSchema, message: z.object(richMessage).strict() }).strict(),
  /** Phase 7c3b: replaces a form still open, by the handle its submission gave. */
  z.object({ ...commandBase, kind: z.literal("update_form"), handle: z.string().min(1).max(255), form: ChannelFormSchema }).strict(),
  /** Replaces a message the adapter posted for the core. */
  z.object({ ...commandBase, kind: z.literal("update_message"), tenant: ChannelOpaqueIdSchema.optional(), space: ChannelOpaqueIdSchema, messageId: ChannelOpaqueIdSchema, message: z.object(richMessage).strict() }).strict(),
  /** A titled Markdown document people in the space can read, such as a task's plan; answers its ID and link. */
  z.object({ ...commandBase, kind: z.literal("create_document"), tenant: ChannelOpaqueIdSchema.optional(), space: ChannelOpaqueIdSchema, title: z.string().trim().min(1).max(150), markdown: z.string().min(1).max(100_000) }).strict(),
  z.object({ ...commandBase, kind: z.literal("delete_document"), documentId: ChannelOpaqueIdSchema }).strict(),
  /** One page of the people in a space. */
  z.object({ ...commandBase, kind: z.literal("space_members"), tenant: ChannelOpaqueIdSchema.optional(), space: ChannelOpaqueIdSchema, cursor: z.string().min(1).max(500).optional() }).strict(),
  z.object({ ...commandBase, kind: z.literal("user"), tenant: ChannelOpaqueIdSchema.optional(), userId: ChannelOpaqueIdSchema }).strict(),
  z.object({ ...commandBase, kind: z.literal("user_by_email"), tenant: ChannelOpaqueIdSchema.optional(), email: z.string().email().max(320) }).strict(),
  /** Phase 7c1b: a space's name and whether it is private; answers none for a space the adapter does not know. */
  z.object({ ...commandBase, kind: z.literal("space"), tenant: ChannelOpaqueIdSchema.optional(), space: ChannelOpaqueIdSchema }).strict(),
  /** One page of the tenant's public, open spaces, to find one by name. */
  z.object({ ...commandBase, kind: z.literal("spaces"), tenant: ChannelOpaqueIdSchema.optional(), cursor: z.string().min(1).max(500).optional() }).strict(),
  /** Whether the adapter can reach its surface, and the tenant it serves (Rovara's health check). */
  z.object({ ...commandBase, kind: z.literal("check") }).strict(),
]);
export type ChannelCommand = z.infer<typeof ChannelCommandSchema>;

/**
 * Phase 7c1b: a person as the adapter's directory knows them. `tenant` is their own; `linkedTenants` are others they
 * belong to (Slack Enterprise Grid). `external` is a person from another organisation in a shared space.
 */
export const DirectoryUserSchema = z.object({
  userId: ChannelOpaqueIdSchema,
  tenant: ChannelOpaqueIdSchema.optional(),
  linkedTenants: z.array(ChannelOpaqueIdSchema).max(200).optional(),
  name: z.string().min(1).max(200).optional(),
  displayName: z.string().max(200).optional(),
  realName: z.string().max(200).optional(),
  email: z.string().email().max(320).optional(),
  bot: z.boolean(),
  deleted: z.boolean(),
  external: z.boolean().optional(),
}).strict();
export type DirectoryUser = z.infer<typeof DirectoryUserSchema>;

/** What each command answers on success. */
export const ChannelCommandResultSchemas = {
  start_conversation: z.object({ thread: ChannelOpaqueIdSchema }).strict(),
  /** A private message has no ID to edit. */
  post_message: z.object({ space: ChannelOpaqueIdSchema, messageId: ChannelOpaqueIdSchema.optional(), thread: ChannelOpaqueIdSchema.optional() }).strict(),
  direct_message: z.object({ space: ChannelOpaqueIdSchema, messageId: ChannelOpaqueIdSchema }).strict(),
  update_message: z.object({ updated: z.literal(true) }).strict(),
  update_form: z.object({ updated: z.literal(true) }).strict(),
  create_document: z.object({ documentId: ChannelOpaqueIdSchema, url: HttpsUrl }).strict(),
  delete_document: z.object({ deleted: z.boolean() }).strict(),
  space_members: z.object({ members: z.array(ChannelOpaqueIdSchema).max(1_000), nextCursor: z.string().min(1).max(500).optional() }).strict(),
  /** None for a person the adapter does not know. */
  user: z.object({ user: DirectoryUserSchema.optional() }).strict(),
  user_by_email: z.object({ user: DirectoryUserSchema.optional() }).strict(),
  space: z.object({ space: z.object({ name: z.string().min(1).max(200), private: z.boolean() }).strict().optional() }).strict(),
  spaces: z.object({
    spaces: z.array(z.object({ space: ChannelOpaqueIdSchema, name: z.string().min(1).max(200), private: z.boolean() }).strict()).max(1_000),
    nextCursor: z.string().min(1).max(500).optional(),
  }).strict(),
  check: z.object({ tenant: ChannelOpaqueIdSchema }).strict(),
} as const;
export type ChannelCommandResult<K extends ChannelCommandKind> = z.infer<(typeof ChannelCommandResultSchemas)[K]>;

/** An adapter's answer: the command's result, or a refusal with a code and a message written for an administrator. */
export const ChannelCommandAnswerSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), message: z.string().max(500) }).strict() }).strict(),
]);

export function channelCommandId(): string {
  return `cmd_${randomBytes(18).toString("base64url")}`;
}

/** Whether an adapter takes a command kind: it names a commands URL and declares the kind's capability. */
export function adapterTakesCommand(adapter: Pick<ChannelAdapterRecord, "capabilities" | "commandsUrl">, kind: ChannelCommandKind): boolean {
  return adapter.commandsUrl !== undefined && adapter.capabilities[COMMAND_CAPABILITY[kind]] === true;
}

// ---- Standard Webhooks signing ----

export const WEBHOOK_TOLERANCE_SECONDS = 300;
const SECRET_PREFIX = "whsec_";

/**
 * A stored signing secret as the signer takes it, or undefined for one that is not (a revoked one). The built-in
 * adapter's secret is generated by the deployment as 64 letters and digits, which read as base64, without the prefix.
 */
export function usableWebhookSecret(stored: string | undefined): string | undefined {
  if (stored === undefined) return undefined;
  if (stored.startsWith(SECRET_PREFIX)) return stored;
  return /^[A-Za-z0-9]{64}$/.test(stored) ? `${SECRET_PREFIX}${stored}` : undefined;
}

/** A new signing secret: `whsec_` and 32 random bytes in base64. */
export function generateWebhookSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString("base64")}`;
}

function secretBytes(secret: string): Buffer {
  if (!secret.startsWith(SECRET_PREFIX)) throw new Error("signing secret must start with whsec_");
  const bytes = Buffer.from(secret.slice(SECRET_PREFIX.length), "base64");
  if (bytes.length < 24) throw new Error("signing secret is too short");
  return bytes;
}

/** The `webhook-signature` value for one message: `v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<body>">`. */
export function signWebhook(input: { secret: string; id: string; timestamp: number; body: string }): string {
  const mac = createHmac("sha256", secretBytes(input.secret)).update(`${input.id}.${input.timestamp}.${input.body}`).digest("base64");
  return `v1,${mac}`;
}

/** The three headers to send with a signed message. */
export function webhookHeaders(input: { secret: string; id: string; timestamp: number; body: string }): Record<string, string> {
  return { "webhook-id": input.id, "webhook-timestamp": String(input.timestamp), "webhook-signature": signWebhook(input) };
}

export type WebhookVerification =
  | { ok: true; id: string; timestamp: number }
  | { ok: false; reason: "missing_headers" | "bad_timestamp" | "stale_timestamp" | "bad_signature" };

/**
 * Checks a signed message: all three headers present, a timestamp within the tolerance of `nowSeconds` either way, and
 * one `v1` signature that matches in constant time. Header names are matched without regard to case.
 */
export function verifyWebhook(input: {
  secret: string;
  headers: Record<string, string | undefined>;
  body: string;
  nowSeconds: number;
  toleranceSeconds?: number;
}): WebhookVerification {
  const header = (name: string) => Object.entries(input.headers).find(([key]) => key.toLowerCase() === name)?.[1];
  const id = header("webhook-id");
  const timestampText = header("webhook-timestamp");
  const signatures = header("webhook-signature");
  if (!id || !timestampText || !signatures || id.length > 256) return { ok: false, reason: "missing_headers" };
  if (!/^\d{1,12}$/.test(timestampText)) return { ok: false, reason: "bad_timestamp" };
  const timestamp = Number(timestampText);
  if (Math.abs(input.nowSeconds - timestamp) > (input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS)) return { ok: false, reason: "stale_timestamp" };
  const expected = Buffer.from(signWebhook({ secret: input.secret, id, timestamp, body: input.body }).slice(3), "base64");
  for (const entry of signatures.split(" ").slice(0, 8)) {
    const [scheme, value] = entry.split(",", 2);
    if (scheme !== "v1" || value === undefined) continue;
    const given = Buffer.from(value, "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true, id, timestamp };
  }
  return { ok: false, reason: "bad_signature" };
}

// ---- Account linking (FR-030, FR-031) ----

export const LINK_CODE_TTL_SECONDS = 600;
/** At most one `link_required` event per actor in this window. */
export const LINK_REQUIRED_INTERVAL_SECONDS = 3_600;

/** A one-time link code: 24 random bytes, base64url. Only its hash is stored. */
export function generateLinkCode(): string {
  return randomBytes(24).toString("base64url");
}
export function linkCodeHash(code: string): string {
  return createHash("sha256").update(`channel-link:${code}`).digest("hex");
}
export const LinkCodeSchema = z.string().regex(/^[A-Za-z0-9_-]{32}$/);

/** A pending link: who asked, until when. Stored under its code's hash and deleted when redeemed. */
export const ChannelLinkCodeRecordSchema = z.object({
  actor: ActorRefSchema,
  expiresAt: z.number().int().positive(),
  createdAt: z.string().datetime(),
}).strict();
export type ChannelLinkCodeRecord = z.infer<typeof ChannelLinkCodeRecordSchema>;
export function channelLinkCodeKey(codeHash: string): { pk: string; sk: string } {
  if (!/^[a-f0-9]{64}$/.test(codeHash)) throw new Error("link code hash must be a sha256 hex digest");
  return { pk: `CHANNEL_LINK_CODE#${codeHash}`, sk: "META" };
}

/** A channel actor linked to a developer. Stored under the actor, and listed under the developer. */
export const ChannelLinkSchema = z.object({
  actor: ActorRefSchema,
  developerId: z.string().min(1).max(200),
  linkedAt: z.string().datetime(),
}).strict();
export type ChannelLink = z.infer<typeof ChannelLinkSchema>;

function actorParts(actor: z.infer<typeof ActorRefSchema>) {
  const parsed = ActorRefSchema.parse(actor);
  if (parsed.channel === SLACK_CHANNEL) throw new Error("Slack actors are not linked under these unscoped keys: the hosted product verifies them itself (an in-process adapter links through the company-scoped keys below)");
  return parsed;
}
export function channelLinkKey(actor: z.infer<typeof ActorRefSchema>): { pk: string; sk: string } {
  const parsed = actorParts(actor);
  return { pk: `CHANNEL_LINK#${parsed.channel}/${parsed.tenant}`, sk: `USER#${parsed.userId}` };
}
export function developerChannelLinkKey(developerId: string, actor: z.infer<typeof ActorRefSchema>): { pk: string; sk: string } {
  const parsed = actorParts(actor);
  return { pk: `DEVELOPER_CHANNEL_LINKS#${developerId}`, sk: `${parsed.channel}/${parsed.tenant}/${parsed.userId}` };
}

/**
 * Owner decision 58 and 45.6: the same link keys under the company scope (`ORG#<company>#...`), for the in-process adapters, whose people are linked to a person of one company. The unscoped
 * keys above are the registered (webhook) adapters' stored layout and keep refusing `slack` (the hosted product's own path serves that tool); an in-process adapter of any id, `slack` included, links through these.
 */
export function orgChannelLinkKey(orgId: OrgId, actor: z.infer<typeof ActorRefSchema>): OrgKey {
  const parsed = ActorRefSchema.parse(actor);
  return { pk: orgScoped(orgId, `CHANNEL_LINK#${parsed.channel}/${parsed.tenant}`), sk: `USER#${parsed.userId}` };
}
export function orgDeveloperChannelLinkKey(orgId: OrgId, developerId: string, actor: z.infer<typeof ActorRefSchema>): OrgKey {
  const parsed = ActorRefSchema.parse(actor);
  return { pk: orgScoped(orgId, `DEVELOPER_CHANNEL_LINKS#${developerId}`), sk: `${parsed.channel}/${parsed.tenant}/${parsed.userId}` };
}
export function orgChannelLinkCodeKey(orgId: OrgId, codeHash: string): OrgKey {
  if (!/^[a-f0-9]{64}$/.test(codeHash)) throw new Error("link code hash must be a sha256 hex digest");
  return { pk: orgScoped(orgId, `CHANNEL_LINK_CODE#${codeHash}`), sk: "META" };
}

/** FR-031: a channel user ID as the confirmation shows it, such as `+91 ••• 4821`. */
export function maskChannelUserId(userId: string): string {
  if (userId.length <= 6) return "•••";
  return `${userId.slice(0, 3)} ••• ${userId.slice(-4)}`;
}
