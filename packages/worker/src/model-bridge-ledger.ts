// TE-F1c (M2, release 0.5.19; te-f1 design 5): the bridge's ledger and the evidence words a round gets from it.
//
// One row per call: time, row, status, class, tokens, cost, refusal word, how it was served. NEVER a body, a header value, a URL query, a token or a provider message: `record` copies named fields only, so an extra key on its
// input has nowhere to go. The worker knows each exec's window (`execStart` / `execEnd`): a FAILED check whose window holds a rate-limit, quota, overloaded, cap or key-refused call is reported with that class ("not run:
// provider rate limit"), never "failed". Per check (TE-A6 per-test attribution is not built).
//
// Evidence (7a's condition 2): an UNSEALED round always says "not sealed; model hosts blocked by name only". A round with no block at all says that instead ("not sealed; model hosts not blocked in this round"), never the by-name
// claim. "Sealed" is the exact typed round value `check_sealed` AND the sealed block mode: no free string is ever read as sealed. A suffix row (Azure OpenAI) is never blocked by name: its line is "Azure OpenAI not blocked in
// this round".
import type { NOT_RUN_CLASSES} from "@agentx/contracts";
import {
  MODEL_EGRESS_CLASSES, MODEL_EGRESS_REFUSALS, MODEL_EGRESS_ROUND_KINDS, MODEL_HOSTS_NOT_BLOCKED_SENTENCE, NOT_RUN_SENTENCES, NOT_SEALED_BLOCKED_BY_NAME_SENTENCE, capSentence, evidenceLinesFor, formatUsdMicros,
  type ModelEgressClass, type ModelEgressRefusal, type ModelEgressRoundKind,
} from "@agentx/contracts";
import { AZURE_OPENAI_NOT_BLOCKED_SENTENCE, type ModelBlockEvidenceInput } from "./model-helper-block.js";

export const MODEL_BRIDGE_LEDGER_ROWS_MAX = 1_000;
const ROW_ID = /^[a-z][a-z0-9-]{0,39}$/u;
const EXEC_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const WINDOWS_MAX = 512;

export const LEDGER_VIAS = ["real", "replayed", "refused"] as const;
export type LedgerVia = (typeof LEDGER_VIAS)[number];

export interface LedgerRow {
  readonly atMs: number;
  readonly row: string;
  readonly status: number;
  readonly class: ModelEgressClass;
  readonly refusal?: ModelEgressRefusal;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costMicros: number;
  readonly estimated: boolean;
  readonly via: LedgerVia;
  /** The exec (check) whose token made the call, when it had a live one. Only a call with an exec can turn THAT exec's failure into "not run". */
  readonly execId?: string;
}

/** What `record` reads. Anything else on the object is ignored. */
export interface LedgerEntryInput {
  readonly row: string;
  readonly status: number;
  readonly class: ModelEgressClass;
  readonly refusal?: ModelEgressRefusal;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costMicros: number;
  readonly estimated: boolean;
  readonly via: LedgerVia;
  readonly execId?: string;
}

export interface LedgerSummary {
  readonly calls: number;
  readonly costMicros: number;
  readonly estimated: boolean;
  readonly omitted: number;
  /** "Your product's model calls: 14 calls, $0.38 (your key)": never counted toward Rovara's own model spend. */
  readonly line: string;
}

export interface ModelBridgeLedger {
  record(entry: LedgerEntryInput): void;
  rows(): readonly LedgerRow[];
  /** The not-run classes that really happened to the product's own calls (for the evidence lines): see `countsForNotRun`. */
  classes(): ModelEgressClass[];
  execStart(execId: string): void;
  execEnd(execId: string): void;
  /** The not-run sentence for the exec's window, or undefined when its window holds no such class. */
  notRunFor(execId: string): string | undefined;
  /** A failed check whose window holds a not-run class becomes `not_run` with the sentence; anything else is returned as it is. */
  checkOutcome(execId: string, status: string): { readonly status: string; readonly sentence?: string };
  summary(): LedgerSummary;
}

const whole = (value: unknown): number | undefined => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined);
const CLASS_PRIORITY: readonly (typeof NOT_RUN_CLASSES)[number][] = ["cap", "key_refused", "rate_limit", "quota", "overloaded"];

/**
 * Whether a row may turn a failure into "not run". Only what really happened to the product's own call: a provider class on a call that went out (`via: "real"`, the adapter's own spend-cap refusal included), or the bridge's own
 * DOLLAR cap (`via: "refused"`, class `cap`). The bridge's call-count and concurrency refusals are class `refused` and never count, a replay never counts, and a call with no exec counts for nobody: test code cannot make
 * its own failure read "not run" by hitting the bridge's own limits.
 */
