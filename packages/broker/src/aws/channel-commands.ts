// Spec 062 FR-072: the core asks an adapter and waits for its answer. Each command is signed with the adapter's
// secret, with the command's ID as its `webhook-id`; the adapter signs its answer the same way, with the same ID, so
// an answer cannot be replayed onto another command. Only a kind the adapter's capabilities name is ever sent.
import {
  ChannelCommandAnswerSchema,
  ChannelCommandResultSchemas,
  ChannelCommandSchema,
  adapterTakesCommand,
  agentXError,
  channelCommandId,
  publicHttpsUrlProblem,
  verifyWebhook,
  webhookHeaders,
  type ChannelAdapterRecord,
  type ChannelCommand,
  type ChannelCommandKind,
  type ChannelCommandResult,
} from "@agentx/contracts";
import { EndpointRefused } from "@agentx/gateway";

const COMMAND_TIMEOUT_MS = 10_000;
const MAX_ANSWER_BYTES = 1_000_000;

export interface ChannelCommandDependencies {
  getSecret(secretName: string): Promise<string | undefined>;
  fetch: typeof fetch;
  /** Throws EndpointRefused when the commands host resolves to a non-public address. */
  checkAddresses(url: URL): Promise<void>;
  now(): number;
}

/** What a command carries besides its envelope (version, ID, channel, time), which the client adds. */
export type ChannelCommandInput<K extends ChannelCommandKind> = Omit<Extract<ChannelCommand, { kind: K }>, "version" | "id" | "channel" | "createdAt" | "kind">;

/**
 * Sends one command and answers its checked result. Throws CONFIG_INVALID when the adapter does not take the kind or
 * its URL is not public, FORBIDDEN when its answer is not signed for this command, and RUNTIME_UNAVAILABLE when it
 * cannot be reached, answers with an error, or answers something unreadable.
 */
export async function sendChannelCommand<K extends ChannelCommandKind>(
  deps: ChannelCommandDependencies,
  adapter: ChannelAdapterRecord,
  kind: K,
  input: ChannelCommandInput<K>,
): Promise<ChannelCommandResult<K>> {
  if (!adapterTakesCommand(adapter, kind) || adapter.commandsUrl === undefined) {
    throw agentXError("CONFIG_INVALID", `the ${adapter.channel} adapter does not take ${kind} commands`);
  }
  const problem = publicHttpsUrlProblem(adapter.commandsUrl, "commandsUrl");
  if (problem !== undefined) throw agentXError("CONFIG_INVALID", `the ${adapter.channel} adapter's commandsUrl is refused: ${problem}`);
  const url = new URL(adapter.commandsUrl);
  try {
    await deps.checkAddresses(url);
  } catch (error) {
    if (error instanceof EndpointRefused) throw agentXError("CONFIG_INVALID", `the ${adapter.channel} adapter's commandsUrl is not a public address`);
    throw agentXError("RUNTIME_UNAVAILABLE", `the ${adapter.channel} adapter's commandsUrl could not be resolved`);
  }
  const secret = await deps.getSecret(adapter.secretName);
  if (secret === undefined) throw agentXError("RUNTIME_UNAVAILABLE", `the ${adapter.channel} adapter's signing secret could not be read`);

  const command = ChannelCommandSchema.parse({ ...input, version: 1, id: channelCommandId(), channel: adapter.channel, createdAt: new Date(deps.now()).toISOString(), kind });
  const body = JSON.stringify(command);
  const headers = { "content-type": "application/json", ...webhookHeaders({ secret, id: command.id, timestamp: Math.floor(deps.now() / 1000), body }) };
  let response: Response;
  let text: string;
  try {
    response = await deps.fetch(url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS) });
    text = await response.text();
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", `the ${adapter.channel} adapter did not answer the ${kind} command`);
  }
  if (response.status !== 200) throw agentXError("RUNTIME_UNAVAILABLE", `the ${adapter.channel} adapter answered the ${kind} command with HTTP ${response.status}`);
  if (Buffer.byteLength(text, "utf8") > MAX_ANSWER_BYTES) throw agentXError("RUNTIME_UNAVAILABLE", `the ${adapter.channel} adapter's answer is too large`);

  const answerHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => { answerHeaders[name] = value; });
  const verified = verifyWebhook({ secret, headers: answerHeaders, body: text, nowSeconds: Math.floor(deps.now() / 1000) });
  if (!verified.ok || verified.id !== command.id) throw agentXError("FORBIDDEN", `the ${adapter.channel} adapter's answer is not signed for this command`);

  let answer: ReturnType<typeof ChannelCommandAnswerSchema.safeParse>;
  try { answer = ChannelCommandAnswerSchema.safeParse(JSON.parse(text)); } catch { throw agentXError("RUNTIME_UNAVAILABLE", `the ${adapter.channel} adapter's answer is not JSON`); }
  if (!answer.success) throw agentXError("RUNTIME_UNAVAILABLE", `the ${adapter.channel} adapter's answer is unreadable`);
  if (!answer.data.ok) throw agentXError("RUNTIME_UNAVAILABLE", `the ${adapter.channel} adapter refused the ${kind} command: ${answer.data.error.code}`);
  const result = ChannelCommandResultSchemas[kind].safeParse(answer.data.result);
  if (!result.success) throw agentXError("RUNTIME_UNAVAILABLE", `the ${adapter.channel} adapter's ${kind} result is unreadable`);
  return result.data as ChannelCommandResult<K>;
}
