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
export function secretsManagerSource(
  client: {
    send(command: GetSecretValueCommand | PutSecretValueCommand): Promise<{ SecretString?: string; SecretBinary?: Uint8Array }>;
  },
  /** This deployment's (or environment's) actual connector secret prefix, named in an access-denied message. */
  connectorSecretPrefix: string = CONNECTOR_SECRET_PREFIX,
): SecretStore {
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
          throw new CredentialUnavailable(`AgentX cannot read secret ${name}; connector secrets must be named ${connectorSecretPrefix}<name> in this account and region, or its KMS key does not allow the AgentX broker`);
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

/** The host a connector's credential must be pinned to (spec 055 FR-009). */
export interface HostPin {
  /** The endpoint's host. */
  host: string;
  /** True for a generic `mcp` connector: an unpinned credential is refused too. */
  required: boolean;
}

/** Why a credential's pinned host does not allow sending it to this connector, or undefined. */
export function hostPinProblem(ref: string, recordHost: string | undefined, pin: HostPin | undefined): string | undefined {
  if (pin === undefined) return undefined;
  if (recordHost === undefined) {
    return pin.required ? `credential ${ref} is not pinned to a host; register it again with --host ${pin.host}` : undefined;
  }
  return recordHost === pin.host ? undefined : `credential ${ref} is pinned to ${recordHost}, not ${pin.host}, so AgentX does not send it there`;
}

/**
 * Why a credential registered for one token URL cannot serve a connector type that names another,
 * or undefined. Either side may be absent.
 */
export function tokenUrlProblem(ref: string, recordTokenUrl: string | undefined, typeEndpoint: URL | undefined): string | undefined {
  if (recordTokenUrl === undefined || typeEndpoint === undefined) return undefined;
  return new URL(recordTokenUrl).href === typeEndpoint.href ? undefined : `credential ${ref} is registered for token URL ${recordTokenUrl}, not ${typeEndpoint.href}, so AgentX does not send it there`;
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
    const prefix = this.connectorSecretPrefix;
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

  /** Spec 025 E7: the registration under a reference, if a valid one exists. */
  async registration(ref: string): Promise<CredentialRecord | undefined> {
    return this.readRecord(ref);
  }

  /** Spec 025 E7: whether the secret exists and reads as the type, without keeping or returning it. */
  async checkSecret(registration: CredentialRegistration): Promise<"reads" | "missing" | "wrong_type" | "unavailable"> {
    const found = await this.classifySecret(registration);
    return found.status === "denied" || found.status === "unreachable" ? "unavailable" : found.status;
  }

  /** This deployment's connector secret prefix, the one register() enforces (spec 025 C5). */
  get connectorSecretPrefix(): string {
    return this.options.connectorSecretPrefix ?? CONNECTOR_SECRET_PREFIX;
  }

  /** The built-in GitHub App's reference, which register() refuses. */
  get builtInRef(): string {
    return this.options.githubApp.ref;
  }

  /** Phase 5 entry point: a provider that resolves the record on each issue, so re-registration takes effect. */
  provider(ref: string, options: { tokenEndpoint?: URL; accepts?: readonly CredentialType[]; pin?: HostPin } = {}): CredentialProvider<unknown> {
    const memoKey = `${ref}\u0000${options.tokenEndpoint?.href ?? ""}`;
    return {
      issue: async (scope, access, actor) => {
        if (ref === this.options.githubApp.ref) {
          throw new CredentialUnavailable(`credential ${ref} is the built-in GitHub App and serves only the github connector`);
        }
        const record = await this.readRecord(ref);
        if (!record) throw new CredentialUnavailable(`credential ${ref} is not registered; run ${credentialSetupCommand(options.accepts)}`);
        // Spec 055: checked on every issue, so a re-registration or an edited endpoint can never send it elsewhere.
        const pinned = hostPinProblem(ref, record.host, options.pin);
        if (pinned !== undefined) throw new CredentialUnavailable(pinned);
        // registeredAt alone has millisecond resolution, so two registrations in the same
        // millisecond are told apart by what they point at.
        const registration = JSON.stringify([record.registeredAt, record.type, record.secretName, record.tokenUrl ?? null, record.resource ?? null]);
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

  private buildProvider(record: CredentialRecord, typeEndpoint: URL | undefined): CredentialProvider<unknown> {
    const base = { ref: record.ref, secretName: record.secretName, secrets: this.options.secrets, now: this.now };
    if (record.type === "static-secret") return staticSecretProvider(base);
    // Spec 055 phase 2: a connector type's own token endpoint wins; a generic connector uses the
    // one registered with the credential. A credential registered for another endpoint is refused.
    const mismatch = tokenUrlProblem(record.ref, record.tokenUrl, typeEndpoint);
    if (mismatch !== undefined) throw new CredentialUnavailable(mismatch);
    const tokenEndpoint = typeEndpoint ?? (record.tokenUrl === undefined ? undefined : new URL(record.tokenUrl));
    if (!tokenEndpoint) throw new CredentialUnavailable(`credential ${record.ref} has no token URL; sign in again with agentx admin credential authorize --ref ${record.ref} --endpoint <mcp url>, or register it with --token-url`);
    if (record.type === "oauth-refresh-token") {
      const secrets = this.options.secrets;
      if (!("write" in secrets)) throw new CredentialUnavailable(`credential ${record.ref}: this deployment cannot save a rotated refresh token`);
      return oauthRefreshTokenProvider({
        ...base,
        secrets,
        tokens: new DynamoTokenCache(this.documentClient, this.tableName, record.ref),
        lease: new DynamoRefreshLease(this.documentClient, this.tableName, record.ref, this.now),
        tokenEndpoint,
        ...(record.resource === undefined ? {} : { resource: record.resource }),
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
    const found = await this.classifySecret(registration);
    if (found.status === "reads") return;
    // A throttle, service or network failure says nothing about the administrator's input, and
    // its message is AWS's, so only the secret's name is reported.
    if (found.status === "unreachable") throw agentXError("RUNTIME_UNAVAILABLE", `could not read secret ${registration.secretName} from Secrets Manager; try again`);
    throw agentXError("CONFIG_INVALID", found.message);
  }

  /**
   * The one classifier registration and a change plan share (spec 025 C3): whether the secret
   * reads as the type. Never keeps or returns the secret; a message names only the secret.
   */
  private async classifySecret(registration: CredentialRegistration): Promise<
    { status: "reads" } | { status: "missing" | "wrong_type" | "denied"; message: string } | { status: "unreachable" }
  > {
    const { ref, type, secretName } = registration;
    let raw: string | undefined;
    try {
      raw = await this.options.secrets.read(secretName);
    } catch (error) {
      if (error instanceof CredentialUnavailable) return { status: "denied", message: error.message };
      return { status: "unreachable" };
    }
    try {
      parseConnectorSecret(type, raw, ref, secretName);
      return { status: "reads" };
    } catch (error) {
      if (error instanceof CredentialUnavailable) return { status: raw === undefined ? "missing" : "wrong_type", message: error.message };
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
  return { ref: record.ref, type: record.type, secretName: record.secretName, ...(record.host === undefined ? {} : { host: record.host }),
    ...(record.tokenUrl === undefined ? {} : { tokenUrl: record.tokenUrl }), ...(record.resource === undefined ? {} : { resource: record.resource }), builtIn: false, tokenCached, registeredBy: record.registeredBy, registeredAt: record.registeredAt };
}
