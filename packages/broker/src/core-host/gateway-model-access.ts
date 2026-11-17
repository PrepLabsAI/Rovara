// Switch-on lane L2b (DEC 236): the core engine's model keys live in the Cloud MODEL GATEWAY, never in Code.
//
// On a deployed install a worker calls AI through the gateway's agent route (`/v1/messages`) with a task token (#670) the broker mints for its operation
// (`/v1/internal/model-access`, core/model-gateway/route.ts). The gateway holds each company's own key (sealed, write-only) and enforces the one combined
// company budget; a company with no key connected is refused there ("connect an AI key"). So on this install:
//
//   model-keys    `gatewayModelKeyStore`: holds no key and never gives one (`get` is always undefined, `providers` is empty). It exists so the build area's
//                 point is filled by a deployed adapter that says where the keys are, rather than by a store that could ever read one.
//   modelAccess   the route every core task step is dispatched with: the gateway agent route's API (Anthropic Messages) and the one agent model the install
//                 runs. The worker job then carries the `model-access` capability, and the token's `mdl` names exactly that model.
//   modelGateway  the broker's core callback layer mints the task token (the task key in KMS, purpose `task`) and answers the gateway's address.
//
// Settings (the function's environment, both the broker and the dispatcher): ROVARA_CORE_MODEL_GATEWAY_URL (the gateway's https origin) and
// ROVARA_CORE_AGENT_MODEL (an Anthropic model id). Both absent: nothing is built and the model-keys point stays empty, so the registry refuses the switch
// by name, as before. One without the other, or either malformed, refuses in fixed words (no value is echoed).
import { CORE_AGENT_MODEL_VARIABLE, CORE_MODEL_GATEWAY_URL_VARIABLE, TASK_KEY_PURPOSE, type InvocationModelRoute, type ModelKeyStore, type SecretValue } from "@agentx/contracts";
import { kmsTokenSigner, type TokenSigner } from "../developer/tokens.js";
import type { ModelGateway } from "../core/model-gateway/route.js";
import type { TaskTokenDescriber } from "../core/model-gateway/token.js";
import { coreAdapter, type CoreAdapterModule } from "./registry.js";

// The names are the deployment's (contracts/core-engine-infra.ts: the stack parameters CoreModelGatewayHost and CoreAgentModel set them).
export { CORE_AGENT_MODEL_VARIABLE, CORE_MODEL_GATEWAY_URL_VARIABLE };
/** The model-keys adapter's name: the keys are the gateway's. */
export const GATEWAY_MODEL_KEYS = "model-gateway";

export interface GatewayModelAccessSettings {
  /** The gateway's https origin (no path, credentials, query or fragment). */
  gatewayUrl: string;
  /** The route every core step is dispatched with: the agent model on the gateway's Anthropic Messages route. */
  route: InvocationModelRoute;
}

/** Fixed refusal words: they name the variables, never their values. */
export const GATEWAY_SETTINGS_PARTIAL = `the core engine's model gateway settings are incomplete: set both ${CORE_MODEL_GATEWAY_URL_VARIABLE} and ${CORE_AGENT_MODEL_VARIABLE}, or neither`;
export const GATEWAY_URL_INVALID = `${CORE_MODEL_GATEWAY_URL_VARIABLE} is not an https origin`;
export const AGENT_MODEL_INVALID = `${CORE_AGENT_MODEL_VARIABLE} is not an Anthropic model id`;

const AGENT_MODEL = /^claude-[a-z0-9][a-z0-9.-]{0,99}$/u;

/** The settings, `undefined` when neither is set, or `{ problem }` in fixed words. */
export function readGatewayModelAccess(env: NodeJS.ProcessEnv): GatewayModelAccessSettings | { problem: string } | undefined {
  const rawUrl = env[CORE_MODEL_GATEWAY_URL_VARIABLE]?.trim() ?? "";
  const rawModel = env[CORE_AGENT_MODEL_VARIABLE]?.trim() ?? "";
  if (rawUrl === "" && rawModel === "") return undefined;
  if (rawUrl === "" || rawModel === "") return { problem: GATEWAY_SETTINGS_PARTIAL };
  let url: URL;
  try { url = new URL(rawUrl); } catch { return { problem: GATEWAY_URL_INVALID }; }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || rawUrl.length > 512
    || (rawUrl !== url.origin && rawUrl !== `${url.origin}/`)) return { problem: GATEWAY_URL_INVALID };
  if (!AGENT_MODEL.test(rawModel)) return { problem: AGENT_MODEL_INVALID };
  return { gatewayUrl: url.origin, route: { alias: rawModel, api: "anthropic-messages", catalog: rawModel } };
}

/** As `readGatewayModelAccess`, but a problem throws its fixed words (a root must never run half-configured). */
export function gatewayModelAccessFromEnvironment(env: NodeJS.ProcessEnv): GatewayModelAccessSettings | undefined {
  const read = readGatewayModelAccess(env);
  if (read !== undefined && "problem" in read) throw Object.assign(new Error(read.problem), { name: "GatewayModelAccessInvalid" });
  return read;
}

