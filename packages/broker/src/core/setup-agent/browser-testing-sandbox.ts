// Browser testing: whether Rovara can start the test sandbox for a project right now, and which runtime profiles a proposal may name.
//
// "This is not your live site" is claimed only on a runtime whose registered record shows the egress probes passed: a runtime row is written only when the registrar re-judged every probe of its
// qualification, so the probe manifest on a READY row is the record that they passed. `SANDBOX_EGRESS_PROBE_IDS` (contracts) names the ones that matter: the app and the browser refused a public address, the app
// refused the host on its bridge, and the build container refused the cloud metadata address and a private one. The row is READ, never inferred: a runtime without them is not available for this.
import {
  Ec2RuntimeBindingSchema, SANDBOX_EGRESS_PROBE_IDS, WEB_API_RUNTIME_PROFILE_ID, projectRevisionKey,
  type DocumentStore, type E2ERegisteredRuntime, type E2EReadyRuntimeProfile, type OrgId,
} from "@agentx/contracts";
import { readProjectAdmittedE2ERuntimes, runtimeRowReader } from "../e2e/runtime-readiness.js";

/** Whether a registered runtime's probe manifest lists every egress probe. */
export function runtimeProvesSandbox(row: Pick<E2ERegisteredRuntime, "probeManifest">): boolean {
  const listed = new Set([...row.probeManifest.positiveProbeIds, ...row.probeManifest.negativeProbeIds]);
  return SANDBOX_EGRESS_PROBE_IDS.every((probeId) => listed.has(probeId));
}

interface SandboxInput { store: Pick<DocumentStore, "get">; companyId: OrgId; project: string; runtimeCatalogId: string; now: number }

async function admittedRows(input: SandboxInput, revision: number): Promise<E2ERegisteredRuntime[]> {
  const row = await input.store.get(projectRevisionKey(input.companyId, input.project, revision));
  const binding = Ec2RuntimeBindingSchema.safeParse(row?.["runtimeBinding"]);
  if (!binding.success || input.runtimeCatalogId === "") return [];
  return readProjectAdmittedE2ERuntimes({ runtimeCatalogId: input.runtimeCatalogId, profileId: WEB_API_RUNTIME_PROFILE_ID, binding: binding.data, now: input.now, read: runtimeRowReader(input.store) });
}

/** True when the project's runtime binding has a READY web or API runtime that passed every egress probe. A read that fails is "not available", and the page says the real fault. */
export async function sandboxAvailableFor(input: SandboxInput, revision: number): Promise<boolean> {
  try { return (await admittedRows(input, revision)).some(runtimeProvesSandbox); } catch { return false; }
}

/** The web and API profiles READY for the project, for the proposal's targets. Empty when none is. */
export async function readyProfilesFor(input: SandboxInput, revision: number): Promise<E2EReadyRuntimeProfile[]> {
  try { return (await admittedRows(input, revision)).flatMap((row) => (row.capabilities.kind === "web" || row.capabilities.kind === "api" ? [{ kind: row.capabilities.kind, profileId: row.profileId }] : [])); } catch { return []; }
}
