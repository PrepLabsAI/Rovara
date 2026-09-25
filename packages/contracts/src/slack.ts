import { z } from "zod";
import { ActionPolicySchema } from "./action-policy.js";
import { ThreadConnectorSchema } from "./connectors.js";
import { AgentXNameSchema } from "./project.js";
import { WorkspaceStatusSchema } from "./workspace.js";

// Thread owner keys hash this issuer; OIDC issuers are https URLs, so the key spaces never overlap.
export const SLACK_THREAD_OWNER_ISSUER = "slack-thread";

export const SlackTeamIdSchema = z.string().regex(/^[TE][A-Z0-9]{2,31}$/);
export const SlackChannelIdSchema = z.string().regex(/^[CG][A-Z0-9]{2,31}$/);
export const SlackUserIdSchema = z.string().regex(/^[UW][A-Z0-9]{2,31}$/);
export const SlackMessageTimestampSchema = z.string().regex(/^\d{10}\.\d{6}$/);

export const SlackThreadSchema = z
  .object({
    teamId: SlackTeamIdSchema,
    channelId: SlackChannelIdSchema,
    threadTs: SlackMessageTimestampSchema,
  })
  .strict();

export const SlackRequesterSchema = z
  .object({
    teamId: SlackTeamIdSchema,
    userId: SlackUserIdSchema,
  })
  .strict();

// A channel binds to a project, not a revision: new thread workspaces use the latest registered revision.
export const SlackChannelBindingSchema = z
  .object({
    teamId: SlackTeamIdSchema,
    channelId: SlackChannelIdSchema,
    projectName: AgentXNameSchema,
    updatedAt: z.string().datetime(),
  })
  .strict();

export const SlackWorkspaceLimitSchema = z.enum(["MEMBER", "ORGANIZATION"]);

export const SlackThreadWorkspaceResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("WORKSPACE"),
      workspaceId: z.string().uuid(),
      status: WorkspaceStatusSchema,
      operationId: z.string().uuid().nullable(),
      created: z.boolean(),
      orchestratorInstructions: z.string().min(1).max(32_768),
      githubMcpRepositories: z.array(AgentXNameSchema).max(32).optional(),
      // Connector metadata for services that send includeConnectors: true (feature 013).
      connectors: z.array(ThreadConnectorSchema).max(8).optional(),
      repositories: z.array(AgentXNameSchema).max(32).optional(),
      // Sent only to services that send includeRecoverableOperations: true (see the broker).
      recoverableOperations: z.array(z.string().uuid()).max(5).optional(),
      // The project revision whose settings the broker applied to this turn. Sent only to a
      // service that asked for it, because older deployed services parse this result strictly.
      settingsRevision: z.number().int().positive().optional(),
      // The latest revision's action policy, sent only to a service that sends includeActionPolicy: true.
      actionPolicy: ActionPolicySchema.optional(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("LIMIT_REACHED"),
      limit: SlackWorkspaceLimitSchema,
      maximum: z.number().int().positive(),
      starterThreads: z.array(SlackThreadSchema),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("CLOSED"),
      workspaceId: z.string().uuid(),
      closedAt: z.string().datetime(),
    })
    .strict(),
]);

// The answer to POST /v1/threads/workspace/prepare (spec 014). Only a service that sends
// lazyPreparation: true calls that route, so this schema never reaches an older service.
export const SlackThreadPrepareResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("WORKSPACE"),
      workspaceId: z.string().uuid(),
      status: WorkspaceStatusSchema,
      operationId: z.string().uuid().nullable(),
      // True only for the request whose write started this preparation.
      created: z.boolean(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("LIMIT_REACHED"),
      limit: SlackWorkspaceLimitSchema,
      maximum: z.number().int().positive(),
      starterThreads: z.array(SlackThreadSchema),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("CLOSED"),
      workspaceId: z.string().uuid(),
      closedAt: z.string().datetime(),
    })
    .strict(),
]);

export const SlackWorkspaceCloseStartResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("NOT_FOUND") }).strict(),
  z.object({
    outcome: z.literal("CLOSED"),
    workspaceId: z.string().uuid(),
    closedAt: z.string().datetime(),
  }).strict(),
  z.object({
    outcome: z.literal("PREFLIGHT"),
    workspaceId: z.string().uuid(),
    operationId: z.string().uuid(),
    status: z.enum(["ACCEPTED", "DISPATCHING", "RUNNING", "CANCEL_REQUESTED", "SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"]),
  }).strict(),
]);

