import { z } from "zod";
import { companyScoped, IMPLICIT_COMPANY_ID, OrgIdSchema } from "@agentx/contracts";
import type { JWTVerifyGetKey } from "jose";
import type { CompanySignInStore } from "./company-membership.js";
import { oidcSignInProvider, type SignInProvider } from "./providers.js";

export const CompanyIssuerSettings = z.object({
  issuer: z.string().max(2048).url().refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.username === "" && url.password === "" && url.search === "" && url.hash === "";
    } catch { return false; }
  }),
  clientId: z.string().min(1).max(256), displayName: z.string().min(1).max(80),
  requiredClaim: z.string().min(1).max(128).optional(), requiredValues: z.array(z.string().min(1).max(128)).max(32), enabled: z.boolean(),
  since: z.number().finite().nonnegative().optional(),
}).strict();
export const CompanyIssuerRecord = CompanyIssuerSettings.extend({ entityType: z.literal("COMPANY_SIGNIN_ISSUER"), enabledSince: z.number().finite().nonnegative() }).strict();
export const companyIssuerKey = (companyId: string) => ({ pk: companyScoped(OrgIdSchema.parse(companyId), "SIGNIN_ISSUER"), sk: "OIDC" });
// T6 must add this family to COMPANY_SECRET_PATHS at merge. A stored record cannot choose a secret.
const COMPANY_SECRET_FAMILY = "org-signin";
export function companyIssuerSecretName(env: string, companyId: string): string {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(env) || !OrgIdSchema.safeParse(companyId).success) throw new Error("company sign-in unavailable");
  return `agentx/${env}/${COMPANY_SECRET_FAMILY}/${companyId}/oidc`;
}
export interface SelectedCompanyIssuer { provider: SignInProvider; issuer: string; since: number }

/** Every selection rereads the config. The bounded cache holds providers, never membership. */
export function companyIssuerProvider(input: {
  store: CompanySignInStore; env: string; readSecret: (name: string) => Promise<string>; fetch: typeof fetch;
  jwksFor: (uri: string) => JWTVerifyGetKey; now: () => number;
}): (companyId: string) => Promise<SelectedCompanyIssuer | undefined> {
  const cache = new Map<string, { version: string; selected: SelectedCompanyIssuer }>();
  return async (companyId) => {
    if (companyId === IMPLICIT_COMPANY_ID || !OrgIdSchema.safeParse(companyId).success) return undefined;
    const key = companyIssuerKey(companyId);
    const parsed = CompanyIssuerRecord.extend({ pk: z.literal(key.pk), sk: z.literal("OIDC") }).safeParse(await input.store.read(key));
    if (!parsed.success || !parsed.data.enabled || (parsed.data.requiredValues.length > 0 && parsed.data.requiredClaim === undefined)) {
      cache.delete(companyId); return undefined;
    }
    const record = parsed.data;
    const version = JSON.stringify(record);
    const current = cache.get(companyId);
    if (current?.version === version) return current.selected;
    const selected: SelectedCompanyIssuer = {
      issuer: record.issuer.replace(/\/+$/, ""), since: Math.max(record.enabledSince, record.since ?? 0),
      provider: oidcSignInProvider({
        issuer: record.issuer, clientId: record.clientId, requiredValues: record.requiredValues,
        ...(record.requiredClaim === undefined ? {} : { requiredClaim: record.requiredClaim }),
        clientSecret: () => input.readSecret(companyIssuerSecretName(input.env, companyId)),
        fetch: input.fetch, jwksFor: input.jwksFor, now: input.now,
        // Deliberately no administrator mapping: only the install's own issuer has it.
      }),
    };
    if (!cache.has(companyId) && cache.size >= 50) cache.delete(cache.keys().next().value!);
    cache.set(companyId, { version, selected });
    return selected;
  };
}
