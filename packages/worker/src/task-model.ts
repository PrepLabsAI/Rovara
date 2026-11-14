import {parseTaskModelFallbackAuthorization} from "./model-fallback-authority.js";
export {parseTaskModelFallbackAuthorization} from "./model-fallback-authority.js";
import { type TaskModelFallbackAuthorization,type TaskModelFallbackRequest,TaskModelFallbackRequestSchema,type TaskModelPolicyBinding,agentXError, type InvocationModelRoute, type ModelSelection, type SecondReviewerPayload } from "@agentx/contracts";
import { ROUTE_PROVIDER, routedThinkingLevel, type ChatGptFallbackReason, type ModelFallbackNotice, type ModelProxyOptions } from "@agentx/model-runtime";
import type { EventBatchSink } from "./events.js";
import { createChatGptPiSessionAdapter, createProxyPiSessionAdapter, type PiSessionAdapter, type WorkspaceModelConfiguration } from "./pi-session.js";
import { effectiveCacheRetention } from "./usage.js";

export function resolveTaskModel(
  selected: ModelSelection | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): WorkspaceModelConfiguration {
  return {
    provider: selected?.provider ?? required(environment, "AGENTX_MODEL_PROVIDER"),
    modelId: selected?.modelId ?? required(environment, "AGENTX_MODEL_ID"),
    ...(selected?.thinkingLevel === undefined ? {} : { thinkingLevel: selected.thinkingLevel }),
    cacheRetention: effectiveCacheRetention(environment.PI_CACHE_RETENTION),
  };
}

/** Task 27: the model of a task whose broker chose a route: the route's alias on `rovara-route`, with the thinking level asked for (off if that model does not reason). */
function routedTaskModel(route: InvocationModelRoute, selected: ModelSelection | undefined, environment: NodeJS.ProcessEnv): WorkspaceModelConfiguration {
  const level = routedThinkingLevel(route, selected?.thinkingLevel);
  return {
    provider: ROUTE_PROVIDER,
    modelId: route.alias,
    ...(level === undefined ? {} : { thinkingLevel: level }),
    cacheRetention: effectiveCacheRetention(environment.PI_CACHE_RETENTION),
  };
}

/**
 * SR-1: the models and sessions the second reviewer may try, in order. Each is called the way the broker checked it: through its own proxy route when it has one (never the task's model, and the proxy's model
 * fallback is not asked for). A routed candidate on a worker with no model proxy cannot be reached, so it is left out; with none left the second reviewer runs nothing and reports no answer.
 */
