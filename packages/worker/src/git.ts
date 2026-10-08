import { execFile as execFileCallback, spawn } from "node:child_process";
import { lstat, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { agentXError } from "@agentx/contracts";

const execFile = promisify(execFileCallback);

/**
 * AgentX's own Git calls on a workspace repository (candidate capture, turn diffs and fingerprints,
 * original-code restore, review reads, publication, pull request maintenance, workspace close, and
 * later the base-to-candidate review diff and publish tree checks) MUST run under
 * {@link gitHardenedEnvironment}. The coding agent controls that repository's `.git/config`,
 * `.gitattributes` and hooks, so under an ordinary environment a configured filter, merge or diff
 * driver, fsmonitor, hook, credential helper, signing program, pager or transport would run
 * commands on the worker host, see a push token, or change what AgentX reads as the agent's work.
 *
 * Project-owned commands (setup and readiness) are the project's own code and get
 * {@link projectCommandEnvironment} instead, which keeps the worker's Git settings as they were.
 */

/** Settings that no repository or user config may override for AgentX's own git calls. */
export const HARDENED_GIT_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["core.fsmonitor", "false"], ["core.hooksPath", "/dev/null"], ["core.untrackedCache", "false"],
  ["credential.helper", ""], ["core.askPass", ""], ["diff.external", ""], ["core.pager", "cat"],
  ["protocol.allow", "never"], ["protocol.https.allow", "always"], ["core.sshCommand", "false"],
  // Signing and signature checks would run gpg.program (a revert or merge honours commit.gpgSign).
  ["commit.gpgSign", "false"], ["tag.gpgSign", "false"], ["log.showSignature", "false"], ["merge.verifySignatures", "false"],
  ["gpg.program", "/dev/null"], ["gpg.ssh.program", "/dev/null"], ["gpg.x509.program", "/dev/null"],
  // HTTPS is verified and direct. http.proxy="" deliberately also overrides the worker's own
  // HTTPS_PROXY/https_proxy: workers reach GitHub directly (egress via NAT), and no proxy may see the
  // push token. A repository's http.*, url.* and remote.* keys are refused for network calls.
  ["http.sslVerify", "true"], ["http.proxy", ""],
  // Never recurse into a nested repository, whose own config AgentX has not neutralised.
  ["submodule.recurse", "false"], ["fetch.recurseSubmodules", "false"], ["push.recurseSubmodules", "no"],
  ["diff.ignoreSubmodules", "dirty"], ["status.submoduleSummary", "false"],
  // Commands Git would otherwise start on its own.
  ["core.alternateRefsCommand", "true"], ["gc.auto", "0"], ["maintenance.auto", "false"],
  ["core.editor", "false"], ["sequence.editor", "false"],
];

/** Variables from the worker's own environment that would redirect or extend what Git runs. */
const UNSAFE_GIT_VARIABLES = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG_PARAMETERS", "GIT_EXTERNAL_DIFF", "GIT_SSH",
  "GIT_SSH_COMMAND", "GIT_ASKPASS", "GIT_ALLOW_PROTOCOL", "GIT_PROXY_COMMAND", "GIT_CONFIG", "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_TEMPLATE_DIR",
] as const;

/** Git LFS's standard driver: the only filter a repository keeps under AgentX's own Git calls. */
const LFS_FILTER: ReadonlyArray<readonly [string, string]> = [
  ["clean", "git-lfs clean -- %f"], ["smudge", "git-lfs smudge -- %f"], ["process", "git-lfs filter-process"], ["required", "true"],
];
/**
 * Every other filter is off, so a working tree file is staged as its raw bytes: an encryption filter
 * such as git-crypt stages plaintext. Operators: only git-lfs filters are honoured.
 */
const DISABLED_FILTER: ReadonlyArray<readonly [string, string]> = [
  ["clean", ""], ["smudge", ""], ["process", ""], ["required", "false"],
];
/** Git's own three-way text merge, in place of a repository's merge driver command. */
const TEXT_MERGE_DRIVER = "git merge-file --marker-size=%L %A %O %B";

let testFileTransport = false;

/**
 * Test seam: lets AgentX's hardened Git use local `file://` remotes, which integration fixtures
 * use. Everything else, including `protocol.allow=never`, stays in force. Returns the undo.
 */
export function allowGitFileTransportForTests(): () => void {
  testFileTransport = true;
  return () => {
    testFileTransport = false;
  };
}

/**
 * The static part of the hardened environment: the worker's variables without Git redirections,
 * `extra`, system and global config ignored, prompts off, and Git's safe directory,
 * {@link HARDENED_GIT_CONFIG} and `config` forced over any repository config. Not exported: it
 * leaves the repository's own drivers in force, so callers use {@link gitHardenedEnvironment}.
 */
