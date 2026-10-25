import { E2E_AGENT_BEDROCK_QUOTA_CODES, bedrockProfileGeography, type E2EModelFailureClass, type ModelProvider } from "@agentx/contracts";

/**
 * Model discovery and recommendation (M1.4 Task 4.10C, D-4): which of the models Rovara could use does this account actually see, and how to rank them for the owner.
 *
 * It is pure: every transport (the Bedrock control plane, Service Quotas, `fetch`, the provider key) is injected, and it knows nothing of the e2e route, so Task 4.10D's quota hint
 * and the follow-up DISCOVERROLES reuse it. It is read-only and keeps only ids, statuses and counts: no key, no message text, no account detail.
 *
 * Discovery never blocks. Any list error, a 401 or 403, a network error or a deadline gives `status: "unverified"` with a fixed reason, and the driving test decides instead. A partial
 * answer (models listed, quotas denied) stays `listed`, without quota hints. Without a quota the ranking does not recommend the model (I-3): a limit of zero is `limit-zero`, and a
 * quota that could not be read is "unknown", which is not "usable".
 */

export const MODEL_DISCOVERY_SCHEMA = "rovara-model-discovery/v1" as const;
/** The bound on one call and on the whole discovery. */
export const MODEL_DISCOVERY_CALL_TIMEOUT_MS = 10_000;
export const MODEL_DISCOVERY_TOTAL_TIMEOUT_MS = 60_000;
const MAX_PROFILE_PAGES = 5;
/** The account's quota list for Bedrock is long (a hundred a page); a list that goes on past this many pages is read as incomplete (`quota-lookup-incomplete`), never as complete. */
const MAX_QUOTA_PAGES = 20;
const MAX_AVAILABILITY_CHECKS = 20;
const MAX_ANTHROPIC_PAGES = 3;
const MAX_OPENROUTER_CANDIDATES = 10;

