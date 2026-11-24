// A registry's credential, made for one registry at the moment the worker's preparation asks (A1/P1a: the broker half of N9, `fb9b446fe`, written for today's core).
//   - CodeArtifact (a project's entry): a token the broker's own identity gets for the bound domain, asked for with a duration and nothing else. It must parse, not be expired and not outlive
//     REGISTRY_TOKEN_SECONDS (plus a minute of clock skew): a minter that answers with a longer-lived token is refused, because a registry token cannot be revoked.
//   - A company's package token (`CompanyRegistryStore.token`; owner decision 254zzz434): the company's install secret for that registry's host, read now, handed on for this one preparation and kept nowhere.
//     A personal access token has NO expiry of its own, so none is made up for it: the credential carries no `expiresAt`, and what bounds it is the preparation (the grant, the live PREPARE, the count).
//   - A failure is one fixed sentence that names the registry. What the service said (an AWS error, a path, the credential's value) is never carried.
import { REGISTRY_TOKEN_SECONDS, RegistryCredentialSchema, agentXError, type CompanyRegistryEntry, type PrivateRegistryHost, type ProjectRegistry, type RegistryCredential } from "@agentx/contracts";

export interface CodeArtifactTokenRequest { domain: string; domainOwner: string; region: string; durationSeconds: number }
export interface MintedToken { token: string; expiresAt: Date; username?: string }
export interface StoredRegistryCredential { token: string; username?: string }

/** The broker's own AWS identity as a CodeArtifact token source. */
export type CodeArtifactMinter = (request: CodeArtifactTokenRequest) => Promise<MintedToken>;

/**
 * A company's package tokens. `entries` is what the company set (host and scopes: never a value); `token` is the ONE reader of a stored value (the exchange is its only caller): the secret named by
 * `companyRegistrySecretName` for that company and host, or undefined when none is saved. Both are for the company the caller names, which is the company of the run's own records.
 */
export interface CompanyRegistryStore {
  entries(companyId: string): Promise<readonly CompanyRegistryEntry[]>;
  token(companyId: string, host: PrivateRegistryHost): Promise<StoredRegistryCredential | undefined>;
}

export const REGISTRY_UNAVAILABLE_MESSAGE = (registry: string): string => `Rovara could not get a token for the package registry "${registry}". Check the registry's settings and the install's access, then try again.`;
const CLOCK_SKEW_MS = 60_000;
/** CodeArtifact's token is used with the user name `aws` (python-configure-pip.html, maven-mvn.html). */
export const CODEARTIFACT_USERNAME = "aws";

const refuse = (registry: string): never => { throw agentXError("RUNTIME_UNAVAILABLE", REGISTRY_UNAVAILABLE_MESSAGE(registry)); };

export async function mintCodeArtifactCredential(entry: ProjectRegistry, minter: CodeArtifactMinter | undefined, now: () => Date = () => new Date()): Promise<RegistryCredential> {
  let minted: MintedToken;
  try {
    if (minter === undefined) return refuse(entry.name);
    minted = await minter({ domain: entry.domain, domainOwner: entry.domainOwner, region: entry.region, durationSeconds: REGISTRY_TOKEN_SECONDS });
  } catch {
    return refuse(entry.name);
  }
  const lifetime = minted.expiresAt.getTime() - now().getTime();
  if (lifetime <= 0 || lifetime > REGISTRY_TOKEN_SECONDS * 1_000 + CLOCK_SKEW_MS) return refuse(entry.name);
  const parsed = RegistryCredentialSchema.safeParse({ username: minted.username ?? CODEARTIFACT_USERNAME, token: minted.token, expiresAt: minted.expiresAt.toISOString() });
  return parsed.success ? parsed.data : refuse(entry.name);
}

/** The company's token for a host, as a credential with no expiry. `registry` is the name the worker asked by (for the sentence only). */
export async function companyRegistryCredential(store: Pick<CompanyRegistryStore, "token"> | undefined, companyId: string, host: PrivateRegistryHost, registry: string): Promise<RegistryCredential> {
  let held: StoredRegistryCredential | undefined;
  try {
    held = await store?.token(companyId, host);
  } catch {
    return refuse(registry);
  }
  if (held === undefined) return refuse(registry);
  const parsed = RegistryCredentialSchema.safeParse({ token: held.token, ...(held.username === undefined ? {} : { username: held.username }) });
  return parsed.success ? parsed.data : refuse(registry);
}
