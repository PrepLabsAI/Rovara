// Points a GitHub App's webhook at the control plane. The signing secret has two homes. Webhook lane W3: once the environment's DEDICATED webhook secret (agentx/<env>/github-webhook-secret,
// created empty by the control-plane stack, filled by the owner with put-secret-value) has a value, that value is the owner's and this code NEVER touches the secret again: it sends GitHub
// the URL only (no secret), and neither generates nor stores a key in the App's secret. Until the dedicated secret has a value, the old behaviour stands: the secret lives in the App's
// Secrets Manager secret (key webhookSecret), an existing valid one is reused, never rotated. In both modes it is never printed, logged or put in an error.
import { randomBytes } from "node:crypto";
import { agentXError } from "@agentx/contracts";
import type { InitSecrets } from "../init/context.js";
import { appSettingsUrl, GITHUB_WEBHOOK_EVENTS, type GitHubApi } from "../init/github-app.js";

/** The broker refuses a webhook secret shorter than this (packages/broker/src/github-app.ts). */
const MIN_SECRET_LENGTH = 32;
const MAX_SECRET_BYTES = 4_096;

export interface EnsureGithubWebhookInput {
  /** The App's own JWT. */
  appJwt: string;
  api: GitHubApi;
  secrets: Pick<InitSecrets, "get" | "put" | "hasValue">;
  /** The App secret's name or ARN. */
  secretId: string;
  /** The environment's dedicated webhook secret (githubWebhookSecretName). When it has a value, the owner's secret stands and none is sent or stored here. */
  dedicatedSecretId?: string;
  webhookUrl: string;
}

export interface GithubWebhookOutcome {
  /** "configured": the secret was generated or the hook's settings were changed. "unchanged": both already looked right
   * (the secret is sent to GitHub either way, since GitHub does not show its copy). */
  status: "configured" | "unchanged";
  /** Events the App is not subscribed to. GitHub's API cannot add them: the App's settings page can. */
  missingEvents: string[];
  settingsUrl: string;
  /** The hook had no URL or another one: an App made by an older release had no webhook, and GitHub's API cannot switch
   * its Active flag on. */
  urlChanged: boolean;
  /** The App's general settings page, where Active is. */
  appUrl: string;
  /** "dedicated": the owner's webhook secret has a value, so no secret was sent to GitHub or stored. "app-secret": the App secret's key was used (older installs and installs awaiting the owner's step). */
  secretSource: "dedicated" | "app-secret";
}

/** The webhook secret in a stored App secret's JSON, when it is one the broker accepts. */
export function storedWebhookSecret(value: Record<string, unknown>): string | undefined {
  const secret = typeof value.webhookSecret === "string" ? value.webhookSecret.trim() : "";
  return secret.length >= MIN_SECRET_LENGTH && Buffer.byteLength(secret, "utf8") <= MAX_SECRET_BYTES ? secret : undefined;
}

/** A secret's JSON object. Never throws a parser error: V8's SyntaxError quotes part of its input. */
function secretObject(raw: string | undefined, secretId: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw ?? "") as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* the one message below; never echo the value */ }
  throw agentXError("CONFIG_INVALID", `secret ${secretId} is not an AgentX GitHub App secret, so its webhook cannot be set up`);
}

export async function ensureGithubWebhook(input: EnsureGithubWebhookInput): Promise<GithubWebhookOutcome> {
  const { appJwt, api, secrets, secretId, webhookUrl } = input;
  // DescribeSecret only (never a value read): does the owner's dedicated secret have a value? Then nothing here may overwrite GitHub's copy of it.
  const dedicated = input.dedicatedSecretId !== undefined && await secrets.hasValue(input.dedicatedSecretId);
  if (dedicated) return pointHookAtControlPlane({ appJwt, api, webhookUrl, secretSource: "dedicated" });
  // Raw JSON, merged: keys this code does not know (the private key, the App's id) stay as they are.
  const stored = secretObject(await secrets.get(secretId), secretId);
  const existing = storedWebhookSecret(stored);
  const secret = existing ?? randomBytes(32).toString("hex");
  // Stored before GitHub is told, so the broker never gets a signed delivery it cannot verify.
  if (existing === undefined) {
    try {
      await secrets.put(secretId, JSON.stringify({ ...stored, webhookSecret: secret }));
    } catch (error) {
      // Only the error's name: never its message or cause, which could echo the request.
      throw agentXError("RUNTIME_UNAVAILABLE", `could not store the webhook secret in ${secretId} (${error instanceof Error ? error.name : "unknown error"})`);
    }
  }
  return pointHookAtControlPlane({ appJwt, api, webhookUrl, secretSource: "app-secret", secret, alreadyStored: existing !== undefined });
}

/** Sets the hook's URL (and, for the App secret's key only, the secret), then reads which events the App lacks. `secret` is absent in dedicated mode: the request then carries none. */
async function pointHookAtControlPlane(input: { appJwt: string; api: GitHubApi; webhookUrl: string; secretSource: GithubWebhookOutcome["secretSource"]; secret?: string; alreadyStored?: boolean }): Promise<GithubWebhookOutcome> {
  const { appJwt, api, webhookUrl } = input;
  const current = await api.getHookConfig(appJwt);
  const dedicated = input.secretSource === "dedicated";
  const hookRight = (dedicated || input.alreadyStored === true) && current.url === webhookUrl && current.contentType === "json" && current.insecureSsl === "0";
  // The App secret's key is always sent: GitHub masks its copy of the secret, so a hook holding a different one cannot be told from a right one. The dedicated secret is never sent, and a
  // hook that already points at the control plane is left alone.
  if (!dedicated) await api.setHookConfig(appJwt, { url: webhookUrl, secret: input.secret! });
  else if (!hookRight) await api.setHookConfig(appJwt, { url: webhookUrl });
  const app = await api.getApp(appJwt);
  const subscribed = new Set(app.events ?? []);
  return {
    status: hookRight ? "unchanged" : "configured",
    missingEvents: GITHUB_WEBHOOK_EVENTS.filter((event) => !subscribed.has(event)),
    settingsUrl: `${appSettingsUrl(app.owner, app.slug)}/permissions`,
    urlChanged: current.url !== webhookUrl,
    appUrl: appSettingsUrl(app.owner, app.slug),
    secretSource: input.secretSource,
  };
}

/** What init and upgrade print for events the App lacks; never the secret. */
export function missingEventsLine(outcome: GithubWebhookOutcome): string | undefined {
  return outcome.missingEvents.length === 0 ? undefined : `GitHub webhook: tick these events on ${outcome.settingsUrl}: ${outcome.missingEvents.join(", ")}`;
}

/** What init and upgrade print when the hook was just pointed at the control plane: it may still be switched off. */
export function activeHintLine(outcome: GithubWebhookOutcome): string | undefined {
  return outcome.status === "configured" && outcome.urlChanged ? `GitHub webhook: turn on Active at ${outcome.appUrl} if it is off` : undefined;
}
