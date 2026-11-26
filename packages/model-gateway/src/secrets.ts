import { createHash } from "node:crypto";
import { AwsJsonClient, type CredentialSource, type WireTransport } from "./aws.js";
import type { CompanyKeyProvider, LearningKeySource } from "./learning-route.js";
import type { ProviderKeys } from "./provider.js";

/**
 * The provider key, read at run time from Secrets Manager by the secret's ARN (GATEWAY_ANTHROPIC_KEY_SECRET), with the serving
 * task's own role. Held in memory for a short while (a rotated key is picked up within PROVIDER_KEY_CACHE_MS), one read at a
 * time. The value is never logged and never put in an error: every failure is the same fixed message.
 */
export const PROVIDER_KEY_CACHE_MS = 5 * 60_000;
export const SECRET_ARN = /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]{1,512}$/u;

export class ProviderKeyUnavailable extends Error { constructor() { super("provider key unavailable"); this.name = "ProviderKeyUnavailable"; } }

export interface SecretsOptions { region: string; credentials: CredentialSource; secretArns: { anthropic: string }; transport?: WireTransport; endpoint?: string; now?: () => number; cacheMs?: number }

export type StandaloneKeyProvider = "anthropic" | "openai" | "openrouter";
export interface StandaloneSecretsOptions {
  region: string;
  credentials: CredentialSource;
  secretArns: Partial<Record<StandaloneKeyProvider, string>>;
  transport?: WireTransport;
  endpoint?: string;
  now?: () => number;
  cacheMs?: number;
}

function secretReader(options: { region: string; credentials: CredentialSource; arn: string; transport?: WireTransport; endpoint?: string; now?: () => number; cacheMs?: number }) {
  if (!SECRET_ARN.test(options.arn)) throw new Error("invalid provider key secret");
  const client = new AwsJsonClient({
    region: options.region, service: "secretsmanager", targetPrefix: "secretsmanager", contentType: "application/x-amz-json-1.1",
    credentials: options.credentials,
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? PROVIDER_KEY_CACHE_MS;
  let cached: { value: string; versionId: string; readAt: number } | undefined;
  let pending: Promise<{ value: string; versionId: string }> | undefined;
  const read = async (): Promise<{ value: string; versionId: string }> => {
    try {
      const answer = await client.call("GetSecretValue", { SecretId: options.arn });
      const value = typeof answer.SecretString === "string" ? answer.SecretString.trim() : "";
      if (value.length < 6 || value.length > 8192 || /[\r\n]/u.test(value)) throw new ProviderKeyUnavailable();
      const versionId = typeof answer.VersionId === "string" && answer.VersionId.length > 0 && answer.VersionId.length <= 128 ? answer.VersionId : "v1";
      cached = { value, versionId, readAt: now() };
      return { value, versionId };
    } catch { throw new ProviderKeyUnavailable(); }
    finally { pending = undefined; }
  };
  const get = async (signal?: AbortSignal): Promise<{ value: string; versionId: string }> => {
    if (cached !== undefined && now() - cached.readAt < cacheMs && now() >= cached.readAt) return { value: cached.value, versionId: cached.versionId };
    if (signal?.aborted) throw new ProviderKeyUnavailable();
    pending ??= read();
    const shared = pending;
    if (signal === undefined) return shared;
    return new Promise<{ value: string; versionId: string }>((resolve, reject) => {
      const abort = () => reject(new ProviderKeyUnavailable());
      signal.addEventListener("abort", abort, { once: true });
      void shared.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  };
  return { get, clear: () => { cached = undefined; } };
}

export function createSecretsManagerKeys(options: SecretsOptions): ProviderKeys {
  const reader = secretReader({ ...options, arn: options.secretArns.anthropic });
  return {
    async keyFor(_claims, provider, signal) {
      if (provider !== "anthropic") throw new ProviderKeyUnavailable();
      return (await reader.get(signal)).value;
    },
  };
}

/**
 * Standalone (self-hosted) provider keys backed by Secrets Manager ARNs for Anthropic, OpenAI and/or OpenRouter.
 * Implements LearningKeySource (including `identityFor` and `resolveForCharge`) so signed `runPrice` quotes and
 * revision-bound charge receipts work identically to Cloud's company-key mode without a Cloud Companies table.
 */
export function createStandaloneKeySource(options: StandaloneSecretsOptions): LearningKeySource {
  const readers = new Map<StandaloneKeyProvider, { sourceId: string; reader: ReturnType<typeof secretReader> }>();
  for (const provider of ["anthropic", "openai", "openrouter"] as const) {
    const arn = options.secretArns[provider];
    if (arn === undefined) continue;
    const sourceId = `standalone-${provider}-${createHash("sha256").update(arn).digest("hex").slice(0, 12)}`;
    readers.set(provider, { sourceId, reader: secretReader({ ...options, arn }) });
  }
  const forProvider = (provider: CompanyKeyProvider) => (provider === "anthropic" || provider === "openai" || provider === "openrouter") ? readers.get(provider) : undefined;
  return {
    async connected(_iss, _cid, provider) {
      return forProvider(provider) !== undefined;
    },
    async keyFor(_iss, _cid, provider, signal) {
      const entry = forProvider(provider);
      if (entry === undefined) return undefined;
      return (await entry.reader.get(signal)).value;
    },
    async identityFor(_iss, _cid, provider) {
      const entry = forProvider(provider);
      if (entry === undefined) return undefined;
      const { versionId } = await entry.reader.get();
      return { sourceId: entry.sourceId, versionId };
    },
    async resolveForCharge(_iss, _cid, provider, signal) {
      const entry = forProvider(provider);
      if (entry === undefined) return undefined;
      const { value, versionId } = await entry.reader.get(signal);
      return {
        source: { kind: "company_key", id: entry.sourceId, name: `Install ${provider}`, provider, connectionRevision: versionId },
        key: async () => value,
      };
    },
    refused(_iss, _cid, provider) {
      forProvider(provider)?.reader.clear();
    },
  };
}
