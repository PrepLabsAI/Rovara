// TE-F1a: the evidence lines a model-call ledger becomes, for one round (DECISIONS 163b D3, 7a's condition). The residual line for an unsealed round is ALWAYS present and plain: "not sealed; model hosts blocked by name only"
// (F0a's sentence, imported, not written twice). No line ever says "sealed" without "not" in front of it: the sealed round has its own lines, with no such word at all. The redirect-escape sentence is F0a's too, and its host is
// the BLOCK LIST's own text (an observed name came from customer code and is never repeated).
import { NOT_SEALED_BLOCKED_BY_NAME_SENTENCE, findRedirectEscapes } from "../model-egress-block.js";
import { MODEL_EGRESS_CLASSES, NOT_RUN_SENTENCES, capSentence, type ModelEgressClass, type ModelEgressNotRunClass } from "./classify.js";
import { SIGV4_NOT_RUN_SENTENCE } from "./schemes.js";

/** Which round the lines are for. `working` and `check_unsealed` are unsealed (the by-name block only); `check_sealed` is the sealed round (no route out exists). An unknown value is read as unsealed. */
export const MODEL_EGRESS_ROUND_KINDS = ["working", "check_unsealed", "check_sealed"] as const;
export type ModelEgressRoundKind = (typeof MODEL_EGRESS_ROUND_KINDS)[number];

export interface ModelEgressLedger {
  /** The class of each call the round made. */
  readonly classes: readonly ModelEgressClass[];
  /** The task cap in micro-dollars, for the cap sentence. */
  readonly capMicros?: number;
  /** Every host the redirect catcher saw a client call (untrusted: a Host header or a TLS hello). */
  readonly observedHosts?: readonly unknown[];
  /** The hosts that must not be reached directly (F0a's `modelHostBlockList`). */
  readonly blockList?: readonly string[];
  /** The domain suffixes whose every subdomain is blocked (F0a's `modelHostSuffixBlockList`: Azure OpenAI). */
  readonly hostSuffixes?: readonly string[];
  /** Calls refused because the row is a Bedrock row (SigV4 is not built). */
  readonly bedrockCalls?: number;
}

/** At most this many escaped hosts get a line each; the rest are counted. */
export const MODEL_EGRESS_ESCAPE_LINES_MAX = 5;

const UNSAID_SEALED = /(?<!not )sealed/iu;
const WITHHELD_HOST_LINE = "not run: client ignored the redirect (called a host whose name is withheld)";
const WITHHELD_UNLISTED_LINE = "not run: unlisted model host (called a host whose name is withheld)";
const CLASS_ORDER: readonly ModelEgressNotRunClass[] = ["cap", "key_refused", "rate_limit", "quota", "overloaded"];

/**
 * The lines for one round, in a fixed order: the residual line first when the round is unsealed, then one line per not-run class the ledger holds, then one line per escaped host or unlisted model host (at most five, then a count), then the Bedrock line.
 * Never throws; a malformed ledger gives fewer lines, never an invented one. No returned line has "sealed" without "not " before it.
 */
export function evidenceLinesFor(roundKind: ModelEgressRoundKind, ledger: ModelEgressLedger): string[] {
  try {
    return linesFor(roundKind, typeof ledger === "object" && ledger !== null ? ledger : {});
  } catch {
    // Never throws: a ledger that cannot be read (a hostile getter) still gives the residual line for any round that is not the sealed one, and nothing invented.
    return roundKind === "check_sealed" ? [] : [NOT_SEALED_BLOCKED_BY_NAME_SENTENCE];
  }
}

function linesFor(roundKind: ModelEgressRoundKind, ledger: Partial<ModelEgressLedger>): string[] {
  const lines: string[] = [];
  if (roundKind !== "check_sealed") lines.push(NOT_SEALED_BLOCKED_BY_NAME_SENTENCE);
  const reported: readonly unknown[] = Array.isArray(ledger.classes) ? (ledger.classes as readonly unknown[]) : [];
  const present = new Set<unknown>(reported.filter((entry) => typeof entry === "string" && (MODEL_EGRESS_CLASSES as readonly string[]).includes(entry)));
  for (const entry of CLASS_ORDER) {
    if (!present.has(entry)) continue;
    lines.push(entry === "cap" ? capSentence(ledger.capMicros) : NOT_RUN_SENTENCES[entry]);
  }
  const blockList: readonly string[] = Array.isArray(ledger.blockList) ? (ledger.blockList as readonly string[]) : [];
  const observed: readonly unknown[] = Array.isArray(ledger.observedHosts) ? (ledger.observedHosts as readonly unknown[]) : [];
  const suffixes: readonly string[] = Array.isArray(ledger.hostSuffixes) ? (ledger.hostSuffixes as readonly string[]) : [];
  const escapes = findRedirectEscapes(blockList, observed, { hostSuffixes: suffixes });
  for (const escape of escapes.slice(0, MODEL_EGRESS_ESCAPE_LINES_MAX)) lines.push(UNSAID_SEALED.test(escape.sentence) ? (escape.kind === "unlisted_model_host" ? WITHHELD_UNLISTED_LINE : WITHHELD_HOST_LINE) : escape.sentence);
  if (escapes.length > MODEL_EGRESS_ESCAPE_LINES_MAX) lines.push(`not run: client ignored the redirect (${String(escapes.length - MODEL_EGRESS_ESCAPE_LINES_MAX)} more hosts called)`);
  if (typeof ledger.bedrockCalls === "number" && Number.isSafeInteger(ledger.bedrockCalls) && ledger.bedrockCalls > 0) lines.push(SIGV4_NOT_RUN_SENTENCE);
  return lines;
}
