// The Connections page and the Sources page: pure functions from a view model to HTML, like the other pages. Every change is one verified form, in a page session opened a few minutes ago; the
// form token binds the operation and the thing it is about (a connection id, a server id, a change id), and the server checks that binding again when the form comes back.
// A secret field is a password box: it goes to the server in the one post and is never drawn again.
import { randomUUID } from "node:crypto";
import { CONNECTION_FORMS, type ConnectionFormField } from "./connection-forms.js";
import { esc, layout, untrusted } from "./html.js";
import type { PageContext } from "./pages.js";
import type { ConnectionsPageView, SourcesPageView } from "./views.js";

const hidden = (name: string, value: string | number): string => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;

/** One small form: the operation, what it is about, and its own form token. */
function actionForm(context: PageContext, path: string, op: string, subject: string, inner: string, button: string, options: { cls?: string; requestId?: string } = {}): string {
  const requestId = options.requestId;
  return `<form class="decide" method="post" action="${esc(context.base)}${esc(path)}">${hidden("op", op)}${requestId === undefined ? "" : hidden("requestId", requestId)}${inner}`
    + `${hidden("ft", context.formToken({ action: "connections.act", subject: `${op}:${subject}`, ...(requestId === undefined ? {} : { requestId }) }))}`
    + `<div class="row"><button type="submit"${options.cls === undefined ? "" : ` class="${esc(options.cls)}"`}>${esc(button)}</button></div></form>`;
}

function fieldHtml(field: ConnectionFormField): string {
  const name = `f_${field.name}`;
  const hint = field.hint === undefined ? "" : ` <span class="muted">${esc(field.hint)}</span>`;
  if (field.kind === "select") return `<label>${esc(field.label)}<br><select name="${esc(name)}">${(field.options ?? []).map((option) => `<option value="${esc(option)}">${esc(option)}</option>`).join("")}</select></label>`;
  return `<label>${esc(field.label)}${hint}<br><input type="${field.kind === "password" ? "password" : "text"}" name="${esc(name)}"${field.required === true ? " required" : ""} autocomplete="off" spellcheck="false"></label>`;
}

