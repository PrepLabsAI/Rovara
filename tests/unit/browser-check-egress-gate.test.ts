// Browser testing, egress gate (fail closed): a browser or API check starts only on a runtime whose registered probe manifest lists every egress probe, the private-network one included.
// The gate sits in the ONE reader every path goes through; a census lists the paths and the files allowed to read runtime rows at all, so a new reader cannot be added around it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { SANDBOX_EGRESS_PROBE_IDS } from "../../packages/contracts/src/index.js";
import { e2eRegisteredRuntimeKey, readProjectAdmittedE2ERuntimes, readProjectReadyE2ERuntimes, readReadyE2ERuntimeProfiles } from "../../packages/broker/src/aws/e2e-runtime-readiness.js";
import { readyProfilesFor, sandboxAvailableFor } from "../../packages/broker/src/core/setup-agent/browser-testing-sandbox.js";
import { BROWSER_TESTING_WORDS } from "../../packages/broker/src/core/setup-agent/browser-testing-state.js";
import { FAKE_COMPANY } from "../support/core-host-fakes.js";
import { BT, browserGet, browserPost, browserWorld } from "../support/browser-testing-world.js";
import { NOW, PROFILE, binding, inferredSnapshot, registeredProbeIds, shaCanonical, webApiRow } from "../support/e2e-application-plan-fixtures.js";

const uuid = () => crypto.randomUUID();

/** A READY row of this kind listing exactly these probes (split into positive and negative; the digest recomputed so the row still parses whole). */
function rowListing(kind: "web" | "api", probeIds: readonly string[]) {
  const base = webApiRow(kind);
  const { manifestDigest: _digest, ...content } = base.probeManifest;
  void _digest;
  const body = { ...content, positiveProbeIds: probeIds.slice(0, 2), negativeProbeIds: probeIds.slice(2) };
  return webApiRow(kind, { probeManifest: { ...body, manifestDigest: shaCanonical(body) } });
}
const listedBy = (kind: "web" | "api") => { const ids = registeredProbeIds(kind); return [...ids.positiveProbeIds, ...ids.negativeProbeIds]; };
const without = (ids: readonly string[], missing: string) => ids.filter((id) => id !== missing);

/** A row reader over the catalog rows a test seeds (the keys are Cloud's, as the real reader reads them). */
function catalog(rows: Partial<Record<"web" | "api", ReturnType<typeof webApiRow>>>) {
  const stored = new Map<string, unknown>();
  for (const [kind, row] of Object.entries(rows) as Array<["web" | "api", ReturnType<typeof webApiRow>]>) {
    const key = e2eRegisteredRuntimeKey("catalog", PROFILE, kind);
    stored.set(`${key.pk}|${key.sk}`, { ...key, ...row });
  }
  const read = async (key: { pk: string; sk: string }) => stored.get(`${key.pk}|${key.sk}`);
  const common = { runtimeCatalogId: "catalog", profileId: PROFILE, now: NOW, read };
  return {
    profiles: async () => (await readReadyE2ERuntimeProfiles(common)).map((item) => item.kind).sort(),
    ready: async () => (await readProjectReadyE2ERuntimes({ ...common, binding })).map((item) => item.kind).sort(),
    admitted: async () => (await readProjectAdmittedE2ERuntimes({ ...common, binding })).map((item) => item.capabilities.kind).sort(),
  };
}
const readerNames = ["profiles", "ready", "admitted"] as const;

describe("every reader a browser or API check goes through is gated on the egress probes", () => {
  it("a qualification that listed every probe is READY on each reader, both kinds", async () => {
    const c = catalog({ web: rowListing("web", listedBy("web")), api: rowListing("api", listedBy("api")) });
    for (const reader of readerNames) expect(await c[reader](), reader).toEqual(["api", "web"]);
  });

  it.each([...SANDBOX_EGRESS_PROBE_IDS])("a runtime whose rows lack %s is READY on no reader: no browser or API check can be proposed, planned, approved or admitted on it", async (missing) => {
    const c = catalog({ web: rowListing("web", without(listedBy("web"), missing)), api: rowListing("api", without(listedBy("api"), missing)) });
    for (const reader of readerNames) expect(await c[reader](), reader).toEqual([]);
  });

  it("a runtime qualified before the private-network probe existed (every other egress probe listed, that one not) is stale, and the page-level seams say so too", async () => {
    const missing = "app-private-denial-v1";
    const c = catalog({ web: rowListing("web", without(listedBy("web"), missing)), api: rowListing("api", without(listedBy("api"), missing)) });
    for (const reader of readerNames) expect(await c[reader](), reader).toEqual([]);
  });

  it("is judged row by row: a stale web row does not take a current api row down with it, and the reverse", async () => {
    const stale = "app-private-denial-v1";
    const staleWeb = catalog({ web: rowListing("web", without(listedBy("web"), stale)), api: rowListing("api", listedBy("api")) });
    const staleApi = catalog({ web: rowListing("web", listedBy("web")), api: rowListing("api", without(listedBy("api"), stale)) });
    for (const reader of readerNames) { expect(await staleWeb[reader](), reader).toEqual(["api"]); expect(await staleApi[reader](), reader).toEqual(["web"]); }
  });

  it("a row with no probes of the egress kind at all (the shape the registrar wrote before this gate) is not READY", async () => {
    const c = catalog({ web: rowListing("web", ["web-csv-positive-v1", "web-csv-negative-v1", "web-egress-denial-v1"]), api: rowListing("api", ["api-state-positive-v1", "api-tenant-negative-v1", "api-egress-denial-v1"]) });
    for (const reader of readerNames) expect(await c[reader](), reader).toEqual([]);
  });
});

