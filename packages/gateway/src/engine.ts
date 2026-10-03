import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { AgentXError, agentXError, errorStatus, type ToolHints } from "@agentx/contracts";
import { connectMcp, McpUnauthorized, type McpConnection, type McpToolAnnotations } from "./mcp-client.js";
import { CredentialUnavailable } from "./credentials.js";
import {
  GuardRejection,
  type Access,
  type CatalogTool,
  type ConnectorContext,
  type ConnectorDefinition,
  type IssuedCredential,
  type Invocation,
  type Ledger,
  type ToolRequest,
  type ToolResult,
} from "./types.js";
import { boundNames, removeBoundProperties } from "./binding.js";
import { flattenSchema } from "./schema.js";
import { fingerprint, isObject, resultText, withDeadline } from "./util.js";

export interface SkippedTool { tool: string; reason: string }

/** Derive schemas from discovery, narrow by admin policy, bind routing outside model arguments, and say why any approved tool is not offered. */
export function reviewTools<Scope>(
  connection: Pick<McpConnection, "tools">,
  connector: Pick<ConnectorDefinition<Scope>, "binder">,
  context: ConnectorContext<Scope>,
): { tools: CatalogTool[]; skipped: SkippedTool[] } {
  const { tools, skipped } = review(connection, connector, context);
  return { tools: tools.map(({ tool }) => tool), skipped };
}

/** reviewTools, keeping for each offered tool the bound properties a call on it sends. */
function review<Scope>(
  connection: Pick<McpConnection, "tools">,
  connector: Pick<ConnectorDefinition<Scope>, "binder">,
  context: ConnectorContext<Scope>,
): { tools: Array<{ tool: CatalogTool; bound: string[] }>; skipped: SkippedTool[] } {
  const tools: Array<{ tool: CatalogTool; bound: string[] }> = [];
  const skipped: SkippedTool[] = [];
  const offered = new Set(connection.tools.map((tool) => tool.name));
  for (const approval of context.policy.tools) {
    if (!offered.has(approval.name)) skipped.push({ tool: approval.name, reason: "not offered by the vendor" });
  }
  for (const upstream of connection.tools) {
    const policy = context.policy.tools.find((entry) => entry.name === upstream.name);
    if (!policy) continue;
    if (JSON.stringify(upstream.inputSchema).length > 32_768) { skipped.push({ tool: upstream.name, reason: "schema exceeds 32768 characters" }); continue; }
    const flattened = flattenSchema(upstream.inputSchema);
    if ("unsupported" in flattened) { skipped.push({ tool: upstream.name, reason: flattened.unsupported }); continue; }
    const schema = flattened.schema;
    if (schema.type !== "object" || !isObject(schema.properties) || schema.anyOf || schema.oneOf || schema.patternProperties) {
      skipped.push({ tool: upstream.name, reason: "schema is not a plain object" });
      continue;
    }
    const properties = schema.properties;
    const binding = removeBoundProperties(schema, connector.binder);
    if ("unbindable" in binding) { skipped.push({ tool: upstream.name, reason: binding.unbindable }); continue; }
    if (policy.allowedArguments) {
      const outside = (schema.required as string[]).filter((name) => !policy.allowedArguments!.includes(name));
      if (outside.length) { skipped.push({ tool: upstream.name, reason: `requires arguments outside allowedArguments: ${outside.join(", ")}` }); continue; }
      for (const name of Object.keys(properties)) if (!policy.allowedArguments.includes(name)) delete properties[name];
    }
    let incompatible: string | undefined;
    for (const [name, values] of Object.entries(policy.argumentValues ?? {})) {
      const property = properties[name];
      if (!isObject(property)) { incompatible = name; break; }
      const upstreamEnum = Array.isArray(property.enum) ? property.enum : undefined;
      const permitted = upstreamEnum ? values.filter((value) => upstreamEnum.includes(value)) : values;
      if (!permitted.length) { incompatible = name; break; }
      properties[name] = { ...property, enum: permitted };
      if (!(schema.required as string[]).includes(name)) (schema.required as string[]).push(name);
    }
    if (incompatible !== undefined) { skipped.push({ tool: upstream.name, reason: `argumentValues do not match ${incompatible}` }); continue; }
    schema.additionalProperties = false;
    if (JSON.stringify(schema).length > 32_768) { skipped.push({ tool: upstream.name, reason: "flattened schema exceeds 32768 characters" }); continue; }
    // Compile during discovery too; schemas we cannot validate must never be advertised.
    try { new AjvJsonSchemaValidator().getValidator(schema); } catch { skipped.push({ tool: upstream.name, reason: "schema does not compile" }); continue; }
    tools.push({ bound: binding.bound, tool: {
      name: upstream.name,
      scope: context.scopeAlias,
      description: (upstream.description ?? upstream.name).slice(0, 16_384),
      inputSchema: schema,
      // Hashed under the feature 007 key `repository` so hashes survive the release.
      schemaHash: fingerprint({ upstream, policy, repository: context.scope }),
      access: policy.access,
      ...toolHints(upstream.annotations),
    } });
  }
  return { tools, skipped };
}

