import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  CredentialRegistrationSchema,
  OAuthClientCredentialsSecretSchema,
  agentXError,
  type CredentialListEntry,
  type CredentialRecord,
  type CredentialRegistration,
} from "@agentx/contracts";
import {
  CredentialUnavailable,
  oauthClientCredentialsProvider,
  staticSecretProvider,
  type CachedToken,
  type CredentialProvider,
  type SecretSource,
  type TokenCache,
} from "@agentx/gateway";
import type { AuthenticatedIdentity } from "../auth.js";

/** How a deployment reads connector secrets, and the built-in GitHub App entry it lists first. */
export interface ConnectorCredentialsConfiguration {
  secrets: SecretSource;
  githubApp: { ref: string; secretName: string };
  fetchImplementation?: typeof fetch;
}

const REGISTRY_PK = "CREDENTIALS";
const RECORD_PREFIX = "REF#";
const TOKEN_PREFIX = "TOKEN#";
const tokenPartition = (ref: string) => `CREDENTIAL#${ref}`;

/** Reads a Secrets Manager secret. A missing secret is `undefined`; an access denial names only the secret. */
export function secretsManagerSource(client: {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string; SecretBinary?: Uint8Array }>;
}): SecretSource {
  return {
    async read(name) {
      try {
        const response = await client.send(new GetSecretValueCommand({ SecretId: name }));
        if (response.SecretString !== undefined) return response.SecretString;
        return response.SecretBinary === undefined ? undefined : Buffer.from(response.SecretBinary).toString("utf8");
      } catch (error) {
        const errorName = error instanceof Error ? error.name : undefined;
        if (errorName === "ResourceNotFoundException") return undefined;
        if (errorName === "AccessDeniedException") {
          throw new CredentialUnavailable(`AgentX cannot read secret ${name}; connector secrets must be named agentx/connectors/<name> in this account and region`);
        }
        throw error;
      }
    },
  };
}

/**
 * Minted tokens shared across broker containers. A cache failure is logged (never with the token)
 * and swallowed: the provider then simply mints again.
 */
export class DynamoTokenCache implements TokenCache {
  constructor(private readonly client: DynamoDBDocumentClient, private readonly tableName: string, private readonly ref: string) {}

  async get(key: string): Promise<CachedToken | undefined> {
    try {
      const response = await this.client.send(new GetCommand({ TableName: this.tableName, Key: this.key(key), ConsistentRead: true }));
      const item = response.Item as { token?: unknown; expiresAt?: unknown } | undefined;
      if (typeof item?.token !== "string" || typeof item.expiresAt !== "number") return undefined;
      return { token: item.token, expiresAt: item.expiresAt };
    } catch {
      this.failed("get");
      return undefined;
    }
  }

  async put(key: string, value: CachedToken): Promise<void> {
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: { ...this.key(key), entityType: "CREDENTIAL_TOKEN", token: value.token, expiresAt: value.expiresAt },
      }));
    } catch {
      this.failed("put");
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteCommand({ TableName: this.tableName, Key: this.key(key) }));
    } catch {
      this.failed("delete");
    }
  }

  private key(key: string) {
    return { pk: tokenPartition(this.ref), sk: `${TOKEN_PREFIX}${key}` };
  }

  private failed(operation: "get" | "put" | "delete"): void {
    console.log(JSON.stringify({ component: "broker", event: "connector.token_cache_failed", credential: this.ref, operation }));
  }
}

/** Registered connector credentials: records name a secret, never hold one. */
export class CredentialRegistry {
  private readonly documentClient: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly now: () => number;
  /** One delegate per reference and token endpoint, replaced when the record's registeredAt changes. */
  private readonly delegates = new Map<string, { registeredAt: string; provider: CredentialProvider<unknown> }>();

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
    if (registration.ref === this.options.githubApp.ref) {
      throw agentXError("CONFIG_INVALID", `${registration.ref} is the built-in GitHub App credential and cannot be replaced`);
    }
    try {
      await this.validateSecret(registration);
    } catch (error) {
      if (error instanceof CredentialUnavailable) throw agentXError("CONFIG_INVALID", error.message);
      throw error;
    }

