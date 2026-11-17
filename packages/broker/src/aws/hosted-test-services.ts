// DEC 254z-amend3: test services on Code's AWS deployment. They are ON by default (the stack setting `td`, read as ROVARA_TEST_SERVICES; exactly "0" is the opt-out), and the catalog is the owner starter list, the same
// pinned images as the laptop (`hostedServiceCatalog`). But Code's EC2 workers cannot run them yet: they boot from packages/worker/ec2/boot.sh alone, which has no test-services stage (no run folder, no IPv6 drops,
// no boot facts, no service images on the host, and none of the AGENTX_TEST_SERVICES_* variables the worker needs), and a launch renders AGENTX_TEST_SERVICES only for a named-environment worker, which Code never makes.
// So the broker and the dispatcher mark them unavailable for the reason `workers` at start (`markHostedTestServices`, from broker-environment-init.ts, before anything reads the environment): nothing is proposed,
// planned or started with dependencies, a task whose environment lists some runs the project's own checks and says "Test services not available here: ..." in fixed words, and the test environment's state answer
// says the same. When Code's workers gain the stage, HOSTED_WORKERS_RUN_TEST_SERVICES becomes true in the same change, with its tests.
//
// Leaf module: it reads only the environment it is given, and makes no AWS call.
import { ownerCatalogOf, ownerStarterEntries, type VerifiedCatalog } from "@agentx/contracts";
import type { ServiceCatalogSource } from "../core/test-env/dependency-plan.js";
import { TEST_SERVICES_UNAVAILABLE_VARIABLE, testServicesSwitchedOn } from "../core/test-env/test-services-switch.js";

/** Whether Code's own EC2 workers can start test services. False until their boot has the test-services stage (see above). */
export const HOSTED_WORKERS_RUN_TEST_SERVICES = false;

/**
 * Puts the host's marker on a hosted function's environment: `workers` while test services are switched on and Code's workers cannot run them. A marker already there is kept (it is the host's, and says no less);
 * with the switch off nothing is set. Returns the marker in effect.
 */
export function markHostedTestServices(env: Record<string, string | undefined>, workersRunThem: boolean = HOSTED_WORKERS_RUN_TEST_SERVICES): string | undefined {
  if (!testServicesSwitchedOn(env) || workersRunThem) return env[TEST_SERVICES_UNAVAILABLE_VARIABLE];
  env[TEST_SERVICES_UNAVAILABLE_VARIABLE] ??= "workers";
  return env[TEST_SERVICES_UNAVAILABLE_VARIABLE];
}

let starterCatalog: VerifiedCatalog | undefined;
/**
 * The hosted catalog source: the owner starter list compiled into this release (contracts owner-starter-images.ts, a guard file), as `ownerCatalogOf` makes it, the same catalog the laptop builds from the same list.
 * No signing key and no download: Code's release is the trust anchor, exactly as on a laptop. Undefined while test services are switched off.
 */
export function hostedServiceCatalog(env: NodeJS.ProcessEnv): ServiceCatalogSource | undefined {
  if (!testServicesSwitchedOn(env)) return undefined;
  return async () => (starterCatalog ??= ownerCatalogOf(ownerStarterEntries()));
}
