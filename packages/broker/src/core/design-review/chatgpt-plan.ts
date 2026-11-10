// Design review stage: whether a step may run on a person's own ChatGPT plan. A design review never does: its reviewers and its merge step run on the model proxy with one key per slot, billed to the customer, and
// never on a plan that belongs to one person. This is the one rule both places in the operation builder  read: the task's ordinary plan selection, and a governed stage whose resolved source
// is the personal plan. Pure.

export interface ChatgptPlanUseInput {
  /** The step's own model source dropped the plan (`dropChatgpt`). */
  dropChatgpt: boolean;
  /** The step is an agent's run (never a person's own coding turn). */
  agentRun: boolean;
  /** The operation is a design review round. */
  designReview: boolean;
  /** A governed stage resolved the personal ChatGPT plan as its source. */
  governedPersonal: boolean;
}

/** `selection`: the task's plan selection may be kept for the step. `governed`: the step is to run on the verified personal plan the governed stage resolved. A design review gets neither. */
export function chatgptPlanUse(input: ChatgptPlanUseInput): { selection: boolean; governed: boolean } {
  return { selection: !input.dropChatgpt && !input.agentRun && !input.designReview, governed: !input.designReview && input.governedPersonal };
}
