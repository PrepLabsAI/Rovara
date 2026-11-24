// S1: a press of a task action button (`rovara_task:*`), or the describe of one (the form and the confirm it needs), handed to the core in process. The interactivity Lambda verified Slack's signature and the workspace; the broker maps the
// Slack account to the linked Rovara person with its one resolver (`companySlackCaller`) and asks the core (`CoreTaskEntry.taskAction`), which resolves the account AGAIN, judges the press (who, when, revision, confirm digest) and binds the
// surface from the verified Slack conversation (`via`), never from this event. This file only validates the event's shape, maps it, and answers: every expected answer (done, refused, a form to show) is a 200 with its status, so Slack is
// never asked to retry it; a throw means nothing was done and is a 503 the Lambda tells the person about ("press again"). No HTTP request is made or faked.
import { ActionValuesSchema, ActorRefSchema, ConversationRefSchema, SLACK_CHANNEL, SlackThreadSchema, SlackUserIdSchema } from "@agentx/contracts";
import { z } from "zod";
import type { CoreTaskEntry } from "./engine-boundary.js";
import type { TaskActionAnswer } from "../core-host/task-action-routes.js";

const Base = { actionId: z.string().min(1).max(64), taskId: z.string().uuid(), binding: z.unknown(), values: ActionValuesSchema.optional(), conversation: ConversationRefSchema, actor: ActorRefSchema };
const PressSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("describe"), ...Base }).strict(),
  z.object({ mode: z.literal("perform"), ...Base, confirmDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(), requestKey: z.string().min(1).max(400) }).strict(),
]);

export interface SlackTaskActionEvent { source: "agentx.slack-ingress"; action: "core-task-action"; press: z.input<typeof PressSchema> }

export function isSlackTaskActionEvent(event: unknown): event is SlackTaskActionEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  // API Gateway always sets requestContext, so a request from outside can never take this path.
  return value.source === "agentx.slack-ingress" && value.action === "core-task-action" && value.requestContext === undefined && typeof value.press === "object" && value.press !== null;
}

const INVALID = { mode: "perform", result: { status: "refused", code: "TASK_ACTION_NOT_OFFERED", reason: "not_offered", writes: "none" } } as const satisfies TaskActionAnswer;

export async function answerSlackTaskAction(
  entry: CoreTaskEntry | undefined, event: SlackTaskActionEvent,
  callerOf: (thread: { teamId: string; channelId: string; threadTs: string }, userId: string) => Promise<{ developerId: string; sessionId: string; name: string }>,
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  const headers = { "content-type": "application/json", "cache-control": "no-store" };
  const answer = (value: TaskActionAnswer | { notLinked: true }) => ({ statusCode: 200, headers, body: JSON.stringify(value) });
  const parsed = PressSchema.safeParse(event.press);
  if (!parsed.success) return answer(INVALID);
  const press = parsed.data;
  // Slack only, in one workspace: a guest from a shared channel is another workspace's account.
  if (press.conversation.channel !== SLACK_CHANNEL || press.actor.channel !== SLACK_CHANNEL || press.actor.tenant !== press.conversation.tenant) return answer(INVALID);
  const thread = SlackThreadSchema.safeParse({ teamId: press.conversation.tenant, channelId: press.conversation.space, threadTs: press.conversation.thread });
  const user = SlackUserIdSchema.safeParse(press.actor.userId);
  if (!thread.success || !user.success || entry?.taskAction === undefined) return answer(INVALID);
  try {
    let caller: { developerId: string; sessionId: string; name: string };
    try { caller = await callerOf(thread.data, user.data); } catch { return answer({ notLinked: true }); }
    return answer(await entry.taskAction({ developerId: caller.developerId, sessionId: caller.sessionId, name: caller.name }, press));
  } catch {
    return { statusCode: 503, headers, body: JSON.stringify({ error: { code: "RUNTIME_UNAVAILABLE", message: "The press was not taken." } }) };
  }
}
