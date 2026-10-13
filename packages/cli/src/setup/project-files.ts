// FR-040: what the GitHub App can see, and setup and test commands proposed from a repository's
// build files, for the engineer to confirm or edit. Nothing is guessed: a repository with no known
// build file gets no command, and the engineer types one or leaves it empty.
//
// Repository file contents are untrusted: they come from whatever the GitHub App can see, so they
// are only ever read (regex or JSON.parse, both guarded) to choose between a small set of commands
// this file writes itself. No file content ever becomes part of a command's executable or args, and
// no file content, private key or installation token is ever logged.
import { createHash } from "node:crypto";
import { agentXError, createCandidateManifest, type CandidateManifest, type CandidateRepository, type ProjectCommand } from "@agentx/contracts";
import type { InitSecrets } from "../init/context.js";
import { githubAppJwt, githubAppSecretName, parseAppSecret, type GitHubApi } from "../init/github-app.js";

export interface RepositoryInfo { fullName: string; name: string; defaultBranch: string; cloneUrl: string }
export interface GitHubRepositoryApi {
  /** Every repository the installation can see (GET /installation/repositories, all pages). */
  list(token: string): Promise<RepositoryInfo[]>;
  /** A file's text at the default branch, or undefined when it does not exist. */
  file(token: string, fullName: string, path: string): Promise<string | undefined>;
  snapshot(token: string, fullName: string, paths: readonly string[], ref: string): Promise<RepositorySnapshot>;
}
export interface RepositorySnapshot {
  candidate: CandidateManifest;
  commitSha: string;
  treeSha: string;
  treeComplete: true;
  treePaths: string[];
  sources: Array<{ path: string; sha256: string; bytes: Uint8Array; kind: "blob" }>;
}


const API = "https://api.github.com";
/** Seconds a setup command may run (the proposal's and a typed command's alike). */
export const SETUP_TIMEOUT = 900;
/** Seconds a test (readiness) command may run. */
export const TEST_TIMEOUT = 1800;
const NPM_PLACEHOLDER = /no test specified/;
/** A repository's file is untrusted content: never hold more of it than this in memory. Every
 * build file this module reads (package.json, pyproject.toml, requirements.txt, a Makefile) states
 * what it needs near the top, so a cap this size never changes what is proposed for a real project. */
const MAX_FILE_BYTES = 64 * 1024;
const MAX_SNAPSHOT_FILES = 512;
const MAX_SNAPSHOT_FILE_BYTES = 512 * 1024;
const MAX_SNAPSHOT_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_TREE_JSON_BYTES = 16 * 1024 * 1024;
const MAX_BLOB_JSON_BYTES = 768 * 1024;
const forbiddenSnapshotPart = /^(?:\.git|\.github|\.aws|\.ssh|\.env(?:\..*)?|secrets?|credentials?|.*(?:token|password|private[-_]?key).*)$/i;
function safeSnapshotPath(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && !path.startsWith("/") && !path.includes("\\")
    && !path.split("/").some((part) => part === "" || part === "." || part === ".." || forbiddenSnapshotPart.test(part));
}

export const BUILD_FILES: readonly string[] = [
  "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  "pyproject.toml", "uv.lock", "poetry.lock", "requirements.txt",
  "go.mod", "Cargo.toml", "Makefile",
];

/** Reads at most `maxBytes` of the response body. When the runtime gives a streaming body, reading
 * stops (and the connection is cancelled) as soon as the cap is reached, so an oversized file is
 * never pulled fully into memory just to be truncated afterward. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (reader === undefined) {
    const text = await response.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const value = result.value;
      chunks.push(value);
      total += value.byteLength;
      if (total >= maxBytes) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).subarray(0, maxBytes).toString("utf8");
}

async function readJsonBounded<T>(response: Response, maxBytes: number): Promise<T> {
  const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (reader === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub response body is unavailable for bounded source verification");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub immutable source metadata exceeded the response size limit");
      chunks.push(result.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")) as T;
}

/** A generous safety cap: 100 pages of 100 repositories each is 10,000 repositories, far more than
 * one GitHub App installation realistically has. If it is ever hit, `list` fails loudly rather than
 * silently returning a partial (and therefore misleading) list. */
