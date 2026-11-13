// Stamps one version on every package under packages/ and on every dependency one package has on another, so a build's tarballs carry a
// version that has never been seen before and a stale npm cache cannot hide a new tarball. CI runs it before `npm pack` with
// `<current version>-ci.<short sha>`. It edits package.json files in the checkout only; it never touches package-lock.json and is never run on a commit.
//
// Node runs this file directly, so only erasable syntax and only Node's own modules. Usage, from the repository root:
//   node scripts/stamp-package-versions.ts <version>
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Manifest { name: string; version: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; [key: string]: unknown }

/** The manifest with `version` on it and on every dependency that names one of `names`. */
export function stamp(manifest: Manifest, names: ReadonlySet<string>, version: string): Manifest {
  const next: Manifest = { ...manifest, version };
  for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const block = manifest[field];
    if (block === undefined) continue;
    next[field] = Object.fromEntries(Object.entries(block).map(([name, range]) => [name, names.has(name) ? version : range]));
  }
  return next;
}

function main(): void {
  const version = process.argv[2];
  if (version === undefined || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("usage: node scripts/stamp-package-versions.ts <semver version>");
  const directories = readdirSync("packages", { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join("packages", entry.name, "package.json"));
  const manifests = directories.map((path) => ({ path, manifest: JSON.parse(readFileSync(path, "utf8")) as Manifest }));
  const names = new Set(manifests.map((item) => item.manifest.name));
  for (const { path, manifest } of manifests) writeFileSync(path, `${JSON.stringify(stamp(manifest, names, version), null, 2)}\n`);
  console.log(`stamped ${manifests.length} packages with ${version}`);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
