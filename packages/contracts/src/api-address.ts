// The permanent API address stack's shared names (DEC 254zzz505): the one place the address stack (infra/lib/api-address.ts, scripts/address-flip.ts) and the control-plane pipeline's
// consumer (PublicApiUrl, the rebuild guard) read them from, so the two cannot drift apart. Names only; no behaviour.
import { EnvironmentNameSchema } from "./environments.js";

/** The address stack OUTPUTS its origin (`https://<domain>`) under this name; the pipeline feeds exactly that value to every create and update of the control plane. */
export const PUBLIC_API_ORIGIN_OUTPUT = "PublicApiOrigin";

/** The legacy install's address stack name. */
export const LEGACY_ADDRESS_STACK_NAME = "AgentXApiAddress";

/** The address stack's name: the legacy install's (`env` undefined), or `agentx-<env>-address` in the named layout. Throws for an invalid environment name. */
export function publicApiAddressStackName(env: string | undefined): string {
  return env === undefined ? LEGACY_ADDRESS_STACK_NAME : `agentx-${EnvironmentNameSchema.parse(env)}-address`;
}

/** The longest address-stack domain: the control plane's `PublicApiUrl` host limit (`https://` plus 64 characters is PUBLIC_API_URL_MAX_LENGTH, 72), so the origin the stack outputs is never one the pipeline refuses. */
export const API_ADDRESS_DOMAIN_MAX_LENGTH = 64;
