// Knowledge resolver (K1, C1): size budgets and the drop order.
//
// Two pools, each with its own byte budget: the always-on items, and the additions (fileMatch, manual and auto items that were
// activated). When a pool is over its budget, items are dropped farthest-first in the order the design names: folder before repo
// before meta (then project, group and company). Inside one layer the deeper folder goes first, then the larger file, then the later path, so the same
// inputs always drop the same files. A locked company rule is never dropped; if locked rules alone exceed the always-on budget the
// caller fails the stage closed ("Company rules exceed the size budget") so an admin fixes the rules.
import { KNOWLEDGE_LAYER_ORDER, type KnowledgeBudgets, type KnowledgeItem } from "./model.js";

export interface BudgetPoolResult {
  kept: KnowledgeItem[];
  dropped: KnowledgeItem[];
  bytes: number;
  /** True when locked items alone are over the pool's budget: nothing droppable can fix it. */
  lockedOverflow: boolean;
}

export interface BudgetResult {
  alwaysOn: BudgetPoolResult;
  additions: BudgetPoolResult;
}

/** The order items are dropped in: first in the list is dropped first. */
const DROP_ORDER = [...KNOWLEDGE_LAYER_ORDER].reverse();

const depthOf = (scopeDir: string): number => (scopeDir === "" ? 0 : scopeDir.split("/").length);

function dropRank(item: KnowledgeItem): number {
  return DROP_ORDER.indexOf(item.layer);
}

/** Droppable items in the order they would go. Exported for the tests that pin the order. */
export function dropOrder(items: readonly KnowledgeItem[]): KnowledgeItem[] {
  return items
    .filter((item) => item.locked !== true)
    .toSorted((left, right) =>
      dropRank(left) - dropRank(right)
      || depthOf(right.scopeDir) - depthOf(left.scopeDir)
      // The larger file goes first, so fewer files are lost to make room.
      || right.bytes - left.bytes
      || (right.path ?? "").localeCompare(left.path ?? "")
      || (right.name ?? "").localeCompare(left.name ?? ""));
}

export function fitPool(items: readonly KnowledgeItem[], budgetBytes: number): BudgetPoolResult {
  let bytes = items.reduce((sum, item) => sum + item.bytes, 0);
  const lockedBytes = items.filter((item) => item.locked === true).reduce((sum, item) => sum + item.bytes, 0);
  const dropped = new Set<KnowledgeItem>();
  for (const candidate of dropOrder(items)) {
    if (bytes <= budgetBytes) break;
    dropped.add(candidate);
    bytes -= candidate.bytes;
  }
  return {
    kept: items.filter((item) => !dropped.has(item)),
    dropped: items.filter((item) => dropped.has(item)),
    bytes,
    lockedOverflow: lockedBytes > budgetBytes,
  };
}

/** Splits already-activated items into the always-on pool and the additions pool and fits each. */
export function applyBudget(items: readonly KnowledgeItem[], budgets: KnowledgeBudgets): BudgetResult {
  return {
    alwaysOn: fitPool(items.filter((item) => item.activation === "always"), budgets.alwaysOnBytes),
    additions: fitPool(items.filter((item) => item.activation !== "always"), budgets.additionsBytes),
  };
}
