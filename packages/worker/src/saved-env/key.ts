// Setup and test health SH21: the environment key's pure parts now live in the contracts (`saved-env-key-files.ts`), so the broker and the worker work it out the same way; this file re-exports them and keeps the
// one thing only the worker does, hashing a file of a checkout.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export {
  SAVED_ENV_FIXED_KEY_GLOBS, SAVED_ENV_KEY_BUILD_OUTPUT_DIRS, SAVED_ENV_KEY_EXCLUDED_GLOBS, blobKeyHash, environmentKeyFromRepositories, isRegularBlobMode, keyFilePaths, stripJsonComments,
  type EnvironmentKeyRequest, type EnvironmentKeyResult, type KeyRepository,
} from "@agentx/contracts";

/** The most bytes of one key file that are hashed; a larger file is unreadable (a key file is a manifest, not data). */
export const SAVED_ENV_KEY_FILE_MAX_BYTES = 64 * 1_048_576;

/**
 * sha256 hex of a file in a repository checkout, or undefined. Only a regular file whose real path is exactly `root/relativePath` is hashed: a symbolic link (as the file or as any directory above it) is refused,
 * so a checkout cannot make the key read a file outside itself.
 */
export async function hashWorkspaceFile(root: string, relativePath: string): Promise<string | undefined> {
  try {
    if (relativePath.length === 0 || relativePath.startsWith("/") || relativePath.includes("\\") || relativePath.split("/").some((part) => part === "" || part === "." || part === "..")) return undefined;
    const realRoot = await realpath(root);
    const full = path.join(realRoot, relativePath);
    const [info, real] = await Promise.all([lstat(full), realpath(full)]);
    if (!info.isFile() || info.isSymbolicLink() || real !== full || info.size > SAVED_ENV_KEY_FILE_MAX_BYTES) return undefined;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(full)) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}
