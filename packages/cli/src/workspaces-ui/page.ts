// The workspaces page: one HTML document, one stylesheet and one ES module, held here as text so
// they compile into `packages/cli/dist/` with everything else and ship in the published CLI without
// a bundler or a second build step (spec 041 Out Of Scope, as in spec 040).
//
// The page has no inline script and no inline style, so the strict CSP below holds. Every node is
// built with `textContent`, so a project name, a workspace id or a server message is text, never
// markup.
//
// Every same-origin asset this page links to must carry the session token in its URL: the server
// refuses any request without it (tests/contract/local-page-assets.test.ts).
import { UI_TOKEN_HEADER, UI_TOKEN_QUERY } from "./protocol.js";

export const WORKSPACES_CSP = [
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
export function workspacesHtml(token: string): string {
  const query = `${UI_TOKEN_QUERY}=${encodeURIComponent(token)}`;
  const stylesheet = `/app.css?${query}`;
  const script = `/app.js?${query}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>AgentX workspaces</title>
<link rel="stylesheet" href="${stylesheet}">
</head>
<body>
<header>
  <div>
    <h1>Workspaces</h1>
    <p id="subtitle">Loading&hellip;</p>
  </div>
  <button id="refresh" type="button">Refresh</button>
</header>
<p id="error" class="error hidden"></p>
<main>
  <aside class="card">
    <h2>Projects</h2>
    <ul id="projects"></ul>
  </aside>
  <section class="card">
    <h2 id="workspaces-title">Workspaces</h2>
    <ul id="workspaces"></ul>
    <p id="empty" class="hint hidden"></p>
  </section>
</main>
<script type="module" src="${script}"></script>
</body>
</html>
`;
}

export const WORKSPACES_CSS = `:root { color-scheme: light dark; }
body { font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0 auto; max-width: 62rem; padding: 1.5rem 1rem 4rem; }
header { align-items: flex-start; display: flex; gap: 1rem; justify-content: space-between; margin-bottom: 1.25rem; }
h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
h2 { font-size: .85rem; letter-spacing: .06em; margin: 0 0 .75rem; text-transform: uppercase; opacity: .7; }
header p { margin: 0; opacity: .75; }
main { align-items: start; display: grid; gap: 1rem; grid-template-columns: 16rem 1fr; }
@media (max-width: 46rem) { main { grid-template-columns: 1fr; } }
.card { border: 1px solid rgba(128,128,128,.35); border-radius: .5rem; padding: 1rem; }
.hidden { display: none; }
ul { list-style: none; margin: 0; padding: 0; }
#projects li { margin: 0 0 .25rem; }
#projects button { background: none; border: 0; border-radius: .35rem; cursor: pointer; display: block; font: inherit; padding: .35rem .5rem; text-align: left; width: 100%; }
#projects button:hover { background: rgba(128,128,128,.14); }
#projects button.selected { background: rgba(26,86,219,.14); font-weight: 600; }
#projects .count { float: right; font-variant-numeric: tabular-nums; opacity: .6; }
#workspaces li { border-top: 1px solid rgba(128,128,128,.25); display: flex; gap: .75rem; justify-content: space-between; padding: .6rem 0; }
#workspaces li:first-child { border-top: 0; }
.id { font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break: break-all; }
.meta { display: block; font-size: .85rem; margin-top: .15rem; opacity: .7; }
.pill { border: 1px solid rgba(128,128,128,.45); border-radius: 999px; flex: none; font-size: .78rem; height: fit-content; padding: .1rem .6rem; text-transform: lowercase; }
.pill.ready { border-color: #2e7d32; color: #2e7d32; }
.pill.working, .pill.starting { border-color: #b06000; color: #b06000; }
.pill.failed, .pill.unhealthy { border-color: #c62828; color: #c62828; }
.pill.closed, .pill.stopped { opacity: .65; }
button { border: 1px solid rgba(128,128,128,.5); border-radius: .35rem; cursor: pointer; font: inherit; padding: .45rem 1rem; }
button[disabled] { cursor: progress; opacity: .6; }
.error { color: #c62828; margin: 0 0 1rem; }
.hint { font-size: .9rem; margin: .35rem 0 0; opacity: .7; }
`;

/** How often the page asks for the list again while the tab is open. */
export const REFRESH_MS = 15_000;

/** The page's module. Plain browser JavaScript held as text, not TypeScript: nothing here is
 * compiled, imported by Node, or type-checked with the rest of the CLI. */
export const WORKSPACES_JS = `// AgentX workspaces. Served from 127.0.0.1 by \`agentx workspaces\`; loopback only.
const token = new URL(import.meta.url).searchParams.get(${JSON.stringify(UI_TOKEN_QUERY)}) ?? "";
const TOKEN_HEADER = ${JSON.stringify(UI_TOKEN_HEADER)};
const REFRESH_MS = ${REFRESH_MS};
const byId = (id) => document.getElementById(id);
const show = (id, on) => { byId(id).classList.toggle("hidden", !on); };

let selected = null;
let latest = null;

/** The pill class for a state word, so unknown states from a newer server still render plainly. */
function pillClass(state) {
  if (state === "ready") return "ready";
  if (state === "working" || state === "starting") return "working";
  if (state === "failed to start") return "failed";
  if (state === "unhealthy") return "unhealthy";
  if (state === "closed" || state === "closing") return "closed";
  if (state === "stopped" || state === "not started") return "stopped";
  return "";
}

function renderProjects(data) {
  const list = byId("projects");
  list.replaceChildren();
  if (data.projects.length === 0) {
    const item = document.createElement("li");
    item.className = "hint";
    item.textContent = "No projects yet. Join a project's Slack channel, or ask an admin for access.";
    list.append(item);
    return;
  }
  for (const project of data.projects) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    if (project.name === selected) button.className = "selected";
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(data.workspaces.filter((workspace) => workspace.projectName === project.name).length);
    const name = document.createElement("span");
    name.textContent = project.name;
    button.append(count, name);
    button.addEventListener("click", () => { selected = project.name; render(latest); });
    item.append(button);
    list.append(item);
  }
}

function renderWorkspaces(data) {
  const workspaces = data.workspaces.filter((workspace) => workspace.projectName === selected);
  byId("workspaces-title").textContent = selected ? "Workspaces in " + selected : "Workspaces";
  const list = byId("workspaces");
  list.replaceChildren();
  for (const workspace of workspaces) {
    const item = document.createElement("li");
    const left = document.createElement("div");
    const id = document.createElement("span");
    id.className = "id";
    id.textContent = workspace.id;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = "revision " + workspace.projectRevision + " \\u00b7 updated " + new Date(workspace.updatedAt).toLocaleString();
    left.append(id, meta);
    const pill = document.createElement("span");
    pill.className = "pill " + pillClass(workspace.state);
    pill.textContent = workspace.state;
    item.append(left, pill);
    list.append(item);
  }
  const empty = workspaces.length === 0;
  show("empty", empty);
  if (empty) {
    byId("empty").textContent = selected
      ? "No workspaces in " + selected + " yet. Start a thread in its Slack channel."
      : "Pick a project to see its workspaces.";
  }
}

function render(data) {
  if (!data) return;
  latest = data;
  if (selected === null || !data.projects.some((project) => project.name === selected)) {
    selected = data.projects.length > 0 ? data.projects[0].name : null;
  }
  byId("subtitle").textContent = "Signed in to " + data.env + " as " + data.developer.name + " \\u00b7 " + data.workspaces.length + " workspace" + (data.workspaces.length === 1 ? "" : "s");
  renderProjects(data);
  renderWorkspaces(data);
  const notice = data.notices.includes("slack_unavailable")
    ? "Slack could not be reached, so projects you use through a Slack channel may be missing."
    : "";
  byId("error").textContent = notice;
  show("error", notice !== "");
}

function load() {
  const button = byId("refresh");
  button.disabled = true;
  return fetch("/data", { headers: { [TOKEN_HEADER]: token } })
    .then((response) => response.json())
    .then((reply) => {
      if (reply.ok) render(reply.data);
      else {
        byId("error").textContent = reply.error;
        show("error", true);
        byId("subtitle").textContent = "Could not read your workspaces.";
      }
    })
    .catch((error) => {
      byId("error").textContent = "could not reach agentx on this computer: " + error;
      show("error", true);
    })
    .finally(() => { button.disabled = false; });
}

byId("refresh").addEventListener("click", () => { void load(); });
setInterval(() => { if (!document.hidden) void load(); }, REFRESH_MS);
void load();
`;
