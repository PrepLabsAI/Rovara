import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, dirname, resolve } from "node:path";
import { canonicalJson } from "@agentx/contracts";
import { expectedE2EConfigDigest, verifyE2ECompiledFileInventory } from "./identity.js";
import type { E2ECompiledSuite } from "./scenarios.js";

export const E2E_RUNTIME_ASSET_VERSION = "managed-e2e-runtime-assets/v1" as const;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export type E2ERuntimeAssets = Readonly<{
  version: typeof E2E_RUNTIME_ASSET_VERSION;
  launchId: string;
  compilerFiles: ReadonlyMap<string, string>;
  launchProjection: Readonly<Record<string, unknown>>;
  launchConfigDigest: string;
  assets: Readonly<Record<string, string>>;
  assetDigests: Readonly<Record<string, string>>;
}>;

export type E2EFirstPartyCapture = Readonly<{ schemaVersion: "e2e-run-start-capture/v1"; challenge: string; runId: string; seq: number; at: string }>;
export type E2EFirstPartyCaptureResult = Readonly<{ status: "valid"; capture: E2EFirstPartyCapture }> | Readonly<{ status: "missing" | "duplicate" | "invalid"; capture: null }>;

export function parseE2EFirstPartyCapture(bytes: Uint8Array, launchId: string): E2EFirstPartyCaptureResult {
  if (bytes.byteLength === 0) return { status: "missing", capture: null };
  if (bytes.byteLength > 16_384) return { status: "invalid", capture: null };
  let lines: string[];
  try { lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\n").filter((line) => line.length > 0); }
  catch { return { status: "invalid", capture: null }; }
  if (lines.length > 1) return { status: "duplicate", capture: null };
  if (lines.length !== 1) return { status: "missing", capture: null };
  try {
    const value: unknown = JSON.parse(lines[0]!);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "invalid", capture: null };
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "at,challenge,runId,schemaVersion,seq" || record.schemaVersion !== "e2e-run-start-capture/v1" || record.challenge !== launchId || typeof record.runId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.runId) || typeof record.seq !== "number" || !Number.isSafeInteger(record.seq) || record.seq < 1 || typeof record.at !== "string" || !Number.isFinite(Date.parse(record.at))) return { status: "invalid", capture: null };
    return { status: "valid", capture: record as E2EFirstPartyCapture };
  } catch { return { status: "invalid", capture: null }; }
}

