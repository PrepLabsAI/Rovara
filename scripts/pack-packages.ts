// Packs every package under packages/ with `npm pack` into one folder and checks each tarball. This is what Cloud installs. Nothing is
// published (decision 154): the packages are private, and this script only writes files.
//
// For each package it checks that the tarball holds the package.json and every file its `exports`, `main` and `bin` point at, so a package
// that built but forgot to ship a file (a `files` list that left something out) fails here, not in Cloud. It writes packs.json beside the
// tarballs: name, version, file and sha256 of each.
//
// Node runs this file directly, so only erasable syntax and only Node's own modules. Usage, from the repository root, after `npm run build`:
//   node scripts/pack-packages.ts <out directory>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface Manifest {
  name: string;
  version: string;
  main?: string;
  bin?: string | Record<string, string>;
  exports?: string | Record<string, string | { types?: string; default?: string }>;
}

/** The files a package.json says a consumer will load, as paths inside the package (no leading "./"). */
export function shippedTargets(manifest: Manifest): string[] {
  const targets: string[] = [];
  if (typeof manifest.main === "string") targets.push(manifest.main);
  if (typeof manifest.bin === "string") targets.push(manifest.bin);
  else if (manifest.bin !== undefined) targets.push(...Object.values(manifest.bin));
  if (typeof manifest.exports === "string") targets.push(manifest.exports);
  else if (manifest.exports !== undefined) {
    for (const value of Object.values(manifest.exports)) targets.push(...(typeof value === "string" ? [value] : [value.types, value.default].filter((item): item is string => item !== undefined)));
  }
  return [...new Set(targets)].map((target) => target.replace(/^\.\//, ""));
}

function main(): void {
  const out = resolve(process.argv[2] ?? "");
  if (process.argv[2] === undefined) throw new Error("usage: node scripts/pack-packages.ts <out directory>");
  mkdirSync(out, { recursive: true });
  const packs: { name: string; version: string; file: string; sha256: string }[] = [];
  const problems: string[] = [];
  for (const entry of readdirSync("packages", { withFileTypes: true }).filter((item) => item.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const directory = `packages/${entry.name}`;
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as Manifest;
    const result = JSON.parse(execFileSync("npm", ["pack", `./${directory}`, "--pack-destination", out, "--json", "--ignore-scripts"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })) as { filename: string; files: { path: string }[] }[];
    const packed = result[0]!;
    const inside = new Set(packed.files.map((file) => file.path));
    if (!inside.has("package.json")) problems.push(`${manifest.name}: no package.json in the tarball`);
    for (const target of shippedTargets(manifest)) {
      // A declaration file is shipped with its JavaScript file; only the entries themselves are checked.
      if (!inside.has(target)) problems.push(`${manifest.name}: ${target} is named by package.json but is not in the tarball`);
    }
    if (![...inside].some((path) => path.startsWith("dist/"))) problems.push(`${manifest.name}: the tarball has no dist/ (run npm run build first)`);
    if (![...inside].every((path) => !path.endsWith(".map"))) problems.push(`${manifest.name}: the tarball holds source map files (*.map are left out to keep it small)`);
    if ([...inside].some((path) => path.startsWith("src/"))) problems.push(`${manifest.name}: the tarball holds src/ (only the build is shipped)`);
    packs.push({ name: manifest.name, version: manifest.version, file: packed.filename, sha256: createHash("sha256").update(readFileSync(join(out, packed.filename))).digest("hex") });
  }
  writeFileSync(join(out, "packs.json"), `${JSON.stringify(packs, null, 2)}\n`);
  for (const pack of packs) console.log(`${pack.name}@${pack.version}  ${pack.file}  ${pack.sha256.slice(0, 12)}`);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`pack check failed: ${problem}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
