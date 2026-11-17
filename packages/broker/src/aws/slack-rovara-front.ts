// Guided onboarding PR 5: the Slack Lambda's half of `/rovara` and its Link / Unlink presses. Both arrive at Slack's interactivity request URL (POST /v1/slack/interactions,
// the slash command's request URL is set to the same address), whose handler has ALREADY checked Slack's signature (X-Slack-Signature v0 HMAC over v0:<timestamp>:<raw body>,
// a five-minute window, constant-time: slack-ingress.ts validSignature) before this module sees the body.
//
// Slack waits three seconds, so this side only reads the verified fields, hands them to an asynchronous invoke of this same Lambda and answers 200 at once (an empty answer:
// Slack then shows nothing until the follow-up). The asynchronous half asks the broker (slack-rovara-command.ts, a direct invoke) and posts its answer to the request's
// response_url, private to the person. Only Slack's own response URLs are ever fetched.
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { z } from "zod";
import { SlackChannelIdSchema, SlackUserIdSchema } from "@agentx/contracts";
import type { HttpResponse } from "./slack-ingress.js";
import type { SlackRovaraAnswer, SlackRovaraEvent } from "./slack-rovara-command.js";
import { slackWorkspaceTeam } from "./slack-workspace-binding.js";
import type { BrokerReply } from "./slack-workflow-choice.js";

export const ROVARA_COMMAND = "/rovara";
/** The two buttons' action ids (the broker's answers carry them; slack-rovara-command.ts). */
export const ROVARA_LINK_ACTION = "rovara_channel_link";
export const ROVARA_UNLINK_ACTION = "rovara_channel_unlink";
export const ROVARA_TRY_AGAIN = "Rovara couldn't take that just now; try again.";
const ROVARA_UNREADABLE = "Rovara couldn't read that command. Type `/rovara` for help.";

/** What the front hands to the asynchronous half: the verified fields and where to answer. */
export interface RovaraHandOff { source: "agentx.slack-rovara-handoff"; responseUrl: string; event: SlackRovaraEvent }
export function isRovaraHandOff(event: unknown): event is RovaraHandOff {
  return event !== null && typeof event === "object" && !Array.isArray(event) && (event as { source?: unknown }).source === "agentx.slack-rovara-handoff";
}

/** Only Slack's own response URLs are ever fetched. */
export function isSlackResponseUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 1024) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "hooks.slack.com" && url.username === "" && url.password === "" && url.port === "";
  } catch { return false; }
}

const Token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const team = (value: unknown): string | undefined => slackWorkspaceTeam(value) ? value : undefined;
const empty = (): HttpResponse => ({ statusCode: 200, headers: {}, body: "" });
const ephemeral = (text: string): HttpResponse => ({ statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ response_type: "ephemeral", text }) });
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

type Parsed = { handOff: RovaraHandOff; ack: HttpResponse } | { answer: HttpResponse };

/** The slash command (form fields, https://docs.slack.dev/interactivity/implementing-slash-commands). Undefined: another command, not ours. */
function commandOf(form: URLSearchParams): Parsed | undefined {
  if (form.get("command") !== ROVARA_COMMAND) return undefined;
  const teamId = team(form.get("team_id"));
  const userId = SlackUserIdSchema.safeParse(form.get("user_id"));
  const channelId = form.get("channel_id") ?? "";
  const text = form.get("text") ?? "";
  const responseUrl = form.get("response_url");
  if (teamId === undefined || !userId.success || !/^[CGD][A-Z0-9]{2,31}$/.test(channelId) || text.length > 300 || !isSlackResponseUrl(responseUrl)) return { answer: ephemeral(ROVARA_UNREADABLE) };
  return { ack: empty(), handOff: { source: "agentx.slack-rovara-handoff", responseUrl, event: { source: "agentx.slack-rovara", kind: "command", teamId, userId: userId.data, channelId, text } } };
}

/** A Link / Unlink press (block_actions). Undefined: any other interaction, which the interactivity handler keeps. */
function pressOf(form: URLSearchParams): Parsed | undefined {
  let payload: Record<string, unknown>;
  try { payload = record(JSON.parse(form.get("payload") ?? "")); } catch { return undefined; }
  if (payload.type !== "block_actions" || !Array.isArray(payload.actions)) return undefined;
  const ids = payload.actions.map((action) => record(action).action_id);
  if (!ids.some((id) => id === ROVARA_LINK_ACTION || id === ROVARA_UNLINK_ACTION)) return undefined;
  // Ours from here on: anything malformed is acknowledged and dropped (Slack would only retry it).
  if (payload.actions.length !== 1) return { answer: empty() };
  const action = record(payload.actions[0]);
  const teamId = team(record(payload.team).id);
  const user = record(payload.user);
  const userId = SlackUserIdSchema.safeParse(user.id);
  const channelId = SlackChannelIdSchema.safeParse(record(payload.channel).id);
  const token = Token.safeParse(action.value);
  // The person's own workspace must be the one the press came through: a Slack Connect member of another organization is not this company's person.
  if (teamId === undefined || !userId.success || user.team_id !== teamId || !channelId.success || !token.success || !isSlackResponseUrl(payload.response_url)) return { answer: empty() };
  return { ack: empty(), handOff: { source: "agentx.slack-rovara-handoff", responseUrl: payload.response_url, event: {
    source: "agentx.slack-rovara", kind: "press", teamId, userId: userId.data, channelId: channelId.data, action: action.action_id === ROVARA_LINK_ACTION ? "link" : "unlink", token: token.data,
  } } };
}

