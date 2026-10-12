// Sign in with ChatGPT (#341): which tasks run on a ChatGPT plan, whose plan, and on which model.
import type { ModelSelection, OperationRequester } from "@agentx/contracts";
import { catalogModel } from "@agentx/model-runtime/catalog";
import type { ChatGptConnections } from "./connections.js";

/**
 * The plan models Rovara prefers, best first: the strongest general coding models the spike found a
 * Plus or Pro plan allows. A plan that allows none of them gets its first model Pi knows.
 */
export const CHATGPT_MODEL_PREFERENCE = ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol", "gpt-6-luna", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"] as const;

/** The model a task runs on from the plan's allowed list: the preferred one, else the best allowed, among models Pi knows. */
export function chatGptTaskModel(allowed: readonly string[], preferred?: string): string | undefined {
  const known = allowed.filter((modelId) => catalogModel({ provider: "openai", modelId }) !== undefined);
  if (preferred !== undefined && known.includes(preferred)) return preferred;
  return CHATGPT_MODEL_PREFERENCE.find((modelId) => known.includes(modelId)) ?? known[0];
}

/**
 * The task's ChatGPT model when its owner has a working connection, or undefined when the task runs on the install's
 * default as before: no owner, no connection, a revoked one, a plan at its limit, or a connection that cannot be read.
 */
export async function chatGptTaskSelection(
  connections: ChatGptConnections | undefined,
  ownerDeveloperId: string | undefined,
): Promise<{ developerId: string; model: ModelSelection } | undefined> {
  if (connections === undefined || ownerDeveloperId === undefined) return undefined;
  let view: Awaited<ReturnType<ChatGptConnections["view"]>>;
  let settings: Awaited<ReturnType<ChatGptConnections["settings"]>>;
  try {
    // #343: with the admin's switch off, every task runs on the default; connections are kept for when it is on.
    settings = await connections.settings();
    if (!settings.enabled) return undefined;
    view = await connections.view(ownerDeveloperId);
  } catch (error) {
    // A task never fails because its owner's connection could not be read; it runs on the default.
    console.log(JSON.stringify({ component: "broker", event: "chatgpt.connection_unreadable", errorName: error instanceof Error ? error.name : "unknown" }));
    return undefined;
  }
  if (!view.connected || view.status !== "connected") return undefined;
  const modelId = chatGptTaskModel(view.models ?? [], settings.preferredModel);
  return modelId === undefined ? undefined : { developerId: ownerDeveloperId, model: { provider: "openai", modelId } };
}

/** Whose plan a task runs on: a developer task's owner (also when a teammate continues it), else whoever asked. */
export function chatGptOwner(taskOwner: string | undefined, requester: OperationRequester | undefined, slackDeveloperId: (userId: string) => string): string | undefined {
  if (taskOwner !== undefined) return taskOwner;
  if (requester === undefined) return undefined;
  return "kind" in requester ? requester.developerId : slackDeveloperId(requester.userId);
}
