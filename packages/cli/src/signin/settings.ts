// Spec 025 FR-006 and FR-010 (R7): the developer sign-in choice, kept in SSM beside the environment
// settings. No secret value is ever stored here, only the company client secret's name.
import { z } from "zod";
import { EnvironmentNameSchema, SlackTeamIdSchema, agentXError, environmentSettingsPrefix } from "@agentx/contracts";
import type { ParameterStore } from "../environments/parameter-store.js";

export const DeveloperSignInSettingsSchema = z.object({
  schemaVersion: z.literal(1),
  env: EnvironmentNameSchema,
  slack: z.boolean(),
  oidc: z.object({
    issuer: z.string().url().refine((value) => value.startsWith("https://"), "the company issuer must use https"),
    clientId: z.string().min(1).max(256),
    requiredClaim: z.string().min(1).max(128).optional(),
    requiredValues: z.array(z.string().min(1).max(128)).min(1).max(20).optional(),
    displayName: z.string().min(1).max(40),
    clientSecretName: z.string().regex(/^agentx\/[a-z0-9-]+\/developer-oidc$/),
  }).strict().optional(),
  updatedAt: z.iso.datetime(),
  updatedBy: z.string().min(1).max(2048),
}).strict()
  .refine((settings) => settings.slack || settings.oidc !== undefined, "enable Slack sign-in, company sign-in, or both (FR-010)")
  .superRefine((settings, context) => {
    if (settings.oidc !== undefined && settings.oidc.clientSecretName !== oidcSecretName(settings.env)) {
      context.addIssue({ code: "custom", path: ["oidc", "clientSecretName"], message: `must be ${oidcSecretName(settings.env)}` });
    }
  });

export type DeveloperSignInSettings = z.infer<typeof DeveloperSignInSettingsSchema>;
export interface StoredDeveloperSignIn { settings?: DeveloperSignInSettings; slackTeamId?: string }

export const signInParameterName = (env: string) => `${environmentSettingsPrefix(env)}signin`;
export const slackTeamIdParameterName = (env: string) => `${environmentSettingsPrefix(env)}slack/teamId`;
export const oidcSecretName = (env: string) => `agentx/${env}/developer-oidc`;

const firstIssue = (error: z.ZodError) => `${error.issues[0]?.path.join(".") ?? ""} ${error.issues[0]?.message ?? ""}`.trim();

export async function readSignInSettings(store: ParameterStore, env: string): Promise<DeveloperSignInSettings | undefined> {
  const stored = await store.get(signInParameterName(env));
  if (stored === undefined) return undefined;
  let json: unknown;
  try { json = JSON.parse(stored.value); } catch { throw agentXError("CONFIG_INVALID", `${signInParameterName(env)} is not valid JSON; run agentx signin enable again`); }
  const parsed = DeveloperSignInSettingsSchema.safeParse(json);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `${signInParameterName(env)} is invalid (${firstIssue(parsed.error)}); run agentx signin enable again`);
  if (parsed.data.env !== env) throw agentXError("CONFIG_INVALID", `${signInParameterName(env)} names environment ${parsed.data.env}; run agentx signin enable again`);
  return parsed.data;
}

export async function writeSignInSettings(store: ParameterStore, settings: DeveloperSignInSettings): Promise<void> {
  const parsed = DeveloperSignInSettingsSchema.safeParse(settings);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `developer sign-in settings are invalid: ${firstIssue(parsed.error)}`);
  await store.put(signInParameterName(parsed.data.env), JSON.stringify(parsed.data));
}

export async function readSlackTeamId(store: ParameterStore, env: string): Promise<string | undefined> {
  const stored = await store.get(slackTeamIdParameterName(env));
  return stored === undefined || stored.value === "" ? undefined : stored.value;
}

export async function writeSlackTeamId(store: ParameterStore, env: string, teamId: string): Promise<void> {
  if (!SlackTeamIdSchema.safeParse(teamId).success) throw agentXError("CONFIG_INVALID", `${teamId} is not a Slack team ID (it starts with T)`);
  await store.put(slackTeamIdParameterName(env), teamId);
}

export async function readStoredDeveloperSignIn(store: ParameterStore, env: string): Promise<StoredDeveloperSignIn | undefined> {
  const [settings, slackTeamId] = await Promise.all([readSignInSettings(store, env), readSlackTeamId(store, env)]);
  if (settings === undefined && slackTeamId === undefined) return undefined;
  return { ...(settings === undefined ? {} : { settings }), ...(slackTeamId === undefined ? {} : { slackTeamId }) };
}

/** Exactly the seven parameter names `developerSignInParameters` declares on the control-plane
 * stack (infra/lib/developer-signin.ts), spec 025 phase 25a. Kept as the one place both sides list
 * these names, so `signInStackParameters` can never drift into returning a key the template does
 * not declare. */
export const SIGN_IN_PARAMETER_NAMES = [
  "SlackTeamId", "DeveloperSignInSlack", "DeveloperOidcIssuer", "DeveloperOidcClientId",
  "DeveloperOidcRequiredClaim", "DeveloperOidcRequiredValues", "DeveloperOidcDisplayName",
] as const;

export function signInStackParameters(stored: StoredDeveloperSignIn): Record<string, string> {
  const oidc = stored.settings?.oidc;
  const values: Record<(typeof SIGN_IN_PARAMETER_NAMES)[number], string> = {
    SlackTeamId: stored.slackTeamId ?? "",
    DeveloperSignInSlack: stored.settings?.slack === true ? "enabled" : "disabled",
    DeveloperOidcIssuer: oidc?.issuer ?? "",
    DeveloperOidcClientId: oidc?.clientId ?? "",
    DeveloperOidcRequiredClaim: oidc?.requiredClaim ?? "",
    DeveloperOidcRequiredValues: JSON.stringify(oidc?.requiredValues ?? []),
    DeveloperOidcDisplayName: oidc?.displayName ?? "Company sign-in",
  };
  return values;
}

export function describeSignIn(settings: DeveloperSignInSettings | undefined): string[] {
  const oidc = settings?.oidc;
  const requirement = oidc?.requiredClaim === undefined ? "" : `, requires ${oidc.requiredClaim}: ${(oidc.requiredValues ?? []).join(" or ")}`;
  return [
    `Slack sign-in: ${settings?.slack === true ? "on" : "off"}`,
    oidc === undefined ? "Company sign-in: off" : `Company sign-in: on (${oidc.displayName}, ${oidc.issuer}, client ${oidc.clientId}${requirement})`,
  ];
}
