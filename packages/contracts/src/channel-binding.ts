import { z } from "zod";
import { ChannelIdSchema, ChannelOpaqueIdSchema, SLACK_CHANNEL } from "./conversation.js";
import { orgScoped, type OrgId, type OrgKey } from "./company-scope.js";
import { AgentXNameSchema } from "./names.js";
import { SlackChannelBindingSchema, SlackChannelIdSchema, SlackTeamIdSchema, type SlackChannelBinding } from "./slack.js";

/**
 * Spec 062 FR-010: a channel's space bound to a project. Slack bindings keep their stored keys and attributes
 * (`SLACK_BINDING#<team>` / `CHANNEL#<channel>`, `teamId`, `channelId`), so no row moves; other channels use
 * `BINDING#<channel>/<tenant>` / `SPACE#<space>`.
 */

/** Where a binding applies: a channel's space within a tenant. */
export const ChannelSpaceRefSchema = z.object({
  channel: ChannelIdSchema,
  tenant: ChannelOpaqueIdSchema,
  space: ChannelOpaqueIdSchema,
}).strict().superRefine((ref, context) => {
  if (ref.channel !== SLACK_CHANNEL) return;
  if (!SlackTeamIdSchema.safeParse(ref.tenant).success) context.addIssue({ code: "custom", path: ["tenant"], message: "not a Slack tenant" });
  if (!SlackChannelIdSchema.safeParse(ref.space).success) context.addIssue({ code: "custom", path: ["space"], message: "not a Slack space" });
});
export type ChannelSpaceRef = z.infer<typeof ChannelSpaceRefSchema>;

export const ChannelBindingSchema = z.object({
  channel: ChannelIdSchema,
  tenant: ChannelOpaqueIdSchema,
  space: ChannelOpaqueIdSchema,
  projectName: AgentXNameSchema,
  updatedAt: z.string().datetime(),
}).strict().superRefine((binding, context) => {
  const ref = ChannelSpaceRefSchema.safeParse({ channel: binding.channel, tenant: binding.tenant, space: binding.space });
  if (!ref.success) for (const issue of ref.error.issues) context.addIssue({ code: "custom", path: issue.path, message: issue.message });
});
export type ChannelBinding = z.infer<typeof ChannelBindingSchema>;

/**
 * The partition holding a tenant's bindings on one channel, for a query. A Slack team is used as given, as today, so
 * an unset or malformed team finds nothing rather than throwing; another channel's tenant must be a valid ID, so the
 * `<channel>/<tenant>` partition is unambiguous.
 */
export function channelBindingPartition(channel: string, tenant: string): string {
  const parsedChannel = ChannelIdSchema.parse(channel);
  if (parsedChannel === SLACK_CHANNEL) return `SLACK_BINDING#${tenant}`;
  return `BINDING#${parsedChannel}/${ChannelOpaqueIdSchema.parse(tenant)}`;
}

/** The sort-key prefix of every binding on a channel, for listing a tenant's bindings. */
export function channelBindingSortPrefix(channel: string): string {
  return ChannelIdSchema.parse(channel) === SLACK_CHANNEL ? "CHANNEL#" : "SPACE#";
}

/** The state-table key of one space's binding. */
export function channelBindingKey(ref: ChannelSpaceRef): { pk: string; sk: string } {
  const parsed = ChannelSpaceRefSchema.parse(ref);
  return { pk: channelBindingPartition(parsed.channel, parsed.tenant), sk: `${channelBindingSortPrefix(parsed.channel)}${parsed.space}` };
}

/**
 * Decisions 45.6 and 45.5a: the same binding key under the company scope (`ORG#<orgId>#...`), the layout Cloud and Code share. For Slack it equals
 * `slackBindingKey(orgId, team, channel)` in org-scoped-keys.ts; another channel's binding sits under the same scope. The unscoped functions above are
 * public's stored layout (phase 2) and stay until the broker's call sites move to these in lane L6.
 */
export function orgChannelBindingPartition(orgId: OrgId, channel: string, tenant: string): string {
  return orgScoped(orgId, channelBindingPartition(channel, tenant));
}

export function orgChannelBindingKey(orgId: OrgId, ref: ChannelSpaceRef): OrgKey {
  const key = channelBindingKey(ref);
  return { pk: orgScoped(orgId, key.pk), sk: key.sk };
}

/** Whether a stored row's key is exactly `ref`'s binding key. Never throws: a malformed `ref` is simply not a match. */
export function isChannelBindingKeyOf(item: { pk?: unknown; sk?: unknown }, ref: ChannelSpaceRef): boolean {
  if (!ChannelSpaceRefSchema.safeParse(ref).success) return false;
  const key = channelBindingKey(ref);
  return item.pk === key.pk && item.sk === key.sk;
}

/** The entity type a binding row is stored with: `SLACK_BINDING` for Slack, as today. */
export function channelBindingEntityType(channel: string): string {
  return ChannelIdSchema.parse(channel) === SLACK_CHANNEL ? "SLACK_BINDING" : "CHANNEL_BINDING";
}

export function channelBindingFromSlack(binding: SlackChannelBinding): ChannelBinding {
  return ChannelBindingSchema.parse({
    channel: SLACK_CHANNEL, tenant: binding.teamId, space: binding.channelId, projectName: binding.projectName, updatedAt: binding.updatedAt,
  });
}

export function slackBindingOf(binding: ChannelBinding): SlackChannelBinding {
  const parsed = ChannelBindingSchema.parse(binding);
  if (parsed.channel !== SLACK_CHANNEL) throw new Error(`not a Slack binding: ${parsed.channel}`);
  return SlackChannelBindingSchema.parse({ teamId: parsed.tenant, channelId: parsed.space, projectName: parsed.projectName, updatedAt: parsed.updatedAt });
}

/** A binding's stored attributes besides its key. Slack keeps `teamId` and `channelId`; other channels store the neutral fields. */
export function channelBindingAttributes(binding: ChannelBinding): Record<string, string> {
  const parsed = ChannelBindingSchema.parse(binding);
  if (parsed.channel === SLACK_CHANNEL) {
    return { entityType: channelBindingEntityType(parsed.channel), ...slackBindingOf(parsed) };
  }
  return { entityType: channelBindingEntityType(parsed.channel), ...parsed };
}

/**
 * The binding a stored row holds for `ref`; undefined when there is no row. A row that is malformed or names another
 * space throws, as reading a Slack binding does today, so a corrupt row is an error rather than "not bound".
 * Extra stored attributes (`pk`, `sk`, `updatedBy`, an old `projectRevision`) are ignored.
 */
export function readChannelBindingItem(ref: ChannelSpaceRef, item: Record<string, unknown> | undefined): ChannelBinding | undefined {
  if (item === undefined) return undefined;
  const parsedRef = ChannelSpaceRefSchema.parse(ref);
  const stored = parsedRef.channel === SLACK_CHANNEL
    ? { channel: SLACK_CHANNEL, tenant: item.teamId, space: item.channelId }
    : { channel: item.channel, tenant: item.tenant, space: item.space };
  const binding = ChannelBindingSchema.parse({ ...stored, projectName: item.projectName, updatedAt: item.updatedAt });
  if (binding.channel !== parsedRef.channel || binding.tenant !== parsedRef.tenant || binding.space !== parsedRef.space) {
    throw new Error("stored binding names another space");
  }
  return binding;
}
