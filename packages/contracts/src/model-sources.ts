// Company AI sources (Plan 3 Task 24a): where an org's models can come from besides Rovara's own, the
// shapes a client may send and the server stores, and the launch gates that keep each kind off until its
// real-key checklist passes. The store, the routes and the ChatGPT settings are Task 24b.
import { z } from "zod";
import { ModelSourceIdSchema } from "./agent.js";
import { type ModelSourceId } from "./agent-node.js";
import { ChatGptModelIdSchema } from "./chatgpt.js";
import { ModelIdentifierSchema } from "./models.js";
import { canonicalModelName, legacyAliasModelName, type ModelIdentifier } from "./models-node.js";
import type { OrgId } from "./company-scope.js";

export const ModelSourceKindSchema = z.enum(["rovara", "personal-chatgpt", "anthropic", "openai", "openrouter", "bedrock", "endpoint"]);
export type ModelSourceKind = z.infer<typeof ModelSourceKindSchema>;

/** The kinds an org can add as its own source; `rovara` and `personal-chatgpt` are always there. */
export const CUSTOM_SOURCE_KINDS = ["anthropic", "openai", "openrouter", "bedrock", "endpoint"] as const;
export type CustomSourceKind = (typeof CUSTOM_SOURCE_KINDS)[number];

/**
 * The custom kinds an org can use today. Empty on purpose (human decision): the target is
 * ["anthropic", "openai", "openrouter"], each added by a one-line change only after its real-key checklist
 * passes in the combined final round. `bedrock` waits for Task 37 Step 10 and `endpoint` is not at launch.
 */
export const SOURCE_KINDS_AT_LAUNCH: readonly CustomSourceKind[] = [];

/** The wire formats the model proxy serves (docs/learnings/model-sources-spike.md, question 4). */
export const TRANSPORTS_AT_LAUNCH = ["anthropic-messages", "openai-responses", "openai-completions"] as const;
export type Transport = (typeof TRANSPORTS_AT_LAUNCH)[number];

/**
 * The only requests the model proxy's inference listener forwards (docs/learnings/model-sources-spike.md, question 2a): exact
 * paths, POST only, one per transport. A path with a wildcard would reach the pass-through and management routes.
 */
export const INFERENCE_PATHS = [
  { method: "POST", path: "/v1/messages", transport: "anthropic-messages" },
  { method: "POST", path: "/v1/responses", transport: "openai-responses" },
  { method: "POST", path: "/chat/completions", transport: "openai-completions" },
] as const satisfies ReadonlyArray<{ method: "POST"; path: string; transport: Transport }>;

export const MAX_MODELS_PER_SOURCE = 20;
export const MAX_CUSTOM_SOURCES_PER_ORG = 10;

export interface SourceLaunch {
  kinds?: readonly CustomSourceKind[];
  transports?: readonly string[];
}

/**
 * The refusal for a company source that is not available yet, or undefined when it is. A kind outside the
 * launch list is refused, and so is an endpoint whose `api` is missing or outside the transports. Rovara's own
 * models and a member's ChatGPT plan are not company sources, so they are never refused here. `launch` lets a
 * test (or a build that turns a kind on early) supply its own lists.
 */
export function sourceKindProblem(kind: ModelSourceKind, api?: string, launch: SourceLaunch = {}): string | undefined {
  if (kind === "rovara" || kind === "personal-chatgpt") return undefined;
  const refusal = `${kind} sources aren't available yet`;
  if (!(launch.kinds ?? SOURCE_KINDS_AT_LAUNCH).includes(kind)) return refusal;
  if (kind === "endpoint" && (api === undefined || !(launch.transports ?? TRANSPORTS_AT_LAUNCH).includes(api))) return refusal;
  return undefined;
}

/** The refusal for adding sources to an org that already has `existing` custom ones, when the total would pass the limit. */
export function customSourceLimitProblem(existing: number, adding = 1): string | undefined {
  return existing + adding > MAX_CUSTOM_SOURCES_PER_ORG ? `an organization can have at most ${MAX_CUSTOM_SOURCES_PER_ORG} AI sources` : undefined;
}

