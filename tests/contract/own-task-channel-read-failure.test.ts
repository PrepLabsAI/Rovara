// MEMBERSHIP-READ-FAILS-SAFE: the task's OWN person on an OLD-ENGINE task (no engine stamp) holds it through the start's own test, which also admits fresh bound-channel membership
// (`taskReaderPerson` with `ownTask`, then `checkProjectAccess`). A membership read that FAILS anywhere on that path is the retryable 503 (membership-read.ts), never "not your task":
// the person is either held (as before the failure) or told to try again, whichever of the path's reads fails.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { developerTaskRouteDependencies, type DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { coreTaskMarkKey } from "../../packages/broker/src/core-host/core-task-mark.js";
import { companyRouteHarness, PERSON, TASK } from "../support/company-route-harness.js";

const caller: DeveloperCaller = { developerId: PERSON, sessionId: "session", amr: "slack", name: "Test Person", slackUserId: "U0SHARED" };

describe("an old-engine task's own person, held by the bound channel (no grant), when one membership read fails", () => {
  it("is held, or told the retryable 503 for the failed read: never 'not your task' (mayStart false)", async () => {
    const h = companyRouteHarness();
    h.project(undefined, "channel"); h.task(TASK);
    // The harness stamps every task as the core's (D1-2); this path is the unstamped task's, so the stamp is taken off.
    h.db.delete(coreTaskMarkKey(TASK).pk, coreTaskMarkKey(TASK).sk);
    const state = { count: 0, failAt: 0 };
    h.deps.companies = { companyOf: async () => { state.count += 1; if (state.count === state.failAt) throw new Error("the store failed"); return IMPLICIT_COMPANY_ID; } };
    const ask = () => developerTaskRouteDependencies(h.deps, caller).taskReaderPerson!(PERSON, "shared-project", undefined, { ownTask: true, taskId: TASK });
    // Control: with every read working, the channel holds the old-engine task's own person.
    expect(await ask()).toMatchObject({ projectMember: false, mayStart: true });
    const reads = state.count;
    expect(reads, "the path reads membership more than once, so a later read can fail on its own").toBeGreaterThan(1);
    const answers: string[] = [];
    for (let failAt = 1; failAt <= reads; failAt += 1) {
      state.count = 0; state.failAt = failAt;
      const answer = await ask().then((value) => `held:${String(value?.mayStart)}`, (error: { code?: string }) => `error:${String(error.code)}`);
      if (answer !== "held:true" && answer !== "error:RUNTIME_UNAVAILABLE") answers.push(`read #${String(failAt)} of ${String(reads)} failed -> ${answer}`);
    }
    expect(answers).toEqual([]);
  });
});
