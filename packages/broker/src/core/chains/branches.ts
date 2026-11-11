// Which edge a finished step takes, and how often an edge may be taken. An agent picks only among
// the branch ids the design lists; a pick that is not one of them takes the design's default, and with no default there is no way on. A loop is bounded by the
// `maxTraversals` of an edge on it, which the run counts as `traversals["<from>><to>"]`.
import type { BranchId, ChainStepId, Edge, Next, StepResult } from "@agentx/contracts";

/** The edge a step's result takes. `branch` is the choice the run records (the pick, or the default it fell back to). */
export type ChosenEdge = { edge: Edge; branch?: BranchId; fellBack: boolean } | { error: "branch_invalid" };

const edgeOf = (fields: { to: Edge["to"]; maxTraversals?: number | undefined }): Edge => ({ to: fields.to, ...(fields.maxTraversals === undefined ? {} : { maxTraversals: fields.maxTraversals }) });

/**
 * `go` takes its edge and `end` ends the run. A `branch` takes the choice whose id is `result.branch`; any other value (or none) takes the `default` choice, flagged
 * as a fall-back; with no default the answer is `branch_invalid`, which fails the run.
 */
export function chooseEdge(next: Next, result: StepResult): ChosenEdge {
  if (next.kind === "go") return { edge: edgeOf(next), fellBack: false };
  if (next.kind === "end") return { edge: { to: "$end" }, fellBack: false };
  const picked = next.choices.find((choice) => choice.id === result.branch);
  if (picked !== undefined) return { edge: edgeOf(picked), branch: picked.id, fellBack: false };
  const fallback = next.default === undefined ? undefined : next.choices.find((choice) => choice.id === next.default);
  return fallback === undefined ? { error: "branch_invalid" } : { edge: edgeOf(fallback), branch: fallback.id, fellBack: true };
}

/** Takes an edge: counts it, or refuses it when it has been taken `maxTraversals` times already. */
export function takeEdge(run: { traversals: Readonly<Record<string, number>> }, from: ChainStepId, edge: Edge): { ok: true; traversals: Record<string, number> } | { ok: false; message: string } {
  const key = `${from}>${edge.to}`;
  const count = (run.traversals[key] ?? 0) + 1;
  if (edge.maxTraversals !== undefined && count > edge.maxTraversals) {
    return { ok: false, message: `Step "${edge.to}" was reached ${String(count)} times from "${from}", the most this chain allows.` };
  }
  return { ok: true, traversals: { ...run.traversals, [key]: count } };
}