/** An IAM role in the org's own AWS account, with no wildcard: the proxy assumes it for Bedrock. */
export const BEDROCK_ROLE_ARN_PATTERN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;
const REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const SOURCE_ID_PATTERN = /^src_[0-9a-z]{20}$/;
const EXTERNAL_ID_PATTERN = /^rovara-org_[0-9a-z]{20}$/;

/** The STS external id the org's trust policy must require: server-set, never sent by a client. */
export function bedrockExternalId(orgId: OrgId): string {
  return `rovara-${orgId}`;
}

/** The Pi catalog provider that serves a kind's models. */
const CATALOG_PROVIDER = {
  anthropic: "anthropic",
  openai: "openai",
  openrouter: "openrouter",
  bedrock: "amazon-bedrock",
} as const;

/**
 * N8: where the secret behind a custom model endpoint lives. A source holds only this reference; the model access function (the one piece of code inside the
 * VPC that already reads the proxy's own secrets) resolves it when it registers or checks the source, and the value is never in a record, a response, a log or a
 * model's context. A reference is a NAME, never an ARN, of the form `rovara/model-endpoints/<orgId>/<host>/<name>`:
 *   - the prefix is the first fence (the function may read secrets under it and nothing else, so a reference cannot name the proxy's master key or another customer secret);
 *   - the org segment ties the secret to its org (an org cannot name another org's secret);
 *   - the host segment ties the secret to the host it is for, so it cannot be sent to another host by changing the address, or by moving it over two saves.
 * `endpointSecretRefProblem` checks the org and host segments against the source; the schema checks the shape.
 */
export const MODEL_ENDPOINT_SECRET_PREFIX = "rovara/model-endpoints/";
// Each name segment is Secrets Manager name characters and not only dots ("." and ".." are never a segment: a name is flat, but a reference that looks like a path climb is refused anyway).
const MODEL_ENDPOINT_SECRET_REF = /^rovara\/model-endpoints\/org_[0-9a-z]{20}\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+\/(?!\.+(?:\/|$))[A-Za-z0-9_+=.@-]+(?:\/(?!\.+(?:\/|$))[A-Za-z0-9_+=.@-]+)*$/;
export const MODEL_ENDPOINT_SECRET_REF_MAX = 200;

/** Whether a string is a model endpoint secret reference (the shape and the length). */
export function isModelEndpointSecretRef(value: string): boolean {
  return value.length <= MODEL_ENDPOINT_SECRET_REF_MAX && MODEL_ENDPOINT_SECRET_REF.test(value);
}

/**
 * The refusal for a secret reference that does not belong to this org or to this address's host, or undefined when it does. The text never repeats the reference.
 * `baseUrl` is the endpoint's address; a reference or address that does not parse is refused.
 */
export function endpointSecretRefProblem(orgId: OrgId, baseUrl: string, keyRef: string): string | undefined {
  if (!isModelEndpointSecretRef(keyRef)) return `must be a secret name of the form ${MODEL_ENDPOINT_SECRET_PREFIX}<organization>/<host>/<name>`;
  const [, , organization, host] = keyRef.split("/");
  if (organization !== orgId) return "names a secret of another organization";
  let hostname: string;
  try { hostname = new URL(baseUrl).hostname.toLowerCase(); } catch { return "needs a valid address to check the secret against"; }
  if (host !== hostname) return "names a secret for another host; a secret is named for the one host it is sent to";
  return undefined;
}

/** The hex digest shape of an endpoint's qualification (`endpointQualificationDigest` in the broker). */
const QUALIFICATION_DIGEST = /^[0-9a-f]{64}$/;

