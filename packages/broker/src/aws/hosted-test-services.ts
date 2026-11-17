// DEC 254z-amend3: test services on Code's AWS deployment. They are ON by default (the stack setting `td`, read as ROVARA_TEST_SERVICES; exactly "0" is the opt-out), and the catalog is the owner starter list, the same
// pinned images as the laptop (`hostedServiceCatalog`).
//
// DEC 254zm: Code's EC2 workers run them once the install holds its own copies of the starter images (five ECR repositories, copied by digest: infra/lib/test-service-mirror.ts, scripts/test-services-mirror.ts) and
// the operator said so with the stack setting TestServiceImages=mirrored (packed `ti`, read as ROVARA_TEST_SERVICES_HOSTED_IMAGES). Until then (the default `none`, or any other value) nothing changes from L4-B2:
// the broker and the dispatcher mark test services unavailable for the reason `workers` at start (`markHostedTestServices`, from broker-environment-init.ts, before anything reads the environment), and a launch
// carries no `testServices` (`hostedWorkersRunTestServices`, session-steps.ts), so the user data stays byte-identical. With `mirrored`, a launch carries `testServices`, the worker's boot runs the test-services stage
// its image carries (packages/worker/ec2/test-services-stage.sh), and a worker whose stage or pulls failed offers no test-services feature: a step that needs one then ends with the fixed "not available here" words
// (task-flow/dispatch.ts), and every other step runs as before.
//
// Leaf module: it reads only the environment it is given, and makes no AWS call.
import { TEST_SERVICE_IMAGES_SETTING_VARIABLE, ownerCatalogOf, ownerStarterEntries, type VerifiedCatalog } from "@agentx/contracts";
import type { ServiceCatalogSource } from "../core/test-env/dependency-plan.js";
import { TEST_SERVICES_UNAVAILABLE_VARIABLE, testServicesSwitchedOn } from "../core/test-env/test-services-switch.js";

/** The variable the hosted functions read the TestServiceImages setting from (packed `ti`). Not ROVARA_TEST_SERVICE_IMAGES: that is the laptop owner's own list of image tags. */
export const HOSTED_TEST_SERVICE_IMAGES_VARIABLE = TEST_SERVICE_IMAGES_SETTING_VARIABLE;
/** The one value that says the install's copies of the starter images are in place. Anything else (unset, `none`, a typo) means they are not: fail closed. */
export const HOSTED_TEST_SERVICE_IMAGES_MIRRORED = "mirrored";

/** Whether Code's own EC2 workers start test services on this install: switched on (anything but exactly "0") AND the operator said the starter copies are in place (exactly `mirrored`). */
export function hostedWorkersRunTestServices(env: Record<string, string | undefined>): boolean {
  return testServicesSwitchedOn(env) && env[HOSTED_TEST_SERVICE_IMAGES_VARIABLE] === HOSTED_TEST_SERVICE_IMAGES_MIRRORED;
}

/**
 * Puts the host's marker on a hosted function's environment: `workers` while test services are switched on and Code's workers cannot run them (no `mirrored` setting). A marker already there is kept (it is the host's, and says no less);
 * with the switch off nothing is set. Returns the marker in effect.
 */
export function markHostedTestServices(env: Record<string, string | undefined>, workersRunThem: boolean = hostedWorkersRunTestServices(env)): string | undefined {
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
