// The wizard page: one HTML document, one stylesheet and one ES module, held here as text so they
// compile into `packages/cli/dist/` with everything else and ship in the published CLI without a
// bundler or a second build step (spec 040 Out Of Scope).
//
// The page has no inline script and no inline style, so the strict CSP below holds. It builds every
// node with `textContent`, so a question, a log line or a plan is text, never markup.
//
// Every same-origin asset this page links to must carry the session token in its URL: the server
// refuses any request without it (tests/contract/local-page-assets.test.ts).
//
// Spec 048 FR-001, FR-003, FR-004, FR-006, FR-008 and FR-011: the page shell. A slim header (where
// the install is), a progress rail of the five phases (journey.ts), and one panel that shows only
// the current step: the welcome text, a resume notice, a failure screen, the connect and finishing
// cards, the one question waiting on the operator, and the plan and the full log behind collapsed
// details so they never crowd the current step out.
import { CARD_PHASES, STEP_STATUS_WORDS } from "./journey.js";
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
<header class="top">
  <div><h1>Install AgentX</h1><p id="place">Connecting to the installer&hellip;</p></div>
  <p id="time-left" class="time-left"></p>
</header>
<div class="layout">
  <nav class="rail" aria-label="Install progress"><ol id="phases"></ol></nav>
  <main id="panel" aria-live="polite">
    <p id="step-of" class="step-of"></p>
    <section id="welcome" class="card hidden"><h2>Before you start</h2><div id="welcome-body"></div></section>
    <section id="resume" class="card hidden"><h2>Welcome back</h2><div id="resume-body"></div></section>
    <section id="failure" class="card status failed hidden" role="alert">
      <h2 id="failure-title"></h2>
      <h3>What happened</h3><p id="failure-what"></p>
      <h3>What to do</h3><p id="failure-next"></p>
      <div id="failure-actions"></div>
      <details><summary>Technical details</summary><div id="failure-details"></div></details>
    </section>
    <div id="cards"></div>
    <section id="next" class="card hidden"><h2>Open this</h2><div id="next-link"></div></section>
    <section id="question" class="card question hidden">
      <h2 id="question-text"></h2>
      <p id="question-why" class="why hidden"></p>
      <p id="question-example" class="hint hidden"></p>
      <div id="question-body"></div>
      <p id="question-error" class="error hidden" role="alert"></p>
    </section>
    <section id="outcome" class="card hidden"><h2 id="outcome-title"></h2><p id="outcome-body"></p><div id="outcome-commands"></div></section>
    <details id="plan" class="card hidden"><summary>View the plan</summary><pre id="plan-body"></pre></details>
    <details id="log-box" class="card"><summary>Show technical log</summary><pre id="log"></pre></details>
    <p id="closed-note" class="note hidden"></p>
  </main>
</div>
<script type="module" src="${script}"></script>
</body>
</html>
`;
}

// The installer's design system (type scale, spacing, color tokens and component classes) now
// lives in design.ts; re-exported here so server.ts keeps its existing import unchanged.
export { WIZARD_CSS } from "./design.js";

/** The page's module. It is plain browser JavaScript held as text, not TypeScript: nothing here is
 * compiled, imported by Node, or type-checked with the rest of the CLI. */
export const WIZARD_JS = `// AgentX install wizard. Served from 127.0.0.1 by the AgentX installer; loopback only.
const token = new URL(import.meta.url).searchParams.get(${JSON.stringify(WIZARD_TOKEN_QUERY)}) ?? "";
const TOKEN_HEADER = ${JSON.stringify(WIZARD_TOKEN_HEADER)};
const CARD_PHASES = ${JSON.stringify(CARD_PHASES)};
const STEP_WORDS = ${JSON.stringify(STEP_STATUS_WORDS)};
const byId = (id) => document.getElementById(id);
const show = (id, on) => { byId(id).classList.toggle("hidden", !on); };
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const setText = (id, text) => { byId(id).textContent = text ?? ""; show(id, Boolean(text)); };

let renderedQuestion = null;
let sending = false;
let lastState = null;
let installerClosed = false;

function post(path, body) {
  return fetch(path, { method: "POST", headers: { "content-type": "application/json", [TOKEN_HEADER]: token }, body: JSON.stringify(body ?? {}) });
}

function clockText(seconds) {
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}

function elapsedText(node) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(node.dataset.started)) / 1000));
  const usual = Number(node.dataset.usual);
  return " (" + clockText(seconds) + " so far, " + (seconds > usual ? "taking longer than usual" : node.dataset.usualText) + ")";
}

