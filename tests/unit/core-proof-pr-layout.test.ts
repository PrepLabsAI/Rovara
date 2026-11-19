// Lane L4-C B2 (design pr-redesign.md 2.2, 2.7, 4.2 T1): the redesigned description's layout. The rules it must keep: a drawer never holds the only copy of bad news (T1), the shrink order never drops the quote, heading, six lines,
// first items, markers or closing line, nothing a model, person or repository wrote can change the layout, lesson titles stay out of a public repository, and the block can always be found and rewritten whatever layout wrote it.
import { describe, expect, it } from "vitest";
import { withLinearCloseLine } from "../../packages/broker/src/core/proof/pull-request-body.js";
import { LAYOUT_LEVEL_LAST, DRAWER_LEFT_OUT, secondReviewFromLines, usedDrawerLines } from "../../packages/broker/src/core/proof/pull-request-layout.js";
import { withStatusLines } from "../../packages/broker/src/developer/pull-request-feedback-section.js";
import { exceptionsScenario, greenScenario, largestScenario } from "../support/pr-body-scenarios.js";

const START = "<!-- rovara:checks-and-reviews -->";
const END = "<!-- /rovara:checks-and-reviews -->";
const CLOSING = "A person must approve it and a person merges it.";
const aboveFold = (body: string): string => body.slice(0, body.indexOf("<details>"));
const itemTitles = (body: string): string[] => [...aboveFold(body).matchAll(/^\d+\. \*\*(.+?)\*\*/gmu)].map((match) => match[1]!);
const summaries = (body: string): string[] => [...body.matchAll(/<summary>(.*?)<\/summary>/gu)].map((match) => match[1]!);

