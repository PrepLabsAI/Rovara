// Rebuilds only the reviewed pure 0.2.12 parser fixture; never loads the old Lambda handler.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as buildBundle, version as esbuildVersion, type Plugin } from "esbuild";
import * as ts from "typescript";

const scriptPath = fileURLToPath(import.meta.url);
const oldCommit = "8db81509d3c4726252f01d6627c43c46becd6e21";
const manifestSha = "85b32a891001ad0ae4d180a46630035ac6d125dd21c7224ee37bc7b369567f80";
const zipName = "packages/16edced13be82a7926e681815bda3cc727dbe9a566e9976b85832a3e729621ab.zip";
const mapSha = "c84baa7a6e5ff0d53d4d36e94fd5e2564776135dba1b407b901f4bc0b1114df2";
const bundleSha = "4f61072bd5c19de3080f59322a5f8dcd4add178341d4a8d839cd1109e87d987f";
const EXPECTED_EXPORTS = ["WorkerInvocationSchema", "WorkflowSnapshotSchema"];
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

function argumentsMap(values: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!(["--release-dir", "--repo", "--output"] as string[]).includes(name ?? "") || value === undefined || args.has(name!)) {
      throw new Error("usage: tsx scripts/generate-rollback-0212-parser.ts --release-dir DIR --repo DIR --output DIR");
    }
    args.set(name!, value);
  }
  if (args.size !== 3) throw new Error("usage: tsx scripts/generate-rollback-0212-parser.ts --release-dir DIR --repo DIR --output DIR");
  return args;
}

interface Manifest { version: string; gitCommit: string; packages: Array<{ file: string; sha256: string }> }
interface PackageLock { packages: Record<string, { version: string; integrity: string }> }
interface Extracted { mapSha: string; contracts: Record<string, string>; zod: Record<string, string> }

const args = argumentsMap(process.argv.slice(2));
const repo = path.resolve(args.get("--repo")!);
const output = path.resolve(args.get("--output")!);
const release = path.resolve(args.get("--release-dir")!);
const localRequire = createRequire(path.join(repo, "package.json"));
mkdirSync(output, { recursive: true });

const manifestBytes = readFileSync(path.join(release, "release.json"));
if (sha(manifestBytes) !== manifestSha) throw new Error("release manifest changed");
const manifest = JSON.parse(manifestBytes.toString("utf8")) as Manifest;
if (manifest.version !== "0.2.12" || manifest.gitCommit !== oldCommit) throw new Error("release identity mismatch");
const entry = manifest.packages.find((item) => item.file === zipName);
if (entry === undefined || sha(readFileSync(path.join(release, zipName))) !== entry.sha256) throw new Error("shipped ZIP changed");
const extracted = JSON.parse(execFileSync("python3", ["-c",
  "import json,zipfile,sys,hashlib; z=zipfile.ZipFile(sys.argv[1]); b=z.read('index.js.map'); m=json.loads(b); print(json.dumps({'mapSha':hashlib.sha256(b).hexdigest(),'contracts':{s:c for s,c in zip(m['sources'],m['sourcesContent']) if '/packages/contracts/dist/' in s},'zod':{s:hashlib.sha256(c.encode()).hexdigest() for s,c in zip(m['sources'],m['sourcesContent']) if '/node_modules/zod/' in s}}))",
  path.join(release, zipName)], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })) as Extracted;
if (extracted.mapSha !== mapSha) throw new Error("shipped map changed");

const oldLock = JSON.parse(execFileSync("git", ["show", `${oldCommit}:package-lock.json`], { cwd: repo, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })) as PackageLock;
const currentLock = JSON.parse(readFileSync(path.join(repo, "package-lock.json"), "utf8")) as PackageLock;
for (const name of ["typescript", "esbuild", "zod"]) {
  const oldPackage = oldLock.packages[`node_modules/${name}`];
  const currentPackage = currentLock.packages[`node_modules/${name}`];
  const installed = localRequire(`${name}/package.json`) as { version: string };
  if (oldPackage === undefined || currentPackage === undefined || oldPackage.version !== currentPackage.version
    || oldPackage.version !== installed.version || oldPackage.integrity !== currentPackage.integrity) {
    throw new Error(`${name} pin drift`);
  }
}

