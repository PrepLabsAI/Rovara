// agentx signin show|enable|disable|check (spec 025 FR-045, FR-046), under the operator role.
import { CLI_PACKAGE_NAME, agentXError, CLI_COMMAND_NAME } from "@agentx/contracts";
import type { CallerIdentity } from "../environments/adopt.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import { readEnvironmentSettings, type EnvironmentSettings } from "../environments/settings.js";
import type { InitSecrets } from "../init/context.js";
import type { Prompter } from "../init/prompts.js";
import type { SlackApi } from "../init/slack-app.js";
import { applySignInChange, type ApplySignInInput, type SignInChoice } from "./apply.js";
import { agentXConfigurationUrl, apiBase, checkDeveloperSignIn, type SignInCheck } from "./check.js";
import { enableOidcSignIn, enableSlackSignIn, type SigninFlags, type SigninSecretFlags } from "./collect.js";
import { describeSignIn, githubSecretName, readSignInSettings, readSlackTeamId, type DeveloperSignInSettings } from "./settings.js";

export interface SigninServices {
  store: ParameterStore; secrets: InitSecrets; cloudFormation: { send(command: unknown): Promise<unknown> }; identity: CallerIdentity;
  fetch: typeof fetch; slackApi: SlackApi; prompter: Prompter; processEnv: NodeJS.ProcessEnv; write: (line: string) => void; now: () => number;
  sleep?: (ms: number) => Promise<void>; pollMs?: number;
}

async function installed(services: SigninServices, env: string): Promise<EnvironmentSettings> {
  const settings = await readEnvironmentSettings(services.store, env);
  if (settings === undefined) throw agentXError("CONFIG_INVALID", `environment ${env} is not installed in this account and region; check --env and --region`);
  if (settings.naming !== "environment") throw agentXError("CONFIG_INVALID", `developer sign-in needs an environment installed with ${CLI_COMMAND_NAME} init; ${env} uses the legacy stack names`);
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
  const lines = [...describeSignIn(stored), `Slack team: ${teamId ?? "not recorded"}`, `The control plane offers: ${offered}`, `Developers sign in with: npx ${CLI_PACKAGE_NAME} login ${apiBase(settings)}`];
  return { lines, data: { settings: stored ?? null, slackTeamId: teamId ?? null, offered } };
}

/** DEC 254h: a GitHub OAuth app's client id (letters, digits, dots, dashes, underscores). */
const GITHUB_CLIENT_ID = /^[A-Za-z0-9._-]{1,64}$/;

export async function runSigninEnable(services: SigninServices, env: string, method: "slack" | "oidc" | "github", flags: SigninFlags, secretFlags: SigninSecretFlags, yes: boolean): Promise<{ changed: boolean }> {
  const settings = await installed(services, env);
  const holder = (await services.identity.get()).arn;
  const questions = { env, apiEndpoint: settings.controlPlaneUrl, secrets: services.secrets, prompter: services.prompter, processEnv: services.processEnv, flags, secretFlags, write: services.write };
  const common = { env, store: services.store, cloudFormation: services.cloudFormation, holder, settings, rerun: `${CLI_COMMAND_NAME} signin enable ${method}`, ...applyOptions(services, yes) };
  // Each `next` reads the settings under the lock, so a change made while the questions were asked is kept.
  const keepGithub = (current: DeveloperSignInSettings | undefined) => (current?.github === undefined ? {} : { github: current.github });
  if (method === "github") {
    // DEC 254h: only the client id; the client secret is stored by the owner under githubSecretName(env) and never passes through the CLI.
    const clientId = flags.githubClientId;
    if (clientId === undefined || !GITHUB_CLIENT_ID.test(clientId)) throw agentXError("CONFIG_INVALID", "GitHub sign-in needs --signin-github-client-id <the GitHub OAuth app's Client ID>");
    const result = await applySignInChange({ ...common, next: (current) => ({ slack: current?.slack ?? false, ...(current?.oidc === undefined ? {} : { oidc: current.oidc }), github: { clientId, clientSecretName: githubSecretName(env) } }) });
    return { changed: result.changed };
  }
  if (method === "slack") {
    const { teamId, credentials } = await enableSlackSignIn({ ...questions, slackApi: services.slackApi });
    const result = await applySignInChange({ ...common, next: (current) => ({ slack: true, ...(current?.oidc === undefined ? {} : { oidc: current.oidc }), ...keepGithub(current) }), slackTeamId: teamId, ...(credentials === undefined ? {} : { credentials }) });
    return { changed: result.changed };
  }
  const { oidc, credentials } = await enableOidcSignIn({ ...questions, fetch: services.fetch });
  const result = await applySignInChange({ ...common, next: (current) => ({ slack: current?.slack ?? false, oidc, ...keepGithub(current) }), credentials });
  return { changed: result.changed };
}

export async function runSigninDisable(services: SigninServices, env: string, method: "slack" | "oidc" | "github", yes: boolean): Promise<{ changed: boolean }> {
  const settings = await installed(services, env);
  const holder = (await services.identity.get()).arn;
  const next = (current: DeveloperSignInSettings | undefined): SignInChoice => {
    if (current === undefined) throw agentXError("CONFIG_INVALID", `developer sign-in is not set up, so there is nothing to disable; run ${CLI_COMMAND_NAME} signin show to see the settings`);
    const choice = { slack: method === "slack" ? false : current.slack, ...(method === "oidc" || current.oidc === undefined ? {} : { oidc: current.oidc }),
      ...(method === "github" || current.github === undefined ? {} : { github: current.github }) };
    if (method === "github" && current.github === undefined) throw agentXError("CONFIG_INVALID", `GitHub sign-in is not on, so there is nothing to disable; run ${CLI_COMMAND_NAME} signin show to see the settings`);
    if (!choice.slack && choice.oidc === undefined && choice.github === undefined) {
      const other = method === "slack" ? `company sign-in first (${CLI_COMMAND_NAME} signin enable oidc)` : `Slack sign-in first (${CLI_COMMAND_NAME} signin enable slack)`;
      throw agentXError("CONFIG_INVALID", `${method === "slack" ? "Slack" : method === "github" ? "GitHub" : "Company"} sign-in is the only method enabled; enable ${other}, because at least one method must stay on`);
    }
    return choice;
  };
  const result = await applySignInChange({ env, store: services.store, cloudFormation: services.cloudFormation, holder, settings, next, rerun: `${CLI_COMMAND_NAME} signin disable ${method}`, ...applyOptions(services, yes) });
  return { changed: result.changed };
}

export async function runSigninCheck(services: SigninServices, env: string): Promise<SignInCheck[]> {
  const settings = await installed(services, env);
  return checkDeveloperSignIn({ env, store: services.store, secrets: services.secrets, settings, fetch: services.fetch, slackApi: services.slackApi });
}
