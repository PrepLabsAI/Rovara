// FR-050: the GitHub App installation and repository access. The private key signs one JWT in
// memory and is never written anywhere.
import { appSettingsUrl, GITHUB_WEBHOOK_EVENTS, githubAppJwt, githubAppSecretName, githubWebhookUrl, parseAppSecret } from "../init/github-app.js";
import { storedWebhookSecret } from "../github/webhook-setup.js";
import { plainMessage } from "../output.js";
import { check, type DoctorCheck, type DoctorContext } from "./checks.js";
import { jsonObject } from "./secrets.js";

const DELIVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether GitHub's webhook deliveries reach AgentX: ok when the latest delivery in the last 7 days went through; a warning
 * when there was none (the hook may be switched off, or nothing happened) or the latest one failed. Only the time, status
 * and HTTP code of each delivery are read.
 */
async function deliveriesCheck(context: DoctorContext, jwt: string, settingsPage: string): Promise<DoctorCheck> {
  const name = "GitHub webhook deliveries";
  const fix = `check that Active is on at ${settingsPage}; GitHub lists each delivery at ${settingsPage}/advanced`;
  let deliveries;
  try {
    deliveries = await context.services.github.listHookDeliveries(jwt);
  } catch (error) {
    return check("github", name, "warn", `could not read the App's recent webhook deliveries from GitHub: ${plainMessage(error)}`, "run agentx doctor again in a minute");
  }
  const since = context.services.now() - DELIVERY_WINDOW_MS;
  const recent = deliveries
    .map((delivery) => ({ ...delivery, at: Date.parse(delivery.deliveredAt) }))
    .filter((delivery) => Number.isFinite(delivery.at) && delivery.at >= since)
    .sort((left, right) => right.at - left.at);
  const latest = recent[0];
  if (latest === undefined) return check("github", name, "warn", "GitHub has delivered no event to AgentX in the last 7 days", fix);
  if (latest.statusCode >= 200 && latest.statusCode < 400 && latest.status === "OK") {
    return check("github", name, "ok", "GitHub delivered an event to AgentX in the last 7 days");
  }
  const answer = latest.statusCode > 0 ? `HTTP ${latest.statusCode}` : "it got no answer";
  return check("github", name, "warn", `GitHub's latest delivery to AgentX failed (${answer})`, fix);
}

export async function githubChecks(context: DoctorContext): Promise<DoctorCheck[]> {
  const { env, progress, services } = context;
  const raw = await services.secrets.get(githubAppSecretName(env));
  let app;
  try {
    if (raw === undefined) throw new Error("missing");
    app = parseAppSecret(raw, githubAppSecretName(env));
  } catch {
    return [check("github", "GitHub App", "skip", `the secret ${githubAppSecretName(env)} cannot be read; the secrets check says why`)];
  }
  const jwt = githubAppJwt({ appId: app.appId, privateKey: app.privateKey, nowSeconds: Math.floor(services.now() / 1000) });
  const appPage = `https://github.com/apps/${app.slug}`;
  let installations;
  try {
    installations = await services.github.listInstallations(jwt);
  } catch (error) {
    if (/\bHTTP 401\b/.test(plainMessage(error))) {
      return [check("github", "GitHub App", "fail", "GitHub refused the app's key (HTTP 401)", `generate a new private key on the app's settings page and store it in ${githubAppSecretName(env)}`)];
    }
    return [check("github", "GitHub App", "fail", `could not reach GitHub to list the app's installations: ${plainMessage(error)}`, "check this computer's network access to github.com, then run agentx doctor again")];
  }
  const wanted = progress?.github?.installationId;
  const installation = wanted === undefined
    ? installations.find((entry) => entry.account.login.toLowerCase() === app.account.toLowerCase())
    : installations.find((entry) => String(entry.id) === wanted);
  if (installation === undefined) {
    return [check("github", "GitHub App", "fail", `the GitHub App ${app.slug} is not installed on ${app.account}`, `install it again: ${appPage}/installations/new`)];
  }
  let count: number;
  try {
    const token = await services.github.installationToken(jwt, String(installation.id));
    count = await services.github.repositoryCount(token.token);
  } catch (error) {
    const message = plainMessage(error);
    // GitHub answers 403 or 404 for a suspended or removed installation; anything else is not blamed on it.
    const fix = /\bHTTP (403|404)\b/.test(message)
      ? "the installation may be suspended; check it in the installation settings on GitHub, then run agentx doctor again"
      : "run agentx doctor again in a minute; if it keeps failing, check githubstatus.com and the app's installation settings on GitHub";
    return [check("github", "GitHub App", "fail", `installed on ${installation.account.login}, but its repositories could not be read: ${message}`, fix)];
  }
  if (count === 0) return [check("github", "GitHub App", "fail", `installed on ${installation.account.login}, but it sees no repository`, "choose the repositories AgentX may use in the app's installation settings on GitHub")];
  return [check("github", "GitHub App", "ok", `installed on ${installation.account.login}, sees ${count} ${count === 1 ? "repository" : "repositories"}`)];
}

