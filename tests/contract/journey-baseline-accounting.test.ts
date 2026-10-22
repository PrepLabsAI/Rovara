import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// M1.3 Task 3.7b: the baseline round is on by default, and it is a CHECKS operation that runs right after the coding run, so a journey that counts rounds sees it as its first one.
// CI's linux-runtime run of m1-web-journey failed that way: its base commit holds the project contract only (the app arrives with the candidate), so the baseline ran on a repository
// with no app ("Cannot find module '/app/server.mjs'") and the journey's "round 1" was the baseline. Such a journey keeps its round accounting explicit: it registers its project
// with the baseline switched off. Only the `results` variant of m1-3-journeys runs a baseline, and its base commit is the app with its defects.

const journey = (name: string) => readFileSync(`tests/e2e/${name}`, "utf8");

describe("journeys that count rounds say whether the project has the baseline round", () => {
  it("m1-web-journey registers its project with the baseline switched off, so round 1 is the candidate's", () => {
    const text = journey("m1-web-journey.test.ts");
    expect(text).toMatch(/developerTasks: \{[\s\S]{0,160}e2eBaselineRound: false/u);
  });

  it("m1-3-journeys switches it off for every variant but results", () => {
    const text = journey("m1-3-journeys.test.ts");
    expect(text).toMatch(/variant === "results" \? \{\} : \{ developerTasks: \{[\s\S]{0,160}e2eBaselineRound: false/u);
  });
});