export type DiscoveryState = "available" | "needs-access" | "not-in-region" | "limit-zero" | "listed";
export type UnverifiedReason = "access-denied" | "key-rejected" | "unreachable" | "not-supported" | "unknown";
export interface QuotaEntry { scope: "geographic" | "global"; code: string | null; tokensPerMinute: number | null }
export interface DiscoveredModel { modelId: string; visible: boolean; state: DiscoveryState; quotas: QuotaEntry[]; signals: string[] }
export interface ModelDiscoveryReport {
  schemaVersion: typeof MODEL_DISCOVERY_SCHEMA;
  provider: ModelProvider;
  checkedAt: string;
  status: "listed" | "unverified";
  unverifiedReason?: UnverifiedReason;
  models: DiscoveredModel[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------------------------------------------------

export interface InferenceProfileRow { id: string; status: string; foundationModelIds: readonly string[] }
export interface FoundationModelRow { modelId: string; modelName: string; providerName: string }
export interface AvailabilityRow { agreement: string | null; authorization: string | null }
export interface BedrockDiscoveryClient {
  listInferenceProfiles(page: { nextToken?: string }): Promise<{ profiles: readonly InferenceProfileRow[]; nextToken?: string | undefined }>;
  listFoundationModels(): Promise<readonly FoundationModelRow[]>;
  getAvailability(foundationModelId: string): Promise<AvailabilityRow>;
}
export interface QuotaRow { code: string; name: string; value: number }
export interface QuotaClient { list(page: { nextToken?: string }): Promise<{ quotas: readonly QuotaRow[]; nextToken?: string | undefined }> }

export interface DiscoveryDependencies {
  bedrock?: BedrockDiscoveryClient;
  quotas?: QuotaClient;
  fetch?: typeof fetch;
  /** The provider key, read when a request is made and never kept. */
  apiKey?: () => Promise<string>;
  now: () => number;
  /** Test seam for the deadlines. */
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface DiscoverInput {
  provider: ModelProvider;
  region?: string;
  /** The OpenRouter provider allowlist, as slugs. */
  openRouterProviders?: readonly string[];
  /** The model ids to look for (the eligible ones): discovery never reports a model outside this list. */
  candidates: readonly string[];
  /** A gateway's base URL, for a later task; a gateway without `/models` gives `unverified/not-supported`. */
  baseUrl?: string;
}

class DiscoveryFailure extends Error {
  constructor(readonly reason: UnverifiedReason) { super(reason); this.name = "DiscoveryFailure"; }
}

function classifyError(error: unknown): UnverifiedReason {
  if (error instanceof DiscoveryFailure) return error.reason;
  const record = typeof error === "object" && error !== null ? error as { name?: unknown; code?: unknown; $metadata?: { httpStatusCode?: unknown }; status?: unknown } : {};
  const name = typeof record.name === "string" ? record.name : "";
  const status = typeof record.$metadata?.httpStatusCode === "number" ? record.$metadata.httpStatusCode : typeof record.status === "number" ? record.status : undefined;
  if (/^(AccessDenied|UnauthorizedOperation|AccessDeniedException|NoSuchResourceException|UnrecognizedClientException)/.test(name) || status === 403 || status === 401) return "access-denied";
  if (name === "TimeoutError" || (typeof record.code === "string" && /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR_)/.test(record.code))) return "unreachable";
  return "unknown";
}

/** A deadline-bound call: `unreachable` when it does not settle within the smaller of the per-call bound and what is left of the whole. */
function createBounded(deps: DiscoveryDependencies): <T>(operation: () => Promise<T>) => Promise<T> {
  const startedAt = deps.now();
  const setTimer = deps.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const left = MODEL_DISCOVERY_TOTAL_TIMEOUT_MS - (deps.now() - startedAt);
    if (left <= 0) throw new DiscoveryFailure("unreachable");
    let handle: unknown;
    const deadline = new Promise<never>((_resolve, reject) => { handle = setTimer(() => reject(new DiscoveryFailure("unreachable")), Math.min(MODEL_DISCOVERY_CALL_TIMEOUT_MS, left)); });
    try { return await Promise.race([operation(), deadline]); } finally { clearTimer(handle); }
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Bedrock quotas
// ---------------------------------------------------------------------------------------------------------------------

/** The foundation model behind a Bedrock profile id: the id without its geography prefix (`us.`, `global.`, ...). */
export function foundationModelIdOf(profileId: string): string {
  return bedrockProfileGeography(profileId) === undefined ? profileId : profileId.slice(profileId.indexOf(".") + 1);
}

const normalize = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const GEOGRAPHIC_QUOTA_NAME = /^cross-region model inference tokens per minute for (.+)$/i;
const GLOBAL_QUOTA_NAME = /^global cross-region model inference tokens per minute for (.+)$/i;

export interface QuotaHintInput {
  /** The model id as the route pins it (a profile id on Bedrock). */
  modelId: string;
  region: string;
  /** The model's name as Bedrock lists it, with its provider (`Anthropic Claude Haiku 4.5`), to match quotas by name; known quota codes need none. */
  modelName?: string;
  /** Known quota codes by foundation model id. Defaults to the contracts' table. */
  knownCodes?: Readonly<Record<string, { geographic: string | null; global: string | null }>>;
}

/** The rows read, and whether the account's list ended (`complete`) or the page cap stopped the read with more to come. */
async function readAllQuotas(quotas: QuotaClient, call: <T>(operation: () => Promise<T>) => Promise<T>): Promise<{ rows: QuotaRow[]; complete: boolean }> {
  const rows: QuotaRow[] = [];
  let nextToken: string | undefined;
  for (let page = 0; page < MAX_QUOTA_PAGES; page += 1) {
    const response = await call(() => quotas.list(nextToken === undefined ? {} : { nextToken }));
    rows.push(...response.quotas);
    nextToken = response.nextToken;
    if (nextToken === undefined) break;
  }
  return { rows, complete: nextToken === undefined };
}

function hintFrom(rows: readonly QuotaRow[], input: QuotaHintInput): QuotaEntry[] {
  const known = (input.knownCodes ?? E2E_AGENT_BEDROCK_QUOTA_CODES)[foundationModelIdOf(input.modelId)];
  const wanted = input.modelName === undefined ? undefined : normalize(input.modelName);
  const find = (scope: "geographic" | "global"): QuotaEntry => {
    const code = scope === "geographic" ? known?.geographic : known?.global;
    let match = code === null || code === undefined ? undefined : rows.find((row) => row.code === code);
    if (match === undefined && wanted !== undefined && wanted !== "") {
      const pattern = scope === "geographic" ? GEOGRAPHIC_QUOTA_NAME : GLOBAL_QUOTA_NAME;
      match = rows.find((row) => { const named = pattern.exec(row.name)?.[1]; return named !== undefined && normalize(named) === wanted; });
    }
    return match === undefined ? { scope, code: code ?? null, tokensPerMinute: null } : { scope, code: match.code, tokensPerMinute: Number.isFinite(match.value) ? match.value : null };
  };
  return [find("geographic"), find("global")];
}

/**
 * The two "tokens per minute" quotas of one Bedrock model, geographic (cross-region) and global. A quota that is not found has `tokensPerMinute: null` (never a state), and a
 * lookup that is denied or fails gives both as null: it is a hint, never a verdict. Used by the driving test's discovery and by Task 4.10D's coding-role checks.
 */
export async function quotaHint(input: QuotaHintInput, deps: Pick<DiscoveryDependencies, "quotas" | "now"> & Partial<DiscoveryDependencies>): Promise<QuotaEntry[]> {
  const empty = hintFrom([], input);
  if (deps.quotas === undefined) return empty;
  try {
    const { rows } = await readAllQuotas(deps.quotas, createBounded(deps));
    return hintFrom(rows, input);
  } catch { return empty; }
}

// ---------------------------------------------------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------------------------------------------------

const unverified = (input: DiscoverInput, deps: DiscoveryDependencies, reason: UnverifiedReason): ModelDiscoveryReport =>
  ({ schemaVersion: MODEL_DISCOVERY_SCHEMA, provider: input.provider, checkedAt: new Date(deps.now()).toISOString(), status: "unverified", unverifiedReason: reason, models: [] });
const listed = (input: DiscoverInput, deps: DiscoveryDependencies, models: DiscoveredModel[]): ModelDiscoveryReport =>
  ({ schemaVersion: MODEL_DISCOVERY_SCHEMA, provider: input.provider, checkedAt: new Date(deps.now()).toISOString(), status: "listed", models });

async function discoverBedrock(input: DiscoverInput, deps: DiscoveryDependencies, call: ReturnType<typeof createBounded>): Promise<ModelDiscoveryReport> {
  const bedrock = deps.bedrock;
  if (bedrock === undefined) return unverified(input, deps, "not-supported");
  const profiles = new Map<string, InferenceProfileRow>();
  let nextToken: string | undefined;
  for (let page = 0; page < MAX_PROFILE_PAGES; page += 1) {
    const response = await call(() => bedrock.listInferenceProfiles(nextToken === undefined ? {} : { nextToken }));
    for (const profile of response.profiles) profiles.set(profile.id, profile);
    nextToken = response.nextToken;
    if (nextToken === undefined) break;
  }
  let names = new Map<string, FoundationModelRow>();
  try { names = new Map((await call(() => bedrock.listFoundationModels())).map((row) => [row.modelId, row])); } catch { /* names only help the quota match */ }
  // How the quota lookup went, as a fixed code: `ok`, `incomplete` (the page cap stopped it), `unavailable` (no client), or why it failed. It reaches the report as a signal on every
  // model whose quota stays unknown, so a run that cannot read quotas says so instead of looking like one that found none.
  let quotaRows: QuotaRow[] | undefined;
  let quotaStatus: "ok" | "incomplete" | "unavailable" | UnverifiedReason = "unavailable";
  if (deps.quotas !== undefined) {
    try { const read = await readAllQuotas(deps.quotas, call); quotaRows = read.rows; quotaStatus = read.complete ? "ok" : "incomplete"; } catch (error) { quotaRows = undefined; quotaStatus = classifyError(error); }
  }

  const availabilityByFoundation = new Map<string, AvailabilityRow | null>();
  let availabilityChecks = 0;
  const models: DiscoveredModel[] = [];
  for (const modelId of input.candidates) {
    const profile = profiles.get(modelId);
    if (profile === undefined || profile.status !== "ACTIVE") {
      models.push({ modelId, visible: false, state: "not-in-region", quotas: [], signals: ["profile-missing-or-inactive"] });
      continue;
    }
    const foundationId = foundationModelIdOf(modelId);
    const behind = profile.foundationModelIds.length > 0 ? profile.foundationModelIds : [foundationId];
    let state: DiscoveryState = "listed";
    const signals: string[] = [];
    let denied = false;
    let confirmed = true;
    for (const behindId of behind) {
      if (!availabilityByFoundation.has(behindId)) {
        if (availabilityChecks >= MAX_AVAILABILITY_CHECKS) availabilityByFoundation.set(behindId, null);
        else {
          availabilityChecks += 1;
          try { availabilityByFoundation.set(behindId, await call(() => bedrock.getAvailability(behindId))); } catch { availabilityByFoundation.set(behindId, null); }
        }
      }
      const availability = availabilityByFoundation.get(behindId) ?? null;
      if (availability === null) { confirmed = false; signals.push("availability-unknown"); continue; }
      if (availability.agreement !== null && availability.agreement !== "AVAILABLE") { denied = true; signals.push(`agreement-${availability.agreement.toLowerCase()}`); }
      if (availability.authorization !== null && availability.authorization !== "AUTHORIZED") { denied = true; signals.push(`authorization-${availability.authorization.toLowerCase()}`); }
    }
    if (denied) state = "needs-access";
    else if (confirmed) state = "available";
    const named = names.get(foundationId);
    const quotas = quotaRows === undefined ? hintFrom([], { modelId, region: input.region ?? "" })
      : hintFrom(quotaRows, { modelId, region: input.region ?? "", ...(named === undefined ? {} : { modelName: `${named.providerName} ${named.modelName}` }) });
    // The quota that applies to the route's own scope decides a zero.
    const scope = bedrockProfileGeography(modelId) === "global" ? "global" : "geographic";
    const routeQuota = quotas.find((entry) => entry.scope === scope)?.tokensPerMinute ?? null;
    if (state !== "needs-access" && routeQuota === 0) state = "limit-zero";
    if (routeQuota === null) signals.push(quotaStatus === "ok" ? "quota-not-found" : `quota-lookup-${quotaStatus}`);
    models.push({ modelId, visible: true, state, quotas, signals });
  }
  return listed(input, deps, models);
}

async function readJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return undefined; }
}

function statusFailure(status: number): DiscoveryFailure {
  if (status === 401 || status === 403) return new DiscoveryFailure("key-rejected");
  if (status === 404 || status === 405) return new DiscoveryFailure("not-supported");
  return new DiscoveryFailure("unknown");
}

async function discoverAnthropic(input: DiscoverInput, deps: DiscoveryDependencies, call: ReturnType<typeof createBounded>): Promise<ModelDiscoveryReport> {
  if (deps.fetch === undefined || deps.apiKey === undefined) return unverified(input, deps, "not-supported");
  const base = input.baseUrl ?? "https://api.anthropic.com";
  const ids = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < MAX_ANTHROPIC_PAGES; page += 1) {
    const key = await deps.apiKey();
    const url = `${base}/v1/models?limit=1000${after === undefined ? "" : `&after_id=${encodeURIComponent(after)}`}`;
    const response = await call(() => deps.fetch!(url, { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } }));
    if (!response.ok) throw statusFailure(response.status);
    const body = await readJson(response) as { data?: Array<{ id?: unknown }>; has_more?: unknown; last_id?: unknown } | undefined;
    for (const row of body?.data ?? []) if (typeof row.id === "string") ids.add(row.id);
    if (body?.has_more !== true || typeof body.last_id !== "string") break;
    after = body.last_id;
  }
  const models = input.candidates.map((modelId): DiscoveredModel => {
    // The listing names a dated snapshot of an alias, so the pin counts as listed when only its dated id is there.
    const found = ids.has(modelId) || [...ids].some((id) => id.startsWith(`${modelId}-`) && /^\d{8}$/.test(id.slice(modelId.length + 1)));
    return { modelId, visible: found, state: found ? "available" : "not-in-region", quotas: [], signals: found ? [] : ["not-listed"] };
  });
  return listed(input, deps, models);
}

