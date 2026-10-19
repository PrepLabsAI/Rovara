import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WEB_API_QUALIFICATION_APP_TREE_DIGEST, webApiQualificationAppTreeDigest } from "@agentx/contracts";

const MAX_FILES = 256;
const MAX_FILE_BYTES = 1024 * 1024;

/** The qualification app shipped inside the installed verifier package (`assets/qualification-app`, next to `dist`). */
export function installedWebApiQualificationAppRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../assets/qualification-app");
}

/**
 * Reads the whole app tree and checks it against the digest pinned in contracts. Symbolic links, special files and anything oversized
 * refuse outright, so nothing but the pinned bytes can ever be built and started for a probe.
 */
export async function verifyWebApiQualificationApp(appRoot: string): Promise<Readonly<{ treeDigest: string; files: readonly Readonly<{ path: string; sha256: string }>[] }>> {
  const root = await realpath(appRoot);
  const info = await lstat(root);
  if (!info.isDirectory()) throw new Error("qualification-app-not-a-directory");
  const files: { path: string; sha256: string }[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, child.name);
      if (child.isSymbolicLink() || (!child.isDirectory() && !child.isFile())) throw new Error("qualification-app-digest-mismatch: links and special files are refused");
      if (child.isDirectory()) { await walk(path); continue; }
      if ((await lstat(path)).size > MAX_FILE_BYTES || files.length >= MAX_FILES) throw new Error("qualification-app-digest-mismatch: the tree exceeds its bounds");
      files.push({ path: relative(root, path).split(sep).join("/"), sha256: createHash("sha256").update(await readFile(path)).digest("hex") });
    }
  };
  await walk(root);
  const treeDigest = webApiQualificationAppTreeDigest(files);
  if (treeDigest !== WEB_API_QUALIFICATION_APP_TREE_DIGEST) throw new Error("qualification-app-digest-mismatch");
  return Object.freeze({ treeDigest, files: Object.freeze(files.map((file) => Object.freeze(file))) });
}

/**
 * Copies the verified app to `destination`, a directory the Docker host can mount (the daemon resolves mount paths on the Docker
 * host, so the installed asset path inside the worker container is not usable). Nothing is created when verification fails.
 */
export async function stageWebApiQualificationApp(appRoot: string, destination: string): Promise<void> {
  await verifyWebApiQualificationApp(appRoot);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  try {
    await cp(appRoot, destination, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    // The build container reads the copy as its own unprivileged user.
    await chmod(destination, 0o755);
    for (const entry of await readdir(destination, { withFileTypes: true, recursive: true })) {
      const path = join(entry.parentPath, entry.name);
      await chmod(path, entry.isDirectory() ? 0o755 : 0o644);
    }
    // The copy is checked again, so a change between the first check and the copy cannot reach a build.
    await verifyWebApiQualificationApp(destination);
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
