// DEC 240: which AI each company's agents use. A company admin picks it in Cloud ("AI for your agents"); Cloud writes it to its
// Companies table (packages/cloud-server agent-ai-routes.ts) and the gateway reads it here, on every agent call:
//
//   rovara         Rovara's AI: Claude through Bedrock in Rovara's OWN AWS account (bedrock-transport.ts), charged to the company
//                  at list price on its bill (DEC 240b), under the one combined company cap.
//   anthropic_key  the company's own Anthropic key (DEC 236, company-key mode).
//   bedrock_byo    the company's own Bedrock (DEC 238): its own invoke-only role, assumed as the company (ByoBedrock below).
//   openai_key     the company's own OpenAI key (DEC 254t), through Chat Completions (agent-openai.ts); only when its kind is switched on.
//   openrouter_key the company's own OpenRouter key (DEC 254t), the same way; its reported cost is used by settleAmount's rules.
//   custom_endpoint the company's own OpenAI-compatible endpoint (DEC 254t), behind the SSRF guard (endpoint-guard.ts).
//
// DEC 254zzz263 + controller R-1: without a saved choice, keep a connected Anthropic key or Bedrock; only companies
// with nothing connected default to company-billed Rovara AI. Only the operator exemption list makes a call exempt. Saved choices and
// fallback order win at admission, before any hold or send; never retry another source after a provider answered.
import { BEDROCK_CONVERSE_ID } from "./bedrock-converse.js";
import type { CredentialSource } from "./aws.js";
import type { EndpointTarget } from "./endpoint-guard.js";
import { geographiesOf, parseBedrockConnect, type BedrockConnection } from "./bedrock-byo.js";
import type { BedrockSessionSource } from "./bedrock-byo-sessions.js";
import { BEDROCK_CLAUDE_ID, createBedrockTransport } from "./bedrock-transport.js";
import { GATEWAY_COMPANY_AGENT_AI } from "./deploy.js";
import type { Dynamo } from "./dynamo.js";
import type { LearningKeySource } from "./learning-route.js";
import { COMPANY, record } from "./model-gateway-token.js";
import type { ProviderTransport } from "./provider.js";
import { PRODUCT_DEFAULT_CAPS, type ProductKeyStore } from "./product-keys.js";
import type { ProductKeyRow } from "./product-seal.js";

export const AGENT_AI_SOURCES = ["rovara", "anthropic_key", "bedrock_byo", "openai_key", "openrouter_key", "custom_endpoint"] as const;
export type AgentAiSource = typeof AGENT_AI_SOURCES[number];

/**
 * DEC 254t (A2): the company's own OpenAI or OpenRouter key as its agents' AI (agent-openai.ts translates Anthropic Messages to Chat
 * Completions and back). The key is the company's sealed account of that provider (the learning document, learning-keys.ts); the
 * transport has a fixed host. `maxOutputTokens` is the price snapshot's limit for the model (unknown: OPENAI_AGENT_DEFAULT_MAX_OUTPUT_TOKENS).
 */
/** DEC 254t (A3): the company's own OpenAI-compatible endpoint: a transport per checked target (endpoint-source.ts), and catalog limits. */
export interface CompanyEndpointAi {
  /** `onRefused` is told why a call was refused before sending ("address" or "busy"); `company` is the verified company (resolution limits). */
  transport(target: EndpointTarget, onRefused: (reason: "address" | "busy") => void, company: string): ProviderTransport;
  /** The catalog model's output limit (the price snapshot's row). Unknown: OPENAI_AGENT_DEFAULT_MAX_OUTPUT_TOKENS. */
  maxOutputTokens?(provider: string, model: string): number | undefined;
}
export interface CompanyChatAi {
  transport: ProviderTransport;
  maxOutputTokens?(model: string): number | undefined;
}

/**
 * DEC 254t (a): the company AI source kinds the code supports (the contracts' SOURCE_KINDS_AT_LAUNCH; this package imports no
 * contracts, so a contract test holds the copies equal). Supported is not switched on: GATEWAY_AI_SOURCE_KINDS names the kinds the
 * install's owner switched on after each one's real-key check passed (scripts/real-key-check.ts). Absent or empty: none.
 */
