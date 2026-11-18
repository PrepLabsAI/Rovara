// Spec 025 FR-006 and FR-010 (R7): the developer sign-in choice, kept in SSM beside the environment
// settings. No secret value is ever stored here, only the company client secret's name.
import { z } from "zod";
import { EnvironmentNameSchema, SlackTeamIdSchema, agentXError, environmentSettingsPrefix, CLI_COMMAND_NAME } from "@agentx/contracts";
import type { ParameterStore } from "../environments/parameter-store.js";

export const DeveloperSignInSettingsSchema = z.object({
  schemaVersion: z.literal(1),
  env: EnvironmentNameSchema,
  slack: z.boolean(),
  oidc: z.object({
    issuer: z.string().url().max(512).refine((value) => value.startsWith("https://"), "the company issuer must use https"),
    clientId: z.string().min(1).max(256),
    requiredClaim: z.string().min(1).max(128).optional(),
    requiredValues: z.array(z.string().min(1).max(128)).min(1).max(20).optional(),
    displayName: z.string().min(1).max(40),
    clientSecretName: z.string().regex(/^agentx\/[a-z0-9-]+\/developer-oidc$/),
  }).strict()
    .refine((oidc) => (oidc.requiredClaim === undefined) === (oidc.requiredValues === undefined), "requiredClaim and requiredValues must be set together or not at all")
    .optional(),
  /**
   * DEC 254h: GitHub sign-in (served only while Code's company layer is on). Only the OAuth app's client id and the name of the secret holding its
   * client secret; the owner stores that secret, and nothing here reads or writes it.
   */
  github: z.object({
    clientId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
    clientSecretName: z.string().regex(/^agentx\/[a-z0-9-]+\/developer-github$/),
  }).strict().optional(),
  /** FR-045: when each method was last turned on, in epoch seconds. A session started before it was
   * ended by the disable in between, so it stays ended. Kept while the method is off. */
  since: z.object({
    slack: z.number().int().nonnegative().max(999_999_999_999).optional(),
    oidc: z.number().int().nonnegative().max(999_999_999_999).optional(),
    github: z.number().int().nonnegative().max(999_999_999_999).optional(),
  }).strict().optional(),
  updatedAt: z.iso.datetime(),
  updatedBy: z.string().min(1).max(2048),
}).strict()
  .refine((settings) => settings.slack || settings.oidc !== undefined || settings.github !== undefined, "enable Slack sign-in, company sign-in, or both (FR-010), or GitHub sign-in")
  .superRefine((settings, context) => {
    if (settings.github !== undefined && settings.github.clientSecretName !== githubSecretName(settings.env)) {
      context.addIssue({ code: "custom", path: ["github", "clientSecretName"], message: `must be ${githubSecretName(settings.env)}` });
    }
    if (settings.oidc !== undefined && settings.oidc.clientSecretName !== oidcSecretName(settings.env)) {
      context.addIssue({ code: "custom", path: ["oidc", "clientSecretName"], message: `must be ${oidcSecretName(settings.env)}` });
    }
  });

export type DeveloperSignInSettings = z.infer<typeof DeveloperSignInSettingsSchema>;
export interface StoredDeveloperSignIn { settings?: DeveloperSignInSettings; slackTeamId?: string }

export const signInParameterName = (env: string) => `${environmentSettingsPrefix(env)}signin`;
export const slackTeamIdParameterName = (env: string) => `${environmentSettingsPrefix(env)}slack/teamId`;
export const oidcSecretName = (env: string) => `agentx/${env}/developer-oidc`;
/** DEC 254h: the secret the sign-in function reads GitHub's client secret from (`{"clientSecret": "..."}`), stored by the owner, never by the CLI. */
export const githubSecretName = (env: string) => `agentx/${env}/developer-github`;

const firstIssue = (error: z.ZodError) => `${error.issues[0]?.path.join(".") ?? ""} ${error.issues[0]?.message ?? ""}`.trim();

export async function readSignInSettings(store: ParameterStore, env: string): Promise<DeveloperSignInSettings | undefined> {
  const stored = await store.get(signInParameterName(env));
  if (stored === undefined) return undefined;
  let json: unknown;
  try { json = JSON.parse(stored.value); } catch { throw agentXError("CONFIG_INVALID", `${signInParameterName(env)} is not valid JSON; run ${CLI_COMMAND_NAME} signin enable again`); }
  const parsed = DeveloperSignInSettingsSchema.safeParse(json);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `${signInParameterName(env)} is invalid (${firstIssue(parsed.error)}); run ${CLI_COMMAND_NAME} signin enable again`);
  if (parsed.data.env !== env) throw agentXError("CONFIG_INVALID", `${signInParameterName(env)} names environment ${parsed.data.env}; run ${CLI_COMMAND_NAME} signin enable again`);
  return parsed.data;
}

