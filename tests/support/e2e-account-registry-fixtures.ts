import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  E2EApplicationProjectContractSchema, canonicalJson, inspectE2ERepository, readE2EApplicationProjectContract,
  type E2EApplicationProjectContract, type E2ESourceSnapshot,
} from "@agentx/contracts";
import { planSyntheticAccountWrites, type E2EAccountRegistryEntry } from "../../packages/broker/src/e2e/application-account-registry.js";

/** Fixtures for the synthetic account registry: contracts with chosen account profiles, and the registry the setup approval would have written for a source. */
export const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
export const shaCanonicalOf = (value: unknown) => sha256Hex(canonicalJson(value));

/** Read here rather than imported from the plan fixtures, which import this module. */
const ordersContractManifest = readFileSync(new URL("../fixtures/e2e-web-api-app/package.json", import.meta.url), "utf8");

type ProfileDeclaration = { profileId: string; scope: "synthetic-test" | "external-test"; authProfileId: string; seedProfileId: string;
  tenantRef: string; roleRef: string; identityProbeId: string };
type OrdersManifest = { name: string; agentx: { e2e: { recipe: { recipeDigest: string; accountProfileIds: string[] } & Record<string, unknown>; accountProfiles: ProfileDeclaration[]; targetAccounts: unknown[] } } };

/** The orders fixture manifest (synthetic, orders-owner, orders-viewer), edited and with its recipe digest recomputed, as the project's source would carry it. */
export function ordersManifestWith(edit: (e2e: OrdersManifest["agentx"]["e2e"]) => void): string {
  const manifest = JSON.parse(ordersContractManifest) as OrdersManifest;
  edit(manifest.agentx.e2e);
  const { recipeDigest: _digest, ...body } = manifest.agentx.e2e.recipe;
  void _digest;
  manifest.agentx.e2e.recipe.recipeDigest = shaCanonicalOf(body);
  return JSON.stringify(manifest);
}

/** The orders contract plus a fourth profile in another tenant: `synthetic`, `orders-owner`, `orders-viewer` and `orders-owner-b`. */
export const withOwnerB = (e2e: OrdersManifest["agentx"]["e2e"]) => {
  e2e.accountProfiles.push({ profileId: "orders-owner-b", scope: "synthetic-test", authProfileId: "orders-auth/v1", seedProfileId: "orders-seed/v1",
    tenantRef: "tenant-b", roleRef: "owner", identityProbeId: "orders-identity/v1" });
  e2e.recipe.accountProfileIds.push("orders-owner-b");
};
export const withViewerRole = (roleRef: string) => (e2e: OrdersManifest["agentx"]["e2e"]) => {
  e2e.accountProfiles.find((profile) => profile.profileId === "orders-viewer")!.roleRef = roleRef;
};

export function contractOf(manifest: string): E2EApplicationProjectContract {
  return E2EApplicationProjectContractSchema.parse((JSON.parse(manifest) as OrdersManifest).agentx.e2e);
}
export const ORDERS_APPLICATION_ID = (JSON.parse(ordersContractManifest) as { name: string }).name;

/** The registry a setup approval of `snapshot` would have written at `now`: revision 1 of every synthetic profile of every application with a project contract. */
export function registryFor(snapshot: E2ESourceSnapshot, now = Date.now()): E2EAccountRegistryEntry[] {
  const inspection = inspectE2ERepository(snapshot, snapshot.candidate).inspection;
  return inspection.applications.flatMap((application) => {
    let contract: E2EApplicationProjectContract | null = null;
    try { contract = readE2EApplicationProjectContract(snapshot, application.applicationId); } catch { /* an application without a readable contract has no accounts */ }
    return contract === null ? [] : planSyntheticAccountWrites({ contract, applicationId: application.applicationId, prior: [], now })
      .map((write) => ({ definition: write.definition, latest: write.latest }));
  });
}