    const existing = await this.readRecord(registration.ref);
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
    const records = (await this.queryAll(REGISTRY_PK, RECORD_PREFIX)).map(recordOf);
    const now = this.now();
    const entries: CredentialListEntry[] = [];
    for (const record of records) {
      let tokenCached = false;
      if (record.type === "oauth-client-credentials") {
        const tokens = await this.queryAll(tokenPartition(record.ref), TOKEN_PREFIX);
        tokenCached = tokens.some((token) => typeof token.expiresAt === "number" && token.expiresAt > now);
      }
      entries.push(listEntry(record, tokenCached));
    }
    const builtIn: CredentialListEntry = { ref: this.options.githubApp.ref, type: "github-app", secretName: this.options.githubApp.secretName, builtIn: true, tokenCached: false };
    return { credentials: [builtIn, ...entries] };
  }

  /** Phase 5 entry point: a provider that resolves the record on each issue, so re-registration takes effect. */
  provider(ref: string, options: { tokenEndpoint?: URL } = {}): CredentialProvider<unknown> {
    const memoKey = `${ref}\u0000${options.tokenEndpoint?.href ?? ""}`;
    return {
      issue: async (scope, access, actor) => {
        if (ref === this.options.githubApp.ref) {
          throw new CredentialUnavailable(`credential ${ref} is the built-in GitHub App and serves only the github connector`);
        }
        const record = await this.readRecord(ref);
        if (!record) throw new CredentialUnavailable(`credential ${ref} is not registered; run agentx admin credential register`);
        const current = this.delegates.get(memoKey);
        let delegate = current?.registeredAt === record.registeredAt ? current.provider : undefined;
        if (!delegate) {
          delegate = this.buildProvider(record, options.tokenEndpoint);
          this.delegates.set(memoKey, { registeredAt: record.registeredAt, provider: delegate });
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
    return oauthClientCredentialsProvider({
      ...base,
      tokens: new DynamoTokenCache(this.documentClient, this.tableName, record.ref),
      tokenEndpoint,
      ...(this.options.fetchImplementation ? { fetchImplementation: this.options.fetchImplementation } : {}),
    });
  }

  /**
   * Proves the secret exists and has the type's shape. An OAuth client secret is only read and
   * parsed: its token endpoint belongs to the connector type, so registration never mints.
   */
  private async validateSecret(registration: CredentialRegistration): Promise<void> {
    const { ref, secretName } = registration;
    if (registration.type === "static-secret") {
      await staticSecretProvider({ ref, secretName, secrets: this.options.secrets, now: this.now }).issue(undefined, "read");
      return;
    }
    const raw = await this.options.secrets.read(secretName);
    if (raw === undefined) throw new CredentialUnavailable(`credential ${ref}: secret ${secretName} was not found`);
    let json: unknown;
    try { json = JSON.parse(raw); } catch { json = undefined; }
    if (!OAuthClientCredentialsSecretSchema.safeParse(json).success) {
      throw new CredentialUnavailable(`credential ${ref}: secret ${secretName} must be JSON {"clientId": "...", "clientSecret": "...", "scopes": ["..."]}`);
    }
  }

  private async readRecord(ref: string): Promise<CredentialRecord | undefined> {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: REGISTRY_PK, sk: `${RECORD_PREFIX}${ref}` },
      ConsistentRead: true,
    }));
    return response.Item === undefined ? undefined : recordOf(response.Item);
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

function recordOf(item: Record<string, unknown>): CredentialRecord {
  const { ref, type, secretName, registeredBy, registeredAt } = item as CredentialRecord;
  return { ref, type, secretName, registeredBy, registeredAt };
}

function listEntry(record: CredentialRecord, tokenCached: boolean): CredentialListEntry {
  return { ref: record.ref, type: record.type, secretName: record.secretName, builtIn: false, tokenCached, registeredBy: record.registeredBy, registeredAt: record.registeredAt };
}
