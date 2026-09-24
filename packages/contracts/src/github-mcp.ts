import { z } from "zod";

export const McpToolNameSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const GitHubMcpPolicySchema = z.object({
  tools: z.array(z.object({
    name: McpToolNameSchema,
    access: z.enum(["read", "write"]),
    allowedArguments: z.array(z.string().min(1).max(128)).max(64).optional(),
    argumentValues: z.record(z.string().min(1).max(128), z.array(z.union([z.string().max(256), z.number(), z.boolean()])).min(1).max(32)).optional(),
  }).strict()).min(1).max(32),
}).strict().refine((value) => new Set(value.tools.map((tool) => tool.name)).size === value.tools.length, "duplicate MCP tool approval");

export const GitHubMcpToolSchema = z.object({
  name: McpToolNameSchema,
  repository: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  description: z.string().max(16_384),
  inputSchema: z.record(z.string(), z.unknown()),
  schemaHash: z.string().regex(/^[a-f0-9]{64}$/),
  access: z.enum(["read", "write"]),
}).strict();
export const GitHubMcpCatalogSchema = z.object({ tools: z.array(GitHubMcpToolSchema).max(32) }).strict();

export const GitHubMcpRequestSchema = z.object({
  requestId: z.uuid(),
  repository: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  tool: McpToolNameSchema,
  schemaHash: z.string().regex(/^[a-f0-9]{64}$/),
  arguments: z.record(z.string(), z.unknown()).refine((value) => JSON.stringify(value).length <= 65_536, "arguments exceed limit"),
}).strict();

export const GitHubMcpResultSchema = z.object({
  requestId: z.uuid(), status: z.enum(["SUCCEEDED", "FAILED", "UNKNOWN", "IN_PROGRESS"]),
  text: z.string().max(64_000), truncated: z.boolean(), replayed: z.boolean(),
}).strict();

export type GitHubMcpPolicy = z.infer<typeof GitHubMcpPolicySchema>;
export type GitHubMcpTool = z.infer<typeof GitHubMcpToolSchema>;
export type GitHubMcpRequest = z.infer<typeof GitHubMcpRequestSchema>;
export type GitHubMcpResult = z.infer<typeof GitHubMcpResultSchema>;
