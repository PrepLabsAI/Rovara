import { z } from "zod";
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

export const SlackChannelBindingSchema = z
  .object({
    teamId: SlackTeamIdSchema,
    channelId: SlackChannelIdSchema,
    projectName: AgentXNameSchema,
    projectRevision: z.number().int().positive(),
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
]);

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

export function slackThreadSubject(thread: SlackThread): string {
  const parsed = SlackThreadSchema.parse(thread);
  return `${parsed.teamId}/${parsed.channelId}/${parsed.threadTs}`;
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
export type SlackRequestMessage = z.infer<typeof SlackRequestMessageSchema>;
