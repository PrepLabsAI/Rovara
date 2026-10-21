import { KEYED_MODEL_PROVIDERS, agentXError, isKeyedModelProvider, type E2EModelRouteDefinition } from "@agentx/contracts";

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
  // The AWS SDK's own configuration and credential sources: the worker must use the instance role, as configured.
  "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_EC2_METADATA_SERVICE_ENDPOINT",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "NODE_USE_ENV_PROXY",
  "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "PI_CACHE_RETENTION",
];

/** The redirecting variables set in `environment`, once each, in a stable order. */
export function e2eRedirectingEnvironment(environment: NodeJS.ProcessEnv = process.env): string[] {
  const found = E2E_REDIRECTING_ENVIRONMENT_VARIABLES.filter((name) => (environment[name] ?? "") !== "");
  const attempts = environment["AWS_MAX_ATTEMPTS"];
  if (attempts !== undefined && attempts !== "" && attempts !== "1") found.push("AWS_MAX_ATTEMPTS");
  // A role ARN alone configures nothing; with a web identity token file it is a second credential source.
  if ((environment["AWS_ROLE_ARN"] ?? "") !== "" && (environment["AWS_WEB_IDENTITY_TOKEN_FILE"] ?? "") !== "") found.push("AWS_ROLE_ARN");
  return [...new Set(found)].sort();
}

/**
 * Throws RUNTIME_UNAVAILABLE naming the variables (never their values) when the environment can redirect a model call.
 * pi-ai and the AWS SDK read the real process environment whatever a caller passes, so that is always checked; the
 * caller's own environment is checked as well.
 */
export function assertE2EEnvironmentCannotRedirect(environment?: NodeJS.ProcessEnv): void {
  const found = [...new Set([...e2eRedirectingEnvironment(process.env), ...(environment === undefined ? [] : e2eRedirectingEnvironment(environment))])].sort();
  if (found.length === 0) return;
  throw agentXError("RUNTIME_UNAVAILABLE", `this worker's environment can redirect model calls (${found.join(", ")}); the AI navigation agent does not start`);
}

/**
 * The worker refuses a route whose provider or secret differs from its own settings: the installation's provider is
 * `AGENTX_MODEL_PROVIDER` (unset is Bedrock, as for the coding agent) and a keyed provider's secret is that provider's
 * worker secret-ARN setting. A stale or forged definition therefore cannot reach a provider the owner did not choose.
 * The scripted route calls no provider and is exempt.
 */
export function assertE2ERouteMatchesInstallation(definition: Pick<E2EModelRouteDefinition, "provider" | "secretArn">, environment: NodeJS.ProcessEnv = process.env): void {
  if (definition.provider === "rovara-scripted") return;
  const reapprove = (why: string) => agentXError("RUNTIME_UNAVAILABLE", `model-route-changed-reapprove: ${why}; the AI navigation settings changed, so the checks need approving again`);
  const installed = (environment["AGENTX_MODEL_PROVIDER"] ?? "") || "amazon-bedrock";
  if (installed !== definition.provider) throw reapprove("the route's provider is not this worker's provider");
  if (!isKeyedModelProvider(definition.provider)) return;
  const secret = environment[KEYED_MODEL_PROVIDERS[definition.provider].secretArnVariable] ?? "";
  if (secret === "" || secret !== definition.secretArn) throw reapprove("the route's provider secret is not this worker's provider secret");
}
