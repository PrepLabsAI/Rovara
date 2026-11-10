// Owner decision 2026-10-27: where the repository has code owners that cover the changed paths, a code owner has to approve before the change request is ready. The host reads its own owners file (item C4);
// these tests feed the verdict the neutral answer, made by the shared file reader for the syntax most hosts use.
import { describe, expect, it } from "vitest";
import { codeOwnerVerdict } from "../../packages/broker/src/core/merge/code-owners.js";
import { readCodeOwnersFile } from "../../packages/broker/src/plugins/code-host/code-owners-file.js";

const never = async (): Promise<"unknown"> => "unknown";

describe("codeOwnerVerdict", () => {
  const verdict = (text: string | undefined, paths: string[], approvers: string[], team: (team: string, login: string) => Promise<"member" | "not_member" | "unknown"> = never) =>
    codeOwnerVerdict({ codeOwners: text === undefined ? undefined : readCodeOwnersFile(text), paths, approverLogins: approvers, teamMember: team });

  it("fails closed on a file it cannot read the way the host does, whatever the changed paths are", async () => {
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

describe("codeOwnerVerdict over a neutral answer", () => {
  it("works from any host's owners, not only a file's: a person, a team and an owner it cannot match", async () => {
    const owners = { unsupported: false, ownersOf: (path: string) => (path.startsWith("pay/") ? [{ kind: "team" as const, team: "acme/pay" }, { kind: "person" as const, login: "Lee" }] : []) };
    const team = async (name: string, login: string) => (name === "acme/pay" && login === "kim" ? "member" as const : "not_member" as const);
    expect(await codeOwnerVerdict({ codeOwners: owners, paths: ["pay/a.ts"], approverLogins: ["lee"], teamMember: team })).toEqual({ ok: true });
    expect(await codeOwnerVerdict({ codeOwners: owners, paths: ["pay/a.ts"], approverLogins: ["kim"], teamMember: team })).toEqual({ ok: true });
    expect(await codeOwnerVerdict({ codeOwners: owners, paths: ["pay/a.ts"], approverLogins: ["zed"], teamMember: team })).toEqual({ ok: false, owners: "@acme/pay, @Lee" });
    expect(await codeOwnerVerdict({ codeOwners: owners, paths: ["other.ts"], approverLogins: [], teamMember: team })).toEqual({ ok: true });
    expect(await codeOwnerVerdict({ codeOwners: { unsupported: true, ownersOf: () => [] }, paths: ["x"], approverLogins: [], teamMember: team })).toEqual({ ok: false, unreadable: true });
  });
});
