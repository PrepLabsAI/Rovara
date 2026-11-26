// Lane L4-C B2 (design pr-redesign.md 2.2, 2.7, 4.2 T1): the redesigned description's layout. The rules it must keep: a drawer never holds the only copy of bad news (T1), the shrink order never drops the quote, heading, six lines,
// first items, markers or closing line, nothing a model, person or repository wrote can change the layout, lesson titles stay out of a public repository, and the block can always be found and rewritten whatever layout wrote it.
import { describe, expect, it } from "vitest";
import { secondReviewFromLines, usedDrawerLines } from "../../packages/broker/src/core/proof/pull-request-layout.js";
import { exceptionsScenario, greenScenario, largestScenario } from "../support/pr-body-scenarios.js";

const summaries = (body: string): string[] => [...body.matchAll(/<summary>(.*?)<\/summary>/gu)].map((match) => match[1]!);

describe("T1: a drawer never holds the only copy of bad news", () => {
  it("a drawer's summary holds fixed words and counts only: nothing a repository wrote, and no tag", () => {
    for (const body of [exceptionsScenario().body, greenScenario("clean").body, largestScenario().body]) {
      for (const text of summaries(body)) {
        expect(text, text).not.toMatch(/[<>&@`[\]]|https?:/u);
        expect(text, text).toMatch(/^(Requirements and proof|Checks|Test setup|Reviews|Screenshots|What Rovara used|Plan and record)/u);
      }
    }
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

describe("a caller that gives only the second review's lines", () => {
  it("still has them above the fold: read back as did-not-run or blocking, never silence", () => {
    expect(secondReviewFromLines(undefined)).toBeUndefined();
    expect(secondReviewFromLines([])).toBeUndefined();
    expect(secondReviewFromLines(["Second review did not run: budget"])).toEqual({ state: "did_not_run", reasonLine: "Second review did not run: budget" });
    expect(secondReviewFromLines(["Second review (openai/model-b): 2 blocking findings", "- The amount is not checked (src/a.ts:3)"])).toMatchObject({ state: "blocking", count: 2, model: "openai/model-b", findings: [{ text: "The amount is not checked (src/a.ts:3)" }] });
    expect(secondReviewFromLines(["something else entirely"])).toMatchObject({ state: "blocking", count: 1 });
  });
});
