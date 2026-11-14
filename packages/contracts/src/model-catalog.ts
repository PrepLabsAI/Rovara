// TE-F0a (M2, release 0.5.19; DECISIONS 157, 158, 163b D9): the provider-row schema for the model catcher, and the company-gateway row an admin adds once at setup. Pure contract: strict zod, no Node module, no network.
//
// What a row says: which hosts a model provider is reached at, which protocol family it speaks, how a call is authenticated, how customer code is redirected to the helper (an environment variable, one SDK option, DNS in the
// sealed network, or "none": the client cannot be redirected), how a streamed answer is framed, and the ids of the error envelopes the failure pack (TE-F2) will fill. The built-in rows are in `model-catalog-rows.ts`; the stable
// digest of a row set and the unsigned parse are in `model-catalog-digest.ts`.
//
// This file is NOT Rovara's own agent-model store (`model-providers.ts`, `model-sources.ts`, `e2e-model-*.ts`, `ports/model-keys.ts`): DECISIONS 157 keeps the customer product's model access a separate store, and nothing here
// is read by those files.
//
// Rules the schema carries so no builder has to remember them: unknown keys are refused at every level (`.strict()`; a `__proto__` key is an unknown key and never reaches an object); every list is bounded; every host is an
// exact lowercase public DNS name (no scheme, port, path, wildcard, userinfo or IP address); a row serves a family with one host once (routing is never ambiguous); `sigv4` is a Bedrock row's and only that row's, and a Bedrock
// row is never served by the helper (it routes to the local AWS front, which 9d owns); a company gateway is a public HTTPS name, never an address, never `localhost` (D9).
import { z } from "zod";

export const MODEL_CATALOG_SCHEMA_VERSION = 1;
export const MODEL_FAMILIES = ["openai_compatible", "anthropic_messages", "gemini", "vertex", "bedrock", "cohere"] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];
export const MODEL_ROW_KINDS = ["provider", "hosted_gateway"] as const;
export const MODEL_STREAMING_FORMATS = ["sse", "aws_event_stream", "json_array", "json_lines"] as const;
export type ModelStreamingFormat = (typeof MODEL_STREAMING_FORMATS)[number];
export const MODEL_ERROR_SHAPE_KEYS = ["rateLimit", "tokenLimit", "refusal", "badToolJson", "cutOffStream"] as const;
export const COMPANY_GATEWAY_MAX_PER_PROJECT = 20;
/** The families a company gateway may speak: the API shape it exposes. Vertex (Google OAuth) and Bedrock (SigV4) are not a header-key gateway. */
export const COMPANY_GATEWAY_FAMILIES = ["openai_compatible", "anthropic_messages", "gemini", "cohere"] as const;

/** The fixed sentences the evidence uses (the words are code, never data). */
export const NONE_REDIRECT_SENTENCE = "not run: client cannot be redirected";

const MODEL_ROWS_MAX = 64;
const HOSTS_MAX = 256; // Vertex includes exact locational, REP and mTLS names.
const NOTES_MAX = 20;
const NOTE_MAX_CHARS = 300;
export const MODEL_HOST_MAX_CHARS = 253;

// ---- one host

export const MODEL_HOST_REFUSAL_CODES = [
  "empty", "too_long", "scheme", "userinfo", "wildcard", "path", "query", "bad_characters", "port", "ip_literal", "not_lowercase", "bad_label", "localhost", "not_public",
] as const;
export type ModelHostRefusalCode = (typeof MODEL_HOST_REFUSAL_CODES)[number];

/** Names that look public but are not: reserved or private-use suffixes, and the wildcard-DNS services that turn an address into a name. A best-effort list; the proxy still resolves the name and refuses a private answer (F1). */
const NOT_PUBLIC_SUFFIXES = [
  "local", "internal", "localdomain", "lan", "intranet", "private", "corp", "home", "home.arpa", "invalid", "test", "example", "onion",
  "nip.io", "sslip.io", "xip.io", "localtest.me", "lvh.me", "traefik.me",
] as const;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const NUMERIC_ADDRESS = /^(?:0x[0-9a-f]*|[0-9]+)(?:\.(?:0x[0-9a-f]*|[0-9]+)){0,3}$/u;

/**
 * Whether the text is one exact, lowercase, public DNS host name, with a fixed refusal code when it is not. Never throws, never echoes the input, and looks at the length first so a huge input costs nothing.
 * Order of the checks decides the code: a URL is "scheme", an address in any spelling (dotted, integer, hex, bracketed or bare IPv6, a name whose last label has no letter) is "ip_literal".
 */
