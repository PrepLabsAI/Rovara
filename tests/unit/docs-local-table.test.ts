// Port lane L11 (L7): the tables in docs/local.md keep one set of cells per row, so the page renders (the GitHub row once carried a third cell after its closing pipe).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("docs/local.md", () => {
  it("has the same number of cells in every row of each table", async () => {
    const lines = (await readFile(join(process.cwd(), "docs/local.md"), "utf8")).split("\n");
    let width: number | undefined;
    for (const [index, line] of lines.entries()) {
      if (!line.startsWith("|")) { width = undefined; continue; }
      // A pipe inside backticks is not a cell edge.
      const cells = line.replace(/`[^`]*`/gu, "x").trim().replace(/^\||\|$/gu, "").split("|").length;
      width ??= cells;
      expect(cells, `docs/local.md line ${index + 1}`).toBe(width);
      expect(line.trimEnd().endsWith("|"), `docs/local.md line ${index + 1} ends in a pipe`).toBe(true);
    }
  });

  it("says the worker's git sends the token to github.com too, and records the broker-relay follow-up", async () => {
    const text = await readFile(join(process.cwd(), "docs/local.md"), "utf8");
    expect(text).toContain("A task's worker sends it to `github.com` over git");
    expect(text).toContain("broker-side git relay");
  });
});
