// MCP servers on the customer's own network (Enterprise; design meta-repo-mcp.md 3.6 "Enterprise endpoints", lane E task E6, owner decision Q12).
//
// The admin does not edit infrastructure. They paste an address (or a stdio server's package) in settings. Rovara tests it, shows what it offers, and asks for
// approval. On approval the entry becomes part of the install's allow-list, which is nothing more than the set of approved entries: there is no second list to
// keep in step. Public never has these: its endpoints stay public https only (mcp-connector.ts).
import { z } from "zod";

export const McpServerIdSchema = z.string().regex(/^mcp[a-z0-9]{6,24}$/);

/**
 * Review S1. The id of a package-run server starts with this, and the id is the last part of the name of its secrets. The runner execution role may read only secrets whose name starts with it,
 * so the tokens of address-based servers (ids that never start with it) are out of reach of any task. Address-based ids are made so that they cannot (see `newServerId`).
 */
export const PACKAGE_SERVER_ID_PREFIX = "mcppkg";
export const isPackageServerId = (serverId: string): boolean => McpServerIdSchema.safeParse(serverId).success && serverId.startsWith(PACKAGE_SERVER_ID_PREFIX);

/**
 * `needs_reapproval`: a package-run entry that was stored before the approval bound its install (no lockfile or bundle hash). It is never served and cannot be approved as it
 * is; an admin looks at it again by adding the package again. (Stdio never shipped switched on, so no running install has one; the status exists so that reading an old row
 * never throws and never serves.)
 *
 * `changed_needs_review` (T10): a package-run server that was approved and whose tools, when it started, were not the ones approved (for example after a Rovara upgrade changed the Node
 * version). It is paused: never served. The admin looks again by adding the package again (the same flow as any new proposal, which shows what it offers now) and turns the old entry off.
 */
export const MCP_SERVER_STATUSES = ["awaiting_approval", "approved", "disabled", "needs_reapproval", "changed_needs_review"] as const;
export const McpServerStatusSchema = z.enum(MCP_SERVER_STATUSES);
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>;

const OneLine = z.string().min(1).max(60).refine((value) => ![...value].some((char) => char.charCodeAt(0) <= 0x1f || char.charCodeAt(0) === 0x7f), "must be one line");

/** The address of a private HTTPS MCP server: https, no login, query or fragment; a DNS name or an IP address; any port. */
export function privateMcpAddressProblem(value: string): string | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return "address: that is not a web address"; }
  if (url.protocol !== "https:") return "address: must start with https://";
  if (url.username !== "" || url.password !== "") return "address: must not hold a user name or password";
  if (url.search !== "" || url.hash !== "") return "address: must not have a query or fragment";
  if (url.hostname === "") return "address: has no host";
  return undefined;
}

export const McpHttpAddressSchema = z.string().max(2_048).superRefine((value, context) => {
  const problem = privateMcpAddressProblem(value);
  if (problem !== undefined) context.addIssue({ code: "custom", message: problem });
});

/** An exact version (no range, no tag such as `latest`), so what runs is what the admin saw. */
export const EXACT_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,60}\/)?[a-z0-9][a-z0-9._-]{0,60}$/;
const ARGUMENT = /^[A-Za-z0-9_@%+=:,./-]{1,100}$/;

// ---------------------------------------------------------------------------------------------
// Env names a package-run server may be given (stdio host redesign, section 8)
// ---------------------------------------------------------------------------------------------

const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
/**
 * Names that change how a program starts, where it looks for code or trust, or that reach the cloud. The design's list is PATH, HOME, NODE_OPTIONS, NODE_PATH, LD_*, npm_config_*,
 * AWS_*, ECS_*, TMPDIR and SHELL. This list is a little stricter: it also holds the other NODE_* names (extra CAs, TLS switches), DYLD_*, NPM_*, the proxy and certificate
 * variables, shell start-up variables, and the names the runner itself uses.
 */