/** The two MCP annotations the action gate reads, kept only when the vendor sent them as booleans. */
function toolHints(annotations: McpToolAnnotations | undefined): { hints: ToolHints } | Record<string, never> {
  const hints: ToolHints = {};
  if (typeof annotations?.readOnlyHint === "boolean") hints.readOnlyHint = annotations.readOnlyHint;
  if (typeof annotations?.destructiveHint === "boolean") hints.destructiveHint = annotations.destructiveHint;
  return Object.keys(hints).length > 0 ? { hints } : {};
}

export function approveTools<Scope>(
  connection: Pick<McpConnection, "tools">,
  connector: Pick<ConnectorDefinition<Scope>, "binder">,
  context: ConnectorContext<Scope>,
): CatalogTool[] {
  return reviewTools(connection, connector, context).tools;
}

export interface EngineOptions {
  connect?: typeof connectMcp;
  /** Called when the vendor's definition no longer matches the one the model was given. */
  onDefinitionChanged?: () => void;
  /** Footer appended to a write's body or description when the model supplied one. */
  attribution?: string;
  /** Called when a write is sent unsigned because the signed arguments failed the upstream schema. */
  onAttributionDropped?: (tool: string) => void;
}

/**
 * Signs a write without ever creating a body: an absent body on an update means "leave it unchanged".
 * Only a value the model wrote is signed; one the binder supplied is left as the server set it.
 */
function withAttribution(
  args: Record<string, unknown>,
  modelArgs: Record<string, unknown>,
  attribution: string | undefined,
  schema: Record<string, unknown>,
  keys: readonly string[] = ["body", "description"],
): Record<string, unknown> {
  if (!attribution) return args;
  const properties = isObject(schema.properties) ? schema.properties : {};
  const footer = `\n\n—\n${attribution}`;
  for (const key of keys) {
    const value = args[key];
    if (typeof value !== "string" || !Object.hasOwn(properties, key) || modelArgs[key] !== value) continue;
    // A model that echoes a previously signed body must not stack a second identical footer.
    return value.endsWith(footer) ? args : { ...args, [key]: `${value}${footer}` };
  }
  return args;
}

class PolicyFailure extends Error {}
class DefinitionChanged extends PolicyFailure {}

/**
 * Applies each guard's rewrite in order. Without one, the model's arguments pass through as the same
 * object. Each rewrite gets its own copy, so one that mutates its input cannot change the caller's
 * request or make a key it added look model-written.
 */
function rewriteArguments<Scope>(request: ToolRequest, bound: Readonly<Record<string, unknown>>, scope: Scope, connector: Pick<ConnectorDefinition<Scope>, "binder" | "guards" | "label">): Record<string, unknown> {
  let args = request.arguments;
  const names = boundNames(connector.binder);
  for (const guard of connector.guards) {
    if (!guard.rewrite) continue;
    args = guard.rewrite({ tool: request.tool, arguments: structuredClone(args), bound: structuredClone(bound), scope: structuredClone(scope) });
    if (!isObject(args) || Object.getPrototypeOf(args) !== Object.prototype) throw new Error("guard rewrite returned a non-object");
    if (names.some((name) => Object.hasOwn(args, name))) throw new PolicyFailure(`${connector.label} guard set a server-controlled argument.`);
  }
  return args;
}

/**
 * The bound values a call sends: those its tool has. A required binding's missing value fails the
 * upstream schema; a when-present one may be optional there, so its absence is refused here instead
 * of silently sending an unrestricted call.
 */
function injectedValues<Scope>(names: readonly string[], bound: Readonly<Record<string, unknown>>, connector: Pick<ConnectorDefinition<Scope>, "binder" | "label">): Record<string, unknown> {
  const injected: Record<string, unknown> = {};
  for (const name of names) {
    const value = bound[name];
    if (!connector.binder.properties.includes(name) && (typeof value !== "string" || value === "")) {
      throw new PolicyFailure(`${connector.label} has no server-bound value for ${name}. An administrator must fix the connector configuration.`);
    }
    injected[name] = value;
  }
  return injected;
}

/** Feature 007 fingerprinted requests under the key `repository`; keep it so stored records replay. */
export function requestFingerprint(request: ToolRequest): string {
  return fingerprint({ requestId: request.requestId, repository: request.scope, tool: request.tool, schemaHash: request.schemaHash, arguments: request.arguments });
}