export const AI_SOURCE_KINDS = ["anthropic", "openai", "openrouter", "bedrock", "endpoint"] as const;
export type AiSourceKind = typeof AI_SOURCE_KINDS[number];
/** The agent source each kind is chosen as. `rovara` is Rovara's own AI, never a company source kind. */
export const AGENT_SOURCE_OF_KIND: Readonly<Record<AiSourceKind, string>> = Object.freeze({ anthropic: "anthropic_key", openai: "openai_key", openrouter: "openrouter_key", bedrock: "bedrock_byo", endpoint: "custom_endpoint" });
/**
 * The company sources that were live before the per-install switch (DEC 236 and DEC 238). They keep working exactly as before, switch
 * or no switch: turning them off on an install that uses them would stop its agents. Whether to gate them too is an owner question.
 */
export const PRE_SWITCH_AGENT_SOURCES: readonly string[] = ["anthropic_key", "bedrock_byo"];

/**
 * GATEWAY_AI_SOURCE_KINDS: comma-separated supported kinds, no spaces, no repeats. Absent or empty: none switched on. Anything else
 * throws with fixed words (never a partial list; the value is never repeated).
 */
export function parseAiSourceKinds(value: string | undefined): Set<AiSourceKind> {
  if (value === undefined || value === "") return new Set();
  const kinds = value.split(",");
  if (kinds.length > AI_SOURCE_KINDS.length || new Set(kinds).size !== kinds.length || !kinds.every((kind) => (AI_SOURCE_KINDS as readonly string[]).includes(kind))) throw new Error("invalid AI source kinds");
  return new Set(kinds as AiSourceKind[]);
}

/**
 * Whether a saved agent source may be used on this install: Rovara's AI and the pre-switch sources always (their own settings decide,
 * as before); any other source only when its kind is switched on. An unknown source never.
 */
export function agentSourceSwitchedOn(source: string, switchedOn: ReadonlySet<string>): boolean {
  if (source === "rovara" || PRE_SWITCH_AGENT_SOURCES.includes(source)) return true;
  const kind = AI_SOURCE_KINDS.find((k) => AGENT_SOURCE_OF_KIND[k] === source);
  return kind !== undefined && switchedOn.has(kind);
}

export interface AgentAiSourceReader {
  /** The company's saved choice, or undefined when it saved none. Throws when the choice can't be read or is not one of the sources. */
  sourceFor(cid: string, signal?: AbortSignal): Promise<AgentAiSource | undefined>;
  /**
   * DEC 254zzz84(4): the company's saved order, its first choice and the sources after it (in order, possibly none), or undefined when it saved
   * none. Throws like sourceFor. A reader without it has no fallback (the first choice alone, exactly as before).
   */
  orderFor?(cid: string, signal?: AbortSignal): Promise<{ source: AgentAiSource; fallback: AgentAiSource[] } | undefined>;
}

/** DEC 254zzz84(4): the most sources a company's order may hold after its first choice. */
export const AGENT_AI_FALLBACK_MAX = 5;
/** A stored fallback list: an array of distinct known sources, without the first choice, at most AGENT_AI_FALLBACK_MAX. Anything else is undefined (unreadable). */
export function validFallback(value: unknown, source: AgentAiSource): AgentAiSource[] | undefined {
  if (!Array.isArray(value) || value.length > AGENT_AI_FALLBACK_MAX) return undefined;
  const seen = new Set<string>([source]);
  for (const entry of value) {
    if (typeof entry !== "string" || !(AGENT_AI_SOURCES as readonly string[]).includes(entry) || seen.has(entry)) return undefined;
    seen.add(entry);
  }
  return value.slice() as AgentAiSource[];
}

/**
 * The choice from Cloud's Companies table: COMPANY#<org_…> / AGENT_AI, `{ companyId, source, version, ... }`. Strongly consistent,
 * so an admin's change applies to the very next call. Fail closed: another company's row or an unknown source throws (the agent
 * route answers 503 and holds and sends nothing).
 */
export class CompanyAgentAiSource implements AgentAiSourceReader {
  constructor(private readonly db: Dynamo, private readonly table: string) {}
  async sourceFor(cid: string, signal?: AbortSignal): Promise<AgentAiSource | undefined> {
    return (await this.orderFor(cid, signal))?.source;
  }
  /** The saved order. A `fallback` that is present but not a valid list (another source twice, the first choice again, an unknown source, too many) throws: never a partial order. */
  async orderFor(cid: string, signal?: AbortSignal): Promise<{ source: AgentAiSource; fallback: AgentAiSource[] } | undefined> {
    if (typeof cid !== "string" || !COMPANY.test(cid)) throw new Error("agent ai source unavailable");
    const item = await this.db.get(this.table, { pk: `${GATEWAY_COMPANY_AGENT_AI.partitionPrefix}${cid}`, sk: GATEWAY_COMPANY_AGENT_AI.sortKey }, { consistent: true, ...(signal === undefined ? {} : { signal }) });
    if (item === undefined) return undefined;
    const source = record(item)?.source;
    if (item.companyId !== cid || typeof source !== "string" || !(AGENT_AI_SOURCES as readonly string[]).includes(source)) throw new Error("agent ai source unavailable");
    const stored = record(item)?.fallback;
    const fallback = stored === undefined ? [] : validFallback(stored, source as AgentAiSource);
    if (fallback === undefined) throw new Error("agent ai source unavailable");
    return { source: source as AgentAiSource, fallback };
  }
}

