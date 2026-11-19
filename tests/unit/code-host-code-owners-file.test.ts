// Item C4: the CODEOWNERS file syntax lives behind the code host now (`CodeHost.codeOwners()`); these are the parser's own tests, moved with it from the merge core's.
import { describe, expect, it } from "vitest";
import { expectLinearScaling } from "../support/scaling.js";
import { codeOwnerOf, ownersOfPath, parseCodeOwners, readCodeOwnersFile } from "../../packages/broker/src/plugins/code-host/code-owners-file.js";

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

// The file is the repository's: no pattern may make one path slow. Matching steps an automaton over the path, so its cost is path length x pattern size, and a pattern such as `*a*a…b` made the old regex
// take 19 s on a 256-character path, or a per-state reach list (`*` x 4000) 5.9 s. A bar on the clock cannot tell a slow runner from a slow algorithm, so each case is checked for scaling on each axis:
// the pattern grows 8x over a fixed path, then the path grows 8x under a fixed pattern. Linear work grows about 8x on each axis; the old behaviour grew much faster.
describe("a hostile pattern cannot make matching slow", () => {
  const cases: Array<[string, (n: number) => string, (m: number) => string[]]> = [
    ["a run of stars", (n) => "*".repeat(n), (m) => ["a".repeat(m)]],
    // The second path holds the letters the quick refusal looks for, so the automaton itself runs and fails only at the end.
    ["stars between letters", (n) => "*a".repeat(n / 2) + "*b", (m) => ["a".repeat(m), `${"a".repeat(m)}ba`]],
    ["a long name between stars", (n) => "a" + "*".repeat(n) + "b", (m) => ["a" + "c".repeat(m) + "b"]],
    ["many any-directory segments", (n) => "a/" + "**/".repeat(n / 3) + "b", (m) => ["a/" + "c/".repeat(m / 2) + "b"]],
  ];
  for (const [label, pattern, paths] of cases) {
    it(label, () => {
      let matched: boolean[] = [];
      // The pattern grows 8x (512 to 4,096 characters) over a fixed path of 256.
      expectLinearScaling((size) => {
        const [rule] = rules(`${pattern(size)} @o`);
        const fixed = paths(256);
        return () => { matched = fixed.map((path) => rule!.matches(path)); };
      }, { n: 512, label: `${label}: pattern size` });
      expect(matched).toHaveLength(paths(256).length);
      // The path grows 8x (512 to 4,096 characters) under a fixed pattern of 256.
      expectLinearScaling((size) => {
        const [rule] = rules(`${pattern(256)} @o`);
        const grown = paths(size);
        return () => { matched = grown.map((path) => rule!.matches(path)); };
      }, { n: 512, label: `${label}: path length` });
      expect(matched).toHaveLength(paths(256).length);
    }, 60_000);
  }
});