export function createE2ERuntimeAssets(
  compiledInput: E2ECompiledSuite,
  pathsInput: Readonly<{ launchId: string; capturePath: string; workerBridgePath: string }>,
): E2ERuntimeAssets {
  const compiled = compiledInput;
  if (!compiled || !(compiled.files instanceof Map) || !compiled.inventory || typeof compiled.expectedConfigDigest !== "string") throw new TypeError("compiled E2E suite is invalid");
  verifyE2ECompiledFileInventory(compiled.files, compiled.inventory);
  const rawConfig: string | undefined = compiled.files.get("e2e.config.json") as string | undefined;
  if (!rawConfig) throw new TypeError("compiler config asset is missing");
  const configValue: unknown = JSON.parse(rawConfig) as unknown;
  if (!configValue || typeof configValue !== "object" || Array.isArray(configValue)) throw new TypeError("compiler config is invalid");
  const config = configValue as Record<string, unknown>;
  if (config.projectId !== "rovara-contract-p0" || !Array.isArray(config.tests) || !Array.isArray(config.targets) || config.workers !== 1 || config.retries !== 0 || config.cache !== "off" || Object.hasOwn(config, "reporters")) throw new TypeError("compiler config does not match the fixed P0 launch contract");
  const base = config as unknown as { projectId: string; tests: readonly string[]; targets: readonly { name: string; platform: string }[]; workers: number; retries: number; timeout: number; cache: "off" };
  const compilerDigest = expectedE2EConfigDigest(base);
  if (compilerDigest !== compiled.expectedConfigDigest) throw new TypeError("compiler config digest does not match immutable inventory");
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(pathsInput.launchId) || !isAbsolute(pathsInput.capturePath) || !isAbsolute(pathsInput.workerBridgePath) || resolve(pathsInput.capturePath) !== pathsInput.capturePath || resolve(pathsInput.workerBridgePath) !== pathsInput.workerBridgePath || dirname(pathsInput.capturePath) !== dirname(pathsInput.workerBridgePath) || pathsInput.capturePath === pathsInput.workerBridgePath) throw new TypeError("runtime asset paths must be distinct canonical files in one owned directory");

  const launchProjection = Object.freeze({
    projectId: base.projectId,
    tests: [...base.tests],
    workers: base.workers,
    retries: base.retries,
    timeout: base.timeout,
    cache: base.cache,
    targets: base.targets.map(({ name, platform }) => ({ name, platform, app: {} })),
    reporters: [],
  });
  const launchConfigDigest = hash(canonicalJson(launchProjection));
  const reporterSource = `import { openSync, writeSync, closeSync, constants } from "node:fs";\nconst capturePath = ${JSON.stringify(pathsInput.capturePath)};\nconst challenge = ${JSON.stringify(pathsInput.launchId)};\nexport const reporter = Object.freeze({ name: "agentx-first-party-run-start/v1", onEvent(event) { if (event.type !== "run-started") return; const body = JSON.stringify({ schemaVersion: "e2e-run-start-capture/v1", challenge, runId: event.runId, seq: event.seq, at: event.at }) + "\\n"; const fd = openSync(capturePath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600); try { writeSync(fd, body); } finally { closeSync(fd); } } });\n`;
  const runtimeConfigSource = `import { reporter } from "./first-party-reporter.mjs";\nimport config from "./compiler-config.json" with { type: "json" };\nexport default Object.freeze({ ...config, reporters: [reporter] });\n`;
  const workerBridgeSource = String.raw`import { createConnection } from "node:net";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
const socketPath = process.env.AGENTX_E2E_SOCKET;
const capability = process.env.AGENTX_E2E_WORKER_CAPABILITY;
if (!socketPath || !isAbsolute(socketPath) || !capability || !/^[a-f0-9]{64,}$/.test(capability)) throw new Error("trusted E2E worker session is unavailable");
let sequence = 0;
const workerId = randomBytes(12).toString("hex");
let workerTokenPromise;
const transact = async (value) => {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body, "utf8") > 262144) throw new Error("trusted E2E worker frame exceeds limit");
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let received = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(value); };
    socket.once("error", (error) => finish(error));
    socket.once("connect", () => socket.end(body + "\n"));
    socket.on("data", (chunk) => { received = Buffer.concat([received, chunk]); if (received.byteLength > 262144) finish(new Error("trusted E2E worker response exceeds limit")); });
    socket.once("end", () => {
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(received);
        const parsed = JSON.parse(text);
        if (!parsed || parsed.schemaVersion !== "trusted-worker-response/v1" || typeof parsed.ok !== "boolean") throw new Error("trusted E2E worker response is malformed");
        if (!parsed.ok) throw new Error(typeof parsed.error === "string" ? parsed.error : "trusted E2E observation failed");
        finish(undefined, parsed.value);
      } catch (error) { finish(error); }
    });
  });
};
const workerToken = async () => {
  workerTokenPromise ??= transact({ schemaVersion: "trusted-worker-observation/v1", kind: "register", capability, workerId }).then((value) => {
    if (!value || typeof value.workerToken !== "string" || !/^[a-f0-9]{64}$/.test(value.workerToken)) throw new Error("trusted E2E worker registration response is invalid");
    return value.workerToken;
  });
  return await workerTokenPromise;
};
const request = async (payload) => transact({ schemaVersion: "trusted-worker-observation/v1", workerId, workerToken: await workerToken(), sequence: ++sequence, payload });
const sdkPath = createRequire(process.cwd() + "/package.json").resolve("e2e");
const { expect } = await import(pathToFileURL(sdkPath).href);
const projectModuleExports = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("module export inventory is malformed");
  const inventory = value;
  if (inventory.protocol !== "registered-module-export-inventory/v1" || !Array.isArray(inventory.exports) || Object.keys(inventory).sort().join(",") !== "exports,protocol") throw new Error("module export inventory protocol is unsupported");
  const names = inventory.exports.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).sort().join(",") !== "kind,name" || !/^[A-Za-z_$][A-Za-z0-9_$]{0,254}$/.test(row.name) || !["callable", "value", "type"].includes(row.kind)) throw new Error("module export inventory row is malformed");
    return row.name;
  });
  if (new Set(names).size !== names.length || names.length > 256) throw new Error("module export inventory names are ambiguous or oversized");
  return names.sort();
};
const assertion = async (record, response) => {
  const item = record && record.assertion;
  if (!item || !["json", "state"].includes(item.kind)) throw new Error("approved E2E assertion kind is unsupported");
  if ((item.kind === "json" && item.responseId !== "result") || (item.kind === "state" && !["result", "module-export-names"].includes(item.probeId))) throw new Error("approved E2E assertion selector is unsupported");
  const projectedResponse = item.kind === "state" && item.probeId === "module-export-names" ? projectModuleExports(response) : response;
  await expect(projectedResponse).toEqual(item.equals);
};
const observation = Object.freeze({ request, inspectContract: request, assertion });
Object.defineProperty(globalThis, "__agentxE2EObservation", { configurable: false, enumerable: false, writable: false, value: observation });
`;
  const assets = Object.freeze({
    "runtime-config.mjs": runtimeConfigSource,
    "first-party-reporter.mjs": reporterSource,
    "worker-bridge.mjs": workerBridgeSource,
    "compiler-config.json": rawConfig,
    "launch-id.txt": `${pathsInput.launchId}\n`,
    "asset-version.txt": `${E2E_RUNTIME_ASSET_VERSION}\n`,
  });
  const assetDigests = Object.freeze(Object.fromEntries(Object.entries(assets).map(([name, content]) => [name, hash(content)])));
  return Object.freeze({ version: E2E_RUNTIME_ASSET_VERSION, launchId: pathsInput.launchId, compilerFiles: new Map(compiled.files), launchProjection, launchConfigDigest, assets, assetDigests });
}

export function createE2ERuntimeLaunchId(): string { return randomUUID(); }
