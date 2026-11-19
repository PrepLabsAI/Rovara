// Design review stage: the `approve_spend` card SOURCE for the cost gate. It turns a gate decision (`estimate.ts`, `gateDesignReviewCost`) into the pending item the decision projector
// (`decisions/project.ts`) makes a card from. Pure: no store, no clock, no route. The card's tier comes from `riskTierOf` alone (by the amount asked; "cost unavailable" asks for nothing priced, so it is low),
// and the choices are `choose` actions, each a POST of this server. The route that receives them (and re-checks the caller's live authority, the skip rules and the lock) is wiring pending .
import { type DesignReviewTier } from "@agentx/contracts";
import type { DecisionItem } from "../decisions/project.js";
import type { DesignReviewCapGate, DesignSpendChoice } from "./estimate.js";

/**
 * What the card asks for, by which its tier is worked out: the estimate when there is one; with NO price ("run it anyway") it is what the run may spend at most, the room left under the cap, so an unpriced run is
 * never low risk by default.
 */
export const designSpendAmountUsd = (gate: Extract<DesignReviewCapGate, { kind: "ask" }>, capUsd: number, spentUsd: number): number => gate.estimateUsd ?? Math.max(0, Math.round((capUsd - spentUsd) * 1e6) / 1e6);

/** The choices a person can make on the card; the last path segment of each action. */
export const DESIGN_SPEND_CHOICE_SEGMENTS = { lower_tier: "lower-tier", raise_cap: "raise-cap", run_unpriced: "run-unpriced", skip: "skip" } as const;

/** `/v1/app/tasks/{taskId}/design-review/spend/{choice}`: one POST per choice. The path only names the choice; the amount or tier is read from the task's own record, never from the request. */
export const designSpendChoicePath = (taskId: string, choice: DesignSpendChoice["choice"]): string => `/v1/app/tasks/${taskId}/design-review/spend/${DESIGN_SPEND_CHOICE_SEGMENTS[choice]}`;

const usd = (value: number): string => `$${value.toFixed(2)}`;
const TIER_WORDS: Record<DesignReviewTier, string> = { light: "Light", standard: "Standard", thorough: "Thorough" };

function labelOf(choice: DesignSpendChoice): string {
  switch (choice.choice) {
    case "lower_tier": return `Run ${TIER_WORDS[choice.tier]} (about ${usd(choice.estimateUsd)})`;
    case "raise_cap": return `Raise the limit to ${usd(choice.newCapUsd)}`;
    case "run_unpriced": return "Run it anyway";
    case "skip": return "Skip design review";
  }
}

export interface DesignSpendCardInput {
  /** The task and project the gate stopped. `subjectId` is stable per task and gate: a second gate on the same task is the same card. */
  taskId: string;
  subjectId: string;
  project: string;
  title: string;
  createdAt: string;
  openPath: string;
  /** The gate's answer (`kind: "ask"`). */
  gate: Extract<DesignReviewCapGate, { kind: "ask" }>;
  capUsd: number;
  /** What the review has spent already (the unpriced card is tiered by the room left under the cap). */
  spentUsd?: number | undefined;
  /** A version of what the person is shown: the design digest and the gate's inputs, so a changed design or cap makes an earlier look worthless. */
  contentVersion: string;
}

/**
 * The pending item for a gate that stopped a design review. Over the cap: up to three choices (the next lower tier if it fits, raise the cap for this task, skip if the rules allow). No price: "Cost
 * unavailable", where running it is one tap. A gate with no choice left produces a card that only opens the page: the task waits, nothing runs, nothing is approved by default.
 */
export function designSpendCardItem(input: DesignSpendCardInput): DecisionItem {
  const { gate } = input;
  return {
    kind: "approve_spend",
    subjectId: input.subjectId,
    taskId: input.taskId,
    project: input.project,
    title: input.title,
    createdAt: input.createdAt,
    openPath: input.openPath,
    contentVersion: input.contentVersion,
    // An over-cap card is tiered by what it would spend, like any spend request; "cost unavailable" by what the run may spend at most (the room left under the cap).
    amountUsd: designSpendAmountUsd(gate, input.capUsd, input.spentUsd ?? 0),
    scopeLabel: "this design review",
    design: {
      why: gate.why,
      capUsd: input.capUsd,
      ...(gate.estimateUsd === undefined ? {} : { estimateUsd: gate.estimateUsd }),
      choices: gate.choices.map((choice) => ({ label: labelOf(choice), href: designSpendChoicePath(input.taskId, choice.choice) })),
    },
  };
}
