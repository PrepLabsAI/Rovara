// TE-H1 browser evidence, slice 3: where a project's recipe is kept and which one a run uses.
//   - The recipe screen (the local page `/browser-evidence/<project>`) saves the owner's recipe as ONE company-scoped row per project (`projectBrowserEvidenceRecipeKey`, beside the project's own rows). The row holds the recipe
//     exactly as `BrowserEvidenceRecipeSchema` reads it and nothing secret: a sign-in is a form and the NAME of the saved sign-in, never its values (browser-evidence-sign-in.ts).
//   - The owner's config file (`projectSettings.<project>.browserEvidence`, DEC 241c) stays the stronger source: when it names a recipe for the project, that is the recipe, and the page shows it read-only.
//   - Fails closed everywhere: a row that does not read as a recipe for exactly this company and project (another company's, another project's, a different shape, a sign-in naming another project's secret) is NO recipe, which
//     means browser evidence is off for the project. Nothing here ever returns a guess or a half recipe.
import {
  BrowserEvidenceRecipeSchema, agentXError, isBrowserEvidenceSignInRefOf, projectBrowserEvidenceRecipeKey, when,
  type BrowserEvidenceRecipe, type DocumentStore, type OrgId, type StoredDocument,
} from "@agentx/contracts";

export const BROWSER_EVIDENCE_RECIPE_ENTITY = "BROWSER_EVIDENCE_RECIPE";
export const RECIPE_WORDS = {
  invalid: "That recipe is not valid. Check the start command, the port, the pages and the sign-in form.",
  badSignIn: "The sign-in is saved under the project's own name only.",
  changed: "The recipe changed while you were looking. Read it again, then save.",
} as const;

export interface StoredBrowserEvidenceRecipe { recipe: BrowserEvidenceRecipe; version: number; updatedAt: string }

/** A recipe fit to be used for `project`: valid, and with a sign-in (if any) that is this project's own. */
export function recipeFitsProject(project: string, recipe: unknown): recipe is BrowserEvidenceRecipe {
  const parsed = BrowserEvidenceRecipeSchema.safeParse(recipe);
  return parsed.success && (parsed.data.signIn === undefined || isBrowserEvidenceSignInRefOf(project, parsed.data.signIn.credentialRef));
}

function recipeOfRow(row: StoredDocument | undefined, orgId: OrgId, project: string): StoredBrowserEvidenceRecipe | undefined {
  if (row === undefined || row["entityType"] !== BROWSER_EVIDENCE_RECIPE_ENTITY || row["orgId"] !== orgId || row["project"] !== project) return undefined;
  const version = row["version"];
  const updatedAt = row["updatedAt"];
  if (!Number.isSafeInteger(version) || (version as number) < 1 || typeof updatedAt !== "string") return undefined;
  const parsed = BrowserEvidenceRecipeSchema.safeParse(row["recipe"]);
  if (!parsed.success || !recipeFitsProject(project, parsed.data)) return undefined;
  return { recipe: parsed.data, version: version as number, updatedAt };
}

/** The project's saved recipe, or undefined (none saved, or one that does not read for this company and project). Never throws for a stored row. */
export async function readStoredRecipe(store: Pick<DocumentStore, "get">, orgId: OrgId, project: string): Promise<StoredBrowserEvidenceRecipe | undefined> {
  return recipeOfRow(await store.get(projectBrowserEvidenceRecipeKey(orgId, project)), orgId, project);
}

/**
 * Saves the recipe as the project's. `expectedVersion` is the version the owner was looking at (`undefined`: none was saved): another version is refused with one sentence, so two pages never overwrite each other unseen.
 * The recipe is checked whole by its schema, and its sign-in must name this project's own saved sign-in.
 */
export async function saveStoredRecipe(store: Pick<DocumentStore, "get" | "put">, orgId: OrgId, project: string, recipe: unknown, input: { expectedVersion: number | undefined; now: () => number }): Promise<{ version: number }> {
  const parsed = BrowserEvidenceRecipeSchema.safeParse(recipe);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", RECIPE_WORDS.invalid);
  if (!recipeFitsProject(project, parsed.data)) throw agentXError("CONFIG_INVALID", RECIPE_WORDS.badSignIn);
  const key = projectBrowserEvidenceRecipeKey(orgId, project);
  const at = new Date(input.now()).toISOString();
  const document = (version: number) => ({ ...key, entityType: BROWSER_EVIDENCE_RECIPE_ENTITY, orgId, project, recipe: JSON.parse(JSON.stringify(parsed.data)) as never, version, updatedAt: at });
  if (input.expectedVersion === undefined) {
    // Nothing saved: written only if still nothing is. A row that is there but does not read as this project's recipe (a damaged or foreign one) is replaced, never left to refuse every save for good.
    const row = await store.get(key);
    const written = await store.put({ item: document(1), condition: row === undefined || recipeOfRow(row, orgId, project) !== undefined ? when.absent() : when.present() });
    if (!written.applied) throw agentXError("CHANGE_STALE", RECIPE_WORDS.changed);
    return { version: 1 };
  }
  const next = input.expectedVersion + 1;
  const written = await store.put({ item: document(next), condition: when.and(when.eq("version", input.expectedVersion), when.eq("orgId", orgId), when.eq("project", project)) });
  if (!written.applied) throw agentXError("CHANGE_STALE", RECIPE_WORDS.changed);
  return { version: next };
}

/** Takes the project's saved recipe away (browser evidence is then off for it unless the owner's config names one). A row that is not there is already gone. */
export async function clearStoredRecipe(store: Pick<DocumentStore, "delete">, orgId: OrgId, project: string): Promise<void> {
  await store.delete({ key: projectBrowserEvidenceRecipeKey(orgId, project) });
}

export type EffectiveRecipe = { source: "config" | "page"; recipe: BrowserEvidenceRecipe; version?: number };

/**
 * The recipe a run of `project` uses: the owner's config file's, when it has one that is valid for the project; otherwise the page's saved one. A config recipe that is there but not valid is NOT replaced by the page's: the
 * stronger source said something and it could not be read, so browser evidence is off (fail closed), never silently another recipe.
 */
export async function effectiveRecipe(input: { store: Pick<DocumentStore, "get">; orgId: OrgId; project: string; fromConfig: BrowserEvidenceRecipe | undefined | (() => BrowserEvidenceRecipe | undefined) }): Promise<EffectiveRecipe | undefined> {
  const fromConfig = typeof input.fromConfig === "function" ? input.fromConfig() : input.fromConfig;
  if (fromConfig !== undefined) return recipeFitsProject(input.project, fromConfig) ? { source: "config", recipe: fromConfig } : undefined;
  const stored = await readStoredRecipe(input.store, input.orgId, input.project);
  return stored === undefined ? undefined : { source: "page", recipe: stored.recipe, version: stored.version };
}