function linkBlock(link) {
  const wrap = el("p");
  const anchor = el("a", "button primary", link.label);
  anchor.href = link.url;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  wrap.append(anchor);
  if (link.note) wrap.append(el("span", "hint", " " + link.note));
  return wrap;
}

function commandRow(command) {
  const row = el("div", "command");
  const copy = el("button", "", "Copy");
  copy.type = "button";
  copy.addEventListener("click", () => {
    const done = () => { copy.textContent = "Copied"; };
    const failed = () => { copy.textContent = "Select it and copy"; };
    if (navigator.clipboard) navigator.clipboard.writeText(command.command).then(done, failed); else failed();
  });
  row.append(el("span", "", command.label + ":"), el("code", "", command.command), copy);
  return row;
}

function detailsBlock(lines) {
  const details = el("details");
  details.append(el("summary", "", "Technical details"));
  for (const line of lines) details.append(el("p", "", line));
  return details;
}

function renderRail(state) {
  const list = byId("phases");
  list.replaceChildren();
  for (const phase of state.journey.phases) {
    const item = el("li", "phase " + phase.status);
    if (phase.id === state.journey.current) item.setAttribute("aria-current", "step");
    item.append(el("span", "phase-title", phase.title), el("span", "phase-status", phase.statusWord), el("span", "phase-time", phase.timeText));
    const steps = state.steps.filter((step) => step.phase === phase.id);
    if (phase.id === state.journey.current && steps.length > 0) {
      const ul = el("ul", "steps");
      for (const step of steps) {
        const li = el("li", "step " + step.status, step.title + ": " + (STEP_WORDS[step.status] ?? ""));
        if (step.status === "running" && step.startedAt) {
          const time = el("span", "elapsed");
          time.dataset.started = step.startedAt;
          time.dataset.usual = String(step.usualSeconds);
          time.dataset.usualText = step.usualText;
          time.textContent = elapsedText(time);
          li.append(time);
        }
        ul.append(li);
      }
      item.append(ul);
    } else if (phase.status === "done") {
      const finished = steps.filter((step) => step.status === "done" || step.status === "skipped");
      const cards = (state.cards ?? []).filter((card) => CARD_PHASES[card.id] === phase.id && card.status === "ok" && card.id !== "ready");
      if (finished.length + cards.length > 0) {
        const details = el("details");
        details.append(el("summary", "", "Details"));
        for (const step of finished) details.append(el("p", "", step.title + (step.tookSeconds === undefined ? ": done" : ": took " + clockText(step.tookSeconds))));
        for (const card of cards) for (const line of card.lines) details.append(el("p", "", line));
        item.append(details);
      }
    }
    list.append(item);
  }
}

function renderCard(card) {
  const section = el("section", "card status " + card.status);
  section.append(el("h2", "", card.title));
  for (const line of card.lines) section.append(el("p", "", line));
  if (card.checks) {
    const list = el("ul", "checks");
    for (const check of card.checks) list.append(el("li", check.ok ? "ok" : "failed", (check.ok ? "Ready: " : "Not ready: ") + check.label + ". " + check.detail));
    section.append(list);
  }
  if (card.link) section.append(linkBlock(card.link));
  let group;
  for (const command of card.commands ?? []) {
    if (command.group && command.group !== group) section.append(el("h3", "", command.group));
    group = command.group;
    section.append(commandRow(command));
  }
  if (card.id === "ready" && !installerClosed) {
    const buttons = el("div", "buttons");
    const close = el("button", "primary", "Close installer");
    close.type = "button";
    close.addEventListener("click", () => { close.disabled = true; post("/close"); });
    buttons.append(close);
    section.append(buttons);
  }
  if (card.details && card.details.length > 0) section.append(detailsBlock(card.details));
  return section;
}

function renderPanelCards(state) {
  const holder = byId("cards");
  holder.replaceChildren();
  const offered = new Set();
  // Every card's link counts as offered, not only a rendered one's: a card collapsed into its
  // phase's Details (status ok, not the current phase) could in principle still carry the run's
  // own link (state.ts only clears it when a replacing card's link actually differs), and the
  // bottom "Open this" button must not repeat a link a card already gave, shown or not.
  for (const card of state.cards ?? []) if (card.link) offered.add(card.link.url);
  for (const card of state.cards ?? []) {
    const current = CARD_PHASES[card.id] === state.journey.current;
    if (card.status === "ok" && !current && card.id !== "ready") continue;
    // FR-060: while the failure panel is up, it is the one place the failure is told; the failed
    // step's own card would only repeat it (its problem is in the panel's technical details).
    if (state.failure && card.status === "failed" && CARD_PHASES[card.id] === state.journey.current) continue;
    holder.append(renderCard(card));
  }
  const next = state.link && !offered.has(state.link.url) ? state.link : null;
  show("next", Boolean(next));
  byId("next-link").replaceChildren(...(next ? [linkBlock(next)] : []));
}

