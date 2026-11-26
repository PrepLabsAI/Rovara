// TE-H1 browser evidence, slice 3, on a laptop: the recipe page's data and actions, and the recipe a run of a project uses.
//   - Which recipe a run uses: the owner's config file's (`projectSettings.<project>.browserEvidence`, DEC 241c) when it has one, otherwise the one saved on the page (core/proof/browser-evidence-recipe.ts). Either is dropped, and
//     browser evidence is off for the project, when it does not read, or when its sign-in names another project's saved sign-in.
//   - What the page may do: save, replace or remove the project's recipe and its saved sign-in. Every one is the owner's own act on a page session opened in the last few minutes (`context.fresh`, checked again here); the API
//     token refuses all of them (`BROWSER_EVIDENCE_ON_THE_PAGE`). The recipe lives in the company's own rows and the sign-in's values in the company's own secret path; nothing the page says back holds either value.
//   - What the page reads: never a value, only whether a usable sign-in is saved, and the setup agent's last suggestion, read from its stored result (no code host call), as text for the owner to read and then save.
import { AgentXError, browserEvidenceVideoWanted, type AuditSink, type BrowserEvidenceRecipe, type DocumentStore, type OrgId } from "@agentx/contracts";
import type { BrowserEvidencePageAction, BrowserEvidencePageView, LocalActionResult } from "../../core/local-pages/views.js";
import { clearStoredRecipe, effectiveRecipe, readStoredRecipe, saveStoredRecipe } from "../../core/proof/browser-evidence-recipe.js";
import type { BrowserEvidenceSignIn } from "../../core/proof/browser-evidence-sign-in.js";
import type { BrokerRequest, BrokerResponse } from "../../handler.js";
import { listProjects } from "../../core-host/app/projects.js";

export const BROWSER_EVIDENCE_ON_THE_PAGE = "A project's browser evidence recipe and its saved sign-in are changed on their local page, by you, in a page session opened within the last ten minutes. Run `rovara open browser-evidence` to open it; an assistant cannot change them for you, and neither can this token.";
export const NEEDS_FRESH_PAGE = "That change needs a page you opened in the last few minutes. Run `rovara open browser-evidence` to open one.";

/** The API addresses a tool might try: a project's recipe and its saved sign-in. They are answered with the page's own sentence and nothing else, whatever the method and whoever asks: there is no way to read or change either with a token. */
const API_PATH = /^\/v1\/app\/projects\/[a-z][a-z0-9-]{0,62}\/browser-evidence(?:\/sign-in)?$/u;

export interface LocalBrowserEvidenceOptions {
  store: DocumentStore;
  companyId: OrgId;
  now: () => number;
  /** The company's saved sign-ins (the laptop's secret files, in the company's own folder). */
  signIn: BrowserEvidenceSignIn;
  /** The owner's config file's recipe for a project, read fail-closed (the runtime's `browserEvidenceRecipeOf`). */
  fromConfig: (project: string) => BrowserEvidenceRecipe | undefined;
  /** Whether this machine can start the executor image (browser evidence can run here at all). */
  canRun: () => Promise<boolean>;
  /** The setup agent's last suggestion for the project, from its stored result; undefined when there is none. */
  suggestion?: ((project: string) => Promise<BrowserEvidencePageView["suggestion"] | undefined>) | undefined;
  audit?: Pick<AuditSink, "record"> | undefined;
}

export interface LocalBrowserEvidence {
  /** The recipe a run of this project's task uses, or undefined (browser evidence off). Never throws: a fault is no recipe. */
  recipeFor(project: string): Promise<BrowserEvidenceRecipe | undefined>;
  /** The API's refusal (`BROWSER_EVIDENCE_ON_THE_PAGE`) for the addresses above; undefined for any other address. */
  routes(request: BrokerRequest): Promise<BrokerResponse | undefined>;
  /** What the worker's sign-in callback reads from (the company's saved sign-ins). */
  readonly signInReader: Pick<BrowserEvidenceSignIn, "read">;
  projects(): Promise<string[]>;
  page(project: string): Promise<BrowserEvidencePageView | undefined>;
  action(input: BrowserEvidencePageAction, context: { fresh: boolean }): Promise<LocalActionResult>;
}

