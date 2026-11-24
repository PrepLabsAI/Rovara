// Plug-in foundations N9 (INTG2) and the company package token (PRIVATE-PACKAGES P1a, owner decision 254zzz434): private package registries for a run's setup.
//
// Two sources, never a token in either record:
//   - a PROJECT may name a CodeArtifact registry (a domain the install bound to its company): where it is, and nothing that reaches it (the broker's own identity mints a short-lived token);
//   - a COMPANY holds one install secret per supported registry host (`PRIVATE_REGISTRY_HOSTS`: GitHub Packages' npm registry first), pasted once, write-only. Every project of the company gets the
//     company's entries at its `prepare`, each with the npm scopes the company set for it. No project holds a credential reference: a generic `npm`/`pypi`/`maven` project entry is refused.
// At `prepare` the worker asks the broker for each registry's token by NAME (`/registry-credentials`), writes the package manager's config outside every repository, runs the setup and readiness
// commands, and removes the file. The token never enters model context, the transcript, evidence, logs, the manifest or a pull request: every command result passes `scrubRegistrySecrets` first.
//
// Public edition: no CodeArtifact yet (the install is shared by many companies; a CodeArtifact domain is install-wide until a per-org binding exists). A company's own secret is read for that company
// only, so the company entries need no edition. The public registries (npmjs, PyPI, Maven Central) need no entry and no credential: they stay reachable under the default allow-list.
import { z } from "zod";
import { AgentXNameSchema } from "./names.js";
import { e2eSecretSpellings } from "./e2e-secret-spellings.js";
/** The install's edition as the registry rule reads it (Cloud's edition module stays Cloud-only). */
import type { Edition } from "./model-not-enabled.js";
import { OrgIdSchema, type OrgId } from "./browser-ids.js";

/** The feature a worker lists when it can take the prepare payload's `registries` and run setup with a registry's config. Added to WORKER_INVOCATION_FEATURES. */
export const PREPARE_REGISTRIES_FEATURE = "prepare.registries.v1" as const;
/**
 * The feature a worker lists ONLY when it installs a company's private packages in its own install step (PRIVATE-PACKAGES P2: tmpfs file outside the workspace, scripts off, no project command and no
 * sandbox sees the token). A company's package token reaches no worker without it: a `prepare.registries.v1` worker alone hands the token to the project's own setup commands. Deliberately NOT in
 * WORKER_INVOCATION_FEATURES or the worker's implemented features until P2 ships the step (fail closed: until then a company that set a token gets a refused preparation, never a token).
 */
export const PREPARE_COMPANY_REGISTRIES_FEATURE = "prepare.registries.companyInstallStep.v1" as const;

export const REGISTRY_FORMATS = ["npm", "pypi", "maven"] as const;
export type RegistryFormat = (typeof REGISTRY_FORMATS)[number];

/**
 * How long the token the broker mints lasts. CodeArtifact accepts 0 or 900 to 43200 seconds (GetAuthorizationToken, durationSeconds). A token made from an assumed role's credentials can be cut off early only by denying that role in IAM
 * (tokens-authentication.html, "Revoking CodeArtifact authorization tokens"; day-two.md), so the duration is the normal bound on a leak: one hour covers a long install and nothing more. The broker refuses a minter that answers with a longer-lived token.
 * https://docs.aws.amazon.com/codeartifact/latest/APIReference/API_GetAuthorizationToken.html
 */
export const REGISTRY_TOKEN_SECONDS = 3_600;
/** A credential that is not at least this long is not treated as a secret to scrub (a short value corrupts output), so it is not accepted as a token at all. */
export const REGISTRY_TOKEN_MIN_LENGTH = 16;
export const REGISTRY_TOKEN_MAX_LENGTH = 8_192;
export const REGISTRIES_MAX = 8;

