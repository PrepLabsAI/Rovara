// The proof that Code's copy of the model gateway equals the gateway in Rovara Cloud at one pinned commit (#1478), byte for byte,
// except for differences this file's manifest declares one by one (scripts/gateway-catch-up-manifest.json).
//
//   node scripts/gateway-catch-up-proof.ts check [--root <dir>] [--cloud <clone of Rovara Cloud>]
//
// Without --cloud (CI): every file is hashed the way git hashes a blob and compared with the blob id the manifest holds for Cloud's file.
//   - exact: the file's blob id must be Cloud's (packages/model-gateway/**, the image files, the base tsconfig, the shared contracts,
//     the gateway's fixtures, the image script and the named tests). Every file under packages/model-gateway must be listed.
//   - adapted: Code's own import lines and file names. The declared hunks are put back into Code's file and the result must hash to
//     Cloud's blob; a hunk whose Cloud side is not written down here is held by the blob id of Code's file instead.
//   - linePins: lines Code's hand-written helper repeats from Cloud's file, and names it must not carry.
//   - switches: the per-environment source kinds Code's deploy inputs hold.
//   - declaredNotPorted: Cloud files in scope that Code does not carry (they must stay absent).
// With --cloud the same manifest is also checked against Cloud's own tree at the pinned commit: every blob id, every hunk's
// Cloud text, every line pin and the switches file, and every Cloud file in scope must be accounted for.
// Any other byte difference fails. A later, deliberate change to a gateway file in Code is recorded under `divergedFromCloud`
// (the new blob id and the reason) in the pull request that makes it.
// Node runs this file directly, so only erasable syntax.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface Hunk { cloudStart: number; cloudCount: number; cloudSha256: string; code: string[]; cloud?: string[] }
export interface Adapted { cloudPath: string; cloudBlob: string; hunks: Hunk[]; codeBlob?: string }
/** Lines Code's hand-written helper repeats from a Cloud file; `pairs` are lines that differ only by a name (Code's text, Cloud's text), `cloudOnly` the Cloud lines that make that name the same value. */
export interface LinePin { cloudPath: string; cloudBlob: string; lines: string[]; absent: string[]; pairs?: Array<{ code: string; cloud: string }>; cloudOnly?: string[] }
export interface Manifest {
  cloudCommit: string;
  exact: Record<string, string>;
  adapted: Record<string, Adapted>;
  linePins: Record<string, LinePin>;
  switches: { cloudPath: string; cloudBlob: string; environments: Record<string, string> };
  declaredNotPorted: Record<string, { cloudBlob: string; why: string }>;
  divergedFromCloud: Record<string, { blob: string; reason: string }>;
}
export interface Report { failures: string[]; summary: string[] }

const HERE = dirname(fileURLToPath(import.meta.url));
export const MANIFEST_PATH = join(HERE, "gateway-catch-up-manifest.json");
/** The manifest, with each `blob:<40 hex>` written there read as the bare blob id. */
export function readManifest(path = MANIFEST_PATH): Manifest {
  return JSON.parse(readFileSync(path, "utf8"), (_key, value: unknown) => (typeof value === "string" && /^blob:[0-9a-f]{40}$/u.test(value) ? value.slice(5) : value)) as Manifest;
}
/** Every Cloud path this proof is about (a Cloud file in scope the manifest does not name fails the --cloud check). */
export const CLOUD_SCOPE = /^(packages\/model-gateway\/|environments\/model-gateway\/|contracts\/shared\/model-gateway|scripts\/[^/]*model-gateway[^/]*$|scripts\/agent-own-key-backfill[^/]*$|tests\/fixtures\/model-gateway(-bedrock|-prices)?\/|tsconfig\.base\.json$|tsconfig\.lint\/pkg-model-gateway)/u;

/** The blob id git gives these bytes. */
export function blobId(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function readBytes(root: string, path: string): Buffer | undefined {
  const full = join(root, path);
  return existsSync(full) && statSync(full).isFile() ? readFileSync(full) : undefined;
}

function walk(root: string, dir: string): string[] {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (name === "dist" || name === "node_modules" || name.endsWith(".tsbuildinfo")) return [];
    return statSync(join(root, rel)).isDirectory() ? walk(root, rel) : [rel];
  });
}

