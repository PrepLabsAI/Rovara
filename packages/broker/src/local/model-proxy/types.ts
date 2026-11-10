// Port lane L9a, K1: the local model proxy's shapes (provisional, owner decision 58; see docs/ports.md).
//
// The worker never holds a model key. It holds a short-lived token that only this proxy accepts, bound to one workspace and one
// operation, and the proxy adds the real key (read from the `model-keys` port) when it forwards the call to the provider.
import type { Cost, InvocationModelRoute, ModelProviderAdapter } from "@agentx/contracts";

/** The providers Code knows without a plug-in (`BUILTIN_MODEL_PROVIDERS`). Others are `model-provider` plug-ins (item K2). */
export const PROXY_PROVIDERS = ["anthropic", "openai", "openrouter"] as const;
/** A provider id: open text (a `model-provider` plug-in brings a new one). */
export type ProxyProvider = string;

/** The wire shape a call speaks; the same three the worker's model library speaks to a routed model. */
export type ProxyApi = InvocationModelRoute["api"];

/** One model a token may call: the name the worker puts in its request (`alias`), and what the provider is really asked for. */
export interface ProxyRoute {
  alias: string;
  provider: ProxyProvider;
  /** The provider's own model id, put in the forwarded request in place of the alias. */
  model: string;
  api: ProxyApi;
}

/** What a worker's callback capability entitles it to, as the broker decided when it sent the job. */
export interface ModelGrant {
  workspaceId: string;
  operationId: string;
  /** The fence the operation holds its workspace at, when the broker keeps one. */
  fence?: number | undefined;
  taskId?: string | undefined;
  projectName?: string | undefined;
  /** The only models a token for this operation may call. */
  routes: readonly ProxyRoute[];
  /** The most this operation may spend. Absent: no limit is held. */
  budget?: Cost | undefined;
}

export interface ModelGrantSource {
  /**
   * What the capability allows. Throws an `AgentXError` (`CALLBACK_FORBIDDEN` for a capability that is not valid, expired or not for model
   * access, `STALE_FENCE` for an operation that no longer holds its workspace); the proxy answers a fixed refusal and never repeats the text.
   */
  grant(capability: string): Promise<ModelGrant>;
  /** Whether the operation still holds its workspace. Asked before every call, so a token dies with its operation. */
  active(operation: { workspaceId: string; operationId: string; fence: number | undefined }): Promise<boolean>;
}

/** What the proxy tells its owner about, in fixed words. Never a header, a body, a key or a token. */
export interface ModelProxyEvent {
  event: "token_minted" | "token_refused" | "call_refused" | "call_forwarded" | "call_finished" | "provider_refused" | "stream_stopped" | "unmetered";
  code?: string | undefined;
  operationId?: string | undefined;
  provider?: ProxyProvider | undefined;
  status?: number | undefined;
}

/** The providers the proxy may call: the `model-provider` plug-ins that are registered (item K2). Looked up per call, so a provider added at start-up is seen. */
export interface ModelProviderBook {
  get(id: string): ModelProviderAdapter | undefined;
  ids(): readonly string[];
}