const AWS_REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
const CODEARTIFACT_DOMAIN = /^[a-z][a-z0-9-]{0,48}[a-z0-9]$/;
const CODEARTIFACT_REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/;
const NPM_SCOPE = /^@[a-z0-9][a-z0-9._~-]{0,213}$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TOP_LABEL = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** A hostname of at least two labels (a name the allow-list can hold): never an address, never a single label. */
function isRegistryHostname(host: string): boolean {
  if (host.length > 253) return false;
  const labels = host.split(".");
  return labels.length >= 2 && labels.every((label) => DNS_LABEL.test(label)) && TOP_LABEL.test(labels.at(-1)!);
}

const RegistryUrlSchema = z.string().max(2_048).superRefine((value, context) => {
  let url: URL;
  try { url = new URL(value); } catch { context.addIssue({ code: "custom", message: "registry url must be an https address" }); return; }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.port !== "") {
    context.addIssue({ code: "custom", message: "registry url must be an https address without credentials, a port, a query or a fragment" });
  } else if (!isRegistryHostname(url.hostname)) {
    context.addIssue({ code: "custom", message: "registry url must name a host of at least two labels (not an IP number)" });
  }
});

const ScopeSchema = z.string().regex(NPM_SCOPE);
/** An npm scope as a company's registry entry names it (`@acme`). */
export const RegistryScopeSchema = ScopeSchema;
const RegistryNameSchema = AgentXNameSchema;

/** The sentence a project gets when it names a generic registry: its token is the company's, set once. */
export const GENERIC_REGISTRY_REFUSED = "private package tokens are set once for the company, not in the project";
const RefusedGenericRegistrySchema = z.object({ kind: z.enum(REGISTRY_FORMATS) }).passthrough().superRefine((_entry, context) => {
  context.addIssue({ code: "custom", message: GENERIC_REGISTRY_REFUSED });
});

const CodeArtifactRegistrySchema = z.object({
  kind: z.literal("codeartifact"),
  name: RegistryNameSchema,
  format: z.enum(REGISTRY_FORMATS),
  domain: z.string().regex(CODEARTIFACT_DOMAIN),
  domainOwner: z.string().regex(/^\d{12}$/),
  repository: z.string().regex(CODEARTIFACT_REPOSITORY),
  region: z.string().regex(AWS_REGION),
  scope: ScopeSchema.optional(),
}).strict();

export const ProjectRegistrySchema = z.discriminatedUnion("kind", [CodeArtifactRegistrySchema, RefusedGenericRegistrySchema]).superRefine((entry, context) => {
  if (entry.kind === "codeartifact" && entry.scope !== undefined && entry.format !== "npm") context.addIssue({ code: "custom", path: ["scope"], message: "scope applies to npm registries only" });
}) as unknown as z.ZodType<z.infer<typeof CodeArtifactRegistrySchema>>;
export type ProjectRegistry = z.infer<typeof CodeArtifactRegistrySchema>;

export const ProjectRegistriesSchema = z.array(ProjectRegistrySchema).max(REGISTRIES_MAX).superRefine((entries, context) => {
  const names = new Set<string>();
  const targets = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (names.has(entry.name)) context.addIssue({ code: "custom", path: [index, "name"], message: "registry names must be unique" });
    names.add(entry.name);
    // Two registries of one format without a scope would fight over the same config line: the second would silently win.
    const target = `${formatOf(entry)}\0${entry.scope ?? ""}`;
    if (targets.has(target)) context.addIssue({ code: "custom", path: [index], message: "two registries of one format need different npm scopes" });
    targets.add(target);
  }
});

export function formatOf(entry: ProjectRegistry): RegistryFormat {
  return entry.format;
}

/** The CodeArtifact host of a domain: `<domain>-<owner>.d.codeartifact.<region>.amazonaws.com` (China regions end in `.amazonaws.com.cn`). */
function codeArtifactHost(entry: ProjectRegistry): string {
  return `${entry.domain}-${entry.domainOwner}.d.codeartifact.${entry.region}.amazonaws.com${entry.region.startsWith("cn-") ? ".cn" : ""}`;
}

/**
 * The address a package manager is pointed at, always ending in `/` (npm and pip need it). CodeArtifact's is derived, never typed:
 * https://docs.aws.amazon.com/codeartifact/latest/ug/npm-auth.html , python-configure-pip.html , maven-mvn.html
 */
