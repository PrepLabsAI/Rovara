// TE-F1a (release 0.5.19; DECISIONS 150, 157, 163b): the auth schemes and the model-egress row. PURE: strict zod, no network, no clock, no randomness.
//
// DEPENDS ON TE-F0a (PR #519, `model-catalog.ts`): the catalog row is F0a's and is used as it is (`ModelCatalogRow`, `ModelCatalogRowSchema`, `ModelFamily`, `CompanyGatewayRow`). A model-egress row is that catalog row PLUS what
// the key-injecting proxy needs and the catalog does not carry: how the one real credential is added (`scheme`), the Azure deployment, what a call is priced at, and the default output reservation. Nothing here copies the
// catalog's redirect, streaming or error fields. A company gateway row (F0a's `CompanyGatewayRow`) becomes an egress row with `gatewayEgressRow`.
import { z } from "zod";
import { ModelCatalogRowSchema, type CompanyGatewayRow, type ModelCatalogRow, type ModelFamily } from "../model-catalog.js";

/** How the one real credential is added to a call. `sigv4` is a type only: not built (DECISIONS 163b D8); a row that uses it answers the not-run sentence below. */
export const MODEL_EGRESS_SCHEMES = [
  "bearer",
  "header:x-goog-api-key",
  "header:x-api-key",
  "header:api-key",
  "query:key",
  "gcp-oauth:federation",
  "gcp-oauth:key-file",
  "sigv4",
] as const;
export const ModelEgressSchemeSchema = z.enum(MODEL_EGRESS_SCHEMES);
export type ModelEgressScheme = z.infer<typeof ModelEgressSchemeSchema>;

export const SIGV4_NOT_RUN_SENTENCE = "not run: Bedrock real calls need the AWS account connection (TE-F6)";

/** The protocol families are the catalog's (F0a). */
export type ModelEgressFamily = ModelFamily;

/** A scheme whose secret is a token minted per company (Google OAuth), not a stored key: the adapter mints it, the core only places it. */
export const isTokenScheme = (scheme: ModelEgressScheme): boolean => scheme === "gcp-oauth:federation" || scheme === "gcp-oauth:key-file";

const PRICE_MICROS = z.number().int().min(0).max(1_000_000_000);
/** Micro-dollars per million tokens (so $3.00 per million tokens is 3000000): whole numbers all the way, no floating-point money. */
export const ModelEgressPriceRatesSchema = z.object({ inputMicrosPerMTok: PRICE_MICROS, outputMicrosPerMTok: PRICE_MICROS }).strict();
export type ModelEgressPriceRates = z.infer<typeof ModelEgressPriceRatesSchema>;
export const ModelEgressPriceSchema = z.object({ model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u), inputMicrosPerMTok: PRICE_MICROS, outputMicrosPerMTok: PRICE_MICROS }).strict();

/** An Azure OpenAI row's deployment and API version, as data: the path and the one `api-version` a call may carry. */
export const ModelEgressAzureSchema = z
  .object({ deployment: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u), apiVersion: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:-preview)?$/u) })
  .strict();

/** The fields a model-egress row adds to a catalog row. */
export const ModelEgressExtraSchema = z
  .object({
    scheme: ModelEgressSchemeSchema,
    /** What a call reserves for its answer when the request names no maximum. */
    defaultMaxOutputTokens: z.number().int().min(1).max(10_000_000),
    prices: z.array(ModelEgressPriceSchema).max(256),
    /** What a model with no price of its own is reserved at. Absent: the ceiling in `cost.ts`. */
    fallbackPrice: ModelEgressPriceRatesSchema.optional(),
    azure: ModelEgressAzureSchema.optional(),
    /** What a request that names a file or cached content reserves as input (tokens). Absent: `DEFAULT_EXTERNAL_INPUT_RESERVE_TOKENS`. */
    externalInputReserveTokens: z.number().int().min(1).max(100_000_000).optional(),
    /** The field a chat-completions maximum is written in when the proxy sets one. Absent: `max_completion_tokens` for the `openai` and `azure-openai` rows, `max_tokens` for every other (see `maxOutputFieldOf`). */
    maxOutputField: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
  })
  .strict();
export type ModelEgressExtra = z.infer<typeof ModelEgressExtraSchema>;

/** What the routing rules read of the catalog row: its id, hosts, family and fixed path prefix. A gateway row fits as well as a built-in one. */
export type ModelEgressCatalogPart = Pick<ModelCatalogRow, "id" | "hosts" | "hostSuffixes" | "family" | "pathPrefix">;
export type ModelEgressRow = ModelEgressCatalogPart & ModelEgressExtra;

