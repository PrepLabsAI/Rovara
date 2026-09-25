import { GetSecretValueCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  CONNECTOR_SECRET_PREFIX,
  CredentialRecordSchema,
  CredentialRegistrationSchema,
  agentXError,
  type CredentialListEntry,
  type CredentialRecord,
  type CredentialRegistration,
  type CredentialType,
} from "@agentx/contracts";
import {
  CredentialUnavailable,
  oauthClientCredentialsProvider,
  oauthRefreshTokenProvider,
  parseConnectorSecret,
  staticSecretProvider,
  type CachedToken,
  type CredentialProvider,
  type RefreshLease,
  type SecretSource,
  type SecretStore,
  type TokenCache,
} from "@agentx/gateway";
import type { AuthenticatedIdentity } from "../auth.js";

/**
 * How a deployment reads connector secrets, and the built-in GitHub App entry it lists first. A
 * store that can also write is needed only by oauth-refresh-token credentials, to save a rotated token.
 */
export interface ConnectorCredentialsConfiguration {
  secrets: SecretSource | SecretStore;
  githubApp: { ref: string; secretName: string };
  fetchImplementation?: typeof fetch;
  /** This deployment's connector secret prefix (naming.connectorSecretPrefix); defaults to CONNECTOR_SECRET_PREFIX. */
  connectorSecretPrefix?: string;
}

const REGISTRY_PK = "CREDENTIALS";
const RECORD_PREFIX = "REF#";
const TOKEN_PREFIX = "TOKEN#";
const LEASE_KEY = "LEASE#refresh";
const tokenPartition = (ref: string) => `CREDENTIAL#${ref}`;

/**
 * Reads a Secrets Manager secret, and replaces one for a rotated refresh token. A missing secret is
 * `undefined`; an access denial names only the secret. The broker role may write only secrets the
 * administrator tagged `agentx-writable: refresh-token` (see infra/lib/control-plane.ts).
 */
export function secretsManagerSource(client: {
  send(command: GetSecretValueCommand | PutSecretValueCommand): Promise<{ SecretString?: string; SecretBinary?: Uint8Array }>;
}): SecretStore {
  return {
    async write(name, value) {
      await client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
    },
    async read(name) {
      try {
        const response = await client.send(new GetSecretValueCommand({ SecretId: name }));
        if (response.SecretString !== undefined) return response.SecretString;
        return response.SecretBinary === undefined ? undefined : Buffer.from(response.SecretBinary).toString("utf8");
      } catch (error) {
        const errorName = error instanceof Error ? error.name : undefined;
        if (errorName === "ResourceNotFoundException") return undefined;
        if (errorName === "AccessDeniedException") {
          throw new CredentialUnavailable(`AgentX cannot read secret ${name}; connector secrets must be named with this deployment's connector prefix in this account and region, or its KMS key does not allow the AgentX broker`);
        }
        // These name a permanent problem with the secret itself (its ciphertext, its KMS key or
        // its deletion state), never a transient AWS fault, so a retry would never help.
        if (errorName === "DecryptionFailure" || errorName === "InvalidRequestException" || errorName === "InvalidParameterException") {
          throw new CredentialUnavailable(`secret ${name} cannot be decrypted or is scheduled for deletion`);
        }
        throw error;
      }
    },
  };
}

/** The oauth-refresh-token provider's optional margin-adjusted cutoff, kept only when it is a finite number. */
function finiteRefreshAt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Minted tokens shared across broker containers. An oauth-refresh-token entry's optional
 * `refreshAt` (its margin-adjusted cutoff) is kept alongside `token` and `expiresAt`. A cache failure is logged (never with the token)
 * and swallowed: the provider then simply mints again.
 */
export class DynamoTokenCache implements TokenCache {
  constructor(private readonly client: DynamoDBDocumentClient, private readonly tableName: string, private readonly ref: string) {}

  async get(key: string): Promise<CachedToken | undefined> {
    try {
      const response = await this.client.send(new GetCommand({ TableName: this.tableName, Key: this.key(key), ConsistentRead: true }));
      const item = response.Item as { token?: unknown; expiresAt?: unknown; refreshAt?: unknown } | undefined;
      if (typeof item?.token !== "string" || typeof item.expiresAt !== "number") return undefined;
      const refreshAt = finiteRefreshAt(item.refreshAt);
      return { token: item.token, expiresAt: item.expiresAt, ...(refreshAt === undefined ? {} : { refreshAt }) };
    } catch (error) {
      this.failed("get", error);
      return undefined;
    }
  }