/** What a file's blob id must be: Cloud's, unless a later deliberate change is recorded for it. */
function expectedBlob(manifest: Manifest, path: string, cloudBlob: string): { want: string; diverged: boolean } {
  const diverged = manifest.divergedFromCloud[path];
  return diverged === undefined ? { want: cloudBlob, diverged: false } : { want: diverged.blob, diverged: true };
}

function checkExact(manifest: Manifest, root: string, report: Report): void {
  let equal = 0;
  for (const [path, cloudBlob] of Object.entries(manifest.exact)) {
    const bytes = readBytes(root, path);
    const { want, diverged } = expectedBlob(manifest, path, cloudBlob);
    if (bytes === undefined) report.failures.push(`exact: ${path} is missing`);
    else if (blobId(bytes) !== want) report.failures.push(`exact: ${path} differs from ${diverged ? "its recorded divergence" : `Cloud at ${manifest.cloudCommit.slice(0, 9)}`}`);
    else equal += 1;
  }
  const listed = new Set(Object.keys(manifest.exact));
  for (const path of walk(root, "packages/model-gateway")) if (!listed.has(path)) report.failures.push(`exact: ${path} is in Code's gateway package but not in the manifest`);
  report.summary.push(`exact: ${equal} of ${listed.size} files equal Cloud blob for blob`);
}

/** Cloud's text rebuilt from Code's file by putting each hunk's Cloud lines back; undefined when a hunk's Cloud side is not written down. */
export function rebuildCloud(codeText: string, hunks: Hunk[]): { text?: string; misplaced: string[] } {
  const lines = codeText.split("\n");
  const misplaced: string[] = [];
  let delta = 0;
  let embedded = true;
  for (const hunk of hunks) {
    const at = hunk.cloudStart - 1 + delta;
    if (lines.slice(at, at + hunk.code.length).join("\n") !== hunk.code.join("\n")) misplaced.push(`line ${hunk.cloudStart}`);
    if (hunk.cloud === undefined) {
      embedded = false;
      delta += hunk.code.length - hunk.cloudCount; // Code's lines stay in place: the rest of the file is still in Code's numbering
    } else {
      lines.splice(at, hunk.code.length, ...hunk.cloud); // Cloud's lines are back: the numbering up to here is Cloud's
    }
  }
  return embedded ? { text: lines.join("\n"), misplaced } : { misplaced };
}

function checkAdaptedFile(manifest: Manifest, root: string, path: string, entry: Adapted, report: Report): boolean {
  const bytes = readBytes(root, path);
  if (bytes === undefined) { report.failures.push(`adapted: ${path} is missing`); return false; }
  const { want, diverged } = expectedBlob(manifest, path, entry.codeBlob ?? entry.cloudBlob);
  if (diverged || entry.codeBlob !== undefined) {
    if (blobId(bytes) !== want) { report.failures.push(`adapted: ${path} differs from the pinned adapted file`); return false; }
  }
  if (diverged) return true;
  const rebuilt = rebuildCloud(bytes.toString("utf8"), entry.hunks);
  for (const spot of rebuilt.misplaced) report.failures.push(`adapted: ${path} no longer holds its declared replacement at ${spot}`);
  if (rebuilt.text !== undefined && blobId(Buffer.from(rebuilt.text, "utf8")) !== entry.cloudBlob) {
    report.failures.push(`adapted: ${path} differs from Cloud outside its declared replacements`);
    return false;
  }
  return rebuilt.misplaced.length === 0;
}

function checkAdapted(manifest: Manifest, root: string, report: Report): void {
  let ok = 0;
  let hunks = 0;
  for (const [path, entry] of Object.entries(manifest.adapted)) {
    if (checkAdaptedFile(manifest, root, path, entry, report)) ok += 1;
    hunks += entry.hunks.length;
  }
  report.summary.push(`adapted: ${ok} of ${Object.keys(manifest.adapted).length} files equal Cloud after ${hunks} declared replacements`);
}