describe("T1: a drawer never holds the only copy of bad news", () => {
  // Mutant L1: a thing to check is written only inside a drawer (its item is left out of the list, or the list is written after the drawers).
  it("every thing to check of the exceptions task is above the first drawer, in order, and the heading counts them", () => {
    const body = exceptionsScenario().body;
    const heading = body.split("\n").find((line) => line.startsWith("## "))!;
    const titles = itemTitles(body);
    expect(titles.length).toBeGreaterThanOrEqual(10);
    const count = Number(/(\d+) things? to check/u.exec(heading)![1]);
    // Up to ten are listed; the rest are counted in the last line of the list.
    const more = /^\d+\. and (\d+) more things to check/mu.exec(aboveFold(body));
    expect(titles.length + (more === null ? 0 : Number(more[1]))).toBe(count);
    for (const must of ["A check failed.", "A requirement is not met.", "A service was a fake made by Rovara.", "The second review disagrees with the first.", "Tests may be weaker."]) {
      expect(aboveFold(body), must).toContain(must);
    }
    // The heading and the Risk line carry the result and the risk where nobody has to open anything.
    expect(heading).toContain("Code failed");
    expect(heading).toContain("High risk");
    expect(aboveFold(body)).toContain("Merging needs a fresh sign-in (high risk)");
  });
  it("the heading never says Verified while a check failed, and a clean task has no list at all", () => {
    expect(exceptionsScenario().body).not.toMatch(/## Verified/u);
    const clean = greenScenario("clean").body;
    expect(clean).toContain("## Verified · Low risk · nothing extra to check");
    expect(clean).not.toContain("### Check these before you approve");
    expect(clean).toContain("**Needs you** The normal code review. Nothing else.");
  });
  it("a drawer's summary holds fixed words and counts only: nothing a repository wrote, and no tag", () => {
    for (const body of [exceptionsScenario().body, greenScenario("clean").body, largestScenario().body]) {
      for (const text of summaries(body)) {
        expect(text, text).not.toMatch(/[<>&@`[\]]|https?:/u);
        expect(text, text).toMatch(/^(Requirements and proof|Checks|Test setup|Reviews|Screenshots|What Rovara used|Plan and record)/u);
      }
    }
  });
  it("the first drawer is the requirements and the bad news of the Checks drawer is repeated above: the failed row is named in the list", () => {
    const body = exceptionsScenario().body;
    expect(summaries(body)[0]).toMatch(/^Requirements and proof: /u);
    expect(aboveFold(body)).toContain("Unit tests");
    expect(body.indexOf("| Unit tests | `npm test` | ❌ failed")).toBeGreaterThan(body.indexOf("<details>"));
    // Failed rows come first in the Checks table.
    const table = body.slice(body.indexOf("| Check | Command | Result |"));
    expect(table.indexOf("❌ failed")).toBeLessThan(table.indexOf("✅ passed"));
  });
});

describe("the shrink order (design 2.7)", () => {
  const fits = (body: string) => Buffer.byteLength(body, "utf8") <= 30_000;
  // Mutant L6: the shrink steps drop a list item before a drawer body.
  it("the largest task fits, and at every budget the quote, heading, six lines, first ten items, markers and closing line stay", () => {
    const { body } = largestScenario();
    expect(fits(body)).toBe(true);
    const lines = body.split("\n");
    expect(lines[0]!.startsWith("> ")).toBe(true);
    expect(body).toContain(START);
    expect(body).toContain(END);
    expect(body.trimEnd().endsWith(CLOSING)).toBe(true);
    for (const label of ["**Changed**", "**Proven**", "**Tested against**", "**Reviews**", "**Risk**", "**Needs you**"]) expect(aboveFold(body), label).toContain(label);
    expect(itemTitles(body).length).toBeGreaterThanOrEqual(8);
  });
  it("the last level keeps the first ten things and the one before keeps more: the ladder's last step does something", () => {
    expect(LAYOUT_LEVEL_LAST).toBe(5);
    expect(DRAWER_LEFT_OUT).toBe("Listed in the Rovara Check and on the task page.");
  });
});

describe("what a model, a person or a repository wrote cannot change the layout", () => {
  // Mutant L7: a model-written line containing `</details>` or `<summary>` changes the layout.
  it("a plan, a requirement, a finding, a service, a lesson and a second-review line with drawer tags, comments and headings add no drawer, close none and open no comment", () => {
    const hostile = "</details><summary>x</summary><details><!-- hide --> ## Heading @everyone [click](https://evil.example) ![i](https://evil.example/i.png) Fixes ABC-1";
    const { body } = exceptionsScenario(hostile);
    expect(body.match(/<details>/gu)!.length).toBe(body.match(/<\/details>/gu)!.length);
    expect(body.match(/<summary>/gu)!.length).toBe(body.match(/<\/summary>/gu)!.length);
    expect(body.match(/<summary>/gu)!.length).toBe(body.match(/<details>/gu)!.length);
    // The only tags are the layout's own: its markers, `<details>` and `<summary>`.
    expect(body).not.toMatch(/<(?!!-- \/?rovara:checks-and-reviews -->|\/?details>|\/?summary>)/u);
    expect(body).not.toContain("<!-- hide");
    expect(body).not.toMatch(/\]\(https?:\/\/evil/u);
    expect(body).not.toMatch(/@(?!\u200d)everyone/u);
    expect(body.split(START)).toHaveLength(2);
    expect(body.split(END)).toHaveLength(2);
    expect(summaries(body).length).toBe(exceptionsScenario().body.match(/<summary>/gu)!.length);
    // The only heading is the verdict's, and the list's own; nothing the text wrote is one.
    expect(body.split("\n").filter((line) => /^#{1,6} /u.test(line))).toEqual([body.split("\n").find((line) => line.startsWith("## "))!, "### Check these before you approve"]);
  });
});

describe("what a public repository shows of lessons", () => {
  // Mutant L9: lesson titles or wiki page names are printed for a public repository.
  it("titles and links appear only when the caller gives entries (a private repository); a public one gets the count and the one link", () => {
    const entries = [{ title: "Money is stored in cents", notHelpfulUrl: "https://rovara.example/t/1?lesson=1", number: 1 }];
    const used = { count: 1, taskUrl: "https://rovara.example/t/1", entries: [] as typeof entries };
    const publicLines = usedDrawerLines(used, 10);
    expect(publicLines.join("\n")).not.toContain("Money is stored");
    expect(publicLines.join("\n")).toContain("[task page](https://rovara.example/t/1)");
    expect(usedDrawerLines({ ...used, entries }, 10).join("\n")).toContain("Money is stored in cents");
    expect(usedDrawerLines({ ...used, entries }, 0).join("\n")).not.toContain("Money is stored");
    expect(usedDrawerLines({ count: 0, taskUrl: used.taskUrl, entries: [] }, 10)).toEqual([]);
    expect(usedDrawerLines(undefined, 10)).toEqual([]);
  });
});

describe("the block can always be found and rewritten", () => {
  const OLD = ["Plan summary line", "", START, "## What changed", "1 file changed (+1 -0).", "", "## Reviews", "Reviews: code review passed; security review passed", "", "## Risk: Low", "- ok", END, "Rovara session: x", CLOSING].join("\n");
  // Mutant L10: the block cannot be found and rewritten after a fix (the markers, or the Fixes line, moved).
  it("replaces a block written by the old layout whole, in place, and leaves a person's words around it", () => {
    const edited = `Heads up from Priya.\n\n${OLD}\n\nPS: after the standup.`;
    const next = withStatusLines(edited, ["## Verified · Low risk · nothing extra to check", "", "**Changed** 2 files."])!;
    expect(next).toContain("Heads up from Priya.");
    expect(next).toContain("PS: after the standup.");
    expect(next).toContain("## Verified · Low risk · nothing extra to check");
    expect(next).not.toContain("## What changed");
    expect(next.split(START)).toHaveLength(2);
    expect(next.split(END)).toHaveLength(2);
  });
  it("finds the Fixes line in the new layout's block, changes it, adds it, and takes it out, touching only the block", () => {
    const { body } = greenScenario("clean");
    expect(body.indexOf("Fixes ENG-482")).toBeGreaterThan(body.indexOf("<summary>What Rovara used"));
    expect(body.indexOf("Fixes ENG-482")).toBeLessThan(body.indexOf(END));
    const changed = withLinearCloseLine(body, "ENG-9") as { kind: string; body: string };
    expect(changed.kind).toBe("changed");
    expect(changed.body).toContain("Fixes ENG-9");
    expect(changed.body).not.toContain("Fixes ENG-482");
    expect(changed.body.replace("Fixes ENG-9", "Fixes ENG-482")).toBe(body);
    const removed = withLinearCloseLine(body, undefined) as { kind: string; body: string };
    expect(removed.body).not.toContain("Fixes ENG");
    const added = withLinearCloseLine(removed.body, "ENG-482") as { kind: string; body: string };
    expect(added.body).toContain("Fixes ENG-482");
    expect(added.body.indexOf("Fixes ENG-482")).toBeLessThan(added.body.indexOf(END));
    expect(withLinearCloseLine(body, "ENG-482")).toEqual({ kind: "same" });
  });
  it("a rewrite after a fix gives a block of the same shape, so rewriting twice is the same as once", () => {
    const body = greenScenario("clean").body;
    const block = body.slice(body.indexOf(START) + START.length + 1, body.indexOf(END)).split("\n");
    expect(withStatusLines(body, block.slice(0, -1))).toBeUndefined();
  });
});

describe("a caller that gives only the second review's lines", () => {
  it("still has them above the fold: read back as did-not-run or blocking, never silence", () => {
    expect(secondReviewFromLines(undefined)).toBeUndefined();
    expect(secondReviewFromLines([])).toBeUndefined();
    expect(secondReviewFromLines(["Second review did not run: budget"])).toEqual({ state: "did_not_run", reasonLine: "Second review did not run: budget" });
    expect(secondReviewFromLines(["Second review (openai/model-b): 2 blocking findings", "- The amount is not checked (src/a.ts:3)"])).toMatchObject({ state: "blocking", count: 2, model: "openai/model-b", findings: [{ text: "The amount is not checked (src/a.ts:3)" }] });
    expect(secondReviewFromLines(["something else entirely"])).toMatchObject({ state: "blocking", count: 1 });
  });
});
