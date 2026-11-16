// TE-H1 browser evidence (DEC 241c): where a laptop's setting lives. Until the company setting (TE-D1) can be read in production, the owner's own config file holds an optional recipe per project
// (`projectSettings.<project>.browserEvidence`: the start command and port the project's app runs with in its sandbox, its pages, and the elements to paint over). Like `sandboxModelHosts`, it is read from the owner's
// file only (nothing a repository, a task or an agent writes reaches it) and read FAIL-CLOSED: a project with no entry, an entry without the recipe, a recipe that does not parse (an unknown key, a bad port or path, a
// start command with a control character), a missing project name, or a name that is not an own key of the settings all mean browser evidence is off. A recipe never turns on by guess or by repair.
import { BrowserEvidenceRecipeSchema, type BrowserEvidenceRecipe, type PluginConfig } from "@agentx/contracts";

export function browserEvidenceRecipeOf(config: Pick<PluginConfig, "projectSettings"> | undefined, project: string | undefined): BrowserEvidenceRecipe | undefined {
  try {
    const settings = config?.projectSettings;
    if (settings === undefined || project === undefined || !Object.hasOwn(settings, project)) return undefined;
    const entry: unknown = settings[project];
    if (typeof entry !== "object" || entry === null || !Object.hasOwn(entry, "browserEvidence")) return undefined;
    const parsed = BrowserEvidenceRecipeSchema.safeParse((entry as { browserEvidence?: unknown }).browserEvidence);
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

// ---- the executor image and the pinned profile (the laptop's half of DEC 241a)

/**
 * The executor image the owner named in `ROVARA_EXECUTOR_IMAGE` (the image built from `environments/e2e-executor`), as one docker argument: a plain reference with no space, no control character and no leading dash. Anything else, or nothing,
 * is no executor image, and then no project asks for browser evidence (the worker could not start the capture).
 */
export function executorImageOf(environment: Readonly<Record<string, string | undefined>> | undefined): string | undefined {
  const value = environment?.["ROVARA_EXECUTOR_IMAGE"]?.trim();
  return value !== undefined && /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/u.test(value) ? value : undefined;
}

/**
 * A JSON text as the docker CLI sends a seccomp profile file: every space, tab and line break outside a string removed, every string kept byte for byte (what Go's `json.Compact` does). The guard compares the profile it was given with
 * what the CLI sends, so the two must be the same text. Throws on text that is not a JSON document.
 */
export function compactJsonText(text: string): string {
  JSON.parse(text);
  let out = "";
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString) {
      out += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
    } else if (character === "\"") { inString = true; out += character; }
    else if (character !== " " && character !== "\t" && character !== "\n" && character !== "\r") out += character;
  }
  return out;
}
