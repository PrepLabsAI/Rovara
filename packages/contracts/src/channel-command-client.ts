// Spec 062 FR-072: one signed command and its signed answer. Each command is signed with the adapter's secret, with the
// command's ID as its `webhook-id`; the adapter signs its answer the same way, with the same ID, so an answer cannot be
// replayed onto another command. Shared by the broker, which checks the adapter's URL first, and the orchestrator,
// which talks only to the deployment's own built-in adapter.
import {
  ChannelCommandAnswerSchema,
  ChannelCommandResultSchemas,
  ChannelCommandSchema,
  channelCommandId,
  verifyWebhook,
  webhookHeaders,
  type ChannelCommand,
  type ChannelCommandKind,
  type ChannelCommandResult,
} from "./channel-adapter.js";
import { AgentXError, agentXError } from "./errors.js";

const COMMAND_TIMEOUT_MS = 10_000;
/** A document takes several calls on the adapter's side (Slack: create, share, read its link). */
const DOCUMENT_TIMEOUT_MS = 25_000;
const MAX_ANSWER_BYTES = 1_000_000;

/**
 * Phase 7c: a command that ran nowhere or may have run. `refused`: the adapter answered with its own error code, or a
 * 4xx, so nothing was done. `unanswered`: no readable answer came (a timeout, a lost connection, a 5xx), so it may have.
 */
export class ChannelCommandFailed extends AgentXError {
  constructor(readonly outcome: "refused" | "unanswered", message: string, readonly adapterCode?: string) {
    super("RUNTIME_UNAVAILABLE", message, 503);
    this.name = "ChannelCommandFailed";
  }
}

/** What a command carries besides its envelope (version, ID, channel, time), which the client adds. */
export type ChannelCommandInput<K extends ChannelCommandKind> = Omit<Extract<ChannelCommand, { kind: K }>, "version" | "id" | "channel" | "createdAt" | "kind">;

/**
 * Sends one command to `url` and answers its checked result. Throws FORBIDDEN when the answer is not signed for this
 * command, and ChannelCommandFailed when the adapter refused it or gave no readable answer.
 */
export async function sendSignedChannelCommand<K extends ChannelCommandKind>(
  options: { url: URL; secret: string; channel: string; fetch: typeof fetch; now: () => number; signal?: AbortSignal },
  kind: K,
  input: ChannelCommandInput<K>,
): Promise<ChannelCommandResult<K>> {
  const { url, secret, channel } = options;
  const command = ChannelCommandSchema.parse({ ...input, version: 1, id: channelCommandId(), channel, createdAt: new Date(options.now()).toISOString(), kind });
  const body = JSON.stringify(command);
  const headers = { "content-type": "application/json", ...webhookHeaders({ secret, id: command.id, timestamp: Math.floor(options.now() / 1000), body }) };
  let response: Response;
  let text: string;
  try {
    const timeout = kind === "create_document" || kind === "delete_document" ? DOCUMENT_TIMEOUT_MS : COMMAND_TIMEOUT_MS;
    const signal = options.signal === undefined ? AbortSignal.timeout(timeout) : AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]);
    response = await options.fetch(url, { method: "POST", headers, body, redirect: "manual", signal });
    text = await response.text();
  } catch {
    throw new ChannelCommandFailed("unanswered", `the ${channel} adapter did not answer the ${kind} command`);
  }
  if (response.status !== 200) {
    // A 4xx is the adapter refusing the command before running it (a bad signature, say); a 5xx, 408 or 429 may not be.
    const refused = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
    throw new ChannelCommandFailed(refused ? "refused" : "unanswered", `the ${channel} adapter answered the ${kind} command with HTTP ${response.status}`, refused ? `http_${response.status}` : undefined);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_ANSWER_BYTES) throw new ChannelCommandFailed("unanswered", `the ${channel} adapter's answer is too large`);

  const answerHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => { answerHeaders[name] = value; });
  const verified = verifyWebhook({ secret, headers: answerHeaders, body: text, nowSeconds: Math.floor(options.now() / 1000) });
  if (!verified.ok || verified.id !== command.id) throw agentXError("FORBIDDEN", `the ${channel} adapter's answer is not signed for this command`);

  let answer: ReturnType<typeof ChannelCommandAnswerSchema.safeParse>;
  try { answer = ChannelCommandAnswerSchema.safeParse(JSON.parse(text)); } catch { throw new ChannelCommandFailed("unanswered", `the ${channel} adapter's answer is not JSON`); }
  if (!answer.success) throw new ChannelCommandFailed("unanswered", `the ${channel} adapter's answer is unreadable`);
  if (!answer.data.ok) throw new ChannelCommandFailed("refused", `the ${channel} adapter refused the ${kind} command: ${answer.data.error.code}`, answer.data.error.code);
  const result = ChannelCommandResultSchemas[kind].safeParse(answer.data.result);
  // It answered, so it ran; what it said cannot be used.
  if (!result.success) throw new ChannelCommandFailed("unanswered", `the ${channel} adapter's ${kind} result is unreadable`);
  return result.data as ChannelCommandResult<K>;
}
