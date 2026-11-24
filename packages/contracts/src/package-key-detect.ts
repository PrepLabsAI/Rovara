// Lane P5a (DEC 435 delta D4.1 to D4.3; PRIVATE-PACKAGES plan check (e)): decide that a repository "needs a package key" WITHOUT reading a secret and with the fewest installs possible.
//
//   1. STATIC, before any install: `detectStaticPackageKeys` reads the repository's own config files and lockfiles (see package-key-parse.ts). A scope routed to a registry Rovara knows needs a
//      token on every read (GitHub Packages) while the company holds none for that host: the repository is `untested: missing` at once and the caller runs ZERO installs for it.
//   2. DYNAMIC, after ONE install attempt: `classifyInstallFailure` reads the scrubbed output of a failed install. A 401 / 403 / hidden-package answer from a private registry host of the repository
//      is `needs_package_key` (`refused` when a token was used, else `missing`). A plain network error, a public registry's 404 and any other 403 are NOT: they stay what they were. A shared ROOT
//      install is judged for every repository under the root (untested, never failed).
//
// Secrets: the only question ever asked about a token is `hasCompanyToken(host)`, answered set or not set by the caller (Secrets Manager is never read here). A token committed in a repository
// config file is REPORTED (file, line, host) without its value and is never used. Pure and browser-safe: text in, facts out.
import {
  PACKAGE_KEY_KNOWN_HOSTS,
  packageKeyUntested,
  type PackageKeyUntested,
} from "./package-key.js";
import {
  PACKAGE_KEY_LIMITS,
  PUBLIC_PACKAGE_HOSTS,
  hostOfUrl,
  parserFor,
  scopeOfRegistryPath,
  type CommittedToken,
  type PackageKeyFile,
  type PackageKeySource,
} from "./package-key-parse.js";

export type { CommittedToken, PackageKeyFile, PackageKeySource } from "./package-key-parse.js";

/** Answers "is a token stored for this registry host?" with a yes or no. It never returns, and the detector never asks for, the token. */
export type HasCompanyToken = (host: string) => boolean;

/** A private registry a repository points at: the host, the scopes routed there, and which kinds of file said so. */
export interface PrivateRegistryUse { host: string; scopes: string[]; sources: PackageKeySource[] }

export interface PackageKeyFindings {
  repo: string;
  registries: PrivateRegistryUse[];
  /** Token values written in the repository's own files: where they are, never what they are. Never used. */
  committedTokens: CommittedToken[];
}

export interface StaticPackageKeyResult extends PackageKeyFindings {
  /** Present when the repository cannot be installed for want of a token that is known to be needed: run NO install for it. */
  untested?: PackageKeyUntested | undefined;
}

const isPrivateHost = (host: string): boolean => !PUBLIC_PACKAGE_HOSTS.has(host);

/** What a repository's files say, without judging it: the private registries and the committed tokens. Files over the total bound are cut off (the first ones win). */
export function readPackageKeyFindings(repo: string, files: readonly PackageKeyFile[]): PackageKeyFindings {
  const byHost = new Map<string, { scopes: Set<string>; sources: Set<PackageKeySource> }>();
  const committedTokens: CommittedToken[] = [];
  for (const file of files) {
    const parse = parserFor(file.path);
    if (parse === undefined) continue;
    const parsed = parse(file.text, file.path);
    committedTokens.push(...parsed.committed);
    for (const ref of parsed.refs.filter((candidate) => isPrivateHost(candidate.host))) {
      if (!byHost.has(ref.host) && byHost.size >= PACKAGE_KEY_LIMITS.refs) continue;
      const use = byHost.get(ref.host) ?? { scopes: new Set<string>(), sources: new Set<PackageKeySource>() };
      if (ref.scope !== undefined) use.scopes.add(ref.scope);
      use.sources.add(ref.source);
      byHost.set(ref.host, use);
    }
  }
  const registries = [...byHost].map(([host, use]) => ({ host, scopes: [...use.scopes].sort(), sources: [...use.sources].sort() })).sort((left, right) => (left.host < right.host ? -1 : 1));
  return { repo, registries, committedTokens };
}

/** Step 1: before any install. A known token-only registry (GitHub Packages) with no company token stored makes the repository `untested: missing` with zero installs. */
export function detectStaticPackageKeys(input: { repo: string; files: readonly PackageKeyFile[]; hasCompanyToken: HasCompanyToken }): StaticPackageKeyResult {
  const findings = readPackageKeyFindings(input.repo, input.files);
  const needed = findings.registries.find((registry) => PACKAGE_KEY_KNOWN_HOSTS[registry.host] !== undefined && !input.hasCompanyToken(registry.host));
  return needed === undefined ? findings : { ...findings, untested: packageKeyUntested("missing", needed.host, needed.scopes) };
}

// ---- step 2: the output of a failed install

const OUTPUT_TAIL_BYTES = 262_144;
const WINDOW_LINES = 3;
const GITHUB_PACKAGES_HOST = "npm.pkg.github.com";