function staticGitEnvironment(
  directory: string,
  extra: Readonly<Record<string, string>> = {},
  config: ReadonlyArray<readonly [string, string]> = [],
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const name of UNSAFE_GIT_VARIABLES) delete environment[name];
  Object.assign(environment, extra, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  });
  const settings: ReadonlyArray<readonly [string, string]> = [
    ["safe.directory", directory],
    ...HARDENED_GIT_CONFIG,
    ...config,
    ...(testFileTransport ? [["protocol.file.allow", "always"] as const] : []),
  ];
  environment.GIT_CONFIG_COUNT = String(settings.length);
  settings.forEach(([key, value], index) => {
    environment[`GIT_CONFIG_KEY_${index}`] = key;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return environment;
}

/**
 * The environment for a project-owned command (setup or readiness): the worker's environment with
 * the command's own `env` over it (#54) and Git's safe directory set. A project command is the
 * project's code, so it keeps the worker's Git settings (SSH, credential helpers, global config).
 * Never use it for AgentX's own Git calls.
 */
export function projectCommandEnvironment(directory: string, extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: directory,
  };
}

export interface GitHardenedEnvironmentOptions {
  /**
   * The call reaches a remote (fetch, push, clone) and may carry the push token. The repository's
   * transport settings cannot be overridden from outside: a longer `insteadOf` or a URL-specific
   * `http.<url>.*` key wins, and Git treats any URL as a possible remote name, so
   * `remote."<registered url>".pushurl` (or `.url`, `.proxy`) redirects a push or fetch to that URL.
   * A promisor remote (partial clone) would fetch lazily with the token too. So a repository that
   * sets any `url.*`, `http.*` or `remote.*` key (other than origin's `url` and `fetch`), or
   * `extensions.partialClone`, is refused.
   */
  network?: boolean;
}

/** The only remote keys a clone AgentX made has, and that network calls accept. */
const ALLOWED_REMOTE_KEYS = new Set(["remote.origin.url", "remote.origin.fetch"]);

function isRefusedForNetwork(key: string): boolean {
  if (/^(?:url|http)\./u.test(key) || key === "extensions.partialclone") return true;
  return key.startsWith("remote.") && !ALLOWED_REMOTE_KEYS.has(key);
}

function networkRefusal(keys: readonly string[]): Error {
  const unique = [...new Set(keys)].sort();
  const shown = unique.slice(0, 10).join(", ");
  const more = unique.length > 10 ? ` and ${unique.length - 10} more` : "";
  return agentXError(
    "CONFIG_INVALID",
    `the repository's Git config sets ${shown}${more}, which AgentX does not allow when it fetches or pushes. ` +
      "Unset them (git config --unset-all <key>) and try again.",
  );
}

/**
 * The hardened Git environment for a workspace repository: the static hardening plus every filter,
 * merge and diff driver and per-protocol setting the repository's config names forced off (`lfs`
 * pinned to the standard Git LFS commands; a merge driver replaced by Git's text merge), and the
 * work tree pinned to `directory` so a repository `core.worktree` cannot point Git at host files.
 * See the note at the top of this module: all worker Git calls touching the candidate repo use it.
 */
