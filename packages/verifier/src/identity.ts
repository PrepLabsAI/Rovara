import { createHash } from "node:crypto";
import { canonicalJson, type E2EExpectedCase } from "@agentx/contracts";

export const E2E_COMPILER_PROTOCOL = "trusted-e2e-compiler/v1" as const;
export const E2E_UPSTREAM_PACKAGE = "e2e" as const;
export const E2E_UPSTREAM_VERSION = "0.20.0" as const;
export const E2E_GENERATED_TEST_PATH = ".agentx/e2e/generated-contract.test.ts" as const;
export const E2E_GENERATED_CONFIG_PATH = "e2e.config.json" as const;
export const E2E_SELECTION_PACKET_PATH = ".agentx/e2e/selection-packet.json" as const;
export const E2E_UPSTREAM_ID_ALGORITHM = "e2e-0.20.0-test-id-result-id/v1" as const;
export const E2E_CANDIDATE_RESPONSE_SCOPE = "contained-candidate-process-response/v1" as const;
export const E2E_CANDIDATE_ADAPTER_VERSION = 1 as const;
export const E2E_FIXED_BOOTSTRAP_SHA256 = "a6565dab541b51f8777e59d24e58421de488b02228914ef794189b346c4b68ff" as const;
export const E2E_CANDIDATE_REQUEST_PROTOCOL = "contained-candidate-host-request/v1" as const;
export const E2E_CANDIDATE_APP_WIRE_PROTOCOL = "contained-candidate-app-wire/v1" as const;
export const E2E_SUPERVISOR_RPC_PROTOCOL = "trusted-supervisor-observation-rpc/v1" as const;
export const E2E_CANDIDATE_HOST_REQUEST_FIELDS = Object.freeze(["requestId", "input"] as const);
export const E2E_CANDIDATE_APP_WIRE_REQUEST_FIELDS = Object.freeze(["wireId", "input"] as const);
export const E2E_CANDIDATE_APP_WIRE_RESPONSE_FIELDS = Object.freeze(["wireId", "output"] as const);
export const E2E_CANDIDATE_RESPONSE_PROTOCOL = Object.freeze({ schemaVersion: "contained-candidate-process-response-adapter/v1", scope: E2E_CANDIDATE_RESPONSE_SCOPE, adapterVersion: E2E_CANDIDATE_ADAPTER_VERSION, fixedBootstrapSha256: E2E_FIXED_BOOTSTRAP_SHA256, requestProtocol: E2E_CANDIDATE_REQUEST_PROTOCOL, hostRequestFields: E2E_CANDIDATE_HOST_REQUEST_FIELDS, appWireProtocol: E2E_CANDIDATE_APP_WIRE_PROTOCOL, appWireRequestFields: E2E_CANDIDATE_APP_WIRE_REQUEST_FIELDS, appWireResponseFields: E2E_CANDIDATE_APP_WIRE_RESPONSE_FIELDS });

export type E2ECompiledFile = Readonly<{ path: string; sha256: string; byteLength: number; role: "test" | "config" | "selection-packet" }>;
export type E2ECompiledInventory = Readonly<{ schemaVersion: 1; compilerProtocol: typeof E2E_COMPILER_PROTOCOL; upstream: { package: typeof E2E_UPSTREAM_PACKAGE; version: typeof E2E_UPSTREAM_VERSION; idAlgorithm: typeof E2E_UPSTREAM_ID_ALGORITHM; configDigestAlgorithm: "e2e-0.20.0-sanitized-config/v1"; expectedConfigDigest: string }; files: readonly E2ECompiledFile[]; digest: string }>;

const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");
function encodeTitle(title: string): string {
  const bytes = new TextEncoder().encode(title.normalize("NFC"));
  return [...bytes].map((byte) => ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39) || byte === 0x2d || byte === 0x2e || byte === 0x5f || byte === 0x7e) ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join("");
}
export function upstreamE2ECaseIdentity(item: E2EExpectedCase, title: string): { upstreamTestId: string; upstreamResultId: string } {
  const path = E2E_GENERATED_TEST_PATH;
  const upstreamTestId = `${path}::${encodeTitle(title)}`;
  const upstreamResultId = sha256(canonicalJson({ testId: upstreamTestId, targetId: item.targetId, agent: item.agentId }));
  return { upstreamTestId, upstreamResultId };
}
export function contentDigest(value: unknown): string { return sha256(canonicalJson(value)); }

/** Pinned e2e@0.20.0 resolve.js projection for the fixed, no-engine P0 config emitted here. */
export function expectedE2EConfigDigest(rawConfig: { projectId: string; tests: readonly string[]; targets: readonly { name: string; platform: string }[]; workers: number; retries: number; timeout: number; cache: "off" }): string {
  const projection = { projectId: rawConfig.projectId, tests: rawConfig.tests, workers: rawConfig.workers, retries: rawConfig.retries, timeout: rawConfig.timeout, cache: rawConfig.cache,
    targets: rawConfig.targets.map(({ name, platform }) => ({ name, platform, app: {} })) };
  return sha256(canonicalJson(projection));
}

export function verifyE2ECompiledFileInventory(files: ReadonlyMap<string, string>, inventory: E2ECompiledInventory): void {
  const paths = [...files.keys()].sort();
  const entries = [...inventory.files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (paths.length !== entries.length || paths.some((path, index) => path !== entries[index]?.path)) throw new Error("generated file inventory path set changed");
  for (const item of entries) {
    const content = files.get(item.path);
    if (content === undefined || sha256(content) !== item.sha256 || Buffer.byteLength(content) !== item.byteLength) throw new Error(`generated file integrity check failed: ${item.path}`);
  }
  const body = { schemaVersion: inventory.schemaVersion, compilerProtocol: inventory.compilerProtocol, upstream: inventory.upstream, files: inventory.files };
  if (sha256(canonicalJson(body)) !== inventory.digest) throw new Error("generated file inventory digest changed");
}