const EXTRA_KEYS: readonly string[] = ["scheme", "defaultMaxOutputTokens", "prices", "fallbackPrice", "azure", "externalInputReserveTokens", "maxOutputField"];

export type ModelEgressRowParse = { readonly ok: true; readonly row: ModelEgressRow; readonly catalog: ModelCatalogRow } | { readonly ok: false; readonly reason: string };

/** Whether the catalog row says the provider takes this scheme (`query:key` is the legacy Gemini REST form, which the catalog does not list: allowed for the Gemini and Vertex families only). */
export function catalogAllowsScheme(auth: ModelCatalogRow["auth"], family: ModelFamily, scheme: ModelEgressScheme): boolean {
  if (scheme === "query:key") return family === "gemini" || family === "vertex";
  return auth.some((entry) => {
    if (entry.scheme === "bearer") return scheme === "bearer";
    if (entry.scheme === "header") return scheme === `header:${entry.name}`;
    if (entry.scheme === "sigv4") return scheme === "sigv4";
    return isTokenScheme(scheme);
  });
}

/**
 * One model-egress row from untrusted JSON: the catalog's keys are parsed by F0a's own schema, the extra keys by `ModelEgressExtraSchema`, and an unknown key is refused. The scheme must be one the catalog row lists (a Google
 * token scheme for `gcp_oauth`), federation versus key file being the source record's choice. The reason is a short fixed phrase, never the refused text.
 */
export function parseModelEgressRow(input: unknown): ModelEgressRowParse {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, reason: "a row is an object" };
  const catalogPart: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const extraPart: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    const value = (input as Record<string, unknown>)[key];
    Object.defineProperty(EXTRA_KEYS.includes(key) ? extraPart : catalogPart, key, { value, enumerable: true, writable: true, configurable: true });
  }
  const catalog = ModelCatalogRowSchema.safeParse(catalogPart);
  if (!catalog.success) return { ok: false, reason: "the catalog part of the row is not valid" };
  const extra = ModelEgressExtraSchema.safeParse(extraPart);
  if (!extra.success) return { ok: false, reason: "the egress part of the row is not valid" };
  const problem = egressRowProblem(catalog.data, extra.data);
  return problem === undefined ? { ok: true, row: { ...catalog.data, ...extra.data }, catalog: catalog.data } : { ok: false, reason: problem };
}

function egressRowProblem(catalog: ModelCatalogRow, extra: ModelEgressExtra): string | undefined {
  if (!catalogAllowsScheme(catalog.auth, catalog.family, extra.scheme)) return "the scheme is not one the catalog row lists";
  if ((extra.scheme === "sigv4") !== (catalog.family === "bedrock")) return "sigv4 is a bedrock row's, and a bedrock row uses nothing else";
  if (isTokenScheme(extra.scheme) && catalog.family !== "vertex") return "a Google token scheme is a vertex row's";
  if (new Set(extra.prices.map((price) => price.model)).size !== extra.prices.length) return "a model is priced once";
  if (extra.azure !== undefined && (catalog.family !== "openai_compatible" || extra.scheme !== "header:api-key")) return "an Azure row is an openai_compatible row that sends api-key";
  return undefined;
}

/** A company gateway row as an egress row: its one host, its family and prefix, with the extras the source record carries. The scheme must be the gateway's own (`bearer`, or its one named header). */
export function gatewayEgressRow(gateway: CompanyGatewayRow, extra: Omit<ModelEgressExtra, "scheme">): ModelEgressRow | undefined {
  const scheme: ModelEgressScheme = gateway.auth.scheme === "bearer" ? "bearer" : `header:${gateway.auth.name}` as ModelEgressScheme;
  const checked = ModelEgressExtraSchema.safeParse({ ...extra, scheme });
  if (!checked.success) return undefined;
  return { id: gateway.id, hosts: [gateway.host], hostSuffixes: [], family: gateway.family, pathPrefix: gateway.pathPrefix, ...checked.data };
}

/** What the adapter knows about the connected source that the row cannot say: a Vertex source's project and location. Comes from the adapter's own record, never from a frame. */
export const ModelEgressConnectionSchema = z
  .object({
    /** For a row that names only a domain suffix (Azure OpenAI): the connected resource's own host. */
    host: z.string().max(253).optional(),
    vertex: z.object({ project: z.string().regex(/^[a-z0-9][a-z0-9-]{3,60}$/u), location: z.string().regex(/^(?:global|[a-z]{2,}(?:-[a-z]+[0-9]+)?)$/u) }).strict().optional(),
  })
  .strict();
export type ModelEgressConnection = z.infer<typeof ModelEgressConnectionSchema>;
