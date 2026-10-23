// `agentx admin project register --file` (M1.4 Task 4.10D, review I-2): the documented way to set a project's models runs the same model check as project add. The environment's settings (its region
// and key configuration) are read the way the setup commands read them; a computer that cannot read them registers anyway, says so, and sends no stale check result.
import type { ProjectDefinition } from "@agentx/contracts";
import type { ParameterStore } from "../environments/parameter-store.js";
import { readEnvironmentSettings } from "../environments/settings.js";
import { checkProjectModels, type ProjectModelChecker } from "./project-model-check.js";

export async function checkModelsForRegistration(input: {
  definition: ProjectDefinition; env: string; store: ParameterStore;
  /** The check for an environment's settings (the real one builds its AWS checks from them). */
  checker: (settings: NonNullable<Awaited<ReturnType<typeof readEnvironmentSettings>>>) => ProjectModelChecker;
  acceptUncheckedModel?: string | undefined;
}): Promise<{ definition: ProjectDefinition; warnings: string[] }> {
  if (input.definition.models === undefined) return { definition: input.definition, warnings: [] };
  let settings: Awaited<ReturnType<typeof readEnvironmentSettings>>;
  try { settings = await readEnvironmentSettings(input.store, input.env); } catch { settings = undefined; }
  if (settings === undefined) {
    const unchecked = await checkProjectModels({ definition: input.definition, check: undefined });
    return { definition: unchecked.definition, warnings: [`The project's models were not checked: this computer cannot read the settings of environment ${input.env}. Run agentx --env ${input.env} doctor to check them.`] };
  }
  return checkProjectModels({
    definition: input.definition, check: input.checker(settings),
    ...(input.acceptUncheckedModel === undefined ? {} : { acceptUnchecked: { reason: input.acceptUncheckedModel } }),
  });
}
