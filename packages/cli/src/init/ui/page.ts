// The wizard page: one HTML document, one stylesheet and one ES module, held here as text so they
// compile into `packages/cli/dist/` with everything else and ship in the published CLI without a
// bundler or a second build step (spec 040 Out Of Scope).
//
// The page has no inline script and no inline style, so the strict CSP below holds. It builds every
// node with `textContent`, so a question, a log line or a plan is text, never markup.
//
// Every same-origin asset this page links to must carry the session token in its URL: the server
// refuses any request without it (tests/contract/local-page-assets.test.ts).
import { WIZARD_TOKEN_HEADER, WIZARD_TOKEN_QUERY } from "./protocol.js";

export const WIZARD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** The stylesheet and the module each carry the session token in their own URL, because the server
 * refuses every request without it; the module reads it back from `import.meta.url`, so the page
 * needs no inline script to hand it over. */
export function wizardHtml(token: string): string {
  const query = `${WIZARD_TOKEN_QUERY}=${encodeURIComponent(token)}`;
  const stylesheet = `/app.css?${query}`;
  const script = `/app.js?${query}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>Install AgentX</title>
<link rel="stylesheet" href="${stylesheet}">
</head>
<body>
<header><h1>Install AgentX</h1><p id="subtitle">Connecting to the installer&hellip;</p></header>
<main>
  <section id="resume" class="card hidden"><h2>Continuing an install</h2><div id="resume-body"></div></section>
  <section id="plan" class="card hidden"><h2>Review</h2><pre id="plan-body"></pre></section>
  <section id="next" class="card hidden"><h2>Next</h2><div id="next-link"></div></section>
  <div id="cards"></div>
  <section id="question" class="card hidden"><h2 id="question-text"></h2><div id="question-body"></div><p id="question-error" class="error hidden"></p></section>
  <section id="outcome" class="card hidden"><h2>Finished</h2><p id="outcome-body"></p></section>
  <section class="card"><h2>Steps</h2><ol id="steps"></ol></section>
  <section class="card"><h2>Log</h2><pre id="log"></pre></section>
</main>
<script type="module" src="${script}"></script>
</body>
</html>
`;
}

export const WIZARD_CSS = `:root { color-scheme: light dark; }
body { font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0 auto; max-width: 52rem; padding: 1.5rem 1rem 4rem; }
h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
h2 { font-size: .85rem; letter-spacing: .06em; margin: 0 0 .75rem; text-transform: uppercase; opacity: .7; }
header p { margin: 0 0 1.5rem; opacity: .75; }
.card { border: 1px solid rgba(128,128,128,.35); border-radius: .5rem; margin-bottom: 1rem; padding: 1rem; }
.hidden { display: none; }
pre { font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; margin: 0; max-height: 26rem; overflow: auto; white-space: pre-wrap; word-break: break-word; }
#log { max-height: 18rem; opacity: .85; }
#outcome-body { white-space: pre-wrap; }
ol#steps { list-style: none; margin: 0; padding: 0; }
ol#steps li { display: flex; gap: .6rem; padding: .2rem 0; }
ol#steps li .mark { flex: none; width: 1.3rem; text-align: center; }
li.pending { opacity: .5; }
li.running { font-weight: 600; }
li.waiting { color: #b06000; }
li.done .mark, li.skipped .mark { color: #2e7d32; }
li .note { display: block; font-size: .85rem; opacity: .8; }
label { display: block; margin-bottom: .5rem; }
input[type=text], input[type=password], textarea, select { border: 1px solid rgba(128,128,128,.5); border-radius: .35rem; box-sizing: border-box; font: inherit; padding: .45rem .6rem; width: 100%; }
textarea { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; min-height: 8rem; }
.choices { display: grid; gap: .35rem; margin-bottom: .75rem; }
.choices label { align-items: baseline; display: flex; gap: .5rem; margin: 0; }
.buttons { display: flex; gap: .5rem; margin-top: .75rem; }
button { border: 1px solid rgba(128,128,128,.5); border-radius: .35rem; cursor: pointer; font: inherit; padding: .45rem 1rem; }
button.primary { background: #1a56db; border-color: #1a56db; color: #fff; }
button[disabled] { cursor: progress; opacity: .6; }
.error { color: #c62828; margin: .6rem 0 0; }
.hint { font-size: .85rem; margin: .35rem 0 0; opacity: .7; }
a.button { border: 1px solid rgba(128,128,128,.5); border-radius: .35rem; display: inline-block; font: inherit; margin-top: .5rem; padding: .45rem 1rem; text-decoration: none; }
a.button.primary { background: #1a56db; border-color: #1a56db; color: #fff; }
.card.status p { margin: 0 0 .35rem; }
.card.status.ok { border-color: #2e7d32; }
.card.status.waiting { border-color: #b06000; }
.card.status.failed { border-color: #c62828; }
ul.checks { list-style: none; margin: .5rem 0 0; padding: 0; }
ul.checks li { display: flex; gap: .6rem; padding: .15rem 0; }
ul.checks li.ok .mark { color: #2e7d32; }
ul.checks li.failed .mark { color: #c62828; }
`;

