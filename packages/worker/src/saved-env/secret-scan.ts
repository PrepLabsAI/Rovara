// Setup and test health SH22 (design setup-test-health.md, sections 5.1 and 12): "no secrets in any layer". The image build scans the staged tree BEFORE anything is built, and a single finding ends the build
// with no image (`secrets_found`); the project then sets up fresh, as before.
//
// Three things are looked for, strongest first:
//   1. EXACT VALUES the worker itself holds or handed out (`forbiddenValues`: the registry login, a repository clone credential, a model key, the value of any credential-shaped environment variable). Searched in
//      EVERY file, dependency folders included. This is the check that matters most: setup has no secrets, so a secret in the tree can only be one Rovara's own machinery left behind.
//   2. CREDENTIAL FILES by name and content (`.env`, `.git-credentials`, `.netrc`, a `.npmrc` or `.pypirc` holding a token, `.aws/credentials`, `.docker/config.json` with an `auths` entry, a private key file),
//      and `.git/config` holding a credential (a URL with a password, an extra header, a credential section).
//   3. CREDENTIAL-SHAPED TEXT: private key blocks, provider token formats, a URL with a password, an AWS secret key assignment. In dependency folders (node_modules, virtual environments, caches) only the provider
//      token formats are looked for: a package's test fixtures hold private keys that are not anyone's secret, and failing every Node project on them would make saved images useless.
//
// The EXACT-VALUE check reads every file WHOLE, in overlapping chunks (a value split across two chunks is still found). The regular-expression checks read at most `MAX_SCANNED_BYTES_PER_FILE` of a file (a larger
// file is almost always an archive or a binary).
//
// LINKS: a symbolic link is never followed. `links.ts` decides which are acceptable, on the real tree: a relative link that stays inside the seed without passing through another link, a virtual
// environment's interpreter link into the base image's interpreter folders, and nothing under `.git`. Any other link ends the scan as `unsafe_link`. A file with a set-user-id or set-group-id bit ends it as
// `unsafe_mode`.
//
// What it does not do: read past `MAX_SCANNED_BYTES_PER_FILE` for shapes, look inside archives, decode text, or read `.git/objects` (compressed). Those are residual risks the report names; the exact-value check does
// not depend on them being absent (except inside archives and compressed objects).
//
// Findings carry the KIND and the PATH, never the matched text. Nothing here logs.
import { lstat, open, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_LINK_POLICY, inspectLink, type LinkPolicy } from "./links.js";

export const SECRET_FINDING_KINDS = ["forbidden_value", "credential_file", "private_key", "token", "url_password", "aws_secret", "git_config_credential"] as const;
export type SecretFindingKind = (typeof SECRET_FINDING_KINDS)[number];

export interface SecretFinding { kind: SecretFindingKind; /** A path inside the scanned tree, POSIX, cut to 200 characters. */ path: string }

export type SecretScanResult =
  | { ok: true; files: number; bytes: number }
  | { ok: false; reason: "found"; findings: SecretFinding[]; truncated: boolean }
  | { ok: false; reason: "unscannable"; detail: "too_many_files" | "too_many_bytes" | "deadline" | "special_file" | "unreadable" | "unsafe_link" | "unsafe_mode" };

export interface SecretScanOptions {
  /** Exact secret values to look for in every file (at least 8 characters each; shorter ones are ignored, since a short string matches by chance). */
  forbiddenValues?: readonly string[];
  maxFiles?: number;
  maxTotalBytes?: number;
  /** Epoch ms after which the scan stops with `deadline`. */
  deadlineAtMs?: number;
  now?: () => number;
  /** The most findings reported (the scan still stops at the first file that has one, per file). */
  maxFindings?: number;
  /** Which links are acceptable (links.ts). Default: no absolute link but a virtual environment's interpreter in `/usr/bin` or `/usr/local/bin`. */
  links?: LinkPolicy;
}

export const MAX_SCANNED_BYTES_PER_FILE = 4 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES = 1_500_000;
const DEFAULT_MAX_TOTAL_BYTES = 12 * 1024 * 1024 * 1024;
const MIN_FORBIDDEN_LENGTH = 8;