export interface ModelSourceOptions {
  /**
   * N8: whether the `endpoint` kind (a company's own model endpoint, Enterprise only) is part of the schema at all. The broker passes the install's `customModelEndpoint`
   * edition feature, so on Public the kind (and its `keyRef`) is refused by the schema itself. Default true: the pure schema has no edition; the routes and routing gates
   * read the edition and fail closed when they have none.
   */
  customModelEndpoint?: boolean;
  /**
   * Whether Pi's catalog knows a model. Pi's catalogs live in model-runtime, which contracts cannot import, so
   * the broker supplies this (`catalogModel(model) !== undefined`). Without it only the shape is checked.
   */
  isKnownCatalog?: (model: ModelIdentifier) => boolean;
}

/** A name shown on a page and in a terminal: counted in code points, with no control or invisible formatting characters (a label cannot hide or rewrite text around it). */
function displayName(maxCodePoints: number) {
  return z.string().trim().min(1)
    .refine((value) => [...value].length <= maxCodePoints, { message: `must be at most ${String(maxCodePoints)} characters` })
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), { message: "must not hold control or invisible characters" });
}

const LabelSchema = displayName(64);

function catalogSchema(provider: string | undefined, options: ModelSourceOptions) {
  return ModelIdentifierSchema
    .refine((model) => provider === undefined || model.provider === provider, { message: provider === undefined ? "" : `must be a ${provider} catalog model` })
    .refine((model) => options.isKnownCatalog?.(model) ?? true, { message: "must be a model in the catalog" });
}

/** `identities` are the models an entry claims; each position is unique across entries by `legacyAliasModelName` (stored sources must keep reading). */
function modelsSchema<T extends z.ZodType>(model: T, identities: (entry: z.infer<T>) => ModelIdentifier[]) {
  return z.array(model).min(1).max(MAX_MODELS_PER_SOURCE).superRefine((models, context) => {
    const seen: Array<Set<string>> = [];
    for (const [index, entry] of models.entries()) {
      for (const [position, identity] of identities(entry).entries()) {
        const names = (seen[position] ??= new Set<string>());
        const name = legacyAliasModelName(identity);
        if (names.has(name)) context.addIssue({ code: "custom", path: [index], message: "models must be unique" });
        names.add(name);
      }
    }
  });
}

function keyedModels(kind: keyof typeof CATALOG_PROVIDER, options: ModelSourceOptions) {
  return modelsSchema(z.object({ catalog: catalogSchema(CATALOG_PROVIDER[kind], options) }).strict(), (entry) => [entry.catalog]);
}

function inputShapes(options: ModelSourceOptions) {
  const keyed = (kind: "anthropic" | "openai" | "openrouter") => z.object({ kind: z.literal(kind), label: LabelSchema, models: keyedModels(kind, options) }).strict();
  const bedrock = z.object({
    kind: z.literal("bedrock"),
    label: LabelSchema,
    roleArn: z.string().regex(BEDROCK_ROLE_ARN_PATTERN),
    region: z.string().regex(REGION_PATTERN),
    models: keyedModels("bedrock", options),
  }).strict();
  const endpoint = z.object({
    kind: z.literal("endpoint"),
    label: LabelSchema,
    baseUrl: z.url({ protocol: /^https?$/ }).max(2048),
    // The wire format; sourceKindProblem decides which are available, so an unavailable one refuses with its text.
    api: z.string().trim().min(1).max(64),
    // N8: the secret the endpoint's calls carry, as a reference only (see MODEL_ENDPOINT_SECRET_PREFIX). Absent: the endpoint needs no secret.
    keyRef: z.string().max(MODEL_ENDPOINT_SECRET_REF_MAX).regex(MODEL_ENDPOINT_SECRET_REF, { message: `must be a secret name of the form ${MODEL_ENDPOINT_SECRET_PREFIX}<organization>/<host>/<name>` }).optional(),
    // `name` is what the endpoint calls the model; `catalog` is the Pi model it behaves like, for prices and limits.
    models: modelsSchema(
      z.object({ name: displayName(256), catalog: catalogSchema(undefined, options) }).strict(),
      // Unique by the name the endpoint serves and by the catalog model it stands for, since routing matches on either.
      (entry) => [{ provider: "endpoint", modelId: entry.name }, entry.catalog],
    ),
  }).strict();
  return [keyed("anthropic"), keyed("openai"), keyed("openrouter"), bedrock, endpoint] as const;
}

