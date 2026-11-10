// Port lane P5 (item K2, owner decisions 60 and 61): the `model-provider` plug-in point.
//
// A model provider is a plug-in that says WHERE a model is, HOW to sign in to it, WHICH request format it speaks and WHAT it costs. The provider id is open
// text (the key store's `provider` was always free text), so a company's own model gateway is a new plug-in and no core change. Bedrock is a normal provider here:
// its sign-in kind is `aws-sigv4`, not a hard-wired machine role.
//
// What this port does NOT change: the model key never reaches a worker (the proxy signs the call), the proxy's request guard (the allow-lists of fields, tool types
// and headers, field for field as Cloud's guard) and the task budget apply to every provider the same way, and a provider-side tool is refused whatever the provider.
//
// Formats are three, for now (research: designs-2026-10-30/MODEL-PROVIDER-FORMATS-RESEARCH.md): Anthropic messages, OpenAI chat and OpenAI responses. The sign-in kind
// and the address are separate from the format, because the big clouds serve the same format with different sign-ins and paths. Claude on Google Cloud's Vertex AI is the
// messages format with the `vertex` variant (the model in the address, the version in the body), not a fourth format. OpenAI responses is always sent with the full
// history and `store: false`: no part of Rovara depends on state kept at the provider.
import { z } from "zod";
import type { SecretValue } from "./model-keys.js";
import type { ModelPrice } from "./policy.js";

/** The request formats a provider may speak (the worker's `InvocationModelRoute.api` values). */
export const MODEL_REQUEST_FORMATS = ["anthropic-messages", "openai-completions", "openai-responses"] as const;
export type ModelRequestFormat = (typeof MODEL_REQUEST_FORMATS)[number];

/** A provider id: lower-case words and digits with hyphens. Open: any plug-in may bring a new one. */
export const MODEL_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/u;

/** The ways a provider can be signed in to. */
export const MODEL_SIGN_IN_KINDS = ["bearer-key", "named-header", "aws-sigv4", "google-oauth", "microsoft-entra", "none"] as const;
export type ModelSignInKind = (typeof MODEL_SIGN_IN_KINDS)[number];

/**
 * What the sign-in needs, by kind:
 *  - `bearer-key`: `Authorization: Bearer <key>`; the key is the provider's entry in the key store.
 *  - `named-header`: the key in a header of the provider's choice (`x-api-key`, `api-key`).
 *  - `aws-sigv4`: the call is signed with AWS Signature Version 4 for `service` in `region`. The credential is JSON `{"accessKeyId","secretAccessKey","sessionToken"?}`, from the
 *    provider's `credential()` (an AWS role resolved when the call is made) or from the key store.
 *  - `google-oauth`: a Google access token as a bearer token. The token is the provider's `credential()` (refreshed there) or the key store's value.
 *  - `microsoft-entra`: a Microsoft Entra access token (for `scope`) as a bearer token, from the same two places.
 *  - `none`: no sign-in (a model on this computer or in a trusted network).
 */
export type ModelSignIn =
  | { kind: "bearer-key" }
  | { kind: "named-header"; header: string }
  | { kind: "aws-sigv4"; region: string; service: string }
  | { kind: "google-oauth" }
  | { kind: "microsoft-entra"; scope: string }
  | { kind: "none" };

/**
 * What a provider really does with a request of one format. Many OpenAI-compatible layers ignore a field silently instead of refusing it, so a plug-in states what
 * it honours and the proxy refuses a request that needs what is not honoured (today: a forced tool choice) rather than let it fall through.
 */
export interface ModelFormatCapabilities {
  /** A tool choice that names a tool or says "required"/"any" is honoured. */
  forcedToolChoice: boolean;
  /** More than one tool call in one answer. */
  parallelToolCalls: boolean;
  /** How reasoning is controlled: `effort` (a level), `thinking` (a budget) or `none`. */
  reasoning: "none" | "effort" | "thinking";
  /** The reasoning comes back in the answer. */
  reasoningReturned: boolean;
  /** The provider caches a repeated prompt prefix. */
  promptCaching: boolean;
  /** The streamed answer ends with token counts (what the budget reads). */
  streamUsage: boolean;
}

