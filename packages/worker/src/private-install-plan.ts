// Private packages P2a: what the install step decides BEFORE any token is fetched, and how it reads the result. Pure functions and bounded file reads; nothing here starts a container or touches a secret.
//   - `inspectRepository`: which package manager a repository uses (from its lockfile; never the repo's own pin), whether it names a supported private host, and its `.npmrc`;
//   - `parseNpmrc`: the repository's `.npmrc` checked against an ALLOW-list (never a deny-list), and the lines that are kept for the derived copy;
//   - `renderDerivedNpmrc`, `renderUserNpmrc`, `renderYarnrc`: the token files (the token is an argument, never stored here);
//   - `classifyInstallOutput`: the scrubbed output of one run, reduced to a fixed outcome code. Nothing of the output leaves this module.
import { createHash } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { redactText } from "@agentx/contracts";

export const GITHUB_PACKAGES_HOST = "npm.pkg.github.com";
const GITHUB_PACKAGES_URL = `https://${GITHUB_PACKAGES_HOST}/`;
/** Where the install container reads its token files (the host folder is mounted read-only at this fixed path). */
export const INSTALL_MOUNT_PATH = "/run/rovara-install";
/** The package managers the worker image ships (official node image: npm 10 and yarn 1.22). pnpm and Yarn Berry are refused until an image lane pins them. */
export type InstallManager = "npm" | "yarn1";
export type LockfileKind = "npm" | "yarn1" | "pnpm" | "berry";

export const PRIVATE_INSTALL_OUTCOMES = [
  "installed", "untested_missing", "untested_refused", "registry_unreachable",
  "refused_manager_not_in_image", "refused_ambiguous_lockfile", "refused_no_lockfile", "refused_npmrc_key", "refused_devcontainer", "refused_not_ec2", "refused_no_secure_tmpfs", "refused_unsafe_token",
  "failed_token_unavailable", "failed_network", "failed_public_registry", "failed_engine", "failed_timeout", "failed_changed_files", "failed_unknown",
] as const;
export type PrivateInstallOutcome = (typeof PRIVATE_INSTALL_OUTCOMES)[number];

/** One line per outcome, in fixed words (what the diagnostic and the person see). Never a package-manager line. */
export const PRIVATE_INSTALL_SENTENCES: Readonly<Record<Exclude<PrivateInstallOutcome, "installed">, string>> = {
  untested_missing: "the company has no package token for this registry",
  untested_refused: "the package token was not accepted by the registry",
  registry_unreachable: "Rovara staff must turn on GitHub Packages for this install",
  refused_manager_not_in_image: "this repository's package manager is not in Rovara's image yet (npm and yarn 1 only)",
  refused_ambiguous_lockfile: "this repository has more than one lockfile, so Rovara cannot tell which package manager to use",
  refused_no_lockfile: "this repository has no lockfile, so Rovara cannot install private packages safely",
  refused_npmrc_key: "this repository's .npmrc sets something Rovara does not allow for a private install",
  refused_devcontainer: "a project with a devcontainer cannot use private package registries yet",
  refused_not_ec2: "private package installs run on Rovara's hosted workers only",
  refused_no_secure_tmpfs: "this machine has no private memory-only folder for the package token",
  refused_unsafe_token: "Rovara cannot use the company's package token",
  failed_token_unavailable: "Rovara could not get the company's package token for this run",
  failed_network: "the registry could not be reached",
  failed_public_registry: "a public registry refused the install",
  failed_engine: "the repository needs a Node version the image does not have",
  failed_timeout: "the install took too long",
  failed_changed_files: "the install changed the repository's tracked files",
  failed_unknown: "the install failed",
};

// ---- the repository's .npmrc: an allow-list

const SIMPLE_KEYS: ReadonlySet<string> = new Set(["engine-strict", "legacy-peer-deps", "strict-peer-deps", "auto-install-peers", "save-exact", "save-prefix", "package-lock", "fund", "audit", "loglevel", "progress"]);
const SIMPLE_VALUE = /^[A-Za-z0-9._~^-]{0,32}$/u;
const SCOPE_KEY = /^(@[a-z0-9][a-z0-9._-]{0,63}):registry$/u;
const PUBLIC_REGISTRY_HOSTS: ReadonlySet<string> = new Set(["registry.npmjs.org", "registry.yarnpkg.com"]);
const AUTH_KEY = `//${GITHUB_PACKAGES_HOST}/:_authToken`;

