/**
 * CODE-PUBLIC-URL (owner DEC 254zzz505): one configured public address for the control plane's API, so every external URL Code builds (the sign-in callbacks and the token
 * issuer, the Slack, GitHub and Linear webhook addresses, the worker's and the notifier's callback base, the channel adapters' links) survives a rebuilt API.
 *
 * The stack parameter `PublicApiUrl` is an https ORIGIN (no path, no trailing slash) or empty. Empty (the default) is exactly today's behaviour: every one of those URLs is the API's
 * own `https://<id>.execute-api.<region>.amazonaws.com` host. Set, it is used everywhere (infra/lib/public-api-url.ts is the one place that chooses).
 *
 * The pattern is deliberately narrower than Cloud's `CodeUrl` (`^https://[^/\s]+$`): the broker gets the host packed in AGENTX_SETTINGS (a URL's slashes and an open character class
 * cannot be packed, the same reason CoreModelGatewayHost is a host), so the parameter holds lowercase DNS labels and nothing a packing separator could be.
 * Lowercase only also keeps the issuer, which is compared as an exact string, from differing by case between the two places that hold it.
 *
 * The parameter is a row of F1's install layer (packages/contracts/src/settings/install-rows.ts, `install.control-plane.PublicApiUrl`): its kept-on-upgrade position (OPERATOR_PARAMETERS, on the
 * control plane and the foundation) and its packed broker setting (`pu`, BROKER_SETTINGS.publicApiUrl) are derived from that row.
 */
import { PUBLIC_API_ORIGIN_OUTPUT } from "./api-address.js";

export const PUBLIC_API_URL_PARAMETER = "PublicApiUrl";
/** What the broker reads: the origin (`https://<host>`), unpacked from the host AGENTX_SETTINGS holds (BROKER_SETTINGS.publicApiUrl, httpsOrigin). */
export const PUBLIC_API_URL_VARIABLE = "ROVARA_PUBLIC_API_URL";
/**
 * Empty, or `https://` and a lowercase host of at least two DNS labels: no port (an API Gateway custom domain is served on 443 only), path, query, fragment, credentials or trailing
 * slash. A port would also be one more thing the DNS firewall's allow list (which names a host, never a port) would have to cut off.
 */
export const PUBLIC_API_URL_PATTERN = "^(https://[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+)?$";
/** `https://` and a host of at most 64 characters: what the broker's 4 KB has room for, and under the 127 characters a packed setting may hold. */
export const PUBLIC_API_URL_MAX_LENGTH = 72;

/**
 * The address stack (a separate, long-lived stack that holds the certificate, the API Gateway custom domain and the mapping onto the API, deployed by hand once per environment and
 * never rebuilt with the control plane) OUTPUTS its origin under `PUBLIC_API_ORIGIN_OUTPUT`. The pipeline feeds exactly that value to every create and every update of the control plane
 * (`resolvePublicApiUrl`), so a rebuild can never fall back to the raw host and re-key Cloud. The address stack's shared names (`PUBLIC_API_ORIGIN_OUTPUT`, `LEGACY_ADDRESS_STACK_NAME`,
 * `publicApiAddressStackName`) and its 64-character host limit live in ./api-address.ts only; the contracts index exports them from there (this file imports, it does not re-export:
 * `export *` of both files would be a duplicate export).
 */

/**
 * The control plane's base URL (an origin) from its stack outputs, for what the CLI records and prints: the settings' control plane URL (what `agentx login` names), and the sign-in
 * callbacks an operator registers in Slack and the company identity provider. The `DeveloperSignInIssuer` output (`<base>/v1/auth`) follows PublicApiUrl, so its origin is the permanent
 * address where the install has one; the raw `ApiEndpoint` otherwise (an install with no address, or a release before that output): exactly what the CLI always recorded.
 */
export function controlPlaneBase(outputs: Readonly<Record<string, string | undefined>>): string | undefined {
  const issuer = outputs.DeveloperSignInIssuer;
  if (issuer !== undefined && issuer.endsWith("/v1/auth") && issuer.length > "/v1/auth".length) return issuer.slice(0, -"/v1/auth".length);
  return outputs.ApiEndpoint;
}