function renderFailure(failure) {
  show("failure", Boolean(failure));
  if (!failure) return;
  byId("failure-title").textContent = failure.title;
  byId("failure-what").textContent = failure.what;
  byId("failure-next").textContent = failure.next;
  const details = byId("failure-details");
  details.replaceChildren(...failure.details.map((line) => el("p", "", line)));
  if (failure.link) details.append(linkBlock(failure.link));
}

function submit(id, value) {
  if (sending) return;
  sending = true;
  for (const button of document.querySelectorAll("#question button, #failure-actions button")) button.disabled = true;
  post("/answer", { id, value }).then((response) => response.json()).then((reply) => {
    if (!reply.ok) sending = false;
  }).catch((error) => {
    sending = false;
    setText("question-error", "Could not reach the installer: " + error);
  });
}

function buttonRow(question) {
  const row = el("div", "buttons");
  for (const choice of question.buttons ?? []) {
    const button = el("button", choice.primary ? "primary" : "", choice.label);
    button.type = "button";
    button.addEventListener("click", () => submit(question.id, choice.value));
    row.append(button);
  }
  return row;
}

function sendButton(onSend) {
  const row = el("div", "buttons");
  const send = el("button", "primary", "Continue");
  send.type = "button";
  send.addEventListener("click", onSend);
  row.append(send);
  return row;
}

function hideFromPasswordManagers(field) {
  field.autocomplete = "off";
  field.spellcheck = false;
  field.setAttribute("data-1p-ignore", "");
  field.setAttribute("data-lpignore", "true");
  field.setAttribute("data-bwignore", "");
}

function buildForm(question, body) {
  const inputs = [];
  for (const field of question.fields ?? []) {
    const id = "field-" + field.name;
    const wrap = el("div", "field");
    const label = el("label", "field-label", field.label);
    label.htmlFor = id;
    const input = el("input");
    input.id = id;
    input.type = field.masked ? "password" : "text";
    if (field.masked) hideFromPasswordManagers(input);
    if (field.value && !field.masked) input.value = field.value;
    const notes = [];
    for (const [suffix, text, className] of [["why", field.why, "hint"], ["example", field.example ? "For example: " + field.example : undefined, "hint"], ["hint", field.hint, "hint"], ["error", field.error, "error"]]) {
      if (!text) continue;
      const note = el("p", className, text);
      note.id = id + "-" + suffix;
      notes.push(note);
    }
    if (field.error) input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", notes.map((note) => note.id).join(" "));
    wrap.append(label, input, ...notes);
    body.append(wrap);
    inputs.push([field, input]);
  }
  body.append(sendButton(() => {
    const values = Object.fromEntries(inputs.map(([field, input]) => [field.name, input.value]));
    if (!sending) for (const [field, input] of inputs) if (field.masked) input.value = "";
    submit(question.id, JSON.stringify(values));
  }));
}

function buildQuestion(question) {
  const body = byId("question-body");
  body.replaceChildren();
  byId("question-text").textContent = question.label ?? question.text;
  setText("question-why", question.why);
  setText("question-example", question.example ? "For example: " + question.example : undefined);
  setText("question-error", question.error);
  if (question.learnMoreUrl) {
    const more = el("a", "", "Learn more");
    more.href = question.learnMoreUrl;
    more.target = "_blank";
    more.rel = "noopener noreferrer";
    body.append(el("p", "hint"));
    body.lastChild.append(more, " (opens in a new tab)");
  }
  if (question.kind === "confirm" || question.kind === "actions") { body.append(buttonRow(question)); return; }
  if (question.kind === "form") { buildForm(question, body); return; }
  const described = ["question-why", "question-example", "question-error"].filter((id) => !byId(id).classList.contains("hidden"));
  let read;
  if (question.kind === "choose") {
    const group = el("div", "choices");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-labelledby", "question-text");
    for (const choice of question.choices ?? []) {
      const label = el("label");
      const radio = el("input");
      radio.type = "radio";
      radio.name = "choice-" + question.id;
      radio.value = choice.value;
      radio.checked = choice.value === question.defaultValue;
      label.append(radio, el("span", "", choice.label));
      group.append(label);
    }
    body.append(group);
    read = () => { const picked = group.querySelector("input:checked"); return picked ? picked.value : ""; };
  } else {
    const field = question.multiline ? el("textarea") : el("input");
    field.id = "answer-field";
    if (!question.multiline) field.type = question.masked ? "password" : "text";
    if (question.masked) hideFromPasswordManagers(field); else field.autocomplete = "on";
    field.setAttribute("aria-labelledby", "question-text");
    if (question.defaultValue && !question.masked) field.placeholder = question.defaultValue;
    body.append(field);
    if (question.hint) {
      const hint = el("p", "hint", question.hint);
      hint.id = "question-hint";
      described.push(hint.id);
      body.append(hint);
    }
    field.setAttribute("aria-describedby", described.join(" "));
    if (question.error) field.setAttribute("aria-invalid", "true");
    read = () => {
      const value = field.value;
      if (sending) return value;
      if (question.masked) field.value = "";
      return value;
    };
    if (!question.multiline) field.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); submit(question.id, read()); } });
    queueMicrotask(() => field.focus());
  }
  body.append(sendButton(() => submit(question.id, read())));
}