const ENV_DENIED_EXACT = new Set(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SHELL", "USER", "LOGNAME", "PWD", "OLDPWD", "IFS", "BASH_ENV", "ENV", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "TZ", "LANG", "LANGUAGE", "RES_OPTIONS", "LOCALDOMAIN", "HOSTALIASES", "NLSPATH", "LOCPATH", "GCONV_PATH", "ARGP_HELP_FMT"]);
const ENV_DENIED_PREFIXES = ["NODE_", "LD_", "DYLD_", "NPM_", "AWS_", "ECS_", "MCP_", "ROVARA_", "GIT_", "PYTHON", "OPENSSL_", "UV_", "LC_", "GLIBC_", "MALLOC_", "RES_"];

/** Why an env name may not be given to a package-run server, or undefined when it may. */
export function mcpSecretEnvNameProblem(name: string): string | undefined {
  if (!ENV_NAME.test(name)) return "secret name: use 2 to 64 capital letters, digits and underscores, starting with a letter";
  const upper = name.toUpperCase();
  if (ENV_DENIED_EXACT.has(upper) || ENV_DENIED_PREFIXES.some((prefix) => upper.startsWith(prefix))) return "secret name: that name is reserved";
  return undefined;
}

export const McpSecretEnvNameSchema = z.string().max(64).superRefine((value, context) => {
  const problem = mcpSecretEnvNameProblem(value);
  if (problem !== undefined) context.addIssue({ code: "custom", message: problem });
});

// ---------------------------------------------------------------------------------------------
// What the approval of a package-run server binds
// ---------------------------------------------------------------------------------------------

/** sha256 as 64 lower-case hex characters. */
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** A host name (lower case, no trailing dot, no wildcard) or an IPv4 address. Whether an address is allowed is checked when the server is approved, against the install's ranges. */
const DESTINATION_HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** One address a package-run server may reach: the exact host and port the admin approved. */
export const McpStdioDestinationSchema = z.object({
  host: z.string().regex(DESTINATION_HOST),
  port: z.number().int().min(1).max(65_535),
}).strict();
export type McpStdioDestination = z.infer<typeof McpStdioDestinationSchema>;

/** The sizes Fargate offers up to 1 vCPU and 2 GiB. Any other pair is refused. */
const SIZES: Readonly<Record<number, readonly number[]>> = { 256: [512, 1024, 2048], 512: [1024, 2048], 1024: [2048] };
export const McpStdioSizeSchema = z.object({
  cpu: z.union([z.literal(256), z.literal(512), z.literal(1024)]),
  memoryMiB: z.union([z.literal(512), z.literal(1024), z.literal(2048)]),
}).strict().refine((size) => SIZES[size.cpu]?.includes(size.memoryMiB) === true, "size: that CPU and memory do not go together");
export type McpStdioSize = z.infer<typeof McpStdioSizeSchema>;
export const MCP_STDIO_DEFAULT_SIZE: McpStdioSize = { cpu: 256, memoryMiB: 512 };

const destinations = z.array(McpStdioDestinationSchema).max(8).default([]).refine((list) => new Set(list.map((item) => `${item.host}:${item.port}`)).size === list.length, "destinations: each address once");
const secretEnv = z.array(McpSecretEnvNameSchema).max(8).default([]).refine((names) => new Set(names).size === names.length, "secret names: each name once");

const stdioFields = {
  registry: z.literal("npm"),
  name: z.string().regex(NPM_NAME),
  version: z.string().regex(EXACT_VERSION),
  /** Arguments after the package's own command. No shell is used; each is one plain word. */
  args: z.array(z.string().regex(ARGUMENT).refine((value) => !value.split("/").includes(".."), "no ..")).max(8),
  /** The addresses the server may reach (at most 8). The server's task gets a security group that holds only these. */
  destinations,
  /** The names (never the values) of the secrets the server is given as environment variables (at most 8). The values are held in the org's secret store. */
  secretEnv,
  /** The task size. Default 0.25 vCPU / 0.5 GiB. */
  size: McpStdioSizeSchema.default(MCP_STDIO_DEFAULT_SIZE),
};

/**
 * A stdio server the MCP host runs: an npm package at an exact version, with fixed arguments. The approval binds ALL of this: the tarball's `integrity`, the `lockfileHash` of the
 * dependency tree, the `bundleHash` of the exact files that run, the destinations, the secret names and the size. Nothing is installed again for an approved entry.
 */
export const McpStdioSpecSchema = z.object({
  ...stdioFields,
  /**
   * The integrity (`sha512-…`) of the package's TARBALL, which the install computes from the bytes it downloads and the admin sees before approving. It is required in a stored
   * entry: the install uses only a tarball that hashes to it, so a registry that serves different bytes later is refused.
   */
  integrity: z.string().regex(/^sha512-[A-Za-z0-9+/=]{20,200}$/),
  /** sha256 of the lockfile bytes the install used. */
  lockfileHash: Sha256Hex,
  /** sha256 of the deterministic bundle (tar) every probe and serve task runs. The fetch step refuses any other bytes. */
  bundleHash: Sha256Hex,
}).strict();
export type McpStdioSpec = z.infer<typeof McpStdioSpecSchema>;

/**
 * What an admin types: the integrity is optional here (the install computes it and shows it; if they give one, the install's must equal it). The two hashes are NOT typed: only the
 * install computes them, so an admin (or a forged request) cannot name the bundle that will run.
 */
export const McpStdioProposalSchema = z.object({ ...stdioFields, integrity: McpStdioSpecSchema.shape.integrity.optional() }).strict();
export type McpStdioProposal = z.infer<typeof McpStdioProposalSchema>;

/** The spec as an entry holds it: only a `needs_reapproval` or `disabled` entry may lack the two hashes (see `McpServerEntrySchema`). */
const McpStdioStoredSpecSchema = z.object({ ...stdioFields, integrity: McpStdioSpecSchema.shape.integrity, lockfileHash: Sha256Hex.optional(), bundleHash: Sha256Hex.optional() }).strict();
export type McpStdioStoredSpec = z.infer<typeof McpStdioStoredSpecSchema>;

export const McpServerProposalTransportSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("http"), address: McpHttpAddressSchema }).strict(),
  z.object({ kind: z.literal("stdio"), spec: McpStdioProposalSchema }).strict(),
]);
export type McpServerProposalTransport = z.infer<typeof McpServerProposalTransportSchema>;

