import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build, type Metafile, type Plugin } from "esbuild";

const execFileAsync = promisify(execFile);

// scripts/release/pack-cli.ts -> repo root is two levels up, same as build.ts's REPO_ROOT.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_PACKAGE_NAME = "@charterarc/agentx";
const ENTRY_POINT = join(REPO_ROOT, "packages/cli/src/main.ts");

// esbuild reports `args.path` with the platform's own separators, so the filter must match both
// `/` (macOS/Linux) and `\` (Windows) between path segments. Exported so its cross-platform
// behavior can be tested directly, without needing an actual Windows filesystem.
export const ENTRY_SHEBANG_FILTER = /packages[\\/]cli[\\/]src[\\/]main\.ts$/;

/**
 * main.ts starts with its own `#!/usr/bin/env node` shebang, needed when @agentx/cli's own
 * "bin" points straight at its tsc-compiled dist/main.js (tsc preserves a leading shebang
 * verbatim). esbuild *also* auto-detects and re-emits an entry point's leading shebang, so
 * bundling main.ts unchanged would duplicate it ahead of the banner below, producing two
 * "#!/usr/bin/env node" lines - the second one is invalid JS and crashes at import time. Strip
 * just the entry file's shebang line before esbuild sees it, so the banner's own shebang is the
 * only one in the bundle.
 */
function stripEntryShebang(): Plugin {
  return {
    name: "strip-entry-shebang",
    setup(pluginBuild) {
      pluginBuild.onLoad({ filter: ENTRY_SHEBANG_FILTER }, async (args) => {
        const text = await readFile(args.path, "utf8");
        const stripped = text.startsWith("#!") ? text.slice(text.indexOf("\n") + 1) : text;
        return { contents: stripped, loader: "ts" };
      });
    },
  };
}

export interface PackCliInput {
  version: string;
  out: string;
  name?: string;
}

export interface PackCliResult {
  tarball: string;
  /** Every node_modules package in the bundle, as THIRD_PARTY_NOTICES names it. */
  bundledPackages: BundledPackage[];
}

export interface BundledPackage {
  name: string;
  version: string;
  license: string;
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.[a-z0-9]+)?$/i;

/**
 * The node_modules packages esbuild put into the bundle, read from its metafile: each package's
 * directory is the path up to its name after the last `node_modules/` (a nested copy is its own
 * entry). Workspace packages (@agentx/*) resolve to packages/*, never node_modules, so they are
 * not third-party and are left out.
 */
export function bundledPackageDirectories(metafile: Metafile, root: string): Map<string, string> {
  const directories = new Map<string, string>();
  for (const input of Object.keys(metafile.inputs)) {
    const path = input.split("\\").join("/");
    const match = /^(.*node_modules\/)((?:@[^/]+\/)?[^/]+)\//.exec(path);
    if (match === null) continue;
    directories.set(resolve(root, `${match[1]}${match[2]}`), match[2]!);
  }
  return directories;
}

/**
 * THIRD_PARTY_NOTICES: for each bundled package, its name, version and license, then the license
 * text it ships. MIT, ISC and BSD licenses require the notice to travel with every copy, and the
 * bundle keeps no legal comments, so this file is where the notices live.
 */
export async function thirdPartyNotices(metafile: Metafile, root: string): Promise<{ text: string; packages: BundledPackage[] }> {
  const entries: Array<BundledPackage & { texts: string[] }> = [];
  const seen = new Set<string>();
  for (const [directory, name] of bundledPackageDirectories(metafile, root)) {
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { name?: string; version?: string; license?: unknown };
    const version = manifest.version ?? "unknown";
    if (seen.has(`${name}@${version}`)) continue;
    seen.add(`${name}@${version}`);
    const license = typeof manifest.license === "string" ? manifest.license : "see the license text below";
    const files = (await readdir(directory)).filter((file) => LICENSE_FILE.test(file)).sort();
    const texts = await Promise.all(files.map(async (file) => (await readFile(join(directory, file), "utf8")).trim()));
    entries.push({ name, version, license, texts });
  }
  entries.sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)));
  const rule = "-".repeat(72);
  // A package that ships no license file points at a package in this file that ships the same license's text.
  const missing = (entry: BundledPackage): string => {
    const other = entries.find((candidate) => candidate.license === entry.license && candidate.texts.length > 0);
    return other === undefined
      ? `This package ships no license file; its package.json declares the license ${entry.license}.`
      : `This package ships no license file; its package.json declares the license ${entry.license}, whose text is included in this file under ${other.name}@${other.version}.`;
  };
  const sections = entries.map((entry) => [
    rule,
    `${entry.name}@${entry.version}`,
    `License: ${entry.license}`,
    "",
    entry.texts.length > 0 ? entry.texts.join("\n\n") : missing(entry),
    "",
  ].join("\n"));
  const text = [
    "Third-party notices for the AgentX CLI",
    "",
    "bin/agentx.mjs bundles the open-source packages below. Each is listed with its version, its",
    "license, and the license text it ships.",
    "",
    ...sections,
  ].join("\n");
  return { text, packages: entries.map(({ name, version, license }) => ({ name, version, license })) };
}

function readmeText(name: string): string {
  return [
    `# ${name}`,
    "",
    "AgentX installer and administration CLI, bundled as a single self-contained script with no",
    "runtime dependencies of its own. See LICENSE for terms (Functional Source License 1.1, ALv2",
    "future license). The notices and license texts of the open-source packages the bundle",
    "includes are in THIRD_PARTY_NOTICES.",
    "",
    "## Install",
    "",
    "```",
    `npm install -g ${name}`,
    "agentx --help",
    "```",
    "",
  ].join("\n");
}