const refusal = (error: unknown): LocalActionResult => {
  if (!(error instanceof AgentXError)) throw error;
  return { ok: false, reason: error.code === "CHANGE_STALE" ? "stale" : error.code === "CONFIG_INVALID" ? "invalid" : error.code === "NOT_FOUND" ? "not_found" : "refused", message: error.message.slice(error.code.length + 2) };
};

export function createLocalBrowserEvidence(options: LocalBrowserEvidenceOptions): LocalBrowserEvidence {
  const { store, companyId } = options;
  const known = async (): Promise<string[]> => (await listProjects(store, companyId)).map((project) => project.name).sort();
  const audit = async (action: string, project: string, video = false): Promise<void> => {
    const at = new Date(options.now()).toISOString();
    // The record names the project and the act, never a value; a ledger that cannot be written never undoes or blocks the owner's act.
    await options.audit?.record({ eventId: `evt_${action.replace(/\./gu, "_")}_${project}_${String(options.now())}`, companyId, at, actor: { type: "person", id: "owner" }, action, details: { project, ...(video ? { video: "on" } : {}) } }).catch(() => undefined);
  };
  const recipeFor = async (project: string): Promise<BrowserEvidenceRecipe | undefined> => {
    try { return (await effectiveRecipe({ store, orgId: companyId, project, fromConfig: () => options.fromConfig(project) }))?.recipe; } catch { return undefined; }
  };
  return {
    recipeFor,
    signInReader: options.signIn,
    async routes(request) {
      if (!API_PATH.test(request.path.split("?")[0] ?? request.path)) return undefined;
      return { statusCode: 403, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: { code: "FORBIDDEN", message: BROWSER_EVIDENCE_ON_THE_PAGE } }) };
    },
    projects: known,
    async page(project) {
      if (!(await known()).includes(project)) return undefined;
      const effective = await effectiveRecipe({ store, orgId: companyId, project, fromConfig: () => options.fromConfig(project) }).catch(() => undefined);
      const stored = await readStoredRecipe(store, companyId, project).catch(() => undefined);
      const suggestion = await options.suggestion?.(project).catch(() => undefined);
      return {
        project, source: effective?.source ?? "none", ...(effective === undefined ? {} : { recipe: effective.recipe }), ...(stored === undefined ? {} : { version: stored.version }),
        signInSaved: await options.signIn.has(companyId, project).catch(() => false), ...(suggestion === undefined ? {} : { suggestion }), canRun: await options.canRun().catch(() => false),
      };
    },
    async action(input, context) {
      // The owner's own act, in a page opened a few minutes ago: checked here as well as where the form was received.
      if (!context.fresh) return { ok: false, reason: "reauth", message: NEEDS_FRESH_PAGE };
      try {
        if (!(await known()).includes(input.project)) return { ok: false, reason: "not_found", message: "That project is not here." };
        switch (input.op) {
          case "save": {
            // The owner's config file is the stronger source: a page recipe saved under it would never run, so it is refused rather than hidden.
            if (options.fromConfig(input.project) !== undefined) return { ok: false, reason: "refused", message: "This project's recipe is set in your config file. Change it there." };
            await saveStoredRecipe(store, companyId, input.project, input.recipe, { expectedVersion: input.expectedVersion, now: options.now });
            // A recipe that asks for video says so in the record: it is the one choice that records the live page.
            await audit("browser_evidence.recipe_saved", input.project, browserEvidenceVideoWanted(input.recipe));
            return { ok: true, message: "Saved." };
          }
          case "turn-off": {
            if (options.fromConfig(input.project) !== undefined) return { ok: false, reason: "refused", message: "This project's recipe is set in your config file. Change it there." };
            await clearStoredRecipe(store, companyId, input.project);
            await audit("browser_evidence.recipe_removed", input.project);
            return { ok: true, message: "Browser evidence is off for this project." };
          }
          case "save-sign-in": {
            await options.signIn.save(companyId, input.project, { username: input.username, password: input.password });
            await audit("browser_evidence.sign_in_saved", input.project);
            return { ok: true, message: "The sign-in is saved." };
          }
          case "clear-sign-in": {
            await options.signIn.clear(companyId, input.project);
            await audit("browser_evidence.sign_in_removed", input.project);
            return { ok: true, message: "The saved sign-in is removed." };
          }
        }
      } catch (error) {
        // Only an `AgentXError` carries a sentence of ours; anything else (a store fault, a file error) is rethrown by `refusal` and never shown, as it could hold a path.
        return refusal(error);
      }
    },
  };
}