export const McpServerTransportSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("http"), address: McpHttpAddressSchema }).strict(),
  z.object({ kind: z.literal("stdio"), spec: McpStdioSpecSchema }).strict(),
]);
export type McpServerTransport = z.infer<typeof McpServerTransportSchema>;

/** The transport as an entry holds it (see `McpStdioStoredSpecSchema`). */
const McpServerStoredTransportSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("http"), address: McpHttpAddressSchema }).strict(),
  z.object({ kind: z.literal("stdio"), spec: McpStdioStoredSpecSchema }).strict(),
]);

/** What the test showed. The tools are shown to the admin before they approve; the hash binds the approval to exactly this list. */
export const McpServerProbeSchema = z.object({
  at: z.string().max(40),
  toolsHash: z.string().regex(/^[0-9a-f]{64}$/),
  /**
   * Fix round 2: 2 when `toolsHash` also covers each tool's full description (`descriptionHash`); absent on a probe stored before that, whose hash covers names and schemas only. A reader
   * that finds it absent compares the old way (see the controller's baseline), so an approval made before this change is not read as a tools change.
   */
  hashVersion: z.literal(2).optional(),
  tools: z.array(z.object({
    name: z.string().max(64),
    description: z.string().max(300),
    annotation: z.enum(["read_only", "unannotated", "unsafe"]),
    schemaHash: z.string().regex(/^[0-9a-f]{64}$/),
    /** Fix round 2: the hash of the tool's whole description as the server gave it (the shown description is cut to 300 characters). */
    descriptionHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  }).strict()).max(100),
}).strict();
export type McpServerProbe = z.infer<typeof McpServerProbeSchema>;

