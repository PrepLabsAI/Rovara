import { OrgIdSchema } from "@agentx/contracts";
import { COMPANY_SECRET_TAG_KEY } from "./company-names.js";
import { SecretsManagerSecretError } from "./index.js";

export interface CompanySessionRequest {
  sessionName: string;
  tags: Array<{ Key: string; Value: string }>;
  durationSeconds: number;
}
export interface CompanySession {
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string };
  /** Epoch milliseconds, like Date.now(). */
  expiresAt: number;
}

/** The host injects STS and client creation. This package neither acquires credentials nor depends on STS. */
export function createCompanyClientFactory<Client>(options: {
  assumeRole: (request: CompanySessionRequest) => Promise<CompanySession>;
  clientFrom: (credentials: CompanySession["credentials"]) => Client;
  now?: () => number;
}): (companyId: string) => Promise<Client> {
  const now = options.now ?? Date.now;
  const cache = new Map<string, { client: Client; expiresAt: number }>();
  const pending = new Map<string, Promise<Client>>();
  return async (companyId) => {
    if (!OrgIdSchema.safeParse(companyId).success) throw new SecretsManagerSecretError("the secret reference is not valid");
    const cached = cache.get(companyId);
    if (cached !== undefined && now() < cached.expiresAt - 60_000) return cached.client;
    const active = pending.get(companyId);
    if (active !== undefined) return active;
    const task = (async () => {
      try {
        const session = await options.assumeRole({ sessionName: "rovara-company-secrets", tags: [{ Key: COMPANY_SECRET_TAG_KEY, Value: companyId }], durationSeconds: 900 });
        if (!Number.isFinite(session.expiresAt) || session.expiresAt <= now() + 60_000) throw new Error("expired session");
        for (const value of [session.credentials.accessKeyId, session.credentials.secretAccessKey, session.credentials.sessionToken]) {
          if (typeof value !== "string" || value.length === 0) throw new Error("invalid credentials");
        }
        const client = options.clientFrom(session.credentials);
        cache.set(companyId, { client, expiresAt: session.expiresAt });
        return client;
      } catch {
        cache.delete(companyId);
        throw new SecretsManagerSecretError("the secrets service could not be reached");
      }
    })();
    pending.set(companyId, task);
    try { return await task; } finally { pending.delete(companyId); }
  };
}
