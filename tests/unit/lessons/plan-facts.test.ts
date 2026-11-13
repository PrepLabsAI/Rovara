// What the loader is told about a task besides its title: a short summary of the approved plan and the files the plan names. Pure, bounded, and made only from the plan's own structure.
import { describe, expect, it } from "vitest";
import type { PlanDocument } from "@rovara-code/contracts";
import { PLAN_FACTS_MAX_FILES, PLAN_FACTS_SUMMARY_MAX, planLoadFacts } from "../../../packages/core/src/lessons/plan-facts.js";

const plan = (claims: PlanDocument["claims"], title = "Retry failed HTTP calls"): PlanDocument => ({ schemaVersion: 1, title, why: [], claims, notChanging: [], risks: [], decisions: [] });

describe("planLoadFacts", () => {
  it("the summary is the title and the top-level claims; the files are the cited code and the files named in words, each once", () => {
    const facts = planLoadFacts(plan([
      { id: "1", text: "Wrap the fetch in withRetry in src/http/client.ts", evidence: [{ kind: "code", path: "src/http/client.ts", startLine: 1, endLine: 5 }, { kind: "code", path: "src/http/retry.ts", startLine: 2, endLine: 9 }], children: [{ id: "1.1", text: "Update ./tests/client.test.ts" }] },
      { id: "2", text: "Document the change in docs/retry.md and see https://example.com/a.json" },
    ]));
    expect(facts.summary).toBe("Retry failed HTTP calls\nWrap the fetch in withRetry in src/http/client.ts\nDocument the change in docs/retry.md and see https://example.com/a.json");
    expect(facts.files).toEqual(["src/http/client.ts", "src/http/retry.ts", "tests/client.test.ts", "docs/retry.md"]);
  });

  it("is bounded: a long summary is cut and at most 30 files are listed", () => {
    const claims = Array.from({ length: 60 }, (_, i) => ({ id: String(i + 1), text: `Change src/m${i}/index.ts ${"x".repeat(200)}`, evidence: [{ kind: "code" as const, path: `src/m${i}/index.ts`, startLine: 1, endLine: 2 }] }));
    const facts = planLoadFacts(plan(claims));
    expect(facts.summary.length).toBeLessThanOrEqual(PLAN_FACTS_SUMMARY_MAX);
    expect(facts.files).toHaveLength(PLAN_FACTS_MAX_FILES);
  });

  it("a plan that names no file gives none (so no path scope is judged), and a plan that needs no change has a summary only", () => {
    expect(planLoadFacts(plan([{ id: "1", text: "Rename the helper everywhere" }])).files).toEqual([]);
    expect(planLoadFacts({ ...plan([{ id: "1", text: "Nothing to do" }]), noChangeNeeded: { reason: "x" } } as never).files).toEqual([]);
  });

  it("paths that could escape or confuse are not listed", () => {
    const facts = planLoadFacts(plan([{ id: "1", text: "Edit ../../etc/passwd.conf and /abs/path/a.ts and src/ok.ts", evidence: [{ kind: "code", path: "../up.ts", startLine: 1, endLine: 1 }] }]));
    expect(facts.files).toEqual(["src/ok.ts"]);
  });
});
