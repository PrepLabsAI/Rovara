// DEC 253k: the eval spend capabilities with the adapter the install BOUND at its `eval-reservation` plug-in point, and only that one. Code binds none, so the answer is
// "spend not approved"; a deployed install with the model gateway binds `core-host/eval-authority-http.ts`. A caller never supplies its own adapter here.
import type { AdapterRegistry, EvalReservationAdapter, EvalSpendApproval, MonthlyMeter } from "@agentx/contracts";
import { createEvalSpendCapabilities } from "./eval-spend.js";

/** The one adapter bound at `eval-reservation`, or undefined when none is (or the registry cannot say). */
export function boundEvalReservation(registry: Pick<AdapterRegistry, "names" | "get">): EvalReservationAdapter | undefined {
  try {
    const names = registry.names("eval-reservation");
    return names.length === 1 ? registry.get("eval-reservation", names[0]!) : undefined;
  } catch { return undefined; }
}

type CapabilityOptions = Omit<Parameters<typeof createEvalSpendCapabilities>[0], "adapter">;

/** `createEvalSpendCapabilities` over the bound adapter. An `adapter` in `options` is ignored: the registry's is the only one. */
export function createBoundEvalSpendCapabilities(registry: Pick<AdapterRegistry, "names" | "get">, options: CapabilityOptions): { approval: EvalSpendApproval; meter: MonthlyMeter } {
  const { adapter: _ignored, ...rest } = options as CapabilityOptions & { adapter?: unknown };
  void _ignored;
  const adapter = boundEvalReservation(registry);
  return createEvalSpendCapabilities({ ...rest, ...(adapter === undefined ? {} : { adapter }) });
}
