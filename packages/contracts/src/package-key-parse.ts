// Lane P5a (DEC 435 delta D4.1): what a repository's own config files say about WHERE its packages come from. Pure text parsing, browser-safe, no file or network access.
//
// Read: `.npmrc` (only `@scope:registry=`, `registry=` and the KEYS of token lines), `.yarnrc.yml` (`npmScopes` keys, `npmRegistryServer`, the keys of token lines), `.yarnrc` (classic `@scope:registry`),
// and the `resolved` / `tarball` URLs of a lockfile (package-lock, npm-shrinkwrap, yarn.lock, pnpm-lock). Every other value is dropped on the line it is read: a token VALUE is never copied,
// kept, measured or returned (the caller learns file, line and host only).
import { PACKAGE_KEY_HOST_PATTERN, PACKAGE_KEY_SCOPE_PATTERN } from "./package-key.js";

export interface PackageKeyFile { path: string; text: string }
export type PackageKeySource = "npmrc" | "yarnrc" | "lockfile";
/** One place a repository points at a registry: the host, the scope that routes there (when one does) and which file said so. */
export interface RegistryRef { host: string; scope?: string | undefined; source: PackageKeySource }
/** A token VALUE written in a committed file. The value is never carried: only where it is. */
export interface CommittedToken { file: string; line: number; host?: string | undefined }
export interface ParsedConfig { refs: RegistryRef[]; committed: CommittedToken[] }

/** Registries and git hosts that need no company token (public reads). A scope routed to one of them is not a private registry. */
export const PUBLIC_PACKAGE_HOSTS: ReadonlySet<string> = new Set(["registry.npmjs.org", "registry.npmjs.com", "registry.yarnpkg.com", "github.com", "codeload.github.com", "gitlab.com", "bitbucket.org", "raw.githubusercontent.com"]);

export const PACKAGE_KEY_LIMITS = { lines: 20_000, lineLength: 4_096, refs: 64 } as const;
const ENV_REFERENCE = /^\$\{[^}]*\}$/u;

