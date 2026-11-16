// The worker's binding of the final-check eval for ONE task invocation (plan v3.2 row 20.2). main.ts calls `evalFinalCheckForTask` for a task that carries an
// `evalRequest`; the answer is the `evalFinalCheck` dependency of `runTaskInvocation`, or undefined (the request then reads "not run: not connected", zero calls,
// exactly as before this file).
//
// OFF BY DEFAULT. The eval binds only when the host's environment names the model gateway's address (`ROVARA_EVAL_GATEWAY_URL`, an https origin), the trusted sources
// below are present and whole, and (for a result at all) a fresh check sandbox is available. Anything less is undefined, or a round kind of "working", which reads
// "needs a fresh sandbox" before any money is held. Nothing here throws to its caller.
//
// THE ONE MODEL ROUTE. The eval's model calls go only through the gateway's product route (`createEvalGatewayAccess`, #714): a whole-stage hold, then each call once
// to `/v1/product/gemini/...` with the task token. The token is the one the control plane mints for this operation (`/v1/internal/model-access`, the operation's own
// callback capability). It is sent only to the origin it was minted for: a token whose `baseUrl` is not the configured gateway's origin (an install with no gateway,
// or a proxy key) is never sent anywhere. The token never enters the sandbox (the bridge's egress is the stage's call), a log line, an error or an artifact.
//
// WHAT THIS BASE DOES NOT HAVE (each one reads "not run", never a guess, until it is built): the trusted SOURCES (the confirmed plan with its question inventory, the
// persisted approval, the company-scoped baseline cache), delivered from the control plane (live setup delivery, EVAL-WIRE-SOURCES-NOT-DELIVERED); and the FRESH
// check sandbox (TE-B1). `evalHostSourcesFor` is the one place a later lane fills in.
import type { EvalGatewayTokenSource } from "./eval-gateway-access.js";
import { createEvalGatewayAccess } from "./eval-gateway-access.js";
import { createBridgedEvalExec, type FreshEvalSandbox } from "./eval-bridged-exec.js";
import { createEvalFinalCheckPorts, type EvalHostCapabilities } from "./eval-host.js";
import type { EvalFinalCheckPorts } from "./eval-final-check.js";
import type { EvalMeterOptions } from "./eval-model-access.js";
import type { ModelEgressFrame } from "@agentx/contracts";
import { modelAccessSource } from "../model-access.js";

/** The host's setting that turns the eval on: the model gateway's https origin. Unset (the default), or anything else: the eval stays off. */
export const EVAL_GATEWAY_URL_VARIABLE = "ROVARA_EVAL_GATEWAY_URL";

/** The gateway's origin from the environment, or undefined: https only, an origin (a bare `/` path at most), no credentials, query or fragment, at most 512 characters. Never throws, never echoes the value. */
export function evalGatewayOriginFrom(environment: NodeJS.ProcessEnv): string | undefined {
  const raw = environment[EVAL_GATEWAY_URL_VARIABLE]?.trim();
  if (raw === undefined || raw === "" || raw.length > 512) return undefined;
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  // Exactly an origin: anything with credentials, a path, a query or a fragment makes the text differ from `origin` (or `origin/`).
  if (url.protocol !== "https:" || (raw !== url.origin && raw !== `${url.origin}/`)) return undefined;
  return url.origin;
}

/** The trusted capabilities of one invocation, made from this invocation's own scope only (nothing is shared across invocations or companies). */
export interface EvalHostSources {
  readonly plan: EvalHostCapabilities["plan"];
  readonly approval: EvalHostCapabilities["approval"];
  readonly cache: EvalHostCapabilities["cache"];
  readonly baselines: EvalHostCapabilities["baselines"];
  /** The check round's fresh sandbox. */
  readonly sandbox: FreshEvalSandbox;
  /** The worker's own folder for the run's socket (absolute; short enough for a Unix socket path). */
  readonly runDir: string;
  /** The worker's own "this frame carries a changed prompt". Absent: the eval reads "no changed prompt call". */
  readonly changedPrompt?: (frame: ModelEgressFrame) => boolean;
  /** The worker's own pin of the model, from the trusted plan: true only for a frame that calls the plan's model (and judge). Required: the repository's eval code must not choose the model. */
  readonly modelAllowed: (frame: ModelEgressFrame) => boolean;
  readonly meter?: EvalMeterOptions;
}