/** The App's webhook: where it sends events, which events, and whether the secret that verifies them is stored. Warnings, not
 * failures: nothing here stops AgentX working, and agentx upgrade fixes the first and the last. */
export async function githubWebhookChecks(context: DoctorContext): Promise<DoctorCheck[]> {
  const { env, settings, services } = context;
  const secretName = githubAppSecretName(env);
  const raw = await services.secrets.get(secretName);
  let app;
  try {
    if (raw === undefined) throw new Error("missing");
    app = parseAppSecret(raw, secretName);
  } catch {
    return [];
  }
  const upgradeFix = `run agentx --env ${env} upgrade: it`;
  const checks: DoctorCheck[] = [];
  let settingsPage: string | undefined;
  const expectedUrl = githubWebhookUrl(settings.controlPlaneUrl);
  const jwt = githubAppJwt({ appId: app.appId, privateKey: app.privateKey, nowSeconds: Math.floor(services.now() / 1000) });
  try {
    const hook = await services.github.getHookConfig(jwt);
    checks.push(hook.url === expectedUrl
      ? check("github", "GitHub webhook", "ok", `the App sends events to ${expectedUrl}`)
      : check("github", "GitHub webhook", "warn", hook.url === undefined ? `the App has no webhook URL; it should send events to ${expectedUrl}` : `the App sends events to ${hook.url}, not ${expectedUrl}`, `${upgradeFix} points the App's webhook at the control plane`));
    const githubApp = await services.github.getApp(jwt);
    const subscribed = githubApp.events ?? [];
    const missing = GITHUB_WEBHOOK_EVENTS.filter((event) => !subscribed.includes(event));
    settingsPage = appSettingsUrl(githubApp.owner, githubApp.slug);
    checks.push(missing.length === 0
      // GitHub's API does not say whether the hook is Active, so the page where it is switched on is always named.
      ? check("github", "GitHub webhook", "ok", `subscribed to pull request and comment events; check that Active is on at ${settingsPage}`)
      : check("github", "GitHub webhook", "warn", `the App is not subscribed to ${missing.join(", ")}`, `GitHub's API cannot add events: tick ${missing.join(", ")} at ${settingsPage}/permissions, and check that Active is on at ${settingsPage}`));
  } catch (error) {
    checks.push(check("github", "GitHub webhook", "warn", `could not read the App's webhook settings from GitHub: ${plainMessage(error)}`, "run agentx doctor again in a minute"));
  }
  checks.push(storedWebhookSecret(jsonObject(raw) ?? {}) === undefined
    ? check("github", "GitHub webhook secret", "warn", `${secretName} holds no webhook secret, so GitHub's deliveries cannot be verified`, `${upgradeFix} stores a webhook secret and gives it to GitHub`)
    : check("github", "GitHub webhook secret", "ok", "stored"));
  // Without the App's settings page (GitHub could not be asked above) the warning already says to try again.
  if (settingsPage !== undefined) checks.push(await deliveriesCheck(context, jwt, settingsPage));
  return checks;
}