/** The input shapes an edition may use: without `customModelEndpoint` the endpoint kind is not in the union, so a client-sent endpoint is refused as an unknown kind. */
function allowedInputShapes(options: ModelSourceOptions) {
  const all = inputShapes(options);
  return options.customModelEndpoint === false ? all.slice(0, 4) as unknown as typeof all : all;
}

/**
 * What a client may send to add or change a source. Strict, so a client-sent `sourceId`, `externalId` or
 * `tested` is refused rather than ignored.
 */
export function modelSourceInputSchema(options: ModelSourceOptions = {}) {
  return z.discriminatedUnion("kind", allowedInputShapes(options));
}

/** What the server stores: the input plus its generated `sourceId` and, for Bedrock, the server-set `externalId` and `tested`. */
export function modelSourceSchema(options: ModelSourceOptions = {}) {
  const [anthropic, openai, openrouter, bedrock, endpoint] = inputShapes(options);
  const sourceId = z.string().regex(SOURCE_ID_PATTERN);
  const shapes = [
    anthropic.extend({ sourceId }).strict(),
    openai.extend({ sourceId }).strict(),
    openrouter.extend({ sourceId }).strict(),
    bedrock.extend({ sourceId, externalId: z.string().regex(EXTERNAL_ID_PATTERN), tested: z.boolean().default(false) }).strict(),
    // N8: `qualifiedDigest` is set by the server alone, when a check passes (never by a client: the input shape lacks it). It is the digest of the exact settings
    // that passed (`endpointQualificationDigest`), so any later change to the address, the secret reference, the wire format or the model list leaves it stale and the
    // source unusable until a new check passes.
    endpoint.extend({ sourceId, qualifiedDigest: z.string().regex(QUALIFICATION_DIGEST).optional() }).strict(),
  ] as const;
  return z.discriminatedUnion("kind", options.customModelEndpoint === false ? shapes.slice(0, 4) as unknown as typeof shapes : shapes);
}

/** The shape-only schemas; a caller with Pi's catalog uses `modelSourceInputSchema({ isKnownCatalog })`. */
export const ModelSourceInputSchema = modelSourceInputSchema();
export const ModelSourceSchema = modelSourceSchema();
/** The refusal when a stored source is not this org's: a Bedrock source's external id must be `rovara-<orgId>`. */
export function modelSourceOrgProblem(orgId: OrgId, source: ModelSource): string | undefined {
  if (source.kind === "bedrock" && source.externalId !== bedrockExternalId(orgId)) return "the external id does not belong to this organization";
  return undefined;
}

/**
 * The canonical names a served model name can stand for, under EVERY provider's rules, not only its catalog entry's: the shared matcher strips Bedrock region and vendor
 * prefixes only for `amazon-bedrock` and a `vendor/` prefix only for `openrouter`, and a gateway can serve a model under any spelling (`us.anthropic.x-v1:0`, `anthropic/x`,
 * `bedrock/us.anthropic.x`). So the name is read as each provider's, and again with each leading `a/` segment removed. No second matcher lives here.
 */
function servedCanonicalNames(provider: string, name: string): Set<string> {
  const ids = new Set<string>();
  const parts = name.split("/");
  for (let index = 0; index < parts.length; index += 1) ids.add(parts.slice(index).join("/"));
  // A version after "@" (Vertex AI: `claude-opus-4-1@20250805`, `@latest`) is not part of the model's name.
  for (const id of [...ids]) ids.add(id.replace(/@[A-Za-z0-9._-]+$/u, ""));
  const names = new Set<string>();
  for (const id of ids) for (const reading of new Set([provider, "amazon-bedrock", "openrouter", "anthropic", "openai"])) names.add(canonicalModelName({ provider: reading, modelId: id }));
  return names;
}

/**
 * N8: why an endpoint source may not list a model the company forbids, or undefined. Every model is checked as the catalog model it stands for, and as the name the endpoint
 * serves it under, read under every provider's rules (`servedCanonicalNames`), so a forbidden model cannot hide behind another spelling.
 */