export function checkModelHost(raw: unknown): { ok: true; host: string } | { ok: false; code: ModelHostRefusalCode } {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, code: "empty" };
  if (raw.length > MODEL_HOST_MAX_CHARS) return { ok: false, code: "too_long" };
  if (raw.includes("://")) return { ok: false, code: "scheme" };
  if (raw.includes("@")) return { ok: false, code: "userinfo" };
  if (raw.includes("*")) return { ok: false, code: "wildcard" };
  if (/[/\\]/u.test(raw)) return { ok: false, code: "path" };
  if (/[?#]/u.test(raw)) return { ok: false, code: "query" };
  if (!/^[\x21-\x7e]+$/u.test(raw)) return { ok: false, code: "bad_characters" };
  if (raw.startsWith("[")) return { ok: false, code: "ip_literal" };
  if (raw.includes(":")) return /^[^:]+:[0-9]{1,6}$/u.test(raw) ? { ok: false, code: "port" } : { ok: false, code: "ip_literal" };
  if (raw !== raw.toLowerCase()) return { ok: false, code: "not_lowercase" };
  if (raw === "localhost" || raw.endsWith(".localhost")) return { ok: false, code: "localhost" };
  // A trailing dot is a different spelling of the same name: judge the name first (an address is an address), then refuse the dot.
  const bare = raw.endsWith(".") ? raw.slice(0, -1) : raw;
  const labels = bare.split(".");
  if (NUMERIC_ADDRESS.test(bare) || !/[a-z]/u.test(labels[labels.length - 1] ?? "")) return { ok: false, code: "ip_literal" };
  if (bare !== raw) return { ok: false, code: "bad_label" };
  if (labels.some((label) => !LABEL.test(label) || /^0x[0-9a-f]*$/u.test(label))) return { ok: false, code: "bad_label" };
  if (labels.length < 2) return { ok: false, code: "not_public" };
  if (NOT_PUBLIC_SUFFIXES.some((suffix) => raw === suffix || raw.endsWith(`.${suffix}`))) return { ok: false, code: "not_public" };
  return { ok: true, host: raw };
}

/** A host as a schema: the failure message IS the fixed refusal code (so a caller can read it back without parsing words). */
export const ModelHostSchema = z.string().superRefine((value, context) => {
  const checked = checkModelHost(value);
  if (!checked.ok) context.addIssue({ code: "custom", message: checked.code });
});

// ---- small pieces

const RowId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u);
/** Printable ASCII only: no control, hidden or variation-selector character can ride in a label or a note. */
const printable = (max: number) => z.string().min(1).max(max).regex(/^[\x20-\x7e]+$/u);
const Note = printable(NOTE_MAX_CHARS);
/**
 * The environment variables a row may name, as an allow-list: the redirect (base-URL) variables of the SDKs the rows cover, the dummy-key variables and the metadata-server variables. NOT a pattern: a variable that changes
 * how a process loads or runs code (LD_PRELOAD, NODE_OPTIONS, BASH_ENV, PATH, a proxy variable) can never be written into the environment of a customer's test run by a row.
 */
export const MODEL_REDIRECT_ENV_NAMES = [
  "GOOGLE_GEMINI_BASE_URL", "GOOGLE_VERTEX_BASE_URL", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_API_KEY", "GEMINI_API_KEY", "GCE_METADATA_HOST", "GCE_METADATA_IP",
  "OPENAI_BASE_URL", "OPENAI_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "CO_API_URL", "CO_API_KEY", "AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_KEY",
  "GROQ_BASE_URL", "GROQ_API_KEY", "TOGETHER_BASE_URL", "TOGETHER_API_KEY", "MISTRAL_API_KEY",
] as const;
const EnvName = z.enum(MODEL_REDIRECT_ENV_NAMES);
const PathPrefix = z.string().max(120).regex(/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+){0,7}$/u).refine((value) => !value.split("/").some((segment) => /^\.+$/u.test(segment)), "a plain path with no dot segment");
const ShapeId = z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/u);

