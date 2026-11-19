// Saved project images: the environment key, worked out by the BROKER from the code host's tree listing of the commits a job is for. The key hashes the key files (lockfiles, build files, toolchain files,
// dev container files and the environment's detector globs), the approved revision, the SET of secret names and the base image digest (contracts `saved-env-key-files.ts`, the one implementation the worker uses too).
// TWO LIMITS, BOTH BY DESIGN TODAY: the base image digest is WORKER-WIDE (the one worker image every worker of the environment runs: a rollout changes every project's key once, it is not a property of a project), and the
// secret names are those of the approved environment's `http_hook` accounts only (no other field of the environment names a secret).
// A key file is named by its git blob id, so no file is read and no clone is needed; the dev container files are read as text (the files they point at are key files too). The worker works the key out again from
// the clone it built from and refuses to build when it differs (`key_mismatch`).
//   - the listing is cached by repository and commit (a commit's tree never changes), a few at a time;
//   - FAIL CLOSED: a listing that is truncated, missing or unreadable, a key file that is a link or a submodule, a dev container file that cannot be read, or more key files than a key can hold gives NO key (the
//     registry then queues nothing, `no_key`), never a key over fewer files.
import { blobKeyHash, environmentKeyFromRepositories, isRegularBlobMode, type KeyRepository } from "@agentx/contracts";

export interface TreeEntryListing { path: string; mode: string; type: string; sha: string }

/** What the broker asks of the code host. Both answers are about one commit and never change for it. */
export interface KeyHost {
  /** The whole tree of a commit, or undefined when the host cannot list it. `truncated` is the host's own flag. */
  listTree(repository: { name: string; url: string }, commit: string): Promise<{ truncated: boolean; entries: readonly TreeEntryListing[] } | undefined>;
  /** A small file of a commit as text, or undefined when there is none or it cannot be read. */
  readText(repository: { name: string; url: string }, commit: string, path: string): Promise<string | undefined>;
}

export interface KeyRequest {
  /** The company the listing is read for: part of the cache key, so one company never gets a hit from another's listing. */
  orgId: string;
  repositories: ReadonlyArray<{ name: string; url: string }>;
  /** The commit of each repository, by repository name: exactly these repositories. */
  commits: ReadonlyMap<string, string>;
  detectorGlobs: readonly string[];
  testEnvRevision: number;
  secretNames: readonly string[];
  baseImageDigest: string;
}

/** A small cache of listings by company, repository and commit. */
export class KeyListingCache {
  private readonly trees = new Map<string, { truncated: boolean; entries: readonly TreeEntryListing[] }>();
  private readonly texts = new Map<string, string | undefined>();
  constructor(private readonly max = 32) {}
  async tree(host: KeyHost, orgId: string, repository: { name: string; url: string }, commit: string): Promise<{ truncated: boolean; entries: readonly TreeEntryListing[] } | undefined> {
    const key = `${orgId}\n${repository.url}\n${commit}`;
    const known = this.trees.get(key);
    if (known !== undefined) return known;
    const listed = await host.listTree(repository, commit);
    if (listed !== undefined && !listed.truncated) {
      if (this.trees.size >= this.max) this.trees.delete(this.trees.keys().next().value as string);
      this.trees.set(key, listed);
    }
    return listed;
  }
  async text(host: KeyHost, orgId: string, repository: { name: string; url: string }, commit: string, path: string): Promise<string | undefined> {
    const key = `${orgId}\n${repository.url}\n${commit}\n${path}`;
    if (this.texts.has(key)) return this.texts.get(key);
    const text = await host.readText(repository, commit, path);
    // Only an answer is kept: a file that could not be read is asked for again.
    if (text !== undefined) {
      if (this.texts.size >= this.max * 8) this.texts.delete(this.texts.keys().next().value as string);
      this.texts.set(key, text);
    }
    return text;
  }
}

/** The key, or undefined (no key can be worked out). Never throws. */
export async function expectedEnvironmentKey(host: KeyHost, request: KeyRequest, cache: KeyListingCache = new KeyListingCache()): Promise<string | undefined> {
  try {
    if (request.repositories.length === 0 || request.repositories.length !== request.commits.size) return undefined;
    const repositories: KeyRepository[] = [];
    for (const repository of request.repositories) {
      const commit = request.commits.get(repository.name);
      if (commit === undefined) return undefined;
      const tree = await cache.tree(host, request.orgId, repository, commit);
      // A truncated listing is no listing: a key over part of the tree would miss the files past the cut.
      if (tree === undefined || tree.truncated) return undefined;
      const entries = new Map(tree.entries.filter((entry) => entry.type !== "tree").map((entry) => [entry.path, entry]));
      repositories.push({
        repositoryId: repository.name,
        paths: [...entries.keys()],
        readText: async (path) => { const entry = entries.get(path); return entry?.type === "blob" ? cache.text(host, request.orgId, repository, commit, path).catch(() => undefined) : undefined; },
        hashFile: async (path) => { const entry = entries.get(path); return entry !== undefined && entry.type === "blob" && isRegularBlobMode(entry.mode) ? blobKeyHash(entry.sha) : undefined; },
      });
    }
    const key = await environmentKeyFromRepositories({ repositories, detectorGlobs: request.detectorGlobs, testEnvRevision: request.testEnvRevision, secretNames: request.secretNames, baseImageDigest: request.baseImageDigest });
    return key.ok ? key.key : undefined;
  } catch {
    return undefined;
  }
}
