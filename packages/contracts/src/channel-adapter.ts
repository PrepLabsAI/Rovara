import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ActorRefSchema, ChannelIdSchema, ChannelOpaqueIdSchema, ConversationRefSchema, InboundMessageSchema, SLACK_CHANNEL } from "./conversation.js";
import { orgScoped, type OrgId, type OrgKey } from "./company-scope.js";
import { publicHttpsUrlSchema } from "./mcp-connector.js";
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
  capabilities: ChannelCapabilitiesSchema,
  projects: uniqueList(AgentXNameSchema, 64, "projects").refine((projects) => projects.length > 0, "an adapter must be registered for at least one project"),
  stepUp: uniqueList(StepUpKindSchema, 2, "stepUp").default([...DEFAULT_STEP_UP]),
}).strict();
export type ChannelAdapterRegistration = z.infer<typeof ChannelAdapterRegistrationSchema>;

/** A registered adapter as the state table stores it. The signing secret is in Secrets Manager under `secretName`. */
export const ChannelAdapterRecordSchema = z.object({
  channel: RegisteredChannelIdSchema,
  callbackUrl: publicHttpsUrlSchema("callbackUrl"),
  capabilities: ChannelCapabilitiesSchema,
  projects: uniqueList(AgentXNameSchema, 64, "projects"),
  stepUp: uniqueList(StepUpKindSchema, 2, "stepUp"),
  secretName: z.string().min(1).max(512),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  updatedBy: z.string().min(1).max(512),
}).strict();
export type ChannelAdapterRecord = z.infer<typeof ChannelAdapterRecordSchema>;

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
export const ChannelQueueItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("message"), message: InboundMessageSchema, projectName: AgentXNameSchema, developerId: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("decision"), decision: ChannelDecisionSchema, projectName: AgentXNameSchema, developerId: z.string().min(1).max(200) }).strict(),
]);
export type ChannelQueueItem = z.infer<typeof ChannelQueueItemSchema>;

// ---- Events Rovara sends to an adapter (FR-022) ----

const Text = z.string().min(1).max(40_000);
const HttpsUrl = z.string().url().max(2_048).refine((url) => url.startsWith("https://"), "must be an https URL");
const ApprovalAction = z.object({ decision: ChannelDecisionValueSchema, label: z.string().min(1).max(80) }).strict();

const eventData = {
  ack: z.object({ inReplyTo: ChannelOpaqueIdSchema }).strict(),
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
    taskUrl: HttpsUrl,
    /** Absent when the adapter steps this kind up (FR-032): the person approves on `taskUrl`. */
    actions: z.array(ApprovalAction).min(1).max(4).optional(),
  }).strict(),
  check_report: z.object({ text: Text, status: z.enum(["passed", "failed", "unknown"]) }).strict(),
  pr: z.object({ url: HttpsUrl, title: z.string().min(1).max(300) }).strict(),
  done: z.object({ text: Text }).strict(),
  error: z.object({ code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), text: Text }).strict(),
  link_required: z.object({ linkUrl: HttpsUrl, expiresAt: z.string().datetime(), actor: ActorRefSchema }).strict(),
} as const;
export type ChannelEventType = keyof typeof eventData;
export const CHANNEL_EVENT_TYPES = Object.keys(eventData) as ChannelEventType[];

const eventBase = {
  version: z.literal(1),
  /** Stable across retries, so the adapter drops a repeat (it is also the `webhook-id`). */
  id: z.string().regex(/^evt_[A-Za-z0-9_-]{16,64}$/),
  channel: AdapterChannelIdSchema,
  conversation: ConversationRefSchema,
  createdAt: z.string().datetime(),
};
export const ChannelEventSchema = z.discriminatedUnion("type", [
  z.object({ ...eventBase, type: z.literal("ack"), data: eventData.ack }).strict(),
  z.object({ ...eventBase, type: z.literal("progress"), data: eventData.progress }).strict(),
  z.object({ ...eventBase, type: z.literal("question"), data: eventData.question }).strict(),
  z.object({ ...eventBase, type: z.literal("approval_request"), data: eventData.approval_request }).strict(),
  z.object({ ...eventBase, type: z.literal("check_report"), data: eventData.check_report }).strict(),
  z.object({ ...eventBase, type: z.literal("pr"), data: eventData.pr }).strict(),
  z.object({ ...eventBase, type: z.literal("done"), data: eventData.done }).strict(),
  z.object({ ...eventBase, type: z.literal("error"), data: eventData.error }).strict(),
  z.object({ ...eventBase, type: z.literal("link_required"), data: eventData.link_required }).strict(),
]).superRefine((event, context) => {
  if (event.conversation.channel !== event.channel) context.addIssue({ code: "custom", path: ["conversation", "channel"], message: "must equal channel" });
});
export type ChannelEvent = z.infer<typeof ChannelEventSchema>;

export function channelEventId(): string {
  return `evt_${randomBytes(18).toString("base64url")}`;
}

/** FR-023: an approval request shaped for the adapter. A stepped-up kind carries no actions; a buttonless adapter gets numbered replies in the text. */
export function shapeApprovalRequest(
  adapter: Pick<ChannelAdapterRecord, "capabilities" | "stepUp">,
  data: Omit<z.infer<typeof eventData.approval_request>, "actions">,
  actions: ReadonlyArray<z.infer<typeof ApprovalAction>>,
): z.infer<typeof eventData.approval_request> {
  const steppedUp = data.kind !== "other" && adapter.stepUp.includes(data.kind);
  if (steppedUp) return { ...data, text: `${data.text}\n\nApprove on the task page: ${data.taskUrl}` };
  if (adapter.capabilities.buttons >= actions.length) return { ...data, actions: [...actions] };
  const replies = actions.map((action, index) => `reply ${index + 1} to ${action.label.toLowerCase()}`).join(", ");
  return { ...data, text: `${data.text}\n\n${replies.charAt(0).toUpperCase()}${replies.slice(1)}.`, actions: [...actions] };
}

/** Whether an adapter may post a decision for a request of this kind (FR-032). */
export function adapterMayDecide(adapter: Pick<ChannelAdapterRecord, "stepUp">, kind: "plan_approval" | "admin" | "other"): boolean {
  return kind === "other" || !adapter.stepUp.includes(kind);
}

// ---- Standard Webhooks signing ----

export const WEBHOOK_TOLERANCE_SECONDS = 300;
const SECRET_PREFIX = "whsec_";

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
