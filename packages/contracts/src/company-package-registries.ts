// The company's package tokens, the WRITE side (PRIVATE-PACKAGES P1b, owner decision 254zzz434; the read side is project-registries.ts and the broker's exchange).
//
//   GET    /v1/app/company/package-registries   any live company member   -> { registries: [one status per supported host] }   (status only: NEVER a value)
//   PUT    /v1/app/company/package-registries   live owner or admin        { requestId, expectedRevision, host, scopes, token } -> the host's status
//   DELETE /v1/app/company/package-registries   live owner or admin        { requestId, expectedRevision, host }                -> the host's status (the secret waits 7 days to be deleted)
//
// No route, command or tool returns the stored token to any caller: the only reader is the install exchange (`/registry-credentials`). The token is in the PUT body only; nothing logs a body.
import { z } from "zod";
import { PRIVATE_REGISTRY_HOSTS, REGISTRIES_MAX, REGISTRY_TOKEN_MAX_LENGTH, REGISTRY_TOKEN_MIN_LENGTH, RegistryScopeSchema } from "./project-registries.js";

export const COMPANY_PACKAGE_REGISTRIES_PATH = "/v1/app/company/package-registries";
/** The audit actions: who, when, host and scopes, never the value. */
export const COMPANY_REGISTRY_AUDIT = { set: "package_registry.token_set", replace: "package_registry.token_replaced", delete: "package_registry.token_deleted", refused: "package_registry.token_refused", restored: "package_registry.secret_restored", adopted: "package_registry.secret_adopted" } as const;
/** How long a deleted token's secret waits before it is gone (the secrets service's recovery window, in days). */
export const COMPANY_REGISTRY_RECOVERY_DAYS = 7;
/** The classic token GitHub Packages' npm registry takes, and the one scope it may hold. */
export const GITHUB_PACKAGES_READ_SCOPE = "read:packages";
/** The only scopes a token may hold BESIDE read:packages (harmless reads: GitHub's docs say read:packages alone installs even a private repository's packages). Anything else is refused. */
export const GITHUB_PACKAGES_ALLOWED_EXTRA_SCOPES = ["read:org", "read:user", "user:email"] as const;

const HostSchema = z.string().min(1).max(253);
const RequestIdSchema = z.string().uuid();
const RevisionSchema = z.number().int().min(0).max(1_000_000);

export const CompanyRegistryPutBodySchema = z.object({
  requestId: RequestIdSchema,
  expectedRevision: RevisionSchema,
  host: HostSchema,
  scopes: z.array(RegistryScopeSchema).min(1).max(REGISTRIES_MAX).refine((scopes) => new Set(scopes).size === scopes.length),
  token: z.string().min(REGISTRY_TOKEN_MIN_LENGTH).max(REGISTRY_TOKEN_MAX_LENGTH),
}).strict();
export type CompanyRegistryPutBody = z.infer<typeof CompanyRegistryPutBodySchema>;

export const CompanyRegistryDeleteBodySchema = z.object({ requestId: RequestIdSchema, expectedRevision: RevisionSchema, host: HostSchema }).strict();
export type CompanyRegistryDeleteBody = z.infer<typeof CompanyRegistryDeleteBodySchema>;

/** One host's status line. `setAt` and `setBy` (a person's Rovara id) are there when a token is set or being removed. Never a token, a length or a hash of one. */
export const CompanyRegistryStatusSchema = z.object({
  host: z.enum(Object.keys(PRIVATE_REGISTRY_HOSTS) as [keyof typeof PRIVATE_REGISTRY_HOSTS]),
  state: z.enum(["not_set", "set", "being_removed"]),
  revision: RevisionSchema,
  scopes: z.array(RegistryScopeSchema),
  setAt: z.string().datetime().optional(),
  setBy: z.string().min(1).max(128).optional(),
  removedAt: z.string().datetime().optional(),
}).strict();
export type CompanyRegistryStatus = z.infer<typeof CompanyRegistryStatusSchema>;
export const CompanyRegistriesViewSchema = z.object({ registries: z.array(CompanyRegistryStatusSchema) }).strict();
export type CompanyRegistriesView = z.infer<typeof CompanyRegistriesViewSchema>;

/** Fixed sentences. None echoes a value a caller sent. */
export const COMPANY_REGISTRY_WORDS = {
  adminOnly: "Only a company owner or admin can change the company's package tokens.",
  bodyInvalid: "Send the registry host, the npm scopes it serves and the token, as the form does.",
  hostUnsupported: "Rovara can hold a package token for GitHub Packages (npm.pkg.github.com) only, for now.",
  tokenShape: "GitHub Packages' npm registry needs a classic personal access token (it starts with ghp_).",
  tokenFineGrained: "GitHub Packages' npm registry needs a classic token, not a fine-grained one.",
  scopesTooBroad: "That token can do more than read packages. Use a classic token with the read:packages scope (read:org, read:user and user:email are also fine and nothing else), made by a machine user that can only read packages.",
  scopesMissing: "That token does not have the read:packages scope. Use a classic token with the read:packages scope (read:org, read:user and user:email are also fine and nothing else).",
  tokenRejected: "GitHub did not accept this token.",
  unchecked: "Rovara could not check this token with GitHub just now, so nothing was saved. Try again.",
  stale: "This setting changed since you loaded it. Reload and try again.",
  beingRemoved: "this connection is being removed; remove it again, then add a new one",
  notSet: "No package token is set for that host.",
  unavailable: "The company's package token settings could not be read or saved just now. Nothing was changed. Try again.",
  auditUnavailable: "That could not be recorded, so nothing was changed. Try again.",
} as const;
