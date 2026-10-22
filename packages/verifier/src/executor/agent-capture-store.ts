import { E2E_AGENT_TRACE_MAX_BYTES } from "@agentx/contracts";

/**
 * The capture-only replay cache store of a round with an agent step (Ruling M4-A, Task 4.3b).
 *
 * e2e keeps a recording of what an `act` step did (its `ActionTrace`) so a later run can replay it without a model. A candidate round never replays: `read` always misses, so the
 * model always navigates. `write` keeps the trace the runner hands over, and the runner only does that after a later deterministic verification step of the attempt passed, which is
 * the "verified round" this feature wants. Nothing here reads a file or the network; the traces stay in this process until the host takes them, scans them for credentials, and
 * writes the clean ones to the out directory as operator evidence. `delete` does nothing: an eviction can never remove what a verified round produced.
 *
 * A trace is as sensitive as a transcript (it holds typed values verbatim), so it is never put anywhere but the operator's evidence, and only after the credential scan.
 */
export interface E2EAgentCaptureStore {
  readonly writable: true;
  read(keyHash: string): Promise<{ readonly status: "miss" }>;
  write(keyHash: string, trace: unknown): Promise<{ bytes: number } | undefined>;
  delete(keyHash: string): Promise<void>;
  /** The traces received so far that no earlier `taken()` returned, in the order they arrived. */
  taken(): ReadonlyArray<{ keyHash: string; trace: unknown }>;
}

/** More recordings than a group can have steps; anything past this is refused instead of held. */
const MAX_HELD_TRACES = 16;

export interface E2EAgentCaptureStoreOptions {
  /** Whether the bytes of a trace carry a credential (an account's, or a session value). A trace that does is not kept. */
  scan?: (bytes: Uint8Array) => boolean;
  /** Called with the clean trace's bytes as it is kept; the host writes them to the out directory. A throw here loses the file, never the trace or the round. */
  persist?: (keyHash: string, bytes: Uint8Array) => void;
}

export function createE2EAgentCaptureStore(options: E2EAgentCaptureStoreOptions = {}): E2EAgentCaptureStore {
  // Insertion order is arrival order; a trace written again for a held key keeps its place and becomes new again.
  const held = new Map<string, { trace: unknown; fresh: boolean }>();
  return Object.freeze({
    writable: true as const,
    async read() { return { status: "miss" as const }; },
    async write(keyHash: string, trace: unknown): Promise<{ bytes: number } | undefined> {
      let serialized: string | undefined;
      try { serialized = JSON.stringify(trace); } catch { return undefined; }
      if (serialized === undefined) return undefined;
      const bytes = Buffer.byteLength(serialized, "utf8");
      // The same wire ceiling e2e's own stores hold, and the one the review of a captured trace holds. A trace for a key already held replaces it: the runner settles one
      // recording per step and the latest is the one that was confirmed.
      if (bytes > E2E_AGENT_TRACE_MAX_BYTES || (!held.has(keyHash) && held.size >= MAX_HELD_TRACES)) return undefined;
      const encoded = Buffer.from(serialized, "utf8");
      // A trace carries typed values and screen text verbatim. One that carries a credential is dropped whole: it can only lose a replay input, never change a verdict.
      if (options.scan?.(encoded) === true) return undefined;
      held.set(keyHash, { trace: JSON.parse(serialized) as unknown, fresh: true });
      try { options.persist?.(keyHash, encoded); } catch { /* the file is operator evidence; its loss changes nothing */ }
      return { bytes };
    },
    async delete() { /* a verified recording is never evicted */ },
    taken() {
      const fresh: Array<{ keyHash: string; trace: unknown }> = [];
      for (const [keyHash, entry] of held) if (entry.fresh) { entry.fresh = false; fresh.push({ keyHash, trace: entry.trace }); }
      return fresh;
    },
  });
}
