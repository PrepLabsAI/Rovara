// The runtime every native connector shares (Sentry, Datadog, Grafana, PagerDuty, Vercel, CloudWatch, GitHub Actions). A native connector's
// tools run in the broker, not on an MCP server, but they are served to the connector engine as one: `nativeConnection` is an `McpConnection` whose tools are
// read-only by construction (annotations readOnlyHint true, destructiveHint false), so catalog, approvals, tool grants, the write gate and the ledger run
// unchanged. Routing values (the Sentry organization, the project) are arguments the engine binds from the connection and the scope and removes from what the
// model sees; a tool receives them as its scope and can reach nothing else. Every call is validated against the tool's schema first.
import { agentXError, connectionSecretToken, type ConnectionSecret, type ConnectionType, type ObservabilityConnectionType, type OrgConnection, type SecretConnectionType } from "@agentx/contracts";
import { CredentialUnavailable, ToolRefusal, type Binder, type ConnectorDefinition, type CredentialProvider, type IssuedCredential, type McpConnection, type McpToolResult, type ToolApproval, type connectMcp } from "@agentx/gateway";
import type { z } from "zod";
import { connectorLedgerKeys } from "../../aws/connector-ledger.js";
import type { ConnectorScope, ConnectorType } from "../../aws/connector-types.js";
import { hostPinProblem, type HostPin } from "../../aws/credentials.js";
import type { CheckResult, ConnectionCheckInput } from "../../connections/store.js";
import { VendorFetchError, vendorFetcher, safeVendorFetch, type VendorFetch } from "./vendor-fetch.js";

export type JsonSchema = Record<string, unknown>;

/** The longest text a native tool answers, marker included. */
export const NATIVE_TEXT_LIMIT = 32_768;
const TRUNCATED = "\n(truncated)";
const NOT_CONFIGURED = "connector credentials are not configured in this deployment";

export interface NativeToolContext<Scope> {
  scope: Scope;
  credential: IssuedCredential;
  fetch: VendorFetch;
}

/** A read-only tool run in the broker. Its schema describes the arguments the model sets, and no others (`additionalProperties: false`). */
export interface NativeTool<Scope> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /**
   * The text the model sees. A native tool answers text only: the engine shows `structuredContent` instead of the text when there is one, and that copy
   * would be neither capped nor scrubbed, so none is emitted (review I-2).
   */
  run(args: Record<string, unknown>, ctx: NativeToolContext<Scope>): Promise<{ text: string }>;
}

/** A tool declining the call (an issue outside its project, a vendor 404): its message, in fixed words, goes to the model as the error. */
export class NativeToolRefusal extends Error {
  /** `policy_denied` for a call the connector's own rules refuse (an item outside the scope); `vendor_error` for what the vendor said (a status). */
  constructor(message: string, readonly reason: "policy_denied" | "vendor_error" = "policy_denied") { super(message); this.name = "NativeToolRefusal"; }
}

/** The arguments the server binds on every call, and how they become the scope a tool runs with. */
export interface NativeRouting<Scope> {
  /** Each routing argument and its schema; the engine removes them from the model's view and supplies them. */
  properties: Record<string, JsonSchema>;
  scopeOf(values: Record<string, string>): Scope;
}

// ---- argument validation

interface Violation { path: string; kind: "not-allowed" | "required" }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const at = (path: readonly string[], key: string | number) => [...path, String(key)];

