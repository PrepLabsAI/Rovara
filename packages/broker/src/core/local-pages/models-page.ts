// The page where the owner chooses the model each step uses, and how a checking step that nobody set chooses. Each step shows the model it would run on now and why; a change is one verified form, good only in a page
// opened within the last ten minutes. A step with no setting uses this install's model (or, when asked to, the strongest model of a different AI company than the step it checks). Prices are the provider's own or the
// catalog's list price. Everything a model says about itself is the catalog's name; the sentences are Rovara's.
import { STAGE_EDIT_GROUPS, STAGE_REFERENCE, type ModelSelectionState, type StageId } from "@agentx/contracts";
import { esc, layout, untrusted } from "./html.js";
import type { PageContext } from "./pages.js";

const hidden = (name: string, value: string | number): string => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
const refValue = (model: { provider: string; modelId: string }): string => `${model.provider}::${model.modelId}`;

const STAGE_WORDS: Record<StageId, string> = {
  understand: "Understand the request", plan: "Plan", plan_check: "Check the plan", build: "Write the code", code_review: "Review the code", security_review: "Review the code for security", pull_request: "Answer pull request feedback",
};
const REASON_WORDS: Record<string, string> = {
  COMPANY_LOCK: "locked", PROJECT_CHOICE: "your setting", COMPANY_DEFAULT: "your setting", PROJECT_SELECTION: "the project's choice", PROJECT_DEFAULT: "the project's default", BUILTIN_DEFAULT: "this install's model",
  PERSONAL_PLAN_DEFAULT: "your plan's model", RECIPE_DEFAULT: "the process's model", APPROVED_SAME_MODEL: "the same model as the step it checks, approved",
  DEFAULT_DIFFERENT_COMPANY: "the strongest model of a different AI company than the step it checks", INSTALL_MODEL: "this install's model",
};
const THINKING_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "Leave as it is" }, { value: "default", label: "The model's own default" }, { value: "off", label: "Off" }, { value: "minimal", label: "Minimal" }, { value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" },
];

const dollars = (price: { input: number; output: number } | undefined): string => (price === undefined ? "no price" : `$${price.input.toFixed(2)} in, $${price.output.toFixed(2)} out per million tokens`);