/** Saved choices win; R-1 preserves unsaved own keys before the billed Rovara default. Billing is decided at admission. */
export type AgentSourceVia = "chosen" | "default" | "own_key" | "none";
export interface ResolvedAgentSource {
  source: AgentAiSource | undefined; via: AgentSourceVia;
  /** DEC 254zzz84(4): the saved order's sources after `source`, only when the company saved some (absent: no fallback, exactly as before). */
  fallback?: AgentAiSource[];
}
/** Controller R-1: Anthropic precedes Bedrock, matching the backfill; only an unconnected company defaults to Rovara AI. */
export function defaultAgentSource(input: { keyConnected: boolean; bedrockConnected: boolean }): { source: AgentAiSource | undefined; via: "own_key" | "default" } {
  if (input.keyConnected) return { source: "anthropic_key", via: "own_key" };
  if (input.bedrockConnected) return { source: "bedrock_byo", via: "own_key" };
  return { source: "rovara", via: "default" };
}
export interface AgentSourcePorts {
  sources: AgentAiSourceReader;
  /** Operator billing exemptions only; never eligibility for the default. */
  exempt?: ReadonlySet<string>;
  keys: Pick<LearningKeySource, "connected" | "bedrockConnected">;
  byo?: Pick<ByoBedrock, "connection">;
}
/** Saved source/order first. Without one, preserve this issuer/company's own connections, even after backfill. Read faults throw before any hold or send. */
export async function resolveAgentSource(ports: AgentSourcePorts, iss: string, cid: string, signal?: AbortSignal): Promise<ResolvedAgentSource> {
  if (ports.sources.orderFor !== undefined) {
    const order = await ports.sources.orderFor(cid, signal);
    if (order !== undefined) return order.fallback.length === 0 ? { source: order.source, via: "chosen" } : { source: order.source, via: "chosen", fallback: order.fallback.slice() };
  } else {
    const saved = await ports.sources.sourceFor(cid, signal);
    if (saved !== undefined) return { source: saved, via: "chosen" };
  }
  const keyConnected = (await ports.keys.connected(iss, cid, "anthropic", signal)) === true;
  // An unavailable adapter says nothing about saved connections. Preserve the payer from metadata;
  // admission then refuses bedrock_byo as not offered, before any hold, credential read or send.
  const bedrockConnected = !keyConnected && (ports.byo === undefined
    ? (await ports.keys.bedrockConnected?.(iss, cid)) === true
    : (await ports.byo.connection(iss, cid, signal)) !== undefined);
  return defaultAgentSource({ keyConnected, bedrockConnected });
}

/** Rovara's AI as the agent route uses it. */
export interface RovaraAi {
  /** Deployed serving role and Region; no credential is exposed. Missing on legacy unpriced adapters. */
  sourceId?: string;
  /** The agent's (Anthropic) model name to its Bedrock model or system inference profile id: the allow-list. Nothing else is called. */
  models: ReadonlyMap<string, string>;
  /** Companies the operator named as exempt from charges (the founders' test company, DEC 240b). Never inferred. */
  exempt: ReadonlySet<string>;
  /** Bedrock in Rovara's account (createBedrockTransport). */
  transport: ProviderTransport;
  /**
   * DEC 243c: a non-Claude model's own output limit (the price snapshot's Bedrock row). A call is held to at most this; unknown:
   * CONVERSE_DEFAULT_MAX_OUTPUT_TOKENS. Claude keeps the agent route's own limit.
   */
  maxOutputTokens?(id: string): number | undefined;
}

