import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson } from "@agentx/contracts";
import type { E2ECompiledApplicationSuite, E2EApplicationCompiledShard } from "./application-scenarios.js";
import { E2E_APPLICATION_DECLARATION_PATH, E2E_APPLICATION_GENERATED_CONFIG_PATH, E2E_APPLICATION_SELECTION_PACKET_PATH } from "./application-templates.js";

export const E2E_APPLICATION_RUNTIME_ASSET_VERSION = "application-runtime-v1" as const;
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export type E2EApplicationRuntimeAssets = Readonly<{ version: typeof E2E_APPLICATION_RUNTIME_ASSET_VERSION; launchId: string;
  shard: E2EApplicationCompiledShard; ownedDirectory: string; configPath: string; capturePath: string; reporterPath: string;
  assetDigests: Readonly<Record<string, string>>; inventoryDigest: string }>;

function safeRelative(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !path.includes("\0")
    && path.normalize("NFC") === path && path.split("/").every((part) => part && part !== "." && part !== "..");
}
async function assertDirectory(path: string, owner = true): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path || (owner && typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error("application runtime directory is not an owned canonical directory");
}
async function writeOwned(path: string, data: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(data); } finally { await handle.close(); }
}
function reporterSource(launchId: string): string {
  return `import { openSync, writeSync, closeSync, constants } from "node:fs";\nimport { fileURLToPath } from "node:url";\nconst capturePath=fileURLToPath(new URL(${JSON.stringify(`./.agentx/e2e/run-start-${launchId}.jsonl`)},import.meta.url));const challenge=${JSON.stringify(launchId)};let seen=false;\nexport const reporter=Object.freeze({name:"agentx-application-first-party-reporter/v1",onEvent(event){if(event.type!=="run-started")return;if(seen)throw new Error("duplicate application run start");seen=true;const row={schemaVersion:"e2e-run-start-capture/v1",challenge,runId:event.runId,seq:event.seq,at:event.at};const body=Buffer.from(JSON.stringify(row)+"\\n");const fd=openSync(capturePath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);try{let offset=0;while(offset<body.byteLength){const written=writeSync(fd,body,offset);if(written<=0)throw new Error("short application run-start capture write");offset+=written}}finally{closeSync(fd)}}});\n`;
}
export function expectedE2EApplicationReporterDigest(launchId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(launchId)) throw new TypeError("application launch challenge must be a UUID");
  return sha(reporterSource(launchId));
}
export async function createE2EApplicationRuntimeAssets(input: { compiled: E2ECompiledApplicationSuite; shardId: string; launchId?: string; ownedDirectory: string }): Promise<E2EApplicationRuntimeAssets> {
  if (!input.compiled || input.compiled.protocol !== "trusted-e2e-application/v1") throw new TypeError("compiled application suite is invalid");
  const compiledShards: readonly E2EApplicationCompiledShard[] = input.compiled.shards;
  if (!Array.isArray(input.compiled.shards)) throw new TypeError("compiled application shard inventory is invalid");
  const shard = compiledShards.find((candidate) => candidate.shardId === input.shardId);
  if (!shard || shard.expectedCases.length < 1 || shard.expectedCases.length > 64) throw new Error("application runtime shard is absent or outside its case bound");
  const groupRow = input.compiled.inventory.shards.find((item) => item.shardId === shard.shardId);
  if (!groupRow || groupRow.targetId !== shard.targetId || groupRow.inventoryDigest !== shard.inventory.digest
    || groupRow.expectedConfigDigest !== shard.expectedConfigDigest || canonicalJson(groupRow.expectedCaseIds) !== canonicalJson(shard.expectedCases.map((item) => item.caseId))) throw new Error("application shard differs from its immutable group inventory");
  const { digest, ...inventoryBody } = shard.inventory;
  if (sha(canonicalJson(inventoryBody)) !== digest || shard.inventory.upstream.version !== "0.20.0" || shard.inventory.upstream.expectedConfigDigest !== shard.expectedConfigDigest) throw new Error("application shard inventory digest or runner identity is invalid");
  for (const file of shard.inventory.files) {
    const content = shard.files.get(file.path);
    if (!content || Buffer.byteLength(content) !== file.byteLength || sha(content) !== file.sha256 || !safeRelative(file.path)) throw new Error("compiled application file is missing, altered, or outside its fixed inventory");
  }
  if (shard.files.size !== shard.inventory.files.length || !shard.files.has(E2E_APPLICATION_GENERATED_CONFIG_PATH) || !shard.files.has(E2E_APPLICATION_DECLARATION_PATH) || !shard.files.has(E2E_APPLICATION_SELECTION_PACKET_PATH)) throw new Error("compiled application shard does not contain every fixed runtime file");
  const launchId = input.launchId ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(launchId)) throw new TypeError("application launch challenge must be a UUID");
  const ownedDirectory = resolve(input.ownedDirectory);
  if (!isAbsolute(input.ownedDirectory) || ownedDirectory !== input.ownedDirectory) throw new TypeError("application runtime root must be canonical and absolute");
  await mkdir(ownedDirectory, { mode: 0o700 });
  await assertDirectory(ownedDirectory);
  const appPrivate = join(ownedDirectory, ".agentx", "e2e");
  await mkdir(join(ownedDirectory, ".agentx"), { mode: 0o700 });
  await mkdir(appPrivate, { mode: 0o700 });
  await assertDirectory(join(ownedDirectory, ".agentx")); await assertDirectory(appPrivate);
  for (const [path, content] of shard.files) await writeOwned(join(ownedDirectory, ...path.split("/")), content);
  const capturePath = join(appPrivate, `run-start-${launchId}.jsonl`);
  const reporterPath = join(ownedDirectory, "application-first-party-reporter.mjs");
  const source = reporterSource(launchId);
  await writeOwned(reporterPath, source);
  const verifyHandle = await open(reporterPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try {
    const info = await verifyHandle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid())
      || await realpath(reporterPath) !== reporterPath) throw new Error("application reporter asset is not a private owned file");
    bytes = await verifyHandle.readFile();
    if (bytes.byteLength !== info.size) throw new Error("application reporter asset changed while being verified");
  } finally { await verifyHandle.close(); }
  if (sha(bytes) !== sha(source)) throw new Error("application reporter materialization digest changed");
  const pathRelative = relative(ownedDirectory, reporterPath);
  if (!pathRelative || pathRelative.startsWith(`..${sep}`) || pathRelative === "..") throw new Error("application reporter path escaped its owned root");
  return Object.freeze({ version: E2E_APPLICATION_RUNTIME_ASSET_VERSION, launchId, shard, ownedDirectory,
    configPath: join(ownedDirectory, E2E_APPLICATION_GENERATED_CONFIG_PATH), capturePath, reporterPath,
    assetDigests: Object.freeze({ reporter: sha(bytes), compilerInventory: shard.inventory.digest }), inventoryDigest: shard.inventory.digest });
}