describe("the core's browser testing seams read the same gate", () => {
  async function company(rows: Parameters<typeof catalog>[0]) {
    const w = await browserWorld({ snapshot: () => inferredSnapshot, sandboxFrom: (store, companyId, project) => sandboxAvailableFor({ store, companyId, project, runtimeCatalogId: "catalog", now: NOW }, 1) });
    for (const [kind, row] of Object.entries(rows) as Array<["web" | "api", ReturnType<typeof webApiRow>]>) await w.world.store.put({ item: { ...e2eRegisteredRuntimeKey("catalog", PROFILE, kind), ...row } as never });
    return w;
  }
  const seam = (w: Awaited<ReturnType<typeof company>>) => ({ store: w.world.store, companyId: FAKE_COMPANY, project: "payments", runtimeCatalogId: "catalog", now: NOW });

  it("an unqualified runtime: the sandbox is unavailable, no profile can be named, the page serves the existing real fault and the check route refuses with the existing sentence", async () => {
    const stale = "app-private-denial-v1";
    const w = await company({ web: rowListing("web", without(listedBy("web"), stale)), api: rowListing("api", without(listedBy("api"), stale)) });
    expect(await sandboxAvailableFor(seam(w), 1)).toBe(false);
    expect(await readyProfilesFor(seam(w), 1)).toEqual([]);
    await w.refresh();
    const view = (await w.call(browserGet(), w.owner)).body;
    expect(view).toMatchObject({ sandboxAvailable: false, faults: ["sandbox-unavailable"] });
    const refused = await w.call(browserPost("check", { requestId: uuid(), expectedDraftRevision: 1 }, BT), w.owner);
    expect(refused.status).toBe(503);
    expect(refused.body["error"]).toMatchObject({ message: BROWSER_TESTING_WORDS.sandboxUnavailable });
  });

  it("a qualified runtime: the sandbox is available, the profiles are named, the page has no fault and the check runs", async () => {
    const w = await company({ web: rowListing("web", listedBy("web")), api: rowListing("api", listedBy("api")) });
    expect(await sandboxAvailableFor(seam(w), 1)).toBe(true);
    expect(await readyProfilesFor(seam(w), 1)).toEqual([{ kind: "web", profileId: PROFILE }, { kind: "api", profileId: PROFILE }]);
    await w.refresh();
    expect((await w.call(browserGet(), w.owner)).body).toMatchObject({ sandboxAvailable: true, faults: [] });
    expect((await w.call(browserPost("check", { requestId: uuid(), expectedDraftRevision: 1 }, BT), w.owner)).status).toBe(200);
  });

  it("a project with a runtime binding and no runtime row at all is unavailable too", async () => {
    expect(await sandboxAvailableFor(seam(await company({})), 1)).toBe(false);
  });
});

// ---- the census

const root = new URL("../../packages/", import.meta.url).pathname;
function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    if (name === "node_modules" || name === "dist" || name === "build") return [];
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : name.endsWith(".ts") && !name.endsWith(".d.ts") ? [relative(root, path)] : [];
  });
}
const sources = sourceFiles(root).map((file) => ({ file, text: readFileSync(join(root, file), "utf8") }));
const filesMatching = (pattern: RegExp) => sources.filter((source) => pattern.test(source.text)).map((source) => source.file).sort();