export function renderConnections(context: PageContext, view: ConnectionsPageView, options: { fresh: boolean }): string {
  const stale = options.fresh ? "" : "<p class=\"warn\">This page was opened a while ago. To change anything, close it and run <code>rovara open connections</code> again, then make the change within ten minutes.</p>";
  const rows = view.connections.map((connection) => `<tr><td>${untrusted(connection.label)}<br><span class="muted">${esc(connection.type)} · ${esc(connection.connectionId)}</span></td>`
    + `<td>${untrusted(connection.detail)}</td><td>${esc(connection.access === "read" ? "reads" : "reads and writes")}</td>`
    + `<td>${connection.hasCredential ? "<span class=\"ok\">ready</span>" : "<span class=\"warn\">no key saved</span>"}<br>`
    + `${connection.lastCheck === undefined ? "<span class=\"muted\">not checked yet</span>" : `<span class="${connection.lastCheck.ok ? "ok" : "bad"}">${connection.lastCheck.ok ? "last check passed" : "last check failed"}</span> <span class="muted">${esc(connection.lastCheck.at)}</span>`}</td>`
    + `<td class="row">${options.fresh ? actionForm(context, "/connections/act", "check", connection.connectionId, hidden("connectionId", connection.connectionId), "Check", { requestId: randomUUID() })
      + actionForm(context, "/connections/act", "remove", connection.connectionId, hidden("connectionId", connection.connectionId), "Remove", { cls: "danger", requestId: randomUUID() }) : ""}</td></tr>`);
  const add = options.fresh ? CONNECTION_FORMS.map((form) => {
    const write = form.mayWrite ? "<label>What it may do<br><select name=\"access\"><option value=\"read\">Read only</option><option value=\"read_write\">Read and write</option></select></label>" : "";
    const unchecked = view.monitoringKinds.includes(form.type) || !["sentry", "datadog", "grafana", "vercel", "pagerduty"].includes(form.type) ? "" : "<p class=\"warn\">No adapter for this kind is registered on this install, so it cannot be checked.</p>";
    return `<details><summary>${esc(form.title)}</summary>${unchecked}${actionForm(context, "/connections/act", "save", form.type,
      `${hidden("type", form.type)}<label>A name for it<br><input type="text" name="f_label" maxlength="64" required autocomplete="off"></label>${form.fields.map(fieldHtml).join("")}${write}`, "Save the connection", { cls: "primary", requestId: randomUUID() })}</details>`;
  }).join("") : "";
  const servers = view.servers.map((server) => {
    const tools = server.tools.length === 0 ? "" : `<details><summary>${esc(server.tools.length)} tools</summary><ul>${server.tools.map((tool) => `<li>${untrusted(tool.name)} <span class="muted">${esc(tool.annotation.replaceAll("_", " "))}</span> ${untrusted(tool.description)}</li>`).join("")}</ul></details>`;
    const acts = !options.fresh ? "" : [
      ...(server.status === "awaiting_approval" ? [actionForm(context, "/connections/act", "server-approve", server.serverId, hidden("serverId", server.serverId), "Approve", { cls: "primary" })] : []),
      ...(server.status === "approved" || server.status === "changed_needs_review" ? [actionForm(context, "/connections/act", "server-disable", server.serverId, hidden("serverId", server.serverId), "Turn off")] : []),
      ...(server.status !== "approved" ? [actionForm(context, "/connections/act", "server-remove", server.serverId, hidden("serverId", server.serverId), "Remove", { cls: "danger" })] : []),
    ].join("");
    return `<tr><td>${untrusted(server.label)}<br><span class="muted">${esc(server.serverId)} · ${esc(server.transport)}</span></td><td>${server.address === undefined ? "runs from a package" : untrusted(server.address)}${server.hasToken ? "<br><span class=\"muted\">has a token</span>" : ""}</td>`
      + `<td>${esc(server.status.replaceAll("_", " "))}${server.pausedAt === undefined ? "" : `<br><span class="warn">its tools changed ${esc(server.pausedAt)}</span>`}</td><td>${tools}</td><td class="row">${acts}</td></tr>`;
  });
  const addServer = !options.fresh ? "" : view.privateRangesSet
    ? `<details><summary>Add an MCP server on your own network</summary>${actionForm(context, "/connections/act", "server-add", "new",
      "<label>A name for it<br><input type=\"text\" name=\"label\" maxlength=\"60\" required autocomplete=\"off\"></label><label>Address <span class=\"muted\">https://host:port/path</span><br><input type=\"text\" name=\"address\" required autocomplete=\"off\" spellcheck=\"false\"></label>"
      + "<label>Token (optional, never shown again)<br><input type=\"password\" name=\"token\" autocomplete=\"off\"></label>", "Test it and add it", { cls: "primary" })}</details>`
    : "<p class=\"muted\">To add an MCP server on your own network, name the address ranges it may be in first: set <code>ROVARA_PRIVATE_MCP_CIDRS</code> (and <code>ROVARA_VPC_CIDRS</code>) and start Rovara again. With none named, every private server is refused.</p>";
  const projects = view.projects.length === 0 ? "" : `<p>Context sources of a project: ${view.projects.map((project) => `<a href="${esc(context.base)}/sources?project=${encodeURIComponent(project)}">${untrusted(project)}</a>`).join(", ")}</p>`;
  return layout({
    title: "Connections", nonce: context.nonce, base: context.base, ...(context.notice === undefined ? {} : { notice: context.notice }),
    body: "<h1>Connections</h1><p>A connection is a key you give Rovara for a tracker, an MCP server or a monitoring service. A key is kept only in a file you alone can read, is never shown again, and what a connection reads is shown to a model as data, never as an instruction. Adding or changing one is done here, by you: a tool that holds your API token cannot.</p>"
      + `${stale}<section class="panel" id="connections"><h2>Saved connections</h2>${rows.length === 0 ? "<p class=\"muted\">You have no connections.</p>" : `<table><thead><tr><th>Connection</th><th>Points at</th><th>May</th><th>State</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table>`}</section>`
      + `${add === "" ? "" : `<section class="panel" id="add"><h2>Add a connection</h2>${add}</section>`}`
      + `<section class="panel" id="servers"><h2>MCP servers on your network</h2>${servers.length === 0 ? "<p class=\"muted\">No server is registered.</p>" : `<table><thead><tr><th>Server</th><th>Address</th><th>State</th><th>Offers</th><th></th></tr></thead><tbody>${servers.join("")}</tbody></table>`}${view.stdioAvailable ? "" : "<p class=\"muted\">Servers that Rovara would run from a package are not available on this install.</p>"}${addServer}</section>`
      + `<section class="panel" id="sources"><h2>Context sources</h2>${projects === "" ? "<p class=\"muted\">Register a project first.</p>" : projects}</section>`,
  });
}

