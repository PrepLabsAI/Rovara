import { createHash } from "node:crypto";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { agentXError, type GitHubMcpPolicy, type GitHubMcpRequest, type GitHubMcpResult, type GitHubMcpTool, type SlackRequester } from "@agentx/contracts";
import { connectMcp, type McpConnection, type McpToolResult } from "./mcp-client.js";

export interface GitHubMcpInvocation {
  requestedBy?: SlackRequester;
  requestId: string; workspaceId: string; ownerKey: string; repository: string; tool: string;
  fingerprint: string; createdAt: string; updatedAt: string; result: GitHubMcpResult;
}
export interface GitHubMcpStore {
  claim(record: GitHubMcpInvocation): Promise<boolean>;
  get(requestId: string): Promise<GitHubMcpInvocation | undefined>;
  finish(record: GitHubMcpInvocation): Promise<void>;
}
export interface GitHubMcpDependencies {
  credentials(repository: { url: string; credentialRef: string }, access: "read" | "write"): Promise<{ owner: string; repo: string; token: string }>;
  connect?: typeof connectMcp;
}
export interface GitHubMcpContext {
  requestedBy?: SlackRequester;
  workspaceId: string; ownerKey: string;
  repository: { name: string; url: string; credentialRef: string };
  policy: GitHubMcpPolicy;
}
const ENDPOINT = new URL("https://api.githubcopilot.com/mcp/");
class PolicyFailure extends Error {}

export async function discoverGitHubTools(context: GitHubMcpContext, dependencies: GitHubMcpDependencies): Promise<{ tools: GitHubMcpTool[] }> {
  let connection: McpConnection | undefined;
  const signal = AbortSignal.timeout(20_000);
  try {
    const credentials = await withDeadline(dependencies.credentials(context.repository, "read"), signal);
    connection = await (dependencies.connect ?? connectMcp)({ endpoint: ENDPOINT, token: credentials.token, tools: context.policy.tools.map((tool) => tool.name), signal });
    return { tools: approvedTools(connection, context) };
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", "GitHub MCP discovery failed; check installation permissions and endpoint availability");
  } finally { await connection?.close().catch(() => undefined); }
}

/** Derive schemas from discovery, narrow by admin policy, and bind routing outside model arguments. */
export function approvedTools(connection: Pick<McpConnection, "tools">, context: GitHubMcpContext): GitHubMcpTool[] {
  const tools: GitHubMcpTool[] = [];
  for (const upstream of connection.tools) {
    const policy = context.policy.tools.find((entry) => entry.name === upstream.name);
    if (!policy) continue;
    if (JSON.stringify(upstream.inputSchema).length > 32_768) throw new Error("MCP schema exceeded limit");
    const schema = structuredClone(upstream.inputSchema);
    // Initial adapter supports plain repository-scoped object schemas. Fail closed on unsupported routing shapes.
    if (schema.type !== "object" || !isObject(schema.properties) || schema.$ref || schema.allOf || schema.anyOf || schema.oneOf || schema.patternProperties) continue;
    const properties = schema.properties;
    if (!isObject(properties.owner) || properties.owner.type !== "string" || !isObject(properties.repo) || properties.repo.type !== "string") continue;
    const required = Array.isArray(schema.required) ? schema.required as string[] : [];
    if (!required.includes("owner") || !required.includes("repo")) continue;
    delete properties.owner;
    delete properties.repo;
    schema.required = required.filter((name) => !["owner", "repo"].includes(name));
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
      name: upstream.name, repository: context.repository.name,
      description: (upstream.description ?? upstream.name).slice(0, 16_384), inputSchema: schema,
      schemaHash: fingerprint({ upstream, policy, repository: context.repository }), access: policy.access,
    });
  }
  return tools;
}