export interface ModelProviderFormat {
  format: ModelRequestFormat;
  /**
   * The path on the provider for this format, in place of the usual one (`/v1/messages`, `/v1/chat/completions`, `/v1/responses`). It starts with `/` and has no query, so a
   * versioned base such as `https://example.test/openai/v1` + `/chat/completions` can be written. Unused by the `vertex` variant.
   */
  pathOverride?: string;
  /**
   * `vertex`: Claude on Google Cloud. `address` is the models collection (`.../publishers/anthropic/models`); the call goes to `<address>/<model>:rawPredict` (or
   * `:streamRawPredict` when streaming), the model leaves the body and `anthropic_version` enters it. Only the messages format has it.
   */
  variant?: "vertex";
  capabilities: ModelFormatCapabilities;
}

/**
 * One model's price. A price of zero would let a task budget pass any call, so it is refused unless the plug-in says the model is free (`free: true`, and then both prices are zero).
 */
export interface ModelProviderModelPrice extends ModelPrice {
  free?: boolean;
}

/** Prices per million tokens, keyed by the provider's own model id. The proxy prices a call as `<provider id>/<model id>`. */
export interface ModelProviderPrices {
  currency: string;
  models: Readonly<Record<string, ModelProviderModelPrice>>;
}

/** The adapter a `model-provider` plug-in registers. Its `kind` is the provider id (the registry name), as for a code host. */
export interface ModelProviderAdapter {
  readonly kind: string;
  /** What people read: "Anthropic", "Company gateway". */
  readonly name: string;
  /** Where the provider is: `https://host[:port][/base]`, no query. Cloud accepts only addresses an administrator approved (docs/ports.md). */
  readonly address: string;
  readonly signIn: ModelSignIn;
  /** The formats it speaks. The first is the one a model uses unless the owner's `model` setting names another. */
  readonly formats: readonly [ModelProviderFormat, ...ModelProviderFormat[]];
  /** The model a task step uses when the owner names none (a provider without one is chosen only by the owner's `model` setting). */
  readonly defaultModel?: string;
  /** What a call costs. Absent: the provider's models are unpriced (usage is recorded as unknown and a task budget cannot be held). */
  readonly prices?: ModelProviderPrices;
  /**
   * The credential for `aws-sigv4`, `google-oauth` and `microsoft-entra`, resolved when a call is made (a role's temporary credentials, a refreshed token). The key store's entry for this
   * provider, when there is one, WINS: an explicit entry the owner made is never overridden by a session the shell happens to have. `credential()` is used when the key store has none.
   * The value is a `SecretValue` and goes nowhere but into the signed call. It may throw; the proxy answers a fixed sentence.
   */
  readonly credential?: () => Promise<SecretValue | undefined>;
  /** A fixed sentence (never a secret) saying why the last `credential()` gave nothing: "AWS credential module missing", "the AWS profile could not be used". Shown to the owner. */
  readonly credentialProblem?: () => string | undefined;
}

// ---- Checking a provider ----

const HEADER_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;
/** Headers a sign-in may never use: the proxy sets or refuses them itself (`bearer-key` is the way to send Authorization). */
const FORBIDDEN_SIGN_IN_HEADERS: ReadonlySet<string> = new Set([
  "authorization", "proxy-authorization", "host", "content-length", "content-type", "accept", "connection", "transfer-encoding", "upgrade", "te", "trailer", "user-agent", "cookie",
  "anthropic-version", "anthropic-beta", "openai-organization", "openai-project", "x-api-key-override",
]);
const AWS_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@~-]{0,199}$/u;

const CapabilitiesSchema = z.object({
  forcedToolChoice: z.boolean(),
  parallelToolCalls: z.boolean(),
  reasoning: z.enum(["none", "effort", "thinking"]),
  reasoningReturned: z.boolean(),
  promptCaching: z.boolean(),
  streamUsage: z.boolean(),
}).strict();

const FormatSchema = z.object({
  format: z.enum(MODEL_REQUEST_FORMATS),
  pathOverride: z.string().max(200).regex(/^\/[A-Za-z0-9._~\-/]*$/u, "a path starts with / and holds plain characters (no query)").refine((path) => !path.split("/").some((part) => part === ".."), "a path has no ..").optional(),
  variant: z.literal("vertex").optional(),
  capabilities: CapabilitiesSchema,
}).strict();

const SignInSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bearer-key") }).strict(),
  z.object({
    kind: z.literal("named-header"),
    header: z.string().regex(HEADER_NAME, "a header name is lower-case letters, digits and hyphens").refine((name) => !FORBIDDEN_SIGN_IN_HEADERS.has(name) && !name.startsWith("x-litellm-") && !name.startsWith("x-rovara-"), "that header is set by the proxy"),
  }).strict(),
  z.object({ kind: z.literal("aws-sigv4"), region: z.string().regex(AWS_NAME), service: z.string().regex(AWS_NAME) }).strict(),
  z.object({ kind: z.literal("google-oauth") }).strict(),
  z.object({ kind: z.literal("microsoft-entra"), scope: z.string().min(1).max(200).regex(/^[A-Za-z0-9:/._-]+$/u) }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);

const PriceSchema = z.object({
  inputMicrosPerMillionTokens: z.number().finite().nonnegative(),
  outputMicrosPerMillionTokens: z.number().finite().nonnegative(),
  cacheReadMicrosPerMillionTokens: z.number().finite().nonnegative().optional(),
  cacheWriteMicrosPerMillionTokens: z.number().finite().nonnegative().optional(),
  free: z.boolean().optional(),
}).strict().superRefine((price, context) => {
  const zero = price.inputMicrosPerMillionTokens === 0 || price.outputMicrosPerMillionTokens === 0;
  if (price.free === true) {
    const prices = [price.inputMicrosPerMillionTokens, price.outputMicrosPerMillionTokens, price.cacheReadMicrosPerMillionTokens ?? 0, price.cacheWriteMicrosPerMillionTokens ?? 0];
    if (prices.some((value) => value !== 0)) context.addIssue({ code: "custom", message: "a model marked free has every price 0" });
  } else if (zero) {
    context.addIssue({ code: "custom", message: "a price of 0 would let a task budget pass any call; set the price, or mark the model free (free: true)" });
  }
});

const PricesObjectSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/u),
  models: z.record(z.string().regex(MODEL_ID), PriceSchema),
}).strict();
/** The price table of a provider, checked. (Zod reads an omitted optional number as `number | undefined`; the cast restores the exact shape the port declares.) */
export const ModelProviderPricesSchema = PricesObjectSchema.transform((prices) => prices as ModelProviderPrices);

/** The data part of a provider. `credential` is a function and is checked by its type. */
export const ModelProviderDataSchema = z.object({
  kind: z.string().regex(MODEL_PROVIDER_ID_PATTERN, "a provider id is lower-case letters, digits and hyphens, starting with a letter"),
  name: z.string().min(1).max(80),
  address: z.string().min(1).max(500),
  signIn: SignInSchema,
  formats: z.array(FormatSchema).min(1).max(3),
  defaultModel: z.string().regex(MODEL_ID).optional(),
  prices: ModelProviderPricesSchema.optional(),
}).strict();

/** True for the addresses of this computer, the only ones that may be plain `http`. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(host);
}

/**
 * Why a provider address is refused, or undefined when it is fine: `https` with a host, no sign-in data in the address, no query or fragment. Plain `http` only for this
 * computer (a local model server). Cloud also requires an administrator to approve the address; that rule is Cloud's.
 */
export function modelProviderAddressProblem(address: string): string | undefined {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return "the address is not a URL";
  }
  if (url.username !== "" || url.password !== "") return "the address must not hold a user name or password";
  if (url.search !== "" || url.hash !== "" || address.includes("?") || address.includes("#")) return "the address must not hold a query or a fragment";
  if (url.protocol === "https:") return url.hostname === "" ? "the address has no host" : undefined;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return undefined;
  return "the address must be https (plain http only for this computer)";
}

/**
 * Provider ids that name something else Rovara reads a secret for (the code host's token is kept in the same key file, under `github`). A model provider with one of these ids would be handed
 * that secret as a model key, so it is refused.
 */
export const MODEL_PROVIDER_RESERVED_IDS: readonly string[] = ["github", "linear", "slack", "jira", "gitlab", "bitbucket", "rovara"];

