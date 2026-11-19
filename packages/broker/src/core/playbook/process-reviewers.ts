// "How we work": what the reviewing stages of a project's process see. The plan check, the code and security reviewers and the pull request feedback review of a run whose recipe has a process layer in its
// chain receive Rovara's built-in layers and the instructions written on the stage itself, but not the whole-agent ("project-wide") layers the process layer wrote: the project can steer how
// work is built, but cannot steer, through a general rule, the stages that check it. Any other recipe, and any other step, gets every layer as before.
import type { InstructionLayer, ResolvedRecipe, ResolvedStep } from "@agentx/contracts";

/**
 * The stages that check work: the plan check (`plan_critic`), the review step, which runs the code and the security reviewer, and the pull request step, which runs the review of a pull
 * request's feedback (`FEEDBACK_REVIEW`). It is not a merge gate, but a project-wide rule such as "ignore comments from X" could still shape what it reports.
 */
export const isReviewingStage = (step: ResolvedStep | undefined): boolean => step !== undefined && (step.kind === "plan_critic" || step.kind === "review" || step.kind === "pull_request");

/**
 * The skills `step` is given. A reviewing stage of a recipe with a process layer in its chain is given none: a project's process layer can't add skills, and one stored with skills
 * anyway must not reach the stages that check the work. Rovara Code, the only base a process layer has, carries none. Any other recipe, and any other step, gets every skill as before.
 */
export function skillsForStep(recipe: ResolvedRecipe, step: ResolvedStep | undefined): ResolvedRecipe["skills"] {
  return isReviewingStage(step) && recipe.chain.some((entry) => entry.process === true && !entry.builtin) ? [] : recipe.skills;
}

/**
 * The whole-agent instruction layers `step` is given, base agent first. For a reviewing stage of a recipe with a process layer in its chain, the layers that process layer wrote are left
 * out (a layer is tied to its writer by the agent's name, which is unique in the company, and the chain entry the resolver marked `process`).
 */
export function wholeAgentLayers(recipe: ResolvedRecipe, step: ResolvedStep | undefined): InstructionLayer[] {
  if (!isReviewingStage(step)) return recipe.instructions;
  const written = new Set(recipe.chain.filter((entry) => entry.process === true && !entry.builtin).map((entry) => entry.name));
  return written.size === 0 ? recipe.instructions : recipe.instructions.filter((layer) => !written.has(layer.agentName));
}

/**
 * The instruction layers written on `step` itself that the operation `mode` is given. The pull request feedback review (`FEEDBACK_REVIEW`) of a run with a process layer in its chain is given none
 * of the ones that process layer wrote: a stage rule there would shape what the review reports with no second person having approved it, exactly as project-wide rules are kept from every
 * reviewing stage. The same step writing the pull request description (any other operation) keeps them, and so do Rovara's built-in layers and any ordinary agent's.
 */
export function stepInstructionLayers(recipe: ResolvedRecipe, step: ResolvedStep | undefined, mode: string | undefined): InstructionLayer[] {
  const layers: InstructionLayer[] = step?.settings?.instructions ?? [];
  if (mode !== "FEEDBACK_REVIEW") return layers;
  const written = new Set(recipe.chain.filter((entry) => entry.process === true && !entry.builtin).map((entry) => entry.name));
  return written.size === 0 ? layers : layers.filter((layer) => !written.has(layer.agentName));
}