/**
 * The sources for this invocation, or undefined (the eval stays "not connected"). Today none exist on this base: the plan, the approval and the baseline cache are the
 * broker's, and no route delivers them to the worker yet; the fresh sandbox is TE-B1. A later lane replaces the body; its sources must come from the invocation's own
 * capability and company.
 */
export function evalHostSourcesFor(_invocation: { readonly operationId: string; readonly callbackCapability: string }): EvalHostSources | undefined {
  void _invocation;
  return undefined;
}

export interface EvalTaskBindingInput {
  /** The task carries an `evalRequest`. A task without one gets nothing (the CHECKS path is byte-identical to before). */
  readonly requested: boolean;
  readonly environment: NodeJS.ProcessEnv;
  readonly controlPlaneUrl: string;
  /** This operation's callback capability: the one request for the task token. */
  readonly capability: string;
  readonly sources: EvalHostSources | undefined;
  /** Test seam; default the Node built-in. */
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

/** The task token source: asks the control plane for this operation's access and returns its key only when it was minted for `origin`. A different origin, an unreadable address or any fault is a refusal (no token). */
export function evalGatewayTokenSource(input: { origin: string; controlPlaneUrl: string; capability: string; fetch?: typeof fetch; now?: () => number }): EvalGatewayTokenSource {
  const access = modelAccessSource({
    controlPlaneUrl: input.controlPlaneUrl, capability: input.capability,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.now === undefined ? {} : { now: input.now }),
  });
  return async () => {
    const granted = await access();
    let origin: string;
    try { origin = new URL(granted.baseUrl).origin; } catch { throw new Error("the task token is not for the eval gateway"); }
    if (origin !== input.origin) throw new Error("the task token is not for the eval gateway");
    return granted.apiKey;
  };
}

const isWhole = (sources: EvalHostSources | undefined): sources is EvalHostSources => typeof sources === "object" && sources !== null
  && typeof sources.sandbox === "object" && sources.sandbox !== null && typeof sources.sandbox.available === "function" && typeof sources.sandbox.run === "function"
  && typeof sources.modelAllowed === "function" && typeof sources.runDir === "string" && sources.runDir.startsWith("/");

/** The ports of the final-check eval for this task, or undefined. Never throws. */
export function evalFinalCheckForTask(input: EvalTaskBindingInput): EvalFinalCheckPorts | undefined {
  try {
    if (input.requested !== true) return undefined;
    const origin = evalGatewayOriginFrom(input.environment);
    if (origin === undefined || !isWhole(input.sources)) return undefined;
    const sources = input.sources;
    if (typeof input.controlPlaneUrl !== "string" || input.controlPlaneUrl === "" || typeof input.capability !== "string" || input.capability === "") return undefined;
    const modelAccess = createEvalGatewayAccess(origin, evalGatewayTokenSource({ origin, controlPlaneUrl: input.controlPlaneUrl, capability: input.capability, ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.now === undefined ? {} : { now: input.now }) }),
      input.fetch === undefined ? {} : { fetch: input.fetch });
    // A sandbox that cannot start a fresh round is the working round: "needs a fresh sandbox", before any hold.
    let fresh = false;
    try { fresh = sources.sandbox.available() === true; } catch { fresh = false; }
    return createEvalFinalCheckPorts({
      roundKind: fresh ? "check_unsealed" : "working",
      plan: sources.plan, approval: sources.approval, cache: sources.cache, baselines: sources.baselines,
      modelAccess,
      exec: createBridgedEvalExec({ sandbox: sources.sandbox, runDir: sources.runDir, modelAllowed: sources.modelAllowed, ...(sources.changedPrompt === undefined ? {} : { changedPrompt: sources.changedPrompt }), ...(input.now === undefined ? {} : { now: input.now }) }),
      ...(sources.meter === undefined ? {} : { meter: sources.meter }),
    });
  } catch { return undefined; }
}
