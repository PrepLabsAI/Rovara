// FR-050: the Slack token, the request URLs, and the bot's membership of the bound channel. Slack's
// own "Verified" mark cannot be read without an app configuration token (15d1 decision), so the URLs
// get the same signed self-probe agentx init sends.
import { environmentStackName } from "@agentx/contracts";
import { probeSlackUrls, readSlackBotToken, slackSecretName } from "../init/slack-app.js";
import { plainMessage } from "../output.js";
import { check, type DoctorCheck, type DoctorContext } from "./checks.js";

const PROBE_TIMEOUT_MS = 30_000;
/** Slack documents its error codes as lower case, digits and underscores; anything else is not echoed. */
const safeCode = (code: string | undefined) => (code !== undefined && /^[a-z0-9_]{1,64}$/.test(code) ? code : "no reason given");

export async function slackChecks(context: DoctorContext): Promise<DoctorCheck[]> {
  const { env, settings, progress, services } = context;
  const reinstall = `reinstall the Slack app (api.slack.com/apps, Install App), then store the new Bot User OAuth Token in ${slackSecretName(env)}`;
  let token: string;
  try {
    token = await readSlackBotToken(services.secrets, env);
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
  const secret = JSON.parse((await services.secrets.get(slackSecretName(env))) ?? "{}") as { signingSecret?: string };
  if (outputs.SlackEventsUrl === undefined || outputs.SlackInteractivityUrl === undefined || secret.signingSecret === undefined) {
    checks.push(check("slack", "request URLs", "skip", "the control-plane stack reports no Slack URLs, or no signing secret is stored"));
  } else {
    try {
      await probeSlackUrls({ eventsUrl: outputs.SlackEventsUrl, interactivityUrl: outputs.SlackInteractivityUrl, signingSecret: secret.signingSecret, fetch: services.fetch, now: services.now, sleep: services.sleep, write: () => undefined, timeoutMs: PROBE_TIMEOUT_MS, pollMs: 5_000 });
      checks.push(check("slack", "request URLs", "ok", "the events URL echoes a signed challenge and the interactivity URL answers; Slack's own Verified mark is on the app's Event Subscriptions page"));
    } catch (error) {
      checks.push(check("slack", "request URLs", "fail", plainMessage(error), `check that the Slack app's Request URLs are ${outputs.SlackEventsUrl} and ${outputs.SlackInteractivityUrl}, and the control plane's SlackIngress logs`));
    }
  }

  const channel = progress?.project?.channelName;
  if (channel === undefined) {
    checks.push(check("slack", "bound channels", "skip", "agentx init recorded no bound channel; channels bound later are not listed until the control plane can report them"));
    return checks;
  }
  const found = await services.slackChannels.find(token, channel);
  const bot = auth.user ?? "the bot";
  if (found === undefined) checks.push(check("slack", `#${channel}`, "fail", "the channel no longer exists, or it is private and the bot is not in it", `in #${channel}, type /invite @${bot}, or bind another channel with agentx --env ${env} channel add`));
  else if (!found.isMember) checks.push(check("slack", `#${channel}`, "fail", "the bot is not a member", `in #${channel}, type /invite @${bot}`));
  else checks.push(check("slack", `#${channel}`, "ok", "the bot is a member"));
  return checks;
}