/** Discovery found the connector's credential missing or rejected. RUNTIME_UNAVAILABLE keeps feature 007 callers unchanged. */
export class ConnectorNotConnected extends AgentXError {
  constructor(message: string) { super("RUNTIME_UNAVAILABLE", message, errorStatus("RUNTIME_UNAVAILABLE")); this.name = "ConnectorNotConnected"; }
}

/**
 * Issues a credential and connects; after a 401, invalidates and tries exactly once more.
 * @internal Exported for tests only.
 */
export async function openConnection<Scope>(
  connector: ConnectorDefinition<Scope>, context: ConnectorContext<Scope>, access: Access,
  tools: string[], signal: AbortSignal, options: EngineOptions,
): Promise<{ credential: IssuedCredential; connection: McpConnection }> {
  // Tracked so a second rejection can tell the administrator the cache never got a chance to hold
  // a fresh credential; the invalidate error's own text never surfaces (it could carry secrets).
  let invalidateFailed = false;
  // Spec 055: an endpoint is refused before any credential is issued, so no token is minted or sent.
  if (connector.verifyEndpoint) await withDeadline(connector.verifyEndpoint(), signal);
  for (let attempt = 0; ; attempt += 1) {
    const credential = await withDeadline(connector.credentials.issue(context.scope, access, context.requestedBy), signal);
    try {
      const target = { endpoint: connector.endpoint, token: credential.token, tools, signal, ...(connector.auth ? { auth: connector.auth } : {}) };
      return { credential, connection: await (options.connect ?? connectMcp)(target) };
    } catch (error) {
      if (!(error instanceof McpUnauthorized)) throw error;
      if (attempt > 0) {
        throw new CredentialUnavailable(invalidateFailed
          ? `${connector.label} rejected the credential twice (clearing the cached credential also failed); check ${connector.permissionsHint}`
          : `${connector.label} rejected the credential twice; check ${connector.permissionsHint}`);
      }
      try {
        await withDeadline(Promise.resolve().then(() => connector.credentials.invalidate?.(context.scope)), signal);
      } catch { invalidateFailed = true; }
    }
  }
}

export async function discoverTools<Scope>(
  connector: ConnectorDefinition<Scope>,
  context: ConnectorContext<Scope>,
  options: EngineOptions = {},
): Promise<{ tools: CatalogTool[]; skipped: SkippedTool[] }> {
  let connection: McpConnection | undefined;
  const signal = AbortSignal.timeout(20_000);
  try {
    ({ connection } = await openConnection(connector, context, "read", context.policy.tools.map((tool) => tool.name), signal, options));
    return reviewTools(connection, connector, context);
  } catch (error) {
    if (error instanceof CredentialUnavailable) throw new ConnectorNotConnected(`${connector.label} is not connected: ${error.message}`);
    throw agentXError("RUNTIME_UNAVAILABLE", `${connector.label} MCP discovery failed; check ${connector.permissionsHint} and endpoint availability`);
  } finally { await connection?.close().catch(() => undefined); }
}

