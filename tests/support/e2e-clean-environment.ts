import { vi } from "vitest";
import { E2E_REDIRECTING_ENVIRONMENT_VARIABLES } from "../../packages/model-runtime/src/e2e-environment-guard.js";

/**
 * The environment guard always reads the real process environment, so a developer's own AWS_PROFILE or proxy setting
 * would stop a test that starts a route on a real provider. Tests call this in `beforeEach` (and `vi.unstubAllEnvs()`
 * in `afterEach`) to run with none of the redirecting variables set. They are removed, not emptied: the AWS SDK treats an
 * empty AWS_ENDPOINT_URL as an endpoint.
 */
export function cleanRedirectingEnvironment(): void {
  for (const name of [...E2E_REDIRECTING_ENVIRONMENT_VARIABLES, "AWS_MAX_ATTEMPTS", "AWS_ROLE_ARN"]) vi.stubEnv(name, undefined);
}
