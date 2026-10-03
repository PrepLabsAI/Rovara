import { z } from "zod";
import { McpToolNameSchema } from "./github-mcp.js";
import { ItemPathSchema } from "./item-paths.js";

/**
 * Spec 055: the parts of a generic `mcp` connector that are not connector-list plumbing. They live
 * here, apart from connectors.ts, so credentials.ts can share the host rules without a cycle.
 */

/** A lowercase DNS name with at least one dot: what a credential is pinned to and an endpoint's host must be. */
export const DnsHostSchema = z.string().max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/, "host must be a lowercase DNS name such as mcp.example.com");

/** Names that only ever reach this machine, its network or a private zone. */
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa"] as const;

/**
 * Why a URL AgentX sends a credential to cannot be used, or undefined; `label` names it in the
 * message. https only; no credentials, query or fragment in the URL; and a public-looking DNS name,
 * never an IP literal or a local name. The broker also checks the addresses an MCP endpoint resolves
 * to before each connection (FR-010).
 */
export function publicHttpsUrlProblem(value: string, label: string): string | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return `${label} must be an absolute URL`; }
  if (url.protocol !== "https:") return `${label} must use https`;
  if (url.username !== "" || url.password !== "") return `${label} must not carry a username or password`;
  if (url.search !== "" || url.hash !== "") return `${label} must not have a query or fragment`;
  const host = url.hostname;
  if (host.startsWith("[") || /^\d+(?:\.\d+){3}$/.test(host)) return `${label} host must be a DNS name, not an IP address`;
  if (!DnsHostSchema.safeParse(host).success) return `${label} host must be a DNS name with at least one dot`;
  if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return `${label} host ${host} is a local name`;
  return undefined;
}

/** Why an MCP endpoint cannot be used, or undefined. */
export function mcpEndpointProblem(value: string): string | undefined {
  return publicHttpsUrlProblem(value, "endpoint");
}

/** A public https URL, refused for the reasons publicHttpsUrlProblem gives. */
export function publicHttpsUrlSchema(label: string) {
  return z.string().max(2_048).superRefine((value, context) => {
    const problem = publicHttpsUrlProblem(value, label);
    if (problem !== undefined) context.addIssue({ code: "custom", message: problem });
  });
}

export const McpEndpointSchema = publicHttpsUrlSchema("endpoint");

/** Headers the MCP transport sets itself, which a connector must never override. */
const RESERVED_HEADERS = new Set([
  "host", "content-type", "content-length", "accept", "connection", "transfer-encoding", "cookie",
  "mcp-session-id", "mcp-protocol-version", "last-event-id", "x-mcp-tools",
]);

/** How the token is sent: `<header>: <prefix><token>`. Defaults to `Authorization: Bearer <token>`. */
export const McpAuthSchema = z.object({
  header: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/)
    .refine((name) => !RESERVED_HEADERS.has(name.toLowerCase()), "auth header is set by the MCP transport and cannot carry the token")
    .optional(),
  /** Printable ASCII, so PagerDuty's `Token token=` and a raw key (`""`) both fit; never a line break. */
  prefix: z.string().max(32).regex(/^[\x20-\x7e]*$/, "auth prefix must be printable ASCII").optional(),
}).strict();

export const DEFAULT_MCP_AUTH = { header: "Authorization", prefix: "Bearer " } as const;

/** A name in a scope's values, read by the binder and by an ownership rule. `alias` is the scope's own. */
export const ScopeValueNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/).refine((name) => name !== "alias", "alias is reserved");

/** A top-level tool argument name. */
export const ArgumentNameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/**
 * An item path (spec 014) that may also end in `[]`, for an argument holding a list of IDs
 * (`relatedTo[]`) or a result field holding a list (`projects[].gid`, `memberships[].project.gid`).
 */
export const ReferencePathSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}(?:(?:\.|\[\]\.)[A-Za-z0-9_-]{1,64}){0,3}(?:\[\])?$/u);

/** No C0 control character or DEL, so a message or value is one plain line. */
export function isOneLine(value: string): boolean {
  return ![...value].some((char) => char.charCodeAt(0) <= 0x1f || char.charCodeAt(0) === 0x7f);
}

const MessageSchema = z.string().min(1).max(512).refine(isOneLine, "message must be one line");
const PlainValueSchema = z.union([z.string().max(256), z.number(), z.boolean(), z.null()]);
const NounSchema = z.string().regex(/^[a-z][a-z -]{0,31}$/);

/** No guard: the credential's own reach is the scope. A write tool must be acknowledged. */
export const CredentialScopingSchema = z.object({
  mode: z.literal("credential"),
  acknowledgeUnscopedWrites: z.literal(true).optional(),
}).strict();

/**
 * A declarative lookup-and-compare guard (FR-007). Before a call that names an existing item, the
 * item is read with `lookup` and its `field` must equal the scope's `equals` value, directly or
 * through up to `parent.maxDepth` parents. Fails closed on anything it cannot read.
 */
export const OwnershipRuleSchema = z.object({
  mode: z.literal("ownership"),
  itemNoun: NounSchema,
  itemNounPlural: NounSchema.optional(),
  /** Per tool, where its arguments name an existing item, most important first. */
  references: z.record(McpToolNameSchema, z.array(ReferencePathSchema).min(1).max(16))
    .refine((references) => Object.keys(references).length >= 1 && Object.keys(references).length <= 32, "references must name 1 to 32 tools"),
  lookup: z.object({
    tool: McpToolNameSchema,
    argument: ArgumentNameSchema,
    arguments: z.record(ArgumentNameSchema, PlainValueSchema)
      .refine((values) => Object.keys(values).length <= 8, "lookup arguments are at most 8").optional(),
  }).strict(),
  field: ReferencePathSchema,
  equals: ScopeValueNameSchema,
  caseInsensitive: z.boolean().optional(),
  parent: z.object({ field: ItemPathSchema, maxDepth: z.int().min(1).max(3) }).strict().optional(),
  maxLookups: z.int().min(1).max(10).optional(),
  refuse: z.array(z.object({
    tools: z.array(McpToolNameSchema).min(1).max(16),
    arguments: z.array(ItemPathSchema).min(1).max(16),
    /** Refuse only this value; without it, any value (null included) is refused. */
    equals: PlainValueSchema.optional(),
    message: MessageSchema,
  }).strict()).max(16).optional(),
  require: z.array(z.object({
    tools: z.array(McpToolNameSchema).min(1).max(16),
    argument: ItemPathSchema,
    message: MessageSchema,
  }).strict()).max(16).optional(),
  /** Argument names that address an item, for the preflight warning about unguarded tools (#49). */
  targetArguments: z.array(ArgumentNameSchema).min(1).max(16).optional(),
}).strict();

export const ScopingSchema = z.discriminatedUnion("mode", [CredentialScopingSchema, OwnershipRuleSchema]);

export type McpAuth = z.infer<typeof McpAuthSchema>;
export type CredentialScoping = z.infer<typeof CredentialScopingSchema>;
export type OwnershipRule = z.infer<typeof OwnershipRuleSchema>;
export type Scoping = z.infer<typeof ScopingSchema>;
