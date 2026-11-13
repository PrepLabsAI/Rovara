import { constants } from "node:fs";
import { open, readdir, readFile, realpath, rmdir, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { agentXError } from "@rovara-code/contracts";
import { kindIn, openDirectory, type HeldDirectory } from "./candidate-fs.js";
import { candidateLayout, copyObjectsOut, snapshotTree, withIsolatedGit } from "./isolated-git.js";
import { withIsolatedRepository } from "./isolated-repository.js";
import type { IntegrationResult } from "./parallel-parts.js";
import { readCandidateRepositories } from "./verification/candidate.js";

// The git work behind parallel parts (see parallel-parts.ts). Every part is a small repository of its own, in a folder outside every project repository, whose objects borrow the
// project repository's (alternates), so a part sees the code and can write its own files, and nothing it does reaches the project repository until its tree is merged in.
//
// The agent of a part can write anything under its part's folder, and other parts' agents (and processes an earlier part left running) share the sandbox, so the host worker
// treats the whole folder as hostile:
//  - the folder is `<root>/.agentx-parts/<itemId>/<repository>`, a top-level folder of the workspace that is not `.agentx` (which the sandbox hides behind a read-only tmpfs, where
//    no folder could be mounted) and not inside any project repository;
//  - every host-side create, write and remove goes through directories opened without following a symlink (candidate-fs.ts), never through a path the agent could have swapped;
//  - the worker never reads the part's own object directory. A part's tree is made by a throwaway repository that sees the project repository's objects and the part's files, and
//    the new objects that throwaway wrote (worker-owned) are exported into the project repository. Whatever the agent put in `.git/objects` (links, packs, FIFOs, a commit it
//    made itself) is never opened.

/** Where the parts' working copies live, under the workspace root. */
export const PARTS_DIRECTORY = ".agentx-parts";

/**
 * Everything that writes the project repository's objects or files goes one at a time: the throwaway repositories copy their new objects into one object directory, and two
 * copies at once race on its sub-folders. Parts still build side by side; only these short git steps queue.
 */
const queues = new Map<string, Promise<unknown>>();
function inRepository<T>(repositoryDirectory: string, work: () => Promise<T>): Promise<T> {
  const key = resolve(repositoryDirectory);
  const next = (queues.get(key) ?? Promise.resolve()).then(work);
  const tail = next.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return next;
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const HEX40 = /^[a-f0-9]{40}$/u;
const ITEM_ID = /^[a-f0-9-]{36}$/u;

function segmentsOf(itemId: string, repositoryId: string): string[] {
  const segments = repositoryId.split("/");
  if (!ITEM_ID.test(itemId) || segments.length === 0 || segments.some((segment) => segment === "." || segment === ".." || !SAFE_SEGMENT.test(segment))) {
    throw agentXError("CONFIG_INVALID", "a work breakdown part has an unsafe folder name");
  }
  return segments;
}

/** The folder of one part's working copy, refusing anything that could leave the parts folder. */
export function partDirectory(rootPath: string, itemId: string, repositoryId: string): string {
  return join(resolve(rootPath), PARTS_DIRECTORY, itemId, ...segmentsOf(itemId, repositoryId));
}

/** Whether the parts folder is outside the project repository (it is not when the repository is the workspace root, or holds it). */
export async function partsFolderIsOutside(rootPath: string, repositoryDirectory: string): Promise<boolean> {
  const parts = join(await realpath(resolve(rootPath)), PARTS_DIRECTORY);
  const repository = await realpath(resolve(repositoryDirectory));
  return parts !== repository && !parts.startsWith(`${repository}${sep}`);
}

/** The parts folder, opened without following a symlink at any step; `undefined` when it does not exist and `create` is not set. Throws when it, or a folder above it, is a link. */
async function openParts(rootPath: string, create: boolean): Promise<HeldDirectory | undefined> {
  const open = async (): Promise<HeldDirectory | undefined> => {
    const root = await openDirectory(await realpath(resolve(rootPath)));
    try { return await root.subdirectory(PARTS_DIRECTORY, create); } finally { await root.close(); }
  };
  // Parts start together: only one of them makes the folder (a second `mkdir` would find it made).
  return create ? creatingParts(open) : open();
}

let partsCreation: Promise<unknown> = Promise.resolve();
function creatingParts<T>(work: () => Promise<T>): Promise<T> {
  const next = partsCreation.then(work);
  partsCreation = next.catch(() => undefined);
  return next;
}

/** Removes everything in `directory` without following a link: files and links are unlinked, folders are opened without following and emptied. */
async function removeContents(directory: HeldDirectory): Promise<void> {
  for (const name of await readdir(directory.descriptorPath ?? directory.path)) {
    const kind = await kindIn(directory, name);
    if (kind === undefined) continue;
    if (kind === "directory") {
      let child: HeldDirectory | undefined;
      // A folder that became a link since it was looked at: the link goes, not what it leads to.
      try { child = await directory.subdirectory(name, false); } catch { child = undefined; }
      if (child === undefined) { await unlink(directory.entry(name)).catch(() => undefined); continue; }
      try { await removeContents(child); } finally { await child.close(); }
      await rmdir(directory.entry(name));
    } else {
      await unlink(directory.entry(name));
    }
  }
}

/** Removes the item folder `itemId` of the parts folder: a link at that name is unlinked, a folder is emptied through held directories. */
async function removeItemFolder(parts: HeldDirectory, itemId: string): Promise<void> {
  const kind = await kindIn(parts, itemId);
  if (kind === undefined) return;
  if (kind !== "directory") { await unlink(parts.entry(itemId)); return; }
  let folder: HeldDirectory | undefined;
  try { folder = await parts.subdirectory(itemId, false); } catch { folder = undefined; }
  if (folder === undefined) { await unlink(parts.entry(itemId)).catch(() => undefined); return; }
  try { await removeContents(folder); } finally { await folder.close(); }
  await rmdir(parts.entry(itemId));
}

/** Clears the parts folder at the start of a run: the folders of parts that an earlier run did not get to remove. */
export async function clearPartsFolder(rootPath: string): Promise<void> {
  const parts = await openParts(rootPath, false);
  if (parts === undefined) return;
  try { await removeContents(parts); } finally { await parts.close(); }
}

/** Writes `contents` to `name` in `directory`, never through a symlink at that name. */
async function writeIn(directory: HeldDirectory, name: string, contents: string | Buffer): Promise<void> {
  const handle = await open(directory.entry(name), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(contents); } finally { await handle.close(); }
}

/** For tests: called with a step's name between a part folder being made and the repository being built in it, where another part's agent could plant something. */
let creationHook: ((step: string, directory: string) => Promise<void>) | undefined;
export function setPartCreationHookForTests(next: ((step: string, directory: string) => Promise<void>) | undefined): void {
  creationHook = next;
}

export interface PartWorkingCopy {
  readonly directory: string;
  readonly repositoryId: string;
  /** The commit (in the project repository's objects) whose tree the part started from; a capture is always taken against it, never against the part's own HEAD. */
  readonly startCommit: string;
  /** Removes the working copy and its item folder (the shared parts folder stays), without following a link. Safe to call twice. */
  remove(): Promise<void>;
}

const GIT_IDENTITY = ["-c", "user.name=Rovara", "-c", "user.email=rovara@noreply.local"] as const;

/** Makes the working copy of one part: a repository at `treeSha`, borrowing `repositoryDirectory`'s objects. */
export async function createPartWorkingCopy(input: { rootPath: string; repositoryDirectory: string; repositoryId: string; itemId: string; treeSha: string }): Promise<PartWorkingCopy> {
  if (!HEX40.test(input.treeSha)) throw new Error("part start tree is invalid");
  const segments = segmentsOf(input.itemId, input.repositoryId);
  if (!(await partsFolderIsOutside(input.rootPath, input.repositoryDirectory))) {
    throw agentXError("CONFIG_INVALID", "the parts folder would be inside the project repository (a repository at the workspace root), so its parts are built one after another");
  }
  const realRoot = await realpath(resolve(input.rootPath));
  const directory = join(realRoot, PARTS_DIRECTORY, input.itemId, ...segments);
  const main = await candidateLayout(input.repositoryDirectory);
  const parts = (await openParts(input.rootPath, true))!;
  const held: HeldDirectory[] = [parts];
  const copy: { startCommit: string } = { startCommit: "" };
  const remove = async (): Promise<void> => {
    const folder = await openParts(input.rootPath, false);
    if (folder === undefined) return;
    try { await removeItemFolder(folder, input.itemId); } finally { await folder.close(); }
  };
  try {
    // A folder a stopped run left behind is not trusted: it, or a link at its name, goes first.
    await removeItemFolder(parts, input.itemId);
    let current = await parts.subdirectory(input.itemId, true);
    for (const segment of [undefined, ...segments]) {
      if (segment !== undefined) current = await current!.subdirectory(segment, true);
      held.push(current!);
    }
    const repositoryFolder = current!;
    await creationHook?.("folders made", directory);
    // The repository is built by hand through held directories, never by `git init` on the folder: the folder is already in the shared workspace, so another part's agent could have
    // planted `.git` as a link or a `gitdir:` file in the gap, and `git init` would write through it. Each step below opens (or makes) its folder without following a link and
    // fails when one is there, before anything is written; a `.git` that is a real folder is the part's own.
    const gitFolder = (await repositoryFolder.subdirectory(".git", true))!;
    held.push(gitFolder);
    const objectsFolder = (await gitFolder.subdirectory("objects", true))!;
    held.push(objectsFolder);
    const infoFolder = (await objectsFolder.subdirectory("info", true))!;
    held.push(infoFolder);
    for (const name of ["pack"]) held.push((await objectsFolder.subdirectory(name, true))!);
    const refsFolder = (await gitFolder.subdirectory("refs", true))!;
    held.push(refsFolder);
    for (const name of ["heads", "tags"]) held.push((await refsFolder.subdirectory(name, true))!);
    await writeIn(gitFolder, "config", "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n");
    await writeIn(infoFolder, "alternates", `${main.objects}\n`);
    // A commit whose tree is the start tree, written into the project repository's objects, so the part's HEAD names something every git call can read.
    const commit = await inRepository(input.repositoryDirectory, () => withIsolatedGit(input.repositoryDirectory, "write", async (git) =>
      (await git.text([...GIT_IDENTITY, "commit-tree", input.treeSha, "-m", "Rovara part start"], { index: "none" })).trim()));
    if (!HEX40.test(commit)) throw new Error("part start commit is invalid");
    copy.startCommit = commit;
    await writeIn(gitFolder, "HEAD", `${commit}\n`);
    // The files, and an index that agrees with them, so the agent's own `git status` in the part is clean.
    await withIsolatedGit(directory, "read", async (git) => {
      await git.text(["read-tree", commit]);
      await git.text(["checkout-index", "--all", "--force", "-u"]);
      await writeIn(gitFolder, "index", await readFile(git.temporaryIndex));
      // Git sees the project repository's objects, not what is in the part's own object directory (which the agent may have written to by now).
    }, { objectsDirectory: main.objects });
  } catch (error) {
    await remove().catch(() => undefined);
    throw error;
  } finally {
    for (const folder of held.reverse()) await folder.close().catch(() => undefined);
  }
  return { directory, repositoryId: input.repositoryId, startCommit: copy.startCommit, remove };
}

/**
 * The tree of everything the part holds now (its files as they are), with the new objects it needed copied into the project repository so a merge can use them. The part's own
 * object directory, `.git` and HEAD are never read: a throwaway repository sees the project repository's objects and the part's files, snapshots them against the part's start
 * commit, and its own objects (worker-owned) are what is exported.
 */
export async function capturePartTree(part: PartWorkingCopy, repositoryDirectory: string): Promise<string> {
  // No part of the folder's path is a link (opened from the root down, without following one).
  await (await openDirectory(part.directory)).close();
  const main = await candidateLayout(repositoryDirectory);
  return withIsolatedGit(part.directory, "read", async (git) => {
    const treeSha = await snapshotTree(git, part.startCommit);
    if (!HEX40.test(treeSha)) throw new Error("a part's tree could not be read");
    await inRepository(repositoryDirectory, () => copyObjectsOut(join(git.gitDir, "objects"), main));
    return treeSha;
  }, { objectsDirectory: main.objects });
}

/**
 * Three-way merge of a part's tree into the integrated tree, with `baseTreeSha` as the common ancestor (`git merge-tree --write-tree`, Git's own text merge, no repository
 * driver). Exit status 1 is a conflict, which is returned and never resolved by guesswork; any other failure is thrown.
 *
 * The merge is made of commits: the three trees are wrapped in commits (the base, and the two sides each with the base as parent), because `merge-tree --write-tree` takes commits
 * from Git 2.38, while `--merge-base`, and trees as arguments, need 2.40 and the worker image (Debian bookworm) has 2.39.
 */
export async function integrateTrees(repositoryDirectory: string, input: { integratedTreeSha: string; baseTreeSha: string; partTreeSha: string }): Promise<IntegrationResult> {
  for (const tree of [input.integratedTreeSha, input.baseTreeSha, input.partTreeSha]) if (!HEX40.test(tree)) throw new Error("a tree to merge is invalid");
  if (input.integratedTreeSha === input.baseTreeSha || input.partTreeSha === input.baseTreeSha || input.partTreeSha === input.integratedTreeSha) {
    return { ok: true, treeSha: input.integratedTreeSha === input.baseTreeSha ? input.partTreeSha : input.integratedTreeSha };
  }
  return inRepository(repositoryDirectory, () => withIsolatedGit(repositoryDirectory, "write", async (git) => {
    try {
      const commitOf = async (tree: string, parent?: string): Promise<string> =>
        (await git.text([...GIT_IDENTITY, "commit-tree", tree, ...(parent === undefined ? [] : ["-p", parent]), "-m", "Rovara merge"], { index: "none" })).trim();
      const base = await commitOf(input.baseTreeSha);
      const ours = await commitOf(input.integratedTreeSha, base);
      const theirs = await commitOf(input.partTreeSha, base);
      const output = await git.text(["merge-tree", "--write-tree", ours, theirs], { index: "none" });
      const treeSha = output.split("\n")[0]?.trim() ?? "";
      if (!HEX40.test(treeSha)) throw new Error("the merge did not name a tree");
      return { ok: true as const, treeSha };
    } catch (error) {
      if ((error as { code?: unknown }).code === 1) return { ok: false as const };
      throw error;
    }
  }));
}

/**
 * Makes the project repository's files, and its index, hold `toTreeSha` when they hold `fromTreeSha` now: a two-tree `read-tree -m -u`, which removes what `to` lacks and
 * refuses (rather than overwrites) a file that is not as `from` says. Refs, HEAD and the repository's own index are not changed: the files now differ from the index, as after any
 * agent's edits, so the candidate is committed later, and a build that goes on one part at a time, as for any run.
 */
export async function checkoutIntegratedTree(repositoryDirectory: string, fromTreeSha: string, toTreeSha: string): Promise<void> {
  if (!HEX40.test(fromTreeSha) || !HEX40.test(toTreeSha)) throw new Error("a tree to check out is invalid");
  const current = (await readCandidateRepositories([{ repositoryId: "checkout", directory: repositoryDirectory }]))[0]?.treeSha;
  if (current !== fromTreeSha) throw agentXError("OPERATION_INTERRUPTED", "the repository changed while parts were being built, so the merged work was not checked out");
  await inRepository(repositoryDirectory, () => withIsolatedRepository(repositoryDirectory, "write", { index: "work" }, async (repository) => {
    await repository.text(["read-tree", fromTreeSha], { index: "work" });
    // The index now names `from`'s files without their file stamps; refreshing records them. It does not fail for a file that differs (`-q` only quiets it): what keeps a changed
    // file safe is the tree check above, and `read-tree -m -u`, which refuses to overwrite a file that is not as the index says.
    await repository.text(["update-index", "-q", "--refresh"], { index: "work" });
    await repository.text(["read-tree", "-m", "-u", fromTreeSha, toTreeSha], { index: "work" });
  }));
}
