import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import {
  ActorRefSchema,
  SLACK_CHANNEL,
  agentXError,
  conversationOwnerIssuer,
  conversationSubject,
  parseConversationSubject,
  type ActorRef,
  type ChannelAdapterRecord,
  type ChannelBinding,
  type ChannelSpaceRef,
  type ConversationRef,
  type DeveloperRequester,
} from "@agentx/contracts";
import type { AuthenticatedIdentity, ChannelConversation } from "../auth.js";
import { ownerKeyForSubject } from "./lambda.js";
import { chargeItems, developerCharge, releaseItems } from "../developer/limits.js";
import type { WorkspaceCharge } from "../developer/task-records.js";

/**
 * Spec 062 Phase 4: the orchestrator acting for an adapter conversation on the service routes. Slack keeps its own
 * headers and identity; an adapter conversation is named by its four-segment subject and the actor's user ID, and the
 * broker checks again everything the channel API checked, so an unlink, an unbinding or a removed adapter takes effect
 * on the next call.
 */
export const CONVERSATION_HEADER = "x-agentx-conversation";
export const ACTOR_HEADER = "x-agentx-actor";

type TransactItems = NonNullable<TransactWriteCommandInput["TransactItems"]>;

export interface ChannelConversationDependencies {
  getAdapter(channel: string): Promise<ChannelAdapterRecord | undefined>;
  getBinding(ref: ChannelSpaceRef): Promise<ChannelBinding | undefined>;
  linkedDeveloper(actor: ActorRef): Promise<string | undefined>;
  getDeveloper(developerId: string): Promise<{ developerId: string; provider: DeveloperRequester["provider"]; displayName: string; slackUserId?: string; revoked: boolean } | undefined>;
}

/** The conversation and actor the headers name; undefined when the call is not for an adapter conversation. */
export function readConversationHeaders(headers: Record<string, string | undefined>): { ref: ConversationRef; actor: ActorRef } | undefined {
  const subject = headers[CONVERSATION_HEADER];
  if (subject === undefined) return undefined;
  try {
    const ref = parseConversationSubject(subject);
    if (ref.channel === SLACK_CHANNEL) throw new Error("slack");
    const actor = ActorRefSchema.parse({ channel: ref.channel, tenant: ref.tenant, userId: headers[ACTOR_HEADER] });
    return { ref, actor };
  } catch {
    throw agentXError("CONFIG_INVALID", `valid ${CONVERSATION_HEADER} and ${ACTOR_HEADER} headers are required`);
  }
}

/** FR-024, FR-030: a registered adapter, a space bound to one of its projects, and an actor linked to a current developer. */
export async function channelConversationIdentity(
  deps: ChannelConversationDependencies,
  ref: ConversationRef,
  actor: ActorRef,
): Promise<AuthenticatedIdentity> {
  const adapter = await deps.getAdapter(ref.channel);
  if (adapter === undefined) throw agentXError("FORBIDDEN", "this channel has no registered adapter");
  const binding = await deps.getBinding({ channel: ref.channel, tenant: ref.tenant, space: ref.space });
  if (binding === undefined || !adapter.projects.includes(binding.projectName)) throw agentXError("FORBIDDEN", "this space is not bound to a project the adapter serves");
  const developerId = await deps.linkedDeveloper(actor);
  if (developerId === undefined) throw agentXError("FORBIDDEN", "this channel user is not linked to a Rovara sign-in");
  const developer = await deps.getDeveloper(developerId);
  if (developer === undefined || developer.revoked || developer.developerId !== developerId) throw agentXError("FORBIDDEN", "the linked Rovara sign-in is no longer active");
  const subject = conversationSubject(ref);
  const issuer = conversationOwnerIssuer(ref.channel);
  const channel: ChannelConversation = {
    ref, actor, projectName: binding.projectName, adapter,
    developer: {
      developerId, provider: developer.provider, name: developer.displayName,
      ...(developer.slackUserId === undefined ? {} : { slackUserId: developer.slackUserId }),
    },
  };
  return { issuer, subject, ownerKey: ownerKeyForSubject(issuer, subject), isAdministrator: false, claims: {}, channel };
}