/**
 * Builds the publishable npm package for the AgentX CLI: a single esbuild bundle at
 * `bin/agentx.mjs` (no `dependencies` in package.json, because everything is bundled), a generated
 * `package.json` and `README.md`, then packs it with `npm pack` and returns the tarball path.
 */
export async function packCli(input: PackCliInput): Promise<PackCliResult> {
  const name = input.name ?? DEFAULT_PACKAGE_NAME;
  const out = resolve(input.out);
  const packageDir = join(out, "package");
  const binDir = join(packageDir, "bin");
  // Rerunning packCli into the same --out (e.g. a developer retrying a failed release build)
  // must not leave stray files from a previous attempt mixed into the new package.
  await rm(packageDir, { recursive: true, force: true });
  await mkdir(binDir, { recursive: true });

  const bundlePath = join(binDir, "agentx.mjs");
  const { metafile } = await build({
    entryPoints: [ENTRY_POINT],
    // The inputs list names every bundled package, for THIRD_PARTY_NOTICES.
    metafile: true,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: bundlePath,
    define: { __AGENTX_VERSION__: JSON.stringify(input.version) },
    // Bundled CommonJS dependencies call `require`, which a native ESM module doesn't have; this
    // banner also doubles as the executable's shebang.
    banner: {
      js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
    legalComments: "none",
    plugins: [stripEntryShebang()],
  });
  await chmod(bundlePath, 0o755);

  const manifest = {
    name,
    version: input.version,
    type: "module",
    bin: { agentx: "bin/agentx.mjs" },
    engines: { node: ">=22.19.0" },
    license: "FSL-1.1-ALv2",
    files: ["bin", "README.md", "LICENSE", "THIRD_PARTY_NOTICES"],
    description: "AgentX installer and administration CLI",
    // release.yml's npm job passes no --provenance flag: PrepLabsAI/AgentX is private today, and
    // npm provenance attestation fails for private repositories. Once the repository is public,
    // npm trusted publishing (OIDC) adds provenance automatically, with no flag and no other change
    // needed here — except that npm cross-checks this field against the source repository the
    // publish's OIDC token was minted for (release.yml checks out PrepLabsAI/AgentX), so a missing
    // or mismatched repository.url would make npm reject the publish.
    repository: { type: "git", url: "git+https://github.com/PrepLabsAI/AgentX.git" },
  };
  await writeFile(join(packageDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(join(packageDir, "README.md"), readmeText(name), "utf8");
  // copyFile, not read-as-utf8-then-write, so the packaged LICENSE is byte-for-byte identical to
  // the repo root's (no re-encoding, no line-ending normalization).
  await copyFile(join(REPO_ROOT, "LICENSE"), join(packageDir, "LICENSE"));
  // esbuild's metafile paths are relative to its working directory.
  const notices = await thirdPartyNotices(metafile, process.cwd());
  await writeFile(join(packageDir, "THIRD_PARTY_NOTICES"), notices.text, "utf8");

  // npm pack, run with `packageDir` as cwd, prints only the tarball's filename to stdout (its
  // human-readable "npm notice" summary goes to stderr instead).
  const { stdout } = await execFileAsync("npm", ["pack", "--pack-destination", out], { cwd: packageDir });
  const tarballName = stdout.trim().split("\n").at(-1);
  if (!tarballName) throw new Error("npm pack did not print a tarball filename");
  return { tarball: join(out, tarballName), bundledPackages: notices.packages };
}

function usage(): string {
  return "Usage: tsx scripts/release/pack-cli.ts --version <version> --out <dir> [--name <package-name>]\n";
}

interface CliArgs {
  version: string;
  out: string;
  name?: string;
}

export function parsePackCliArgs(argv: readonly string[]): CliArgs {
  const consumed = new Set<number>();
  const valueAfter = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index < 0) return undefined;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    consumed.add(index);
    consumed.add(index + 1);
    return value;
  };
  const known = new Set(["--version", "--out", "--name", "--help"]);
  for (const argument of argv) {
    if (argument.startsWith("--") && !known.has(argument)) throw new Error(`unknown option ${argument}`);
  }
  const version = valueAfter("--version");
  const out = valueAfter("--out");
  if (version === undefined) throw new Error("--version is required");
  if (out === undefined) throw new Error("--out is required");
  const name = valueAfter("--name");
  // Every remaining argument must be a recognized flag (already checked above) or a value consumed
  // by one; anything else is a stray positional argument (e.g. a misplaced value, or a typo that
  // happens not to start with "--") that this command has no use for and would otherwise ignore.
  const stray = argv.filter((argument, index) => !consumed.has(index) && argument !== "--help");
  if (stray.length > 0) throw new Error(`unexpected argument ${stray[0]}`);
  return { version, out, ...(name !== undefined ? { name } : {}) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--help")) {
    process.stdout.write(usage());
  } else {
    // Wraps the synchronous argument parsing too, not just the packCli promise below, so a bad
    // flag gets the same clean "agentx release pack-cli failed: ..." message + exit code as every
    // other failure, instead of a raw Node stack trace.
    try {
      const args = parsePackCliArgs(process.argv.slice(2));
      packCli({
        version: args.version,
        out: resolve(args.out),
        ...(args.name !== undefined ? { name: args.name } : {}),
      })
        .then((result) => {
          process.stdout.write(`wrote ${result.tarball}\n`);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`agentx release pack-cli failed: ${message}\n`);
          process.exitCode = 1;
        });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`agentx release pack-cli failed: ${message}\n`);
      process.exitCode = 1;
    }
  }
}
