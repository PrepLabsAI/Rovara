// Spec 062 FR-072: the core asks an adapter and waits for its answer. Each command is signed with the adapter's
// secret, with the command's ID as its `webhook-id`; the adapter signs its answer the same way, with the same ID, so
// an answer cannot be replayed onto another command. Only a kind the adapter's capabilities name is ever sent.
import {
  adapterTakesCommand,
  agentXError,
  publicHttpsUrlProblem,
  sendSignedChannelCommand,
  type ChannelAdapterRecord,
  type ChannelCommandInput,
  type ChannelCommandKind,
  type ChannelCommandResult,
} from "@agentx/contracts";
import { EndpointRefused } from "@agentx/gateway";

export { ChannelCommandFailed, type ChannelCommandInput } from "@agentx/contracts";

export interface ChannelCommandDependencies {
  getSecret(secretName: string): Promise<string | undefined>;
  fetch: typeof fetch;
  /** Throws EndpointRefused when the commands host resolves to a non-public address. */
  checkAddresses(url: URL): Promise<void>;
  now(): number;
}


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
  /** The caller's own deadline, as well as the command's. */
  options: { signal?: AbortSignal } = {},
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

  return sendSignedChannelCommand({ url, secret, channel: adapter.channel, fetch: (target, init) => deps.fetch(target, init), now: () => deps.now(), ...(options.signal === undefined ? {} : { signal: options.signal }) }, kind, input);
}
