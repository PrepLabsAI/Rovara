import { AwsJsonClient, type CredentialSource, type WireTransport } from "./aws.js";
import type { ProviderKeys } from "./provider.js";

/**
 * The provider key, read at run time from Secrets Manager by the secret's ARN (GATEWAY_ANTHROPIC_KEY_SECRET), with the serving
 * task's own role. Held in memory for a short while (a rotated key is picked up within PROVIDER_KEY_CACHE_MS), one read at a
 * time. The value is never logged and never put in an error: every failure is the same fixed message.
 */
export const PROVIDER_KEY_CACHE_MS = 5 * 60_000;
const SECRET_ARN = /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]{1,512}$/u;

export class ProviderKeyUnavailable extends Error { constructor() { super("provider key unavailable"); this.name = "ProviderKeyUnavailable"; } }

export interface SecretsOptions { region: string; credentials: CredentialSource; secretArns: { anthropic: string }; transport?: WireTransport; endpoint?: string; now?: () => number; cacheMs?: number }

export function createSecretsManagerKeys(options: SecretsOptions): ProviderKeys {
  if (!SECRET_ARN.test(options.secretArns.anthropic)) throw new Error("invalid provider key secret");
  const client = new AwsJsonClient({ region: options.region, service: "secretsmanager", targetPrefix: "secretsmanager", contentType: "application/x-amz-json-1.1", credentials: options.credentials, ...(options.transport === undefined ? {} : { transport: options.transport }), ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }), ...(options.now === undefined ? {} : { now: options.now }) });
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? PROVIDER_KEY_CACHE_MS;
  let cached: { value: string; readAt: number } | undefined;
  let pending: Promise<string> | undefined;
  const read = async (): Promise<string> => {
    try {
      const answer = await client.call("GetSecretValue", { SecretId: options.secretArns.anthropic });
      const value = typeof answer.SecretString === "string" ? answer.SecretString.trim() : "";
      if (value.length < 6 || value.length > 8192 || /[\r\n]/u.test(value)) throw new ProviderKeyUnavailable();
      cached = { value, readAt: now() };
      return value;
    } catch { throw new ProviderKeyUnavailable(); }
    finally { pending = undefined; }
  };
  return {
    async keyFor(_claims, provider, signal) {
      if (provider !== "anthropic") throw new ProviderKeyUnavailable();
      if (cached !== undefined && now() - cached.readAt < cacheMs && now() >= cached.readAt) return cached.value;
      if (signal?.aborted) throw new ProviderKeyUnavailable();
      pending ??= read();
      const shared = pending;
      if (signal === undefined) return shared;
      return new Promise<string>((resolve, reject) => {
        const abort = () => reject(new ProviderKeyUnavailable());
        signal.addEventListener("abort", abort, { once: true });
        void shared.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      });
    },
  };
}
