// Points a GitHub App's webhook at the control plane. The signing secret lives only in the App's
// Secrets Manager secret (key webhookSecret): an existing valid one is reused, never rotated, and
// it is never printed, logged or put in an error.
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
  secrets: Pick<InitSecrets, "get" | "put">;
  /** The App secret's name or ARN. */
  secretId: string;
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
  const current = await api.getHookConfig(appJwt);
  const hookRight = existing !== undefined && current.url === webhookUrl && current.contentType === "json" && current.insecureSsl === "0";
  // Always sent: GitHub masks its copy of the secret, so a hook holding a different one cannot be told from a right one.
  await api.setHookConfig(appJwt, { url: webhookUrl, secret });
  const app = await api.getApp(appJwt);
  const subscribed = new Set(app.events ?? []);
  return {
    status: hookRight ? "unchanged" : "configured",
    missingEvents: GITHUB_WEBHOOK_EVENTS.filter((event) => !subscribed.has(event)),
    settingsUrl: `${appSettingsUrl(app.owner, app.slug)}/permissions`,
    urlChanged: current.url !== webhookUrl,
    appUrl: appSettingsUrl(app.owner, app.slug),
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