export function registryUrlOf(entry: ProjectRegistry): string {
  const base = `https://${codeArtifactHost(entry)}/${entry.format}/${entry.repository}/`;
  return entry.format === "pypi" ? `${base}simple/` : base;
}

export function registryHostOf(entry: ProjectRegistry): string {
  return new URL(registryUrlOf(entry)).hostname.toLowerCase();
}

/** What a worker is told of a registry: where it is, never how to reach it. The credential is asked for by `name`. */
export const PrepareRegistrySchema = z.object({
  name: RegistryNameSchema,
  kind: z.enum(["npm", "pypi", "maven", "codeartifact"]),
  format: z.enum(REGISTRY_FORMATS),
  url: RegistryUrlSchema,
  scope: ScopeSchema.optional(),
}).strict();
export type PrepareRegistry = z.infer<typeof PrepareRegistrySchema>;
export const PrepareRegistriesSchema = z.array(PrepareRegistrySchema).min(1).max(REGISTRIES_MAX);
export type PrepareRegistries = z.infer<typeof PrepareRegistriesSchema>;

export function prepareRegistriesOf(registries: readonly ProjectRegistry[]): PrepareRegistry[] {
  return registries.map((entry) => ({ name: entry.name, kind: entry.kind, format: formatOf(entry), url: registryUrlOf(entry), ...(entry.scope === undefined ? {} : { scope: entry.scope }) }));
}

// ---- the credential on the wire

export const RegistryCredentialRequestSchema = z.object({ registry: RegistryNameSchema }).strict();

/** A control character in a token would break a config line (a newline writes a second setting). */
const TokenSchema = z.string().min(REGISTRY_TOKEN_MIN_LENGTH).max(REGISTRY_TOKEN_MAX_LENGTH).regex(/^[\x21-\x7e]+$/, "a registry token is printable ASCII without spaces");
export const RegistryCredentialSchema = z.object({
  username: z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/).optional(),
  token: TokenSchema,
  /** When the token stops working. Present for a minted token (CodeArtifact's, at most REGISTRY_TOKEN_SECONDS). ABSENT for a stored one (a personal access token has no expiry of its own and none is made up for it). */
  expiresAt: z.string().datetime().optional(),
}).strict();
export type RegistryCredential = z.infer<typeof RegistryCredentialSchema>;

// ---- the company's registry secrets

/**
 * The registry hosts a company may hold a package token for (v1). A fixed table: the form, the exchange and the card refuse any other host. `key` is the host's id in the secret's name, `tokenPrefix` what
 * its token starts with (GitHub Packages' npm registry takes a classic personal access token only).
 */
export const PRIVATE_REGISTRY_HOSTS = { "npm.pkg.github.com": { key: "ghnpm", format: "npm", tokenPrefix: "ghp_" } } as const satisfies Record<string, { key: string; format: RegistryFormat; tokenPrefix: string }>;
export type PrivateRegistryHost = keyof typeof PRIVATE_REGISTRY_HOSTS;
export const isPrivateRegistryHost = (host: string): host is PrivateRegistryHost => Object.hasOwn(PRIVATE_REGISTRY_HOSTS, host);

/** What a company set for one host: the npm scopes whose packages come from it. Never a token. */
export interface CompanyRegistryEntry { host: PrivateRegistryHost; scopes: readonly string[] }

/**
 * The name of a company's package token for one host: `agentx/<env>/org-connectors/<company>/pkgreg_<hostKey>`. ONE secret per company per host (npm keys its token by host, and the scopes are the entry's
 * metadata, not part of the name). Built from the company of the run and the fixed host table, never from anything a worker, a browser or a project sends: the company is part of the name, the secrets
 * adapter reads a company path for that company only, and the company-tagged session fences it again in IAM. Undefined when the company id or the host is not valid.
 * The company-side store that SAVES the secret must write exactly this name.
 */