function checkLinePins(manifest: Manifest, root: string, report: Report): void {
  for (const [path, pin] of Object.entries(manifest.linePins)) {
    const text = readBytes(root, path)?.toString("utf8");
    if (text === undefined) { report.failures.push(`linePins: ${path} is missing`); continue; }
    const lines = new Set(text.split("\n"));
    for (const line of [...pin.lines, ...(pin.pairs ?? []).map((pair) => pair.code)]) if (!lines.has(line)) report.failures.push(`linePins: ${path} lacks a line it repeats from Cloud's ${pin.cloudPath}: ${line.slice(0, 70)}`);
    for (const name of pin.absent) if (text.includes(name)) report.failures.push(`linePins: ${path} still carries ${name}, which Cloud's ${pin.cloudPath} dropped`);
  }
  report.summary.push(`linePins: ${Object.keys(manifest.linePins).length} hand-written files checked against Cloud's lines`);
}

/** The per-environment source kinds in Code's deploy inputs, read from the file the gateway's route tests read them from. */
async function checkSwitches(manifest: Manifest, root: string, report: Report): Promise<void> {
  const file = join(root, "infra/lib/model-gateway-switches.ts");
  if (!existsSync(file)) { report.failures.push("switches: infra/lib/model-gateway-switches.ts is missing"); return; }
  const loaded = (await import(pathToFileURL(file).href)) as { loadSwitches: () => { environments: Record<string, { aiSourceKinds: string }> } };
  const have = loaded.loadSwitches().environments;
  for (const [env, kinds] of Object.entries(manifest.switches.environments)) {
    if (have[env]?.aiSourceKinds !== kinds) report.failures.push(`switches: ${env} aiSourceKinds is ${String(have[env]?.aiSourceKinds)}, Cloud's row is ${kinds}`);
  }
  report.summary.push(`switches: ${Object.entries(manifest.switches.environments).map(([env, kinds]) => `${env}=${kinds}`).join(", ")}`);
}

function checkNotPorted(manifest: Manifest, root: string, report: Report): void {
  for (const path of Object.keys(manifest.declaredNotPorted)) if (existsSync(join(root, path))) report.failures.push(`declaredNotPorted: ${path} exists in Code but the manifest says it stays in Cloud`);
  report.summary.push(`declaredNotPorted: ${Object.keys(manifest.declaredNotPorted).length} Cloud files stay in Cloud (absent in Code)`);
}

