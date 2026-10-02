// Spec 048 FR-001, FR-003, FR-004, FR-006, FR-008 and FR-011: the page shell. The page has no DOM
// here, so these read its source: it must parse, render every word from state, and keep spec
// 040's rules (no inline script or style, text only through textContent).
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PAGE_CLASSES } from "../../packages/cli/src/init/ui/design.js";
import { WIZARD_CSS, WIZARD_JS, wizardHtml } from "../../packages/cli/src/init/ui/page.js";
import { lintCopy, quotedStrings, type CopyEntry } from "../support/copy-lint.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const html = wizardHtml("token-aaaaaaaa");

describe("the page shell", () => {
  it("is a module node can parse", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentx-page-")); dirs.push(dir);
    await writeFile(join(dir, "app.mjs"), WIZARD_JS);
    expect(() => execFileSync(process.execPath, ["--check", join(dir, "app.mjs")])).not.toThrow();
  });

  it("FR-001 and FR-003: has a header, a progress rail and one current-step panel", () => {
    for (const id of ['id="place"', 'id="time-left"', 'id="phases"', 'id="panel"', 'id="step-of"', 'id="question"', 'id="failure"']) expect(html).toContain(id);
    expect(html).toContain('aria-label="Install progress"');
  });

  it("FR-006: shows the welcome text from state while the install is in Get started", () => {
    expect(html).toContain('id="welcome"');
    expect(html).toContain('id="welcome-body"');
    expect(WIZARD_JS).toContain("state.welcome");
  });

  it("FR-004: the plan and the technical log are behind links", () => {
    expect(html).toMatch(/<details id="plan"[^>]*><summary>View the plan<\/summary><div id="plan-body"><\/div>/);
    expect(html).toMatch(/<details id="log-box"[^>]*><summary>Show technical log<\/summary>/);
  });

  it("FR-008: announces the panel, ties labels and errors to fields, and shows the question large and in plain case", () => {
    expect(html).toContain('<main id="panel" aria-live="polite">');
    expect(html).toContain('role="alert"');
    expect(WIZARD_JS).toContain("aria-describedby");
    expect(WIZARD_JS).toContain("if (notes.length > 0) input.setAttribute(\"aria-describedby\"");
    expect(WIZARD_JS).toContain("if (described.length > 0) field.setAttribute(\"aria-describedby\"");
    expect(WIZARD_JS).toContain("htmlFor");
    expect(WIZARD_JS).toContain('setAttribute("aria-labelledby", "question-text")');
    expect(WIZARD_CSS).not.toMatch(/text-transform:\s*uppercase/);
    expect(WIZARD_CSS).toMatch(/\.question h2 \{[^}]*font-size: var\(--text-xl\)/);
  });

  it("FR-060: a failure's actions are buttons inside the failure panel, and the failed step's own card is not repeated under it", () => {
    expect(html).toMatch(/<section id="failure"[^>]*>[\s\S]*<h3>What to do<\/h3><p id="failure-next"><\/p>\s*<div id="failure-actions"><\/div>\s*<details><summary>Technical details<\/summary>[\s\S]*?<\/section>/);
    expect(WIZARD_JS).toContain('const failureQuestion = Boolean(state.failure && state.question && state.question.kind === "actions");');
    expect(WIZARD_JS).toContain('byId("failure-actions").replaceChildren(buttonRow(state.question));');
    expect(WIZARD_JS).toContain('if (state.failure && card.status === "failed" && CARD_PHASES[card.id] === state.journey.current) continue;');
    expect(WIZARD_JS).toContain('document.querySelectorAll("#question button, #failure-actions button")');
  });

  it("FR-058: the ready card's commands sit under their group's subheading, as in the mockup", () => {
    expect(WIZARD_JS).toContain('if (command.group && command.group !== group) section.append(el("h3", "", command.group));');
  });

  it("Q4: a form field is never filled with a masked value, even if the server sent one", () => {
    expect(WIZARD_JS).toContain("if (field.value && !field.masked) input.value = field.value;");
  });

  it("never repeats a link as the bottom Open this button, even one a collapsed card gave", () => {
    // offered is built from every card's link, in its own loop, before the loop that skips a
    // collapsed (status ok, not the current phase) card from being rendered: a link does not have
    // to be shown on screen to count as already offered.
    expect(WIZARD_JS).toContain("for (const card of state.cards ?? []) if (card.link) offered.add(card.link.url);");
  });

  it("FR-005 and FR-011: takes the tab title, buttons and hints from state, and asks to close on Close installer", () => {
    expect(WIZARD_JS).toContain("document.title = state.pageTitle");
    expect(WIZARD_JS).toContain("question.buttons");
    expect(WIZARD_JS).toContain("question.hint");
    expect(WIZARD_JS).toContain('"/close"');
    expect(WIZARD_JS).not.toContain("defaultConfirm");
    expect(WIZARD_JS).not.toContain("Leave empty for");
  });

  it("FR-034: counts down to a card's waitUntil", () => {
    expect(WIZARD_JS).toContain("card.waitUntil");
    expect(WIZARD_JS).toContain("node.dataset.until");
  });

  // Review fix round 1: a waiting step's message (protocol.ts's WizardStep.message) is terminal-only
  // text that keeps the terminal's own rerun instruction (FR-072; slack-app.ts, finish-steps.ts).
  // Pinned here so the page cannot start rendering it without this test being touched too; the
  // copy-lint's stateEntries (tests/support/copy-lint.ts) reads it only as a technical detail.
  it("never renders a step's message: that text stays terminal-only (FR-072)", () => {
    expect(WIZARD_JS).not.toMatch(/\bstep\.message\b/);
  });

  it("uses only the design system's classes, on every element it builds", () => {
    const used = new Set<string>();
    for (const match of html.matchAll(/class="([^"]+)"/g)) for (const name of (match[1] ?? "").split(" ")) used.add(name);
    for (const match of WIZARD_JS.matchAll(/el\("[a-z0-9]+", "([^"]*)"/g)) for (const name of (match[1] ?? "").split(" ")) if (name !== "") used.add(name);
    for (const match of WIZARD_JS.matchAll(/"((?:card status|phase|step) )" \+/g)) for (const name of (match[1] ?? "").trim().split(" ")) used.add(name);
    expect([...used].filter((name) => !(PAGE_CLASSES as readonly string[]).includes(name))).toEqual([]);
    expect(used.size).toBeGreaterThan(20);
  });

  it("keeps spec 040's rules: no inline handler or style, and no markup built from text", () => {
    expect(html).not.toMatch(/\son[a-z]+=|\sstyle=/);
    expect(WIZARD_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it("FR-060 and SC-011: no static page text is an internal word, and none says Finished", () => {
    const strings = [...quotedStrings(WIZARD_JS), ...quotedStrings(html.replace(/<[^>]+>/g, '"').replace(/&hellip;/g, "..."))];
    expect(strings.join(" ")).not.toMatch(/\bFinished\b/);
    const entries: CopyEntry[] = strings.map((text, index) => ({ where: `page string ${index}`, text, context: /Lost the connection/.test(text) ? "lost-connection" : "page", failedRun: true }));
    expect(lintCopy(entries)).toEqual([]);
  });
});

describe("spec 048 phase 2: the settings screen", () => {
  it("FR-020: shows the Recommended settings above the fields", () => {
    expect(WIZARD_JS).toContain('el("h3", "", "Recommended settings")');
    expect(WIZARD_JS).toContain("question.summary");
  });

  it("FR-021: puts advanced fields in a collapsed Advanced settings section, opened when one of them is refused", () => {
    expect(WIZARD_JS).toContain('el("details", "advanced")');
    expect(WIZARD_JS).toContain('el("summary", "", "Advanced settings")');
    expect(WIZARD_JS).toContain('(question.fields ?? []).some((each) => each.section === "advanced" && each.error)');
  });

  it("FR-022: groups fields under one heading with a fieldset and legend", () => {
    expect(WIZARD_JS).toContain('el("fieldset", "group")');
    expect(WIZARD_JS).toContain('el("legend", "", field.group)');
  });

  it("FR-008: a choice field is a labelled select that starts on its default", () => {
    expect(WIZARD_JS).toContain('el("select")');
    expect(WIZARD_JS).toContain("input.value = field.value || field.defaultValue || \"\";");
    expect(WIZARD_JS).toContain("label.htmlFor = id;");
  });

  it("FR-011 and FR-037: the forward button carries the form's verb, and a field's link opens in a new tab", () => {
    expect(WIZARD_JS).toContain('sendButton(() => {');
    expect(WIZARD_JS).toContain('question.submitLabel ?? "Continue"');
    expect(WIZARD_JS).toContain('el("a", "field-link", field.link.label)');
  });

  it("every new text the page module holds passes the copy-lint", () => {
    const entries: CopyEntry[] = quotedStrings(WIZARD_JS).map((text) => ({ where: "page module", text, context: "page" }));
    expect(lintCopy(entries)).toEqual([]);
  });
});

describe("spec 048 FR-029: the plan review screen", () => {
  it("FR-029: shows the plan as sections and a cost table, with every resource behind a link", () => {
    expect(WIZARD_JS).toContain('el("table", "plan-table")');
    expect(WIZARD_JS).toContain('for (const heading of ["Item", "Monthly", "Basis"])');
    expect(WIZARD_JS).toContain('el("summary", "", "Show every resource")');
  });
});