/** The refused key as it may be named: a short, plain name, never a value and never a line that has no `=` (such a line could itself be a pasted secret). */
export function nameableKey(key: string, hadEquals: boolean): string {
  if (!hadEquals || !/^[A-Za-z0-9@_:/.-]{1,80}$/u.test(key) || redactText(key) !== key) return "(a line without a name)";
  return key;
}

export type NpmrcReading = { ok: true; kept: string[]; githubScopes: string[]; droppedAuth: boolean } | { ok: false; key: string };

const unquote = (value: string): string => (/^(["']).*\1$/u.test(value) && value.length >= 2 ? value.slice(1, -1) : value);
const hostOf = (url: string): string | undefined => { try { const parsed = new URL(url); return parsed.protocol === "https:" ? parsed.hostname.toLowerCase() : undefined; } catch { return undefined; } };

type LineResult = { kind: "keep"; line: string } | { kind: "scope"; scope: string } | { kind: "drop" } | { kind: "refuse" };

/** One `@scope:registry` line: GitHub Packages (the scope is ours to route), a public registry for a scope the company does not hold (kept), or refused. */
function readScopeLine(scope: string, key: string, value: string, companyScopes: readonly string[]): LineResult {
  const host = hostOf(value);
  if (host === GITHUB_PACKAGES_HOST) return { kind: "scope", scope };
  if (host !== undefined && PUBLIC_REGISTRY_HOSTS.has(host) && !companyScopes.includes(scope)) return { kind: "keep", line: `${key}=${value}` };
  return { kind: "refuse" };
}

/** One line against the allow-list. */
function readLine(key: string, value: string, hasValue: boolean, companyScopes: readonly string[]): LineResult {
  if (key === AUTH_KEY) return { kind: "drop" };
  const scope = SCOPE_KEY.exec(key)?.[1];
  if (scope !== undefined) return readScopeLine(scope, key, value, companyScopes);
  if (key === "registry") {
    const host = hostOf(value);
    return host !== undefined && PUBLIC_REGISTRY_HOSTS.has(host) ? { kind: "keep", line: `${key}=${value}` } : { kind: "refuse" };
  }
  if (SIMPLE_KEYS.has(key) && SIMPLE_VALUE.test(value)) return { kind: "keep", line: hasValue ? `${key}=${value}` : key };
  return { kind: "refuse" };
}

/**
 * Reads a repository's `.npmrc` (text) against the allow-list. Every key must be one of: `@<scope>:registry` (to GitHub Packages, or to a public registry for a scope the company does not hold), `registry` (a public registry only), the GitHub
 * Packages `_authToken` line (dropped whatever its value, `${NPM_TOKEN}` included), or one of a few harmless switches. Anything else is refused and its KEY is named: `script-shell`, `node-options`, `globalconfig`, `userconfig`, `prefix`,
 * `cache`, `proxy`, `https-proxy`, `ca`, `cafile`, `always-auth`, `_auth`, any other host's token or password, any `${...}` outside the dropped auth line, an INI section.
 */
export function parseNpmrc(text: string, companyScopes: readonly string[]): NpmrcReading {
  const kept: string[] = [];
  const githubScopes: string[] = [];
  let droppedAuth = false;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "" || line.startsWith(";") || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    const key = (at < 0 ? line : line.slice(0, at)).trim();
    const read = readLine(key, at < 0 ? "" : unquote(line.slice(at + 1).trim()), at >= 0, companyScopes);
    if (read.kind === "refuse") return { ok: false, key: nameableKey(key, at >= 0) };
    if (read.kind === "keep") kept.push(read.line);
    else if (read.kind === "scope") githubScopes.push(read.scope);
    else droppedAuth = true;
  }
  return { ok: true, kept, githubScopes: [...new Set(githubScopes)], droppedAuth };
}

// ---- the token files (the token is an argument; these functions store nothing)

const routeLines = (scopes: readonly string[]): string[] => [...new Set(scopes)].sort().map((scope) => `${scope}:registry=${GITHUB_PACKAGES_URL}`);
const authLine = (token: string): string => `//${GITHUB_PACKAGES_HOST}/:_authToken=${token}`;

/** The npm userconfig: scope routing and ONE host-keyed token line. Never an unscoped `_authToken`, `_auth` or `always-auth`. */
export const renderUserNpmrc = (scopes: readonly string[], token: string): string => `${[...routeLines(scopes), authLine(token)].join("\n")}\n`;

/** The copy mounted over the repository's `.npmrc` inside the container only: the kept lines, our routing, and the one token line. */
export function renderDerivedNpmrc(kept: readonly string[], scopes: readonly string[], token: string): string {
  return `${[...new Set([...kept, ...routeLines(scopes)]), authLine(token)].join("\n")}\n`;
}

/** The yarn 1 rc (`--use-yarnrc`, with `--no-default-rc`): the same routing and token, in yarn's own quoting. */
export function renderYarnrc(scopes: readonly string[], token: string): string {
  const lines = [...new Set(scopes)].sort().map((scope) => `"${scope}:registry" "${GITHUB_PACKAGES_URL}"`);
  return `${[...lines, `"${AUTH_KEY}" "${token}"`].join("\n")}\n`;
}

// ---- the repository

export interface RepositoryInspection {
  /** Whether the repository names the supported host anywhere that decides where packages come from: its `.npmrc`, a yarn rc, or a lockfile's `resolved` addresses. */
  namesHost: boolean;
  /** The package managers its lockfiles belong to (distinct). */
  lockfiles: LockfileKind[];
  /** SHA-256 of the lockfile of the one manager (or of all, in order, when there are several), for the resume rule. */
  lockfileSha256?: string;
  /** The `.npmrc`: absent, a regular file with its text, or something else (a link, a folder). */
  npmrc: { kind: "absent" } | { kind: "file"; text: string } | { kind: "other" };
}

const LOCKFILE_BYTES_MAX = 64 * 1024 * 1024;
const RC_BYTES_MAX = 64 * 1024;
const LOCKFILES = [["package-lock.json", "npm"], ["npm-shrinkwrap.json", "npm"], ["yarn.lock", "yarn1"], ["pnpm-lock.yaml", "pnpm"]] as const;

const lstatOrUndefined = (path: string) => lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });

