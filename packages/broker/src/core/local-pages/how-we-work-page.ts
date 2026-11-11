// The How we work page: what the project's process looks like as a person reads it, and a place to try a change before it is made. How we work in Code is a file in the repository
// (`.rovara/playbook.yaml`, reviewed in a pull request like any other change), so this page reads it and never writes it: a draft is checked and shown, and the owner puts it in the file. Every value
// that came from the file is untrusted text and drawn as plain text.
import { HOW_WE_WORK_REVIEWER_NOTE, PLAYBOOK_FILE_PATH, PLAYBOOK_FILE_TEMPLATE, type HowWeWorkStage, type HowWeWorkView, type PlaybookProblem } from "@agentx/contracts";
import { esc, layout, untrusted } from "./html.js";
import type { PageContext } from "./pages.js";
import type { HowWeWorkPageState } from "./views.js";

/** The longest draft the page checks: a form is read up to a small size, and a form-encoded line end takes three bytes. A longer file is checked with `rovara playbook check`. */
export const DRAFT_CHARACTERS_MAX = 12_000;

const SOURCE_WORDS = { rovara: "Rovara", company: "company", project: "this project" } as const;

const hidden = (name: string, value: string | number): string => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;

/** One row of the view: a value and where it comes from. */
type Row = HowWeWorkStage["checked"]["items"][number];

const mark = (entry: Row): string =>
  `<li>${untrusted(entry.value)} <span class="muted">(${esc(SOURCE_WORDS[entry.source])}${entry.locked ? ", locked" : ""})</span></li>`;
const list = (items: readonly Row[], none = "Nothing."): string => (items.length === 0 ? `<p class="muted">${esc(none)}</p>` : `<ul>${items.map(mark).join("")}</ul>`);

function stageHtml(stage: HowWeWorkStage): string {
  const tools = stage.may.tools.value === null ? "the tools the step normally has" : stage.may.tools.value.join(", ");
  return `<section class="panel" id="stage-${esc(stage.id)}"><h2>${untrusted(stage.name)}</h2>`
    + `<h3>What it is told</h3>${stage.knows.instructions.length === 0 ? "<p class=\"muted\">Only Rovara's own rules.</p>" : `<ul>${stage.knows.instructions.map((row) => `<li><pre>${untrusted(row.value)}</pre><span class="muted">(${esc(SOURCE_WORDS[row.source])})</span></li>`).join("")}</ul>`}`
    + `${stage.knows.note === undefined ? "" : `<p class="muted">${untrusted(stage.knows.note)}</p>`}`
    + `<h3>What it may do</h3><p>${stage.may.readOnly ? "Read only. " : ""}${untrusted(tools)}</p>`
    + `<h3>What it checks</h3>${list(stage.checked.items)}<h3>What it keeps as evidence</h3>${list(stage.evidence.items)}<h3>Who approves</h3>${list(stage.approves.items)}</section>`;
}

function viewHtml(view: HowWeWorkView): string {
  return `${view.rules.length === 0 ? "" : `<section class="panel"><h2>Rules for the whole process</h2><ul>${view.rules.map((row) => `<li><pre>${untrusted(row.value)}</pre><span class="muted">(${esc(SOURCE_WORDS[row.source])})</span></li>`).join("")}</ul><p class="muted">${esc(HOW_WE_WORK_REVIEWER_NOTE)}</p></section>`}`
    + view.stages.map(stageHtml).join("");
}

const problemsHtml = (problems: readonly PlaybookProblem[]): string =>
  `<ul>${problems.map((problem) => `<li><code>${untrusted(problem.path)}</code>: ${untrusted(problem.message)}</li>`).join("")}</ul>`;

function fileHtml(state: HowWeWorkPageState): string {
  const file = state.file;
  if (file.status === "none") return `<p>This project has no How we work file, so it runs Rovara Code as it is. To change how it works, add <code>${esc(PLAYBOOK_FILE_PATH)}</code> to the repository's default branch.</p>`;
  if (file.status === "ok") return `<p>Read from <code>${esc(PLAYBOOK_FILE_PATH)}</code> in ${untrusted(file.repository)}, at commit <code>${esc(file.commit.slice(0, 12))}</code> of the default branch. Revision ${esc(state.view.playbookRevision)}.</p>`;
  if (file.status === "invalid") return `<p class="bad">The file in ${untrusted(file.repository)} cannot be used, so no step of this project starts until it is fixed on the default branch:</p>${problemsHtml(file.problems)}`;
  return `<p class="warn">The file could not be read just now (${untrusted(file.reason)}). Steps wait and try again.</p>`;
}

export function renderHowWeWorkIndex(context: PageContext, projects: readonly string[]): string {
  return layout({
    title: "How we work", nonce: context.nonce, base: context.base, ...(context.notice === undefined ? {} : { notice: context.notice }),
    body: `<h1>How we work</h1><p>Each project's way of working is a file in its repository, <code>${esc(PLAYBOOK_FILE_PATH)}</code>, reviewed in a pull request.</p>`
      + (projects.length === 0 ? "<p class=\"muted\">No project is registered yet.</p>" : `<ul>${projects.map((project) => `<li><a href="${esc(context.base)}/how-we-work/${encodeURIComponent(project)}">${untrusted(project)}</a></li>`).join("")}</ul>`),
  });
}

/** A draft the owner is trying: what they typed, and what it would make (or what is wrong with it). */
export interface DraftTry { text: string; result: { problems: PlaybookProblem[] } | { view: HowWeWorkView } }

export function renderHowWeWork(context: PageContext, project: string, state: HowWeWorkPageState, draft?: DraftTry): string {
  const current = state.file.status === "ok" || state.file.status === "invalid" ? state.file.text : undefined;
  const text = draft?.text ?? current ?? PLAYBOOK_FILE_TEMPLATE;
  const form = `<section class="panel" id="draft"><h2>Try a change</h2>`
    + `<p>Edit the file here to see what it would do. Nothing is saved: copy the text into the file in your repository and open a pull request, as for any change. The page checks up to ${String(DRAFT_CHARACTERS_MAX)} characters; for a longer file run <code>rovara playbook check</code>.</p>`
    + `<form class="decide" method="post" action="${esc(context.base)}/how-we-work/${encodeURIComponent(project)}/check">`
    + `${hidden("ft", context.formToken({ action: "playbook.check", subject: project }))}`
    + `<label>${esc(PLAYBOOK_FILE_PATH)}<br><textarea name="text" rows="18" maxlength="${DRAFT_CHARACTERS_MAX}" spellcheck="false">${esc(text)}</textarea></label>`
    + "<div class=\"row\"><button class=\"primary\" type=\"submit\">Check this draft</button></div></form></section>";
  const tried = draft === undefined ? ""
    : "problems" in draft.result ? `<section class="panel" id="draft-result"><h2>The draft cannot be used</h2>${problemsHtml(draft.result.problems)}</section>`
      : `<section class="panel" id="draft-result"><h2>What the draft would make</h2><p class="muted">This is what a task would run once the file is on the default branch.</p></section>${viewHtml(draft.result.view)}`;
  return layout({
    title: `How we work: ${project}`, nonce: context.nonce, base: context.base, ...(context.notice === undefined ? {} : { notice: context.notice }),
    body: `<h1>How we work: ${untrusted(project)}</h1><p class="muted"><a href="${esc(context.base)}/how-we-work">All projects</a></p>${fileHtml(state)}${form}${tried}`
      + (draft === undefined ? `<h2>As it runs now</h2>${viewHtml(state.view)}` : ""),
  });
}
