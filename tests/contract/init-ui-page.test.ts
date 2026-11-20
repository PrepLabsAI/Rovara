import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { PAGE_CLASSES } from "../../packages/cli/src/init/ui/design.js";
import { WIZARD_JS, wizardHtml } from "../../packages/cli/src/init/ui/page.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const html = wizardHtml("token-aaaaaaaa");

describe("the page shell", () => {

  it("FR-001 and FR-003: has a header, a progress rail and one current-step panel", () => {
    for (const id of ['id="place"', 'id="time-left"', 'id="phases"', 'id="panel"', 'id="step-of"', 'id="question"', 'id="failure"']) expect(html).toContain(id);
    expect(html).toContain('aria-label="Install progress"');
  });

  it("FR-004: the plan and the technical log are behind links", () => {
    expect(html).toMatch(/<details id="plan"[^>]*><summary>View the plan<\/summary><div id="plan-body"><\/div>/);
    expect(html).toMatch(/<details id="log-box"[^>]*><summary>Show technical log<\/summary>/);
  });

  it("uses only the design system's classes, on every element it builds", () => {
    const used = new Set<string>();
    for (const match of html.matchAll(/class="([^"]+)"/g)) for (const name of (match[1] ?? "").split(" ")) used.add(name);
    for (const match of WIZARD_JS.matchAll(/el\("[a-z0-9]+", "([^"]*)"/g)) for (const name of (match[1] ?? "").split(" ")) if (name !== "") used.add(name);
    for (const match of WIZARD_JS.matchAll(/"((?:card status|phase|step) )" \+/g)) for (const name of (match[1] ?? "").trim().split(" ")) used.add(name);
    expect([...used].filter((name) => !(PAGE_CLASSES as readonly string[]).includes(name))).toEqual([]);
    expect(used.size).toBeGreaterThan(20);
  });

});