function render(state) {
  lastState = state;
  document.title = state.pageTitle;
  const where = [state.header.installName, state.header.account ? "AWS account " + state.header.account : "", state.header.region ?? ""].filter(Boolean);
  byId("place").textContent = "Install name: " + where.join(", ");
  byId("time-left").textContent = state.journey.timeLeftText;
  const current = state.journey.phases.find((phase) => phase.id === state.journey.current);
  byId("step-of").textContent = "Step " + state.journey.stepNumber + " of " + state.journey.stepCount + (current ? ": " + current.title : "");
  renderRail(state);
  show("welcome", Boolean(state.welcome));
  byId("welcome-body").replaceChildren(...(state.welcome ?? []).map((line) => el("p", "", line)));
  show("resume", Boolean(state.resume));
  if (state.resume) {
    byId("resume-body").replaceChildren(
      el("p", "", state.resume.continueFrom ? "Welcome back. Continuing with: " + state.resume.continueFrom + "." : "Welcome back. Every step is already done."),
      el("p", "", state.resume.completed.length > 0 ? "Already done: " + state.resume.completed.join(", ") + "." : "Nothing has finished yet."),
    );
  }
  renderFailure(state.failure);
  renderPanelCards(state);
  show("plan", Boolean(state.plan));
  if (state.plan) {
    byId("plan-body").textContent = state.plan;
    byId("plan").open = state.steps.every((step) => step.status === "pending");
  }
  const hasReady = (state.cards ?? []).some((card) => card.id === "ready");
  show("outcome", Boolean(state.outcome) && !hasReady);
  if (state.outcome) {
    byId("outcome-title").textContent = state.phase === "failed" ? "The install stopped" : "The install is paused";
    byId("outcome-body").textContent = state.outcome;
    byId("outcome-commands").replaceChildren(...(state.commands ?? []).map(commandRow));
  }
  if (!state.question) {
    renderedQuestion = null;
    sending = false;
    byId("question-body").replaceChildren();
    byId("failure-actions").replaceChildren();
    show("question", false);
    return;
  }
  // FR-060: the failure's own question (Try this step again, Stop for now) is the failure panel's
  // buttons, not a second card under it.
  const failureQuestion = Boolean(state.failure && state.question && state.question.kind === "actions");
  const renderKey = state.question.id + (failureQuestion ? " in failure" : "");
  show("question", !failureQuestion);
  if (renderKey !== renderedQuestion) {
    renderedQuestion = renderKey;
    sending = false;
    byId("question-body").replaceChildren();
    byId("failure-actions").replaceChildren();
    if (failureQuestion) byId("failure-actions").replaceChildren(buttonRow(state.question));
    else buildQuestion(state.question);
  }
}

function appendLog(line) {
  const pane = byId("log");
  const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
  pane.append(line + "\\n");
  if (atBottom) pane.scrollTop = pane.scrollHeight;
}

setInterval(() => { for (const node of document.querySelectorAll("[data-started]")) node.textContent = elapsedText(node); }, 1000);

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
  installerClosed = true;
  show("question", false);
  const ready = lastState && (lastState.cards ?? []).some((card) => card.id === "ready");
  const logPath = lastState && lastState.logPath ? lastState.logPath : "the install log";
  byId("closed-note").textContent = ready ? "The installer has closed. Everything on this page is also in " + logPath + "." : "The installer has stopped. You can close this tab.";
  show("closed-note", true);
  if (lastState) render(lastState);
});
source.addEventListener("error", () => {
  if (source.readyState !== EventSource.CLOSED || installerClosed) return;
  byId("closed-note").textContent = "Lost the connection to the installer. If it stopped, start the install again in a terminal; it continues where it left off.";
  show("closed-note", true);
});
`;