export function companyRegistrySecretName(env: string, orgId: string, host: string): string | undefined {
  if (!OrgIdSchema.safeParse(orgId).success || !isPrivateRegistryHost(host) || !/^[a-z][a-z0-9-]{0,62}$/.test(env)) return undefined;
  return `agentx/${env}/org-connectors/${orgId}/pkgreg_${PRIVATE_REGISTRY_HOSTS[host].key}`;
}

/** The registry name a worker asks for one scope of a company entry by: the host's key and the scope's place in the entry's sorted scopes (`ghnpm-1`). Stable for one list of entries; a list that changed refuses the ask. */
export function companyRegistryNames(entries: readonly CompanyRegistryEntry[]): Array<{ name: string; host: PrivateRegistryHost; scope: string }> {
  return entries.flatMap((entry) => [...new Set(entry.scopes)].sort().map((scope, index) => ({ name: `${PRIVATE_REGISTRY_HOSTS[entry.host].key}-${String(index + 1)}`, host: entry.host, scope })));
}

/** What a worker is told of the company's entries: one registry per scope (npm routes each scope to the host), each asked for by its name. An entry with no scope routes nothing and is left out. */
export function prepareRegistriesOfCompany(entries: readonly CompanyRegistryEntry[]): PrepareRegistry[] {
  return companyRegistryNames(entries).filter((item) => ScopeSchema.safeParse(item.scope).success)
    .map((item) => ({ name: item.name, kind: PRIVATE_REGISTRY_HOSTS[item.host].format, format: PRIVATE_REGISTRY_HOSTS[item.host].format, url: `https://${item.host}/`, scope: item.scope }));
}

// ---- what a project may name, by edition and org

export type RegistryProblemCode = "edition_kind" | "host_not_approved" | "domain_not_bound";
export interface RegistryProblem { code: RegistryProblemCode; registry: string }

/** Fixed sentences: they name a registry (a name the project chose), never a host's path or a value. */
export const REGISTRY_PROBLEM_MESSAGES: Readonly<Record<RegistryProblemCode, string>> = {
  edition_kind: "This edition does not support project package registries yet. Public package registries need no entry.",
  host_not_approved: "The registry's address is not on the project's allowed addresses. Ask an admin to allow it, then try again.",
  domain_not_bound: "This registry's CodeArtifact domain and repository are not set up for this organization on this install. Ask the install's admin.",
};

/**
 * A CodeArtifact domain the install lets ONE org use, and the repositories of it that org's projects may read. The broker role's IAM is install-wide (a role holds its permissions for
 * every caller), so the org binding is what keeps one org from naming another's domain: the exchange and the start check it, and the infrastructure grants ReadFromRepository on the
 * listed repositories only (so the token, which carries its minter's permissions, reads nothing else).
 */
export interface BoundRegistryDomain { name: string; owner: string; region: string; orgId: OrgId; repositories: readonly string[] }

/** The broker's variable that holds the bindings (`formatBoundRegistryDomains`). */
export const BOUND_REGISTRY_DOMAINS_VARIABLE = "PROJECT_REGISTRY_DOMAINS";

/** `name:owner:region:orgSuffix:repo+repo`, entries joined by `,`. The org id is written without its `org_` prefix (the Lambda environment is held to 4 KB). */
export function formatBoundRegistryDomains(domains: readonly BoundRegistryDomain[]): string {
  return domains.map((domain) => `${domain.name}:${domain.owner}:${domain.region}:${domain.orgId.slice(4)}:${domain.repositories.join("+")}`).join(",");
}

/** Reads `formatBoundRegistryDomains`. Anything malformed yields no binding at all (fail closed: an unreadable value binds nothing). */
export function parseBoundRegistryDomains(text: string | undefined): BoundRegistryDomain[] {
  if (text === undefined || text === "") return [];
  const result: BoundRegistryDomain[] = [];
  for (const item of text.split(",")) {
    const [name, owner, region, suffix, repositories, extra] = item.split(":");
    const orgId = OrgIdSchema.safeParse(`org_${suffix ?? ""}`);
    const repos = (repositories ?? "").split("+");
    if (extra !== undefined || name === undefined || owner === undefined || region === undefined || !CODEARTIFACT_DOMAIN.test(name) || !/^\d{12}$/.test(owner) || !AWS_REGION.test(region)
      || !orgId.success || repos.length === 0 || repos.some((repo) => !CODEARTIFACT_REPOSITORY.test(repo))) return [];
    result.push({ name, owner, region, orgId: orgId.data, repositories: repos });
  }
  return result;
}