async function readSmallFile(path: string): Promise<{ kind: "absent" } | { kind: "file"; text: string } | { kind: "other" }> {
  const info = await lstatOrUndefined(path);
  if (info === undefined) return { kind: "absent" };
  if (!info.isFile() || info.size > RC_BYTES_MAX) return { kind: "other" };
  return { kind: "file", text: await readFile(path, "utf8") };
}

async function readBounded(path: string): Promise<Buffer | undefined> {
  const info = await lstatOrUndefined(path);
  if (info === undefined || !info.isFile() || info.size > LOCKFILE_BYTES_MAX) return undefined;
  const handle = await open(path, "r");
  try { return await handle.readFile(); } finally { await handle.close(); }
}

/** Reads the repository's files at `directory` (at the recorded commit, before any install): lockfiles, rc files and the `.npmrc`. A bounded, read-only look; no repository code runs. */
export async function inspectRepository(directory: string): Promise<RepositoryInspection> {
  const kinds = new Set<LockfileKind>();
  const hash = createHash("sha256");
  let namesHost = false;
  for (const [name, kind] of LOCKFILES) {
    const bytes = await readBounded(join(directory, name));
    if (bytes === undefined) continue;
    // A Yarn Berry lockfile starts with its `__metadata` block; a yarn 1 lockfile has none.
    kinds.add(kind === "yarn1" && bytes.subarray(0, 4_096).includes("__metadata") ? "berry" : kind);
    hash.update(`${name}\0`).update(bytes);
    if (bytes.includes(GITHUB_PACKAGES_HOST)) namesHost = true;
  }
  const npmrc = await readSmallFile(join(directory, ".npmrc"));
  for (const name of [".yarnrc", ".yarnrc.yml"]) {
    const rc = await readSmallFile(join(directory, name));
    if (rc.kind === "file" && rc.text.includes(GITHUB_PACKAGES_HOST)) namesHost = true;
  }
  if (npmrc.kind === "file" && npmrc.text.includes(GITHUB_PACKAGES_HOST)) namesHost = true;
  return { namesHost, lockfiles: [...kinds], ...(kinds.size === 0 ? {} : { lockfileSha256: hash.digest("hex") }), npmrc };
}