// Hop-by-hop headers (the transport owns them), and headers that spoof where a request came from or how a server should treat it. `authorization` is the `bearer` scheme, never a named header.
const FORBIDDEN_HEADERS = new Set([
  "authorization", "proxy-authorization", "proxy-connection", "host", "content-length", "content-type", "content-encoding", "transfer-encoding", "connection", "keep-alive", "upgrade", "te", "trailer", "expect", "cookie", "set-cookie",
  "forwarded", "via", "accept", "user-agent", "origin", "referer", "range", "x-real-ip", "x-client-ip", "true-client-ip", "cf-connecting-ip", "x-http-method", "x-http-method-override", "x-method-override",
  "x-original-url", "x-rewrite-url", "x-original-host",
]);
/** An authentication header name: a lowercase token that is not one the transport or the proxy owns (`authorization` is the `bearer` scheme). */
export const AuthHeaderNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/u)
  .refine((name) => !FORBIDDEN_HEADERS.has(name) && !name.startsWith("proxy-") && !name.startsWith("x-forwarded-") && !name.startsWith("x-amz-"), "a header the transport or the proxy owns");

export const ModelAuthSchema = z.discriminatedUnion("scheme", [
  z.object({ scheme: z.literal("bearer") }).strict(),
  z.object({ scheme: z.literal("header"), name: AuthHeaderNameSchema }).strict(),
  z.object({ scheme: z.literal("sigv4") }).strict(),
  z.object({ scheme: z.literal("gcp_oauth") }).strict(),
]);
export type ModelAuth = z.infer<typeof ModelAuthSchema>;
/** A company gateway authenticates with a bearer token or one named header; nothing else. */
export const GatewayAuthSchema = z.discriminatedUnion("scheme", [z.object({ scheme: z.literal("bearer") }).strict(), z.object({ scheme: z.literal("header"), name: AuthHeaderNameSchema }).strict()]);

const redirectCommon = { client: printable(80), verified: z.boolean(), note: Note.optional() };
export const ModelRedirectSchema = z.discriminatedUnion("kind", [
  /** `names`: the variables that carry the base URL (any one redirects the client); `companion`: other variables the client needs set (a metadata-server host, a project). */
  z.object({ kind: z.literal("env_var"), ...redirectCommon, names: z.array(EnvName).min(1).max(4), companion: z.array(EnvName).max(8) }).strict(),
  /** One configuration line the readiness run proposes; `needsRestTransport` when the client's default transport (gRPC) cannot be redirected to plain HTTP. */
  z.object({ kind: z.literal("sdk_option"), ...redirectCommon, option: printable(120), needsRestTransport: z.boolean() }).strict(),
  z.object({ kind: z.literal("dns_in_sealed_network"), ...redirectCommon }).strict(),
  /** The client cannot be redirected: the evidence says `NONE_REDIRECT_SENTENCE`. */
  z.object({ kind: z.literal("none"), ...redirectCommon }).strict(),
]);
export type ModelRedirect = z.infer<typeof ModelRedirectSchema>;

/** The ids of the error envelopes TE-F2 will fill for this row; the row names them, F2 owns their bodies. */
export const ModelErrorShapesSchema = z.object({ rateLimit: ShapeId, tokenLimit: ShapeId, refusal: ShapeId, badToolJson: ShapeId, cutOffStream: ShapeId }).strict();

const unique = <T>(list: readonly T[]): boolean => new Set(list).size === list.length;

// ---- one row