/** Whether `host` is one of `patterns`: exactly, or under a `*.` entry (subdomains only, as the DNS firewall reads it). */
export function hostMatchesDomain(host: string, patterns: readonly string[]): boolean {
  const lower = host.toLowerCase();
  return patterns.some((raw) => {
    const pattern = raw.toLowerCase();
    return pattern.startsWith("*.") ? lower.endsWith(pattern.slice(1)) && lower.length > pattern.length - 1 : lower === pattern;
  });
}

/**
 * Everything that keeps a project's (CodeArtifact) registries from being used on this install, in registry order. The company's package-token hosts are not here: they are a fixed table (`PRIVATE_REGISTRY_HOSTS`), need no edition
 * (the secret is the company's own) and no approved website of the project (a project's allowed websites say what the AI may use, not what setup installs from).
 *  - Public uses no CodeArtifact yet: its install is shared by many companies and a CodeArtifact domain is install-wide until a per-org binding exists;
 *  - a CodeArtifact registry must name a domain, account, region AND repository that the install bound to the requesting org (`boundDomains`); another org's domain gets no token;
 *  - the registry's host must be on the project's approved websites (the normal egress approval).
 * Fail closed: an install that has no edition on record is held to Public's rule, and a missing org binds nothing.
 */
export function registryProblems(input: { edition: Edition | undefined; registries: readonly ProjectRegistry[]; allowedDomains: readonly string[]; orgId?: string | undefined; boundDomains?: readonly BoundRegistryDomain[] }): RegistryProblem[] {
  const edition = input.edition ?? "public";
  const problems: RegistryProblem[] = [];
  for (const entry of input.registries) {
    if (edition === "public") { problems.push({ code: "edition_kind", registry: entry.name }); continue; }
    const bound = input.orgId !== undefined && (input.boundDomains ?? []).some((domain) => domain.orgId === input.orgId && domain.name === entry.domain && domain.owner === entry.domainOwner && domain.region === entry.region && domain.repositories.includes(entry.repository));
    if (!bound) { problems.push({ code: "domain_not_bound", registry: entry.name }); continue; }
    if (!hostMatchesDomain(registryHostOf(entry), input.allowedDomains)) problems.push({ code: "host_not_approved", registry: entry.name });
  }
  return problems;
}

// ---- scrubbing

/**
 * Removes a token from text in every spelling a tool or a transcript could carry it in: raw, JSON-escaped, percent-encoded (once and twice), base64, base64url and hex
 * (`e2eSecretSpellings`). Longest first, so a longer spelling is not left half-redacted by a shorter one. A secret shorter than the token minimum is ignored: it cannot be a token,
 * and replacing a short common string would corrupt output.
 */
export function scrubRegistrySecrets(text: string, secrets: readonly string[]): string {
  let result = text;
  const tokens = secrets.filter((secret) => secret.length >= REGISTRY_TOKEN_MIN_LENGTH);
  const forms = tokens.flatMap((secret) => e2eSecretSpellings(secret));
  for (const form of [...new Set(forms)].sort((a, b) => b.length - a.length)) {
    if (form.length >= 6) result = result.split(form).join("[redacted]");
  }
  // Output that a tool wrapped (`base64` breaks at 76 columns, `fold`, a terminal's width) splits a spelling across lines; the raw, base64 and base64url spellings are also found with
  // line breaks between any two of their characters.
  for (const token of tokens) {
    for (const form of [token, Buffer.from(token).toString("base64"), Buffer.from(token).toString("base64url")]) {
      if (form.length < 16 || form.length > 8_192) continue;
      const wrapped = new RegExp([...form].map((char) => char.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")).join("[\\r\\n]*"), "g");
      result = result.replace(wrapped, "[redacted]");
    }
  }
  return result;
}