/** The manager of a repository, or the plain refusal: no lockfile, several managers, or one the image does not ship. */
export function selectManager(lockfiles: readonly LockfileKind[]): { ok: true; manager: InstallManager } | { ok: false; outcome: "refused_no_lockfile" | "refused_ambiguous_lockfile" | "refused_manager_not_in_image" } {
  if (lockfiles.length === 0) return { ok: false, outcome: "refused_no_lockfile" };
  if (lockfiles.length > 1) return { ok: false, outcome: "refused_ambiguous_lockfile" };
  const kind = lockfiles[0]!;
  return kind === "npm" || kind === "yarn1" ? { ok: true, manager: kind } : { ok: false, outcome: "refused_manager_not_in_image" };
}

/** The fixed command of a manager (the image's own, scripts off, repository code not loaded). The argument list is asserted exactly by the container's args check. */
export function installCommand(manager: InstallManager): string[] {
  if (manager === "npm") return ["/usr/local/bin/npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=warn", "--include=dev"];
  return ["/usr/local/bin/yarn", "install", "--frozen-lockfile", "--ignore-scripts", "--non-interactive", "--no-progress", "--no-default-rc", "--use-yarnrc", `${INSTALL_MOUNT_PATH}/yarnrc`, "--production=false"];
}

// ---- the result of one run

export interface InstallRunResult { exitCode: number | null; stdout: string; stderr: string; timedOut?: boolean | undefined }

const HOST = GITHUB_PACKAGES_HOST.replace(/\./gu, "\\.");
const REFUSED_STATUS = /E40[134]\b|\b40[134] (?:Unauthorized|Forbidden|Not Found)|Request failed "40[134]|Incorrect or missing password|authentication token/iu;
const NETWORK = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ESOCKETTIMEDOUT|socket hang up|network (?:timeout|error)|\b5\d\d\b[^\n]*(?:Bad Gateway|Service Unavailable|Gateway Time-?out|Internal Server Error)|E5\d\d/iu;

/**
 * The fixed outcome of one run, from its SCRUBBED output (the caller scrubs the token first). Reads classes of failure only; no text of the output is returned.
 * A 401, 403 or 404 that names the supported host is the registry saying no to a token that was used. The same code from a public host is not the package token's fault.
 */
export function classifyInstallOutput(result: InstallRunResult): PrivateInstallOutcome {
  const text = `${result.stderr}\n${result.stdout}`;
  if (result.exitCode === 0 && result.timedOut !== true) return "installed";
  if (result.timedOut === true) return "failed_timeout";
  if (new RegExp(`ENOTFOUND[^\\n]*${HOST}|${HOST}[^\\n]*ENOTFOUND|NXDOMAIN[^\\n]*${HOST}`, "iu").test(text)) return "registry_unreachable";
  const namesHost = new RegExp(HOST, "iu").test(text);
  if (REFUSED_STATUS.test(text) && namesHost) return "untested_refused";
  if (/EBADENGINE|The engine "[^"]+" is incompatible/u.test(text)) return "failed_engine";
  if (NETWORK.test(text)) return "failed_network";
  if (REFUSED_STATUS.test(text)) return "failed_public_registry";
  return "failed_unknown";
}

/** True for the outcomes that are a network fault worth one retry. */
export const isRetryable = (outcome: PrivateInstallOutcome): boolean => outcome === "failed_network";