/** Whether an AWS host is one a SigV4 signature may be sent to: an https `*.amazonaws.com` (or `.amazonaws.com.cn`) name that has the signing region as a label. */
export function awsHostProblem(address: string, region: string): string | undefined {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return "the address is not a URL";
  }
  if (url.protocol !== "https:") return "an AWS sign-in is sent to https only";
  const host = url.hostname.toLowerCase();
  if (!host.endsWith(".amazonaws.com") && !host.endsWith(".amazonaws.com.cn")) return "an AWS sign-in is sent only to an address ending in .amazonaws.com";
  if (!host.split(".").includes(region)) return "the address must be in the region the call is signed for";
  return undefined;
}

export class ModelProviderError extends Error {
  constructor(readonly providerId: string, message: string) {
    super(`model provider ${providerId.slice(0, 40)}: ${message}`);
    this.name = "ModelProviderError";
  }
}

/** Refuses a provider that is not well formed; returns it. The message names the provider and the rule, never a secret. */
export function assertModelProvider(provider: ModelProviderAdapter): ModelProviderAdapter {
  // `credential` is a function; the rest is data and is checked as such.
  const data: Record<string, unknown> = { ...provider };
  delete data.credential;
  delete data.credentialProblem;
  const parsed = ModelProviderDataSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ModelProviderError(String(provider.kind), `${issue?.path.join(".") ?? "provider"}: ${issue?.message ?? "not valid"}`);
  }
  const problem = modelProviderAddressProblem(provider.address);
  if (problem !== undefined) throw new ModelProviderError(provider.kind, problem);
  if (MODEL_PROVIDER_RESERVED_IDS.includes(provider.kind)) throw new ModelProviderError(provider.kind, "that id belongs to another part of Rovara; pick another provider id");
  if (provider.signIn.kind === "aws-sigv4") {
    const aws = awsHostProblem(provider.address, provider.signIn.region);
    if (aws !== undefined) throw new ModelProviderError(provider.kind, aws);
  }
  const seen = new Set<string>();
  for (const entry of provider.formats) {
    if (seen.has(entry.format)) throw new ModelProviderError(provider.kind, `the format ${entry.format} is listed twice`);
    seen.add(entry.format);
    if (entry.variant === "vertex" && entry.format !== "anthropic-messages") throw new ModelProviderError(provider.kind, "the vertex variant belongs to the anthropic-messages format");
    if (entry.variant === "vertex" && entry.pathOverride !== undefined) throw new ModelProviderError(provider.kind, "the vertex variant builds its own path");
  }
  if (provider.signIn.kind === "none" && !isLoopbackHost(new URL(provider.address).hostname)) {
    // No sign-in is for a model on this computer. A remote address with no sign-in would send every prompt, unsigned, to anyone who answers there.
    throw new ModelProviderError(provider.kind, "sign-in kind none is for an address on this computer; use a key for a remote address");
  }
  return provider;
}

/** The format entry a model uses: the one the owner named, else the provider's first. */
export function providerFormat(provider: ModelProviderAdapter, format?: ModelRequestFormat): ModelProviderFormat | undefined {
  return format === undefined ? provider.formats[0] : provider.formats.find((entry) => entry.format === format);
}

/** The price rows of providers, keyed `<provider id>/<model id>` as the metering port reads them. Providers with no prices add none. A second currency is refused (one budget is in one currency). */
export function modelPriceRows(providers: readonly ModelProviderAdapter[]): { currency: string | undefined; models: Record<string, ModelPrice> } {
  let currency: string | undefined;
  const models: Record<string, ModelPrice> = {};
  for (const provider of providers) {
    if (provider.prices === undefined) continue;
    if (currency !== undefined && currency !== provider.prices.currency) throw new ModelProviderError(provider.kind, `prices are in ${provider.prices.currency}, another provider's are in ${currency}`);
    currency = provider.prices.currency;
    for (const [model, price] of Object.entries(provider.prices.models)) {
      // The `free` mark is for the check at load; the metering port reads the four prices only.
      models[`${provider.kind}/${model}`] = { inputMicrosPerMillionTokens: price.inputMicrosPerMillionTokens, outputMicrosPerMillionTokens: price.outputMicrosPerMillionTokens,
        ...(price.cacheReadMicrosPerMillionTokens === undefined ? {} : { cacheReadMicrosPerMillionTokens: price.cacheReadMicrosPerMillionTokens }),
        ...(price.cacheWriteMicrosPerMillionTokens === undefined ? {} : { cacheWriteMicrosPerMillionTokens: price.cacheWriteMicrosPerMillionTokens }) };
    }
  }
  return { currency, models };
}