const MARKS: Record<string, string> = { pending: "·", running: "•", done: "✓", skipped: "✓", waiting: "…" };

/** The page's module. It is plain browser JavaScript held as text, not TypeScript: nothing here is
 * compiled, imported by Node, or type-checked with the rest of the CLI. */
export const WIZARD_JS = `// AgentX install wizard. Served from 127.0.0.1 by \`agentx init --ui\`; loopback only.
const token = new URL(import.meta.url).searchParams.get(${JSON.stringify(WIZARD_TOKEN_QUERY)}) ?? "";
const TOKEN_HEADER = ${JSON.stringify(WIZARD_TOKEN_HEADER)};
const MARKS = ${JSON.stringify(MARKS)};
const byId = (id) => document.getElementById(id);
const show = (id, on) => { byId(id).classList.toggle("hidden", !on); };

let renderedQuestion = null;
let sending = false;

function renderSteps(steps) {
  const list = byId("steps");
  list.replaceChildren();
  for (const step of steps) {
    const item = document.createElement("li");
    item.className = step.status;
    const mark = document.createElement("span");
    mark.className = "mark";
    mark.textContent = MARKS[step.status] ?? "\\u00b7";
    const title = document.createElement("span");
    title.textContent = step.title;
    if (step.message) {
      const note = document.createElement("span");
      note.className = "note";
      note.textContent = step.message;
      title.append(note);
    }
    item.append(mark, title);
    list.append(item);
  }
}

function renderResume(resume) {
  show("resume", Boolean(resume));
  if (!resume) return;
  const body = byId("resume-body");
  body.replaceChildren();
  const done = document.createElement("p");
  done.textContent = resume.completed.length > 0
    ? "Already done: " + resume.completed.join(", ")
    : "Nothing has finished yet.";
  body.append(done);
  const next = document.createElement("p");
  next.textContent = resume.continueFrom ? "Continuing from: " + resume.continueFrom : "Every step is already done.";
  body.append(next);
}

function linkButton(link) {
  const anchor = document.createElement("a");
  anchor.className = "button primary";
  anchor.href = link.url;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.textContent = link.label;
  return anchor;
}

function renderCards(cards, link) {
  const holder = byId("cards");
  holder.replaceChildren();
  const offered = new Set();
  for (const card of cards ?? []) {
    const section = document.createElement("section");
    section.className = "card status " + card.status;
    const title = document.createElement("h2");
    title.textContent = card.title;
    section.append(title);
    for (const line of card.lines) {
      const paragraph = document.createElement("p");
      paragraph.textContent = line;
      section.append(paragraph);
    }
    if (card.checks) {
      const list = document.createElement("ul");
      list.className = "checks";
      for (const check of card.checks) {
        const item = document.createElement("li");
        item.className = check.ok ? "ok" : "failed";
        const mark = document.createElement("span");
        mark.className = "mark";
        mark.textContent = check.ok ? "\\u2713" : "\\u2717";
        const text = document.createElement("span");
        text.textContent = check.label + ": " + check.detail;
        item.append(mark, text);
        list.append(item);
      }
      section.append(list);
    }
    if (card.link) {
      section.append(linkButton(card.link));
      offered.add(card.link.url);
    }
    holder.append(section);
  }
  // The run's own "open this" address, unless a card already offers the same one.
  const next = link && !offered.has(link.url) ? link : null;
  show("next", Boolean(next));
  const slot = byId("next-link");
  slot.replaceChildren();
  if (next) slot.append(linkButton(next));
}

function submit(id, value) {
  if (sending) return;
  sending = true;
  for (const button of document.querySelectorAll("#question button")) button.disabled = true;
  fetch("/answer", {
    method: "POST",
    headers: { "content-type": "application/json", [TOKEN_HEADER]: token },
    body: JSON.stringify({ id, value }),
  }).then((response) => response.json()).then((reply) => {
    // A refusal arrives as a fresh question with the message on it, so only a transport failure
    // needs saying here.
    if (!reply.ok) sending = false;
  }).catch((error) => {
    sending = false;
    const field = byId("question-error");
    field.textContent = "could not reach the installer: " + error;
    field.classList.remove("hidden");
  });
}

function buildQuestion(question) {
  const body = byId("question-body");
  body.replaceChildren();
  byId("question-text").textContent = question.text;
  const error = byId("question-error");
  error.textContent = question.error ?? "";
  show("question-error", Boolean(question.error));

  if (question.kind === "confirm") {
    const buttons = document.createElement("div");
    buttons.className = "buttons";
    for (const choice of [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = choice.label;
      const isDefault = question.defaultConfirm === (choice.value === "yes");
      if (isDefault) button.className = "primary";
      button.addEventListener("click", () => submit(question.id, choice.value));
      buttons.append(button);
    }
    body.append(buttons);
    return;
  }

  let read;
  if (question.kind === "choose") {
    const group = document.createElement("div");
    group.className = "choices";
    const name = "choice-" + question.id;
    for (const choice of question.choices ?? []) {
      const label = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = name;
      radio.value = choice.value;
      radio.checked = choice.value === question.defaultValue;
      const text = document.createElement("span");
      text.textContent = choice.label;
      label.append(radio, text);
      group.append(label);
    }
    body.append(group);
    read = () => {
      const picked = group.querySelector("input:checked");
      return picked ? picked.value : "";
    };
  } else {
    const field = question.multiline ? document.createElement("textarea") : document.createElement("input");
    if (!question.multiline) field.type = question.masked ? "password" : "text";
    field.autocomplete = question.masked ? "off" : "on";
    if (question.masked) {
      field.spellcheck = false;
      // Q4: ask password managers neither to fill nor to save a secret.
      field.setAttribute("data-1p-ignore", "");
      field.setAttribute("data-lpignore", "true");
      field.setAttribute("data-bwignore", "");
    }
    if (question.defaultValue !== undefined && !question.masked) field.placeholder = question.defaultValue;
    body.append(field);
    if (question.defaultValue !== undefined && !question.masked) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = "Leave empty for " + question.defaultValue;
      body.append(hint);
    }
    read = () => {
      const value = field.value;
      // A press while an answer is in flight sends nothing (submit ignores it), so the field keeps
      // what was typed.
      if (sending) return value;
      // Q4: a secret leaves the field the moment it is sent; a refused one is pasted again.
      if (question.masked) field.value = "";
      return value;
    };
    if (!question.multiline) {
      field.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); submit(question.id, read()); } });
    }
    queueMicrotask(() => field.focus());
  }

  const buttons = document.createElement("div");
  buttons.className = "buttons";
  const send = document.createElement("button");
  send.type = "button";
  send.className = "primary";
  send.textContent = "Continue";
  send.addEventListener("click", () => submit(question.id, read()));
  buttons.append(send);
  body.append(buttons);
}

function render(state) {
  byId("subtitle").textContent = state.phase === "running"
    ? "Installing environment " + state.env + ". Keep this tab open until it finishes."
    : "Environment " + state.env + ": " + state.phase + ".";
  renderSteps(state.steps);
  renderResume(state.resume);
  renderCards(state.cards, state.link);
  show("plan", Boolean(state.plan));
  if (state.plan) byId("plan-body").textContent = state.plan;
  show("outcome", Boolean(state.outcome));
  if (state.outcome) byId("outcome-body").textContent = state.outcome;
  if (!state.question) {
    renderedQuestion = null;
    sending = false;
    byId("question-body").replaceChildren();
    show("question", false);
    return;
  }
  show("question", true);
  // Only rebuild on a new question, so a state push cannot wipe what is being typed.
  if (state.question.id !== renderedQuestion) {
    renderedQuestion = state.question.id;
    sending = false;
    buildQuestion(state.question);
  }
}

function appendLog(line) {
  const pane = byId("log");
  const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
  pane.append(line + "\\n");
  if (atBottom) pane.scrollTop = pane.scrollHeight;
}

const source = new EventSource("/events?" + ${JSON.stringify(WIZARD_TOKEN_QUERY)} + "=" + encodeURIComponent(token));
source.addEventListener("snapshot", (event) => {
  const snapshot = JSON.parse(event.data);
  byId("log").replaceChildren(snapshot.log.join("\\n") + (snapshot.log.length > 0 ? "\\n" : ""));
  render(snapshot);
});
source.addEventListener("state", (event) => render(JSON.parse(event.data)));
source.addEventListener("log", (event) => appendLog(JSON.parse(event.data)));
source.addEventListener("closed", () => {
  source.close();
  byId("subtitle").textContent = "The installer has stopped. You can close this tab.";
  show("question", false);
});
source.addEventListener("error", () => {
  if (source.readyState === EventSource.CLOSED) byId("subtitle").textContent = "Lost the connection to the installer. Check the terminal.";
});
`;