  async put(key: string, value: CachedToken): Promise<void> {
    const refreshAt = finiteRefreshAt((value as { refreshAt?: unknown }).refreshAt);
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: { ...this.key(key), entityType: "CREDENTIAL_TOKEN", token: value.token, expiresAt: value.expiresAt, ...(refreshAt === undefined ? {} : { refreshAt }) },
      }));
    } catch (error) {
      this.failed("put", error);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteCommand({ TableName: this.tableName, Key: this.key(key) }));
    } catch (error) {
      this.failed("delete", error);
    }
  }

  private key(key: string) {
    return { pk: tokenPartition(this.ref), sk: `${TOKEN_PREFIX}${key}` };
  }

  /** Logs the error's class name only: an SDK message could quote request content. */
  private failed(operation: "get" | "put" | "delete", error: unknown): void {
    const errorName = error instanceof Error ? error.name : "unknown";
    console.log(JSON.stringify({ component: "broker", event: "connector.token_cache_failed", credential: this.ref, operation, error: errorName }));
  }
}

/**
 * One refresh at a time per refresh-token credential across broker containers: a conditional put
 * on `CREDENTIAL#<ref>` / `LEASE#refresh`. The current owner may re-acquire to renew (extend) its
 * own lease. A DynamoDB failure is logged (class name only) and treated as acquired, so an outage
 * cannot stop every refresh; the provider's re-read of the secret after a refused refresh covers
 * the race that allows.
 */
export class DynamoRefreshLease implements RefreshLease {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly ref: string,
    private readonly now: () => number = Date.now,
  ) {}

  async acquire(owner: string, ttlMs: number): Promise<boolean> {
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: { pk: tokenPartition(this.ref), sk: LEASE_KEY, entityType: "CREDENTIAL_LEASE", owner, expiresAt: this.now() + ttlMs },
        ConditionExpression: "attribute_not_exists(pk) OR expiresAt < :now OR #owner = :owner",
        ExpressionAttributeNames: { "#owner": "owner" },
        ExpressionAttributeValues: { ":now": this.now(), ":owner": owner },
      }));
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
      this.failed("acquire", error);
      return true;
    }
  }

  async release(owner: string): Promise<void> {
    try {
      await this.client.send(new DeleteCommand({
        TableName: this.tableName,
        Key: { pk: tokenPartition(this.ref), sk: LEASE_KEY },
        ConditionExpression: "#owner = :owner",
        ExpressionAttributeNames: { "#owner": "owner" },
        ExpressionAttributeValues: { ":owner": owner },
      }));
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return;
      this.failed("release", error);
    }
  }

  private failed(operation: "acquire" | "release", error: unknown): void {
    const errorName = error instanceof Error ? error.name : "unknown";
    console.log(JSON.stringify({ component: "broker", event: "connector.refresh_lease_failed", credential: this.ref, operation, error: errorName }));
  }
}

/**
 * The command that creates a credential of the type a connector needs: an oauth-refresh-token
 * credential comes from a bot user's one-time sign-in (authorize); every other type is registered
 * from an existing secret. An unstated need keeps the register hint.
 */
export function credentialSetupCommand(accepts: readonly CredentialType[] | undefined): string {
  const signIn = accepts !== undefined && accepts.length > 0 && accepts.every((type) => type === "oauth-refresh-token");
  return signIn ? "agentx admin credential authorize" : "agentx admin credential register";
}

/** Registered connector credentials: records name a secret, never hold one. */
export class CredentialRegistry {
  private readonly documentClient: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly now: () => number;
  /** One delegate per reference and token endpoint, replaced whenever the registration it was built from changes. */
  private readonly delegates = new Map<string, { registration: string; provider: CredentialProvider<unknown> }>();

  constructor(private readonly options: ConnectorCredentialsConfiguration & { documentClient: DynamoDBDocumentClient; tableName: string; now?: () => number }) {
    this.documentClient = options.documentClient;
    this.tableName = options.tableName;
    this.now = options.now ?? Date.now;
  }

