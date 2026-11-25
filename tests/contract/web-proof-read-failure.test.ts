// MEMBERSHIP-READ-FAILS-SAFE: the web proof of a People-list person (developer-routes.ts `webProof` and its identity record read) over the REAL route wiring: with one of its reads failing the check is the
// retryable 503 (RUNTIME_UNAVAILABLE), never TASK_ACCESS_DENIED or "not eligible"; with every read working the person is eligible; a read that ANSWERS "no" still refuses.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { developerTaskRouteDependencies, type DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { companyRouteHarness, TASK, TIME } from "../support/company-route-harness.js";

const ISSUER = "https://signin.example.test";
const SUBJECT = "web-person";
const ID = ownerKeyForSubject(ISSUER, SUBJECT);
const caller: DeveloperCaller = { developerId: ID, sessionId: "session", amr: "oidc", name: "Web Person" };

function world() {
  const h = companyRouteHarness();
  h.project(undefined, "none");
  h.task(TASK);
  h.db.set({ ...h.db.get(`DEVTASK#${TASK}`, "META")!, provider: "oidc", developerId: ID, ownerKey: ID, developerName: "Web Person" });
  h.db.set({ pk: `DEVELOPER#${ID}`, sk: "META", entityType: "DEVELOPER", provider: "oidc", issuer: ISSUER, subject: SUBJECT, displayName: "Web Person", revoked: false, firstSignInAt: TIME, lastSignInAt: TIME });
  h.db.set({ pk: `COMPANY_MEMBER#${ID}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: ID, companyId: IMPLICIT_COMPANY_ID, role: "member", joinedAt: TIME });
  h.db.set({ pk: `MEMBER#${ID}`, sk: "PROJECT#shared-project", projectName: "shared-project", role: "developer" });
  h.deps.companies = { companyOf: async () => IMPLICIT_COMPANY_ID, membershipOf: async () => ({ companyId: IMPLICIT_COMPANY_ID, role: "member" as const }) };
  const task = () => h.db.get(`DEVTASK#${TASK}`, "META") as unknown as DeveloperTaskRecord;
  const check = () => developerTaskRouteDependencies(h.deps, caller).checkTaskPerson!(task(), ID);
  return { h, check };
}

describe("the web proof of a People-list person", () => {
  it("(control) with every read working the person is eligible and present", async () => {
    const { check } = world();
    expect(await check()).toMatchObject({ eligible: true, channelMember: true });
  });

  it.each([
    ["the identity record", (input: Record<string, unknown>) => (input.Key as { pk?: string } | undefined)?.pk === `DEVELOPER#${ID}`, "GetCommand"],
    ["the company membership row", (input: Record<string, unknown>) => (input.Key as { pk?: string } | undefined)?.pk === `COMPANY_MEMBER#${ID}`, "GetCommand"],
    ["the person's grant rows", (input: Record<string, unknown>) => JSON.stringify(input).includes(`MEMBER#${ID}`), "QueryCommand"],
  ] as const)("a failed read of %s is the retryable 503, never a refusal", async (_name, match, command) => {
    const { h, check } = world();
    h.db.injectFault({ command, match, error: { name: "ServiceUnavailable", message: "the store failed" }, times: 1 });
    await expect(check()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(await check(), "the next check, with the read back").toMatchObject({ eligible: true });
  });

  it("a membership row that ANSWERS 'revoked' is still not eligible", async () => {
    const { h, check } = world();
    h.db.set({ ...h.db.get(`COMPANY_MEMBER#${ID}`, "COMPANY")!, revokedAt: TIME });
    expect(await check()).toMatchObject({ eligible: false });
  });
});