const MAX_REPOSITORY_PAGES = 100;

const nextStepFor = (status: number, whatCannotBeSeen: string): string =>
  status === 403
    ? `check that the GitHub App is still installed and can see ${whatCannotBeSeen}`
    : "try again, and check GitHub's status if it keeps failing";

export function githubRepositoryApi(fetchImplementation: typeof fetch): GitHubRepositoryApi {
  const headers = (token: string, accept = "application/vnd.github+json") => ({
    accept, authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", "user-agent": "agentx-cli",
  });
  return {
    async snapshot(token, fullName, paths, ref) {
      if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_SNAPSHOT_FILES || new Set(paths).size !== paths.length || paths.some((path) => !safeSnapshotPath(path))) {
        throw agentXError("CONFIG_INVALID", "snapshot paths must be unique normalized paths within the bounded source allowlist");
      }
      const base = `${API}/repos/${fullName}`;
      const commitResponse = await fetchImplementation(`${base}/commits/${encodeURIComponent(ref)}`, { headers: headers(token) });
      if (!commitResponse.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub could not resolve repository ref in ${fullName} (HTTP ${commitResponse.status}); ${nextStepFor(commitResponse.status, fullName)}`);
      const commitBody = await readJsonBounded<{ sha?: unknown; commit?: { tree?: { sha?: unknown } } }>(commitResponse, 256 * 1024);
      const commitSha = commitBody.sha;
      const treeSha = commitBody.commit?.tree?.sha;
      if (typeof commitSha !== "string" || !/^[a-f0-9]{40}$/.test(commitSha) || typeof treeSha !== "string" || !/^[a-f0-9]{40}$/.test(treeSha)) {
        throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid immutable commit or tree identity");
      }
      const treeResponse = await fetchImplementation(`${base}/git/trees/${treeSha}?recursive=1`, { headers: headers(token) });
      if (!treeResponse.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub could not read the immutable source tree in ${fullName} (HTTP ${treeResponse.status}); ${nextStepFor(treeResponse.status, fullName)}`);
      const treeBody = await readJsonBounded<{ sha?: unknown; truncated?: unknown; tree?: Array<{ path?: unknown; mode?: unknown; type?: unknown; sha?: unknown; size?: unknown }> }>(treeResponse, MAX_TREE_JSON_BYTES);
      if (treeBody.sha !== treeSha || treeBody.truncated !== false || !Array.isArray(treeBody.tree) || treeBody.tree.length > 100_000) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned a mismatched, incomplete or oversized immutable source tree");
      const treePaths = new Set(treeBody.tree.map((entry) => entry.path).filter((path): path is string => typeof path === "string"));
      const sources: RepositorySnapshot["sources"] = [];
      let totalBytes = 0;
      for (const path of paths) {
        const entry = treeBody.tree.find((item) => item.path === path);
        if (entry === undefined || entry.type !== "blob" || entry.mode === "120000" || entry.mode === "160000" || typeof entry.sha !== "string" || !/^[a-f0-9]{40}$/.test(entry.sha)) {
          throw agentXError("CONFIG_INVALID", `snapshot path ${path} is missing or is not a regular Git blob`);
        }
        if (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_SNAPSHOT_FILE_BYTES) throw agentXError("RUNTIME_UNAVAILABLE", `snapshot file ${path} exceeds the source size limit`);
        const blobResponse = await fetchImplementation(`${base}/git/blobs/${entry.sha}`, { headers: headers(token) });
        if (!blobResponse.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub could not read immutable source blob for ${path} (HTTP ${blobResponse.status}); ${nextStepFor(blobResponse.status, fullName)}`);
        const blob = await readJsonBounded<{ sha?: unknown; encoding?: unknown; content?: unknown; size?: unknown }>(blobResponse, Math.min(MAX_BLOB_JSON_BYTES, Math.ceil(entry.size / 3) * 4 + 16_384));
        if (blob.sha !== entry.sha || blob.encoding !== "base64" || typeof blob.content !== "string" || blob.size !== entry.size || blob.content.length > Math.ceil(entry.size / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(blob.content)) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub returned incomplete or mismatched immutable source bytes for ${path}`);
        const bytes = Buffer.from(blob.content, "base64");
        if (bytes.byteLength !== entry.size) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub source byte count did not match the immutable tree for ${path}`);
        const gitObjectSha = createHash("sha1").update(Buffer.from(`blob ${bytes.byteLength}\0`)).update(bytes).digest("hex");
        if (gitObjectSha !== entry.sha) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub source bytes did not match the immutable Git blob identity for ${path}`);
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_SNAPSHOT_TOTAL_BYTES) throw agentXError("RUNTIME_UNAVAILABLE", "requested source snapshot exceeds the total byte limit");
        sources.push({ path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes, kind: "blob" });
      }
      const candidate = createCandidateManifest([{ repositoryId: fullName, commitSha, treeSha } satisfies CandidateRepository]);
      return { candidate, commitSha, treeSha, treeComplete: true as const, treePaths: [...treePaths], sources };
    },
    async list(token) {
      const all: RepositoryInfo[] = [];
      for (let page = 1; page <= MAX_REPOSITORY_PAGES; page += 1) {
        const response = await fetchImplementation(`${API}/installation/repositories?per_page=100&page=${page}`, { headers: headers(token) });
        if (!response.ok) {
          throw agentXError("RUNTIME_UNAVAILABLE", `GitHub repository list failed with HTTP ${response.status}; ${nextStepFor(response.status, "its repositories")}`);
        }
        const body = (await response.json()) as { repositories: Array<{ full_name: string; name: string; default_branch: string; clone_url: string }> };
        all.push(...body.repositories.map((repo) => ({ fullName: repo.full_name, name: repo.name, defaultBranch: repo.default_branch, cloneUrl: repo.clone_url })));
        if (body.repositories.length < 100) return all;
      }
      throw agentXError("RUNTIME_UNAVAILABLE", `GitHub reports more than ${MAX_REPOSITORY_PAGES * 100} repositories for this installation; stopped after page ${MAX_REPOSITORY_PAGES} rather than silently drop the rest. Install the GitHub App on fewer repositories, then run this again`);
    },
    async file(token, fullName, path) {
      const response = await fetchImplementation(`${API}/repos/${fullName}/contents/${encodeURIComponent(path)}`, { headers: headers(token, "application/vnd.github.raw+json") });
      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw agentXError("RUNTIME_UNAVAILABLE", `GitHub could not read ${path} in ${fullName} (HTTP ${response.status}); ${nextStepFor(response.status, fullName)}`);
      }
      return readCapped(response, MAX_FILE_BYTES);
    },
  };
}