export const ModelCatalogRowSchema = z
  .object({
    id: RowId,
    kind: z.enum(MODEL_ROW_KINDS),
    /** Exact lowercase host names the provider is reached at (never a wildcard: a regional host is listed by name). */
    hosts: z.array(ModelHostSchema).max(HOSTS_MAX),
    /** Domains whose every subdomain is this provider's (Azure OpenAI: a customer's own `<resource>.openai.azure.com`). A hosts file cannot hold a pattern, so these are for the DNS-level block and for the finder; at least two labels. */
    hostSuffixes: z.array(ModelHostSchema).max(8).default([]),
    /** Only DEC 174's exact Google token hosts: reserved against gateway claims, never blocked or served as model hosts. No model endpoint may be hidden here. */
    authHosts: z.array(ModelHostSchema.refine((host) => ["oauth2.googleapis.com", "sts.googleapis.com", "iamcredentials.googleapis.com"].includes(host), "auth_host_not_allowed")).max(8),
    family: z.enum(MODEL_FAMILIES),
    /** The fixed path before the API's own path, for a row that shares a host with another (`/v1beta/openai`). */
    pathPrefix: PathPrefix.optional(),
    /** The ways a key is sent; a client may use any one. */
    auth: z.array(ModelAuthSchema).min(1).max(4),
    /** How each kind of client is pointed at the helper. */
    redirect: z.array(ModelRedirectSchema).min(1).max(16),
    streaming: z.array(z.enum(MODEL_STREAMING_FORMATS)).min(1).max(4),
    errors: ModelErrorShapesSchema,
    /** A Bedrock row is never served by this helper: it routes to the local AWS front. */
    routesTo: z.literal("local_aws_front").optional(),
    /** Plain statements about the row, and every fact its source calls UNVERIFIED, written "UNVERIFIED: ...". */
    notes: z.array(Note).max(NOTES_MAX),
  })
  .strict()
  .superRefine((row, context) => {
    const problem = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", path, message });
    if (!unique(row.hosts)) problem(["hosts"], "a host is listed once");
    if (!unique(row.hostSuffixes)) problem(["hostSuffixes"], "a suffix is listed once");
    if (row.hosts.length + row.hostSuffixes.length === 0) problem(["hosts"], "a row names at least one host or host suffix");
    if (!unique(row.authHosts)) problem(["authHosts"], "a host is listed once");
    if (!unique(row.streaming)) problem(["streaming"], "a format is listed once");
    if (!unique(row.auth.map((auth) => (auth.scheme === "header" ? `header:${auth.name}` : auth.scheme)))) problem(["auth"], "an auth scheme is listed once");
    if ((row.family === "bedrock") !== (row.routesTo === "local_aws_front")) problem(["routesTo"], "a bedrock row routes to the local AWS front, and nothing else does");
    if (row.auth.some((auth) => auth.scheme === "sigv4") && row.family !== "bedrock") problem(["auth"], "sigv4 is a bedrock row's");
    if (row.auth.some((auth) => auth.scheme === "gcp_oauth") && row.family !== "vertex") problem(["auth"], "gcp_oauth is a vertex row's");
  });
export type ModelCatalogRow = z.infer<typeof ModelCatalogRowSchema>;

export const ModelCatalogSchema = z
  .object({
    schemaVersion: z.literal(MODEL_CATALOG_SCHEMA_VERSION),
    /** A new number for every catalog release. */
    revision: z.number().int().min(1),
    rows: z.array(ModelCatalogRowSchema).min(1).max(MODEL_ROWS_MAX),
  })
  .strict()
  .superRefine((catalog, context) => {
    const ids = catalog.rows.map((row) => row.id);
    if (!unique(ids)) context.addIssue({ code: "custom", path: ["rows"], message: "an id is listed once" });
    const pairs = catalog.rows.flatMap((row) => row.hosts.map((host) => `${host}|${row.family}`));
    if (!unique(pairs)) context.addIssue({ code: "custom", path: ["rows"], message: "a host is served by one row per family" });
  });
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>;

// ---- the company gateway row

/** A company's own gateway (a LiteLLM proxy, an internal gateway): one public HTTPS host an admin adds once at setup. Authorization to add one is Cloud's later lane; this is the shape only. */
export const CompanyGatewayRowSchema = z
  .object({
    id: RowId,
    host: ModelHostSchema,
    /** The API shape the gateway speaks, not the model behind it: Gemini through OpenRouter is `openai_compatible`. */
    family: z.enum(COMPANY_GATEWAY_FAMILIES),
    auth: GatewayAuthSchema,
    /** The gateway's fixed path before the API's own (`/litellm`). */
    pathPrefix: PathPrefix.optional(),
  })
  .strict();
export type CompanyGatewayRow = z.infer<typeof CompanyGatewayRowSchema>;

export const GATEWAY_REFUSAL_CODES = [...MODEL_HOST_REFUSAL_CODES, "too_many", "invalid_row", "duplicate_id", "duplicate_host", "confusable_host"] as const;
export type GatewayRefusalCode = (typeof GATEWAY_REFUSAL_CODES)[number];