describe("census: who can start or plan a browser or API check, and who reads the runtime rows", () => {
  it("only these files call the gated readers, and each of them is a path that proposes, plans, approves, admits or reports a browser or API check", () => {
    expect(filesMatching(/\b(readReadyE2ERuntimeProfiles|readProjectReadyE2ERuntimes|readProjectAdmittedE2ERuntimes)\s*\(/u)).toEqual([
      "broker/src/aws/broker.ts",                                  // the hosted broker: setup proposals (profiles), planning (ready runtimes), plan approval and dispatch (admitted rows)
      "broker/src/aws/core-application-e2e.ts",                    // the core's planning context: the READY runtimes a plan may name
      "broker/src/aws/e2e-runtime-readiness.ts",                   // the gated reader itself
      "broker/src/core/e2e/application-readiness.ts",              // the core's selection before approval and dispatch: the rows a round is admitted on
      "broker/src/core/setup-agent/browser-testing-sandbox.ts",    // the Browser testing page and its check route: sandboxAvailable and the profiles a proposal may name
    ]);
  });

  it("only these files read an E2E runtime row by its key; every other reader goes through the gated one", () => {
    expect(filesMatching(/\be2eRegisteredRuntimeKey\s*\(/u)).toEqual([
      "broker/src/aws/broker.ts",                                  // the admin status / expiry notice and the model checks' own row read: no check is started from either
      "broker/src/aws/e2e-runtime-readiness.ts",                   // the gated reader, the status and expiry readers, and the row fences
      "broker/src/aws/runtime-installation.ts",                    // the registrar (writes the rows)
      "broker/src/aws/runtime-requalify-steps.ts",                 // the renewal (reads the expiry; writes through the registrar)
      "broker/src/aws/runtime-requalify.ts",                       // the renewal's own readback
      "broker/src/core/e2e/runtime-readiness.ts",                  // the core's re-export and the row fences an approval stands on
    ]);
  });

  it("no file admits a row or projects its readiness around the gate: the admission and the projection are the gate's own, and only the reader file and the re-export call them", () => {
    expect(filesMatching(/\badmitE2ERegisteredRuntime\s*\(/u)).toEqual(["broker/src/aws/e2e-runtime-readiness.ts"]);
    expect(filesMatching(/\bprojectE2ERuntimeReadiness\s*\(/u)).toEqual(["broker/src/aws/e2e-runtime-readiness.ts"]);
    // Everything else that names them is the core's re-export and a comment of the catalog contract.
    expect(filesMatching(/\b(admitE2ERegisteredRuntime|projectE2ERuntimeReadiness)\b/u)).toEqual(["broker/src/aws/e2e-runtime-readiness.ts", "broker/src/core/e2e/runtime-readiness.ts", "contracts/src/e2e-catalog.ts"]);
    const reader = sources.find((source) => source.file === "broker/src/aws/e2e-runtime-readiness.ts")!.text;
    // The only way to admit without the gate is private to the file, and its one other caller is the reader that applies the gate right after.
    expect(reader).not.toMatch(/export function admitWithoutEgressGate/u);
    expect([...reader.matchAll(/admitWithoutEgressGate\(/gu)]).toHaveLength(3);
    expect([...reader.matchAll(/webApiRuntimeRowProvesSandbox\(/gu)].length).toBeGreaterThanOrEqual(3);
  });

  it("the gate is the same check the page asks: both come from the contracts' one function", () => {
    expect(filesMatching(/\bwebApiRuntimeRowProvesSandbox\b/u)).toEqual([
      "broker/src/aws/e2e-feature-verifier-catalog.ts",            // the registrar's own doc comment: it writes the egress probes on both rows so each row can prove it
      "broker/src/aws/e2e-runtime-readiness.ts",
      "broker/src/core/setup-agent/browser-testing-sandbox.ts",
      "contracts/src/e2e-web-api-qualification.ts",
    ]);
  });

  it("every path that plans or admits goes through a file that uses the gated readers (no file reads rows around them)", () => {
    const planning = sources.find((source) => source.file === "broker/src/aws/core-application-e2e.ts")!.text;
    expect(planning).toMatch(/readyRuntimes:[\s\S]*readProjectReadyE2ERuntimes\(/u);
    const selection = sources.find((source) => source.file === "broker/src/core/e2e/application-readiness.ts")!.text;
    expect(selection).toMatch(/readProjectAdmittedE2ERuntimes\(runtimeInput\)/u);
    // The admission builds from the selection's rows, never from a read of its own.
    const admission = sources.find((source) => source.file === "broker/src/e2e/application-admission.ts")!.text;
    expect(admission).toMatch(/selection\.registeredRuntimes/u);
    expect(admission).not.toMatch(/e2eRegisteredRuntimeKey|readProject(Ready|Admitted)E2ERuntimes/u);
  });
});