/** Recognises a VERIFIED body as ours (the command or one of its presses). Undefined: not ours. */
export function rovaraRequestOf(rawBody: string): Parsed | undefined {
  const form = new URLSearchParams(rawBody);
  if (form.has("command")) return commandOf(form);
  if (form.has("payload")) return pressOf(form);
  return undefined;
}

/** The front, called by the interactivity handler only after Slack's signature verified. Answers within Slack's three seconds; undefined when the body is not ours. */
export function createRovaraFront(deps: { handOff: (handOff: RovaraHandOff) => Promise<void>; log?: (event: string, fields: Readonly<Record<string, string | number | boolean>>) => void }) {
  return async (rawBody: string): Promise<HttpResponse | undefined> => {
    const parsed = rovaraRequestOf(rawBody);
    if (parsed === undefined) return undefined;
    if ("answer" in parsed) { deps.log?.("rovara.refused", { reason: "malformed" }); return parsed.answer; }
    try { await deps.handOff(parsed.handOff); }
    catch {
      deps.log?.("rovara.handoff_failed", { kind: parsed.handOff.event.kind });
      return parsed.handOff.event.kind === "command" ? ephemeral(ROVARA_TRY_AGAIN) : empty();
    }
    deps.log?.("rovara.handed_off", { kind: parsed.handOff.event.kind });
    return parsed.ack;
  };
}

const Block = z.record(z.string(), z.unknown());
const Answer = z.object({ text: z.string().min(1).max(3000), blocks: z.array(Block).max(50).optional(), replaceOriginal: z.boolean() }).strict();

/** The broker's answer to a handed-on command or press, checked; a failure is the fixed "try again". */
async function brokerAnswer(invokeBroker: (event: Record<string, unknown>) => Promise<BrokerReply>, event: SlackRovaraEvent): Promise<SlackRovaraAnswer> {
  try {
    const reply = await invokeBroker(event);
    if (reply.statusCode !== 200) throw new Error("refused");
    const body = record(JSON.parse(reply.body ?? ""));
    const answer = Answer.parse({ text: body.text, ...(body.blocks === undefined ? {} : { blocks: body.blocks }), replaceOriginal: body.replaceOriginal });
    return answer as SlackRovaraAnswer;
  } catch { return { text: ROVARA_TRY_AGAIN, replaceOriginal: event.kind === "press" }; }
}

/** The asynchronous half: ask the broker, then answer the person privately at the response URL. */
export async function runRovaraHandOff(deps: {
  invokeBroker: (event: Record<string, unknown>) => Promise<BrokerReply>;
  post: (responseUrl: string, body: Record<string, unknown>) => Promise<void>;
  log?: (event: string, fields: Readonly<Record<string, string | number | boolean>>) => void;
}, handOff: RovaraHandOff): Promise<void> {
  if (!isSlackResponseUrl(handOff.responseUrl)) return;
  const answer = await brokerAnswer(deps.invokeBroker, handOff.event);
  try {
    await deps.post(handOff.responseUrl, { response_type: "ephemeral", replace_original: answer.replaceOriginal, text: answer.text, ...(answer.blocks === undefined ? {} : { blocks: answer.blocks }) });
    deps.log?.("rovara.answered", { kind: handOff.event.kind });
  } catch { deps.log?.("rovara.answer_failed", { kind: handOff.event.kind }); }
}

/** Slack's response_url, as the interactivity module posts to it (no redirects, a bound on time). */
export async function postToResponseUrl(responseUrl: string, body: Record<string, unknown>, fetchImplementation: typeof fetch = fetch): Promise<void> {
  if (!isSlackResponseUrl(responseUrl)) throw new Error("not a Slack response URL");
  const response = await fetchImplementation(responseUrl, { method: "POST", signal: AbortSignal.timeout(5_000), redirect: "error",
    headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Slack response_url failed: HTTP ${response.status}`);
}

/** The asynchronous half over AWS: the broker by a direct invoke (this Lambda may already invoke it), within this Lambda's own time. */
export function awsRovaraHandOffRunner(): (handOff: RovaraHandOff) => Promise<void> {
  const functionName = process.env.BROKER_FUNCTION_NAME;
  const lambda = new LambdaClient(process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION });
  return (handOff) => runRovaraHandOff({
    async invokeBroker(event) {
      if (functionName === undefined || functionName === "") throw new Error("the broker is not configured");
      const response = await lambda.send(new InvokeCommand({ FunctionName: functionName, InvocationType: "RequestResponse", Payload: Buffer.from(JSON.stringify(event)) }), { abortSignal: AbortSignal.timeout(8_000) });
      if (response.FunctionError !== undefined || response.Payload === undefined) throw new Error("broker failed");
      return JSON.parse(Buffer.from(response.Payload).toString("utf8")) as BrokerReply;
    },
    post: (responseUrl, body) => postToResponseUrl(responseUrl, body),
  }, handOff);
}
