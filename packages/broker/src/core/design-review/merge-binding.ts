// Design review stage: the merge step's prompt comes from the broker's registry ONLY. The binding the worker is sent carries the prompt text (the worker cannot import the
// broker's registry), but the text is never a free input: it is looked up by id and version here, and a binding whose text is anything else is refused. builds `merge` with `mergeBindingFor` and
// checks a stored binding with `bindingMergeProblem` before it dispatches or records the merge step. The prompt's digest is `promptDigest` of the registry entry (recorded with the run).
import { promptDigest, type DesignReviewBinding } from "@agentx/contracts";
import { MERGE_PROMPT, type ReviewPrompt } from "./prompts/index.js";

/** The merge prompts the registry holds, by id and version. Today one. Another version is added here, never taken from a caller. */
const MERGE_PROMPTS: readonly ReviewPrompt[] = [MERGE_PROMPT];

export type BindingMerge = NonNullable<DesignReviewBinding["merge"]>;
export type MergeBindingProblem = "unknown_merge_prompt" | "merge_prompt_text_differs";

/** The registered merge prompt with this id and version, or undefined. */
export function mergePromptFromRegistry(id: string, version: number): ReviewPrompt | undefined {
  return MERGE_PROMPTS.find((prompt) => prompt.id === id && prompt.version === version);
}

/** The binding's `merge` entry, made from the registry. The caller supplies the slot and the model; the prompt is not an input. */
export function mergeBindingFor(input: { keySlot: string; model: BindingMerge["model"]; modelRoute?: BindingMerge["modelRoute"] }): BindingMerge {
  return {
    keySlot: input.keySlot, model: input.model, ...(input.modelRoute === undefined ? {} : { modelRoute: input.modelRoute }),
    prompt: { id: MERGE_PROMPT.id, version: MERGE_PROMPT.version, text: MERGE_PROMPT.text },
  };
}

/** Whether a binding's merge prompt is exactly a registered one (id, version AND text). Free text, an edited registry text or an unknown version is a problem. A binding with no merge step has none. */
export function bindingMergeProblem(binding: Pick<DesignReviewBinding, "merge">): MergeBindingProblem | undefined {
  if (binding.merge === undefined) return undefined;
  const registered = mergePromptFromRegistry(binding.merge.prompt.id, binding.merge.prompt.version);
  if (registered === undefined) return "unknown_merge_prompt";
  return registered.text === binding.merge.prompt.text ? undefined : "merge_prompt_text_differs";
}

/** The digest recorded for the merge step's prompt (the registry's, so a binding cannot choose it). Undefined when the binding's prompt is not a registered one. */
export function bindingMergePromptDigest(binding: Pick<DesignReviewBinding, "merge">): string | undefined {
  if (binding.merge === undefined || bindingMergeProblem(binding) !== undefined) return undefined;
  const registered = mergePromptFromRegistry(binding.merge.prompt.id, binding.merge.prompt.version);
  return registered === undefined ? undefined : promptDigest(registered);
}
