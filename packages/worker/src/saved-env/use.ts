// Setup and test health SH23 (design setup-test-health.md, section 5.3): a task starts from the project's saved environment instead of a clone from nothing.
//
// `savedEnvMaterializer` wraps the preparation's repository materializer. For each repository it tries the saved image first and, if ANYTHING about the image is not as expected, removes what it made and clones
// fresh, exactly as before. A task is never blocked by a bad image. The failed step is reported (`onFallback`), so the registry can mark the image stale and queue a rebuild, and the evidence can say "fresh
// setup (saved environment failed at <step>)".
//
// What it does, in order, and what it refuses:
//   - `revision`: the image's revision, the broker's expected revision and the revision the TASK is pinned to must be one number (an image of another revision is not used);
//   - `pull`: by DIGEST only, `registry/repository@sha256:...`, never a tag, with a login for that one repository written to a throwaway Docker config (the broker minted it for this preparation);
//   - `inspect`: the pulled image's `RepoDigests` must name exactly that reference, and its labels must carry the expected environment key and revision;
//   - `extract`: `docker create` (never `run`: nothing in the image is ever executed) and `docker cp` of `/rovara/seed` and `/rovara/manifest.json` into a private folder;
//   - `manifest`: the manifest inside the image must say the same key and revision, and name a commit for every repository of the project;
//   - `layout`: the seed holds a folder for the repository and nothing is missing; `links`: no device file, and no symbolic link that is absolute or leaves the seed (links are COPIED as links and never
//     followed, here or in the copy below);
//   - `git`: the repository's `.git` holds none of the entries that redirect history (alternates, grafts, replace refs, modules, worktrees); it has no hooks; its config is REPLACED by a generated one that holds the
//     origin URL (from the project, credential-free) and turns hooks off (`core.hooksPath=/dev/null`): Git hooks are off at use;
//   - `copy`: the repository's folder is copied into the workspace without following links;
//   - `fetch`: the default branch is fetched (with the clone credential of the preparation), so `refs/remotes/origin/<branch>` is the branch's current head; the preparation then checks that commit out over the
//     seed as it does after a clone, and the project's own setup commands run over the warm dependency folders (the design's "update commands": there is no separate field yet, the approved setup commands are
//     the update).
// The image is removed from the machine afterwards.
import { randomBytes } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SAVED_ENV_IMAGE_MANIFEST_PATH,
  SAVED_ENV_IMAGE_SEED_PATH,
  SAVED_ENV_LABEL_KEY,
  SAVED_ENV_LABEL_REVISION,
  PrepareSavedEnvSchema,
  SavedEnvImageManifestSchema,
  SavedEnvRegistryAuthSchema,
  type PrepareSavedEnv,
  type SavedEnvImageManifest,
  type SavedEnvRegistryAuth,
  type SavedEnvUseStep,
  type StoredProjectDefinition,
} from "@agentx/contracts";
import { assertCredentialFreeRemote, runGitWithCredential, type GitCredential } from "../git-auth.js";
import { createDockerCli, type DockerCli } from "../swebench/containers.js";
import { DEFAULT_LINK_POLICY, inspectLink, type LinkPolicy } from "./links.js";
import { countNonStandardFlags, minimalGitConfig, unsafeGitEntries } from "./tree-check.js";
import { runIsolatedGit } from "../isolated-repository.js";

type Repository = StoredProjectDefinition["repositories"][number];
type Materializer = (repository: Repository, destination: string, credential: GitCredential) => Promise<void>;

const DOCKER_QUICK_MS = 2 * 60_000;
/** A login with less than this left is not used: the pull could outlive it. */
const LOGIN_MIN_REMAINING_MS = 60_000;
const PULL_TIMEOUT_MS = 30 * 60_000;
const COPY_TIMEOUT_MS = 30 * 60_000;
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u;
/** `docker create` needs a command for an image that has none; it is never run. */
const NEVER_RUN = "/rovara/never-run";

