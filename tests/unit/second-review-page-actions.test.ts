import { expect, it } from "vitest";
import { createPageExtraActions } from "../../packages/broker/src/local/app/page-data.js";
import { COMPANY, OTHER, OWNER, createWorld, secondPersonApprovers } from "../support/second-review-world.js";
import { createHarness } from "../support/task-flow-harness.js";

it.each([false, true])("approve-mode preserves the page's freshness check (fresh=%s)", async (fresh) => {
  const world = createWorld({ approvers: secondPersonApprovers() });
  await world.review.apply(OTHER, { action: "mode", scope: "company", mode: "shadow" });
  const proposed = await world.review.apply(OTHER, { action: "mode", scope: "company", mode: "off" });
  if (proposed.status !== "needs_approval") throw new Error("Expected a second-person proposal");
  const changeId = proposed.changeId;
  const actions = createPageExtraActions({ flow: createHarness().deps, companyId: COMPANY, owner: OWNER, secondReview: world.review });

  const result = await actions.secondReview!({ action: "approve-mode", changeId }, {
    fresh,
    proof: (request) => ({ ...request, proofId: "proof-owner", method: "test-proof", token: `ok:${OWNER.personId}` }),
  });

  if (fresh) {
    expect(result).toEqual({ ok: true, message: "Saved." });
    expect((await world.review.state()).modes.company).toBe("off");
    expect((await world.review.state()).pending).toEqual([]);
  } else {
    expect(result).toMatchObject({ ok: false, reason: "reauth" });
    expect((await world.review.state()).modes.company).toBe("shadow");
    expect((await world.review.state()).pending).toMatchObject([{ changeId }]);
  }
});
