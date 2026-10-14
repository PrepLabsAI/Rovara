import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { canonicalJson } from "@agentx/contracts";
import { containedRuntimeProfileForHost } from "./container-envelope.js";

export type InstalledRuntimeManifest = Readonly<{
  schemaVersion: "installed-runtime-manifest/v1";
  entries: readonly Readonly<{ path: string; sha256: string }>[];
  sha256: string;
}>;

/** Hashes the packaged verifier, worker, contracts, runner, and immutable probe fixtures. The only
 * roots are fixed by the code-pinned host profile; no caller-selected path enters this inventory. */
export async function observeInstalledRuntimeManifestForHost(platform: string, arch: string): Promise<InstalledRuntimeManifest> {
  const profile = containedRuntimeProfileForHost(platform, arch);
  if (!profile) throw new Error("installed runtime manifest is unavailable on this host");
  const root = profile.installedRuntimeRoot;
  if (!isAbsolute(root) || await realpath(root) !== root) throw new Error("installed runtime root is not canonical");
  const entries: Array<{ path: string; sha256: string }> = [];
  const addFile = async (path: string): Promise<void> => {
    const absolute = join(root, path);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("installed runtime manifest contains a non-regular file");
    const bytes = await readFile(absolute);
    entries.push({ path: relative(root, absolute).split(sep).join("/"), sha256: createHash("sha256").update(bytes).digest("hex") });
    if (entries.length > 4096) throw new Error("installed runtime manifest exceeds its bounded entry count");
  };
  const addTree = async (path: string): Promise<void> => {
    const absolute = join(root, path);
    const info = await lstat(absolute);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(absolute) !== absolute) throw new Error("installed runtime manifest tree is not a canonical directory");
    const walk = async (directory: string): Promise<void> => {
      const children = await readdir(directory, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        const childPath = join(directory, child.name);
        if (child.isSymbolicLink()) throw new Error("installed runtime manifest refuses symbolic links");
        if (child.isDirectory()) await walk(childPath);
        else if (child.isFile()) await addFile(relative(root, childPath));
        else throw new Error("installed runtime manifest refuses special files");
        if (entries.length > 4096) throw new Error("installed runtime manifest exceeds its bounded entry count");
      }
    };
    await walk(absolute);
  };

  await addFile("package-lock.json");
  await addTree("packages/contracts/dist");
  await addTree("packages/verifier/dist");
  await addTree("packages/verifier/assets");
  await addTree("packages/worker/dist");
  await addTree("node_modules/e2e");
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const body = { schemaVersion: "installed-runtime-manifest/v1" as const, entries };
  return Object.freeze({ ...body, entries: Object.freeze(entries.map((entry) => Object.freeze(entry))), sha256: createHash("sha256").update(canonicalJson(body)).digest("hex") });
}