/** SSM's size limit for a standard (non-advanced) String parameter. */
const MAX_SSM_STANDARD_PARAMETER_BYTES = 4096;

export async function writeSignInSettings(store: ParameterStore, settings: DeveloperSignInSettings): Promise<void> {
  const parsed = DeveloperSignInSettingsSchema.safeParse(settings);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `developer sign-in settings are invalid: ${firstIssue(parsed.error)}`);
  const json = JSON.stringify(parsed.data);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_SSM_STANDARD_PARAMETER_BYTES) {
    throw agentXError(
      "CONFIG_INVALID",
      `developer sign-in settings are ${bytes} bytes, over SSM's ${MAX_SSM_STANDARD_PARAMETER_BYTES}-byte limit for a standard parameter; shorten the OIDC issuer, display name or required values`,
    );
  }
  await store.put(signInParameterName(parsed.data.env), json);
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

/** Exactly the nine parameter names `developerSignInParameters` declares on the control-plane
 * stack (infra/lib/developer-signin.ts), spec 025 phase 25a. Kept as the one place both sides list
 * these names, so `signInStackParameters` can never drift into returning a key the template does
 * not declare. */
export const SIGN_IN_PARAMETER_NAMES = [
  "SlackTeamId", "DeveloperSignInSlack", "DeveloperOidcIssuer", "DeveloperOidcClientId",
  "DeveloperOidcRequiredClaim", "DeveloperOidcRequiredValues", "DeveloperOidcDisplayName",
  "DeveloperSignInSlackSince", "DeveloperOidcSince",
] as const;

/** DEC 254h: GitHub sign-in's parameters, declared only by named environments from this release on. Sent only once GitHub has been turned on. */
export const GITHUB_SIGN_IN_PARAMETER_NAMES = ["DeveloperSignInGithub", "DeveloperGithubClientId", "DeveloperGithubSince"] as const;

/** The enabled-since parameters (FR-045), which a control plane from before them lacks. */
export const SIGN_IN_SINCE_PARAMETER_NAMES: ReadonlySet<string> = new Set(["DeveloperSignInSlackSince", "DeveloperOidcSince"]);

/** Whether GitHub sign-in was ever turned on (so its parameters are set, including to turn it off). */
export const githubEverOn = (settings: DeveloperSignInSettings | undefined) => settings?.github !== undefined || settings?.since?.github !== undefined;

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
    DeveloperSignInSlackSince: String(stored.settings?.since?.slack ?? 0),
    DeveloperOidcSince: String(stored.settings?.since?.oidc ?? 0),
  };
  // A control plane from before GitHub sign-in lacks these parameters, so a Slack or company sign-in change never sends them.
  if (!githubEverOn(stored.settings)) return values;
  return { ...values, DeveloperSignInGithub: stored.settings?.github === undefined ? "disabled" : "enabled",
    DeveloperGithubClientId: stored.settings?.github?.clientId ?? "", DeveloperGithubSince: String(stored.settings?.since?.github ?? 0) };
}

/** `withGithub`: also a GitHub line (by default only once GitHub sign-in was ever turned on, so older output is unchanged). */
export function describeSignIn(settings: DeveloperSignInSettings | undefined, withGithub = githubEverOn(settings)): string[] {
  const oidc = settings?.oidc;
  const requirement = oidc?.requiredClaim === undefined ? "" : `, requires ${oidc.requiredClaim}: ${(oidc.requiredValues ?? []).join(" or ")}`;
  return [
    `Slack sign-in: ${settings?.slack === true ? "on" : "off"}`,
    oidc === undefined ? "Company sign-in: off" : `Company sign-in: on (${oidc.displayName}, ${oidc.issuer}, client ${oidc.clientId}${requirement})`,
    ...(withGithub ? [settings?.github === undefined ? "GitHub sign-in: off" : `GitHub sign-in: on (client ${settings.github.clientId}; secret ${settings.github.clientSecretName})`] : []),
  ];
}
