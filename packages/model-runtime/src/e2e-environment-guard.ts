import { agentXError } from "@agentx/contracts";

/**
 * The worker environment variables that can redirect or re-authenticate a model call (M1.4 Task 4.1, Ruling M4-Q).
 *
 * pi-ai's provider clients read these from the process environment, and the worker cannot scrub its own environment
 * without changing how the coding agent calls its model. The governed e2e route is the only holder of provider access
 * for the AI browser-test agent, so the proxy refuses to start when any of them is set, rather than trust that none
 * leaks into the call. Explicit options (region from the route definition, base URL, the key from Secrets Manager) pin
 * everything else.
 *
 * An unset or empty variable is no setting (pi-ai treats an empty value as absent). `AWS_MAX_ATTEMPTS` is allowed only
 * as `1`, which cannot add a retry.
 */
export const E2E_REDIRECTING_ENVIRONMENT_VARIABLES: readonly string[] = [
  "AWS_BEARER_TOKEN_BEDROCK", "AWS_BEDROCK_SKIP_AUTH", "AWS_BEDROCK_FORCE_HTTP1", "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  "AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "NODE_USE_ENV_PROXY",
  "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "PI_CACHE_RETENTION",
];

/** The redirecting variables set in `environment`, once each, in a stable order. */
export function e2eRedirectingEnvironment(environment: NodeJS.ProcessEnv = process.env): string[] {
  const found = E2E_REDIRECTING_ENVIRONMENT_VARIABLES.filter((name) => (environment[name] ?? "") !== "");
  const attempts = environment["AWS_MAX_ATTEMPTS"];
  if (attempts !== undefined && attempts !== "" && attempts !== "1") found.push("AWS_MAX_ATTEMPTS");
  return [...new Set(found)].sort();
}

/** Throws RUNTIME_UNAVAILABLE naming the variables (never their values) when the environment can redirect a model call. */
export function assertE2EEnvironmentCannotRedirect(environment: NodeJS.ProcessEnv = process.env): void {
  const found = e2eRedirectingEnvironment(environment);
  if (found.length === 0) return;
  throw agentXError("RUNTIME_UNAVAILABLE", `this worker's environment can redirect model calls (${found.join(", ")}); the AI navigation agent does not start`);
}