export const McpServerEntrySchema = z.object({
  serverId: McpServerIdSchema,
  label: OneLine,
  status: McpServerStatusSchema,
  transport: McpServerStoredTransportSchema,
  /**
   * Whether the server has its own token. The token is write-only: it is stored in the org's secret store under this server's id, never returned, and sent only to this
   * server's checked host and port. `secretVersion` names the stored version (not a secret). Absent: the server needs none.
   */
  hasSecret: z.boolean().optional(),
  secretVersion: z.string().max(200).optional(),
  probe: McpServerProbeSchema,
  /** What the install found, for the card the admin reads before approving (T9). Absent on an http server and on an entry stored before it was kept. */
  install: z.object({ packageCount: z.number().int().min(0).max(5_000), unpackedBytes: z.number().int().min(0).max(2 ** 40) }).strict().optional(),
  requestedBy: z.string().max(200),
  requestedAt: z.string().max(40),
  decidedBy: z.string().max(200).optional(),
  decidedAt: z.string().max(40).optional(),
  /** Review M8: when the controller's pause moved the entry to `changed_needs_review`. Kept apart from `decidedBy` and `decidedAt`, which stay with the admin who approved. Cleared by a re-approve. */
  pausedAt: z.string().max(40).optional(),
}).strict().superRefine((entry, context) => {
  // An approved or waiting package-run entry always carries both hashes: nobody can store (or approve) a server whose install is not pinned.
  if (entry.transport.kind !== "stdio" || (entry.status !== "approved" && entry.status !== "awaiting_approval")) return;
  if (entry.transport.spec.lockfileHash === undefined || entry.transport.spec.bundleHash === undefined) context.addIssue({ code: "custom", message: "a package-run server needs its lockfileHash and bundleHash before it can wait for approval or be approved" });
});
export type McpServerEntry = z.infer<typeof McpServerEntrySchema>;

/**
 * Reads a stored row. A package-run entry from before the approval bound its install (approved or waiting, with no lockfile or bundle hash) is read as `needs_reapproval`
 * rather than failing or being served; a disabled one stays disabled. Anything else that does not parse is `undefined` (it is not served and can never make a host allowed).
 */
export function readStoredMcpServerEntry(raw: unknown): McpServerEntry | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  let candidate = raw as Record<string, unknown>;
  const transport = candidate.transport as { kind?: unknown; spec?: unknown } | null | undefined;
  if (transport?.kind === "stdio" && typeof transport.spec === "object" && transport.spec !== null) {
    const spec = transport.spec as Record<string, unknown>;
    const pinned = typeof spec.lockfileHash === "string" && typeof spec.bundleHash === "string";
    if (!pinned && (candidate.status === "approved" || candidate.status === "awaiting_approval")) candidate = { ...candidate, status: "needs_reapproval" };
  }
  const parsed = McpServerEntrySchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The complete spec of a package-run entry that may run (approved) or be approved (waiting), or undefined for anything else: a `needs_reapproval` or disabled entry, an http entry,
 * or an entry missing a hash. The one place the serving and approving code narrows an entry to a spec.
 */
export function stdioSpecIfComplete(entry: McpServerEntry): McpStdioSpec | undefined {
  if (entry.transport.kind !== "stdio" || (entry.status !== "approved" && entry.status !== "awaiting_approval")) return undefined;
  const parsed = McpStdioSpecSchema.safeParse(entry.transport.spec);
  return parsed.success ? parsed.data : undefined;
}

