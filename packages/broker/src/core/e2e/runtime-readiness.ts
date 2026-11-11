// The registered browser and API runtimes of the install's catalog, on the document store. The reading side (admit a row against the project's binding, what an administrator may be
// told, which kinds are READY) is pure: it takes a row reader, and `runtimeRowReader` is that reader over the store. What this file adds is the fence an approval or a verdict
// stands on: a check on the exact row it was derived from. Rows are Cloud's (`E2E_FEATURE_VERIFIER#<catalog>` / `PROFILE#<profile>#<kind>`); nothing differs.
import { when, type DocumentStore, type E2ERegisteredRuntimeSchema, type TransactItem } from "@agentx/contracts";
import type { z } from "zod";
import { e2eRegisteredRuntimeKey } from "../../aws/e2e-runtime-readiness.js";
import { e2eFeatureVerifierKey } from "../../aws/e2e-feature-verifier-catalog.js";

export {
  admitE2ERegisteredRuntime, e2eRegisteredRuntimeKey, projectE2ERuntimeReadiness, readE2ERuntimeStatus, readExpiredE2ERuntimes, readProjectAdmittedE2ERuntimes, readProjectReadyE2ERuntimes,
  readReadyE2ERuntimeProfiles, type ReadyE2ERuntime,
} from "../../aws/e2e-runtime-readiness.js";
export {
  E2E_FEATURE_PROCESS_RESPONSE_SCOPE, E2EFeatureVerifierRecordSchema, admitE2EFeatureVerifier, e2eFeatureVerifierKey, type E2EFeatureVerifierRecord,
} from "../../aws/e2e-feature-verifier-catalog.js";

/** A row reader for the catalog readers above: a consistent read of one key. A failed read throws; the readers decide whether that fails closed. */
export function runtimeRowReader(store: Pick<DocumentStore, "get">): (key: { pk: string; sk: string }) => Promise<unknown> {
  return (key) => store.get(key);
}

/** The catalog row of the feature verifier of a profile (the per-profile row, without a kind), or undefined. Pass it to `admitE2EFeatureVerifier`, which re-checks it whole. */
export function readFeatureVerifierRow(store: Pick<DocumentStore, "get">, runtimeCatalogId: string, profileId: string): Promise<unknown> {
  return store.get(e2eFeatureVerifierKey(runtimeCatalogId, profileId));
}

/**
 * The conditions that keep each runtime row an application approval selected exactly as it was read, until the transaction that records the approval (or a verdict
 * that rests on it) commits. The whole record is held: nothing about a row may move between the read and the commit, whether or not a requalification would bump its
 * generation. A selected row that is not among those read cannot be fenced, and the approval must not be recorded without its fence: that is a throw, never a skip.
 */
export function applicationRuntimeRowFences(input: { rows: readonly z.infer<typeof E2ERegisteredRuntimeSchema>[]; selected: readonly { kind: "web" | "api"; profileId: string }[] }): TransactItem[] {
  return input.selected.map((selected): TransactItem => {
    const row = input.rows.find((item) => item.capabilities.kind === selected.kind && item.profileId === selected.profileId);
    if (row === undefined) throw new Error(`the selected ${selected.kind} runtime ${selected.profileId} is not among the runtime rows this approval was derived from`);
    return { kind: "check", key: e2eRegisteredRuntimeKey(row.runtimeCatalogId, row.profileId, selected.kind),
      condition: when.and(
        when.eq("entityType", "E2E_FEATURE_VERIFIER"), when.eq("state", "READY"), when.eq("runtimeCatalogId", row.runtimeCatalogId), when.eq("catalogRevision", row.catalogRevision),
        when.eq("generation", row.generation), when.eq("bindingDigest", row.bindingDigest), when.eq("capabilityDigest", row.capabilityDigest), when.eq("expiresAt", row.expiresAt),
        when.eq("qualifiedAt", row.qualifiedAt), when.eq("manifestDigest", row.manifestDigest), when.eq("endpoint", row.endpoint),
        when.eq("runnerEnvironmentDigest", row.runnerEnvironmentDigest), when.eq("runnerEnvironment", row.runnerEnvironment),
        when.eq("runnerToolchainDigest", row.runnerToolchainDigest), when.eq("runnerToolchain", row.runnerToolchain), when.eq("transportCorrelationId", row.transportCorrelationId)) };
  });
}
