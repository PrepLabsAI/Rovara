// The setup page: what a setup run is doing and found, in the owner's own session. A command, a website and the use of a setup are decided here and nowhere else (a route and a token cannot). Everything that came
// from the repository or the model (a command, a path, its output, a website name) is shown as plain text, marked as from the repository, and never as a link or an instruction.
import { randomUUID } from "node:crypto";
import { esc, layout, untrusted } from "./html.js";
import type { PageContext } from "./pages.js";
import type { ApprovalOffer, SetupItemView, SetupPageView } from "./views.js";

const hidden = (name: string, value: string | number): string => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
const CHECK_WORDS = { unchecked: "not checked yet", outdated: "checked for an older version", checking: "being checked now", failed: "failed", ready: "passed" } as const;
const CHECK_CLASS = { unchecked: "muted", outdated: "warn", checking: "warn", failed: "bad", ready: "ok" } as const;
const VERDICT_WORDS = { verified: "confirmed in the repository", unverified: "not found where it says", unchecked: "could not be checked" } as const;
const VERDICT_CLASS = { verified: "ok", unverified: "bad", unchecked: "warn" } as const;
const KIND_WORDS: Record<string, string> = { setup: "Setup command", tests: "Test command", repository: "Repository", devcontainer: "Dev container", check: "Check", knowledge: "Knowledge", allowed_domain: "Website", test_environment: "Test environment", source: "Source", intake: "Intake", secret: "Secret", spec_target: "Spec target" };
const STATUS_WORDS = { none: "Rovara has not set this project up yet.", running: "Rovara is running the setup now.", ready: "Rovara finished and has a setup to use.", failed: "The setup run did not finish." } as const;

export function renderSetupIndex(context: PageContext, projects: readonly string[]): string {
  const rows = projects.map((project) => `<li><a href="${esc(context.base)}/setup/${esc(project)}">${esc(project)}</a></li>`).join("");
  return layout({
    title: "Set up a project", nonce: context.nonce, base: context.base, ...(context.notice === undefined ? {} : { notice: context.notice }),
    body: `<h1>Set up a project</h1><p class="muted">Rovara runs a project's setup and test commands in a sandbox, tries again when they fail, and shows you what worked. Nothing it finds changes the project until you approve it here.</p>${rows === "" ? "<p class=\"muted\">No project is registered yet.</p>" : `<ul>${rows}</ul>`}`,
  });
}

