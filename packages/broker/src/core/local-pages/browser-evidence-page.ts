// TE-H1 browser evidence, slice 3: the recipe page. For one project the owner says how Rovara shows its changed pages: the command that starts the app (it runs in the task sandbox, as the project's own checks do), its port, which
// pages to photograph and which repository files make each one, what else to paint over, and, for an app behind a login, the sign-in form and a saved TEST account. A change is one verified form, good only in a page opened within the
// last ten minutes. Nothing here can show a saved value: the page knows only that a sign-in is or is not saved. Everything a model suggested is shown as plain text and fills the form only when the owner asks, and saves nothing.
import { BROWSER_EVIDENCE_SIGN_IN_VALUE_MAX, BROWSER_EVIDENCE_SIGN_IN_VALUE_MIN, type BrowserEvidenceRecipe } from "@agentx/contracts";
import { esc, layout, untrusted } from "./html.js";
import type { PageContext } from "./pages.js";
import type { BrowserEvidencePageView } from "./views.js";

const hidden = (name: string, value: string | number): string => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;

export function renderBrowserEvidenceIndex(context: PageContext, projects: readonly string[]): string {
  const rows = projects.map((project) => `<li><a href="${esc(context.base)}/browser-evidence/${esc(project)}">${esc(project)}</a></li>`).join("");
  return layout({
    title: "Browser evidence", nonce: context.nonce, base: context.base, ...(context.notice === undefined ? {} : { notice: context.notice }),
    body: `<h1>Browser evidence</h1><p class="muted">For a change to a web app, Rovara can start the app in its sandbox and take a before and an after picture of each page the change touched. The pictures are visual evidence only: they never count as proof that the change works. Pick a project to say how.</p>${rows === "" ? "<p class=\"muted\">No project is registered yet.</p>" : `<ul>${rows}</ul>`}`,
  });
}

/** The form's values: the recipe in force, or the suggestion the owner asked to start from. */
type Shown = Pick<BrowserEvidenceRecipe, "startCommand" | "port" | "routes"> & Partial<Pick<BrowserEvidenceRecipe, "readyPath" | "framework" | "mask" | "signIn">>;