const modules = new Map<string, string>();
const verifiedContracts: Array<{ sourcePath: string; gitPath: string; gitSourceSha256: string; shippedCompiledSha256: string }> = [];
for (const [sourcePath, contents] of Object.entries(extracted.contracts)) {
  const suffix = sourcePath.split("/packages/contracts/dist/")[1];
  if (suffix === undefined) throw new Error(`unexpected contract source path: ${sourcePath}`);
  const gitPath = `packages/contracts/src/${suffix.replace(/\.js$/, ".ts")}`;
  const source = execFileSync("git", ["show", `${oldCommit}:${gitPath}`], { cwd: repo, encoding: "utf8" });
  const reproduced = ts.transpileModule(source, { fileName: gitPath, compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true } }).outputText;
  if (reproduced !== contents) throw new Error(`shipped compiled source mismatch: ${gitPath}`);
  modules.set(`packages/contracts/dist/${suffix}`, contents);
  verifiedContracts.push({ sourcePath, gitPath, gitSourceSha256: sha(source), shippedCompiledSha256: sha(contents) });
}
for (const [sourcePath, expected] of Object.entries(extracted.zod)) {
  const suffix = sourcePath.split("/node_modules/zod/")[1];
  if (suffix === undefined || sha(readFileSync(path.join(repo, "node_modules/zod", suffix))) !== expected) {
    throw new Error(`shipped Zod source mismatch: ${suffix ?? sourcePath}`);
  }
}
modules.set("packages/contracts/dist/parser-entry.js", "export { WorkflowSnapshotSchema } from \"./task-workflow.js\";\nexport { WorkerInvocationSchema } from \"./protocol.js\";\n");

const plugin: Plugin = {
  name: "immutable-pure-contracts",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (resolveArgs) => {
      if (resolveArgs.path === "node:crypto" || resolveArgs.path === "node:path") return { path: resolveArgs.path, external: true };
      if (resolveArgs.path === "zod") return { path: path.join(repo, "node_modules/zod/index.js") };
      if (resolveArgs.namespace === "legacy" || resolveArgs.kind === "entry-point") {
        const candidate = resolveArgs.kind === "entry-point" ? resolveArgs.path
          : path.posix.normalize(path.posix.join(path.posix.dirname(resolveArgs.importer), resolveArgs.path));
        if (!modules.has(candidate)) throw new Error(`non-allowlisted old import: ${candidate}`);
        return { path: candidate, namespace: "legacy" };
      }
      const candidate = path.resolve(path.dirname(resolveArgs.importer), resolveArgs.path);
      if (!candidate.startsWith(path.join(repo, "node_modules/zod") + path.sep)) throw new Error(`non-Zod dependency: ${candidate}`);
      return { path: candidate };
    });
    build.onLoad({ filter: /.*/, namespace: "legacy" }, (loadArgs) => {
      const contents = modules.get(loadArgs.path);
      if (contents === undefined) throw new Error(`missing allowlisted old module: ${loadArgs.path}`);
      return { contents, loader: "js" };
    });
  },
};

const result = await buildBundle({ entryPoints: ["packages/contracts/dist/parser-entry.js"], bundle: true, format: "esm", platform: "node", target: "node22", minify: true, treeShaking: true, legalComments: "none", write: false, metafile: true, plugins: [plugin] });
const bytes = result.outputFiles[0]?.contents;
if (bytes === undefined) throw new Error("parser bundle output missing");
const inputs = Object.keys(result.metafile?.inputs ?? {});
if (inputs.some((input) => !input.startsWith("legacy:packages/contracts/dist/") && !input.includes("node_modules/zod/"))) throw new Error("unexpected bundle module");
const outputMetadata = Object.values(result.metafile?.outputs ?? {})[0];
if (outputMetadata === undefined || JSON.stringify(outputMetadata.exports?.slice().sort()) !== JSON.stringify(EXPECTED_EXPORTS)) throw new Error("unexpected exports");
if (sha(bytes) !== bundleSha) throw new Error("derived parser bundle differs from the reviewed immutable bytes");

writeFileSync(path.join(output, "parser-bundle.txt"), bytes);
const provenance = {
  status: "LOCAL_DERIVED_NOT_PUBLISHED", releaseVersion: manifest.version, manifestSha256: manifestSha, zip: zipName, zipSha256: entry.sha256,
  sourceMapSha256: mapSha, gitCommit: oldCommit,
  gitTree: execFileSync("git", ["rev-parse", `${oldCommit}^{tree}`], { cwd: repo, encoding: "utf8" }).trim(),
  runtime: process.version,
  versions: { typescript: ts.version, esbuild: esbuildVersion, zod: (localRequire("zod/package.json") as { version: string }).version },
  options: { format: "esm", platform: "node", target: "node22", minify: true, treeShaking: true, legalComments: "none" },
  exports: outputMetadata.exports ?? [], bundleSha256: sha(bytes), bundleBytes: bytes.length, verifiedContracts,
  shippedZodSourcesMatched: Object.keys(extracted.zod).length, bundleInputs: inputs, producerSha256: sha(readFileSync(scriptPath)),
  limitations: ["Reconstructed pure schemas, not original Lambda bundle execution", "No current workflow compatibility test or semantic authorization rollback approval"],
};
writeFileSync(path.join(output, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ bundleBytes: bytes.length, bundleSha256: sha(bytes), contractsMatched: verifiedContracts.length, shippedZodSourcesMatched: provenance.shippedZodSourcesMatched, inputs: inputs.length, exports: provenance.exports })}\n`);