/** Folders whose contents are installed packages and caches, not the project's own files. */
export const DEPENDENCY_DIRECTORIES: ReadonlySet<string> = new Set(["node_modules", ".venv", "venv", "site-packages", ".tox", ".m2", ".gradle", ".yarn", ".pnpm-store", ".cargo", ".npm", ".nuget", ".bundle"]);

/**
 * The two example credentials AWS prints in its own documentation (an access key id and its secret), which are no one's secret. Matched EXACTLY: a token that merely contains the word is still a token. Built from
 * parts so the whole values are not in this source.
 */
const DOCUMENTED_EXAMPLES: ReadonlySet<string> = new Set([
  ["AKIAIOSFODNN7", "EXAMPLE"].join(""),
  ["wJalrXUtnFEMI/K7MDENG/bPxRfiCY", "EXAMPLEKEY"].join(""),
]);
/** Whether `value` is exactly one of the documented examples. */
const isDocumentedExample = (value: string): boolean => DOCUMENTED_EXAMPLES.has(value);

// Provider token formats. Each needs the provider's own prefix and a body of the provider's length, so ordinary text does not match.
const TOKEN_FORMATS: ReadonlyArray<RegExp> = [
  /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{50,255}\b/u,
  /\bxox[abprs]-[A-Za-z0-9-]{20,255}\b/u,
  /\b[sr]k_live_[A-Za-z0-9]{20,255}\b/u,
  /\bnpm_[A-Za-z0-9]{36}\b/u,
  /\bsk-ant-[A-Za-z0-9_-]{40,255}\b/u,
  /\bsk-proj-[A-Za-z0-9_-]{40,255}\b/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\bglpat-[A-Za-z0-9_-]{20,255}\b/u,
  /\bAIza[0-9A-Za-z_-]{35}\b/u,
  /\bya29\.[0-9A-Za-z_-]{60,}\b/u,
  // Rovara script tokens (UX5b).
  /\brvst_[0-9a-z]{20}_[0-9a-z]{20}_[A-Za-z0-9_-]{43}/u,
];

const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/u;
/** A URL whose user info has a password: `scheme://user:password@host`. A user name with no password (git@github.com) is not one. */
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s/@:'"<>]{1,128}:[^\s/@'"<>]{3,256}@[A-Za-z0-9.[\]-]+/iu;
const AWS_SECRET_ASSIGNMENT = /aws_secret_access_key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}\b/iu;