export const SlackWorkspaceCloseCompleteResultSchema = z.object({
  outcome: z.literal("CLOSED"),
  workspaceId: z.string().uuid(),
  operationId: z.string().uuid(),
  closedAt: z.string().datetime(),
  storageReleased: z.boolean(),
}).strict();

export const SLACK_MESSAGE_CHUNK_LENGTH = 3_500;
const EMPTY_RESPONSE = "AgentX completed the request without returning a textual response.";

// One accepted app_mention, handed from the ingress Lambda to the orchestrator through the FIFO queue.
export const SlackRequestMessageSchema = z
  .object({
    version: z.literal(1),
    eventId: z.string().regex(/^Ev[A-Za-z0-9]{4,64}$/),
    thread: SlackThreadSchema,
    userId: SlackUserIdSchema,
    text: z.string().min(1).max(40_000),
    receivedAt: z.string().datetime(),
  })
  .strict();

/**
 * Spec 014 FR-026: the queue message attribute through which the ingress tells the Slack service how
 * many earlier requests in the thread a request was queued behind. It travels outside the body,
 * because an older Slack service parses the body strictly and would discard a message with a new field.
 */
export const SLACK_QUEUED_BEHIND_ATTRIBUTE = "queuedBehind";

export function queuedBehindAttributes(queuedBehind: number): Record<string, { DataType: "Number"; StringValue: string }> {
  return { [SLACK_QUEUED_BEHIND_ATTRIBUTE]: { DataType: "Number", StringValue: String(queuedBehind) } };
}

/** The count a received message carries, or undefined when it carries none (an older ingress) or a malformed one. */
export function queuedBehindOf(attributes: Readonly<Record<string, { StringValue?: string | undefined }>> | undefined): number | undefined {
  const value = attributes?.[SLACK_QUEUED_BEHIND_ATTRIBUTE]?.StringValue;
  return value !== undefined && /^\d{1,6}$/.test(value) ? Number(value) : undefined;
}

export function slackThreadSubject(thread: SlackThread): string {
  const parsed = SlackThreadSchema.parse(thread);
  return `${parsed.teamId}/${parsed.channelId}/${parsed.threadTs}`;
}

export function slackThreadUrl(thread: SlackThread): string {
  return `https://slack.com/archives/${thread.channelId}/p${thread.threadTs.replace(".", "")}`;
}

export function parseSlackThreadSubject(subject: string): SlackThread {
  const [teamId, channelId, threadTs, ...rest] = subject.split("/");
  if (rest.length > 0) throw new Error("Slack thread subject has too many segments");
  return SlackThreadSchema.parse({ teamId, channelId, threadTs });
}

export function slackRequestText(text: string, botUserId?: string): string {
  const withoutMention = botUserId
    ? text.replace(new RegExp(`<@${botUserId}>`, "gu"), "")
    : text.replace(/^\s*<@[A-Z0-9]+>\s*/u, "");
  return withoutMention.trim();
}

export function splitSlackMessage(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text.trim() || EMPTY_RESPONSE;
  while (remaining.length > SLACK_MESSAGE_CHUNK_LENGTH) {
    const boundary = Math.max(
      remaining.lastIndexOf("\n", SLACK_MESSAGE_CHUNK_LENGTH),
      remaining.lastIndexOf(" ", SLACK_MESSAGE_CHUNK_LENGTH),
    );
    const end = boundary > SLACK_MESSAGE_CHUNK_LENGTH / 2 ? boundary : SLACK_MESSAGE_CHUNK_LENGTH;
    chunks.push(remaining.slice(0, end).trimEnd());
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export type SlackThread = z.infer<typeof SlackThreadSchema>;
export type SlackRequester = z.infer<typeof SlackRequesterSchema>;
export type SlackChannelBinding = z.infer<typeof SlackChannelBindingSchema>;
export type SlackWorkspaceLimit = z.infer<typeof SlackWorkspaceLimitSchema>;
export type SlackThreadWorkspaceResult = z.infer<typeof SlackThreadWorkspaceResultSchema>;
export type SlackThreadPrepareResult = z.infer<typeof SlackThreadPrepareResultSchema>;
export type SlackWorkspaceCloseStartResult = z.infer<typeof SlackWorkspaceCloseStartResultSchema>;
export type SlackWorkspaceCloseCompleteResult = z.infer<typeof SlackWorkspaceCloseCompleteResultSchema>;
export type SlackRequestMessage = z.infer<typeof SlackRequestMessageSchema>;