function git(clone: string, ...args: string[]): string {
  return execFileSync("git", ["-C", clone, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function cloudTree(clone: string, commit: string): Map<string, string> {
  const tree = new Map<string, string>();
  for (const row of git(clone, "ls-tree", "-r", commit).split("\n")) {
    const [meta, path] = row.split("\t");
    if (meta !== undefined && path !== undefined) tree.set(path, meta.split(" ")[2] ?? "");
  }
  return tree;
}

function claimedCloudBlobs(manifest: Manifest): Map<string, string> {
  const claimed = new Map<string, string>();
  for (const [path, blob] of Object.entries(manifest.exact)) claimed.set(path, blob);
  for (const entry of Object.values(manifest.adapted)) claimed.set(entry.cloudPath, entry.cloudBlob);
  for (const [path, entry] of Object.entries(manifest.declaredNotPorted)) claimed.set(path, entry.cloudBlob);
  for (const pin of Object.values(manifest.linePins)) claimed.set(pin.cloudPath, pin.cloudBlob);
  claimed.set(manifest.switches.cloudPath, manifest.switches.cloudBlob);
  return claimed;
}

function checkAgainstCloud(manifest: Manifest, root: string, clone: string, report: Report): void {
  const commit = manifest.cloudCommit;
  const tree = cloudTree(clone, commit);
  const claimed = claimedCloudBlobs(manifest);
  for (const [path, blob] of claimed) if (tree.get(path) !== blob) report.failures.push(`cloud: ${path} is ${tree.get(path) ?? "absent"} at ${commit.slice(0, 9)}, the manifest says ${blob}`);
  for (const path of tree.keys()) if (CLOUD_SCOPE.test(path) && !claimed.has(path)) report.failures.push(`cloud: ${path} is a gateway file in Cloud the manifest does not account for`);
  checkHunksAgainstCloud(manifest, root, clone, report);
  checkPinsAgainstCloud(manifest, clone, report);
  report.summary.push(`cloud: ${claimed.size} Cloud paths read at ${commit.slice(0, 9)}; blob ids, hunks, line pins and switches match, and no gateway file there is unaccounted for`);
}

/** Cloud's own file with the declared hunks replaced by Code's lines must be Code's file. */
function checkHunksAgainstCloud(manifest: Manifest, root: string, clone: string, report: Report): void {
  for (const [path, entry] of Object.entries(manifest.adapted)) {
    const cloudLines = git(clone, "show", `${manifest.cloudCommit}:${entry.cloudPath}`).split("\n");
    const rebuilt = cloudLines.slice();
    for (const hunk of [...entry.hunks].reverse()) {
      const cloudSide = cloudLines.slice(hunk.cloudStart - 1, hunk.cloudStart - 1 + hunk.cloudCount).join("\n");
      if (sha256(cloudSide) !== hunk.cloudSha256) report.failures.push(`cloud: ${path} hunk at ${hunk.cloudStart} does not match Cloud's text`);
      if (hunk.cloud !== undefined && hunk.cloud.join("\n") !== cloudSide) report.failures.push(`cloud: ${path} hunk at ${hunk.cloudStart} is not the text written in the manifest`);
      rebuilt.splice(hunk.cloudStart - 1, hunk.cloudCount, ...hunk.code);
    }
    const code = readBytes(root, path)?.toString("utf8");
    if (code !== undefined && manifest.divergedFromCloud[path] === undefined && rebuilt.join("\n") !== code) report.failures.push(`cloud: ${path} is not Cloud's file with the declared hunks replaced`);
  }
}

function checkPinsAgainstCloud(manifest: Manifest, clone: string, report: Report): void {
  const commit = manifest.cloudCommit;
  for (const [path, pin] of Object.entries(manifest.linePins)) {
    const cloudWhole = git(clone, "show", `${commit}:${pin.cloudPath}`);
    const cloudLines = new Set(cloudWhole.split("\n"));
    for (const line of [...pin.lines, ...(pin.pairs ?? []).map((pair) => pair.cloud), ...(pin.cloudOnly ?? [])]) if (!cloudLines.has(line)) report.failures.push(`cloud: ${path} pins a line that is not in Cloud's ${pin.cloudPath}: ${line.slice(0, 70)}`);
    for (const name of pin.absent) if (cloudWhole.includes(name)) report.failures.push(`cloud: Cloud's ${pin.cloudPath} still carries ${name}`);
  }
  checkSwitchesAgainstCloud(manifest, clone, report);
}

function checkSwitchesAgainstCloud(manifest: Manifest, clone: string, report: Report): void {
  const row = JSON.parse(git(clone, "show", `${manifest.cloudCommit}:${manifest.switches.cloudPath}`)) as { environments: Record<string, { aiSourceKinds: string }> };
  for (const [env, kinds] of Object.entries(manifest.switches.environments)) if (row.environments[env]?.aiSourceKinds !== kinds) report.failures.push(`cloud: ${manifest.switches.cloudPath} ${env} aiSourceKinds is ${String(row.environments[env]?.aiSourceKinds)}`);
}

/** Runs every check on the tree at `root` (and, with `cloudClone`, on Cloud's tree too). */
export async function runProof(options: { root: string; cloudClone?: string; manifest?: Manifest }): Promise<Report> {
  const manifest = options.manifest ?? readManifest();
  const report: Report = { failures: [], summary: [`pinned Cloud commit ${manifest.cloudCommit}`] };
  checkExact(manifest, options.root, report);
  checkAdapted(manifest, options.root, report);
  checkLinePins(manifest, options.root, report);
  await checkSwitches(manifest, options.root, report);
  checkNotPorted(manifest, options.root, report);
  if (options.cloudClone !== undefined) checkAgainstCloud(manifest, options.root, options.cloudClone, report);
  return report;
}

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args[0] !== "check") { console.error("usage: node scripts/gateway-catch-up-proof.ts check [--root <dir>] [--cloud <clone>]"); return 2; }
  const root = resolve(option(args, "--root") ?? join(HERE, ".."));
  const cloud = option(args, "--cloud");
  const report = await runProof({ root, ...(cloud === undefined ? {} : { cloudClone: resolve(cloud) }) });
  for (const line of report.summary) console.log(`gateway catch-up proof: ${line}`);
  for (const failure of report.failures) console.log(`gateway catch-up proof: FAIL ${failure}`);
  console.log(report.failures.length === 0 ? "gateway catch-up proof: PASS" : `gateway catch-up proof: FAIL (${report.failures.length} differences)`);
  return report.failures.length === 0 ? 0 : 1;
}

if (process.argv[1]?.endsWith("gateway-catch-up-proof.ts")) process.exitCode = await main();