const AGENT_MODEL = /^claude-[a-z0-9-]{1,80}$/u;
/**
 * DEC 243c: the other Bedrock coding models Rovara's AI offers, through Converse, each named exactly by the id called. Each passed
 * an agent-loop test on fakes and one real tiny ConverseStream call with a tool (staging us-west-2, 2026-11-15: a tool call within
 * 16 tokens, stop tool_use; the streams are tests/fixtures/model-gateway-bedrock/converse). Priced and limited by the price
 * snapshot's Bedrock rows. gpt-oss 120B / 20B and Nova Pro passed with maxTokens 256 (they reason first; tests/fixtures/
 * model-gateway-bedrock/converse-256): gpt-oss's reasoning is dropped (OpenAI only recommends passing it back after tool calls),
 * and Nova Pro's leading "<thinking>...</thinking>" text is left out (LEADING_THINKING_TEXT_MODEL). Kimi K2 Thinking, MiniMax M2.5,
 * Kimi K3 and Kimi K3.1 need their reasoning sent back on later tool turns; the gateway carries it both ways
 * (REASONING_CARRYOVER_MODEL in bedrock-converse.ts) and each passed the owner's real two-turn call (2026-11-16,
 * scripts/bedrock-reasoning-two-turn.ts; answers in tests/fixtures/model-gateway-bedrock/two-turn-real). Not listed: DeepSeek V3.2.
 */
export const ROVARA_AI_US_CONVERSE_MODELS = [
  "qwen.qwen3-coder-480b-a35b-v1:0=qwen.qwen3-coder-480b-a35b-v1:0",
  "qwen.qwen3-coder-30b-a3b-v1:0=qwen.qwen3-coder-30b-a3b-v1:0",
  "qwen.qwen3-235b-a22b-2507-v1:0=qwen.qwen3-235b-a22b-2507-v1:0",
  "mistral.devstral-2-123b=mistral.devstral-2-123b",
  "mistral.mistral-large-3-675b-instruct=mistral.mistral-large-3-675b-instruct",
  "deepseek.v3-v1:0=deepseek.v3-v1:0",
  "moonshotai.kimi-k2.5=moonshotai.kimi-k2.5",
  "zai.glm-5=zai.glm-5",
  "zai.glm-4.7=zai.glm-4.7",
  "us.amazon.nova-2-lite-v1:0=us.amazon.nova-2-lite-v1:0",
  "openai.gpt-oss-120b-1:0=openai.gpt-oss-120b-1:0",
  "openai.gpt-oss-20b-1:0=openai.gpt-oss-20b-1:0",
  "us.amazon.nova-pro-v1:0=us.amazon.nova-pro-v1:0",
  "moonshot.kimi-k2-thinking=moonshot.kimi-k2-thinking",
  "minimax.minimax-m2.5=minimax.minimax-m2.5",
  "us.moonshotai.kimi-k3=us.moonshotai.kimi-k3",
  "us.moonshotai.kimi-k3.1=us.moonshotai.kimi-k3.1",
  // deepseek.v3.2 stays unlisted: in the real two-turn call (2026-11-16) turn 1 ended end_turn with no tool call and no thinking.
].join(",");
/**
 * DEC 243: Rovara's AI offers every Claude model Bedrock has in the account, each engine model name (Code's model catalog) on its
 * `us.` system inference profile (US cross-Region routing; data stays in the US). Deployed with `-c rovaraModelGatewayRovaraAi=on`.
 * Every one is priced by the AWS price list's Bedrock rows (normalised to the same name) and limited by its Anthropic row.
 * Haiku 4.5 and Haiku 5.5 work at once; Sonnet 5.5, Opus 5.5 and Fable 5.2 need the account's one-time Marketplace enable first
 * (until then a call is refused, free, as ROVARA_AI_MODEL_NOT_ENABLED).
 */
export const ROVARA_AI_US_MODELS = [
  "claude-haiku-4-5=us.anthropic.claude-haiku-4-5-20251001-v1:0",
  "claude-haiku-4-5-20251001=us.anthropic.claude-haiku-4-5-20251001-v1:0",
  "claude-haiku-5-5=us.anthropic.claude-haiku-5-5",
  "claude-sonnet-5-5=us.anthropic.claude-sonnet-5-5",
  "claude-opus-5-5=us.anthropic.claude-opus-5-5",
  "claude-fable-5-2=us.anthropic.claude-fable-5-2",
].join(",");
export const ROVARA_AI_MODELS_MAX = 24;
export const ROVARA_AI_EXEMPT_MAX = 10;

/**
 * GATEWAY_ROVARA_AI_MODELS: `<agent model>=<bedrock id>` pairs, comma-separated, e.g.
 * `claude-sonnet-5-5=us.anthropic.claude-sonnet-5-5`. Each id is a Claude system inference profile of the gateway's own Region's
 * geography (DEC 243: `us.` from a US Region). A plain model id, a `global.` profile or another geography's is refused. Throws on
 * anything else.
 */