const PATTERN = new RegExp(PUBLIC_API_URL_PATTERN, "u");

/** Whether `value` is a well-formed PublicApiUrl, empty included. */
export function isPublicApiUrl(value: string): boolean {
  return value.length <= PUBLIC_API_URL_MAX_LENGTH && PATTERN.test(value);
}

/** The host of a non-empty PublicApiUrl, as the firewall's allow list names it and the broker's packed setting holds it. */
export function publicApiHost(value: string): string {
  if (value === "" || !isPublicApiUrl(value)) throw new Error("the public API URL must be https://<host> with a lowercase host and no path");
  return value.slice("https://".length);
}

/**
 * The rebuild guard (DEC 254zzz505, rev 9.2). "Carry the previous value" works only on an UPDATE: a brand-new control plane stack gets the empty default and would silently use the
 * raw host. So where an address stack exists, its `PublicApiOrigin` output is the only value a create or an update may carry.
 *  - `addressOrigin` undefined: this install has no address stack (nothing to enforce, unless `required`): the parameter is left as the caller has it (`proposed`, or not sent).
 *  - `addressOrigin` defined: it must be well formed and non-empty; `proposed` (what the pipeline was about to send) must be absent or equal to it. Empty and different are refused.
 *  - `required`: no address stack is itself a refusal (the install is declared to have one).
 * Returns the value to send, or undefined to send nothing. Never echoes more than the two origins, which are public addresses.
 */
export function resolvePublicApiUrl(input: { addressOrigin: string | undefined; proposed?: string | undefined; required?: boolean }): string | undefined {
  const { addressOrigin, proposed } = input;
  if (addressOrigin === undefined) {
    if (input.required === true) throw new Error(`this install is declared to have an address stack, but none was found (it outputs ${PUBLIC_API_ORIGIN_OUTPUT}); refusing to create or update the control plane without the permanent address`);
    if (proposed !== undefined && !isPublicApiUrl(proposed)) throw new Error(`${PUBLIC_API_URL_PARAMETER} must be empty or https://<lowercase host>, with no path`);
    return proposed;
  }
  if (addressOrigin === "" || !isPublicApiUrl(addressOrigin)) throw new Error(`the address stack's ${PUBLIC_API_ORIGIN_OUTPUT} output is empty or not an https origin; refusing to create or update the control plane`);
  if (proposed === "") throw new Error(`${PUBLIC_API_URL_PARAMETER} is empty but the address stack's ${PUBLIC_API_ORIGIN_OUTPUT} is ${addressOrigin}; refusing to create or update the control plane with the raw API host`);
  if (proposed !== undefined && proposed !== addressOrigin) throw new Error(`${PUBLIC_API_URL_PARAMETER} ${proposed} does not equal the address stack's ${PUBLIC_API_ORIGIN_OUTPUT} ${addressOrigin}; refusing to create or update the control plane`);
  return addressOrigin;
}

/**
 * Changing the public address of an install that already runs is an ISSUER change: the issuer follows it (Cloud's sealed company AI keys, spend meters and Bedrock external ids are keyed
 * on the issuer). `current` is the running stack's value (undefined: no stack yet, a fresh install, which sets it once). Returns the refusal text, or undefined when the change needs
 * no confirmation (nothing changes, or a fresh install).
 */
export function publicApiUrlChangeWarning(current: string | undefined, proposed: string | undefined): string | undefined {
  if (current === undefined || proposed === undefined || current === proposed) return undefined;
  const from = current === "" ? "the API's own host" : current;
  const to = proposed === "" ? "the API's own host" : proposed;
  return `changing the public API URL of a running install, from ${from} to ${to}, changes its token issuer: Cloud's sealed company AI keys, spend meters and Bedrock external ids are keyed on the issuer, `
    + "and the sign-in callbacks, webhook addresses and links change with it. Cloud's CodeUrl must change in the same window";
}