const countsForNotRun = (row: LedgerRow): boolean => (row.via === "real" || (row.via === "refused" && row.class === "cap")) && (CLASS_PRIORITY as readonly string[]).includes(row.class);

export function createModelBridgeLedger(options: { readonly now: () => number; readonly capMicros?: number }): ModelBridgeLedger {
  const rows: LedgerRow[] = [];
  let omitted = 0;
  const windows = new Map<string, { startMs: number; endMs: number | undefined }>();

  const sentenceFor = (cls: (typeof NOT_RUN_CLASSES)[number]): string => (cls === "cap" ? capSentence(options.capMicros) : NOT_RUN_SENTENCES[cls]);

  const ledger: ModelBridgeLedger = {
    record(entry) {
      if (rows.length >= MODEL_BRIDGE_LEDGER_ROWS_MAX) {
        omitted += 1;
        return;
      }
      const cls = (MODEL_EGRESS_CLASSES as readonly unknown[]).includes(entry.class) ? entry.class : "provider_error";
      const refusal = (MODEL_EGRESS_REFUSALS as readonly unknown[]).includes(entry.refusal) ? entry.refusal : undefined;
      const status = typeof entry.status === "number" && Number.isInteger(entry.status) && entry.status >= 100 && entry.status <= 599 ? entry.status : 0;
      const input = whole(entry.inputTokens);
      const output = whole(entry.outputTokens);
      rows.push({
        atMs: whole(options.now()) ?? 0,
        row: typeof entry.row === "string" && ROW_ID.test(entry.row) ? entry.row : "unknown",
        status,
        class: cls,
        ...(refusal === undefined ? {} : { refusal }),
        ...(input === undefined ? {} : { inputTokens: input }),
        ...(output === undefined ? {} : { outputTokens: output }),
        costMicros: whole(entry.costMicros) ?? 0,
        estimated: entry.estimated === true,
        via: (LEDGER_VIAS as readonly unknown[]).includes(entry.via) ? entry.via : "refused",
        ...(typeof entry.execId === "string" && EXEC_ID.test(entry.execId) ? { execId: entry.execId } : {}),
      });
    },
    rows: () => rows.map((row) => ({ ...row })),
    classes: () => rows.filter(countsForNotRun).map((row) => row.class),
    execStart(execId) {
      if (!EXEC_ID.test(execId) || (windows.size >= WINDOWS_MAX && !windows.has(execId))) return;
      windows.set(execId, { startMs: whole(options.now()) ?? 0, endMs: undefined });
    },
    execEnd(execId) {
      const held = windows.get(execId);
      if (held !== undefined && held.endMs === undefined) held.endMs = whole(options.now()) ?? held.startMs;
    },
    notRunFor(execId) {
      const held = windows.get(execId);
      if (held === undefined) return undefined;
      const end = held.endMs ?? Number.POSITIVE_INFINITY;
      // Per CHECK: the call's own exec, inside that exec's window. Another check's 429, even at the same moment, is not this check's.
      const inside = new Set(rows.filter((row) => row.execId === execId && countsForNotRun(row) && row.atMs >= held.startMs && row.atMs <= end).map((row) => row.class));
      const found = CLASS_PRIORITY.find((cls) => inside.has(cls));
      return found === undefined ? undefined : sentenceFor(found);
    },
    checkOutcome(execId, status) {
      if (status !== "failed") return { status };
      const sentence = ledger.notRunFor(execId);
      return sentence === undefined ? { status } : { status: "not_run", sentence };
    },
    summary() {
      // A call is a real call on the product's key that the provider or the adapter answered; a replay costs nothing and a refusal before the call reached nobody.
      const calls = rows.filter((row) => row.via === "real" && row.refusal === undefined).length;
      const costMicros = rows.reduce((total, row) => total + (row.via === "real" ? row.costMicros : 0), 0);
      const estimated = rows.some((row) => row.via === "real" && row.estimated && row.costMicros > 0);
      const line = calls === 0 ? "Your product's model calls: none" : `Your product's model calls: ${String(calls)} call${calls === 1 ? "" : "s"}, ${formatUsdMicros(costMicros)}${estimated ? " estimated" : ""} (your key)`;
      return { calls, costMicros, estimated, omitted, line };
    },
  };
  return ledger;
}

// ---- evidence

