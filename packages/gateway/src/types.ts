import type { SlackRequester, ToolHints } from "@agentx/contracts";
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
  /**
   * String properties every approved tool must require. They are removed from the model's schema and
   * supplied by the server. A tool without one, or with one optional, is skipped.
   */
  readonly properties: readonly string[];
  /**
   * String properties bound only on the tools that have them, required or optional. They are removed
   * from those tools' schemas and supplied by the server. Tools without them are offered unchanged.
   */
  readonly optionalProperties?: readonly string[] | undefined;
  /**
   * Values for the declared properties. Guards see every value; a call sends only the declared
   * properties its tool has.
   */
  bind(scope: Scope, credential: IssuedCredential): Record<string, unknown>;
}

export interface GuardInput {
  tool: string;
  /** The model's arguments, after every guard's rewrite. */
  arguments: Readonly<Record<string, unknown>>;
  bound: Readonly<Record<string, unknown>>;
  /** The call's scope, such as the Linear team or Jira project, for tools whose schema carries no bound property. */
  scope: unknown;
  connection: Pick<McpConnection, "call">;
}

export interface RewriteInput {
  tool: string;
  /** The model's arguments, after any earlier guard rewrote them. */
  arguments: Readonly<Record<string, unknown>>;
  /** Every value the binder returned, including ones the called tool does not have. */
  bound: Readonly<Record<string, unknown>>;
  /** The call's scope. */
  scope: unknown;
}

export interface Guard {
  /**
   * Upstream tools the check needs on the call's connection besides the called tool. Receives the
   * model's own arguments, from before any guard's rewrite.
   */
  requiredTools(tool: string, args: Readonly<Record<string, unknown>>): readonly string[];
  /**
   * Optional. Returns the model's arguments narrowed to the scope, such as a search limited to the
   * bound project. It runs after the model's arguments pass the narrowed schema, and before bound
   * values are merged, upstream validation, attribution and every check. It must not set a
   * server-bound property, and throws GuardRejection to refuse. Anything else it throws surfaces as a
   * vendor_error failure, still before any write. The ledger still fingerprints the model's own arguments.
   */
  rewrite?(input: RewriteInput): Record<string, unknown>;
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
  /**
   * The argument paths through which this vendor's tools name an existing item, most specific first
   * (feature 014): a name, `a.b` or `a[].b` (contracts item-paths.ts). The action gate treats a call
   * in which any of them resolves to a present value as a change, and a call on a tool that offers
   * none of them as a create. Connector data, so the gate itself names no vendor.
   */
  itemArguments?: readonly string[];
  /**
   * Issue #49: the tools a guard confirms the item of, and the arguments through which a tool names
   * an item. Registration's preflight warns about an approved tool outside `tools` whose input has
   * one of `targetArguments`, since nothing checks the item it names.
   */
  guardedItemTools?: GuardedItemTools;
}

/** The tools a connector's guard covers, and the argument names that address an item (issue #49). */
export interface GuardedItemTools {
  tools: readonly string[];
  targetArguments: readonly string[];
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
  /** The vendor's readOnlyHint and destructiveHint, when it sent them as booleans (feature 014). Never hashed separately. */
  hints?: ToolHints | undefined;
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