/** The deployed model key store: Code holds no key; the gateway does. Never a key, for any company or provider. */
export function gatewayModelKeyStore(): ModelKeyStore & { readonly heldBy: typeof GATEWAY_MODEL_KEYS } {
  return {
    heldBy: GATEWAY_MODEL_KEYS,
    async get(): Promise<SecretValue | undefined> { return undefined; },
    async providers(): Promise<string[]> { return []; },
  };
}

/** The model-keys module for BOTH roots (the broker's and the dispatcher's). None while the gateway is not configured; a broken setting refuses the registry. */
export function gatewayModelKeysModules(env: NodeJS.ProcessEnv): CoreAdapterModule[] {
  const read = readGatewayModelAccess(env);
  if (read === undefined) return [];
  return [coreAdapter({
    point: "model-keys", name: GATEWAY_MODEL_KEYS, owner: "L2b (DEC 236: keys in the model gateway)",
    create: () => {
      if ("problem" in read) throw new Error(`the core engine's model keys cannot be built: ${read.problem}`);
      return gatewayModelKeyStore();
    },
  })];
}

/** The flow's `modelAccess` input: every core task step is dispatched to the gateway's agent model. */
export function gatewayModelRoute(settings: GatewayModelAccessSettings): { route(): Promise<InvocationModelRoute> } {
  const route = Object.freeze({ ...settings.route });
  return { route: async () => ({ ...route }) };
}

/** The task-token signer: the broker's KMS task key, published and checked with purpose `task` only (mintTaskToken refuses any other). */
export function taskKeySigner(signer: TokenSigner): TokenSigner {
  return {
    publicJwk: async () => ({ ...await signer.publicJwk(), rovara_purpose: TASK_KEY_PURPOSE }),
    sign: (input) => signer.sign(input),
  };
}

/**
 * The broker's core callback layer's model gateway: its address, the token issuer (the install's sign-in issuer, whose JWKS the gateway pins), the TASK signer (already
 * `taskKeySigner`, so the minter's own purpose check still means something) and the describer.
 */
export function gatewayForCallbacks(settings: GatewayModelAccessSettings, inputs: { issuer: string; signer: TokenSigner; describer: TaskTokenDescriber }): ModelGateway {
  return { gatewayUrl: settings.gatewayUrl, issuer: inputs.issuer, signer: inputs.signer, describer: inputs.describer };
}

/** Fixed words: the gateway is configured but the broker cannot mint task tokens (no task key or no issuer). */
export const GATEWAY_TASK_TOKENS_MISSING = "the core engine's model gateway is configured, but the broker has no task-token key or issuer (TASK_TOKEN_KEY_ARN, DEVELOPER_TOKEN_ISSUER)";

/** What the broker's core runtime takes from the gateway settings: the flow's model route and, per company, the callback layer's model gateway. */
export interface CoreModelGatewayWiring {
  flowOptions: { modelAccess: { route(): Promise<InvocationModelRoute> } };
  callbackGateway(describer: TaskTokenDescriber): ModelGateway;
}

/**
 * The broker's wiring, read when a company's runtime is built. Neither setting: undefined (no route, no model gateway, as before). Configured without the task-token
 * signer and issuer: throws GATEWAY_TASK_TOKENS_MISSING, so the runtime is refused and no task starts (no paid worker that could never reach its model).
 */
export function coreModelGatewayWiring(env: NodeJS.ProcessEnv, taskTokens: (() => { signer: TokenSigner; issuer: string } | undefined) | undefined): CoreModelGatewayWiring | undefined {
  const settings = gatewayModelAccessFromEnvironment(env);
  if (settings === undefined) return undefined;
  const tokens = taskTokens?.();
  if (tokens === undefined || typeof tokens.issuer !== "string" || tokens.issuer === "" || typeof tokens.signer?.sign !== "function" || typeof tokens.signer.publicJwk !== "function") {
    throw Object.assign(new Error(GATEWAY_TASK_TOKENS_MISSING), { name: "GatewayTaskTokensMissing" });
  }
  return {
    flowOptions: { modelAccess: gatewayModelRoute(settings) },
    callbackGateway: (describer) => gatewayForCallbacks(settings, { issuer: tokens.issuer, signer: tokens.signer, describer }),
  };
}

/**
 * L2b (DEC 236): the task-token signer and issuer from the environment: the install's KMS task key (TASK_TOKEN_KEY_ARN; only the broker may sign with it, by its key policy) and the sign-in issuer
 * (DEVELOPER_TOKEN_ISSUER, whose JWKS publishes that key with purpose `task`). Either absent: undefined. It also signs the service token that reads a company's offered models.
 */
export function taskTokensFromEnvironment(env: NodeJS.ProcessEnv, kms: Parameters<typeof kmsTokenSigner>[0]["kms"]): { signer: TokenSigner; issuer: string } | undefined {
  const keyId = env.TASK_TOKEN_KEY_ARN ?? "";
  const issuer = env.DEVELOPER_TOKEN_ISSUER ?? "";
  // Published with purpose `task` by the JWKS (developer-identity.ts); stamped here, where the key is known to be the task key.
  return keyId === "" || issuer === "" ? undefined : { signer: taskKeySigner(kmsTokenSigner({ kms, keyId })), issuer };
}