/** The round kind, only when it is exactly one of the typed values. Everything else (a free string, a padded word, an object) is `undefined`, and every reader treats `undefined` as UNSEALED. */
export function parseModelRoundKind(value: unknown): ModelEgressRoundKind | undefined {
  return typeof value === "string" && (MODEL_EGRESS_ROUND_KINDS as readonly string[]).includes(value) ? (value as ModelEgressRoundKind) : undefined;
}

export const NOT_SEALED_NO_BLOCK_SENTENCE = "not sealed; model hosts not blocked in this round";
export { AZURE_OPENAI_NOT_BLOCKED_SENTENCE };
/** Part of the unsealed residual (DECISIONS 174): the Google token hosts are never blocked, and a Google service that runs a model inside it goes out under the company's own Google access. Shown wherever the residual line is. */
export const GOOGLE_AI_SERVICE_NOT_BLOCKED_SENTENCE = "a Google service that runs an AI model inside it (for example BigQuery AI functions) is not blocked";

export interface ModelBridgeEvidenceInput extends ModelBlockEvidenceInput {
  /** The round, as the worker's own chooser named it. Anything that is not exactly `check_sealed` is unsealed. */
  readonly roundKind: unknown;
  // `blockMode`, `blockList`, `hostSuffixes` and `azureOpenAiNotBlocked` come from the helper network: `modelBlockEvidenceInput(roundKind, block)` for an unsealed round, `sealedModelBlockEvidenceInput(plan, block)` for the sealed round.
  /** What the 443/80 recorder saw (untrusted). */
  readonly observedHosts: readonly unknown[];
  readonly classes: readonly ModelEgressClass[];
  readonly capMicros?: number;
  readonly bedrockCalls?: number;
  /** A laptop whose gateway cannot hold the names back: `not_blocked`. */
  readonly machineBlock?: "not_blocked";
}

/**
 * The lines for a round. Fixed order: the residual line (unsealed rounds), the Google AI-service line (also unsealed only), the Azure line, then F1-a's class lines and redirect escapes. Sealed only when the round is exactly `check_sealed` AND the block mode is `sealed`.
 * Never throws: an unreadable input still gives a residual line (the weaker one unless the block mode is readable and `by_name`).
 */
export function modelBridgeEvidenceLines(input: ModelBridgeEvidenceInput): string[] {
  try {
    const sealed = parseModelRoundKind(input.roundKind) === "check_sealed" && input.blockMode === "sealed";
    const kind: ModelEgressRoundKind = sealed ? "check_sealed" : parseModelRoundKind(input.roundKind) === "working" ? "working" : "check_unsealed";
    const lines = evidenceLinesFor(kind, {
      classes: input.classes,
      ...(input.capMicros === undefined ? {} : { capMicros: input.capMicros }),
      observedHosts: input.observedHosts,
      blockList: input.blockList,
      hostSuffixes: input.hostSuffixes,
      ...(input.bedrockCalls === undefined ? {} : { bedrockCalls: input.bedrockCalls }),
    });
    if (sealed) return lines;
    // F1-a put the by-name sentence first. When nothing is blocked by name it would be a false claim: say what is true.
    const first = input.machineBlock === "not_blocked" ? `not sealed; ${MODEL_HOSTS_NOT_BLOCKED_SENTENCE}` : input.blockMode === "none" ? NOT_SEALED_NO_BLOCK_SENTENCE : NOT_SEALED_BLOCKED_BY_NAME_SENTENCE;
    const rest = lines.slice(1);
    const azure = input.azureOpenAiNotBlocked === true || input.hostSuffixes.length > 0 ? [AZURE_OPENAI_NOT_BLOCKED_SENTENCE] : [];
    return [first, GOOGLE_AI_SERVICE_NOT_BLOCKED_SENTENCE, ...azure, ...rest];
  } catch {
    // An input that cannot be read still gets the residual line, but only the one it can honestly claim: "blocked by name only" only when the block mode is readable and says so. A `none` block, a machine that cannot block,
    // and an input nothing can be read from all get the weaker "not blocked" words: never a claim of a block that may not exist.
    const read = <T>(get: () => T): T | undefined => { try { return get(); } catch { return undefined; } };
    if (read(() => input.machineBlock) === "not_blocked") return [`not sealed; ${MODEL_HOSTS_NOT_BLOCKED_SENTENCE}`, GOOGLE_AI_SERVICE_NOT_BLOCKED_SENTENCE];
    return [read(() => input.blockMode) === "by_name" ? NOT_SEALED_BLOCKED_BY_NAME_SENTENCE : NOT_SEALED_NO_BLOCK_SENTENCE, GOOGLE_AI_SERVICE_NOT_BLOCKED_SENTENCE];
  }
}
