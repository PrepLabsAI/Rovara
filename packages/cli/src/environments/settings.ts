import { z } from "zod";
import { ModelsAnswersSchema } from "../deploy/answer-schemas.js";
import { agentXError, EnvironmentNameSchema, environmentSettingsPrefix } from "@agentx/contracts";
import { ParameterExistsError, type ParameterStore } from "./parameter-store.js";

export const EnvironmentSettingsSchema = z.object({
  schemaVersion: z.literal(1),
  env: EnvironmentNameSchema,
  account: z.string().regex(/^\d{12}$/),
  region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/),
  engine: z.enum(["templates", "cdk"]),
  /** A release version such as 1.4.0, or "unversioned" for an adopted deployment. */
  version: z.string().regex(/^(?:\d+\.\d+\.\d+|unversioned)$/),
  /** Legacy for a deployment adopted with fixed stack names. */
  naming: z.enum(["environment", "legacy"]),
  stacks: z.object({ access: z.string().optional(), foundation: z.string(), identity: z.string().optional(), gateway: z.string().optional(), runtime: z.string(), "control-plane": z.string(), slack: z.string() }).strict(),
  controlPlaneUrl: z.string().url(),
  identity: z.object({
    mode: z.enum(["cognito", "oidc"]),
    issuer: z.string().url(),
    audience: z.string().min(1).max(256),
    clientId: z.string().min(1).max(256),
  }).strict(),
  models: ModelsAnswersSchema,
  alertAddress: z.string().min(1).optional(),
  access: z
    .object({
      artifactBucket: z.string().min(1),
      cloudFormationRoleArn: z.string().regex(/^arn:aws[a-z-]*:iam::[0-9]{12}:role\/.+$/),
      operatorRoleArn: z.string().regex(/^arn:aws[a-z-]*:iam::[0-9]{12}:role\/.+$/),
      pullThroughPrefix: z.string().min(1),
      permissionsBoundaryArn: z.string().regex(/^arn:aws[a-z-]*:iam::[0-9]{12}:policy\/.+$/).optional(),
    })
    .strict()
    .optional(),
  updatedAt: z.iso.datetime(),
}).strict();

export type EnvironmentSettings = z.infer<typeof EnvironmentSettingsSchema>;

/**
 * The only keys outside the schema that reading settings tolerates: the old monolith (before the
 * Code/Cloud split) stored its cloud add-on's settings under them. Reading ignores exactly these two,
 * whatever their value; the next write leaves them out and says so. Every other unknown key is
 * still refused.
 */
export const LEGACY_SETTINGS_KEYS = ["cloud", "cloudSignIn"] as const;

/** The legacy keys `json` holds, in LEGACY_SETTINGS_KEYS order. */
function legacyKeysIn(json: unknown): string[] {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return [];
  return LEGACY_SETTINGS_KEYS.filter((key) => Object.hasOwn(json, key));
}

/** `json` without the legacy keys; anything that is not a plain object is returned as-is for the schema to refuse. */
function withoutLegacyKeys(json: unknown): unknown {
  const keys = legacyKeysIn(json);
  if (keys.length === 0) return json;
  const copy: Record<string, unknown> = { ...(json as Record<string, unknown>) };
  for (const key of keys) delete copy[key];
  return copy;
}

export function settingsParameterName(env: string): string {
  return `${environmentSettingsPrefix(env)}settings`;
}

/** `<prefix>: <path> <message>` for a zod error's first issue, trimmed. */
function firstIssueMessage(prefix: string, error: z.ZodError): string {
  return `${prefix}: ${error.issues[0]?.path.join(".") ?? ""} ${error.issues[0]?.message ?? ""}`.trim();
}

export async function readEnvironmentSettings(store: ParameterStore, env: string): Promise<EnvironmentSettings | undefined> {
  const stored = await store.get(settingsParameterName(env));
  if (stored === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(stored.value);
  } catch {
    throw agentXError("CONFIG_INVALID", `settings for environment ${env} are not valid JSON`);
  }
  const parsed = EnvironmentSettingsSchema.safeParse(withoutLegacyKeys(json));
  if (!parsed.success) throw agentXError("CONFIG_INVALID", firstIssueMessage(`settings for environment ${env} are invalid`, parsed.error));
  if (parsed.data.env !== env) throw agentXError("CONFIG_INVALID", `settings stored for environment ${env} name environment ${parsed.data.env}`);
  return parsed.data;
}

/** The legacy keys the stored settings hold now; none when there are none, or they are not JSON. */
async function storedLegacyKeys(store: ParameterStore, env: string): Promise<string[]> {
  const stored = await store.get(settingsParameterName(env));
  if (stored === undefined) return [];
  try {
    return legacyKeysIn(JSON.parse(stored.value));
  } catch {
    return [];
  }
}

/**
 * Writes the settings, schema-checked. The written value never holds a legacy key (the schema has
 * none). With `onLegacyKeysDropped`, an overwrite first looks at what is stored, and after the write
 * reports the legacy keys it dropped (names only, never values).
 */
export async function writeEnvironmentSettings(store: ParameterStore, settings: EnvironmentSettings, options: { createOnly?: boolean; onLegacyKeysDropped?: (keys: string[]) => void } = {}): Promise<void> {
  const parsed = EnvironmentSettingsSchema.safeParse(settings);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", firstIssueMessage("environment settings are invalid", parsed.error));
  const dropped = options.onLegacyKeysDropped === undefined || options.createOnly ? [] : await storedLegacyKeys(store, parsed.data.env);
  try {
    await store.put(settingsParameterName(parsed.data.env), JSON.stringify(parsed.data), options.createOnly ? { createOnly: true } : {});
    if (dropped.length > 0) options.onLegacyKeysDropped?.(dropped);
  } catch (error) {
    if (options.createOnly && error instanceof ParameterExistsError) {
      throw agentXError("CONFIG_INVALID", `environment ${parsed.data.env} already has settings; nothing changed`);
    }
    throw error;
  }
}

export async function listEnvironments(store: ParameterStore): Promise<string[]> {
  const names = await store.list("/agentx/");
  return names
    .map((name) => /^\/agentx\/([^/]+)\/settings$/.exec(name)?.[1])
    .filter((env): env is string => env !== undefined && EnvironmentNameSchema.safeParse(env).success)
    .sort();
}
