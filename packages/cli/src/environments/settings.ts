import { z } from "zod";
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
  stacks: z.object({ access: z.string().optional(), foundation: z.string(), identity: z.string().optional(), runtime: z.string(), "control-plane": z.string(), slack: z.string() }).strict(),
  controlPlaneUrl: z.string().url(),
  identity: z.object({
    mode: z.enum(["cognito", "oidc"]),
    issuer: z.string().url(),
    audience: z.string().min(1).max(256),
    clientId: z.string().min(1).max(256),
  }).strict(),
  models: z.object({ orchestrator: z.string().min(1), classifier: z.string().min(1), worker: z.string().min(1) }).strict(),
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
  const parsed = EnvironmentSettingsSchema.safeParse(json);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", firstIssueMessage(`settings for environment ${env} are invalid`, parsed.error));
  if (parsed.data.env !== env) throw agentXError("CONFIG_INVALID", `settings stored for environment ${env} name environment ${parsed.data.env}`);
  return parsed.data;
}

export async function writeEnvironmentSettings(store: ParameterStore, settings: EnvironmentSettings, options: { createOnly?: boolean } = {}): Promise<void> {
  const parsed = EnvironmentSettingsSchema.safeParse(settings);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", firstIssueMessage("environment settings are invalid", parsed.error));
  try {
    await store.put(settingsParameterName(parsed.data.env), JSON.stringify(parsed.data), options.createOnly ? { createOnly: true } : {});
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