/** The codes a test of an address can end in. They are fixed words: a server's own error text is never shown (it can hold addresses and banners). */
export const MCP_PROBE_FAILURES = {
  not_allowed_address: "That address is one Rovara never calls (this machine, a link-local or metadata address, or a multicast address).",
  dns_failed: "Rovara could not find that host name.",
  unreachable: "Rovara could not connect to that address.",
  timed_out: "The server did not answer in time.",
  unauthorized: "The server asked for a login. Add a connection with its token and choose it.",
  not_mcp: "The server answered, but not as an MCP server.",
  host_unavailable: "The MCP host is not set up in this install, so stdio servers cannot be used.",
  host_refused: "The MCP host would not start that package.",
  // T9: the reasons the admin can act on. The host names a refused destination, a busy test slot, or the fixed code of an install that failed; nothing it says in words is shown.
  destination_refused: "This address is outside the ranges your install allows.",
  host_busy: "Rovara is testing other servers right now. Wait a few minutes and try again.",
  install_failed: "Rovara could not install that package.",
} as const;
export type McpProbeFailure = keyof typeof MCP_PROBE_FAILURES;

/**
 * Why an install of a package failed, as the sentence the admin reads. The install task keeps the same table (broker `mcp-runner/install-main.ts`) and a test keeps the two equal; the
 * broker shows THIS table's sentence for the code the host reports, never the host's words. A package or rule name is not part of any sentence.
 */
export const MCP_INSTALL_FAILURES = {
  invalid_request: "That package name or version cannot be installed.",
  integrity_mismatch: "The package's checksum is not the one you typed.",
  not_found: "Your registry does not have that package or version.",
  download_failed: "Rovara could not download that package from your registry.",
  bad_package: "The package file is not one Rovara can unpack.",
  wrong_package: "Your registry returned a different package from the one asked for.",
  git_dependency: "This package needs a git dependency. Rovara installs only from your registry.",
  unsupported_manifest: "This package changes the versions of its dependencies with overrides or resolutions. Rovara does not support that in this version.",
  install_scripts: "This package needs install steps or a native build. Rovara does not run install steps, so this package cannot be used yet.",
  lockfile_policy: "This package's dependencies are not allowed.",
  resolve_failed: "Rovara could not work out this package's dependencies from your registry.",
  install_failed: "Rovara could not install this package's dependencies from your registry.",
  no_program: "This package does not offer a program Rovara can run.",
  too_large: "This package is larger than Rovara allows.",
  timed_out: "Installing this package took longer than Rovara allows.",
  bundle_failed: "Rovara could not prepare this package to run.",
  upload_failed: "Rovara could not store the prepared package.",
} as const;
export type McpInstallFailureCode = keyof typeof MCP_INSTALL_FAILURES;

// ---------------------------------------------------------------------------------------------
// What the MCP controller tells the broker about a package-run server (T10)
// ---------------------------------------------------------------------------------------------

/** Why the controller stopped a server's task. Fixed words (the same list the task runner uses). */
export const MCP_TASK_STOP_REASONS = ["idle", "lifetime", "disabled", "secret_replaced", "crash", "leftover", "room", "approval_changed", "tools_changed", "failed", "done", "shutdown"] as const;
export type McpTaskStopReason = (typeof MCP_TASK_STOP_REASONS)[number];

const EventTime = z.string().datetime();
const PrintableLine = z.string().max(900).regex(/^[\x20-\x7e]*$/);

/**
 * One thing that happened to a package-run server, as the controller writes it and the broker reads it. Ids, fixed words, hashes and counts. `addresses` (an egress change) is host
 * names and addresses the admin approved: the broker puts it in the org's audit details, never in a fact.
 */
export const McpControllerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("task_started"), serverId: McpServerIdSchema, at: EventTime, trigger: z.enum(["call", "warm"]) }).strict(),
  z.object({ type: z.literal("task_stopped"), serverId: McpServerIdSchema, at: EventTime, reason: z.enum(MCP_TASK_STOP_REASONS) }).strict(),
  z.object({ type: z.literal("egress_updated"), serverId: McpServerIdSchema, at: EventTime, added: z.number().int().min(0).max(1_000), removed: z.number().int().min(0).max(1_000), addresses: PrintableLine }).strict(),
  z.object({ type: z.literal("changed_needs_review"), serverId: McpServerIdSchema, at: EventTime, approved: Sha256Hex, observed: Sha256Hex }).strict(),
]);
export type McpControllerEvent = z.infer<typeof McpControllerEventSchema>;