export function renderBrowserEvidencePage(context: PageContext, view: BrowserEvidencePageView, options: { fresh: boolean; useSuggestion: boolean }): string {
  const action = `${esc(context.base)}/browser-evidence/${esc(view.project)}/act`;
  const token = (op: string): string => hidden("ft", context.formToken({ action: "browser-evidence.act", subject: `${op}:${view.project}` }));
  const button = (label: string, cls = ""): string => `<button type="submit"${cls === "" ? "" : ` class="${cls}"`}>${esc(label)}</button>`;
  const shown: Shown | undefined = options.useSuggestion && view.suggestion !== undefined ? view.suggestion.recipe : view.recipe;
  const field = (name: string, label: string, value: string | number | undefined, extra = ""): string => `<label>${esc(label)}<br><input type="text" name="${esc(name)}" value="${esc(value ?? "")}" maxlength="500" size="60" autocomplete="off"${extra}></label>`;
  const readOnly = view.source === "config";

  const state = view.source === "none" ? "Browser evidence is off for this project: no recipe is saved."
    : view.source === "config" ? "Browser evidence is on. The recipe comes from your config file, so it is changed there."
    : "Browser evidence is on for this project.";
  const machine = view.canRun ? "" : "<p class=\"warn\">This computer has no executor image set, so a saved recipe runs nothing here. Set ROVARA_EXECUTOR_IMAGE and restart `rovara up`.</p>";
  const fresh = options.fresh ? "" : "<p class=\"notice\">This page is too old to change anything. Run `rovara open browser-evidence` for a new one, then make the change within ten minutes.</p>";

  const suggestion = (): string => {
    const found = view.suggestion;
    if (found === undefined) return "";
    const recipe = found.recipe;
    const rows = recipe.routes.map((route) => `<tr><td><code>${untrusted(route.path)}</code></td><td>${route.files.map((file) => `<code>${untrusted(file)}</code>`).join(", ")}</td></tr>`).join("");
    return `<div class="panel"><h2>What Rovara suggests</h2><p class="muted">Rovara read the project's code and suggests this. Nothing is saved: read it, change what is wrong, then save it below. It was ${found.verdict === "verified" ? "confirmed in the repository" : found.verdict === "unverified" ? "<span class=\"bad\">not found where it says</span>" : "not checked against the repository"}; from the repository: ${found.from.length === 0 ? "no place is named" : found.from.map((place) => untrusted(place)).join(", ")}.</p>`
      + `<p>Start command <code>${untrusted(recipe.startCommand)}</code>, port <code>${esc(recipe.port)}</code>${recipe.readyPath === undefined ? "" : `, ready at <code>${untrusted(recipe.readyPath)}</code>`}${recipe.framework === undefined ? "" : `, ${esc(recipe.framework)} pages`}.</p>`
      + `${rows === "" ? "" : `<table><thead><tr><th>Page</th><th>Made by these files</th></tr></thead><tbody>${rows}</tbody></table>`}`
      + `<p><a href="${esc(context.base)}/browser-evidence/${esc(view.project)}?suggestion=1">Start the form from this suggestion</a></p></div>`;
  };

  const signIn = shown?.signIn;
  const checked = signIn === undefined ? "" : " checked";
  const form = (): string => {
    const routes = (shown?.routes ?? []).map((route) => `${route.path} ${route.files.join(", ")}`).join("\n");
    const inner = `${field("startCommand", "The command that starts the app", shown?.startCommand)}<br>${field("port", "The port it listens on", shown?.port, " size=\"8\" inputmode=\"numeric\"")}<br>`
      + `${field("readyPath", "A page that answers once the app is up (default /)", shown?.readyPath)}<br>`
      + `<label>Pages Rovara may open by their files<br><select name="framework"><option value="">Only the pages listed below</option><option value="nextjs"${shown?.framework === "nextjs" ? " selected" : ""}>Also Next.js pages and app routes</option></select></label>`
      + `<label>The pages, one a line: the page, then the repository files that make it (for example <code>/checkout src/checkout/**, src/cart/**</code>)<br><textarea name="routes" rows="6" maxlength="8000">${esc(routes)}</textarea></label>`
      + `<label>Other things to paint over in every picture, one CSS selector a line (passwords, card fields and anything marked <code>data-private</code> are always painted over)<br><textarea name="mask" rows="3" maxlength="4000">${esc((shown?.mask ?? []).join("\n"))}</textarea></label>`
      + `<fieldset><legend>The app sits behind a login</legend><label><input type="checkbox" name="signInOn" value="yes"${checked}> Rovara signs in before it takes the pictures</label>`
      + `${field("signInPath", "The login page", signIn?.path)}<br>${field("signInUsername", "Selector of the user name field", signIn?.usernameSelector)}<br>${field("signInPassword", "Selector of the password field", signIn?.passwordSelector)}<br>${field("signInSubmit", "Selector of the sign-in button", signIn?.submitSelector)}<br>`
      + `${field("signInSuccessPath", "The page a signed-in person lands on", signIn?.successPath)}<br>${field("signInSuccessSelector", "Or an element only a signed-in page has", signIn?.successSelector)}`
      + `<p class="muted">The user name and password are saved below, in the secret store, and never here. Both fields are painted over in every picture.</p></fieldset>`
      + `${hidden("version", view.version ?? 0)}${token("save")}`;
    return `<form class="decide" method="post" action="${action}">${hidden("op", "save")}${inner}<div class="row">${button("Save the recipe", "primary")}</div></form>`;
  };

  const turnOff = view.source === "page" ? `<form method="post" action="${action}" class="row">${hidden("op", "turn-off")}${token("turn-off")}${button("Turn browser evidence off for this project", "danger")}</form>` : "";

  const credentials = (): string => {
    const saved = view.signInSaved ? "<p class=\"ok\">A sign-in is saved for this project. Its values are never shown.</p>" : "<p class=\"muted\">No sign-in is saved.</p>";
    const set = `<form class="decide" method="post" action="${action}">${hidden("op", "save-sign-in")}`
      + `<label>User name<br><input type="text" name="username" minlength="${BROWSER_EVIDENCE_SIGN_IN_VALUE_MIN}" maxlength="${BROWSER_EVIDENCE_SIGN_IN_VALUE_MAX}" size="40" autocomplete="off" spellcheck="false"></label>`
      + `<label>Password<br><input type="password" name="password" minlength="${BROWSER_EVIDENCE_SIGN_IN_VALUE_MIN}" maxlength="${BROWSER_EVIDENCE_SIGN_IN_VALUE_MAX}" size="40" autocomplete="new-password"></label>${token("save-sign-in")}`
      + `<div class="row">${button(view.signInSaved ? "Replace the saved sign-in" : "Save the sign-in", "primary")}</div></form>`;
    const clear = view.signInSaved ? `<form method="post" action="${action}" class="row">${hidden("op", "clear-sign-in")}${token("clear-sign-in")}${button("Remove the saved sign-in", "danger")}</form>` : "";
    return `<div class="panel"><h2>The saved sign-in</h2><p>Use a test account made for this, never a real person's: the app in the sandbox receives it when Rovara signs in. It is kept in the secret store of this computer, in the company's own place, and is never put in the recipe, a picture, the evidence, the pull request or a log.</p>${saved}${set}${clear}</div>`;
  };

  const recipeBody = readOnly
    ? `<div class="panel"><h2>The recipe</h2><p class="muted">Set in your config file (<code>projectSettings.${esc(view.project)}.browserEvidence</code>).</p><pre>${esc(JSON.stringify(view.recipe ?? {}, null, 2))}</pre></div>`
    : `<div class="panel"><h2>The recipe</h2><p class="muted">The start command runs in the task's sandbox, as the project's own checks do, once on the unchanged code and once on the change. Only pages on the app's own address are opened. A recipe is kept in Rovara's settings, never in the repository.</p>${form()}${turnOff}</div>`;

  return layout({
    title: `Browser evidence for ${view.project}`, nonce: context.nonce, base: context.base, ...(context.notice === undefined ? {} : { notice: context.notice }),
    body: `<h1>Browser evidence for ${esc(view.project)}</h1><p>${esc(state)}</p><p class="muted">Visual evidence only: it does not count as change proof.</p>${machine}${fresh}${suggestion()}${recipeBody}${credentials()}<p><a href="${esc(context.base)}/browser-evidence">All projects</a></p>`,
  });
}