export async function executeTool<Scope>(
  request: ToolRequest,
  connector: ConnectorDefinition<Scope>,
  context: ConnectorContext<Scope>,
  options: EngineOptions & { ledger: Ledger },
): Promise<ToolResult> {
  const label = connector.label;
  const policy = context.policy.tools.find((tool) => tool.name === request.tool);
  if (!policy) throw agentXError("FORBIDDEN", `${label} MCP tool is not approved for this project`);
  if (boundNames(connector.binder).some((name) => Object.hasOwn(request.arguments, name))) {
    throw agentXError("FORBIDDEN", `${label} routing arguments are server controlled`);
  }
  const write = policy.access === "write";
  const durable = write || context.requestedBy !== undefined;
  const pending = publicResult(request, "IN_PROGRESS", write
    ? `This write is running or its outcome is unknown. Inspect ${label} before issuing a new write; do not automatically retry.`
    : "This read is running or its result has not been recorded.");
  let record: Invocation = {
    requestId: request.requestId, workspaceId: context.workspaceId, ownerKey: context.ownerKey,
    repository: request.scope, tool: request.tool, fingerprint: requestFingerprint(request),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), result: pending,
    ...(context.requestedBy === undefined ? {} : { requestedBy: context.requestedBy }),
    ...(context.settingsRevision === undefined ? {} : { settingsRevision: context.settingsRevision }),
  };
  if (durable && !await options.ledger.claim(record)) {
    const previous = await options.ledger.get(request.requestId);
    if (!previous) throw agentXError("RUNTIME_UNAVAILABLE", "MCP invocation record unavailable; retry only with the same request ID");
    if (previous.ownerKey !== context.ownerKey || previous.workspaceId !== context.workspaceId) throw agentXError("NOT_FOUND", "MCP invocation not found");
    if (previous.requestedBy?.teamId !== context.requestedBy?.teamId || previous.requestedBy?.userId !== context.requestedBy?.userId) throw agentXError("NOT_FOUND", "MCP invocation not found");
    if (previous.fingerprint !== record.fingerprint) throw agentXError("IDEMPOTENCY_CONFLICT", "MCP request ID already used with different inputs");
    return { ...previous.result, replayed: true };
  }
  let connection: McpConnection | undefined;
  let credential: IssuedCredential;
  let writeAttempted = false;
  let response: ToolResult;
  const signal = AbortSignal.timeout(20_000);
  try {
    const tools = [request.tool];
    for (const guard of connector.guards) {
      for (const name of guard.requiredTools(request.tool, request.arguments)) if (!tools.includes(name)) tools.push(name);
    }
    ({ credential, connection } = await openConnection(connector, context, policy.access, tools, signal, options));
    const reviewed = review(connection, connector, context).tools.find(({ tool }) => tool.name === request.tool);
    if (!reviewed || reviewed.tool.schemaHash !== request.schemaHash) {
      options.onDefinitionChanged?.();
      throw new DefinitionChanged("MCP tool definition changed or is unavailable. Refresh tool discovery before submitting a new request.");
    }
    const approved = reviewed.tool;
    const validate = new AjvJsonSchemaValidator().getValidator(approved.inputSchema);
    if (!validate(request.arguments).valid) throw new PolicyFailure("Arguments do not match the approved MCP tool schema.");
    const bound = connector.binder.bind(context.scope, credential);
    const injected = injectedValues(reviewed.bound, bound, connector);
    const modelKeys = new Set(Object.keys(request.arguments));
    const modelArgs = rewriteArguments(request, bound, context.scope, connector);
    // Only keys the model wrote are signed, with the value a rewrite gave them; a key a rewrite added is not.
    const signable = connector.guards.some((guard) => guard.rewrite !== undefined) ? Object.fromEntries(Object.entries(modelArgs).filter(([key]) => modelKeys.has(key))) : modelArgs;
    const upstream = connection.tools.find((tool) => tool.name === request.tool)!;
    const validateUpstream = new AjvJsonSchemaValidator().getValidator(upstream.inputSchema);
    const unsigned = { ...modelArgs, ...injected };
    if (!validateUpstream(unsigned).valid) throw new PolicyFailure("Arguments do not match the upstream MCP tool schema.");
    // The footer is best effort: when it would break the vendor's schema (a body maxLength, say),
    // the model's own arguments go through unsigned rather than the write failing.
    const signed = withAttribution(unsigned, signable, write ? options.attribution : undefined, upstream.inputSchema, connector.attributionKeys);
    const dropped = signed !== unsigned && !validateUpstream(signed).valid;
    const args = dropped ? unsigned : signed;
    for (const guard of connector.guards) await guard.check({ tool: request.tool, arguments: modelArgs, bound, scope: context.scope, connection });
    signal.throwIfAborted();
    writeAttempted = write;
    if (dropped) options.onAttributionDropped?.(request.tool);
    const result = await connection.call(request.tool, args);
    if (result.isError) throw new Error("MCP tool reported an error");
    response = publicResult(request, "SUCCEEDED", resultText(result).split(credential.token).join("[REDACTED]"));
  } catch (error) {
    response = !writeAttempted && error instanceof CredentialUnavailable
      ? publicResult(request, "FAILED", `${label} is not connected for this project: ${error.message}. An administrator must fix its credential.`, "not_connected")
      : error instanceof DefinitionChanged
        ? publicResult(request, "FAILED", error.message, "schema_changed")
        : error instanceof PolicyFailure || error instanceof GuardRejection
          ? publicResult(request, "FAILED", error.message, "policy_denied")
          : writeAttempted
            ? publicResult(request, "UNKNOWN", `${label} write outcome is unknown. Inspect ${label} before issuing another request. Do not automatically retry.`)
            : publicResult(request, "FAILED", `${label} MCP request failed before any write. Check ${connector.permissionsHint} and MCP availability.`, "vendor_error");
  } finally { await connection?.close().catch(() => undefined); }
  if (durable) {
    record = { ...record, updatedAt: new Date().toISOString(), result: response };
    try { await options.ledger.finish(record); }
    catch {
      return publicResult(request, write ? "UNKNOWN" : "FAILED", write
        ? `Could not persist the ${label} write outcome. Inspect ${label}; retry only with the same request ID to recover its record.`
        : `Could not persist the ${label} read outcome.`);
    }
  }
  return response;
}

function publicResult(request: ToolRequest, status: ToolResult["status"], text: string, reason?: ToolResult["reason"]): ToolResult {
  return {
    requestId: request.requestId, status, text: text.slice(0, 64_000), truncated: text.length > 64_000, replayed: false,
    ...(reason === undefined ? {} : { reason }),
  };
}
