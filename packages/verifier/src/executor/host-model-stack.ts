import { createE2EAgentModelAdapter, type E2EAgentModelAdapter } from "./agent-model-adapter.js";
import { createE2EModelChannelClient } from "./model-channel.js";
import type { SessionSecretRegistry } from "./session-secret-registry.js";
import type { E2ESessionSyncSource } from "./session-sync.js";

/**
 * The executor's model path as the host builds it (MIDSTEP-2 MASKMAYBE): the channel client and the AI SDK adapter over it, both given the run's session secret registry. The registry's three
 * jobs on the way to the model are wired here and nowhere else: the credential scan (`modelScan`, a credential in a prompt refuses the call), and the mask (`maskForModel`, an evidence-only value
 * in a prompt is replaced by `<session>` and the step goes on). The adapter's only transport is the client, so nothing else reaches the model.
 */
export function createHostModelStack(input: {
  socketPath: string;
  runId: string;
  routeId: string;
  registry: SessionSecretRegistry;
  sessionSync: E2ESessionSyncSource;
  position: () => { caseId: string; stepIndex: number } | null;
}): { client: ReturnType<typeof createE2EModelChannelClient>; adapter: E2EAgentModelAdapter } {
  const client = createE2EModelChannelClient({ socketPath: input.socketPath, runId: input.runId, sessionSync: input.sessionSync, scan: input.registry.modelScan, mask: input.registry.maskForModel });
  // The adapter's own scan is the executor's second check; the worker's scan is told the browser's session values before every call by the client's sync (MIDSTEPCOOKIE).
  const adapter = createE2EAgentModelAdapter({ client, routeId: input.routeId, position: input.position, scan: input.registry.modelScan });
  return { client, adapter };
}
