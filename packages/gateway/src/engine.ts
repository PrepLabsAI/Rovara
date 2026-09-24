import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { agentXError } from "@agentx/contracts";
import { connectMcp, type McpConnection } from "./mcp-client.js";
import {
  GuardRejection,
  type CatalogTool,
  type ConnectorContext,
  type ConnectorDefinition,
  type Invocation,
  type Ledger,
  type ToolRequest,
  type ToolResult,
} from "./types.js";
import { fingerprint, isObject, resultText, withDeadline } from "./util.js";

/** Derive schemas from discovery, narrow by admin policy, and bind routing outside model arguments. */
export function approveTools<Scope>(
  connection: Pick<McpConnection, "tools">,
  connector: Pick<ConnectorDefinition<Scope>, "binder">,
  context: ConnectorContext<Scope>,
): CatalogTool[] {
  const tools: CatalogTool[] = [];
  for (const upstream of connection.tools) {
    const policy = context.policy.tools.find((entry) => entry.name === upstream.name);
    if (!policy) continue;
    if (JSON.stringify(upstream.inputSchema).length > 32_768) throw new Error("MCP schema exceeded limit");
    const schema = structuredClone(upstream.inputSchema);
    // Plain object schemas only. Fail closed on shapes the narrowing cannot reason about.
    if (schema.type !== "object" || !isObject(schema.properties) || schema.$ref || schema.allOf || schema.anyOf || schema.oneOf || schema.patternProperties) continue;
    const properties = schema.properties;
    const required = Array.isArray(schema.required) ? schema.required as string[] : [];
    const bindable = (name: string) => {
      const property = properties[name];
      return isObject(property) && property.type === "string" && required.includes(name);
    };
    if (!connector.binder.properties.every(bindable)) continue;
    for (const name of connector.binder.properties) delete properties[name];
    schema.required = required.filter((name) => !connector.binder.properties.includes(name));
    if (policy.allowedArguments) {
      if ((schema.required as string[]).some((name) => !policy.allowedArguments!.includes(name))) continue;
      for (const name of Object.keys(properties)) if (!policy.allowedArguments.includes(name)) delete properties[name];
    }
    let incompatible = false;
    for (const [name, values] of Object.entries(policy.argumentValues ?? {})) {
      const property = properties[name];
      if (!isObject(property)) { incompatible = true; break; }
      const upstreamEnum = Array.isArray(property.enum) ? property.enum : undefined;
      const permitted = upstreamEnum ? values.filter((value) => upstreamEnum.includes(value)) : values;
      if (!permitted.length) { incompatible = true; break; }
      properties[name] = { ...property, enum: permitted };
      if (!(schema.required as string[]).includes(name)) (schema.required as string[]).push(name);
    }
    if (incompatible) continue;
    schema.additionalProperties = false;
    // Compile during discovery too; schemas we cannot validate must never be advertised.
    new AjvJsonSchemaValidator().getValidator(schema);
    tools.push({
      name: upstream.name,
      scope: context.scopeAlias,
      description: (upstream.description ?? upstream.name).slice(0, 16_384),
      inputSchema: schema,
      // Hashed under the feature 007 key `repository` so hashes survive the release.
      schemaHash: fingerprint({ upstream, policy, repository: context.scope }),
      access: policy.access,
    });
  }
  return tools;
}

export interface EngineOptions { connect?: typeof connectMcp }

class PolicyFailure extends Error {}

/** Feature 007 fingerprinted requests under the key `repository`; keep it so stored records replay. */
export function requestFingerprint(request: ToolRequest): string {
  return fingerprint({ requestId: request.requestId, repository: request.scope, tool: request.tool, schemaHash: request.schemaHash, arguments: request.arguments });
}

export async function discoverTools<Scope>(
  connector: ConnectorDefinition<Scope>,
  context: ConnectorContext<Scope>,
  options: EngineOptions = {},
): Promise<{ tools: CatalogTool[] }> {
  let connection: McpConnection | undefined;
  const signal = AbortSignal.timeout(20_000);
  try {
    const credential = await withDeadline(connector.credentials.issue(context.scope, "read", context.requestedBy), signal);
    connection = await (options.connect ?? connectMcp)({ endpoint: connector.endpoint, token: credential.token, tools: context.policy.tools.map((tool) => tool.name), signal });
    return { tools: approveTools(connection, connector, context) };
  } catch {
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
  if (connector.binder.properties.some((name) => Object.hasOwn(request.arguments, name))) {
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
  let writeAttempted = false;
  let response: ToolResult;
  const signal = AbortSignal.timeout(20_000);
  try {
    const credential = await withDeadline(connector.credentials.issue(context.scope, policy.access, context.requestedBy), signal);
    const tools = [request.tool];
    for (const guard of connector.guards) {
      for (const name of guard.requiredTools(request.tool, request.arguments)) if (!tools.includes(name)) tools.push(name);
    }
    connection = await (options.connect ?? connectMcp)({ endpoint: connector.endpoint, token: credential.token, tools, signal });
    const approved = approveTools(connection, connector, context).find((tool) => tool.name === request.tool);
    if (!approved || approved.schemaHash !== request.schemaHash) throw new PolicyFailure("MCP tool definition changed or is unavailable. Refresh tool discovery before submitting a new request.");
    const validate = new AjvJsonSchemaValidator().getValidator(approved.inputSchema);
    if (!validate(request.arguments).valid) throw new PolicyFailure("Arguments do not match the approved MCP tool schema.");
    const bound = connector.binder.bind(context.scope, credential);
    const args = { ...request.arguments, ...bound };
    const upstream = connection.tools.find((tool) => tool.name === request.tool)!;
    if (!new AjvJsonSchemaValidator().getValidator(upstream.inputSchema)(args).valid) throw new PolicyFailure("Arguments do not match the upstream MCP tool schema.");
    for (const guard of connector.guards) await guard.check({ tool: request.tool, arguments: request.arguments, bound, connection });
    signal.throwIfAborted();
    writeAttempted = write;
    const result = await connection.call(request.tool, args);
    if (result.isError) throw new Error("MCP tool reported an error");
    response = publicResult(request, "SUCCEEDED", resultText(result).split(credential.token).join("[REDACTED]"));
  } catch (error) {
    response = error instanceof PolicyFailure || error instanceof GuardRejection
      ? publicResult(request, "FAILED", error.message)
      : publicResult(request, writeAttempted ? "UNKNOWN" : "FAILED", writeAttempted
        ? `${label} write outcome is unknown. Inspect ${label} before issuing another request. Do not automatically retry.`
        : `${label} MCP request failed before any write. Check ${connector.permissionsHint} and MCP availability.`);
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

function publicResult(request: ToolRequest, status: ToolResult["status"], text: string): ToolResult {
  return { requestId: request.requestId, status, text: text.slice(0, 64_000), truncated: text.length > 64_000, replayed: false };
}
