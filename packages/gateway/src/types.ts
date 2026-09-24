import type { SlackRequester } from "@agentx/contracts";
import type { McpConnection } from "./mcp-client.js";

export type Access = "read" | "write";

export interface ToolApproval {
  name: string;
  access: Access;
  allowedArguments?: string[] | undefined;
  argumentValues?: Record<string, Array<string | number | boolean>> | undefined;
}

export interface ConnectorPolicy { tools: ToolApproval[] }

export interface IssuedCredential {
  token: string;
  /** Routing values the issuer is authoritative for, such as the GitHub App's account and repository. */
  bindings: Readonly<Record<string, unknown>>;
}

/** The Slack member a call is made for. Service-identity providers ignore it. */
export type Actor = SlackRequester;

export interface CredentialProvider<Scope> {
  issue(scope: Scope, access: Access, actor?: Actor): Promise<IssuedCredential>;
  /** Drops any cached credential after the vendor rejected it; the next issue() mints or reads a fresh one. */
  invalidate?(scope: Scope): Promise<void>;
}

export interface Binder<Scope> {
  /** Required string properties removed from the model's schema and supplied by the server. */
  readonly properties: readonly string[];
  bind(scope: Scope, credential: IssuedCredential): Record<string, unknown>;
}

export interface GuardInput {
  tool: string;
  arguments: Readonly<Record<string, unknown>>;
  bound: Readonly<Record<string, unknown>>;
  connection: Pick<McpConnection, "call">;
}

export interface Guard {
  /** Upstream tools the check needs on the call's connection besides the called tool. */
  requiredTools(tool: string, args: Readonly<Record<string, unknown>>): readonly string[];
  /** Throws GuardRejection to refuse the call before it executes. */
  check(input: GuardInput): Promise<void>;
}

/** A guard's refusal. Its message is returned to the model as a FAILED result. */
export class GuardRejection extends Error {}

export interface ConnectorDefinition<Scope> {
  /** Vendor name used in messages, such as "GitHub". */
  label: string;
  endpoint: URL;
  /** What an administrator should check when the vendor refuses, such as "GitHub App issue permissions". */
  permissionsHint: string;
  credentials: CredentialProvider<Scope>;
  binder: Binder<Scope>;
  guards: readonly Guard[];
  /** Long-form text arguments a write's attribution is appended to; defaults to body and description. */
  attributionKeys?: readonly string[];
}

export interface ConnectorContext<Scope> {
  requestedBy?: SlackRequester;
  workspaceId: string;
  ownerKey: string;
  scopeAlias: string;
  scope: Scope;
  policy: ConnectorPolicy;
  /** The project revision whose policy authorized this call. */
  settingsRevision?: number;
}

export interface CatalogTool {
  name: string;
  scope: string;
  description: string;
  inputSchema: Record<string, unknown>;
  schemaHash: string;
  access: Access;
}

export interface ToolRequest {
  requestId: string;
  scope: string;
  tool: string;
  schemaHash: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  requestId: string;
  status: "SUCCEEDED" | "FAILED" | "UNKNOWN" | "IN_PROGRESS";
  text: string;
  truncated: boolean;
  replayed: boolean;
  /** Why a FAILED result failed, when the gateway knows. */
  reason?: "not_connected" | "schema_changed" | "policy_denied" | "vendor_error";
}

export interface Invocation {
  requestedBy?: SlackRequester;
  requestId: string;
  workspaceId: string;
  ownerKey: string;
  /** The scope alias. Stored as `repository` because feature 007 records use that name. */
  repository: string;
  tool: string;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  result: ToolResult;
  settingsRevision?: number;
}

export interface Ledger {
  claim(record: Invocation): Promise<boolean>;
  get(requestId: string): Promise<Invocation | undefined>;
  finish(record: Invocation): Promise<void>;
}