export function agentxRepositoryName(githubName: string): string {
  const cleaned = githubName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  return /^[a-z]/.test(cleaned) ? cleaned : `repo-${cleaned}`.slice(0, 63);
}

export function parseCommandLine(line: string, cwd: string, timeoutSeconds: number): ProjectCommand {
  const words: string[] = [];
  let current = "";
  let quote: string | undefined;
  let started = false;
  for (const character of line.trim()) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined; else current += character;
    } else if (character === '"' || character === "'") {
      quote = character; started = true;
    } else if (/\s/.test(character)) {
      if (started) { words.push(current); current = ""; started = false; }
    } else {
      current += character; started = true;
    }
  }
  if (quote !== undefined) throw agentXError("CONFIG_INVALID", "the command has an unclosed quote");
  if (started) words.push(current);
  if (words.length === 0) throw agentXError("CONFIG_INVALID", "the command is empty");
  if (words.some((word) => ["&&", "||", "|", ";"].includes(word))) {
    throw agentXError("CONFIG_INVALID", "a command runs one program; put && , | and ; steps in a script or Makefile target and call that");
  }
  const [executable, ...args] = words as [string, ...string[]];
  return { cwd, executable, args, timeoutSeconds };
}

export function commandLine(command: ProjectCommand): string {
  return [command.executable, ...command.args].map((word) => (/[\s"']/.test(word) ? JSON.stringify(word) : word)).join(" ");
}

export interface ProposedCommands { setup: ProjectCommand[]; readiness: ProjectCommand[]; basis: string[] }

export function proposeCommands(files: Readonly<Record<string, string | undefined>>, cwd: string): ProposedCommands {
  const has = (name: string) => files[name] !== undefined;
  const setup: ProjectCommand[] = [];
  const readiness: ProjectCommand[] = [];
  const basis: string[] = [];
  const add = (target: ProjectCommand[], line: string, why: string) => {
    target.push(parseCommandLine(line, cwd, target === setup ? SETUP_TIMEOUT : TEST_TIMEOUT));
    basis.push(`${why}: ${line}`);
  };
  if (has("package.json")) {
    const tool = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
    const install = tool === "npm" ? (has("package-lock.json") ? "npm ci" : "npm install") : `${tool} install --frozen-lockfile`;
    const lock = tool === "pnpm" ? "pnpm-lock.yaml" : tool === "yarn" ? "yarn.lock" : has("package-lock.json") ? "package-lock.json" : undefined;
    add(setup, install, lock === undefined ? "package.json" : `package.json and ${lock}`);
    let test: unknown;
    try { test = (JSON.parse(files["package.json"]!) as { scripts?: { test?: unknown } }).scripts?.test; } catch { test = undefined; }
    if (typeof test === "string" && !NPM_PLACEHOLDER.test(test)) add(readiness, `${tool} test`, "package.json's test script");
  } else if (has("pyproject.toml")) {
    const pyproject = files["pyproject.toml"]!;
    const pytest = /pytest/.test(pyproject);
    if (has("uv.lock")) { add(setup, "uv sync", "pyproject.toml and uv.lock"); if (pytest) add(readiness, "uv run pytest", "pytest in pyproject.toml"); }
    else if (has("poetry.lock")) { add(setup, "poetry install", "pyproject.toml and poetry.lock"); if (pytest) add(readiness, "poetry run pytest", "pytest in pyproject.toml"); }
    else { add(setup, "python3 -m pip install -e .", "pyproject.toml"); if (pytest) add(readiness, "python3 -m pytest", "pytest in pyproject.toml"); }
  } else if (has("requirements.txt")) {
    add(setup, "python3 -m pip install -r requirements.txt", "requirements.txt");
    if (/^pytest\b/m.test(files["requirements.txt"]!)) add(readiness, "python3 -m pytest", "pytest in requirements.txt");
  } else if (has("go.mod")) {
    add(setup, "go mod download", "go.mod"); add(readiness, "go test ./...", "go.mod");
  } else if (has("Cargo.toml")) {
    add(setup, "cargo fetch", "Cargo.toml"); add(readiness, "cargo test", "Cargo.toml");
  }
  if (readiness.length === 0 && has("Makefile") && /^test:/m.test(files.Makefile!)) add(readiness, "make test", "the Makefile's test target");
  return { setup, readiness, basis };
}

/** The GitHub App's installation token for `env`'s recorded app (FR-040): reads the app's id and
 * private key from the secret the GitHub App step stores (parsed the same way that step reads it
 * back, so a malformed secret is refused with the same message everywhere), then mints a JWT and
 * exchanges it. Never logs the private key or the returned token. */
export async function installationToken(input: {
  env: string; secrets: Pick<InitSecrets, "get">; github: Pick<GitHubApi, "listInstallations" | "installationToken">;
  installationId?: string; nowSeconds: number;
}): Promise<string> {
  const name = githubAppSecretName(input.env);
  const raw = await input.secrets.get(name);
  if (raw === undefined) {
    throw agentXError("CONFIG_INVALID", `secret ${name} does not exist; run agentx init again so the GitHub App step stores it`);
  }
  const app = parseAppSecret(raw, name);
  const jwt = githubAppJwt({ appId: app.appId, privateKey: app.privateKey, nowSeconds: input.nowSeconds });
  let installationId = input.installationId;
  if (installationId === undefined) {
    const installations = await input.github.listInstallations(jwt);
    if (installations.length !== 1) {
      throw agentXError("CONFIG_INVALID", installations.length === 0
        ? "the GitHub App is not installed anywhere; install it on your organization and choose repositories, then run this again"
        : `the GitHub App is installed on ${installations.length} accounts (${installations.map((entry) => entry.account.login).join(", ")}); AgentX uses one, so uninstall the others`);
    }
    installationId = String(installations[0]!.id);
  }
  return (await input.github.installationToken(jwt, installationId)).token;
}