  async register(identity: AuthenticatedIdentity, body: unknown): Promise<{ credential: CredentialListEntry; replaced: boolean }> {
    requireAdministrator(identity);
    const parsed = CredentialRegistrationSchema.safeParse(body);
    if (!parsed.success) throw agentXError("CONFIG_INVALID", "invalid credential registration");
    const registration = parsed.data;
    const prefix = this.options.connectorSecretPrefix ?? CONNECTOR_SECRET_PREFIX;
    if (!registration.secretName.startsWith(prefix)) {
      throw agentXError("CONFIG_INVALID", `secret name must be ${prefix}<name> in this deployment`);
    }
    if (registration.ref === this.options.githubApp.ref) {
      throw agentXError("CONFIG_INVALID", `${registration.ref} is the built-in GitHub App credential and cannot be replaced`);
    }
    await this.validateSecret(registration);

    // Any stored item counts, even a malformed one, so replacing it still clears its tokens.
    const existing = await this.readItem(registration.ref);
    const record: CredentialRecord = { ...registration, registeredBy: identity.ownerKey, registeredAt: new Date(this.now()).toISOString() };
    await this.documentClient.send(new PutCommand({
      TableName: this.tableName,
      Item: { pk: REGISTRY_PK, sk: `${RECORD_PREFIX}${record.ref}`, entityType: "CREDENTIAL", ...record },
    }));
    if (existing) {
      // Tokens minted from the previous secret must not outlive it.
      for (const token of await this.queryAll(tokenPartition(record.ref), TOKEN_PREFIX)) {
        await this.documentClient.send(new DeleteCommand({ TableName: this.tableName, Key: { pk: token.pk, sk: token.sk } }));
      }
    }
    return { credential: listEntry(record, false), replaced: existing !== undefined };
  }

  async list(identity: AuthenticatedIdentity): Promise<{ credentials: CredentialListEntry[] }> {
    requireAdministrator(identity);
    const now = this.now();
    const entries: CredentialListEntry[] = [];
    for (const item of await this.queryAll(REGISTRY_PK, RECORD_PREFIX)) {
      const record = recordOf(item);
      if (!record) {
        const ref = typeof item.sk === "string" ? item.sk.slice(RECORD_PREFIX.length) : "unknown";
        console.log(JSON.stringify({ component: "broker", event: "connector.credential_record_invalid", credential: ref }));
        continue;
      }
      // The built-in GitHub App entry is always listed below; a stored record under its ref
      // cannot be registered (register() refuses it), but a leftover or seeded one must not
      // duplicate that row.
      if (record.ref === this.options.githubApp.ref) continue;
      let tokenCached = false;
      if (record.type === "oauth-client-credentials" || record.type === "oauth-refresh-token") {
        const tokens = await this.queryAll(tokenPartition(record.ref), TOKEN_PREFIX);
        tokenCached = tokens.some((token) => typeof token.expiresAt === "number" && token.expiresAt > now);
      }
      entries.push(listEntry(record, tokenCached));
    }
    const builtIn: CredentialListEntry = { ref: this.options.githubApp.ref, type: "github-app", secretName: this.options.githubApp.secretName, builtIn: true, tokenCached: false };
    return { credentials: [builtIn, ...entries] };
  }

  /** Whether a valid record is registered under this reference; a malformed record counts as absent. */
  async has(ref: string): Promise<boolean> {
    return await this.readRecord(ref) !== undefined;
  }

  /** The provider type behind a reference: the built-in GitHub App, a valid stored record's type, or undefined. */
  async typeOf(ref: string): Promise<CredentialType | undefined> {
    if (ref === this.options.githubApp.ref) return "github-app";
    return (await this.readRecord(ref))?.type;
  }

  /** Phase 5 entry point: a provider that resolves the record on each issue, so re-registration takes effect. */
  provider(ref: string, options: { tokenEndpoint?: URL; accepts?: readonly CredentialType[] } = {}): CredentialProvider<unknown> {
    const memoKey = `${ref}\u0000${options.tokenEndpoint?.href ?? ""}`;
    return {
      issue: async (scope, access, actor) => {
        if (ref === this.options.githubApp.ref) {
          throw new CredentialUnavailable(`credential ${ref} is the built-in GitHub App and serves only the github connector`);
        }
        const record = await this.readRecord(ref);
        if (!record) throw new CredentialUnavailable(`credential ${ref} is not registered; run ${credentialSetupCommand(options.accepts)}`);
        // registeredAt alone has millisecond resolution, so two registrations in the same
        // millisecond are told apart by what they point at.
        const registration = JSON.stringify([record.registeredAt, record.type, record.secretName]);
        const current = this.delegates.get(memoKey);
        let delegate = current?.registration === registration ? current.provider : undefined;
        if (!delegate) {
          delegate = this.buildProvider(record, options.tokenEndpoint);
          this.delegates.set(memoKey, { registration, provider: delegate });
        }
        return delegate.issue(scope, access, actor);
      },
      invalidate: async (scope) => {
        await this.delegates.get(memoKey)?.provider.invalidate?.(scope);
      },
    };
  }