/** Each pattern's first group is the status. Written for npm (`code E401`, `401 Unauthorized - GET`), yarn 1 (`Request failed "401 Unauthorized"`), Yarn Berry (`Response Code: 401`), pnpm (`ERR_PNPM_FETCH_401`). */
const STATUS_PATTERNS: readonly RegExp[] = [
  /\bE(40[134])\b/u,
  /\b(40[134])\s+(?:unauthorized|forbidden|not found)\b/iu,
  /\b(?:unauthorized|forbidden|not found)\b\s*[-:(]?\s*(40[134])\b/iu,
  /ERR_PNPM_FETCH_(40[134])/u,
  /response code:\s*(40[134])\b/iu,
  /request failed "(40[134])/iu,
];
/** Answers that name no number: "no token was sent" and "the token was sent and may not read this package". */
const UNAUTHENTICATED = /unable to authenticate|authentication token (?:not found|seems to be invalid)|no authentication configured/iu;
const GITHUB_ORGANIZATION_PACKAGE = /not allowed to read (?:the )?organization package|permission[_ ]denied:? (?:read_package|the token provided)/iu;
const URL_ANYWHERE = /https?:\/\/[a-z0-9][a-z0-9.-]{0,252}(?::\d{1,5})?(?:\/[^\s"'<>)\]},]*)?/giu;

function statusOfLine(line: string): 401 | 403 | 404 | undefined {
  for (const pattern of STATUS_PATTERNS) {
    const code = pattern.exec(line)?.[1];
    if (code !== undefined) return Number(code) as 401 | 403 | 404;
  }
  if (GITHUB_ORGANIZATION_PACKAGE.test(line)) return 403;
  return UNAUTHENTICATED.test(line) ? 401 : undefined;
}

interface UrlFact { host: string; scope?: string | undefined }

function urlsOf(line: string): UrlFact[] {
  const facts: UrlFact[] = [];
  for (const match of line.matchAll(URL_ANYWHERE)) {
    const host = hostOfUrl(match[0]);
    if (host !== undefined) facts.push({ host, scope: scopeOfRegistryPath(new URL(match[0]).pathname) });
  }
  return facts;
}

/** The URLs a status line is about: its own, or (when it names none) the nearest line within a few lines that names one (Berry prints `Response Code` and `Request URL` apart). */
function urlsFor(lines: readonly string[], index: number): UrlFact[] {
  const own = urlsOf(lines[index] ?? "");
  if (own.length > 0) return own;
  for (let step = 1; step <= WINDOW_LINES; step += 1) {
    for (const at of [index + step, index - step]) {
      const near = urlsOf(lines[at] ?? "");
      if (near.length > 0) return near;
    }
  }
  return [];
}

/** The private registry hosts an install's output was refused by (first seen first), with the scopes its failing URLs named. */
function refusedHosts(output: string, known: ReadonlySet<string>): Map<string, Set<string>> {
  const lines = output.slice(-OUTPUT_TAIL_BYTES).split(/\r?\n/u, PACKAGE_KEY_LIMITS.lines).map((line) => line.slice(0, PACKAGE_KEY_LIMITS.lineLength));
  const refused = new Map<string, Set<string>>();
  lines.forEach((line, index) => {
    if (statusOfLine(line) === undefined) return;
    const facts = urlsFor(lines, index).filter((fact) => known.has(fact.host));
    if (facts.length === 0 && GITHUB_ORGANIZATION_PACKAGE.test(line)) facts.push({ host: GITHUB_PACKAGES_HOST });
    for (const fact of facts) {
      const scopes = refused.get(fact.host) ?? new Set<string>();
      if (fact.scope !== undefined) scopes.add(fact.scope);
      refused.set(fact.host, scopes);
    }
  });
  return refused;
}

/** One repository an install ran for: what the static read found, so a private host of ITS own is recognised. */
export interface InstallRepo { repo: string; registries: readonly { host: string; scopes: readonly string[] }[] }

export interface InstallFailureInput {
  /** The SCRUBBED install output (a token must already be removed; this reads text, it does not hold secrets). */
  output: string;
  /** The install's exit code. 0 is never a failure. `null` (killed, timed out) is judged on its output like any other. */
  exitCode: number | null;
  /** The repositories this install covered: one for a per-repository install, every repository under the root for a shared root install. */
  repos: readonly InstallRepo[];
  hasCompanyToken: HasCompanyToken;
}

export type InstallFailureClassification =
  | { outcome: "other" }
  | { outcome: "needs_package_key"; repos: { repo: string; untested: PackageKeyUntested }[]; host: string; otherHosts: string[] };

/**
 * Step 2: ONE install attempt failed. Is it a missing or refused package key? Only a 401 / 403 / 404 (E401, E403, "Unauthorized", "Forbidden", GitHub's "not allowed to read organization package")
 * that names a PRIVATE registry host (GitHub Packages, or a host these repositories route a scope or a lockfile to) counts. A network error (ENOTFOUND, ETIMEDOUT, ECONNRESET, a DNS block), a 404 or 403
 * from a public registry or a git host, and an exit code 0 are `other`. The install is not retried either way.
 */
export function classifyInstallFailure(input: InstallFailureInput): InstallFailureClassification {
  if (input.exitCode === 0 || input.repos.length === 0) return { outcome: "other" };
  const known = new Set<string>(Object.keys(PACKAGE_KEY_KNOWN_HOSTS));
  for (const repo of input.repos) for (const registry of repo.registries) if (isPrivateHost(registry.host)) known.add(registry.host);
  const refused = refusedHosts(input.output, known);
  const [first, ...rest] = refused.keys();
  if (first === undefined) return { outcome: "other" };
  const detail = input.hasCompanyToken(first) ? "refused" : "missing";
  const repos = input.repos.map((repo) => ({
    repo: repo.repo,
    untested: packageKeyUntested(detail, first, [...(repo.registries.find((registry) => registry.host === first)?.scopes ?? []), ...(refused.get(first) ?? [])]),
  }));
  return { outcome: "needs_package_key", repos, host: first, otherHosts: rest };
}