export async function executeGitHubTool(request: GitHubMcpRequest, context: GitHubMcpContext, dependencies: GitHubMcpDependencies & { store: GitHubMcpStore }): Promise<GitHubMcpResult> {
  const policy = context.policy.tools.find((tool) => tool.name === request.tool);
  if (!policy) throw agentXError("FORBIDDEN", "GitHub MCP tool is not approved for this project");
  if (Object.hasOwn(request.arguments, "owner") || Object.hasOwn(request.arguments, "repo")) throw agentXError("FORBIDDEN", "GitHub repository routing is server controlled");
  const write = policy.access === "write";
  const durable = write || context.requestedBy !== undefined;
  const pending = publicResult(request, "IN_PROGRESS", write
    ? "This write is running or its outcome is unknown. Inspect GitHub before issuing a new write; do not automatically retry."
    : "This read is running or its result has not been recorded.");
  let record: GitHubMcpInvocation = {
    requestId: request.requestId, workspaceId: context.workspaceId, ownerKey: context.ownerKey,
    repository: request.repository, tool: request.tool, fingerprint: fingerprint(request),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), result: pending,
    ...(context.requestedBy === undefined ? {} : { requestedBy: context.requestedBy }),
  };
  if (durable && !await dependencies.store.claim(record)) {
    const previous = await dependencies.store.get(request.requestId);
    if (!previous) throw agentXError("RUNTIME_UNAVAILABLE", "MCP invocation record unavailable; retry only with the same request ID");
    if (previous.ownerKey !== context.ownerKey || previous.workspaceId !== context.workspaceId) throw agentXError("NOT_FOUND", "MCP invocation not found");
    if (previous.requestedBy?.teamId !== context.requestedBy?.teamId || previous.requestedBy?.userId !== context.requestedBy?.userId) throw agentXError("NOT_FOUND", "MCP invocation not found");
    if (previous.fingerprint !== record.fingerprint) throw agentXError("IDEMPOTENCY_CONFLICT", "MCP request ID already used with different inputs");
    return { ...previous.result, replayed: true };
  }
  let connection: McpConnection | undefined;
  let writeAttempted = false;
  let response: GitHubMcpResult;
  const signal = AbortSignal.timeout(20_000);
  try {
    const credentials = await withDeadline(dependencies.credentials(context.repository, policy.access), signal);
    const tools = [request.tool];
    // GitHub's issue endpoints also accept PR numbers. This provider-level scope guard prevents bypassing AgentX PR workflows.
    if (request.arguments.issue_number !== undefined && !tools.includes("issue_read")) tools.push("issue_read");
    connection = await (dependencies.connect ?? connectMcp)({ endpoint: ENDPOINT, token: credentials.token, tools, signal });
    const approved = approvedTools(connection, context).find((tool) => tool.name === request.tool);
    if (!approved || approved.schemaHash !== request.schemaHash) throw new PolicyFailure("MCP tool definition changed or is unavailable. Refresh tool discovery before submitting a new request.");
    const validate = new AjvJsonSchemaValidator().getValidator(approved.inputSchema);
    if (!validate(request.arguments).valid) throw new PolicyFailure("Arguments do not match the approved MCP tool schema.");
    const args = { ...request.arguments, owner: credentials.owner, repo: credentials.repo };
    const upstream = connection.tools.find((tool) => tool.name === request.tool)!;
    if (!new AjvJsonSchemaValidator().getValidator(upstream.inputSchema)(args).valid) throw new PolicyFailure("Arguments do not match the upstream MCP tool schema.");
    if (request.arguments.issue_number !== undefined) {
      const number = request.arguments.issue_number;
      if (!Number.isSafeInteger(number) || (number as number) < 1) throw new PolicyFailure("Invalid issue number.");
      const result = await connection.call("issue_read", { method: "get", owner: credentials.owner, repo: credentials.repo, issue_number: number });
      if (result.isError) throw new Error("Issue preflight failed");
      const issue: unknown = JSON.parse(resultText(result));
      const expected = `https://github.com/${credentials.owner}/${credentials.repo}/issues/${number as number}`.toLowerCase();
      if (!isObject(issue) || issue.number !== number || typeof issue.html_url !== "string" || issue.html_url.toLowerCase() !== expected || issue.pull_request) {
        throw new PolicyFailure("This integration requires an issue in the selected repository, not a pull request or another resource.");
      }
    }
    signal.throwIfAborted();
    writeAttempted = write;
    const result = await connection.call(request.tool, args);
    if (result.isError) throw new Error("MCP tool reported an error");
    response = publicResult(request, "SUCCEEDED", resultText(result).split(credentials.token).join("[REDACTED]"));
  } catch (error) {
    response = error instanceof PolicyFailure ? publicResult(request, "FAILED", error.message)
      : publicResult(request, writeAttempted ? "UNKNOWN" : "FAILED", writeAttempted
        ? "GitHub write outcome is unknown. Inspect GitHub before issuing another request. Do not automatically retry."
        : "GitHub MCP request failed before any write. Check GitHub App issue permissions and MCP availability.");
  } finally { await connection?.close().catch(() => undefined); }
  if (durable) {
    record = { ...record, updatedAt: new Date().toISOString(), result: response };
    try { await dependencies.store.finish(record); }
    catch { return publicResult(request, write ? "UNKNOWN" : "FAILED", write
      ? "Could not persist the GitHub write outcome. Inspect GitHub; retry only with the same request ID to recover its record."
      : "Could not persist the GitHub read outcome."); }
  }
  return response;
}

function publicResult(request: GitHubMcpRequest, status: GitHubMcpResult["status"], text: string): GitHubMcpResult {
  return { requestId: request.requestId, status, text: text.slice(0, 64_000), truncated: text.length > 64_000, replayed: false };
}
function resultText(result: McpToolResult): string {
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
  return (result.content ?? []).filter((entry) => entry.type === "text").map((entry) => entry.text ?? "").join("\n");
}
function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
async function withDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("GitHub request deadline exceeded"));
      signal.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", onAbort); }
}