export function renderModelSelection(context: PageContext, state: ModelSelectionState): string {
  const form = (op: string, stage: string, inner: string, label: string, cls = ""): string =>
    `<form class="decide" method="post" action="${esc(context.base)}/models/act">${hidden("op", op)}${hidden("stage", stage)}${hidden("revision", state.revision)}${hidden("ft", context.formToken({ action: "models.act", subject: `${op}:${stage}` }))}${inner}<div class="row"><button${cls === "" ? "" : ` class="${cls}"`} type="submit">${esc(label)}</button></div></form>`;
  const options = (selected?: { provider: string; modelId: string }): string => state.models.map((entry) => {
    const isSelected = selected !== undefined && selected.provider === entry.model.provider && selected.modelId === entry.model.modelId;
    return `<option value="${esc(refValue(entry.model))}"${isSelected ? " selected" : ""}>${untrusted(`${entry.model.modelId} (${entry.model.provider}${entry.priced ? "" : ", no price"}${entry.usable ? "" : ", refused lately"})`)}</option>`;
  }).join("");
  const rows = STAGE_EDIT_GROUPS.map((group) => {
    const first = state.steps.find((step) => step.stage === group[0]);
    if (first === undefined) return "";
    const checking = (group as readonly StageId[]).some((stage) => stage in STAGE_REFERENCE);
    const names = group.map((stage) => STAGE_WORDS[stage]).join(" and ");
    const effective = first.effective;
    const now = effective === undefined
      ? `<p class="warn">${untrusted(first.refusal?.words ?? "No model can be used.")}</p>`
      : `<p><strong>${untrusted(effective.model.modelId)}</strong> <span class="muted">${untrusted(effective.model.provider)} · ${esc(REASON_WORDS[effective.reason] ?? effective.reason)}${effective.sameModelAsChecked ? " · the same model as the step it checks" : ""}${effective.thinkingLevel === null ? "" : ` · thinking ${esc(effective.thinkingLevel)}`}</span><br><span class="muted">${esc(dollars(effective.priceUsdPerMillion))}</span>`
        + `${effective.fallback === undefined ? "" : `<br><span class="warn">${untrusted(`Used ${effective.fallback.used}${effective.fallback.wanted === null ? "" : ` instead of ${effective.fallback.wanted}`} because the first choice could not be used.`)}</span>`}</p>`;
    const setting = first.setting;
    const different = checking
      ? `<label>Independence<br><select name="different"><option value=""${setting?.differentFrom === undefined ? " selected" : ""}>No rule</option><option value="model"${setting?.differentFrom?.level === "model" ? " selected" : ""}>A different model than the step it checks</option><option value="vendor"${setting?.differentFrom?.level === "vendor" ? " selected" : ""}>A model of a different AI company</option></select></label>`
      : "";
    const fields = `<label>Model<br><select name="model"><option value="">No model chosen (use the default)</option>${options(setting?.model)}</select></label>`
      + `<label>Backup model (used if the first cannot be called)<br><select name="fallback"><option value="">None</option>${options(setting?.fallbackModel)}</select></label>`
      + `<label>Thinking<br><select name="thinking">${THINKING_OPTIONS.map((entry) => `<option value="${esc(entry.value)}">${esc(entry.label)}</option>`).join("")}</select></label>${different}`;
    return `<section class="panel"><h2>${esc(names)}</h2>${now}${setting === null ? "<p class=\"muted\">Nothing is set for this step.</p>" : ""}${form("set", group[0], fields, "Save", "primary")}${setting === null ? "" : form("clear", group[0], "", "Go back to the default")}</section>`;
  });
  const reviews = `<section class="panel"><h2>Checking steps nobody set</h2><p>${state.reviewDefault === "different-company" ? "They use the strongest model of a different AI company than the step they check, when this install can call one." : "They use this install's model, as every other step does."}</p>`
    + form("review-default", "", `<label>Default<br><select name="value"><option value="install-model"${state.reviewDefault === "install-model" ? " selected" : ""}>This install's one model</option><option value="different-company"${state.reviewDefault === "different-company" ? " selected" : ""}>The strongest model of a different AI company</option></select></label>`, "Save")
    + "</section>";
  const prices = state.models.length === 0 ? "<p class=\"muted\">No model can be called: set a model key.</p>"
    : `<table><thead><tr><th>Model</th><th>Price</th><th>State</th></tr></thead><tbody>${state.models.map((entry) => `<tr><td>${untrusted(entry.model.modelId)}<br><span class="muted">${untrusted(entry.model.provider)} · ${untrusted(entry.company)}</span></td><td>${esc(dollars(entry.priceUsdPerMillion))}${entry.priceUsdPerMillion === undefined ? "" : `<br><span class="muted">${entry.priceUsdPerMillion.source === "provider" ? "from its provider's price table" : entry.priceUsdPerMillion.source === "built-in" ? "free: the provider does not charge for this variant" : "the catalog's list price"}</span>`}</td><td>${entry.usable ? "<span class=\"ok\">can be used</span>" : "<span class=\"warn\">refused lately</span>"}</td></tr>`).join("")}</tbody></table>`;
  return layout({
    title: "Models", nonce: context.nonce, base: context.base, ...(context.notice === undefined ? {} : { notice: context.notice }),
    body: `<h1>The model each step uses</h1><p class="muted">Each step of a task can use its own model. ${state.install === null ? "No model key is set, so nothing can run." : `This install's model is ${untrusted(state.install.modelId)} (${untrusted(state.install.provider)}).`} ${state.runLimit.enforced ? "A run limit is held on every task, so a model with no price cannot be used." : "No run limit is held, so a model with no price can be used; its cost is shown as unknown."}</p>`
      + `${rows.join("")}${reviews}<section class="panel"><h2>Models and prices</h2>${prices}</section>`,
  });
}