export interface SavedEnvUseOptions {
  /** The prepare invocation's reference (no credential). */
  ref: PrepareSavedEnv;
  /** Gets the pull login from the broker, right before the pull. Never stored; the login is written only to the throwaway Docker config of the pull and removed with it. */
  login: () => Promise<SavedEnvRegistryAuth>;
  /** Now, in milliseconds. Default: the clock. */
  now?: () => number;
  docker: DockerCli;
  /** Called once with the step an attempt failed at (the registry marks the image stale; the evidence says so). Never called when the image was used. */
  onFallback?: (step: SavedEnvUseStep) => void;
  onDiagnostic?: (message: string) => void;
  /** A private folder for the pull login and the extracted seed. Default: a new folder under the machine's temp folder. */
  temporaryFolder?: () => Promise<{ path: string; remove(): Promise<void> }>;
  /** Fetches the default branch into `refs/remotes/origin/<branch>` of the repository at `directory`. Default: `git fetch` with the clone credential, through the hardened runner. */
  fetch?: (input: { directory: string; branch: string; credential: GitCredential }) => Promise<void>;
  random?: () => string;
  /** The canonical path of the workspace this seed is placed in. The image says where it was built; a different path is reported (setup repairs absolute paths in a virtual environment). */
  workspaceRoot?: string;
  /** Which links the seed may hold (links.ts); the same policy the build used. Default: virtual environment interpreters in `/usr/bin` and `/usr/local/bin`. */
  links?: LinkPolicy;
}

class Fallback extends Error {
  constructor(readonly step: SavedEnvUseStep) { super(step); }
}

interface Extracted { seed: string; manifest: SavedEnvImageManifest; remove(): Promise<void> }

const defaultFolder = async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "rovara-saved-env-use-"));
  return { path: folder, remove: () => rm(folder, { recursive: true, force: true }) };
};

const defaultFetch: NonNullable<SavedEnvUseOptions["fetch"]> = async ({ directory, branch, credential }) => {
  await runGitWithCredential({ directory, args: ["fetch", "--no-tags", "--", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], credential, timeout: 300_000, maxBuffer: 1_048_576 });
};

/**
 * Walks the extracted seed: only files, folders and links that `links.ts` accepts, checked on the real tree; no device file or socket; no set-user-id or set-group-id file; no link at all under a `.git`.
 * The folders are never entered through a link.
 */
export async function checkSeedTree(root: string, links: LinkPolicy = DEFAULT_LINK_POLICY): Promise<"ok" | "special_file" | "unsafe_link" | "unsafe_mode"> {
  const stack = [""];
  while (stack.length > 0) {
    const relativeDirectory = stack.pop()!;
    for (const entry of await readdir(path.join(root, relativeDirectory), { withFileTypes: true })) {
      const relative = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      const info = await lstat(path.join(root, relative));
      if (info.isSymbolicLink()) { if (!(await inspectLink(root, relative, await readlink(path.join(root, relative)), links)).ok) return "unsafe_link"; continue; }
      if (info.isDirectory()) { stack.push(relative); continue; }
      if (!info.isFile()) return "special_file";
      if ((info.mode & 0o6000) !== 0) return "unsafe_mode";
    }
  }
  return "ok";
}

/**
 * Pulls and extracts the image once. Throws `Fallback` with the failing step. Everything it creates on the machine (login, container, image, extracted folder) is removed by the caller through the returned
 * `remove`, or here on failure.
 */
