import { agentXError, RunPriceSchema, type RunPrice } from "@agentx/contracts";
import type { TaskTokenDeadline } from "../deadline.js";
import type { TaskTokenDeps, TaskTokenDescription, TaskTokenOperation } from "../token.js";

async function readRunPrice(deps: TaskTokenDeps, description: TaskTokenDescription, deadline?: TaskTokenDeadline): Promise<RunPrice | undefined> {
  try {
    const parsed = RunPriceSchema.safeParse(description.models.length === 1 ? await deps.runPrice?.(description.models[0]!) : undefined);
    deadline?.check();
    if (parsed.success && parsed.data.companyId === description.companyId && parsed.data.model === description.models[0] && parsed.data.expiresAt > (deps.now?.() ?? Date.now())) return parsed.data;
  } catch { /* A failed price read authorizes nothing. */ }
  return undefined;
}

function priceMatchesIdentity(runPrice: RunPrice | undefined, description: TaskTokenDescription): boolean {
  const identity = description.identity;
  return identity === undefined || (runPrice !== undefined && runPrice.provider === identity.provider && runPrice.sourceId === identity.sourceId && runPrice.connectionRevision === identity.connectionRevision && runPrice.catalogModel === identity.modelId);
}

/** Only hosted roots supply the price authority. Never substitute an unpriced hosted token. */
export async function taskRunPrice(deps: TaskTokenDeps, operation: TaskTokenOperation, description: TaskTokenDescription, deadline?: TaskTokenDeadline): Promise<RunPrice | undefined> {
  let runPrice: RunPrice | undefined;
  // The grown tier's review grant carries the signed price like a task step does (the gateway refuses product AI without it); the second and design reviews are held by their ceiling alone.
  if ((operation.reviewerSlot === undefined || description.reviewer?.kind === "tier_review") && (deps.runPrice !== undefined || description.models.some(model => model.includes("/")))) {
    runPrice = await readRunPrice(deps, description, deadline);
    if (!priceMatchesIdentity(runPrice, description)) runPrice = undefined;
    if (description.models.some(model => model.includes("/")) && (runPrice?.provider !== "openrouter" || runPrice.catalogModel !== description.models[0])) runPrice = undefined;
    if (runPrice === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "AgentX does not know this model's price, so it did not start the run");
  }
  return runPrice;
}
