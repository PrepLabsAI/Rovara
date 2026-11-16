// TE-H1 browser evidence, slice 3: a recipe page form as a recipe. Plain text in, a recipe object out, and nothing else: the contract's schema (`BrowserEvidenceRecipeSchema`) judges it afterwards, here and again where it is saved.
// Whole or nothing: a line that does not read, a number that is not one, or more lines than the recipe may have is `undefined` for the WHOLE form, never a recipe with a line quietly left out.
//   routes      one page per line: its path, then the repository files that make it (globs, comma or space between): `/checkout src/checkout/**, src/cart/**`
//   mask        one CSS selector per line
//   sign-in     the login page, three selectors and the page (or element) that says "signed in"; the saved sign-in is named by the project, never typed here
import { BROWSER_EVIDENCE_MASK_SELECTORS_MAX, BROWSER_EVIDENCE_RECIPE_ROUTES_MAX, browserEvidenceSignInRef } from "@agentx/contracts";

const LINE = /^[^\p{Cc}\p{Cf}]*$/u;

/** The form's text fields, as the server reads them (a missing field is the empty string). */
export type BrowserEvidenceFormFields = Readonly<Record<string, string>>;

export function browserEvidenceRecipeFromForm(project: string, form: BrowserEvidenceFormFields): Record<string, unknown> | undefined {
  const get = (name: string): string => {
    const value = form[name];
    return typeof value === "string" ? value.trim() : "";
  };
  const port = /^\d{1,5}$/u.test(get("port")) ? Number(get("port")) : undefined;
  if (port === undefined || get("startCommand") === "" || !LINE.test(get("startCommand"))) return undefined;
  const routes: Array<{ path: string; files: string[] }> = [];
  const lines = get("routes").split(/\r\n|\r|\n/u).map((line) => line.trim()).filter((line) => line !== "");
  if (lines.length > BROWSER_EVIDENCE_RECIPE_ROUTES_MAX) return undefined;
  for (const line of lines) {
    const [path, ...rest] = line.split(/[\s,]+/u).filter((part) => part !== "");
    if (path === undefined || rest.length === 0) return undefined;
    routes.push({ path, files: rest });
  }
  const mask = get("mask").split(/\r\n|\r|\n/u).map((line) => line.trim()).filter((line) => line !== "");
  if (mask.length > BROWSER_EVIDENCE_MASK_SELECTORS_MAX) return undefined;
  const framework = get("framework");
  if (framework !== "" && framework !== "nextjs") return undefined;
  const recipe: Record<string, unknown> = { startCommand: get("startCommand"), port, routes };
  if (get("readyPath") !== "") recipe["readyPath"] = get("readyPath");
  if (framework !== "") recipe["framework"] = framework;
  if (mask.length > 0) recipe["mask"] = mask;
  if (get("signInOn") === "yes") {
    const ref = browserEvidenceSignInRef(project);
    if (ref === undefined) return undefined;
    recipe["signIn"] = {
      path: get("signInPath"), usernameSelector: get("signInUsername"), passwordSelector: get("signInPassword"), submitSelector: get("signInSubmit"), credentialRef: ref,
      ...(get("signInSuccessPath") === "" ? {} : { successPath: get("signInSuccessPath") }), ...(get("signInSuccessSelector") === "" ? {} : { successSelector: get("signInSuccessSelector") }),
    };
  }
  return recipe;
}
