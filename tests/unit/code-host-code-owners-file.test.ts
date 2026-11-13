// Item C4: the CODEOWNERS file syntax lives behind the code host now (`CodeHost.codeOwners()`); these are the parser's own tests, moved with it from the merge core's.
import { describe, expect, it } from "vitest";
import { codeOwnerOf, ownersOfPath, parseCodeOwners, readCodeOwnersFile } from "../../packages/core/src/plugins/code-host/code-owners-file.js";

const rules = (text: string) => parseCodeOwners(text).rules;

describe("parseCodeOwners and ownersOfPath", () => {
  it("takes the last matching rule, in GitHub's way", () => {
    const text = ["# owners", "*       @acme/everyone", "/docs/  @docs-lead", "*.ts @ts-lead", "/src/payments/ @pay-lead @acme/payments  # trailing comment"].join("\n");
    expect(ownersOfPath(rules(text), "README.md")).toEqual(["@acme/everyone"]);
    expect(ownersOfPath(rules(text), "docs/a/b.md")).toEqual(["@docs-lead"]);
    expect(ownersOfPath(rules(text), "src/index.ts")).toEqual(["@ts-lead"]);
    expect(ownersOfPath(rules(text), "src/payments/charge.ts")).toEqual(["@pay-lead", "@acme/payments"]);
  });

  it("an anchored rule matches only from the root, an unanchored directory rule at any depth", () => {
    expect(ownersOfPath(rules("/build/ @a"), "src/build/x.js")).toEqual([]);
    expect(ownersOfPath(rules("/build/ @a"), "build/x.js")).toEqual(["@a"]);
    expect(ownersOfPath(rules("build/ @a"), "src/build/x.js")).toEqual(["@a"]);
    expect(ownersOfPath(rules("docs/*.md @a"), "docs/x.md")).toEqual(["@a"]);
    expect(ownersOfPath(rules("docs/*.md @a"), "docs/deep/x.md")).toEqual([]);
    expect(ownersOfPath(rules("/docs/* @a"), "docs/deep/x.md")).toEqual([]);
    expect(ownersOfPath(rules("/docs/* @a"), "docs/x.md")).toEqual(["@a"]);
  });

  it("supports ** and ?, and is case sensitive on paths", () => {
    expect(ownersOfPath(rules("/src/**/test_*.py @a"), "src/x/y/test_one.py")).toEqual(["@a"]);
    expect(ownersOfPath(rules("/src/**/test_*.py @a"), "src/test_one.py")).toEqual(["@a"]);
    expect(ownersOfPath(rules("/a?.txt @a"), "ab.txt")).toEqual(["@a"]);
    expect(ownersOfPath(rules("/Docs/ @a"), "docs/x")).toEqual([]);
  });

  it("a rule with no owner takes ownership away; an email is an owner Rovara cannot match", () => {
    expect(ownersOfPath(rules("* @a\n/vendor/\n"), "vendor/x.js")).toEqual([]);
    expect(ownersOfPath(rules("* a@example.com @ok"), "x")).toEqual(["a@example.com", "@ok"]);
  });

  it("says when the file holds anything Rovara cannot read the way GitHub does: negation, character classes, a malformed owner, a name that is no owner, too many rules", () => {
    for (const text of ["!/docs/ @a", "/src/[ab].ts @a", "/secure/ @alice!x", "/secure/ nobody", "/secure/ @", "* @a @-bad", "/x/ @a/b/c"]) {
      expect(parseCodeOwners(text).unsupported, text).toBe(true);
    }
    const crowded = Array.from({ length: 5_001 }, (_, index) => `/f${String(index)}/ @a`).join("\n");
    expect(parseCodeOwners(crowded).unsupported).toBe(true);
    expect(parseCodeOwners(Array.from({ length: 5_000 }, (_, index) => `/f${String(index)}/ @a`).join("\n")).unsupported).toBe(false);
    expect(parseCodeOwners("* @a @b/team a@b.co\n# c\n\n/docs/\n").unsupported).toBe(false);
  });

  it("ignores blank lines, comments and a file that is not text", () => {
    expect(rules("\n# only\n\n")).toEqual([]);
  });
});


describe("readCodeOwnersFile", () => {
  it("answers in Rovara's words: a person, a team, or an owner it cannot match", () => {
    expect(codeOwnerOf("@max")).toEqual({ kind: "person", login: "max" });
    expect(codeOwnerOf("@acme/payments")).toEqual({ kind: "team", team: "acme/payments" });
    expect(codeOwnerOf("a@example.com")).toEqual({ kind: "other", label: "a@example.com" });
    const read = readCodeOwnersFile("* @ana\n/docs/ @acme/writers a@example.com\n/vendor/\n");
    expect(read.unsupported).toBe(false);
    expect(read.ownersOf("src/a.ts")).toEqual([{ kind: "person", login: "ana" }]);
    expect(read.ownersOf("docs/x.md")).toEqual([{ kind: "team", team: "acme/writers" }, { kind: "other", label: "a@example.com" }]);
    // A rule with no owner takes ownership away.
    expect(read.ownersOf("vendor/x.js")).toEqual([]);
  });

  it("flags a file it cannot read as a whole", () => {
    expect(readCodeOwnersFile("* @a\n!/x/ @b").unsupported).toBe(true);
  });
});

// The file is the repository's: no pattern may make one path slow. The bar is far above linear work (a few ms) and far below what the old regex
// (`*a*a…b`: 19 s on a 256-character path) or a per-state reach list (`*` x 4000: 5.9 s) took. Sizes grow, and the first one over the bar fails.
describe("a hostile pattern cannot make matching slow", () => {
  const BAR_MS = process.env["CI"] !== undefined && process.env["CI"] !== "" && process.env["CI"] !== "false" ? 2_000 : 500;
  const cases: Array<[string, (n: number) => string, (n: number) => string]> = [
    ["a run of stars", (n) => "*".repeat(n), (n) => "a".repeat(n / 4)],
    ["stars between letters", (n) => "*a".repeat(n / 2) + "*b", (n) => "a".repeat(n / 4)],
    ["a long name between stars", (n) => "a" + "*".repeat(n) + "b", (n) => "a" + "c".repeat(n / 4) + "b"],
    ["many any-directory segments", (n) => "a/" + "**/".repeat(n / 3) + "b", (n) => "a/" + "c/".repeat(n / 8) + "b"],
  ];
  for (const [label, pattern, path] of cases) {
    it(label, () => {
      for (const size of [256, 1_024, 4_096]) {
        const [rule] = rules(`${pattern(size)} @o`);
        const started = performance.now();
        rule!.matches(path(size));
        const took = performance.now() - started;
        expect(took, `${label} at ${String(size)}`).toBeLessThan(BAR_MS);
      }
    }, 60_000);
  }
});