async function extractImage(options: SavedEnvUseOptions, repositories: readonly Repository[]): Promise<Extracted> {
  const parsed = PrepareSavedEnvSchema.safeParse(options.ref);
  if (!parsed.success) throw new Fallback("input");
  const use = parsed.data;
  if (use.testEnvRevision !== use.taskTestEnvRevision) throw new Fallback("revision");
  // the login is fetched as late as possible and checked before anything is pulled with it
  let auth: SavedEnvRegistryAuth;
  try { auth = SavedEnvRegistryAuthSchema.parse(await options.login()); } catch { throw new Fallback("login"); }
  if (auth.repository !== use.repository) throw new Fallback("login");
  if (Date.parse(auth.expiresAt) - (options.now ?? Date.now)() < LOGIN_MIN_REMAINING_MS) throw new Fallback("expired");
  const reference = `${auth.registry}/${use.repository}@${use.digest}`;
  const folder = await (options.temporaryFolder ?? defaultFolder)();
  const container = `rovara-saved-env-${(options.random ?? (() => randomBytes(8).toString("hex")))().replace(/[^a-f0-9]/gu, "").slice(0, 16)}`;
  const docker = options.docker;
  const cleanup = async (): Promise<void> => {
    await docker.run(["rm", "--force", container], { timeoutMs: DOCKER_QUICK_MS }).catch(() => undefined);
    await docker.run(["rmi", "--force", reference], { timeoutMs: DOCKER_QUICK_MS }).catch(() => undefined);
    await folder.remove().catch(() => undefined);
  };
  try {
    // pull, by digest, with a login that exists only for this call
    const config = path.join(folder.path, "docker-config");
    await mkdir(config, { recursive: true, mode: 0o700 });
    await writeFile(path.join(config, "config.json"), JSON.stringify({ auths: { [auth.registry]: { auth: Buffer.from(`${auth.username}:${auth.password}`).toString("base64") } } }), { mode: 0o600 });
    const pulled = await docker.run(["--config", config, "pull", reference], { timeoutMs: PULL_TIMEOUT_MS });
    await rm(config, { recursive: true, force: true });
    if (pulled.exitCode !== 0) throw new Fallback("pull");

    // the image says what the broker expects
    const inspected = await docker.run(["image", "inspect", "--format", "{{json .RepoDigests}} {{json .Config.Labels}}", reference], { timeoutMs: DOCKER_QUICK_MS });
    if (inspected.exitCode !== 0) throw new Fallback("inspect");
    const split = inspected.stdout.trim().indexOf("] ");
    let digests: unknown;
    let labels: unknown;
    try { digests = JSON.parse(inspected.stdout.trim().slice(0, split + 1)); labels = JSON.parse(inspected.stdout.trim().slice(split + 2)); } catch { throw new Fallback("inspect"); }
    if (!Array.isArray(digests) || !digests.includes(reference)) throw new Fallback("inspect");
    const label = (name: string): unknown => (typeof labels === "object" && labels !== null ? (labels as Record<string, unknown>)[name] : undefined);
    if (label(SAVED_ENV_LABEL_KEY) !== use.environmentKey || label(SAVED_ENV_LABEL_REVISION) !== String(use.testEnvRevision)) throw new Fallback("inspect");

    // extract: create (never run) and copy out; docker cp keeps links as links
    const created = await docker.run(["create", "--name", container, reference, NEVER_RUN], { timeoutMs: DOCKER_QUICK_MS });
    if (created.exitCode !== 0) throw new Fallback("extract");
    const seed = path.join(folder.path, "seed");
    const manifestFile = path.join(folder.path, "manifest.json");
    await mkdir(seed, { recursive: true });
    const copiedSeed = await docker.run(["cp", `${container}:${SAVED_ENV_IMAGE_SEED_PATH}/.`, seed], { timeoutMs: COPY_TIMEOUT_MS });
    const copiedManifest = await docker.run(["cp", `${container}:${SAVED_ENV_IMAGE_MANIFEST_PATH}`, manifestFile], { timeoutMs: DOCKER_QUICK_MS });
    if (copiedSeed.exitCode !== 0 || copiedManifest.exitCode !== 0) throw new Fallback("extract");

    // the manifest inside the image
    let manifest: SavedEnvImageManifest;
    try { manifest = SavedEnvImageManifestSchema.parse(JSON.parse(await readFile(manifestFile, "utf8"))); } catch { throw new Fallback("manifest"); }
    if (manifest.environmentKey !== use.environmentKey || manifest.testEnvRevision !== use.testEnvRevision || manifest.testEnvRevision !== use.taskTestEnvRevision) throw new Fallback("manifest");
    for (const repository of repositories) if (!manifest.commits.some((commit) => commit.repositoryId === repository.name)) throw new Fallback("manifest");
    if (options.workspaceRoot !== undefined && manifest.workspaceRoot !== undefined && manifest.workspaceRoot !== options.workspaceRoot) {
      options.onDiagnostic?.("the saved environment was built at another workspace path; the project's setup repairs paths written into it");
    }

    // layout and links
    for (const repository of repositories) {
      try { if (!(await lstat(path.join(seed, repository.path))).isDirectory()) throw new Fallback("layout"); } catch (error) { throw error instanceof Fallback ? error : new Fallback("layout"); }
    }
    const checked = await checkSeedTree(seed, options.links ?? DEFAULT_LINK_POLICY).catch(() => "special_file" as const);
    if (checked !== "ok") throw new Fallback("links");
    return { seed, manifest, remove: cleanup };
  } catch (error) {
    await cleanup();
    throw error instanceof Fallback ? error : new Fallback("extract");
  }
}

/**
 * The preparation's saved environment options from the prepare invocation's `savedEnv` (SH25): the machine's docker, and a fallback that is written to the worker log as a JSON line with the digest and the step
 * (the broker marks the image stale from the operation's result; no credential is in the line).
 */
export function savedEnvOptionsOf(payload: PrepareSavedEnv, login: SavedEnvUseOptions["login"], docker: DockerCli = createDockerCli(), report?: (step: SavedEnvUseStep) => Promise<void>): SavedEnvUseOptions {
  return {
    ref: payload, login, docker,
    onFallback: (step) => {
      console.log(JSON.stringify({ component: "worker", event: "saved-env.fallback", digest: payload.digest, step }));
      // The broker marks the image stale from this report (it knows the digest); a report that cannot be sent changes nothing here.
      void report?.(step);
    },
  };
}