export function endpointForbiddenModelProblem(models: ReadonlyArray<{ name: string; catalog: ModelIdentifier }>, forbidden: readonly ModelIdentifier[]): string | undefined {
  // A forbidden model written another way (the Vertex way, say) is read the same way the served names are.
  const forbiddenNames = new Set(forbidden.flatMap((model) => [canonicalModelName(model), ...servedCanonicalNames(model.provider, model.modelId)]));
  for (const [index, entry] of models.entries()) {
    const served = servedCanonicalNames(entry.catalog.provider, entry.name);
    const catalogNames = [canonicalModelName(entry.catalog), ...servedCanonicalNames(entry.catalog.provider, entry.catalog.modelId)];
    if (catalogNames.some((name) => forbiddenNames.has(name)) || [...served].some((name) => forbiddenNames.has(name))) return `models.${String(index)}: this model is forbidden in your company`;
  }
  return undefined;
}

export type ModelSourceInput = z.infer<typeof ModelSourceInputSchema>;
export type ModelSource = z.infer<typeof ModelSourceSchema>;

export const OrgModelSourcesSchema = z.object({
  sources: z.array(ModelSourceSchema).max(MAX_CUSTOM_SOURCES_PER_ORG),
  /** Which source serves a task first; the rest are fallbacks in order. */
  order: z.array(ModelSourceIdSchema).superRefine((order, context) => {
    if (new Set(order).size !== order.length) context.addIssue({ code: "custom", message: "order must not repeat a source" });
  }),
  assistantModel: ModelIdentifierSchema.optional(),
  chatgptPreferredModel: ChatGptModelIdSchema.optional(),
}).strict().superRefine((record, context) => {
  const known = new Set<string>(record.sources.map((source) => source.sourceId));
  for (const [index, id] of record.order.entries()) {
    if (id !== "rovara" && id !== "personal-chatgpt" && !known.has(id)) context.addIssue({ code: "custom", path: ["order", index], message: "order names a source the organization does not have" });
  }
});
export type OrgModelSources = z.infer<typeof OrgModelSourcesSchema>;

/** A new org's source order: ChatGPT first when the install-wide switch is on, so today's ChatGPT tasks do not change. */
export function defaultModelSourceOrder(chatgptSwitchOn: boolean): ModelSourceId[] {
  return chatgptSwitchOn ? ["personal-chatgpt", "rovara"] : ["rovara"];
}

/** The name the proxy serves a source's model under: unique across orgs and sources, and the same for the same model on any route. */
export function sourceAlias(orgId: OrgId, sourceId: string, model: ModelIdentifier): string {
  return `${orgId}.${sourceId}.${legacyAliasModelName(model)}`;
}

// ---- the texts the admin routes show (Task 24b)

/** What every company AI source route answers on an install with no model proxy (single-company installs today). */
export const MODEL_SOURCES_NEED_PROXY = "company AI sources need Rovara's model proxy, which this install doesn't run";
/** Shown beside every Bedrock source until Task 37's live test has passed. */
export const BEDROCK_NOT_TESTED_NOTE = "NOT TESTED: Bedrock in your own AWS account hasn't been tested yet.";
/** An endpoint's host was approved, but the DNS firewall does not serve it yet. */
export const MODEL_SOURCE_STILL_APPLYING = "Rovara is still applying this address; try again in 5 minutes.";

/**
 * The trust policy an admin pastes into the role a Bedrock source names: the proxy's own roles may assume it, and only with the org's external
 * id. `principals` are Rovara's role ARNs (the model proxy's task role and the function that probes the policy).
 */
export function bedrockTrustPolicy(orgId: OrgId, principals: readonly string[]): Record<string, unknown> {
  return {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { AWS: [...principals] },
      Action: "sts:AssumeRole",
      Condition: { StringEquals: { "sts:ExternalId": bedrockExternalId(orgId) } },
    }],
  };
}