/** The first way `value` does not fit `schema`, as a path; undefined when it fits. Supports the keywords the native tools' schemas use. */
function violation(schema: JsonSchema, value: unknown, path: readonly string[]): Violation | undefined {
  const bad = { path: path.join("."), kind: "not-allowed" } as const;
  if (Array.isArray(schema["enum"]) && !schema["enum"].includes(value)) return bad;
  switch (schema["type"]) {
    case "string": {
      if (typeof value !== "string") return bad;
      if (typeof schema["minLength"] === "number" && value.length < schema["minLength"]) return bad;
      if (typeof schema["maxLength"] === "number" && value.length > schema["maxLength"]) return bad;
      if (typeof schema["pattern"] === "string" && !new RegExp(schema["pattern"], "u").test(value)) return bad;
      return undefined;
    }
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value) || (schema["type"] === "integer" && !Number.isInteger(value))) return bad;
      if (typeof schema["minimum"] === "number" && value < schema["minimum"]) return bad;
      if (typeof schema["maximum"] === "number" && value > schema["maximum"]) return bad;
      return undefined;
    }
    case "boolean": return typeof value === "boolean" ? undefined : bad;
    case "array": {
      if (!Array.isArray(value)) return bad;
      if (typeof schema["minItems"] === "number" && value.length < schema["minItems"]) return bad;
      if (typeof schema["maxItems"] === "number" && value.length > schema["maxItems"]) return bad;
      if (isRecord(schema["items"])) {
        for (const [index, item] of value.entries()) {
          const found = violation(schema["items"], item, at(path, index));
          if (found !== undefined) return found;
        }
      }
      return undefined;
    }
    case "object": {
      if (!isRecord(value)) return bad;
      const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
      const additional = schema["additionalProperties"];
      for (const key of Object.keys(value)) {
        // Own keys only: `__proto__` and `constructor` are never a declared property (review M-2).
        if (Object.hasOwn(properties, key) && isRecord(properties[key])) continue;
        if (isRecord(additional)) {
          const found = violation(additional, value[key], at(path, key));
          if (found !== undefined) return found;
        } else {
          return { path: at(path, key).join("."), kind: "not-allowed" };
        }
      }
      for (const [key, declared] of Object.entries(properties)) {
        if (value[key] === undefined || !isRecord(declared)) continue;
        const found = violation(declared, value[key], at(path, key));
        if (found !== undefined) return found;
      }
      for (const key of Array.isArray(schema["required"]) ? schema["required"] as string[] : []) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) return { path: at(path, key).join("."), kind: "required" };
      }
      return undefined;
    }
    default: return bad;
  }
}

const failure = (text: string): McpToolResult => ({ isError: true, content: [{ type: "text", text }] });

function truncated(text: string): string {
  return text.length <= NATIVE_TEXT_LIMIT ? text : `${text.slice(0, NATIVE_TEXT_LIMIT - TRUNCATED.length)}${TRUNCATED}`;
}

/**
 * The connection the engine opens for a native connector: no network, just the approved tools. `call` checks the routing values and the arguments, runs the
 * tool and answers its text (at most 32,768 characters, ending `(truncated)` when cut). A tool's refusal and a vendor failure come back as errors in their
 * fixed words; anything else is named only by the tool, so what was thrown (and any token in it) reaches nobody.
 */