export function hostOfUrl(value: string): string | undefined {
  let url: URL;
  try { url = new URL(value.trim()); } catch { return undefined; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const host = url.hostname.toLowerCase();
  return PACKAGE_KEY_HOST_PATTERN.test(host) ? host : undefined;
}

const unquote = (value: string): string => {
  const first = value[0];
  return value.length >= 2 && (first === "\"" || first === "'") && value.endsWith(first) ? value.slice(1, -1) : value;
};
/** A literal secret value: not empty and not wholly a `${ENV}` reference. */
const isLiteral = (value: string): boolean => value.length > 0 && !ENV_REFERENCE.test(value);

function linesOf(text: string): string[] {
  return text.split(/\r?\n/u, PACKAGE_KEY_LIMITS.lines).map((line) => (line.length > PACKAGE_KEY_LIMITS.lineLength ? line.slice(0, PACKAGE_KEY_LIMITS.lineLength) : line));
}

// ---- .npmrc

const NPMRC_TOKEN_SUFFIXES = ["_authToken", "_auth", "_password"] as const;

function npmrcTokenKey(key: string): { host?: string | undefined } | undefined {
  const name = key.includes(":") ? key.slice(key.lastIndexOf(":") + 1) : key;
  if (!(NPMRC_TOKEN_SUFFIXES as readonly string[]).includes(name)) return undefined;
  const prefix = key.startsWith("//") ? key.slice(2).split(/[/:]/u, 1)[0]?.toLowerCase() : undefined;
  return { host: prefix !== undefined && PACKAGE_KEY_HOST_PATTERN.test(prefix) ? prefix : undefined };
}

function npmrcRef(key: string, value: string): RegistryRef | undefined {
  const scoped = /^(@[^:\s]+):registry$/iu.exec(key);
  if (key !== "registry" && scoped === null) return undefined;
  const host = hostOfUrl(value);
  if (host === undefined) return undefined;
  const scope = scoped?.[1]?.toLowerCase();
  return { host, source: "npmrc", ...(scope !== undefined && PACKAGE_KEY_SCOPE_PATTERN.test(scope) ? { scope } : {}) };
}

export function parseNpmrc(text: string, path: string): ParsedConfig {
  const result: ParsedConfig = { refs: [], committed: [] };
  linesOf(text).forEach((raw, index) => {
    const line = raw.trim();
    const equals = line.indexOf("=");
    if (line === "" || line.startsWith(";") || line.startsWith("#") || equals <= 0) return;
    const key = line.slice(0, equals).trim();
    const value = unquote(line.slice(equals + 1).trim());
    const token = npmrcTokenKey(key);
    if (token !== undefined) {
      if (isLiteral(value)) result.committed.push({ file: path, line: index + 1, host: token.host });
      return;
    }
    const ref = npmrcRef(key, value);
    if (ref !== undefined) result.refs.push(ref);
  });
  return result;
}

// ---- .yarnrc (classic)

export function parseYarnrcClassic(text: string): ParsedConfig {
  const refs: RegistryRef[] = [];
  for (const raw of linesOf(text)) {
    const match = /^\s*"?(@[^\s":]+:registry|registry)"?\s+"?([^"\s]+)"?\s*$/iu.exec(raw);
    const host = match?.[2] === undefined ? undefined : hostOfUrl(match[2]);
    if (match?.[1] === undefined || host === undefined) continue;
    const scope = match[1].toLowerCase() === "registry" ? undefined : match[1].slice(0, -":registry".length).toLowerCase();
    refs.push({ host, source: "yarnrc", ...(scope !== undefined && PACKAGE_KEY_SCOPE_PATTERN.test(scope) ? { scope } : {}) });
  }
  return { refs, committed: [] };
}

// ---- .yarnrc.yml (Yarn Berry): a minimal indentation reader; it needs only three blocks and never evaluates YAML

interface YamlLine { indent: number; key: string; value: string; number: number }

function yamlLines(text: string): YamlLine[] {
  const rows: YamlLine[] = [];
  linesOf(text).forEach((raw, index) => {
    const match = /^(\s*)("[^"]*"|'[^']*'|[^\s:#"'][^\s:#]*)\s*:(?:\s+(.*))?$/u.exec(raw);
    if (match?.[2] === undefined) return;
    const value = unquote((match[3] ?? "").replace(/\s+#.*$/u, "").trim());
    rows.push({ indent: match[1]?.length ?? 0, key: unquote(match[2]), value, number: index + 1 });
  });
  return rows;
}

const hostOfRegistryKey = (key: string): string | undefined => {
  const bare = key.replace(/^(?:https?:)?\/\//iu, "").split("/", 1)[0]?.toLowerCase();
  return bare !== undefined && PACKAGE_KEY_HOST_PATTERN.test(bare) ? bare : undefined;
};
const YARN_TOKEN_KEYS: ReadonlySet<string> = new Set(["npmAuthToken", "npmAuthIdent"]);

interface YarnReadState { block?: string | undefined; entryIndent?: number | undefined; scope?: string | undefined; host?: string | undefined }

function readYarnTopLevel(result: ParsedConfig, state: YarnReadState, row: YamlLine, path: string): void {
  state.block = row.key; state.entryIndent = undefined; state.scope = undefined; state.host = undefined;
  if (row.key === "npmRegistryServer") pushYarnServer(result, undefined, row.value);
  else if (YARN_TOKEN_KEYS.has(row.key) && isLiteral(row.value)) result.committed.push({ file: path, line: row.number });
}

function readYarnEntry(result: ParsedConfig, state: YarnReadState, row: YamlLine, path: string): void {
  if (row.indent === state.entryIndent) {
    state.scope = state.block === "npmScopes" ? `@${row.key}`.toLowerCase() : undefined;
    state.host = state.block === "npmRegistries" ? hostOfRegistryKey(row.key) : undefined;
    if (state.host !== undefined) result.refs.push({ host: state.host, source: "yarnrc" });
  } else if (row.key === "npmRegistryServer") {
    state.host = pushYarnServer(result, state.scope, row.value);
  } else if (YARN_TOKEN_KEYS.has(row.key) && isLiteral(row.value)) {
    result.committed.push({ file: path, line: row.number, host: state.host });
  }
}

/** Walks the lines once, remembering the top-level block and the entry (scope or registry) being read. */
export function parseYarnrcYml(text: string, path: string): ParsedConfig {
  const result: ParsedConfig = { refs: [], committed: [] };
  const state: YarnReadState = {};
  for (const row of yamlLines(text)) {
    if (row.indent === 0) { readYarnTopLevel(result, state, row, path); continue; }
    if (state.block !== "npmScopes" && state.block !== "npmRegistries") continue;
    state.entryIndent ??= row.indent;
    readYarnEntry(result, state, row, path);
  }
  return result;
}

function pushYarnServer(result: ParsedConfig, scope: string | undefined, value: string): string | undefined {
  const host = hostOfUrl(value);
  if (host !== undefined) result.refs.push({ host, source: "yarnrc", ...(scope !== undefined && PACKAGE_KEY_SCOPE_PATTERN.test(scope) ? { scope } : {}) });
  return host;
}

// ---- lockfiles

/** A URL in a lockfile line. Any user-info (`user:pw@`, a committed token) is matched but never read as the host: it is dropped before the URL is parsed. */
const URL_IN_LINE = /https?:\/\/(?:[^\s/@"'<>]{1,1024}@)?[a-z0-9][a-z0-9.-]{0,252}(?::\d{1,5})?(?:\/[^\s"'<>)\]},]*)?/giu;
const SCOPE_IN_PATH = /(?:^|\/)(@[a-z0-9][a-z0-9._-]{0,63})(?:\/|%2f)/iu;

/** The scope a tarball or metadata path belongs to: `/download/@acme/pkg/1.0.0/hash` and `/@acme%2fpkg` both say `@acme`. */
export function scopeOfRegistryPath(path: string): string | undefined {
  const scope = SCOPE_IN_PATH.exec(path)?.[1]?.toLowerCase();
  return scope !== undefined && PACKAGE_KEY_SCOPE_PATTERN.test(scope) ? scope : undefined;
}

function lockfileRef(urlText: string): RegistryRef | undefined {
  const host = hostOfUrl(urlText);
  if (host === undefined || PUBLIC_PACKAGE_HOSTS.has(host)) return undefined;
  const scope = scopeOfRegistryPath(new URL(urlText).pathname);
  return { host, source: "lockfile", ...(scope === undefined ? {} : { scope }) };
}

export function parseLockfile(text: string): ParsedConfig {
  const seen = new Map<string, RegistryRef>();
  for (const raw of linesOf(text)) {
    if (seen.size >= PACKAGE_KEY_LIMITS.refs) break;
    if (!/resolved|tarball/iu.test(raw)) continue;
    for (const match of raw.matchAll(URL_IN_LINE)) {
      const found = lockfileRef(match[0].replace(/^(https?:\/\/)[^/@]*@/iu, "$1"));
      if (found !== undefined) seen.set(`${found.host}|${found.scope ?? ""}`, found);
    }
  }
  return { refs: [...seen.values()], committed: [] };
}

/** Which parser reads a file, by its base name. A file the detector does not know is skipped. */
export function parserFor(path: string): ((text: string, path: string) => ParsedConfig) | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name === ".npmrc") return parseNpmrc;
  if (name === ".yarnrc.yml") return parseYarnrcYml;
  if (name === ".yarnrc") return (text) => parseYarnrcClassic(text);
  if (["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"].includes(name)) return (text) => parseLockfile(text);
  return undefined;
}
