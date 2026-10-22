import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_AGENT_TRACE_MAX_BYTES, e2eAgentValueDigest } from "@agentx/contracts";
import { E2E_AGENT_EVIDENCE_DIR } from "./evidence-paths.js";

/**
 * The capture-only replay cache store of a round with an agent step (Ruling M4-A, Task 4.3b).
 *
 * e2e keeps a recording of what an `act` step did (its `ActionTrace`) so a later run can replay it without a model. A candidate round never replays: `read` always misses, so the
 * model always navigates. `write` keeps the trace the runner hands over, and the runner only does that after a later deterministic verification step of the attempt passed, which is
 * the "verified round" this feature wants. Nothing here reads a file or the network; the traces stay in this process until the host takes them, scans them for credentials, and
 * writes the clean ones to the out directory as operator evidence. `delete` does nothing: an eviction can never remove what a verified round produced.
 *
 * A trace holds what the agent typed verbatim. The ledger's rule applies to it before it is held or written: a typed value that is text of one of the run's goals stays as it is, any
 * other becomes `hmac-sha256:<its keyed digest>` (the same digest the ledger records, so the trace still matches the ledger), and a trace that shows such a value anywhere else (a
 * summary, a URL, screen text; raw, JSON-escaped, percent-encoded or base64) is dropped whole. Then the credential scan runs over what is left; only a clean trace is kept.
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

/** Where a kept recording is written: named by a digest of its cache key, which is derived from the step's instruction, never from a value. */
export const agentTraceFilePath = (outDir: string, keyHash: string): string => join(outDir, E2E_AGENT_EVIDENCE_DIR, "traces", `trace-${createHash("sha256").update(keyHash, "utf8").digest("hex").slice(0, 16)}.json`);

/** Writes a clean recording to the out directory (the `persist` hook of the store). */
export function persistE2EAgentTrace(outDir: string, keyHash: string, bytes: Uint8Array): void {
  const path = agentTraceFilePath(outDir, keyHash);
  mkdirSync(join(outDir, E2E_AGENT_EVIDENCE_DIR, "traces"), { recursive: true, mode: 0o755 });
  writeFileSync(path, bytes, { mode: 0o644 });
}

export interface E2EAgentCaptureStoreOptions {
  /** Whether the bytes of a trace carry a credential (an account's, or a session value). A trace that does is not kept. */
  scan?: (bytes: Uint8Array) => boolean;
  /** Called with the clean trace's bytes as it is kept; the host writes them to the out directory. A throw here loses the file, never the trace or the round. */
  persist?: (keyHash: string, bytes: Uint8Array) => void;
  /** The run's value key (the ledger's). Without one, a trace with a typed value that is not text of a goal is dropped. */
  valueKey?: string;
  /** The goals of the agent steps this process has run; a typed value that is text of one is kept as it is. */
  goals?: () => readonly string[];
}

/** The recorded actions whose `value` is what the agent typed or chose (e2e's `ActionTrace`). */
const TYPED_ACTIONS: ReadonlySet<string> = new Set(["type", "typeText", "select"]);
const LITERAL_MAX = 256;
type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);

/** Every `value` field anywhere in the trace that is exactly one of the hidden values, replaced by its marker. */
function replaceValueFields(node: unknown, markers: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(node)) return node.map((item) => replaceValueFields(item, markers));
  if (!isRec(node)) return node;
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, key === "value" && typeof value === "string" && markers.has(value) ? markers.get(value)! : replaceValueFields(value, markers)]));
}

/** The trace with the ledger's rule applied to its typed values, or undefined when it cannot be kept. */
function hideTypedValues(trace: unknown, options: E2EAgentCaptureStoreOptions): unknown {
  if (!isRec(trace) || !Array.isArray(trace["actions"])) return undefined;
  const goals = options.goals?.() ?? [];
  const markers = new Map<string, string>();
  for (const action of trace["actions"] as unknown[]) {
    if (!isRec(action) || typeof action["name"] !== "string" || !TYPED_ACTIONS.has(action["name"]) || typeof action["value"] !== "string") continue;
    const value = action["value"];
    if (value === "" || (value.length <= LITERAL_MAX && goals.some((goal) => goal.includes(value)))) continue;
    if (options.valueKey === undefined) return undefined;
    markers.set(value, `hmac-sha256:${e2eAgentValueDigest(options.valueKey, value)}`);
  }
  if (markers.size === 0) return trace;
  const replaced = replaceValueFields(trace, markers) as Rec;
  // The typed action's own summary is prose that may quote the value; it becomes a fixed one.
  const actions = (replaced["actions"] as unknown[]).map((action) => (isRec(action) && typeof action["value"] === "string" && action["value"].startsWith("hmac-sha256:") && [...markers.values()].includes(action["value"])
    ? { ...action, summary: `${String(action["name"])} (the value is kept as its keyed digest)` } : action));
  const result = { ...replaced, actions };
  const serialized = JSON.stringify(result);
  for (const value of markers.keys()) {
    const forms = [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), Buffer.from(value, "utf8").toString("base64")];
    if (forms.some((form) => serialized.includes(form))) return undefined;
  }
  return result;
}

export function createE2EAgentCaptureStore(options: E2EAgentCaptureStoreOptions = {}): E2EAgentCaptureStore {
  // Insertion order is arrival order; a trace written again for a held key keeps its place and becomes new again.
  const held = new Map<string, { trace: unknown; fresh: boolean }>();
  return Object.freeze({
    writable: true as const,
    async read() { return { status: "miss" as const }; },
    async write(keyHash: string, received: unknown): Promise<{ bytes: number } | undefined> {
      let serialized: string | undefined;
      let trace: unknown;
      try { trace = hideTypedValues(JSON.parse(JSON.stringify(received)) as unknown, options); serialized = trace === undefined ? undefined : JSON.stringify(trace); } catch { return undefined; }
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