const STAGE_WORDS: ReadonlyArray<[string, string]> = [["UNDERSTAND", "Understanding"], ["PLAN", "Planning"], ["PLAN_CRITIQUE", "Checking the plan"], ["REVIEW", "Review"]];
const ROLE_WORDS: ReadonlyArray<[string, string]> = [["search", "searches"], ["read", "reads one item"], ["status", "reads a status"]];

export function renderSources(context: PageContext, view: SourcesPageView, options: { fresh: boolean }): string {
  const stale = options.fresh ? "" : "<p class=\"warn\">This page was opened a while ago. To change anything, close it and run <code>rovara open connections</code> again, then make the change within ten minutes.</p>";
  const subject = (value: string): string => `${view.project}:${value}`;
  const sources = view.sources.map((source) => `<tr><td>${untrusted(source.label)}<br><span class="muted">${esc(source.sourceId)}</span></td><td>${untrusted(source.server)}</td>`
    + `<td>${source.stages.map((stage) => esc(STAGE_WORDS.find(([key]) => key === stage)?.[1] ?? stage)).join(", ")}</td>`
    + `<td>${source.tools.map((tool) => `${untrusted(tool.name)} <span class="muted">${esc(tool.role)}${tool.attested ? ", you confirmed it only reads" : ""}</span>`).join("<br>")}</td>`
    + `<td>${esc(source.quotes.replaceAll("_", " "))}, ${esc(source.retention.replaceAll("_", " "))}${source.sendCodeSnippets ? "<br><span class=\"warn\">may be sent code</span>" : ""}</td>`
    + `<td>${options.fresh ? actionForm(context, "/sources/act", "source-remove", subject(source.sourceId), `${hidden("project", view.project)}${hidden("sourceId", source.sourceId)}`, "Remove", { cls: "danger" }) : ""}</td></tr>`);
  const pending = view.pending.map((change) => `<li>${change.kind === "remove" ? "Remove" : "Add or change"} <strong>${untrusted(change.label ?? change.sourceId)}</strong> <span class="muted">${esc(change.proposedAt)}</span>`
    + `${change.reasons.length === 0 ? "" : `<br><span class="warn">Read again before you confirm: ${change.reasons.map((reason) => untrusted(reason)).join("; ")}.</span>`}`
    + `${options.fresh ? `<div class="row">${actionForm(context, "/sources/act", "source-confirm", subject(change.changeId), `${hidden("project", view.project)}${hidden("changeId", change.changeId)}`, "Confirm", { cls: "primary" })}`
      + `${actionForm(context, "/sources/act", "source-reject", subject(change.changeId), `${hidden("project", view.project)}${hidden("changeId", change.changeId)}`, "Turn down")}</div>` : ""}</li>`);
  const choose = view.serverChoices.length === 0 ? "<p class=\"muted\">There is nothing to read from yet: add a read-only MCP connection or approve an MCP server on the Connections page.</p>"
    : `<form class="decide" method="get" action="${esc(context.base)}/sources"><input type="hidden" name="project" value="${esc(view.project)}"><label>Look at the tools of<br><select name="discover">${view.serverChoices.map((choice) => `<option value="${esc(choice.value)}">${untrusted(choice.label)}</option>`).join("")}</select></label><div class="row"><button type="submit">List its tools</button></div></form>`;
  let add = "";
  const found = view.discovered;
  if (found !== undefined && "problem" in found) add = `<p class="warn">${untrusted(found.problem)}</p>`;
  else if (found !== undefined && options.fresh) {
    const tools = found.tools.map((tool, index) => {
      const note = tool.annotation === "unsafe" ? "<span class=\"bad\">says it changes things: cannot be used</span>"
        : tool.annotation === "unannotated" || tool.nameSuggestsChange ? `<span class="warn">${tool.annotation === "unannotated" ? "does not say it only reads" : "its name sounds like a change"}</span> <label><input type="checkbox" name="attest_${index}" value="1"> I confirm it only reads</label>`
        : "<span class=\"ok\">says it only reads</span>";
      const address = tool.takesAddress ? " <span class=\"muted\">takes an address: only used on this server's own host</span>" : "";
      return `<tr><td>${tool.annotation === "unsafe" ? "" : `<input type="checkbox" name="tool" value="${index}">`}${hidden(`tool_name_${index}`, tool.name)}${hidden(`tool_hash_${index}`, tool.schemaHash)}</td>`
        + `<td>${untrusted(tool.name)}<br><span class="muted">${untrusted(tool.description)}</span>${address}</td><td>${note}</td>`
        + `<td><select name="role_${index}">${ROLE_WORDS.map(([value, label]) => `<option value="${value}">${esc(label)}</option>`).join("")}</select></td></tr>`;
    });
    add = `<h3>${untrusted(found.serverLabel)}</h3>${actionForm(context, "/sources/act", "source-propose", subject("new"),
      `${hidden("project", view.project)}${hidden("server", found.server)}<table><thead><tr><th>Use</th><th>Tool</th><th>What Rovara checked</th><th>It</th></tr></thead><tbody>${tools.join("")}</tbody></table>`
      + "<label>A name for the source<br><input type=\"text\" name=\"label\" maxlength=\"60\" required autocomplete=\"off\"></label>"
      + "<label>Its short id (2 to 16 lower-case letters and digits)<br><input type=\"text\" name=\"sourceId\" pattern=\"[a-z][a-z0-9]{1,15}\" required autocomplete=\"off\"></label>"
      + `<fieldset><legend>Where it may be read</legend>${STAGE_WORDS.map(([value, label]) => `<label><input type="checkbox" name="stage" value="${value}"${value === "BUILD" ? "" : " checked"}> ${esc(label)}</label>`).join(" ")}<p class="muted">Never while the code is written.</p></fieldset>`
      + "<label>Who may see a quote<br><select name=\"quotes\"><option value=\"project_members\">You (quotes are shown)</option><option value=\"citations_only\">Nobody (only the title and the link are shown)</option></select></label>"
      + "<label>What is kept<br><select name=\"retention\"><option value=\"live_only\">Nothing after the task ends</option><option value=\"team_record\">Text may be kept in the team record</option></select></label>"
      + "<label><input type=\"checkbox\" name=\"sendCodeSnippets\" value=\"1\"> A query may carry code</label>", "Propose this source", { cls: "primary" })}`;
  }
  return layout({
    title: `Sources of ${view.project}`, nonce: context.nonce, base: context.base, ...(context.notice === undefined ? {} : { notice: context.notice }),
    body: `<h1>Sources of ${untrusted(view.project)}</h1><p>A source is a read-only system a stage may ask while it understands, plans, checks the plan or reviews. Never while the code is written. What it returns is shown to a model as data, and every tool you tick is checked to only read. Ticking tools is done here, by you.</p>`
      + `${stale}<section class="panel" id="sources"><h2>Sources</h2>${sources.length === 0 ? "<p class=\"muted\">This project has no sources.</p>" : `<table><thead><tr><th>Source</th><th>Reads from</th><th>Stages</th><th>Tools</th><th>Quotes</th><th></th></tr></thead><tbody>${sources.join("")}</tbody></table>`}</section>`
      + `${pending.length === 0 ? "" : `<section class="panel" id="pending"><h2>Waiting for your confirmation</h2><ul>${pending.join("")}</ul></section>`}`
      + `<section class="panel" id="add"><h2>Add a source</h2>${choose}${add}</section><p><a href="${esc(context.base)}/connections">Connections</a></p>`,
  });
}
