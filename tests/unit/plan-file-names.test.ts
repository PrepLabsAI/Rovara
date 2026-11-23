// A coding plan names the files that change, in words or in a `code` item. Any real file name counts; a version, a web address, an abbreviation or a framework name does not.
import { describe, expect, it } from "vitest";
import { PLAN_MISSING_FILES, WORKFLOW_BLOCK_REASONS, isPlanUnreadableBlockReason, planMissingParts, type PlanDocument } from "@agentx/contracts";

/** A plan whose only claim says `text` and cites no code: the files rule can only pass by the name in the words. */
const planSaying = (text: string): PlanDocument => ({
  schemaVersion: 1, title: "Plan", why: [{ text: "A reason.", author: "Priya" }], claims: [{ id: "1", text }], notChanging: [], risks: [], decisions: [],
});
const missingFiles = (text: string): boolean => planMissingParts(planSaying(`${text} Tests cover it.`)).includes(PLAN_MISSING_FILES);

describe("a plan claim that names a file", () => {
  const named: Array<[string, string]> = [
    ["a txt file", "Create stop-proof-1.txt in the workspace root."],
    ["a csv file", "Write the rows to data.csv."],
    ["an svg file", "Draw the mark in logo.svg."],
    ["an unlisted extension under a folder", "Add docs/guide.adoc with the steps."],
    ["a nested path with an unlisted extension", "Port the parser to src/x/y.zig."],
    ["a name with two dots", "Export the totals to report.final.csv."],
    ["an unlisted extension, bare", "Add notes.adoc to the repository."],
    ["a Go module file", "Bump the version in go.mod and go.sum."],
    ["an upper-case R script", "Rewrite the model in fit.R."],
    ["an image", "Replace hero.png and favicon.ico."],
    ["a path in backticks", "Edit `lib/render.vue`."],
    ["a path with a dot folder", "Change ./scripts/build.ps1 to run on Windows."],
    ["a file followed by a full stop", "The result goes to out/summary.tsv."],
    ["a file followed by a line number", "See app/main.dart:42 for the entry."],
    ["an unlisted file with a line number", "See docs/main.adoc:42:7 for the entry."],
    ["a notebook", "Clean up analysis.ipynb."],
    ["a short unlisted extension under a path", "Add assets/sprite.z"],
    ["a file in brackets", "(tools/run.nim)"],
    ["a name in quotes", 'Write "config.hjson" next to it.'],
    ["a path from this folder, unlisted", "Edit ./scripts/build.adoc."],
    ["a bare name from this folder, unlisted", "Add ./run.adoc to the repository."],
    ["a path from a folder above, unlisted", "Move ../shared/theme.zig."],
    ["a listed extension in capitals", "Update README.TXT."],
    ["an extensionless well-known name", "Update the Dockerfile."],
  ];
  it.each(named)("counts %s", (_name, text) => {
    expect(missingFiles(text)).toBe(false);
  });

  it("still counts a `code` item without any file name in the words", () => {
    const plan = planSaying("Retry the payment. Tests cover it.");
    plan.claims[0]!.evidence = [{ kind: "code", path: "payments/src/charge.ts", startLine: 1, endLine: 2, note: "Here." }];
    expect(planMissingParts(plan)).not.toContain(PLAN_MISSING_FILES);
  });
});

describe("words that look like a file but are not one", () => {
  const notFiles: Array<[string, string]> = [
    ["a version with a v", "Move to v1.2 of the API."],
    ["a three-part version", "Upgrade to 1.2.3 first."],
    ["a release number", "Ship in 0.5.46 only."],
    ["a pre-release version", "Wait for 1.2rc1 before the change."],
    ["a version with a dash suffix", "Pin 3.0.0-beta.1 for now."],
    ["a wildcard version", "Support 3.5.x as well."],
    ["a domain", "Send the report to example.com."],
    ["a subdomain", "Call api.github.com for the list."],
    ["a web address", "Read https://example.com/docs/guide.adoc for the rules."],
    ["a web address with a known extension", "Fetch https://example.com/a.json first."],
    ["e.g.", "Pick a size, e.g. large, for the change."],
    ["i.e.", "Keep it small, i.e. one screen."],
    ["etc.", "Handle retries, timeouts, etc."],
    ["a clock time", "Run it at 5 p.m. each day."],
    ["a sentence that ends in a word", "Make the change small and safe."],
    ["a decimal", "Raise the limit to 2.5 percent."],
    ["a name of a framework", "Rebuild the page with Next.js."],
    ["Node.js", "Run it on Node.js 22."],
    ["a word pair with a slash", "Works for client/server and/or both."],
    ["an email address", "Mail dev@example.co about it."],
    ["an email address that ends in an unlisted word", "Mail bob@acme.consulting about it."],
    ["a second framework name", "Draw the graph with Chart.js."],
    ["an ending too long to be an extension", "Notes are kept in a.abcdefghijkl for now."],
    ["a name with a ending in a dash", "Use pre-release.1-beta as the label."],
    ["a run-together sentence with a capital", "The change is small.Then more follows."],
    ["an abbreviation in capitals", "Check the U.S.A. rules."],
  ];
  it.each(notFiles)("does not count %s", (_name, text) => {
    expect(missingFiles(text)).toBe(true);
  });
});

describe("the words for a plan that could not be read", () => {
  it("is a proper sentence", () => {
    expect(WORKFLOW_BLOCK_REASONS.planUnreadable).toBe("The plan couldn't be read.");
  });
  it("is still recognised as stored before its wording changed", () => {
    expect(isPlanUnreadableBlockReason("The plan couldn't be read.")).toBe(true);
    expect(isPlanUnreadableBlockReason("the plan couldn't be read")).toBe(true);
    expect(isPlanUnreadableBlockReason("Something else.")).toBe(false);
    expect(isPlanUnreadableBlockReason(undefined)).toBe(false);
  });
});