/** Who asked, for an operation record: the linked developer, who is accountable for the adapter actor (FR-030). */
export function channelRequester(channel: ChannelConversation): DeveloperRequester {
  return { kind: "developer", developerId: channel.developer.developerId, provider: channel.developer.provider };
}

/**
 * The counters an adapter conversation's workspace is charged to: the linked developer's, which are their Slack
 * member's when the developer is linked to Slack (R6), so one person has one allowance across every surface.
 */
export function channelCharge(channel: ChannelConversation, slackTeamId: string | undefined): WorkspaceCharge {
  return developerCharge({ teamId: slackTeamId, slackUserId: channel.developer.slackUserId, developerId: channel.developer.developerId });
}

/** The entry an adapter conversation holds in its member counter's `tasks` set. Task IDs are UUIDs, so it never matches one. */
export const conversationChargeMarker = (subject: string) => `conversation:${subject}`;

/** Whether a member counter's `tasks` entry is an adapter conversation, not a developer task. */
export const isConversationChargeMarker = (entry: string) => entry.startsWith("conversation:");

/**
 * An adapter conversation's preparation charge: the two counters (positions 0 and 1, as chargeConflict reads them),
 * and the thread record marked with its starter and charge, which a close or a failed preparation gives back.
 */
export function channelThreadChargeItems(input: {
  tableName: string;
  threadKey: { pk: string; sk: string };
  subject: string;
  workspaceId: string;
  developerId: string;
  charge: WorkspaceCharge;
  limits: { member: number; organization: number };
}): TransactItems {
  return [
    ...chargeItems(input.tableName, input.charge, input.limits, conversationChargeMarker(input.subject)),
    { Update: {
      TableName: input.tableName,
      Key: input.threadKey,
      UpdateExpression: "SET #entity = :entity, #thread = if_not_exists(#thread, :thread), #workspace = if_not_exists(#workspace, :workspace), starterDeveloperId = :developer, #charge = :charge",
      ConditionExpression: "attribute_not_exists(starterDeveloperId) AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#entity": "entityType", "#thread": "thread", "#workspace": "workspaceId", "#charge": "charge" },
      ExpressionAttributeValues: { ":entity": "CHANNEL_THREAD", ":thread": input.subject, ":workspace": input.workspaceId, ":developer": input.developerId, ":charge": input.charge },
    } },
  ];
}

/** Gives back what channelThreadChargeItems took; `close` also marks the thread closed in the same write. */
export function channelThreadReleaseItems(input: {
  tableName: string;
  threadKey: { pk: string; sk: string };
  subject: string;
  developerId: string;
  charge: WorkspaceCharge;
  close?: { closedAt: string; operationId: string };
}): TransactItems {
  return [
    ...releaseItems(input.tableName, input.charge, conversationChargeMarker(input.subject)),
    { Update: {
      TableName: input.tableName,
      Key: input.threadKey,
      UpdateExpression: input.close === undefined ? "REMOVE starterDeveloperId" : "SET closedAt = :closedAt, closeOperationId = :operation REMOVE starterDeveloperId",
      ConditionExpression: "starterDeveloperId = :developer AND attribute_not_exists(closedAt)",
      ExpressionAttributeValues: {
        ":developer": input.developerId,
        ...(input.close === undefined ? {} : { ":closedAt": input.close.closedAt, ":operation": input.close.operationId }),
      },
    } },
  ];
}

/** A charge read back from a thread record, or undefined when the row does not hold a well-formed one. */
export function storedCharge(value: unknown): WorkspaceCharge | undefined {
  const key = (candidate: unknown) => typeof candidate === "object" && candidate !== null
    && typeof (candidate as { pk?: unknown }).pk === "string" && typeof (candidate as { sk?: unknown }).sk === "string";
  if (typeof value !== "object" || value === null) return undefined;
  const { member, organization } = value as { member?: unknown; organization?: unknown };
  if (!key(member) || !key(organization)) return undefined;
  return { member: { pk: (member as { pk: string }).pk, sk: (member as { sk: string }).sk }, organization: { pk: (organization as { pk: string }).pk, sk: (organization as { sk: string }).sk } };
}