  private buildProvider(record: CredentialRecord, tokenEndpoint: URL | undefined): CredentialProvider<unknown> {
    const base = { ref: record.ref, secretName: record.secretName, secrets: this.options.secrets, now: this.now };
    if (record.type === "static-secret") return staticSecretProvider(base);
    if (!tokenEndpoint) throw new CredentialUnavailable(`credential ${record.ref} needs a token endpoint from its connector type`);
    if (record.type === "oauth-refresh-token") {
      const secrets = this.options.secrets;
      if (!("write" in secrets)) throw new CredentialUnavailable(`credential ${record.ref}: this deployment cannot save a rotated refresh token`);
      return oauthRefreshTokenProvider({
        ...base,
        secrets,
        tokens: new DynamoTokenCache(this.documentClient, this.tableName, record.ref),
        lease: new DynamoRefreshLease(this.documentClient, this.tableName, record.ref, this.now),
        tokenEndpoint,
        // The reason is an error class name, "LeaseDeadlineExceeded" or "SecretChanged", never the token.
        onRotationUnsaved: (reason) => {
          console.log(JSON.stringify({ component: "broker", event: "connector.refresh_token_unsaved", credential: record.ref, reason }));
        },
        ...(this.options.fetchImplementation ? { fetchImplementation: this.options.fetchImplementation } : {}),
      });
    }
    return oauthClientCredentialsProvider({
      ...base,
      tokens: new DynamoTokenCache(this.documentClient, this.tableName, record.ref),
      tokenEndpoint,
      ...(this.options.fetchImplementation ? { fetchImplementation: this.options.fetchImplementation } : {}),
    });
  }

  /**
   * Proves the secret exists and has the type's shape. An OAuth secret is only read and parsed:
   * its token endpoint belongs to the connector type, so registration never mints or refreshes.
   */
  private async validateSecret(registration: CredentialRegistration): Promise<void> {
    const { ref, type, secretName } = registration;
    let raw: string | undefined;
    try {
      raw = await this.options.secrets.read(secretName);
    } catch (error) {
      if (error instanceof CredentialUnavailable) throw agentXError("CONFIG_INVALID", error.message);
      // A throttle, service or network failure says nothing about the administrator's input, and
      // its message is AWS's, so only the secret's name is reported.
      throw agentXError("RUNTIME_UNAVAILABLE", `could not read secret ${secretName} from Secrets Manager; try again`);
    }
    try {
      parseConnectorSecret(type, raw, ref, secretName);
    } catch (error) {
      if (error instanceof CredentialUnavailable) throw agentXError("CONFIG_INVALID", error.message);
      throw error;
    }
  }

  private async readItem(ref: string): Promise<Record<string, unknown> | undefined> {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: REGISTRY_PK, sk: `${RECORD_PREFIX}${ref}` },
      ConsistentRead: true,
    }));
    return response.Item;
  }

  /** A stored record that fails to parse is treated as absent. */
  private async readRecord(ref: string): Promise<CredentialRecord | undefined> {
    const item = await this.readItem(ref);
    return item === undefined ? undefined : recordOf(item);
  }

  private async queryAll(pk: string, prefix: string): Promise<Array<Record<string, unknown>>> {
    const items: Array<Record<string, unknown>> = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
        ConsistentRead: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }));
      items.push(...(response.Items ?? []));
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return items;
  }
}

function requireAdministrator(identity: AuthenticatedIdentity): void {
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
}

/** Parses a stored item, or `undefined` when it is malformed or not keyed by its own reference. */
function recordOf(item: Record<string, unknown>): CredentialRecord | undefined {
  const { pk, sk, ...fields } = item;
  delete fields.entityType;
  const parsed = CredentialRecordSchema.safeParse(fields);
  if (!parsed.success || pk !== REGISTRY_PK || sk !== `${RECORD_PREFIX}${parsed.data.ref}`) return undefined;
  return parsed.data;
}

function listEntry(record: CredentialRecord, tokenCached: boolean): CredentialListEntry {
  return { ref: record.ref, type: record.type, secretName: record.secretName, builtIn: false, tokenCached, registeredBy: record.registeredBy, registeredAt: record.registeredAt };
}
