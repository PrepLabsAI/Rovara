// "How we work" in Rovara Code: the recipe a project runs. It is Rovara Code (the built-in, at its newest released version) with the playbook file's process layer on top, exactly the shape
// Cloud resolves for a project that has a process layer: a chain of the built-in and a layer marked `process`. Everything that reads "what does this stage get told" reads this recipe, so the
// view, the standing block and the reviewers' exclusions (`process-reviewers.ts`) are Cloud's own functions over it.
import {
  ROVARA_CODE_AGENT_ID,
  applyOverlay,
  builtinRecipe,
  currentBuiltinVersion,
  type PlaybookFile,
  type RecipeLayer,
  type RecipeOverlay,
  type ResolvedRecipe,
} from "@agentx/contracts";
import { overlayOfPlaybook } from "./file.js";

/** The name the file's layer writes under: it is what the standing block prints above the file's text, so the model (and a person reading the block) can see where the rules came from. */
export const PLAYBOOK_LAYER_NAME = ".rovara/playbook.yaml";
/** The layer's id in the recipe's chain. A file is not an agent, so this id belongs to no agent record; it is the same for every project and never stored. */
export const PLAYBOOK_LAYER_AGENT_ID = "agt_playbookfile00000000";

const LAYER: RecipeLayer = { agentId: PLAYBOOK_LAYER_AGENT_ID, name: PLAYBOOK_LAYER_NAME, version: 1, builtin: false, process: true };

/** The process the project runs: the recipe, the built-in it is built on, and the overlay the file wrote (none for no file). */
export interface RunningProcess {
  recipe: ResolvedRecipe;
  base: ResolvedRecipe;
  overlay: RecipeOverlay | undefined;
}

/** Rovara Code at its newest released version, with the file's layer on top when there is one. */
export function runningProcessOf(file: PlaybookFile | undefined): RunningProcess {
  const base = builtinRecipe(ROVARA_CODE_AGENT_ID, currentBuiltinVersion(ROVARA_CODE_AGENT_ID));
  if (file === undefined) return { recipe: base, base, overlay: undefined };
  const overlay = overlayOfPlaybook(file);
  if (overlay.instructions === undefined && overlay.steps === undefined) return { recipe: base, base, overlay: undefined };
  return { recipe: applyOverlay(base, overlay, LAYER), base, overlay };
}
