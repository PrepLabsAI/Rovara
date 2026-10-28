import { createE2EAgentCaptureStore, persistE2EAgentTrace, type E2EAgentCaptureStore } from "./agent-capture-store.js";
import type { SessionSecretRegistry } from "./session-secret-registry.js";

/**
 * The host's agent capture store (MIDSTEP-2 fix round 3 moved it here so its wiring can be tested). What the executor WRITES to the out directory is held to the parent's final scan:
 * the registry's `evidenceScan` (all session values, evidence-only ones included), not the model's. A trace that shows one is dropped by the store, never kept and later removed with a verdict.
 */
export function createHostAgentCaptureStore(input: { registry: Pick<SessionSecretRegistry, "evidenceScan">; outDir: string; valueKey: string; goals: () => readonly string[]; origin: string }): E2EAgentCaptureStore {
  return createE2EAgentCaptureStore({
    scan: input.registry.evidenceScan,
    persist: (keyHash, bytes) => persistE2EAgentTrace(input.outDir, keyHash, bytes),
    valueKey: input.valueKey, goals: input.goals, origin: input.origin,
  });
}
