// The hosted company secret store (PRIVATE-PACKAGES P1b): `ConnectionSecrets` over Secrets Manager, every call made through a session of the CompanySecrets role tagged with ONE company (`rovara:org`).
//   - The role is the install's `COMPANY_SECRETS_ROLE_ARN` (infra/lib/company-secrets.ts: trust names only the broker's role, only with exactly the one company tag). With the variable missing or not a role ARN, nothing
//     is built ("package tokens are not set up on this install"): the route says so, and nothing falls back to the broker's own identity.
//   - One session per company, kept until a minute before it ends (the adapter's factory); never shared between companies, and the company id is checked (OrgIdSchema) BEFORE STS is asked.
//   - The name fence is IAM's AND the adapter's: the session can reach `agentx/<env>/org-connectors/<company>/...` only, and the adapter refuses a name outside the company's path before a call.
//   - An error is the adapter's fixed sentence, never STS's or Secrets Manager's own words (they can quote an ARN or a session name).
// The install's name for secrets: `AGENTX_ENV`, and "production" on the legacy install (which has no such variable), the same name the infrastructure gives the role's resources.
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createCompanyClientFactory, createSecretsManagerConnectionSecrets } from "@rovara/aws-adapters/secrets-manager";
import type { ConnectionSecretsClient } from "@rovara/aws-adapters/secrets-manager";
import type { ConnectionSecrets } from "../connections/org-secrets.js";
import type { RegistrySecretStore } from "../core/project-registries/company-registry-control.js";

const ROLE_ARN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/u;

export interface CompanySecretsSessionOptions {
  /** STS in tests. Absent: the real call, signed by the broker's own role. */
  assumeRole?: Parameters<typeof createCompanyClientFactory>[0]["assumeRole"];
  /** A client over a session's credentials in tests. Absent: Secrets Manager's own. */
  clientFrom?: (credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string }) => ConnectionSecretsClient;
  region?: string;
  now?: () => number;
}

const secretsClientFrom = (region: string | undefined) => (credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string }): ConnectionSecretsClient =>
  new SecretsManagerClient({ ...(region === undefined ? {} : { region }), maxAttempts: 2, credentials });

/** The install's secret-name environment: `AGENTX_ENV`, else "production" (the legacy install). */
export const companySecretsEnvOf = (environment: Readonly<Record<string, string | undefined>>): string => {
  const named = environment["AGENTX_ENV"];
  return named !== undefined && named !== "" ? named : "production";
};

/** The company secret store and the install's name for it, or `undefined` where the install has no company-secrets role. */
export function companySecretsFromEnvironment(environment: Readonly<Record<string, string | undefined>>, options: CompanySecretsSessionOptions = {}): { env: string; secrets: ConnectionSecrets & RegistrySecretStore } | undefined {
  const roleArn = environment["COMPANY_SECRETS_ROLE_ARN"];
  if (roleArn === undefined || !ROLE_ARN.test(roleArn)) return undefined;
  const region = options.region ?? environment["AWS_REGION"];
  const sts = options.assumeRole === undefined ? new STSClient({ ...(region === undefined ? {} : { region }) }) : undefined;
  const assumeRole = options.assumeRole ?? (async (request) => {
    const answer = await sts!.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: request.sessionName, DurationSeconds: request.durationSeconds, Tags: request.tags }));
    const credentials = answer.Credentials;
    if (credentials?.AccessKeyId === undefined || credentials.SecretAccessKey === undefined || credentials.SessionToken === undefined || credentials.Expiration === undefined) throw new Error("no credentials");
    return { credentials: { accessKeyId: credentials.AccessKeyId, secretAccessKey: credentials.SecretAccessKey, sessionToken: credentials.SessionToken }, expiresAt: credentials.Expiration.getTime() };
  });
  const env = companySecretsEnvOf(environment);
  const clientFor = createCompanyClientFactory({ assumeRole, clientFrom: options.clientFrom ?? secretsClientFrom(region), ...(options.now === undefined ? {} : { now: options.now }) });
  return { env, secrets: createSecretsManagerConnectionSecrets({ env, clientFor }) };
}
