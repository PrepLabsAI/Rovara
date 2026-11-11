// The per-org credential registry : the CredentialRegistry surface the connector types read
// (`registration`, `typeOf`, `provider`), answered from one org's connections. A reference is a connection id of this
// org; another org's id, an unknown id or a connection with no saved secret reads as not registered. On a cloud
// install this replaces the install-wide registry for the org's workspaces and tasks.
import { staticSecretProvider, CredentialUnavailable, type Access, type CredentialProvider, type SecretSource } from "@agentx/gateway";
import { OrgIdSchema, connectionTakesSecret, type CredentialRecord, type CredentialType, type OrgId } from "@agentx/contracts";
import { hostPinProblem, type ConnectorCredentials, type HostPin } from "../aws/credentials.js";
import { orgConnectorSecretName } from "./org-secrets.js";
import { vendorHostOf } from "./vendor-hosts.js";
import { connectionOf, readConnection, readConnectionSecret, readConnectionToken, type OrgConnectionDeps, type OrgConnectionRecord } from "./store.js";

/**
 * A connection is served only when it exists in this org and has a saved secret. A CloudWatch connection never has one (its connector assumes
 * the customer's role), so it is not registered here and no token is ever issued for it.
 */
async function usable(deps: OrgConnectionDeps, orgId: OrgId, ref: string): Promise<(OrgConnectionRecord & { secretVersion?: string }) | undefined> {
  const connection = await readConnection(deps, orgId, ref);
  return connection !== undefined && connection.hasSecret ? connection : undefined;
}

function recordOf(deps: OrgConnectionDeps, orgId: OrgId, connection: OrgConnectionRecord): CredentialRecord {
  return {
    ref: connection.connectionId,
    // Every connection holds one static key or token.
    type: "static-secret",
    secretName: orgConnectorSecretName(deps.env, orgId, connection.connectionId),
    // The host a token may go to: the address a person typed (MCP, Grafana), or the vendor's own host for the region or site the connection names.
    ...(connection.type === "mcp" ? { host: new URL(connection.endpoint).hostname } : connection.type === "grafana" ? { host: new URL(connection.baseUrl).hostname } : vendorHostOf(connection) === undefined ? {} : { host: vendorHostOf(connection)! }),
    registeredBy: connection.createdBy,
    registeredAt: connection.createdAt,
  };
}

export function orgCredentialRegistry(deps: OrgConnectionDeps, orgIdValue: string): ConnectorCredentials {
  const orgId = OrgIdSchema.parse(orgIdValue);
  /** One delegate per connection, replaced whenever the connection is saved again. */
  const delegates = new Map<string, { version: string; provider: CredentialProvider<unknown> }>();

  /** The stored `{ apiKey | apiToken | token }` as the static-secret shape the provider reads. */
  const secrets = (connection: OrgConnectionRecord & { secretVersion?: string }): SecretSource => ({
    async read() {
      const token = await readConnectionToken(deps, orgId, connection);
      return token === undefined ? undefined : JSON.stringify({ apiKey: token });
    },
  });

  return {
    async has(ref) {
      return await usable(deps, orgId, ref) !== undefined;
    },
    async registration(ref) {
      const connection = await usable(deps, orgId, ref);
      return connection === undefined ? undefined : recordOf(deps, orgId, connection);
    },
    async connection(ref) {
      // The settings of a connection a connector can serve: one with a saved secret, or one that takes none (CloudWatch's role). Still this org's own.
      const connection = await readConnection(deps, orgId, ref);
      return connection === undefined || (connectionTakesSecret(connection.type) && !connection.hasSecret) ? undefined : connectionOf(connection);
    },
    async connectionSecret(ref) {
      const connection = await usable(deps, orgId, ref);
      return connection === undefined ? undefined : readConnectionSecret(deps, orgId, connection);
    },
    async typeOf(ref): Promise<CredentialType | undefined> {
      return await usable(deps, orgId, ref) === undefined ? undefined : "static-secret";
    },
    provider(ref, options: { accepts?: readonly CredentialType[]; pin?: HostPin } = {}) {
      return {
        issue: async (scope, access: Access, actor) => {
          const connection = await usable(deps, orgId, ref);
          if (connection === undefined) throw new CredentialUnavailable(`credential ${ref} is not registered`);
          const record = recordOf(deps, orgId, connection);
          // Checked on every issue, so an edited endpoint can never send the token elsewhere.
          const pinned = hostPinProblem(ref, record.host, options.pin);
          if (pinned !== undefined) throw new CredentialUnavailable(pinned);
          if (access === "write" && connection.access !== "read_write") {
            throw new CredentialUnavailable(`credential ${ref} is a read-only connection, so AgentX does not use it to write`);
          }
          const version = `${connection.updatedAt}|${connection.type}|${connection.secretVersion ?? ""}`;
          let delegate = delegates.get(ref);
          if (delegate?.version !== version) {
            delegate = { version, provider: staticSecretProvider({ ref, secretName: record.secretName, secrets: secrets(connection), now: deps.now }) };
            delegates.set(ref, delegate);
          }
          return delegate.provider.issue(scope, access, actor);
        },
        invalidate: async (scope) => {
          await delegates.get(ref)?.provider.invalidate?.(scope);
        },
      };
    },
  };
}
