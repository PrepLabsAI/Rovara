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

  it("FR-004: the plan and the technical log are behind links", () => {
    expect(html).toMatch(/<details id="plan"[^>]*><summary>View the plan<\/summary>/);
    expect(html).toMatch(/<details id="log-box"[^>]*><summary>Show technical log<\/summary>/);
  });

  it("FR-008: announces the panel, ties labels and errors to fields, and shows the question large and in plain case", () => {
    expect(html).toContain('<main id="panel" aria-live="polite">');
    expect(html).toContain('role="alert"');
    expect(WIZARD_JS).toContain("aria-describedby");
    expect(WIZARD_JS).toContain("htmlFor");
    expect(WIZARD_JS).toContain('setAttribute("aria-labelledby", "question-text")');
    expect(WIZARD_CSS).not.toMatch(/text-transform:\s*uppercase/);
    expect(WIZARD_CSS).toMatch(/\.question h2 \{[^}]*font-size: var\(--text-xl\)/);
  });

  it("FR-005 and FR-011: takes the tab title, buttons and hints from state, and asks to close on Close installer", () => {
    expect(WIZARD_JS).toContain("document.title = state.pageTitle");
    expect(WIZARD_JS).toContain("question.buttons");
    expect(WIZARD_JS).toContain("question.hint");
    expect(WIZARD_JS).toContain('"/close"');
    expect(WIZARD_JS).not.toContain("defaultConfirm");
    expect(WIZARD_JS).not.toContain("Leave empty for");
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
