// Review focus 1: the harness never lets GitHub's head lag be turned off. (The check that the journey suites under
// tests/integration/workflow-e2e/** turned no realism off went with those suites, #1350: they drove the retired spec 056 workflow.)
import { describe, expect, it } from "vitest";
import { FakeGitHub } from "../support/workflow-e2e-github.js";

describe("workflow E2E realism", () => {
  it("refuses to turn GitHub's head lag off through lag()", () => {
    const github = new FakeGitHub();
    expect(() => github.lag({ prHeadReads: 0 })).toThrow(/realism: \{ lag: false \}/);
    github.lag({ prHeadReads: 2 });
  });
});
