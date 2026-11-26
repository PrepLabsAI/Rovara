// The install's price lookup: the registered `model-provider` plug-ins' own tables, then the installed catalog's list prices (`core/cost/price-table.ts`). One function, so the metering port,
// the second review's cap and the per-step model rule all ask the same table. The providers are read at each lookup because they are loaded after the install starts.
import type { AdapterRegistry } from "@agentx/contracts";
import { listPricesPerMillion } from "@agentx/model-runtime/catalog";
import { createModelPrices, type ModelPrices } from "../core/cost/price-table.js";

export function registryModelPrices(registry: Pick<AdapterRegistry, "names" | "require">): ModelPrices {
  return createModelPrices({ providers: () => registry.names("model-provider").map((name) => registry.require("model-provider", name)), catalog: listPricesPerMillion });
}