export function nativeConnection<Scope>(
  tools: readonly NativeTool<Scope>[],
  approved: readonly string[],
  ctx: {
    credential: IssuedCredential;
    fetch: VendorFetch;
    routing: NativeRouting<Scope>;
    /** Further secret values to scrub from anything answered (a credential made of several). */
    scrub?: readonly string[];
    /**
     * A credential for each call, made after its arguments are checked and before the tool runs (GitHub Actions mints a token with exactly the tool's permissions,
     * for the one repository the scope names). The tool runs with it, and its token is scrubbed from the answer like the connection's own. A `CredentialUnavailable`
     * it throws reaches the engine as "not connected"; a `NativeToolRefusal` is the call's refusal.
     */
    credentialFor?(tool: string, scope: Scope): Promise<IssuedCredential>;
  },
): McpConnection {
  const offered = tools.filter((tool) => approved.includes(tool.name));
  const routingNames = Object.keys(ctx.routing.properties);
  const listed: McpConnection["tools"] = offered.map((tool) => {
    const properties = isRecord(tool.inputSchema["properties"]) ? tool.inputSchema["properties"] : {};
    const required = Array.isArray(tool.inputSchema["required"]) ? tool.inputSchema["required"] as string[] : [];
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: { ...tool.inputSchema, type: "object", properties: { ...ctx.routing.properties, ...properties }, required: [...routingNames, ...required], additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
    };
  });
  const redact = (text: string, ...secrets: readonly string[]) => [ctx.credential.token, ...secrets, ...(ctx.scrub ?? [])].filter((value) => value !== "").reduce((current, value) => current.split(value).join("[REDACTED]"), text);
  return {
    tools: listed,
    async call(name, args) {
      const tool = offered.find((entry) => entry.name === name);
      if (tool === undefined) throw new Error("MCP tool not allowed or unavailable");
      const values: Record<string, string> = {};
      for (const key of routingNames) {
        const value = args[key];
        if (value === undefined) return failure(`${tool.name}: ${key} is required`);
        if (typeof value !== "string" || violation(ctx.routing.properties[key]!, value, [key]) !== undefined) return failure(`${tool.name}: ${key} is not allowed`);
        values[key] = value;
      }
      const own = Object.fromEntries(Object.entries(args).filter(([key]) => !routingNames.includes(key)));
      const found = violation(tool.inputSchema, own, []);
      if (found !== undefined) return failure(`${tool.name}: ${found.path} is ${found.kind === "required" ? "required" : "not allowed"}`);
      // The call's own credential, once there is one: what it holds is scrubbed from everything answered, including a refusal's words.
      let credential = ctx.credential;
      try {
        const scope = ctx.routing.scopeOf(values);
        if (ctx.credentialFor !== undefined) credential = await ctx.credentialFor(tool.name, scope);
        const answer = await tool.run(own, { scope, credential, fetch: ctx.fetch });
        return { content: [{ type: "text", text: truncated(redact(answer.text, credential.token)) }] };
      } catch (error) {
        // The words we wrote (a refusal, a fixed vendor-failure text) reach the model through the engine; anything else is named only by the tool.
        if (error instanceof NativeToolRefusal) throw new ToolRefusal(redact(error.message, credential.token), error.reason);
        if (error instanceof VendorFetchError) throw new ToolRefusal(redact(error.message, credential.token), "vendor_error");
        // A credential that cannot be had is the connector not being connected, which the engine reports as such.
        if (error instanceof CredentialUnavailable) throw error;
        return failure(`${tool.name} failed`);
      }
    },
    async close() { /* nothing is open */ },
  };
}

// ---- the connector type

/** What every native connector's stored entry carries. */
interface NativeConfig {
  name: string;
  credentialRef: string;
  tools: ToolApproval[];
}

/** A vendor check failing in a way a person can act on: the connection is recorded as failed with this message. */
export class NativeCheckFailed extends Error {
  constructor(message: string) { super(message); this.name = "NativeCheckFailed"; }
}

export interface NativeConnectorSpec<Config extends NativeConfig, EngineScope extends { alias: string }, RunScope, Connection extends OrgConnection> {
  type: string;
  /** The org connection type `credentialRef` must name. */
  connectionType: ConnectionType;
  schema: z.ZodType<Config>;
  /** Thread and manifest label, for example "Sentry issues". */
  label: string;
  vendor: string;
  scopeNoun: string;
  scopes(config: Config): Array<ConnectorScope<EngineScope>>;
  /** The vendor's API base for this connection (its region or site). Its host is the only one the connector may reach, and the one the token is pinned to. */
  endpoint(connection: Connection): URL;
  /** What an administrator should check when the vendor refuses the token. */
  permissionsHint: string;
  tools: readonly NativeTool<RunScope>[];
  /** Every native type declares none: none has a create or bulk tool (H9). */
  itemArguments: readonly [];
  routing: NativeRouting<RunScope> & {
    /** The routing values the scope supplies. */
    fromScope(scope: EngineScope): Record<string, string>;
    /** The routing values the connection supplies (its organization). */
    fromConnection(connection: Connection): Record<string, string>;
  };
  /** Asks the vendor whether the token works; throws `NativeCheckFailed` (a message to show) or `VendorFetchError` (retryable). */
  check(fetch: VendorFetch, connection: Connection, token: string): Promise<void>;
  /**
   * For a connection whose secret is more than one value (Datadog's API and application keys): the one credential string the tools receive, made from the whole
   * secret, and the parts of it to scrub from anything a tool answers. Absent, the credential is the connection's one token.
   */
  packSecret?(secret: ConnectionSecret): string;
  secretParts?(packed: string): readonly string[];
  /** The headers of the connection check, from the saved secret. Absent: `Authorization: Bearer <token>`. */
  checkHeaders?(secret: ConnectionSecret): Record<string, string>;
  /**
   * The address is one a person typed (Grafana's base URL): every connection goes through the deployment's endpoint guard, which checks the host again and pins the
   * connection to the addresses it returned. Where the deployment has no guard the connector is not connected.
   */
  hostTyped?: boolean;
  /** Tools a scope cannot use, with the reason shown to the administrator. */
  unavailableTools?(scope: EngineScope): ReadonlyArray<{ tool: string; reason: string }>;
}

