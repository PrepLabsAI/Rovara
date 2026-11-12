// Convergence lane A3 (owner decision 72, O2): the `secrets` port over AWS Secrets Manager. Generic and public: it reads a secret by name and holds no company, money or authority rule
// beyond the one below (a company's own secret is read only for that company).
//
// The reference kind is `{ "awsSecret": "<name under the prefix>" }`. The full secret name is the configured `namePrefix` plus the value (`agentx/staging/` + `org-connectors/<company>/<id>`
// reads `agentx/staging/org-connectors/<company>/<id>`, the hosted product's own name, so no secret moves). The value is checked before any call: parts of plain characters joined by `/`, no
// `.` or `..` part, so a reference can never name a secret outside the prefix. Other kinds (`env`, `file`, `key`) answer `undefined`, as the port says.
//
// Company scope: a value whose first part is one of `companyPaths` (`org-connectors`, `org-hooks`) names a company's own secret, and its second part must be the company of the call, or the read
// is refused before AWS is asked. IAM is the second fence: a deployment that serves many companies gives `clientFor(companyId)` a client signed by a session that can reach only that company's
// secrets (the hosted product tags an AssumeRole session with the company).
//
// Read on every call (a rotation takes effect at once), never cached. A value is never logged and never put in an error: every refusal is a fixed `SecretsManagerSecretError` sentence (safe to show), and
// Secrets Manager's own error text (it can quote the secret's name or ARN) is never passed on.
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { SecretRefSchema, SecretValue, type SecretRef, type SecretStore } from "@agentx/contracts";

/**
 * A refusal with a FIXED sentence: it never quotes a reference's value, a secret's name or value, or the service's own words, so it is safe to show. (Code's broker shows it as its own
 * `LocalSecretError`; see the plug-in module.)
 */
export class SecretsManagerSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretsManagerSecretError";
  }
}

export const AWS_SECRET_REF_KIND = "awsSecret";
/** Secrets Manager's longest secret name. */
export const AWS_SECRET_NAME_MAX = 512;
const PART = /^[A-Za-z0-9_+=.@-]+$/u;
const PREFIX = /^(?:[A-Za-z0-9_+=.@-]+\/)*$/u;

export interface SecretsManagerClientLike {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string | undefined; SecretBinary?: Uint8Array | undefined }>;
}

export interface SecretsManagerSecretStoreOptions {
  /** Prefixes every name: `agentx/<env>/`, `rovara/`. Ends with `/`, or is empty (every name the identity can read). */
  namePrefix: string;
  /** The client for a call's company. One client for every company is `() => client`. */
  clientFor: (companyId: string) => SecretsManagerClientLike | Promise<SecretsManagerClientLike>;
  /** First parts that name a company's own secrets (`org-connectors`): the next part must be the company of the call. */
  companyPaths?: readonly string[];
}

const invalid = (): SecretsManagerSecretError => new SecretsManagerSecretError("the secret reference is not valid");

/** The value of an `awsSecret` reference is a relative name: parts joined by single slashes, no `.` or `..` part. */
export function isAwsSecretName(value: string): boolean {
  if (value.length === 0 || value.length > AWS_SECRET_NAME_MAX) return false;
  return value.split("/").every((part) => part !== "." && part !== ".." && PART.test(part));
}

export function createSecretsManagerSecretStore(options: SecretsManagerSecretStoreOptions): SecretStore {
  if (!PREFIX.test(options.namePrefix) || options.namePrefix.split("/").some((part) => part === "." || part === "..")) throw new SecretsManagerSecretError("the secret name prefix is parts of plain characters, each ending with /");
  const companyPaths = new Set(options.companyPaths ?? []);
  for (const path of companyPaths) if (!PART.test(path) || path === "." || path === "..") throw new SecretsManagerSecretError("a company path is one plain part of a secret name");
  return {
    async read(companyId: string, ref: SecretRef) {
      const parsed = SecretRefSchema.safeParse(ref);
      if (!parsed.success) throw invalid();
      const [kind, value] = Object.entries(parsed.data)[0] as [string, string];
      if (kind !== AWS_SECRET_REF_KIND) return undefined;
      if (!isAwsSecretName(value) || options.namePrefix.length + value.length > AWS_SECRET_NAME_MAX) throw invalid();
      const parts = value.split("/");
      if (companyPaths.has(parts[0]!) && (parts.length < 3 || parts[1] !== companyId)) throw new SecretsManagerSecretError("the secret reference names a secret of another company");
      let found: { SecretString?: string | undefined; SecretBinary?: Uint8Array | undefined };
      try {
        const client = await options.clientFor(companyId);
        found = await client.send(new GetSecretValueCommand({ SecretId: `${options.namePrefix}${value}` }));
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        // Not there, or scheduled for deletion (Secrets Manager refuses a read of a deleted secret as an invalid request): no secret.
        if (name === "ResourceNotFoundException" || name === "InvalidRequestException") return undefined;
        if (name === "AccessDeniedException") throw new SecretsManagerSecretError("the secrets service refused to read this secret");
        if (name === "DecryptionFailure") throw new SecretsManagerSecretError("the secret could not be decrypted (check the key policy of the secret's KMS key)");
        throw new SecretsManagerSecretError("the secrets service could not be reached");
      }
      if (found.SecretString === undefined) {
        if (found.SecretBinary !== undefined) throw new SecretsManagerSecretError("the secret is not text");
        return undefined;
      }
      const text = found.SecretString.trim();
      return text === "" ? undefined : new SecretValue(text);
    },
  };
}
