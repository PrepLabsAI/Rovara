// FR-050: the Slack token, the request URLs, and the bot's membership of the bound channel. Slack's
// own "Verified" mark cannot be read without an app configuration token (15d1 decision), so the URLs
// get the same signed self-probe agentx init sends.
import { AgentXError, environmentStackName } from "@agentx/contracts";
import { probeSlackUrls, readSlackBotToken, slackSecretName, SlackSignatureRefusedError } from "../init/slack-app.js";
import { SlackRateLimitedError } from "../setup/channel-add.js";
import { plainMessage } from "../output.js";
import { check, type DoctorCheck, type DoctorContext } from "./checks.js";
import { jsonObject } from "./secrets.js";

const PROBE_TIMEOUT_MS = 30_000;
/** Slack documents its error codes as lower case, digits and underscores; anything else is not echoed. */
const safeCode = (code: string | undefined) => (code !== undefined && /^[a-z0-9_]{1,64}$/.test(code) ? code : "no reason given");

/** The fix for a failed channel lookup, by what failed: slackChannelApi throws CONFIG_INVALID for a
 * missing scope and for a workspace too large to search, RUNTIME_UNAVAILABLE for Slack's other
 * refusals and HTTP errors, and a non-AgentX error when Slack cannot be reached at all. */
function channelLookupFix(error: unknown, reinstall: string, project: { name: string; channelId?: string | undefined; teamId?: string | undefined } | undefined): string {
  const network = "check this computer's network access to slack.com, then run agentx doctor again";
  if (error instanceof SlackRateLimitedError) return "Slack is rate limiting the bot; run agentx doctor again in a minute";
  if (!(error instanceof AgentXError)) return network;
  const message = plainMessage(error);
  if (message.includes("refused: missing_scope")) return `${reinstall} (its manifest grants channels:read, groups:read and channels:join)`;
  if (error.code === "CONFIG_INVALID") return `bind it by ID: agentx admin slack bind --team ${project?.teamId ?? "<team-id>"} --channel ${project?.channelId ?? "<channel-id>"} --project ${project?.name ?? "<name>"}`;
  if (message.includes(" refused: ")) return `Slack refused the bot's request (its error code is above); ${reinstall}`;
  return network;
}

/** The Slack secret's signing secret, read with the same safe parse as the secrets check. */
export function slackSigningSecret(raw: string | undefined): string | undefined {
  const value = jsonObject(raw)?.signingSecret;
  return typeof value === "string" ? value : undefined;
}

export async function slackChecks(context: DoctorContext): Promise<DoctorCheck[]> {
  const { env, settings, progress, services } = context;
  const reinstall = `reinstall the Slack app (api.slack.com/apps, Install App), then store the new Bot User OAuth Token in ${slackSecretName(env)}`;
  // One read of the Slack secret serves both the token and the signing secret.
  const raw = await services.secrets.get(slackSecretName(env));
  let token: string;
  try {
    token = await readSlackBotToken({ get: async () => raw }, env);
  } catch (error) {
    return [check("slack", "bot token", "fail", plainMessage(error), reinstall)];
  }
  let auth: Awaited<ReturnType<typeof services.slackApi.authTest>>;
  try {
    auth = await services.slackApi.authTest(token);
  } catch {
    return [check("slack", "bot token", "fail", "could not reach Slack to check the bot token", "check this computer's network access to slack.com, then run agentx doctor again")];
  }
  if (!auth.ok) return [check("slack", "bot token", "fail", `Slack refused the bot token (${safeCode(auth.error)})`, reinstall)];
  if (auth.bot_id === undefined) return [check("slack", "bot token", "fail", "the stored token is not a bot token", reinstall)];
  const recordedTeam = progress?.slack?.teamId;
  if (recordedTeam !== undefined && auth.team_id !== recordedTeam) {
    return [check("slack", "bot token", "fail", `the bot token is for workspace ${auth.team_id ?? "unknown"}, but agentx init set up ${recordedTeam}`, `store the bot token of the Slack app installed in ${recordedTeam} in ${slackSecretName(env)}`)];
  }
  const checks = [check("slack", "bot token", "ok", `bot ${auth.user ?? auth.user_id ?? "user"} in ${auth.team ?? auth.team_id ?? "the workspace"}`)];

  const controlPlane = settings.stacks["control-plane"] ?? environmentStackName(env, "control-plane");
  const outputs = (await services.stacks.describe(controlPlane))?.outputs ?? {};
  const signingSecret = slackSigningSecret(raw);
  if (outputs.SlackEventsUrl === undefined || outputs.SlackInteractivityUrl === undefined || signingSecret === undefined) {
    checks.push(check("slack", "request URLs", "skip", "the control-plane stack reports no Slack URLs, or no signing secret is stored"));
  } else {
    try {
      await probeSlackUrls({ eventsUrl: outputs.SlackEventsUrl, interactivityUrl: outputs.SlackInteractivityUrl, signingSecret, fetch: services.fetch, now: services.now, sleep: services.sleep, write: () => undefined, timeoutMs: PROBE_TIMEOUT_MS, pollMs: 5_000 });
      checks.push(check("slack", "request URLs", "ok", "the events URL echoes a signed challenge and the interactivity URL answers; Slack's own Verified mark is on the app's Event Subscriptions page"));
    } catch (error) {
      if (error instanceof SlackSignatureRefusedError) {
        // init's words assume a secret it just stored; doctor's secret is not new.
        checks.push(check("slack", "request URLs", "fail", `${error.url} refuses requests signed with the signing secret stored in ${slackSecretName(env)}`, `check that ${slackSecretName(env)} holds the Slack app's Signing Secret (not the Client Secret) and that this computer's clock is correct (Slack refuses signatures older than 5 minutes), then run agentx doctor again`));
      } else {
        checks.push(check("slack", "request URLs", "fail", plainMessage(error).replace("then run agentx init again", "then run agentx doctor again"), `check that the Slack app's Request URLs are ${outputs.SlackEventsUrl} and ${outputs.SlackInteractivityUrl}, and the control plane's SlackIngress logs`));
      }
    }
  }

  const channel = progress?.project?.channelName;
  if (channel === undefined) {
    checks.push(check("slack", "bound channels", "skip", "agentx init recorded no bound channel; channels bound later are not listed until the control plane can report them"));
    return checks;
  }
  const bot = auth.user ?? "the bot";
  let found: Awaited<ReturnType<typeof services.slackChannels.find>>;
  try {
    found = await services.slackChannels.find(token, channel);
  } catch (error) {
    checks.push(check("slack", `#${channel}`, "fail", plainMessage(error), channelLookupFix(error, reinstall, progress?.project)));
    return checks;
  }
  if (found === undefined) checks.push(check("slack", `#${channel}`, "fail", "the channel no longer exists, or it is private and the bot is not in it", `in #${channel}, type /invite @${bot}, or bind another channel with agentx --env ${env} channel add --project ${progress?.project?.name ?? "<project>"}`));
  else if (!found.isMember) checks.push(check("slack", `#${channel}`, "fail", "the bot is not a member", `in #${channel}, type /invite @${bot}`));
  else checks.push(check("slack", `#${channel}`, "ok", "the bot is a member"));
  return checks;
}
