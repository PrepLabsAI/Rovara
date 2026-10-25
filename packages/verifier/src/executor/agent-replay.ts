import { createHash } from "node:crypto";
import { E2EAgentTraceFileSchema, canonicalJson, type E2EReplayTrace } from "@agentx/contracts";
import type { StepExecutor } from "e2e";
import { isAgentError } from "e2e/agent";
import type { E2EWebAgentPorts } from "../web-runtime.js";
import { E2E_REPLAY_EXECUTOR_NAME, E2E_REPLAY_EXECUTOR_VERSION } from "../application-templates.js";

/**
 * The audit replay's three parts (Task 4.6b): a read-only store that serves only the recordings a verified round left, an executor that holds no model and stops the step the
 * moment it is asked to think, and the step port that turns that stop into a fixed code. Together with the bootstrap (which builds a replay config only from these and refuses a model
 * factory) they are why a replay provably runs with no model: nothing here imports the AI SDK, makes a channel client or reads a socket.
 *
 * What the store serves is bound. A recording is a hit only when the digest of the trace in the file is the digest its binding names (the broker computed the binding when it reviewed the
 * recording against the ledger it verified, and the admission that carries both is signed) and the file's cache key is the key it is served under. Any other recording is a miss. A
 * recording that holds a value the model chose (`hmac-sha256:<digest>`: Rovara never keeps such a value, owner decision Q4) is a miss too, so the step cannot replay whole.
 *
 * A step that cannot replay whole (the page changed, no recording matched, a typed value is hidden) is handed by the runner to this executor, which answers at once with a blocked
 * verdict. The step then ends with `typed-value-not-replayable` when the store refused a hidden value, else `replay-needs-model`, and the case is `reproduced: false`. No model is reached,
 * because there is none to reach.
 */

/** What happened to the steps of the run so far, shared by the store, the executor and the step port of one process. */
export interface E2EReplayState {
  /** The store refused a recording for the step now running because it holds a value the model chose. */
  typedValueMiss: boolean;
  /** The executor was asked to think for the step now running. */
  needsModel: boolean;
}
export const createE2EReplayState = (): E2EReplayState => ({ typedValueMiss: false, needsModel: false });

const MARKER_PREFIX = "hmac-sha256:";
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** Whether any string anywhere in the value is a keyed digest of a value the model chose. */
function holdsHiddenValue(node: unknown): boolean {
  if (typeof node === "string") return node.startsWith(MARKER_PREFIX);
  if (Array.isArray(node)) return node.some(holdsHiddenValue);
  if (typeof node === "object" && node !== null) return Object.values(node).some(holdsHiddenValue);
  return false;
}

/** The recording a hit hands the runner, in the entry shape the pinned runner reads (`trace-1`). */
type ReplayEntry = { schemaVersion: "trace-1"; createdAt: string; payload: unknown };
const ENTRY_CREATED_AT = "1970-01-01T00:00:00.000Z";

export interface E2EReplayStore {
  readonly writable: false;
  read(keyHash: string): Promise<{ status: "hit"; entry: ReplayEntry; bytes: number } | { status: "miss" }>;
  write(keyHash: string, trace: never): Promise<undefined>;
}

/**
 * The store of one replay. `traces` are the recordings of the plan (the admission's, narrowed to this group); each is checked once, here: base64 canonical, a file of the recording
 * contract, the cache key the plan names, the digest its binding names. A recording that fails any check is not served, and two recordings under one key are served as neither.
 */
export function createE2EReplayStore(traces: readonly E2EReplayTrace[], state: E2EReplayState = createE2EReplayState()): E2EReplayStore {
  const served = new Map<string, { trace: unknown; bytes: number; hidden: boolean }>();
  const ambiguous = new Set<string>();
  for (const item of traces) {
    try {
      const bytes = Buffer.from(item.traceBase64, "base64");
      if (bytes.toString("base64") !== item.traceBase64) continue;
      const file = E2EAgentTraceFileSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (file.keyHash !== item.keyHash || sha256(canonicalJson(file.trace)) !== item.binding.traceSha256) continue;
      if (served.has(item.keyHash)) { ambiguous.add(item.keyHash); continue; }
      served.set(item.keyHash, { trace: file.trace, bytes: bytes.byteLength, hidden: holdsHiddenValue(file.trace) });
    } catch { /* a recording that is not one of the contract is not served */ }
  }
  for (const keyHash of ambiguous) served.delete(keyHash);
  return Object.freeze({
    writable: false as const,
    async read(keyHash: string) {
      const found = served.get(keyHash);
      if (found === undefined) return { status: "miss" as const };
      if (found.hidden) { state.typedValueMiss = true; return { status: "miss" as const }; }
      return { status: "hit" as const, entry: { schemaVersion: "trace-1" as const, createdAt: ENTRY_CREATED_AT, payload: JSON.parse(JSON.stringify(found.trace)) as unknown }, bytes: found.bytes };
    },
    async write() { return undefined; },
  });
}

/** The executor of a replay: it holds no model (no `model`, no `judge`) and no cache preference, and the one thing it does is stop the step it is handed. */
export function createRovaraE2EReplayExecutor(state: E2EReplayState = createE2EReplayState()): StepExecutor {
  return Object.freeze({
    name: E2E_REPLAY_EXECUTOR_NAME,
    version: E2E_REPLAY_EXECUTOR_VERSION,
    async runStep() {
      state.needsModel = true;
      // `replay-needs-model` is the code the replay reports; the verdict's own code is the runner's closest fixed one (the environment cannot go on without a model).
      return { status: "blocked" as const, summary: "The replay needs a model.", errorCode: "ENVIRONMENT_UNAVAILABLE" as const };
    },
  });
}

/**
 * The agent step port of a replay: it runs the runner's `act` (which replays the recording when the store serves one) with no channel marker and no ledger, and says how it ended.
 * A step that ends any way but whole is `failed` with one of two fixed codes. Anything that is not the runner's own answer (an executor fault) is thrown again.
 */
export function createE2EReplayStepDriver(state: E2EReplayState): E2EWebAgentPorts["runStep"] {
  return async (request) => {
    state.typedValueMiss = false;
    state.needsModel = false;
    try {
      await request.act(request.goal, { maxSteps: request.maxActions, maxModelCalls: request.maxActions + 4, timeout: request.timeoutMs });
      return { verdict: "concluded", stopCode: null, receiptIds: [] };
    } catch (error) {
      if (!isAgentError(error)) throw error instanceof Error ? error : new Error("the replay step failed");
      return { verdict: "failed", stopCode: state.typedValueMiss ? "typed-value-not-replayable" : "replay-needs-model", receiptIds: [] };
    }
  };
}
