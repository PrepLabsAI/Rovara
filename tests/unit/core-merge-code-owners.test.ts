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
});
