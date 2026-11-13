// The model-based floor: the one reviewer a small change gets also answers a fixed set of yes/no questions, and any yes raises the tier to risky (only up, with the reviewer's reason). Tested with a fake reviewer.
// The failure cases (a throw, a timeout, malformed output, a missing or repeated answer) are in change-tier-third-round.test.ts.
import { describe, expect, it } from "vitest";
import { patchDigestOf, recordTier, tierFromDiff, tierReviewRecorded, reviewerFloorRecorded, type ChangeTier, type TierFile } from "../../packages/broker/src/core/decisions/change-tier.js";
import { TIER_QUESTIONS, applyReviewerFloor, recordReviewerFloor, tierReviewPrompt, type TierReviewAnswer, type TierReviewer } from "../../packages/broker/src/core/decisions/tier-reviewer.js";

const AT = "2026-11-13T12:00:00.000Z";
const PATCH = "@@ -1 +1 @@\n-a\n+b";
const file = (path: string): TierFile => ({ path, status: "modified", additions: 1, deletions: 1, patch: PATCH });
const smallTier = (): ChangeTier => tierFromDiff({ files: [file("src/a.ts")], complete: true }, { headSha: "a".repeat(40), at: AT });
const answers = (yes: Record<string, string> = {}): TierReviewAnswer[] => TIER_QUESTIONS.map((question) => ({ id: question.id, yes: question.id in yes, ...(question.id in yes ? { reason: yes[question.id]! } : {}) }));
const reviewer = (give: () => readonly TierReviewAnswer[] | Promise<readonly TierReviewAnswer[]>): TierReviewer & { asked: number } => {
  const fake = { asked: 0, async answer() { fake.asked += 1; return give(); } };
  return fake;
};
const ask = (fake: TierReviewer, tier: ChangeTier = smallTier()) => applyReviewerFloor({ tier, reviewer: fake, files: ["src/a.ts"], patchText: PATCH });

describe("the reviewer floor", () => {
  it("asks the fixed questions, and a small change stays small when every answer is no", async () => {
    const fake = reviewer(() => answers());
    const result = await ask(fake);
    expect(fake.asked).toBe(1);
    expect(result).toMatchObject({ ran: true, raised: false, yes: [] });
    expect(result.tier.level).toBe("small");
    expect(tierReviewPrompt(["src/a.ts"], PATCH)).toContain("auth:");
    expect(TIER_QUESTIONS.map((question) => question.id)).toEqual(["auth", "money", "permissions", "deletion", "checks", "dependencies", "infra", "agent_instructions", "injection", "transport", "exposure", "exfiltration", "tests", "other_security"]);
  });

  it("any yes raises the tier to risky with the reviewer's reason in front, and the growth is recorded", async () => {
    const result = await ask(reviewer(() => answers({ auth: "the change checks a session cookie" })));
    expect(result).toMatchObject({ ran: true, raised: true, yes: ["auth"] });
    expect(result.tier.level).toBe("risky");
    expect(result.tier.reasons[0]).toEqual({ code: "reviewer_auth", path: "the change checks a session cookie" });
    const flow = recordReviewerFloor(recordTier(undefined, smallTier()).flow, result, AT)!;
    expect(flow.tier?.level).toBe("risky");
    expect(flow.grewAfterBuild).toMatchObject({ from: "small", to: "risky" });
    expect(flow.catchCounters).toContainEqual({ step: "tier_questions", findings: 1, mustFix: 1, changedCode: 0 });
    const digest = patchDigestOf(PATCH);
    expect(reviewerFloorRecorded(flow, "a".repeat(40), digest)).toBe(true);
    expect(reviewerFloorRecorded(flow, "b".repeat(40), digest)).toBe(false);
    expect(reviewerFloorRecorded(flow, "a".repeat(40), patchDigestOf("another patch"))).toBe(false);
    expect(reviewerFloorRecorded(flow, undefined, digest)).toBe(false);
    // The raise needs the risky review on this head before a merge (the gate's rule).
    expect(tierReviewRecorded(flow, "risky", "a".repeat(40))).toBe(false);
  });

  it("an unknown id is ignored, and a reason is cut to one plain line", async () => {
    const noisy = await ask(reviewer(() => answers({ infra: ["line one", "line two ", "x".repeat(900)].join(String.fromCharCode(10, 0x200b)) })));
    const reason = noisy.tier.reasons[0]!.path!;
    expect(reason.includes(String.fromCharCode(10)) || reason.includes(String.fromCharCode(0x200b))).toBe(false);
    expect(reason.length).toBeLessThanOrEqual(200);
    const extra = await ask(reviewer(() => [...answers(), { id: "made_up", yes: true, reason: "x" }]));
    expect(extra.tier.level).toBe("small");
  });

  it("only goes up: a risky tier stays risky whatever the reviewer says, and the reasons are kept", async () => {
    const risky = tierFromDiff({ files: [file("src/auth/session.ts")], complete: true }, { headSha: "a".repeat(40), at: AT });
    const result = await ask(reviewer(() => answers()), risky);
    expect(result.tier).toEqual(risky);
    const yes = await ask(reviewer(() => answers({ money: "price list" })), risky);
    expect(yes.raised).toBe(false);
    expect(yes.tier.level).toBe("risky");
    expect(yes.tier.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining(["reviewer_money", "sensitive_path"]));
  });
});