type Problem = { problem: string };

/**
 * The `ConnectorType` of a native connector. It reads the org connection its `credentialRef` names (settings, never the secret) at the time of each use, so a
 * region, site or organization changed since is felt; pins the token to the host that connection's API base names; and serves the tools through
 * `nativeConnection`, over the fixed-origin vendor fetch (`context.nativeFetch` in a test, the lookup-checked fetch otherwise).
 */
export function nativeConnectorType<Config extends NativeConfig, EngineScope extends { alias: string }, RunScope, Connection extends OrgConnection>(
  spec: NativeConnectorSpec<Config, EngineScope, RunScope, Connection>,
): ConnectorType {
  const routingNames = Object.keys(spec.routing.properties);
  return {
    type: spec.type,
    resolve(config, _project, context) {
      const parsed = spec.schema.safeParse(config);
      if (!parsed.success) {
        const fields = [...new Set(parsed.error.issues.map((issue) => issue.path[0] === undefined ? "entry" : String(issue.path[0])))];
        const rules = parsed.error.issues.filter((issue) => issue.code === "custom" && issue.path.length === 0).map((issue) => issue.message);
        return { unusable: [`invalid ${spec.type} connector configuration: ${fields.join(", ")}`, ...rules].join("; ").slice(0, 300) };
      }
      const stored = parsed.data;
      const ref = stored.credentialRef;
      const registry = context.credentialRegistry;
      /** The connection this connector reads and the host its token is pinned to, or why it cannot be served. */
      const load = async (): Promise<Problem | { connection: Connection; endpoint: URL; pin: HostPin }> => {
        if (!registry) return { problem: NOT_CONFIGURED };
        const record = await registry.registration(ref);
        const type = record?.type ?? await registry.typeOf(ref);
        if (type === undefined) return { problem: `credential ${ref} is not registered` };
        if (type !== "static-secret") return { problem: `credential ${ref} is ${type}; a ${spec.vendor} connector needs a static-secret token` };
        const connection = await registry.connection?.(ref);
        if (connection === undefined || connection.type !== spec.connectionType) return { problem: `connection ${ref} is not a ${spec.vendor} connection` };
        const endpoint = spec.endpoint(connection as Connection);
        const pin: HostPin = { host: endpoint.hostname, required: true };
        const pinned = hostPinProblem(ref, record?.host, pin);
        if (pinned !== undefined) return { problem: pinned };
        return { connection: connection as Connection, endpoint, pin };
      };
      const connect: typeof connectMcp = async (target) => {
        if (target.endpoint.protocol !== "https:") throw new Error("a native connector reaches its vendor over https only");
        let base: typeof fetch;
        if (spec.hostTyped === true) {
          // An address a person typed: checked again now, and the connection pinned to what the check returned. No guard, no connection.
          if (context.endpointGuard === undefined) throw new CredentialUnavailable("address checks are not configured in this deployment");
          try {
            base = await context.endpointGuard(target.endpoint);
          } catch (error) {
            throw new CredentialUnavailable(error instanceof Error ? error.message : "the address is not allowed");
          }
        } else {
          base = context.nativeFetch ?? safeVendorFetch();
        }
        const fetcher = vendorFetcher({ base: target.endpoint, fetch: base });
        return nativeConnection(spec.tools, target.tools, {
          credential: { token: target.token, bindings: {} }, fetch: fetcher, routing: spec.routing, scrub: spec.secretParts?.(target.token) ?? [],
        });
      };
      return {
        name: stored.name,
        type: spec.type,
        label: spec.label,
        vendor: spec.vendor,
        scopeNoun: spec.scopeNoun,
        scopes: spec.scopes(stored),
        policy: { tools: stored.tools },
        approvals: stored.tools,
        // Nothing is written, so there is no requester footer to sign.
        attribution: false,
        ledger: connectorLedgerKeys(stored.name),
        credential: { ref, accepts: ["static-secret"] },
        configured: async () => !("problem" in await load()),
        async definition() {
          const loaded = await load();
          if ("problem" in loaded) return { notConnected: loaded.problem };
          const provider = registry!.provider(ref, { accepts: ["static-secret"], pin: loaded.pin }) as CredentialProvider<EngineScope>;
          const fromConnection = spec.routing.fromConnection(loaded.connection);
          const credentials: CredentialProvider<EngineScope> = {
            issue: async (scope, access, actor) => {
              // The provider checks the connection is usable and pinned to this host; a connection of several values is then read whole.
              const issued = await provider.issue(scope, access, actor);
              if (spec.packSecret === undefined) return { ...issued, bindings: { ...issued.bindings, ...fromConnection } };
              const secret = await registry!.connectionSecret?.(ref);
              if (secret === undefined) throw new CredentialUnavailable(`credential ${ref} could not be read; save the connection's secret again`);
              return { ...issued, token: spec.packSecret(secret), bindings: { ...issued.bindings, ...fromConnection } };
            },
            ...(provider.invalidate === undefined ? {} : { invalidate: (scope: EngineScope) => provider.invalidate!(scope) }),
          };
          const binder: Binder<EngineScope> = {
            properties: routingNames,
            bind: (scope, credential) => ({ ...spec.routing.fromScope(scope), ...credential.bindings }),
          };
          const definition: ConnectorDefinition<EngineScope> = {
            label: spec.vendor,
            endpoint: loaded.endpoint,
            permissionsHint: spec.permissionsHint,
            credentials,
            binder,
            guards: [],
            itemArguments: spec.itemArguments,
            ...(spec.unavailableTools === undefined ? {} : { unavailableTools: (scope: EngineScope) => spec.unavailableTools!(scope) }),
          };
          return definition;
        },
        connect,
      };
    },
  };
}

