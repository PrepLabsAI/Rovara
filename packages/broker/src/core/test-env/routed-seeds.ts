// which seed commands the test environment's draft of a setup draft task actually gave to a database dependency. The draft is read exactly as the wizard reads it (the same sanitizer, the same signed catalog),
// so what the setup proposal leaves out is what the proposed environment holds as the dependency's seed, never more. Empty when test services are off, the draft is gone, or no database could be proposed.
import { type OrgId } from "@agentx/contracts";
import type { StoreOnly } from "./deps.js";
import { readTestEnvDraft } from "./draft.js";
import type { ServiceCatalogSource } from "./dependency-plan.js";
import type { RoutedSeed } from "./seed-routing.js";
import { testEnvironmentEnabled } from "./switch.js";
import { testServicesEnabled } from "./test-services-switch.js";

export async function routedSeedsOf(
  deps: { store: StoreOnly["store"]; now: () => number; serviceCatalog?: ServiceCatalogSource | undefined },
  orgId: OrgId, project: string, taskId: string,
): Promise<RoutedSeed[]> {
  if (!testEnvironmentEnabled() || !testServicesEnabled()) return [];
  const catalog = await Promise.resolve(deps.serviceCatalog?.()).catch(() => undefined);
  const stored = await readTestEnvDraft(deps, orgId, project, taskId, deps.now(), { propose: { catalog, edition: "public", projectId: project } });
  return stored?.routedSeeds ?? [];
}