export function renderSetupPage(context: PageContext, view: SetupPageView): string {
  const action = (name: string): string => `${esc(context.base)}/setup/${esc(view.project)}/${name}`;
  const token = (name: string, extra: { requestId?: string; revision?: number; artifactDigest?: string; subject?: string } = {}): string => hidden("ft", context.formToken({ action: `setup.${name}`, subject: view.project, ...extra }));
  const button = (label: string, cls = ""): string => `<button type="submit"${cls === "" ? "" : ` class="${cls}"`}>${esc(label)}</button>`;

  const control = (): string => {
    if (view.status === "running") {
      const stopId = randomUUID();
      const commandId = randomUUID();
      return `<form method="post" action="${action("stop")}" class="row">${hidden("requestId", stopId)}${token("stop", { requestId: stopId })}${button("Stop the run", "danger")}</form>`
        + `<form method="post" action="${action("command")}" class="decide"><label>Run one command in the sandbox<br><input type="text" name="command" maxlength="1000" size="60" autocomplete="off"></label>${hidden("requestId", commandId)}${token("command", { requestId: commandId })}${button("Run it")}</form>`
        + `<p class="muted">A command runs in the setup sandbox, as you typed it, and its result is shown to Rovara as data. It is never sent anywhere else. A command that holds a secret is refused.</p>`;
    }
    if (view.cannotStart !== undefined) return `<p class="notice">${esc(view.cannotStart)}</p>`;
    const requestId = randomUUID();
    return `<form method="post" action="${action("start")}" class="row">${hidden("requestId", requestId)}${token("start", { requestId })}${button(view.status === "none" ? "Set this project up" : "Run the setup again", "primary")}</form>`
      + `<p class="muted">A run is limited to ${esc(view.limits.commands)} commands, ${esc(view.limits.wallClockMin)} minutes and about $${esc((view.limits.budgetCents / 100).toFixed(2))} of model use.</p>`;
  };

  const itemRow = (item: SetupItemView): string => {
    const box = item.usable && item.verdict !== "unverified" ? `<input type="checkbox" name="item" value="${esc(item.id)}"${item.verdict === "verified" ? " checked" : ""}>` : "";
    return `<tr><td>${box}</td><td>${esc(KIND_WORDS[item.kind] ?? item.kind)}</td><td><code>${item.lines.map((line) => untrusted(line)).join("<br>")}</code><br><span class="muted">from the repository: ${item.from.length === 0 ? "no place is named" : item.from.map((place) => untrusted(place)).join(", ")}</span></td>`
      + `<td class="${VERDICT_CLASS[item.verdict]}">${esc(VERDICT_WORDS[item.verdict])}</td></tr>`;
  };

  const proposal = (): string => {
    if (view.items.length === 0) return "";
    const usable = view.items.some((item) => item.usable);
    const requestId = randomUUID();
    const table = `<table><thead><tr><th></th><th>What</th><th>Value</th><th>Checked against the repository</th></tr></thead><tbody>${view.items.map(itemRow).join("")}</tbody></table>`;
    const form = view.status === "ready" && view.apply === undefined && usable
      ? `<form method="post" action="${action("confirm")}" class="decide">${table}${hidden("requestId", requestId)}${hidden("revision", view.revision)}${token("confirm", { requestId, revision: view.revision })}<p>${view.verified ? "" : "<span class=\"warn\">Rovara could not finish checking where each suggestion came from, so it cannot be used yet.</span>"}</p>${view.verified ? button("Use this setup", "primary") : ""}</form><p class="muted">Using a setup does not change the project. Rovara first runs the commands on a fresh workspace; you approve them after that check passes.</p>`
      : table;
    return `<div class="panel"><h2>What Rovara found</h2>${form}</div>`;
  };

  const apply = (): string => {
    if (view.apply === undefined) return "";
    const offer = view.apply.approval;
    const lines = (label: string, list: readonly string[]): string => (list.length === 0 ? "" : `<p><strong>${esc(label)}</strong></p><pre>${list.map((line) => untrusted(line)).join("\n")}</pre>`);
    const decide = (decision: "approve" | "reject", offerOf: ApprovalOffer): string => `<form method="post" action="${action("apply")}" class="row">${hidden("decision", decision)}${hidden("requestId", offerOf.requestId)}${hidden("revision", offerOf.revision)}${hidden("digest", offerOf.artifactDigest)}${hidden("ft", context.formToken({ action: "setup.apply", subject: view.project, requestId: offerOf.requestId, revision: offerOf.revision, artifactDigest: offerOf.artifactDigest }))}${button(decision === "approve" ? "Approve these commands" : "Reject", decision === "approve" ? "primary" : "danger")}</form>`;
    return `<div class="panel"><h2>Waiting for your approval</h2><p>Rovara is running these commands on a fresh workspace. The check is <span class="${CHECK_CLASS[view.apply.check.status]}">${esc(CHECK_WORDS[view.apply.check.status])}</span>${view.apply.check.failedStep === undefined ? "" : `: ${untrusted(view.apply.check.failedStep)}`}.</p>`
      + lines("Setup commands", view.apply.setup) + lines("Test commands", view.apply.readiness)
      + (offer === undefined ? "" : `<div class="row">${decide("approve", offer)}${decide("reject", offer)}</div><p class="muted">Approving makes these the project's setup and test commands for every task that starts after it.</p>`)
      + `<form method="post" action="${action("discard")}" class="row">${token("discard")}${button("Discard")}</form></div>`;
  };

  const hosts = (): string => {
    if (view.hostAsks.length === 0) return "";
    const rows = view.hostAsks.map((ask) => {
      const offer = ask.approval;
      const form = (decision: "approve" | "reject"): string => offer === undefined ? "" : `<form method="post" action="${action("host")}" class="row">${hidden("decision", decision)}${hidden("host", ask.host)}${hidden("requestId", offer.requestId)}${hidden("revision", offer.revision)}${hidden("digest", offer.artifactDigest)}${hidden("ft", context.formToken({ action: "setup.host", subject: `${view.project}:${ask.host}`, requestId: offer.requestId, revision: offer.revision, artifactDigest: offer.artifactDigest }))}${button(decision === "approve" ? "Allow" : "Refuse", decision === "approve" ? "primary" : "danger")}</form>`;
      return `<tr><td><code>${esc(ask.host)}</code>${ask.international ? " <span class=\"warn\">(an international name: it may look like another)</span>" : ""}<br><span class="muted">${ask.from === undefined ? "" : `from the repository: ${untrusted(ask.from.path)}:${esc(ask.from.line)}`}</span></td><td>${esc(ask.status)}</td><td class="row">${form("approve")}${form("reject")}</td></tr>`;
    }).join("");
    return `<div class="panel"><h2>Websites the setup needs</h2><p class="muted">Allowing one lets the install's next worker machine reach it. It does not change a machine that is already running.</p><table><thead><tr><th>Website</th><th>State</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  };

  const approved = (): string => view.approvedHosts.length === 0 ? "" : `<div class="panel"><h2>Websites you allowed</h2><p class="muted">The next machines of this project reach these. Taking one back does not change a machine that is already running.</p><table><tbody>${view.approvedHosts.map((entry) => `<tr><td><code>${esc(entry.host)}</code>${entry.at === undefined ? "" : ` <span class="muted">allowed ${esc(entry.at.slice(0, 10))}</span>`}</td><td><form method="post" action="${action("forget")}" class="row">${hidden("host", entry.host)}${hidden("ft", context.formToken({ action: "setup.forget", subject: `${view.project}:${entry.host}` }))}${button("Take it back")}</form></td></tr>`).join("")}</tbody></table></div>`;

  const journal = (): string => view.journal.length === 0 ? "" : `<div class="panel"><h2>What it ran</h2><table><thead><tr><th>#</th><th>Command</th><th>Result</th></tr></thead><tbody>${view.journal.map((entry) => `<tr><td>${esc(entry.n)}</td><td><code>${untrusted(entry.command)}</code>${entry.source === "person" ? " <span class=\"muted\">(you)</span>" : ""}${entry.flagged ? " <span class=\"warn\">downloads and runs code</span>" : ""}</td><td>${entry.timedOut ? "<span class=\"bad\">timed out</span>" : entry.exitCode === 0 ? "<span class=\"ok\">worked</span>" : `<span class="bad">exit ${esc(entry.exitCode ?? "?")}</span>`}<pre>${untrusted(entry.tail)}</pre></td></tr>`).join("")}</tbody></table></div>`;

  const checkRequest = randomUUID();
  const checkPanel = `<div class="panel"><h2>The project's setup check</h2><p>The project's own setup and test commands are <span class="${CHECK_CLASS[view.check.status]}">${esc(CHECK_WORDS[view.check.status])}</span>${view.check.failedStep === undefined ? "" : `: ${untrusted(view.check.failedStep)}`}.</p>`
    + `<form method="post" action="${action("check")}" class="row">${hidden("requestId", checkRequest)}${token("check", { requestId: checkRequest })}${button("Check the setup now")}</form></div>`;
  const summary = view.summary === undefined ? "" : `<p class="muted">${esc(view.summary.commandsRun)} commands, ${esc(view.summary.elapsedMin)} minutes, about $${esc((view.summary.spendCents / 100).toFixed(2))}${view.summary.partial ? ", stopped before it finished (what it learned is kept)" : ""}.</p>`;
  return layout({
    title: `Set up ${view.project}`, nonce: context.nonce, base: context.base, ...(context.notice === undefined ? {} : { notice: context.notice }),
    body: `<h1>Set up ${esc(view.project)}</h1><p>${esc(STATUS_WORDS[view.status])}${view.failure === undefined ? "" : ` ${esc(view.failure)}`}${view.stoppedBy === undefined ? "" : ` <span class="muted">Stopped by ${untrusted(view.stoppedBy)}.</span>`}</p>${summary}${control()}${apply()}${hosts()}${approved()}${proposal()}${journal()}${checkPanel}`
      + `<p><a href="${esc(context.base)}/setup">All projects</a></p>`,
  });
}
