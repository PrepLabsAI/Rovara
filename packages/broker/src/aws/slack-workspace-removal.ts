// Guided onboarding PR 4: Slack's app_uninstalled and tokens_revoked events (https://docs.slack.dev/reference/events/app_uninstalled, .../tokens_revoked), as the Slack
// ingress hands them to the broker after Slack's signature check (slack-company-install.ts handleSlackWorkspaceRemoved). Kept apart so the ingress bundle stays small.
import { z } from "zod";
import { slackWorkspaceTeam } from "./slack-workspace-binding.js";

/** The Slack ingress hands a signature-verified removal to the broker with this direct invoke (IAM protects the invoke). Identifiers only. */
export const SlackWorkspaceRemovedEventSchema = z.object({
  source: z.literal("agentx.slack-workspace-removed"),
  teamId: z.string().max(32).refine(slackWorkspaceTeam),
  reason: z.enum(["app_uninstalled", "tokens_revoked"]),
  /** Slack's event_time (epoch seconds): an event older than the company's latest connect is ignored, so a late event never undoes a reconnect. */
  eventTime: z.number().int().positive().max(8_640_000_000),
}).strict();
export type SlackWorkspaceRemovedEvent = z.infer<typeof SlackWorkspaceRemovedEventSchema>;
export function isSlackWorkspaceRemovedEvent(event: unknown): boolean {
  return event !== null && typeof event === "object" && !Array.isArray(event) && (event as { source?: unknown }).source === "agentx.slack-workspace-removed";
}

/**
 * The ingress's half: from a verified event_callback payload, the removal to hand on, or undefined (not a removal, or a tokens_revoked naming no bot token: Rovara holds no
 * user tokens). The team is the payload's own team_id; an Enterprise Grid id is not a workspace.
 */
export function slackWorkspaceRemovalOf(payload: Record<string, unknown>): SlackWorkspaceRemovedEvent | undefined {
  const event = payload.event as { type?: unknown; tokens?: { bot?: unknown } } | undefined;
  if (event === null || typeof event !== "object") return undefined;
  if (event.type !== "app_uninstalled" && event.type !== "tokens_revoked") return undefined;
  if (event.type === "tokens_revoked" && (!Array.isArray(event.tokens?.bot) || event.tokens.bot.length === 0)) return undefined;
  const parsed = SlackWorkspaceRemovedEventSchema.safeParse({ source: "agentx.slack-workspace-removed", teamId: payload.team_id, reason: event.type, eventTime: payload.event_time });
  return parsed.success ? parsed.data : undefined;
}
