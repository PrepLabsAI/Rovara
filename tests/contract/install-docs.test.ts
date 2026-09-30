// tests/contract/install-docs.test.ts
// FR-061: the install guide and the README describe the install page and --no-ui, and stay in
// plain words with no em dashes.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NO_BROWSER_LINE } from "../../packages/cli/src/init/ui-mode.js";

const read = (path: string) => readFileSync(path, "utf8");

describe("the install docs (FR-061)", () => {
  it("the install guide describes the page, --no-ui, SSH, and a closed tab", () => {
    const guide = read("docs/install.md");
    const section = guide.slice(guide.indexOf("### The install page"));
    expect(guide.indexOf("### The install page")).toBeGreaterThan(0);
    for (const text of ["127.0.0.1", "--no-ui", "--ui", "ssh -L", "CloudShell", "--yes", "closed", "never shown again"]) expect(section).toContain(text);
    // The guide quotes the line init prints on a machine with no browser.
    expect(guide).toContain(NO_BROWSER_LINE);
  });

  it("the README says the install opens a page, and how to stay in the terminal", () => {
    const readme = read("README.md");
    expect(readme).toContain("install page");
    expect(readme).toContain("--no-ui");
  });

  it("uses no em dashes", () => {
    for (const path of ["docs/install.md", "README.md"]) expect(read(path)).not.toContain("—");
  });
});
