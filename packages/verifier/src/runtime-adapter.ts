import { createHash } from "node:crypto";
import { canonicalJson } from "@agentx/contracts";
import type { E2ESourceSnapshot } from "@agentx/contracts";
import type { E2EMockSpec } from "@agentx/contracts";
import { inspectE2EPortableSource } from "@agentx/contracts";
import type { E2ECompiledSuite } from "./scenarios.js";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export type E2EAppAdapterPacket = Readonly<{
  status: "ready" | "unsupported";
  reason: string | null;
  packet: Readonly<{ schemaVersion: 1; entry: string; exportName: "default"; files: readonly Readonly<{ path: string; bytes: Uint8Array; sha256: string }>[] }> | null;
  originalSourceDigest: string;
  adapterDigest: string | null;
  declaredMockComponentIds: readonly string[];
}>;

/** Build a fixed .mjs entry around unchanged, snapshot-bound ordinary JS candidate modules. */
export function createE2EAppAdapterPacket(input: Readonly<{
  compiled: E2ECompiledSuite;
  snapshot: E2ESourceSnapshot;
  caseId: string;
  mode: "feature" | "inspect";
  mockSpecs?: readonly E2EMockSpec[];
}>): E2EAppAdapterPacket {
  const binding = input.compiled.caseBindings.get(input.caseId);
  const registration = input.compiled.bundle.scenarios.find((scenario) => scenario.scenarioId === input.compiled.expectedCases.find((item) => item.caseId === input.caseId)?.scenarioId);
  if (!binding || !registration) throw new Error("adapter case is absent from compiled source-bound suite");
  const sourceRefs = new Set(input.snapshot.sources.map((item) => item.path));
  const registeredManifestPath = binding.manifestPath;
  if (!/^[a-zA-Z0-9._/-]+$/.test(registeredManifestPath) || registeredManifestPath.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("registered application identity is not an exact candidate package path");
  const moduleMatches = input.snapshot.sources.flatMap((manifest) => {
    if (manifest.path !== registeredManifestPath || manifest.kind !== "blob") return [];
    try {
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifest.bytes)) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
      const exports = (parsed as Record<string, unknown>).exports;
      const target = exports && typeof exports === "object" && !Array.isArray(exports) ? (exports as Record<string, unknown>)[binding.packageExportSubpath] : undefined;
      if (target !== binding.moduleSpecifier) return [];
      if (manifest.path !== binding.manifestPath) return [];
      const base = manifest.path === "package.json" ? "" : manifest.path.slice(0, -"package.json".length);
      const relativeTarget = binding.moduleSpecifier.slice(2);
      const modulePath = `${base}${relativeTarget}`.replace(/^\.\//, "");
      return [{ modulePath, manifestPath: manifest.path }];
    } catch { return []; }
  });
  const modulePath = moduleMatches.length === 1 ? moduleMatches[0]!.modulePath : "";
  const manifestPath = moduleMatches.length === 1 ? moduleMatches[0]!.manifestPath : "";
  if (!modulePath || !sourceRefs.has(modulePath) || !binding.packageExportSubpath || !binding.moduleSpecifier.startsWith("./") || !/^[a-zA-Z0-9._/-]+$/.test(modulePath) || modulePath.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`adapter source module is not an exact verified snapshot path (application=${binding.applicationId}, manifestMatches=${moduleMatches.length}, modulePath=${modulePath || "unresolved"}, sourcePresent=${sourceRefs.has(modulePath)})`);
  const moduleSource = input.snapshot.sources.find((source) => source.path === modulePath);
  if (!moduleSource || moduleSource.kind !== "blob" || !/\.(?:mjs|js)$/.test(modulePath)) {
    return Object.freeze({ status: "unsupported", reason: "candidate module is not an unchanged ordinary JavaScript blob supported by the fixed Node adapter", packet: null, originalSourceDigest: moduleSource?.sha256 ?? "unavailable", adapterDigest: null, declaredMockComponentIds: [] });
  }
  const refs = new Set([modulePath, manifestPath]);
  const appRoot = manifestPath.includes("/") ? manifestPath.slice(0, manifestPath.lastIndexOf("/") + 1) : "";
  for (const source of input.snapshot.sources) {
    if (source.path.startsWith("__agentx_adapter__/") || /(^|\/)(?:\.git|\.aws|\.ssh|credentials?|secrets?)(?:\/|$)/i.test(source.path) || /(^|\/)(?:\.env(?:\.|$)|[^/]*(?:token|secret|password|credential|api[-_]?key)[^/]*)$/i.test(source.path)) continue;
    if (source.kind === "blob" && source.path.startsWith(appRoot) && /(?:\.json|\.js|\.mjs|\.cjs)$/.test(source.path)) refs.add(source.path);
  }
  const selector = binding.callableSelector;
  const inspection = input.mode === "inspect";
  if (inspection && selector !== null || !inspection && selector === null) throw new Error("adapter mode does not match the immutable registered operation selector");
  const mocks = (input.mockSpecs ?? []).filter((mock) => mock.kind === "api" && mock.requestedTargetId === binding.requestedTargetId);
  if (mocks.some((mock) => !mock.apiFixture || mock.sourceRefs.length !== 1 || !sourceRefs.has(mock.sourceRefs[0]!.path) || input.snapshot.sources.find((source) => source.path === mock.sourceRefs[0]!.path)?.sha256 !== mock.sourceRefs[0]!.sha256)) throw new Error("declared API mock fixture is not bound to its exact candidate source blob");
  const sourceInspection = inspectE2EPortableSource(new TextDecoder("utf-8", { fatal: true }).decode(moduleSource.bytes), modulePath);
  if (!sourceInspection.parseable) throw new Error("verified candidate module source cannot be inspected by the accepted portable source protocol");
  if (sourceInspection.exports.some((item) => item.kind === "unresolved")) throw new Error("source export inventory contains unresolved re-exports");
  if (input.snapshot.sources.some((source) => source.path === "__agentx_adapter__/entry.mjs")) throw new Error("candidate source collides with the reserved fixed adapter entry path");
  const adapterImport = `../${modulePath}`;
  const declaredInventory = sourceInspection.exports.map((item) => ({ name: item.name, kind: item.kind === "data" ? "value" : item.kind }));
  const adapterSource = inspection
    ? `import * as registeredModule from ${JSON.stringify(adapterImport)};\nconst declaredInventory = ${JSON.stringify(declaredInventory)};\nexport default async function inspect() { const actualNames = Object.keys(registeredModule).sort(); const declaredNames = declaredInventory.map((item) => item.name).sort(); if (JSON.stringify(actualNames) !== JSON.stringify(declaredNames)) throw new Error("runtime module export inventory differs from verified source inventory"); return { protocol: "registered-module-export-inventory/v1", exports: declaredInventory }; }\n`
    : `import * as registeredModule from ${JSON.stringify(adapterImport)};\nconst selector = ${JSON.stringify(selector)};\nconst mockSpecs = ${JSON.stringify(mocks)};\nexport default async function invoke(input) { const callable = selector.kind === "default" ? registeredModule.default : registeredModule[selector.exportName]; if (typeof callable !== "function") throw new Error("registered callable export is unavailable"); const originalFetch = globalThis.fetch; globalThis.fetch = async (resource, init = {}) => { if (!(typeof resource === "string" || resource instanceof URL) || init.body !== undefined || init.headers !== undefined) throw new Error("request semantics are outside the declared GET mock profile"); const url = new URL(String(resource), "http://agentx-mock.invalid"); const method = String(init.method ?? "GET").toUpperCase(); const fixture = mockSpecs.find((mock) => mock.apiFixture?.method === method && mock.apiFixture.path === url.pathname); if (url.origin !== "http://agentx-mock.invalid" || !fixture) throw new Error("network request is outside the declared source-backed mock inventory"); const api = fixture.apiFixture; const expectedValue = input && Object.hasOwn(input, api.inputField) ? input[api.inputField] : undefined; const value = url.searchParams.get(api.inputField); if (typeof expectedValue !== "string" || value !== expectedValue) throw new Error("candidate request does not preserve the approved input-to-request binding"); const variant = api.variants.find((item) => item.inputValue === value); if (!variant) throw new Error("request does not select one declared source-backed API mock variant"); return new Response(JSON.stringify(variant.body), { status: variant.status, headers: { "content-type": "application/json" } }); }; try { return await callable(input); } finally { globalThis.fetch = originalFetch; } }\n`;
  const entry = "__agentx_adapter__/entry.mjs";
  const adapterBytes = Buffer.from(adapterSource, "utf8");
  const files = [...input.snapshot.sources.filter((source) => refs.has(source.path) && source.kind === "blob").map((source) => ({ path: source.path, bytes: new Uint8Array(source.bytes), sha256: source.sha256 })), { path: entry, bytes: new Uint8Array(adapterBytes), sha256: sha(adapterBytes) }];
  const originalSourceDigest = sha(Buffer.from(canonicalJson(files.filter((file) => file.path !== entry).map((file) => ({ path: file.path, sha256: file.sha256 }))), "utf8"));
  return Object.freeze({ status: "ready", reason: null, packet: Object.freeze({ schemaVersion: 1, entry, exportName: "default", files: Object.freeze(files) }), originalSourceDigest, adapterDigest: sha(adapterBytes), declaredMockComponentIds: mocks.map((mock) => mock.componentId).sort() });
}
