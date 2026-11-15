import { CreateSecretCommand, DeleteSecretCommand, GetSecretValueCommand, PutSecretValueCommand, type TagResourceCommand } from "@aws-sdk/client-secrets-manager";
import { OrgIdSchema, TEST_ACCOUNT_SECRET_TAG_KEYS } from "@agentx/contracts";
import { companyOfSecretName, COMPANY_SECRET_TAG_KEY } from "./company-names.js";
import { isAwsSecretName, SecretsManagerSecretError } from "./index.js";

export type ConnectionSecretsCommand = CreateSecretCommand | DeleteSecretCommand | GetSecretValueCommand | PutSecretValueCommand | TagResourceCommand;
export interface ConnectionSecretsClient {
  send(command: ConnectionSecretsCommand): Promise<{ VersionId?: string | undefined; SecretString?: string | undefined; SecretBinary?: Uint8Array | undefined }>;
}
const invalid = (): SecretsManagerSecretError => new SecretsManagerSecretError("the secret reference is not valid");
const errorName = (error: unknown): string => error instanceof Error ? error.name : "";
function serviceError(error: unknown): SecretsManagerSecretError {
  if (errorName(error) === "AccessDeniedException") return new SecretsManagerSecretError("the secrets service refused this operation");
  if (errorName(error) === "InvalidRequestException") return new SecretsManagerSecretError("this connection is being removed; remove it again, then add a new one");
  return new SecretsManagerSecretError("the secrets service could not be reached");
}
const missing = (error: unknown): boolean => ["ResourceNotFoundException", "InvalidRequestException"].includes(errorName(error));

/** Structural ConnectionSecrets implementation: no broker dependency. Hosted wiring belongs to R2. */
export function createSecretsManagerConnectionSecrets(options: { env: string; clientFor: (companyId: string) => ConnectionSecretsClient | Promise<ConnectionSecretsClient> }) {
  if (typeof options.env !== "string" || options.env.length > 128 || !/^[A-Za-z0-9_-]+$/u.test(options.env)) throw invalid();
  const prefix = `agentx/${options.env}/`;
  function belongs(company: string, name: string): boolean {
    if (!OrgIdSchema.safeParse(company).success || !isAwsSecretName(name) || !name.startsWith(prefix)) throw invalid();
    const relative = name.slice(prefix.length);
    const parsed = companyOfSecretName(relative);
    const parts = relative.split("/");
    if (parsed === undefined || (parsed.path !== "org-connectors" && parsed.path !== "org-hooks") || parts.length !== 3 || !/^[A-Za-z0-9_-]{1,128}$/u.test(parts[2]!)) throw invalid();
    return parsed.company === company;
  }
  function admit(company: string, name: string): void {
    if (!belongs(company, name)) throw new SecretsManagerSecretError("that secret does not belong to this company");
  }
  return {
    async read(company: string, name: string, versionId?: string): Promise<string | undefined> {
      if (!belongs(company, name)) return undefined;
      if (versionId !== undefined && (typeof versionId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(versionId))) throw invalid();
      let result;
      try {
        const client = await options.clientFor(company);
        result = await client.send(new GetSecretValueCommand({ SecretId: name, ...(versionId === undefined ? {} : { VersionId: versionId }) }));
      } catch (error) { if (missing(error)) return undefined; throw serviceError(error); }
      if (result.SecretBinary !== undefined) throw new SecretsManagerSecretError("the secret is not text");
      return result.SecretString;
    },
    async put(company: string, name: string, value: string): Promise<string> {
      admit(company, name);
      const parsed = companyOfSecretName(name.slice(prefix.length));
      if (typeof value !== "string") throw invalid();
      if (Buffer.byteLength(value, "utf8") > 16_384) throw new SecretsManagerSecretError("secret: that is too long to be a key or a token");
      try {
        const client = await options.clientFor(company);
        let result;
        try {
          result = await client.send(new CreateSecretCommand({ Name: name, SecretString: value, Tags: [
            { Key: COMPANY_SECRET_TAG_KEY, Value: company }, { Key: TEST_ACCOUNT_SECRET_TAG_KEYS.use, Value: parsed?.path === "org-hooks" ? "hook" : "connector" },
          ] }));
        } catch (error) {
          if (errorName(error) !== "ResourceExistsException") throw error;
          result = await client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
        }
        if (typeof result.VersionId !== "string" || result.VersionId.length === 0) throw invalid();
        return result.VersionId;
      } catch (error) { throw serviceError(error); }
    },
    async scheduleDelete(company: string, name: string): Promise<void> {
      admit(company, name);
      try {
        const client = await options.clientFor(company);
        await client.send(new DeleteSecretCommand({ SecretId: name, RecoveryWindowInDays: 7 }));
      } catch (error) { if (errorName(error) !== "ResourceNotFoundException") throw serviceError(error); }
    },
  };
}