const CREDENTIAL_FILE_NAMES: ReadonlySet<string> = new Set([".git-credentials", ".netrc", "_netrc", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", ".pgpass", ".my.cnf"]);
const ENV_FILE = /^\.env(?:\.[A-Za-z0-9_-]+)?$/u;
const ENV_FILE_SAFE_SUFFIX = /\.(?:example|sample|template|dist|defaults?|schema|tpl)$/iu;
/** A token or password in a package manager's config file. */
const REGISTRY_AUTH_LINE = /(?:_authToken|_auth|_password|npmAuthToken|npmAuthIdent|password|token|Authorization)\s*[:=]\s*["']?[^\s"'$]{6,}/iu;
const REGISTRY_CONFIG_NAMES: ReadonlySet<string> = new Set([".npmrc", ".pypirc", ".yarnrc", ".yarnrc.yml", "pip.conf", "pip.ini", ".gem/credentials", "settings.xml"]);
// After a line start, blanks that are not line breaks: `^\s*` with the `m` flag rescanned a run of blank lines from every line of it (64 KiB of newlines took 5.7 s; this reads files up to 4 MiB).
// It finds the same files: a match that ran over blank lines matches from the last of them.
const GIT_CONFIG_CREDENTIAL = /^[^\S\n\r\u2028\u2029]*\[credential|extraheader|^[^\S\n\r\u2028\u2029]*helper\s*=|^[^\S\n\r\u2028\u2029]*askpass\s*=/imu;

const isDependencyPath = (parts: readonly string[]): boolean => parts.some((part) => DEPENDENCY_DIRECTORIES.has(part));

/** Whether a byte buffer looks like text: no NUL in its first 8 KiB. */
const looksBinary = (bytes: Buffer): boolean => bytes.subarray(0, 8192).includes(0);

function findInText(text: string, parts: readonly string[], dependency: boolean): SecretFindingKind | undefined {
  const name = parts.at(-1) ?? "";
  // A repository's own `.git/config` (the seed holds each repository in a folder of its own).
  if (name === "config" && parts.at(-2) === ".git" && GIT_CONFIG_CREDENTIAL.test(text)) return "git_config_credential";
  if (PRIVATE_KEY_BLOCK.test(text) && !dependency) return "private_key";
  for (const format of TOKEN_FORMATS) {
    const match = format.exec(text);
    if (match !== null && !isDocumentedExample(match[0])) return "token";
  }
  if (dependency) return undefined;
  if (URL_PASSWORD.test(text)) {
    const match = URL_PASSWORD.exec(text)!;
    // `user:${TOKEN}@host` and `user:$PASSWORD@host` are placeholders; `user:password@localhost` in an example is still refused (we cannot know it is one).
    if (!/:[$%{<]/u.test(match[0].slice(match[0].indexOf("://") + 3))) return "url_password";
  }
  const aws = AWS_SECRET_ASSIGNMENT.exec(text);
  if (aws !== null && !isDocumentedExample(aws[0].slice(-40))) return "aws_secret";
  if (REGISTRY_CONFIG_NAMES.has(name) && REGISTRY_AUTH_LINE.test(text)) return "credential_file";
  return undefined;
}

function fileNameFinding(parts: readonly string[], dependency: boolean): SecretFindingKind | undefined {
  if (dependency) return undefined;
  const name = parts.at(-1) ?? "";
  if (CREDENTIAL_FILE_NAMES.has(name)) return "credential_file";
  if (ENV_FILE.test(name) && !ENV_FILE_SAFE_SUFFIX.test(name)) return "credential_file";
  const parent = parts.at(-2) ?? "";
  if (parent === ".aws" && name === "credentials") return "credential_file";
  if (parent === ".ssh" && !name.endsWith(".pub") && name !== "known_hosts" && name !== "config") return "credential_file";
  return undefined;
}

/** Whether `.docker/config.json` has a login (an `auths` entry with credentials) rather than only settings. */
const DOCKER_AUTH = /"auths"\s*:\s*\{\s*"[^"]+"\s*:\s*\{[^}]*"(?:auth|identitytoken|registrytoken)"\s*:\s*"[^"]{6,}"/u;

/**
 * Whether any of `values` is in the file from byte `from` on, reading in chunks that overlap by the longest value minus one byte, so a value cut by a chunk edge is still seen. (The part before `from` was
 * searched by the caller; the overlap starts there too, so a value across `from` is found.)
 */
async function streamHasValue(file: string, from: number, values: readonly Buffer[]): Promise<boolean> {
  const longest = values.reduce((most, value) => Math.max(most, value.length), 0);
  const overlap = Math.max(0, longest - 1);
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(STREAM_CHUNK_BYTES + overlap);
    let position = Math.max(0, from - overlap);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) return false;
      const window = buffer.subarray(0, bytesRead);
      if (values.some((value) => window.includes(value))) return true;
      if (bytesRead < buffer.length) return false;
      position += bytesRead - overlap;
    }
  } finally { await handle.close(); }
}

/**
 * Scans `root` (a staged copy of the repositories). Never follows a symbolic link, never leaves `root`. A device file, or a tree over the limits, is `unscannable`: the caller treats that like a finding and
 * builds nothing (an unread file might hold anything).
 */
export async function scanTreeForSecrets(root: string, options: SecretScanOptions = {}): Promise<SecretScanResult> {
  const now = options.now ?? Date.now;
  const forbidden = (options.forbiddenValues ?? []).filter((value) => value.length >= MIN_FORBIDDEN_LENGTH).map((value) => Buffer.from(value, "utf8"));
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxFindings = options.maxFindings ?? 20;
  const findings: SecretFinding[] = [];
  let truncated = false;
  let files = 0;
  let bytes = 0;

  const report = (kind: SecretFindingKind, relative: string): void => {
    if (findings.length >= maxFindings) { truncated = true; return; }
    findings.push({ kind, path: relative.slice(0, 200) });
  };

  const stack: string[] = [""];
  while (stack.length > 0) {
    const relativeDir = stack.pop()!;
    let entries;
    try { entries = await readdir(path.join(root, relativeDir), { withFileTypes: true }); } catch { return { ok: false, reason: "unscannable", detail: "unreadable" }; }
    for (const entry of entries) {
      if (options.deadlineAtMs !== undefined && now() > options.deadlineAtMs) return { ok: false, reason: "unscannable", detail: "deadline" };
      const relative = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      const absolute = path.join(root, relative);
      let info;
      try { info = await lstat(absolute); } catch { return { ok: false, reason: "unscannable", detail: "unreadable" }; }
      if (info.isSymbolicLink()) {
        let target: string;
        try { target = await readlink(absolute); } catch { return { ok: false, reason: "unscannable", detail: "unreadable" }; }
        if (!(await inspectLink(root, relative, target, options.links ?? DEFAULT_LINK_POLICY)).ok) return { ok: false, reason: "unscannable", detail: "unsafe_link" };
        continue;
      }
      const parts = relative.split("/");
      if (info.isDirectory()) {
        // .git/objects is compressed: nothing in it can be read as text. Everything else of .git is scanned.
        if (parts.at(-2) === ".git" && (entry.name === "objects" || entry.name === "lfs")) continue;
        stack.push(relative);
        continue;
      }
      if (!info.isFile()) {
        // A socket or a pipe is dropped by the copy and never reaches here; a device file is not something an image should hold.
        return { ok: false, reason: "unscannable", detail: "special_file" };
      }
      // A set-user-id or set-group-id file is something a task could run with another identity: never in an image.
      if ((info.mode & 0o6000) !== 0) return { ok: false, reason: "unscannable", detail: "unsafe_mode" };
      files += 1;
      if (files > maxFiles) return { ok: false, reason: "unscannable", detail: "too_many_files" };
      const dependency = isDependencyPath(parts.slice(0, -1));
      const byName = fileNameFinding(parts, dependency);
      if (byName !== undefined) { report(byName, relative); continue; }

      const want = Math.min(info.size, MAX_SCANNED_BYTES_PER_FILE);
      // With exact values to find, the whole file is read (in chunks), so the whole file counts.
      bytes += forbidden.length > 0 ? info.size : want;
      if (bytes > maxBytes) return { ok: false, reason: "unscannable", detail: "too_many_bytes" };
      if (want === 0) continue;
      let content: Buffer;
      try {
        const handle = await open(absolute, "r");
        try {
          const buffer = Buffer.alloc(want);
          const { bytesRead } = await handle.read(buffer, 0, want, 0);
          content = buffer.subarray(0, bytesRead);
        } finally { await handle.close(); }
      } catch { return { ok: false, reason: "unscannable", detail: "unreadable" }; }

      const rest = info.size > want && forbidden.length > 0 && !forbidden.some((value) => content.includes(value)) ? await streamHasValue(absolute, want, forbidden).catch(() => "unreadable" as const) : false;
      if (rest === "unreadable") return { ok: false, reason: "unscannable", detail: "unreadable" };
      if (rest === true || forbidden.some((value) => content.includes(value))) { report("forbidden_value", relative); continue; }
      if (looksBinary(content)) continue;
      const text = content.toString("latin1");
      if (parts.at(-2) === ".docker" && parts.at(-1) === "config.json" && DOCKER_AUTH.test(text)) { report("credential_file", relative); continue; }
      const kind = findInText(text, parts, dependency);
      if (kind !== undefined) report(kind, relative);
    }
  }
  return findings.length > 0 ? { ok: false, reason: "found", findings, truncated } : { ok: true, files, bytes };
}
