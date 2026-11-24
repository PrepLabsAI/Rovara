// Opus permissions review (2026-11-24) of "merge approvals count only from a current member": the edges the change's own tests leave implicit.
// The hosted MergePeople never turns the member check off; only the laptop's sole owner does. Over the REAL hosted identity point, an account linked in another company, a member who moved
// company or left, and a removed link are nobody, so with self-approval ON their approval does not count. An Auditor, a bot and Rovara's own app never count in either mode.
import { describe, expect, it } from "vitest";
import { approvalStandingOf, humanApprovalOf } from "../../packages/broker/src/core/merge/approval.js";
import { createIdentityMergePeople, soleOwnerPeople, type MergePeople } from "../../packages/broker/src/core/merge/people.js";
import { createHostedMergePeople } from "../../packages/broker/src/aws/hosted-merge-people.js";
import { createHostedIdentity } from "../../packages/broker/src/core-host/hosted-modules.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const HEAD = "a".repeat(40);

describe("(review) approvalStandingOf: only the laptop's sole owner turns the member check off", () => {
  it("the hosted people and the identity people are strict; a MergePeople without the field is strict; soleOwnerPeople alone is not", async () => {
    const identity = { capabilities: {}, authenticate: async () => ({ ok: false as const, reason: "refused" as const }), getPrincipal: async () => undefined, resolveExternalAccount: async () => undefined } as never;
    const hosted = createHostedMergePeople(identity, { documentClient: { send: async () => ({}) }, tableName: "state" });
    expect(hosted.membersTracked).not.toBe(false);
    expect((await approvalStandingOf(hosted, A as never, ["1"])).membersTracked).toBe(true);
    expect((await approvalStandingOf(createIdentityMergePeople(identity, { hostProvider: "github" }), A as never, ["1"])).membersTracked).toBe(true);
    const withoutField = Object.fromEntries(Object.entries(soleOwnerPeople).filter(([key]) => key !== "membersTracked")) as unknown as MergePeople;
    expect((await approvalStandingOf(withoutField, A as never, ["1"])).membersTracked).toBe(true);
    expect((await approvalStandingOf(soleOwnerPeople, A as never, ["1"])).membersTracked).toBe(false);
  });
});

describe("(review) self-approval ON over the real hosted identity point", () => {
  // GitHub account 11 is linked to `ana` in company A, account 22 to `bo` in company B, account 33 to `cy` in company A (cy has since moved to company B), account 44 to `di` in A (di left).
  const linkRows: Record<string, Record<string, string>> = { [A]: { "11": "ana", "33": "cy", "44": "di" }, [B]: { "22": "bo" } };
  const membership: Record<string, { companyId: string; role: "member" | "admin" }> = { ana: { companyId: A, role: "member" }, bo: { companyId: B, role: "admin" }, cy: { companyId: B, role: "member" } };
  const identity = createHostedIdentity({
    membershipOf: async (personId) => membership[personId],
    displayNameOf: async (personId) => personId,
    githubLinks: { personOf: async (companyId, id) => linkRows[companyId]?.[id], accountOf: async () => undefined },
  });
  const people = createIdentityMergePeople(identity, { hostProvider: "github" });
  const approve = async (hostUserId: string, over: Partial<Parameters<typeof humanApprovalOf>[0]> = {}) => humanApprovalOf({
    reviews: [{ hostUserId, login: `u${hostUserId}`, accountType: "person", state: "APPROVED", commitId: HEAD, submittedAt: "2026-11-24T08:00:00Z" }], headSha: HEAD, syncedFrom: undefined, ciPassingOnHead: true,
    permissions: new Map([[`u${hostUserId}`, "write" as const]]), requesterHostUserIds: [hostUserId], allowSelfApproval: true, ...await approvalStandingOf(people, A, [hostUserId]), ...over,
  });

  it("a current member's own approval counts; another company's member, one who moved company, one who left, and an unlinked account do not", async () => {
    expect(await approve("11")).toMatchObject({ approved: true });
    expect(await approve("22")).toEqual({ approved: false, reason: "none" });
    expect(await approve("33")).toEqual({ approved: false, reason: "none" });
    expect(await approve("44")).toEqual({ approved: false, reason: "none" });
    expect(await approve("55")).toEqual({ approved: false, reason: "none" });
  });

  it("the link removed (no account row) is nobody, even for a current member", async () => {
    const saved = linkRows[A]!["11"];
    delete linkRows[A]!["11"];
    try { expect(await approve("11")).toEqual({ approved: false, reason: "none" }); } finally { linkRows[A]!["11"] = saved!; }
  });
});

describe("(review) who never counts, whatever self-approval says", () => {
  const base = (over: Partial<Parameters<typeof humanApprovalOf>[0]> = {}) => humanApprovalOf({
    reviews: [{ hostUserId: "1", login: "ana", accountType: "person", state: "APPROVED", commitId: HEAD, submittedAt: "2026-11-24T08:00:00Z" }], headSha: HEAD, syncedFrom: undefined, ciPassingOnHead: true,
    permissions: new Map([["ana", "write" as const]]), requesterHostUserIds: ["9"], linkedHostUserIds: new Set(["1"]), allowSelfApproval: true, ...over,
  });
  it("an Auditor (a member who may not approve), a bot, and Rovara's own app account", () => {
    for (const allowSelfApproval of [true, false]) {
      expect(base({ allowSelfApproval, excludedHostUserIds: new Set(["1"]) })).toEqual({ approved: false, reason: "no_write" });
      expect(base({ allowSelfApproval, reviews: [{ hostUserId: "1", login: "ana", accountType: "bot", state: "APPROVED", commitId: HEAD, submittedAt: "2026-11-24T08:00:00Z" }] })).toEqual({ approved: false, reason: "none" });
      expect(base({ allowSelfApproval, appUserId: "1" })).toEqual({ approved: false, reason: "none" });
    }
    // Even the laptop's relaxed mode keeps these out.
    expect(base({ linkedHostUserIds: new Set(), membersTracked: false, appUserId: "1" })).toEqual({ approved: false, reason: "none" });
  });
});