/**
 * A native type's connection check for the org connection store (`OrgConnectionStoreInput.checks`): the vendor's own check with the saved token over the
 * store's held fetch. A message to show is a failed check; a vendor that cannot be reached is retryable and is not recorded.
 */
export function nativeConnectionCheck<T extends Extract<ObservabilityConnectionType, SecretConnectionType>>(
  spec: {
    vendor: string;
    endpoint(connection: Extract<OrgConnection, { type: T }>): URL;
    check(fetch: VendorFetch, connection: Extract<OrgConnection, { type: T }>, token: string): Promise<void>;
    checkHeaders?(secret: ConnectionSecret): Record<string, string>;
  },
  type: T,
): (input: ConnectionCheckInput<T>) => Promise<CheckResult> {
  return async (input) => {
    if (input.secret === undefined) return { ok: false, message: "the saved secret could not be read; save it again" };
    const token = connectionSecretToken(type, input.secret);
    const headers = spec.checkHeaders?.(input.secret) ?? { authorization: `Bearer ${token}` };
    const fetcher = vendorFetcher({ base: spec.endpoint(input.connection), fetch: input.fetch, headers });
    try {
      await spec.check(fetcher, input.connection, token);
      return { ok: true };
    } catch (error) {
      if (error instanceof NativeCheckFailed) return { ok: false, message: error.message };
      // The vendor could not be reached: retryable, and not recorded as a failed check.
      if (error instanceof VendorFetchError) throw agentXError("RUNTIME_UNAVAILABLE", `could not reach ${spec.vendor}`);
      throw error;
    }
  };
}
