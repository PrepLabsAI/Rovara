// Path rebasing shared by base-file preparation and the sealed command runner. No runtime dependencies.
/**
 * The path of a seed inside ONE repository's checkout, from its workspace-relative path: the first `k` folders (k = 0 to 4) must be the last `k` folders of the repository's own directory on the worker, the rest is the path in the
 * checkout (never empty, never `..`). Undefined when the seed is not this repository's. Pure.
 */
export function seedPathInRepository(fixturePath: string, repositoryDirectory: string): string | undefined {
  const parts = fixturePath.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.includes("..")) return undefined;
  const folders = repositoryDirectory.split("/").filter((part) => part !== "");
  for (let k = Math.min(4, parts.length - 1); k >= 0; k -= 1) {
    const prefix = parts.slice(0, k);
    if (k === 0 || (folders.length >= k && prefix.every((part, i) => folders[folders.length - k + i] === part))) return parts.slice(k).join("/");
  }
  return undefined;
}