/** Replaces `file` with a new file holding `text`: the old one (or a link in its place) is removed, then the new one is created exclusively, so nothing is ever written THROUGH a link. */
export async function replaceFileExclusively(file: string, text: string): Promise<void> {
  await rm(file, { force: true });
  await writeFile(file, text, { mode: 0o644, flag: "wx" });
}

/** The config of a seeded repository: only the origin URL (from the PROJECT, credential-free), hooks off. */
export function seededGitConfig(originUrl: string): string {
  return minimalGitConfig(originUrl, ["hooksPath = /dev/null", "fsmonitor = false"]);
}

/**
 * The preparation's materializer for a project with a saved environment. `fallback` is the ordinary fresh clone. A repository for which anything fails is cloned fresh (after what the attempt made is removed),
 * and the first failing step is reported once.
 */
export function savedEnvMaterializer(options: SavedEnvUseOptions, repositories: readonly Repository[], fallback: Materializer): Materializer & { dispose(): Promise<void>; used(): boolean } {
  let extracted: Promise<Extracted> | undefined;
  let reported = false;
  let seeded = 0;
  const diagnostic = options.onDiagnostic ?? (() => undefined);
  const report = (step: SavedEnvUseStep): void => {
    if (reported) return;
    reported = true;
    diagnostic(`fresh setup (saved environment failed at ${step})`);
    options.onFallback?.(step);
  };
  const fetch = options.fetch ?? defaultFetch;
  const remaining = new Set(repositories.map((repository) => repository.name));
  /** Removes the pulled image, the container and the extracted folder. Safe to call twice; the preparation calls it when it ends, whether or not every repository came through the materializer. */
  const release = async (): Promise<void> => {
    const pending = extracted;
    extracted = undefined;
    if (pending !== undefined) await (await pending.catch(() => undefined))?.remove();
  };

  const materialize: Materializer = async (repository, destination, credential) => {
    // Only the project's repositories are in the image (the meta repository, for one, is not): the rest clone as before, and say nothing.
    if (!remaining.has(repository.name)) { await fallback(repository, destination, credential); return; }
    try {
      extracted ??= extractImage(options, repositories);
      const image = await extracted;
      try {
        await useRepository({ image, repository, destination, credential, fetch });
        seeded += 1;
      } catch (error) {
        await rm(destination, { recursive: true, force: true });
        throw error;
      }
    } catch (error) {
      report(error instanceof Fallback ? error.step : "copy");
      await rm(destination, { recursive: true, force: true });
      await fallback(repository, destination, credential);
    } finally {
      remaining.delete(repository.name);
      if (remaining.size === 0) await release();
    }
  };
  return Object.assign(materialize, { dispose: release, used: () => seeded > 0 });
}

async function useRepository(input: { image: Extracted; repository: Repository; destination: string; credential: GitCredential; fetch: NonNullable<SavedEnvUseOptions["fetch"]> }): Promise<void> {
  const { image, repository, destination } = input;
  if (!BRANCH_NAME.test(repository.defaultBranch)) throw new Fallback("input");
  const source = path.join(image.seed, repository.path);
  // `.git` must be a real folder (not a link or a file that points elsewhere); the history it carries must not be redirected, and it carries no hooks
  try { const info = await lstat(path.join(source, ".git")); if (!info.isDirectory() || info.isSymbolicLink()) throw new Fallback("git"); } catch { throw new Fallback("git"); }
  if ((await unsafeGitEntries(path.join(source, ".git")).catch(() => ["unreadable"])).length > 0) throw new Fallback("git");
  let config: string;
  try {
    assertCredentialFreeRemote(repository.url);
    config = seededGitConfig(repository.url);
  } catch { throw new Fallback("git"); }
  try {
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, verbatimSymlinks: true, dereference: false, force: false, errorOnExist: true });
  } catch { throw new Fallback("copy"); }
  await rm(path.join(destination, ".git", "hooks"), { recursive: true, force: true });
  // The generated config replaces the image's: removed first, then created exclusively (never written through a link that appeared in between).
  try { await replaceFileExclusively(path.join(destination, ".git", "config"), config); } catch { throw new Fallback("git"); }
  // No index entry may carry a flag that hides a change (assume-unchanged, skip-worktree): the index in the image was rebuilt at build, so any flag now is not ours.
  try {
    const flags = await runIsolatedGit(destination, ["ls-files", "-v", "-z"], { timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
    if (countNonStandardFlags(flags) > 0) throw new Fallback("git");
  } catch { throw new Fallback("git"); }
  try {
    await input.fetch({ directory: destination, branch: repository.defaultBranch, credential: input.credential });
  } catch { throw new Fallback("fetch"); }
}