export async function gitHardenedEnvironment(
  directory: string,
  extra: Readonly<Record<string, string>> = {},
  options: GitHardenedEnvironmentOptions = {},
): Promise<NodeJS.ProcessEnv> {
  const absolute = resolve(directory);
  // A directory that does not exist yet (a clone's destination) has no repository config to read.
  if (!(await stat(absolute).then(() => true, (error: unknown) => (error as { code?: unknown }).code !== "ENOENT"))) {
    return staticGitEnvironment(absolute, extra);
  }
  let keys = "";
  try {
    ({ stdout: keys } = await execFile(
      "git",
      [
        "-C", absolute, "config", "--includes", "--show-scope", "--name-only", "--get-regexp",
        "^(filter|merge|diff|protocol|url|http|remote)\\.|^extensions\\.partialclone$",
      ],
      { env: staticGitEnvironment(absolute), encoding: "utf8", maxBuffer: 1024 * 1024 },
    ));
  } catch (error) {
    // Exit status 1 means no key matched: the repository configures none of these.
    if ((error as { code?: unknown }).code !== 1) throw error;
  }
  const drivers = { filter: new Set<string>(), merge: new Set<string>(), diff: new Set<string>(), protocol: new Set<string>() };
  const transportKeys: string[] = [];
  for (const line of keys.split("\n")) {
    // "<scope>\t<key>". The command scope is this module's own settings, from the environment.
    const [scope, key = ""] = line.trim().split("\t");
    if (scope === "command" || key === "") continue;
    if (isRefusedForNetwork(key)) {
      transportKeys.push(key);
      continue;
    }
    const match = /^(filter|merge|diff|protocol)\.(.+)\.[^.]+$/su.exec(key);
    if (match?.[1] !== undefined && match[2] !== undefined) drivers[match[1] as keyof typeof drivers].add(match[2]);
  }
  if (options.network === true && transportKeys.length > 0) throw networkRefusal(transportKeys);
  const overrides: Array<readonly [string, string]> = [];
  for (const name of [...drivers.filter].sort()) {
    for (const [field, value] of name === "lfs" ? LFS_FILTER : DISABLED_FILTER) overrides.push([`filter.${name}.${field}`, value]);
  }
  for (const name of [...drivers.merge].sort()) overrides.push([`merge.${name}.driver`, TEXT_MERGE_DRIVER]);
  for (const name of [...drivers.diff].sort()) overrides.push([`diff.${name}.textconv`, ""], [`diff.${name}.command`, ""]);
  for (const name of [...drivers.protocol].sort()) overrides.push([`protocol.${name}.allow`, name === "https" ? "always" : "never"]);
  const environment = staticGitEnvironment(absolute, extra, overrides);
  // Git reads core.worktree only from the repository's own config; GIT_WORK_TREE is what overrides it.
  if (await exists(join(absolute, ".git"))) environment.GIT_WORK_TREE = absolute;
  return environment;
}

/**
 * Refuses (CONFIG_INVALID) an index that records a nested repository (a gitlink) whose directory
 * holds a `.git`, such as a submodule a project's setup initialised. `git add`, `diff-files` and
 * `diff-index` check such a nested repository by running Git inside it under its own config, whose
 * filters this module has not neutralised. Run it, with the same environment (and index), before
 * `git add`.
 */
export async function assertNoEmbeddedRepositories(directory: string, env: NodeJS.ProcessEnv): Promise<void> {
  const gitlinks = await new Promise<string[]>((resolvePaths, reject) => {
    const child = spawn("git", ["-C", directory, "ls-files", "--stage", "-z"], { env, stdio: ["ignore", "pipe", "ignore"] });
    const found: string[] = [];
    let rest = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const records = `${rest}${chunk}`.split("\0");
      rest = records.pop() ?? "";
      for (const record of records) if (record.startsWith("160000 ")) found.push(record.slice(record.indexOf("\t") + 1));
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePaths(found);
      else reject(new Error("Git could not list the repository's index"));
    });
  });
  for (const path of gitlinks) {
    if (await exists(join(directory, path, ".git"))) {
      throw agentXError(
        "CONFIG_INVALID",
        `the repository has a nested Git repository (a submodule) checked out at ${path}. AgentX tasks do not yet ` +
          "support projects whose setup initialises Git submodules, or nested repositories the agent creates.",
      );
    }
  }
}

/**
 * Refuses (CONFIG_INVALID) a repository with any tracked or new file that `.gitattributes` gives
 * `filter=lfs`. AgentX's Git runs no hooks, so Git LFS's pre-push hook would never upload the
 * objects and a pull request would hold only pointers. Run it before staging for a push.
 */
export async function assertNoLfsFiles(directory: string, env: NodeJS.ProcessEnv): Promise<void> {
  let found: boolean;
  try {
    const { stdout } = await execFile(
      "git",
      ["-C", directory, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ":(attr:filter=lfs)"],
      { env, encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    found = stdout !== "";
  } catch (error) {
    // More output than fits means many such files: refused all the same.
    if ((error as { code?: unknown }).code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw error;
    found = true;
  }
  if (found) {
    throw agentXError(
      "CONFIG_INVALID",
      "Git LFS repositories are not supported yet: this repository stores files with Git LFS (filter=lfs in .gitattributes).",
    );
  }
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

/** The identity AgentX commits as: its own publication commits and the agent's shell (#208). */
export const AGENTX_GIT_NAME = "AgentX";
export const AGENTX_GIT_EMAIL = "agentx@noreply.local";

/**
 * Git's author and committer variables set to AgentX's identity. The agent's shell has them, so a
 * commit there never fails for a missing identity and the agent never writes one into a
 * repository's config (#208).
 */
export const AGENTX_GIT_IDENTITY_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({
  GIT_AUTHOR_NAME: AGENTX_GIT_NAME,
  GIT_AUTHOR_EMAIL: AGENTX_GIT_EMAIL,
  GIT_COMMITTER_NAME: AGENTX_GIT_NAME,
  GIT_COMMITTER_EMAIL: AGENTX_GIT_EMAIL,
});