async function discoverOpenAi(input: DiscoverInput, deps: DiscoveryDependencies, call: ReturnType<typeof createBounded>): Promise<ModelDiscoveryReport> {
  if (deps.fetch === undefined || deps.apiKey === undefined) return unverified(input, deps, "not-supported");
  const base = input.baseUrl ?? "https://api.openai.com";
  const key = await deps.apiKey();
  const response = await call(() => deps.fetch!(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` } }));
  if (!response.ok) throw statusFailure(response.status);
  const body = await readJson(response) as { data?: Array<{ id?: unknown }> } | undefined;
  const ids = new Set((body?.data ?? []).flatMap((row) => (typeof row.id === "string" ? [row.id] : [])));
  // A project allowlist may not be reflected in this list: the driving test decides.
  return listed(input, deps, input.candidates.map((modelId) => ({ modelId, visible: ids.has(modelId), state: ids.has(modelId) ? "available" as const : "not-in-region" as const, quotas: [], signals: ids.has(modelId) ? [] : ["not-listed"] })));
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function discoverOpenRouter(input: DiscoverInput, deps: DiscoveryDependencies, call: ReturnType<typeof createBounded>): Promise<ModelDiscoveryReport> {
  if (deps.fetch === undefined) return unverified(input, deps, "not-supported");
  const base = input.baseUrl ?? "https://openrouter.ai";
  const allowed = (input.openRouterProviders ?? []).map(slug).filter(Boolean);
  const headers: Record<string, string> = deps.apiKey === undefined ? {} : { authorization: `Bearer ${await deps.apiKey()}` };
  let creditsLeft: number | null = null;
  if (deps.apiKey !== undefined) {
    try {
      const response = await call(() => deps.fetch!(`${base}/api/v1/key`, { headers }));
      if (response.status === 401 || response.status === 403) throw new DiscoveryFailure("key-rejected");
      if (response.ok) { const body = await readJson(response) as { data?: { limit_remaining?: unknown } } | undefined; if (typeof body?.data?.limit_remaining === "number") creditsLeft = body.data.limit_remaining; }
    } catch (error) { if (error instanceof DiscoveryFailure && error.reason === "key-rejected") throw error; }
  }
  const models: DiscoveredModel[] = [];
  for (const modelId of input.candidates.slice(0, MAX_OPENROUTER_CANDIDATES)) {
    const [author, ...rest] = modelId.split("/");
    if (author === undefined || rest.length === 0) { models.push({ modelId, visible: false, state: "not-in-region", quotas: [], signals: ["not-an-openrouter-id"] }); continue; }
    const response = await call(() => deps.fetch!(`${base}/api/v1/models/${encodeURIComponent(author)}/${rest.map(encodeURIComponent).join("/")}/endpoints`, { headers }));
    if (response.status === 404) { models.push({ modelId, visible: false, state: "not-in-region", quotas: [], signals: ["not-listed"] }); continue; }
    if (!response.ok) throw statusFailure(response.status);
    const body = await readJson(response) as { data?: { endpoints?: Array<{ tag?: unknown; provider_name?: unknown }> } } | undefined;
    const slugs = (body?.data?.endpoints ?? []).flatMap((endpoint) => {
      const tag = typeof endpoint.tag === "string" ? slug(endpoint.tag.split("/")[0] ?? "") : "";
      const name = typeof endpoint.provider_name === "string" ? slug(endpoint.provider_name) : "";
      return [tag, name].filter(Boolean);
    });
    const served = allowed.length === 0 ? slugs.length > 0 : slugs.some((candidate) => allowed.includes(candidate));
    if (!served) { models.push({ modelId, visible: false, state: "not-in-region", quotas: [], signals: ["no-allowed-endpoint"] }); continue; }
    models.push({ modelId, visible: true, state: creditsLeft === 0 ? "limit-zero" : "available", quotas: [], signals: creditsLeft === 0 ? ["no-credit-left"] : [] });
  }
  return listed(input, deps, models);
}

/** Never throws: a failure of any kind is an `unverified` report with a fixed reason. */
export async function discoverModels(input: DiscoverInput, deps: DiscoveryDependencies): Promise<ModelDiscoveryReport> {
  const call = createBounded(deps);
  try {
    switch (input.provider) {
      case "amazon-bedrock": return await discoverBedrock(input, deps, call);
      case "anthropic": return await discoverAnthropic(input, deps, call);
      case "openai": return await discoverOpenAi(input, deps, call);
      case "openrouter": return await discoverOpenRouter(input, deps, call);
    }
  } catch (error) {
    return unverified(input, deps, classifyError(error));
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------------------------------------------------

export interface EligibleModel { modelId: string; label: string; inputUsdPerMTok: number; outputUsdPerMTok: number; scope: "geographic" | "global" | null }
export interface ModelTestRecord {
  modelId: string;
  outcome: "passed" | "failed";
  failureClass?: E2EModelFailureClass | null;
  signal?: string | null;
  payloadShape?: "standard" | "minimal";
  testedAt: string;
}
export type NotUsableReason =
  | { code: "limit-zero" | "needs-access" | "not-in-region" }
  | { code: "test-failed"; failureClass: E2EModelFailureClass };
/** `quotaUnreadable`: a Bedrock model seen on the account whose quota for its own route is not known (the lookup was denied, incomplete or found nothing). It can be tested, never recommended untested. */
export interface Tiered extends EligibleModel { testedAt?: string; payloadShape?: "standard" | "minimal"; state?: DiscoveryState; quotaUnreadable?: boolean }
export interface RankedModels {
  recommended: Tiered | null;
  /** Why the recommendation is not the Rovara default, or that discovery could not check. `quota-unreadable`: the default's quota on this account is not known, so it is not recommended. */
  why: "default" | "default-not-usable" | "quota-unreadable" | "discovery-unverified" | "none";
  worksOnAccount: Tiered[];
  notUsable: Array<Tiered & { reason: NotUsableReason }>;
  canBeTested: Tiered[];
}

/** The model family an id belongs to: its id up to the first version number, so Haiku 5.5 and Haiku 4.5 share one. */
function familyOf(modelId: string): string {
  const withoutGeography = bedrockProfileGeography(modelId) === undefined ? modelId : modelId.slice(modelId.indexOf(".") + 1);
  const match = /^[^0-9]*?(?=[-.:]?\d)/.exec(withoutGeography);
  return match === null ? withoutGeography : match[0];
}

export function rankModels(input: { report: ModelDiscoveryReport | null; eligible: readonly EligibleModel[]; recommended: string; tests: readonly ModelTestRecord[]; current?: string | undefined }): RankedModels {
  const byId = new Map(input.eligible.map((row) => [row.modelId, row] as const));
  const latest = new Map<string, ModelTestRecord>();
  for (const test of input.tests) {
    const previous = latest.get(test.modelId);
    if (previous === undefined || previous.testedAt < test.testedAt) latest.set(test.modelId, test);
  }
  const verified = input.report !== null && input.report.status === "listed";
  const discovered = new Map((verified ? input.report!.models : []).map((row) => [row.modelId, row] as const));
  const family = familyOf(input.recommended);
  const order = (left: EligibleModel, right: EligibleModel): number => {
    const key = (row: EligibleModel) => [row.modelId === input.current ? 0 : 1, familyOf(row.modelId) === family ? 0 : 1, row.scope === "global" ? 1 : 0] as const;
    const a = key(left); const b = key(right);
    for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return a[index]! - b[index]!;
    return left.inputUsdPerMTok - right.inputUsdPerMTok || (left.modelId < right.modelId ? -1 : left.modelId > right.modelId ? 1 : 0);
  };

  const works: Tiered[] = [];
  const notUsable: Array<Tiered & { reason: NotUsableReason }> = [];
  const canBeTested: Tiered[] = [];
  for (const row of input.eligible) {
    const test = latest.get(row.modelId);
    const seen = discovered.get(row.modelId);
    if (test?.outcome === "passed") { works.push({ ...row, testedAt: test.testedAt, ...(test.payloadShape === undefined ? {} : { payloadShape: test.payloadShape }) }); continue; }
    if (test?.outcome === "failed") { notUsable.push({ ...row, testedAt: test.testedAt, reason: { code: "test-failed", failureClass: test.failureClass ?? "unknown" } }); continue; }
    if (verified) {
      if (seen === undefined || !seen.visible) { if (row.modelId === input.recommended) notUsable.push({ ...row, state: "not-in-region", reason: { code: "not-in-region" } }); continue; }
      if (seen.state === "limit-zero" || seen.state === "needs-access") { notUsable.push({ ...row, state: seen.state, reason: { code: seen.state } }); continue; }
      // I-3: on Bedrock a model is "usable" only with a quota that is known, and above zero (zero is limit-zero above). Reports stored by earlier versions carry the same null entries.
      const quotaUnreadable = input.report!.provider === "amazon-bedrock" && row.scope !== null && seen.quotas.length > 0 && (seen.quotas.find((entry) => entry.scope === row.scope)?.tokensPerMinute ?? null) === null;
      canBeTested.push({ ...row, state: seen.state, ...(quotaUnreadable ? { quotaUnreadable: true } : {}) });
    } else if (row.modelId === input.recommended || row.modelId === input.current) canBeTested.push(row);
  }
  works.sort((left, right) => (right.testedAt ?? "").localeCompare(left.testedAt ?? "") || order(left, right));
  canBeTested.sort(order);
  notUsable.sort(order);

  const defaultRow = byId.get(input.recommended);
  const defaultUnusable = notUsable.some((row) => row.modelId === input.recommended);
  const defaultQuotaUnreadable = canBeTested.some((row) => row.modelId === input.recommended && row.quotaUnreadable === true);
  let recommended: Tiered | null = null;
  let why: RankedModels["why"];
  if (defaultRow !== undefined && !defaultUnusable && !defaultQuotaUnreadable) {
    recommended = works.find((row) => row.modelId === input.recommended) ?? canBeTested.find((row) => row.modelId === input.recommended) ?? defaultRow;
    why = verified ? "default" : "discovery-unverified";
  } else {
    // Recommend only what is known usable: a model that passed its test, or one seen with a quota that is known.
    recommended = works[0] ?? canBeTested.find((row) => row.quotaUnreadable !== true) ?? null;
    why = defaultQuotaUnreadable ? "quota-unreadable" : recommended === null ? "none" : "default-not-usable";
  }
  return { recommended, why, worksOnAccount: works, notUsable, canBeTested: canBeTested.filter((row) => row.modelId !== recommended?.modelId) };
}