/** The words for each refusal, fixed in code: they never carry the text that was refused. */
export const GATEWAY_REFUSAL_WORDS: Record<GatewayRefusalCode, string> = {
  empty: "The gateway host is empty.",
  too_long: "The gateway host is too long.",
  scheme: "Enter the host name only, without https://.",
  userinfo: "The gateway host cannot hold a user name or password.",
  wildcard: "The gateway host cannot hold a wildcard.",
  path: "Enter the host name only, without a path.",
  query: "Enter the host name only, without a query.",
  bad_characters: "The gateway host holds a character a host name cannot hold.",
  port: "The gateway must use the standard HTTPS port: enter the host name without a port.",
  ip_literal: "The gateway must be a public host name, not an IP address.",
  not_lowercase: "Enter the gateway host in lowercase.",
  bad_label: "The gateway host is not a valid DNS name.",
  localhost: "The gateway cannot be localhost.",
  not_public: "The gateway must be a public host name that Rovara can reach over HTTPS.",
  too_many: `A project can have at most ${String(COMPANY_GATEWAY_MAX_PER_PROJECT)} gateways.`,
  invalid_row: "The gateway entry is not valid.",
  duplicate_id: "Two gateways, or a gateway and a built-in provider, share one id.",
  duplicate_host: "Two gateways use the same host and API shape.",
  confusable_host: "This host belongs to a built-in provider that speaks a different API shape, or to another gateway that does.",
};

export interface GatewayIssue {
  readonly index: number;
  readonly code: GatewayRefusalCode;
  readonly message: string;
}
export type GatewayRowsCheck = { ok: true; rows: CompanyGatewayRow[] } | { ok: false; issues: GatewayIssue[] };

const issue = (index: number, code: GatewayRefusalCode): GatewayIssue => ({ index, code, message: GATEWAY_REFUSAL_WORDS[code] });

/**
 * A project's gateway rows against the built-in rows: at most 20, each one valid, ids unique and never a built-in id, one host in one shape (a host equal to a built-in row's host, or to another gateway's, with a different
 * family is confusable and refused), no address, no `localhost`. Returns fixed codes and fixed words; the refused text is never echoed. Never throws.
 */
export function checkCompanyGatewayRows(input: unknown, builtinRows: readonly (Pick<ModelCatalogRow, "id" | "hosts" | "family"> & { readonly authHosts?: readonly string[]; readonly hostSuffixes?: readonly string[] })[]): GatewayRowsCheck {
  if (!Array.isArray(input)) return { ok: false, issues: [issue(0, "invalid_row")] };
  if (input.length > COMPANY_GATEWAY_MAX_PER_PROJECT) return { ok: false, issues: [issue(COMPANY_GATEWAY_MAX_PER_PROJECT, "too_many")] };
  const issues: GatewayIssue[] = [];
  const rows: CompanyGatewayRow[] = [];
  input.forEach((candidate: unknown, index) => {
    const parsed = CompanyGatewayRowSchema.safeParse(candidate);
    if (parsed.success) {
      rows.push(parsed.data);
      return;
    }
    const hostIssue = parsed.error.issues.find((entry) => entry.path[0] === "host" && (MODEL_HOST_REFUSAL_CODES as readonly string[]).includes(entry.message));
    issues.push(issue(index, hostIssue === undefined ? "invalid_row" : (hostIssue.message as ModelHostRefusalCode)));
  });
  if (issues.length > 0) return { ok: false, issues };
  const builtinIds = new Set(builtinRows.map((row) => row.id));
  const seenIds = new Set<string>();
  const familiesByHost = new Map<string, Set<string>>();
  const addFamily = (host: string, family: string): void => {
    familiesByHost.set(host, new Set([...(familiesByHost.get(host) ?? []), family]));
  };
  // A built-in row's auth hosts (Google's token hosts) are in no gateway's family: a gateway there is always confusable.
  for (const row of builtinRows) {
    for (const host of row.hosts) addFamily(host, row.family);
    for (const host of row.authHosts ?? []) addFamily(host, "auth");
  }
  const suffixFamilies = (host: string): string[] => builtinRows.filter((row) => (row.hostSuffixes ?? []).some((suffix) => host.endsWith(`.${suffix}`))).map((row) => row.family);
  rows.forEach((row, index) => {
    if (builtinIds.has(row.id) || seenIds.has(row.id)) issues.push(issue(index, "duplicate_id"));
    seenIds.add(row.id);
    const viaSuffix = suffixFamilies(row.host);
    const families = viaSuffix.length === 0 && !familiesByHost.has(row.host) ? undefined : new Set([...(familiesByHost.get(row.host) ?? []), ...viaSuffix]);
    if (families !== undefined && !families.has(row.family)) issues.push(issue(index, "confusable_host"));
    else if (families?.has(row.family) === true && rows.slice(0, index).some((earlier) => earlier.host === row.host && earlier.family === row.family)) issues.push(issue(index, "duplicate_host"));
    addFamily(row.host, row.family);
  });
  return issues.length === 0 ? { ok: true, rows } : { ok: false, issues };
}