export function parseRovaraAiModels(value: string, region: string): Map<string, string> {
  const models = new Map<string, string>();
  const geographies = geographiesOf(region);
  const pairs = value.split(",");
  if (value.trim() === "" || pairs.length > ROVARA_AI_MODELS_MAX) throw new Error("invalid rovara ai models");
  for (const pair of pairs) {
    const [name, id, extra] = pair.trim().split("=");
    if (name === undefined || id === undefined || extra !== undefined || models.has(name)) throw new Error("invalid rovara ai models");
    if (BEDROCK_CLAUDE_ID.test(id)) {
      // Claude: an engine model name, on a profile of this Region's geography only (DEC 243).
      if (!AGENT_MODEL.test(name) || !geographies.includes(id.slice(0, id.indexOf(".")))) throw new Error("invalid rovara ai models");
    } else if (BEDROCK_CONVERSE_ID.test(id)) {
      // Any other model (DEC 243c, through Converse): the engine names it exactly by the Bedrock id that is called (Code's model
      // catalog names Bedrock models so, profiles included): that model in this Region, or its profile of this Region's geography.
      const geo = id.split(".").length > 2 && /^(?:us|eu|apac|jp|au|ca)\./u.test(id) ? id.slice(0, id.indexOf(".")) : undefined;
      if (name !== id || (geo !== undefined && !geographies.includes(geo))) throw new Error("invalid rovara ai models");
    } else throw new Error("invalid rovara ai models");
    models.set(name, id);
  }
  return models;
}

/** GATEWAY_ROVARA_AI_EXEMPT: company ids, comma-separated (the operator's explicit list). Empty: none. Throws on anything else. */
export function parseRovaraAiExempt(value: string | undefined): Set<string> {
  if (value === undefined || value === "") return new Set();
  const ids = value.split(",").map((id) => id.trim());
  if (ids.length > ROVARA_AI_EXEMPT_MAX || ids.some((id) => !COMPANY.test(id)) || new Set(ids).size !== ids.length) throw new Error("invalid rovara ai exempt companies");
  return new Set(ids);
}

/**
 * DEC 238: the company's OWN Bedrock as its agents' source (`bedrock_byo`). The connection is the company's one sealed `bedrock`
 * source (product-keys.ts companyBedrock), opened only for the verified company; the call is signed with the customer's role,
 * assumed as that company (bedrock-byo-sessions.ts). Bedrock bills the customer; the gateway meters at list price under the one
 * combined company cap and writes no billable line.
 */
export interface ByoBedrock {
  /** The company's connection, or undefined when none is connected. Throws when it can't be read (the route answers 503). */
  connection(iss: string, cid: string, signal?: AbortSignal): Promise<{ row: ProductKeyRow; connection: BedrockConnection } | undefined>;
  sessions: BedrockSessionSource;
  /** The Bedrock transport for the connection's Region, signing with `credentials` (bedrock-transport.ts). */
  transport(region: string, credentials: CredentialSource): ProviderTransport;
  /** AWS refused the role or a model: shown on the settings page. Never changes the call; never throws. */
  refused?(iss: string, cid: string, row: ProductKeyRow): Promise<void>;
}
/** The deployed ByoBedrock: the product key store's company source, the sessions, and the fixed Bedrock transport. */
export function storedBedrock(store: Pick<ProductKeyStore, "companyBedrock" | "useKey" | "recordWarning">, sessions: BedrockSessionSource, transport: (region: string, credentials: CredentialSource) => ProviderTransport = (region, credentials) => createBedrockTransport({ region, credentials })): ByoBedrock {
  return {
    async connection(iss, cid) {
      const source = await store.companyBedrock(iss, cid);
      if (source === undefined) return undefined;
      const text = await store.useKey(iss, cid, source);
      // Removed between the two reads: not connected.
      if (text === undefined) return undefined;
      const connection = parseBedrockConnect(text);
      if (connection === undefined) throw new Error("bedrock connection unreadable");
      return { row: { iss, cid, owner: source.owner, sourceId: source.sourceId, versionId: source.versionId }, connection };
    },
    sessions, transport,
    async refused(iss, cid, row) {
      try { await store.recordWarning(iss, cid, { sourceId: row.sourceId, owner: row.owner, provider: "bedrock", caps: { ...PRODUCT_DEFAULT_CAPS }, versionId: row.versionId }, 403); } catch { /* A warning never changes a call. */ }
    },
  };
}
