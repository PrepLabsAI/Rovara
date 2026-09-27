// agentx signin show|enable|disable|check (spec 025 FR-045, FR-046), under the operator role.
import { agentXError } from "@agentx/contracts";
import type { CallerIdentity } from "../environments/adopt.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import { readEnvironmentSettings, type EnvironmentSettings } from "../environments/settings.js";
import type { InitSecrets } from "../init/context.js";
import type { Prompter } from "../init/prompts.js";
import type { SlackApi } from "../init/slack-app.js";
import { applySignInChange, type ApplySignInInput } from "./apply.js";
import { agentXConfigurationUrl, apiBase, checkDeveloperSignIn, type SignInCheck } from "./check.js";
import { enableOidcSignIn, enableSlackSignIn, type SigninFlags, type SigninSecretFlags } from "./collect.js";
import { describeSignIn, readSignInSettings, readSlackTeamId } from "./settings.js";

export interface SigninServices {
  store: ParameterStore; secrets: InitSecrets; cloudFormation: { send(command: unknown): Promise<unknown> }; identity: CallerIdentity;
  fetch: typeof fetch; slackApi: SlackApi; prompter: Prompter; processEnv: NodeJS.ProcessEnv; write: (line: string) => void; now: () => number;
  sleep?: (ms: number) => Promise<void>; pollMs?: number;
}

async function installed(services: SigninServices, env: string): Promise<EnvironmentSettings> {
  const settings = await readEnvironmentSettings(services.store, env);
  if (settings === undefined) throw agentXError("CONFIG_INVALID", `environment ${env} is not installed in this account and region; check --env and --region`);
  if (settings.naming !== "environment") throw agentXError("CONFIG_INVALID", `developer sign-in needs an environment installed with agentx init; ${env} uses the legacy stack names`);
  return settings;
}

/** Prints the whole change, then asks once (F30); with --yes the change is still printed, and applied. */
const applyOptions = (services: SigninServices, yes: boolean): Pick<ApplySignInInput, "confirm" | "write" | "now" | "sleep" | "pollMs"> => ({
  confirm: async (text: string) => { services.write(text); return yes || services.prompter.confirm("Apply this change?", { defaultValue: false }); },
  write: services.write, now: services.now,
  ...(services.sleep === undefined ? {} : { sleep: services.sleep }),
  ...(services.pollMs === undefined ? {} : { pollMs: services.pollMs }),
});

/** The methods the control plane's discovery document offers, read leniently: `show` reports, it does not judge (that is `check`). */
function offeredMethods(body: unknown): string {
  const methods = typeof body === "object" && body !== null ? (body as { methods?: { slack?: unknown; oidc?: { displayName?: unknown } | null } }).methods : undefined;
  const names = [
    methods?.slack === true ? "Slack" : undefined,
    typeof methods?.oidc?.displayName === "string" ? methods.oidc.displayName : undefined,
  ].filter((name): name is string => name !== undefined);
  return names.length === 0 ? "nothing" : names.join(" and ");
}

export async function runSigninShow(services: SigninServices, env: string): Promise<{ lines: string[]; data: Record<string, unknown> }> {
  const settings = await installed(services, env);
  const stored = await readSignInSettings(services.store, env);
  const teamId = await readSlackTeamId(services.store, env);
  let offered = "unknown (the control plane could not be reached)";
  try {
    const response = await services.fetch(agentXConfigurationUrl(settings), { signal: AbortSignal.timeout(10_000) });
    if (response.ok) offered = offeredMethods(await response.json());
  } catch { /* shown as unknown */ }
  const lines = [...describeSignIn(stored), `Slack team: ${teamId ?? "not recorded"}`, `The control plane offers: ${offered}`, `Developers sign in with: npx @charterarc/agentx login ${apiBase(settings)}`];
  return { lines, data: { settings: stored ?? null, slackTeamId: teamId ?? null, offered } };
}

export async function runSigninEnable(services: SigninServices, env: string, method: "slack" | "oidc", flags: SigninFlags, secretFlags: SigninSecretFlags, yes: boolean): Promise<{ changed: boolean }> {
  const settings = await installed(services, env);
  const holder = (await services.identity.get()).arn;
  const current = await readSignInSettings(services.store, env);
  const questions = { env, apiEndpoint: settings.controlPlaneUrl, secrets: services.secrets, prompter: services.prompter, processEnv: services.processEnv, flags, secretFlags, write: services.write };
  const common = { env, store: services.store, cloudFormation: services.cloudFormation, holder, settings, ...applyOptions(services, yes) };
  if (method === "slack") {
    const { teamId, credentials } = await enableSlackSignIn({ ...questions, slackApi: services.slackApi });
    const result = await applySignInChange({ ...common, next: { slack: true, ...(current?.oidc === undefined ? {} : { oidc: current.oidc }) }, slackTeamId: teamId, credentials });
    return { changed: result.changed };
  }
  const { oidc, credentials } = await enableOidcSignIn({ ...questions, fetch: services.fetch });
  const result = await applySignInChange({ ...common, next: { slack: current?.slack ?? false, oidc }, credentials });
  return { changed: result.changed };
}

export async function runSigninDisable(services: SigninServices, env: string, method: "slack" | "oidc", yes: boolean): Promise<{ changed: boolean }> {
  const settings = await installed(services, env);
  const current = await readSignInSettings(services.store, env);
  if (current === undefined) throw agentXError("CONFIG_INVALID", "developer sign-in is not set up, so there is nothing to disable; run agentx signin show to see the settings");
  const next = { slack: method === "slack" ? false : current.slack, ...(method === "oidc" || current.oidc === undefined ? {} : { oidc: current.oidc }) };
  if (!next.slack && next.oidc === undefined) {
    const other = method === "slack" ? "company sign-in first (agentx signin enable oidc)" : "Slack sign-in first (agentx signin enable slack)";
    throw agentXError("CONFIG_INVALID", `${method === "slack" ? "Slack" : "Company"} sign-in is the only method enabled; enable ${other}, because at least one method must stay on`);
  }
  const holder = (await services.identity.get()).arn;
  const result = await applySignInChange({ env, store: services.store, cloudFormation: services.cloudFormation, holder, settings, next, ...applyOptions(services, yes) });
  return { changed: result.changed };
}

export async function runSigninCheck(services: SigninServices, env: string): Promise<SignInCheck[]> {
  const settings = await installed(services, env);
  return checkDeveloperSignIn({ env, store: services.store, secrets: services.secrets, settings, fetch: services.fetch, slackApi: services.slackApi });
}
