import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export async function checkWorkspace(path, limitBytes) {
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) throw new Error("INVALID_LIMIT");
  const root = await realpath(path);
  let bytes = 0;
  async function visit(directory) {
    for (const entry of await readdir(directory)) {
      const file = resolve(directory, entry);
      const metadata = await lstat(file);
      if (metadata.isSymbolicLink()) {
        let target;
        try { target = await realpath(file); } catch { throw new Error("BROKEN_SYMLINK"); }
        const rel = relative(root, target);
        if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("ESCAPING_SYMLINK");
      } else if (metadata.isDirectory()) await visit(file);
      else if (metadata.isFile()) {
        bytes += metadata.size;
        if (bytes >= limitBytes) throw new Error("WORKSPACE_TOO_LARGE");
      } else throw new Error("UNSUPPORTED_WORKSPACE_FILE");
    }
  }
  await visit(root);
  return { bytes };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await checkWorkspace(process.argv[2], Number(process.argv[3]));
  process.stdout.write(`${result.bytes}\n`);
}
