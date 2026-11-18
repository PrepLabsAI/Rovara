// HW5b: a press of Approve, or the words typed for Request changes, on the plan card a core task's Slack thread was given (`core-host/chat-decision.ts`, `CoreTaskEntry.chatDecision`). The interactivity Lambda verified Slack's signature
// and that the clicking account is a linked member of the workspace's company, and hands the press here (the ONE new route of this lane: `source: "agentx.slack-ingress"`, `action: "core-plan-press"`, never an HTTP request). This asks
// the core, as the Slack person's linked Rovara person, and the rule is the core's alone (the account, the workspace, the card, the risk, the person's authority; and again in the approvers' `chat-slack` method). A refusal is a fixed
// answer and writes nothing. `undefined` from the entry (a deployment that serves no chat decision) is a refusal, never a decision.
import { ActorRefSchema, ConversationRefSchema, SLACK_CHANNEL, SlackThreadSchema, SlackUserIdSchema } from "@agentx/contracts";
import { z } from "zod";
import type { CoreEntryCaller, CoreTaskEntry } from "./engine-boundary.js";

const PressSchema = z.object({
  conversation: ConversationRefSchema, actor: ActorRefSchema, eventId: z.string().min(1).max(128),
  requestId: z.string().uuid(), expectedRevision: z.number().int().positive(), artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  decision: z.enum(["APPROVE", "REQUEST_CHANGES"]), reason: z.string().max(5_000),
}).strict();

export interface SlackCorePressEvent {
  source: "agentx.slack-ingress";
  action: "core-plan-press";
  press: z.input<typeof PressSchema>;
}

export function isSlackCorePressEvent(event: unknown): event is SlackCorePressEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  // API Gateway always sets requestContext, so a request from outside can never take this path.
  return value.source === "agentx.slack-ingress" && value.action === "core-plan-press" && value.requestContext === undefined && typeof value.press === "object" && value.press !== null;
}

/** What the Lambda is told: `decided` (also a repeat of a finished decision), `duplicate` (this very press was already taken), or a refusal with the reason code that picks its fixed words. */
export type SlackCorePressAnswer = { status: "decided" } | { status: "duplicate" } | { status: "refused"; reason: string };

export interface SlackCorePressInput {
  /** The Slack person's linked Rovara person (throws for one who is not linked, or whose workspace belongs to no company). */
  caller: () => Promise<{ developerId: string; sessionId: string; name: string }>;
}

export async function slackCorePress(entry: CoreTaskEntry | undefined, event: SlackCorePressEvent, input: SlackCorePressInput): Promise<SlackCorePressAnswer> {
  const parsed = PressSchema.safeParse(event.press);
  if (!parsed.success) return { status: "refused", reason: "invalid" };
  const press = parsed.data;
  // Slack only, in one workspace: a guest from a shared channel is another workspace's account.
  if (press.conversation.channel !== SLACK_CHANNEL || press.actor.channel !== SLACK_CHANNEL || press.actor.tenant !== press.conversation.tenant) return { status: "refused", reason: "not_allowed" };
  if (entry?.chatDecision === undefined) return { status: "refused", reason: "method_not_allowed" };
  let caller: CoreEntryCaller;
  try {
    const linked = await input.caller();
    caller = { developerId: linked.developerId, sessionId: linked.sessionId, name: linked.name };
  } catch { return { status: "refused", reason: "link_gone" }; }
  const result = await entry.chatDecision(caller, press);
  return result.outcome === "refused" ? { status: "refused", reason: result.reason } : { status: result.outcome };
}

/**
 * The broker's answer to the interactivity Lambda for one press (the route `isSlackCorePressEvent` names). Every expected answer (decided, repeated, refused) is a 200 with its status, so Slack is never asked to retry it; a throw means
 * nothing was decided, and is a 503 the Lambda tells the person about ("press again"). `callerOf` is the broker's own mapping of a Slack account to its linked Rovara person (`companySlackCaller`).
 */
export async function answerSlackCorePress(
  entry: CoreTaskEntry | undefined, event: SlackCorePressEvent,
  callerOf: (thread: { teamId: string; channelId: string; threadTs: string }, userId: string) => Promise<{ developerId: string; sessionId: string; name: string }>,
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  const headers = { "content-type": "application/json", "cache-control": "no-store" };
  const conversation = event.press.conversation as Partial<{ tenant: string; space: string; thread: string }> | undefined;
  const thread = SlackThreadSchema.safeParse({ teamId: conversation?.tenant, channelId: conversation?.space, threadTs: conversation?.thread });
  const user = SlackUserIdSchema.safeParse((event.press.actor as Partial<{ userId: string }> | undefined)?.userId);
  try {
    const answer: SlackCorePressAnswer = !thread.success || !user.success ? { status: "refused", reason: "invalid" } : await slackCorePress(entry, event, { caller: () => callerOf(thread.data, user.data) });
    return { statusCode: 200, headers, body: JSON.stringify(answer) };
  } catch {
    return { statusCode: 503, headers, body: JSON.stringify({ error: { code: "RUNTIME_UNAVAILABLE", message: "The press was not taken." } }) };
  }
}
