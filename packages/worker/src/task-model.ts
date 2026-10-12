import type { ModelSelection } from "@agentx/contracts";
import type { ChatGptFallbackReason } from "@agentx/model-runtime";
import { createChatGptPiSessionAdapter, type PiSessionAdapter, type WorkspaceModelConfiguration } from "./pi-session.js";
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
  payload: { model?: ModelSelection | undefined; chatgpt?: { model: ModelSelection } | undefined },
  chatGptToken: (() => Promise<string>) | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  /** #342: told why, once, when the plan stops serving the task and its requests move to the default model. */
  onFallback: (reason: ChatGptFallbackReason) => Promise<void> = async () => undefined,
): Promise<{ model: WorkspaceModelConfiguration; piAdapter?: PiSessionAdapter }> {
  if (payload.chatgpt === undefined || chatGptToken === undefined) return { model: resolveTaskModel(payload.model, environment) };
  try {
    await chatGptToken();
  } catch (error) {
    const effective = resolveTaskModel(payload.model, environment);
    console.info(JSON.stringify({ event: "model_fallback", role: "worker", reason: "chatgpt_unavailable", errorName: error instanceof Error ? error.name : "unknown",
      requested: { provider: payload.chatgpt.model.provider, modelId: payload.chatgpt.model.modelId }, effective: { provider: effective.provider, modelId: effective.modelId } }));
    return { model: effective };
  }
  const fallbackModel = resolveTaskModel(payload.model, environment);
  const report = (reason: ChatGptFallbackReason) => {
    console.info(JSON.stringify({ event: "model_fallback", role: "worker", reason: `chatgpt_${reason}`,
      requested: { provider: payload.chatgpt!.model.provider, modelId: payload.chatgpt!.model.modelId }, effective: { provider: fallbackModel.provider, modelId: fallbackModel.modelId } }));
    // Best effort: the task goes on whether or not the control plane heard.
    void onFallback(reason).catch((error: unknown) => {
      console.info(JSON.stringify({ event: "chatgpt_status_unreported", reason, errorName: error instanceof Error ? error.name : "unknown" }));
    });
  };
  return { model: resolveTaskModel(payload.chatgpt.model, environment), piAdapter: createChatGptPiSessionAdapter(chatGptToken, fallbackModel, report) };
}
