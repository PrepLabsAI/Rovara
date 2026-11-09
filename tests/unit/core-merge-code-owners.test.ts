// Owner decision 2026-10-27: where the repository has a CODEOWNERS file that covers the changed paths, a code owner has to approve before the pull request is ready.
import { describe, expect, it } from "vitest";
import { codeOwnerVerdict, ownersOfPath, parseCodeOwners } from "../../packages/broker/src/core/merge/code-owners.js";

const rules = (text: string) => parseCodeOwners(text).rules;
const never = async (): Promise<"unknown"> => "unknown";

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

describe("codeOwnerVerdict", () => {
  const verdict = (text: string | undefined, paths: string[], approvers: string[], team: (team: string, login: string) => Promise<"member" | "not_member" | "unknown"> = never) =>
    codeOwnerVerdict({ codeOwnersText: text, paths, approverLogins: approvers, teamMember: team });

  it("fails closed on a file it cannot read the way GitHub does, whatever the changed paths are", async () => {
    for (const text of ["* @bob\n!/secure/ @alice", "* @bob\n/secure/[a].ts @alice", "* @bob\n/secure/ @alice!x", "* @bob\n/secure/ nobody"]) {
      expect(await verdict(text, ["docs/readme.md"], ["bob"]), text).toEqual({ ok: false, unreadable: true });
    }
    const crowded = ["* @bob", ...Array.from({ length: 5_001 }, (_, index) => `/f${String(index)}/ @a`)].join("\n");
    expect(await verdict(crowded, ["docs/readme.md"], ["bob"])).toEqual({ ok: false, unreadable: true });
  });

  it("an email owner cannot be matched to an approver: it is not satisfied by itself, and an @owner beside it still settles the path", async () => {
    expect(await verdict("/secure/ security@corp.com", ["secure/key.ts"], ["arjun-gh"])).toEqual({ ok: false, unreadable: true });
    expect(await verdict("/secure/ security@corp.com @max-gh", ["secure/key.ts"], ["max-gh"])).toEqual({ ok: true });
    expect(await verdict("/secure/ security@corp.com", ["docs/readme.md"], [])).toEqual({ ok: true });
  });

  it("is satisfied when there is no CODEOWNERS file, or it covers none of the changed paths", async () => {
    expect(await verdict(undefined, ["src/a.ts"], [])).toEqual({ ok: true });
    expect(await verdict("/docs/ @a", ["src/a.ts"], [])).toEqual({ ok: true });
  });

  it("needs an approval from an owner of every covered path, a person matched in any case", async () => {
    expect(await verdict("/src/ @Max-GH", ["src/a.ts"], ["arjun-gh"])).toEqual({ ok: false, owners: "@Max-GH" });
    expect(await verdict("/src/ @Max-GH", ["src/a.ts"], ["max-gh"])).toEqual({ ok: true });
    expect(await verdict("/src/ @a\n/docs/ @b", ["src/x", "docs/y"], ["a"])).toEqual({ ok: false, owners: "@b" });
    expect(await verdict("/src/ @a\n/docs/ @b", ["src/x", "docs/y"], ["a", "b"])).toEqual({ ok: true });
  });

  it("any one of a path's owners is enough", async () => {
    expect(await verdict("/src/ @a @b", ["src/x"], ["b"])).toEqual({ ok: true });
  });

  it("a team owner is satisfied by an approver who is in the team", async () => {
    const team = async (name: string, login: string) => (name === "acme/payments" && login === "arjun-gh" ? "member" as const : "not_member" as const);
    expect(await verdict("/src/ @acme/payments", ["src/x"], ["arjun-gh"], team)).toEqual({ ok: true });
    expect(await verdict("/src/ @acme/payments", ["src/x"], ["max-gh"], team)).toEqual({ ok: false, owners: "@acme/payments" });
  });

  it("a team that cannot be read is not satisfied, and says so (fails closed)", async () => {
    expect(await verdict("/src/ @acme/payments", ["src/x"], ["arjun-gh"], never)).toEqual({ ok: false, unreadable: true });
    // But a person owner who approved settles that path whatever the team lookup says.
    expect(await verdict("/src/ @acme/payments @max-gh", ["src/x"], ["max-gh"], never)).toEqual({ ok: true });
  });

  it("names at most three owners and counts the rest", async () => {
    const result = await verdict("* @a @b @c @d @e", ["x"], []);
    expect(result).toEqual({ ok: false, owners: "@a, @b, @c and 2 more" });
  });

  it("asks about a team once per login however many paths it owns", async () => {
    let asked = 0;
    const team = async () => { asked += 1; return "not_member" as const; };
    await verdict("/src/ @acme/t\n/docs/ @acme/t @other", ["src/a", "src/b", "docs/c"], ["x", "y"], team);
    // Two sets of owners name the same team: each login is asked about once, not once per set.
    expect(asked).toBe(2);
  });
});
