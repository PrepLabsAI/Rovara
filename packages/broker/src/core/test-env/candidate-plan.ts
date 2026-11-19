// Test services (Prove): the dependencies a proposal's CANDIDATE check starts, pinned by digest from the signed catalog, for the preparation's payload (`testServices`). A leaf module, so the setup check's route
// (aws/developer-routes/project-archive-setup.ts) and the candidate state can share it. Undefined for a proposal without dependencies (the preparation then goes out exactly as it always did, with no extra read).
// A dependency that cannot be pinned, `tx` off, or a project with a dev container REFUSES the check, in fixed words: a check that ran without the dependencies would prove nothing.
import { agentXError, type OrgId, type TaskDependencyPlan, type TestEnvironmentBody } from "@agentx/contracts";
import { DEPENDENCY_PLAN_REFUSAL_WORDS, taskDependencyPlansOf, type SeedFileHashes, type ServiceCatalogSource } from "./dependency-plan.js";
import { refuseDependenciesWithDevcontainer } from "./devcontainer-check.js";
import type { StoreOnly } from "./deps.js";
import { testServicesEnabled } from "./test-services-switch.js";
import { approvedFixturesOf, recordsOf, type FixtureStoreFactory } from "./fixture-lookup.js";

export async function candidateDependencyPlan(
  deps: { serviceCatalog?: ServiceCatalogSource | undefined; fixtureStore?: FixtureStoreFactory | undefined; store: StoreOnly["store"] },
  proposal: Pick<TestEnvironmentBody, "dependencies" | "prodDeny">,
  scope: { orgId: OrgId; project: string },
  env: NodeJS.ProcessEnv = process.env,
  /** Review I3: the environment is an APPROVED one (the project's own check), so its file seeds carry the content the approval bound. */
  approvedSeedFiles?: SeedFileHashes,
): Promise<TaskDependencyPlan[] | undefined> {
  if ((proposal.dependencies?.length ?? 0) === 0) return undefined;
  if (!testServicesEnabled(env)) throw agentXError("CONFIG_INVALID", DEPENDENCY_PLAN_REFUSAL_WORDS.not_available_yet);
  await refuseDependenciesWithDevcontainer(deps, scope.orgId, scope.project, proposal);
  const catalog = await Promise.resolve(deps.serviceCatalog?.()).catch(() => undefined);
  const fixtures = await approvedFixturesOf(recordsOf(deps.fixtureStore), scope.orgId, scope.project, proposal);
  const planned = taskDependencyPlansOf({ body: proposal as TestEnvironmentBody, catalog, edition: "public", projectId: scope.project, fixtures, ...(approvedSeedFiles === undefined ? {} : { approvedSeedFiles }) });
  if (!planned.ok) throw agentXError("CONFIG_INVALID", DEPENDENCY_PLAN_REFUSAL_WORDS[planned.reason]);
  return planned.dependencies;
}