export function secondReviewerRuntimes(payload: { workflowSecondReviewer?: SecondReviewerPayload | undefined }, baseProxy: ModelProxyOptions | undefined, environment: NodeJS.ProcessEnv = process.env): Array<{ model: WorkspaceModelConfiguration; piAdapter?: PiSessionAdapter }> | undefined {
  if (payload.workflowSecondReviewer === undefined) return undefined;
  const runtimes: Array<{ model: WorkspaceModelConfiguration; piAdapter?: PiSessionAdapter }> = [];
  for (const candidate of payload.workflowSecondReviewer.candidates) {
    if (candidate.modelRoute === undefined) {
      runtimes.push({ model: resolveTaskModel(candidate.model, environment), ...(baseProxy === undefined ? {} : { piAdapter: createProxyPiSessionAdapter(baseProxy) }) });
    } else if (baseProxy !== undefined) {
      runtimes.push({ model: routedTaskModel(candidate.modelRoute, candidate.model, environment), piAdapter: createProxyPiSessionAdapter({ ...baseProxy, route: candidate.modelRoute }) });
    }
  }
  return runtimes;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required for coding tasks without a project model`);
  return value;
}

/**
 * #341: a task's model and, for one that runs on its owner's ChatGPT plan, the session adapter that uses the plan's
 * token. The token is asked for once before the task starts: a plan that cannot be used (revoked, unreachable) leaves
 * the task on the install's default model, which the invocation also carries.
 */
export async function resolveTaskSessionModel(
  payload: { model?: ModelSelection | undefined; chatgpt?: { model: ModelSelection } | undefined; modelRoute?: InvocationModelRoute | undefined;modelPolicy?:TaskModelPolicyBinding|undefined },
  chatGptToken: (() => Promise<string>) | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  /** #342: told why, once, when the plan stops serving the task and its requests move to the default model. */
  onFallback: (reason: ChatGptFallbackReason) => Promise<void> = async () => undefined,
  /** Ruling R29: where an install with a model proxy sends every request but a ChatGPT plan's own. */
  baseProxy?: ModelProxyOptions,
  authorizeFallback?: (reason:ChatGptFallbackReason|"unavailable")=>Promise<unknown>,
): Promise<{ model: WorkspaceModelConfiguration; piAdapter?: PiSessionAdapter }> {
  // Task 27: a route is never dropped. A worker with no proxy to send it through ends the task rather than use the default model.
  if (payload.modelRoute !== undefined && baseProxy === undefined) {
    throw agentXError("RUNTIME_UNAVAILABLE", "this task names a model route, but this worker has no model proxy to send it through");
  }
  const proxy = payload.modelRoute === undefined || baseProxy === undefined ? baseProxy : { ...baseProxy, route: payload.modelRoute };
  const proxied = proxy === undefined ? {} : { piAdapter: createProxyPiSessionAdapter(proxy) };
  // What the task runs on when its ChatGPT plan is not (or no longer) serving it: the route's model, else the install's default.
  const defaultModel = () => payload.modelRoute === undefined ? resolveTaskModel(payload.model, environment) : routedTaskModel(payload.modelRoute, payload.model, environment);
  const authorizedChoice=async(reason:ChatGptFallbackReason|"unavailable")=>{
    if(payload.modelPolicy===undefined||authorizeFallback===undefined)throw agentXError("RUNTIME_UNAVAILABLE","The task's fallback authorization is unavailable.");
    const authorization=parseTaskModelFallbackAuthorization(await authorizeFallback(reason),payload.modelPolicy);
    return authorizedTaskRuntime(authorization,baseProxy,environment);
  };
  if(payload.modelPolicy!==undefined&&payload.chatgpt!==undefined&&chatGptToken===undefined)throw agentXError("RUNTIME_UNAVAILABLE","The task's fallback authorization is unavailable.");
  if (payload.chatgpt === undefined || chatGptToken === undefined) return { model: defaultModel(), ...proxied };
  try {
    await chatGptToken();
  } catch (error) {
    if(payload.modelPolicy!==undefined){const choice=await authorizedChoice("unavailable");return {model:choice.model,...(choice.proxy===undefined?{}:{piAdapter:createProxyPiSessionAdapter(choice.proxy)})};}
    const effective = defaultModel();
    console.info(JSON.stringify({ event: "model_fallback", role: "worker", reason: "chatgpt_unavailable", errorName: error instanceof Error ? error.name : "unknown",
      requested: { provider: payload.chatgpt.model.provider, modelId: payload.chatgpt.model.modelId }, effective: { provider: effective.provider, modelId: effective.modelId } }));
    return { model: effective, ...proxied };
  }
  const fallbackModel = defaultModel();
  const report = (reason: ChatGptFallbackReason) => {
    if(payload.modelPolicy!==undefined)return; // The awaited broker authorization owns governed history/audit.
    console.info(JSON.stringify({ event: "model_fallback", role: "worker", reason: `chatgpt_${reason}`,
      requested: { provider: payload.chatgpt!.model.provider, modelId: payload.chatgpt!.model.modelId }, effective: { provider: fallbackModel.provider, modelId: fallbackModel.modelId } }));
    // Best effort: the task goes on whether or not the control plane heard.
    void onFallback(reason).catch((error: unknown) => {
      console.info(JSON.stringify({ event: "chatgpt_status_unreported", reason, errorName: error instanceof Error ? error.name : "unknown" }));
    });
  };
  return { model: resolveTaskModel(payload.chatgpt.model, environment), piAdapter: createChatGptPiSessionAdapter(chatGptToken, fallbackModel, report, proxy,payload.modelPolicy===undefined?undefined:authorizedChoice) };
}

/** MODEL3: the task-page note for a missing-key fallback, as one progress event; a failed post never fails the task. */
export function modelFallbackReporter(sink: EventBatchSink): (notice: ModelFallbackNotice) => void {
  let told = false;
  return (notice) => {
    if (told) return;
    told = true;
    void sink([{ type: "progress", payload: { message: `AgentX ${notice.text}.` }, timestamp: new Date().toISOString() }]).catch((error: unknown) => {
      console.info(JSON.stringify({ event: "model_fallback_unreported", errorName: error instanceof Error ? error.name : "unknown" }));
    });
  };
}

function authorizedTaskRuntime(authorization:TaskModelFallbackAuthorization,baseProxy:ModelProxyOptions|undefined,environment:NodeJS.ProcessEnv){
 if(authorization.modelRoute!==undefined&&baseProxy===undefined||authorization.modelRoute===undefined&&authorization.model.provider!=="amazon-bedrock")throw agentXError("RUNTIME_UNAVAILABLE","The task's authorized fallback route is unavailable.");
 const approvedProxy=authorization.modelRoute===undefined?baseProxy:{...baseProxy!,route:authorization.modelRoute};
 const model=authorization.modelRoute===undefined?resolveTaskModel(authorization.model,environment):routedTaskModel(authorization.modelRoute,authorization.model,environment);
 return {model,proxy:approvedProxy};
}
export function taskMissingKeyAuthorizer(payload:{modelPolicy?:TaskModelPolicyBinding|undefined},authorize:(request:TaskModelFallbackRequest)=>Promise<TaskModelFallbackAuthorization>,baseProxy?:ModelProxyOptions,environment:NodeJS.ProcessEnv=process.env){
 if(payload.modelPolicy===undefined)return undefined;
 const binding=payload.modelPolicy;
 return async(notice:ModelFallbackNotice)=>{
  const request=TaskModelFallbackRequestSchema.parse({version:1,binding,reason:"missing_key",failedModel:notice.requested,environmentFallback:notice.effective});
  const reply=parseTaskModelFallbackAuthorization(await authorize(request),binding);
  return authorizedTaskRuntime(reply,baseProxy,environment);
 };
}

/**
 * DR5: the model and session adapter of one design reviewer (or the merge step). Called the way the broker checked it: through its own proxy route when it has one, and with the proxy this reviewer's key slot
 * reaches (`proxy`: the base proxy with this slot's key source). A routed model on a worker with no model proxy cannot be reached and throws; the reviewer then gives no result.
 */
export function designReviewRuntime(candidate: { model: ModelSelection; modelRoute?: InvocationModelRoute | undefined }, proxy: ModelProxyOptions | undefined, environment: NodeJS.ProcessEnv = process.env): { model: WorkspaceModelConfiguration; piAdapter?: PiSessionAdapter } {
  if (candidate.modelRoute === undefined) return { model: resolveTaskModel(candidate.model, environment), ...(proxy === undefined ? {} : { piAdapter: createProxyPiSessionAdapter(proxy) }) };
  if (proxy === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "this design reviewer names a model route, but this worker has no model proxy to send it through");
  return { model: routedTaskModel(candidate.modelRoute, candidate.model, environment), piAdapter: createProxyPiSessionAdapter({ ...proxy, route: candidate.modelRoute }) };
}
