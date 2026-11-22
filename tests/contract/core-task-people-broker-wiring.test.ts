import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { SLACK_OIDC_ISSUER, type DeveloperSignInMethod, type TaskPersonProofRequest } from "@agentx/contracts";
import { developerTaskRouteDependencies, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { getTaskPeople } from "../../packages/broker/src/developer/task-people.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { companyProjectRow } from "../support/company-layout-projects.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

// Execute the broker's actual dependency-object expression with offline ports, without importing its process/bootstrap side effects.
function brokerProofInputs(context: Record<string, unknown>): DeveloperRouteDependencies {
  const file = ts.createSourceFile("broker.ts", readFileSync("packages/broker/src/aws/broker.ts", "utf8"), ts.ScriptTarget.Latest, true);
  let expression: string | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "coreRoot" && node.initializer !== undefined) {
      const find = (child: ts.Node): void => {
        if (ts.isPropertyAssignment(child) && child.name.getText(file) === "checkTaskPerson") {
          const dependency = (part: ts.Node): void => {
            if (ts.isCallExpression(part) && part.expression.getText(file) === "developerTaskRouteDependencies") expression = part.arguments[0]?.getText(file);
            ts.forEachChild(part, dependency);
          };
          dependency(child.initializer);
        }
        ts.forEachChild(child, find);
      };
      find(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (expression === undefined) throw new Error("broker core proof wiring not found");
  return new Script(`(${expression})`).runInNewContext(context) as DeveloperRouteDependencies;
}

describe("broker-wired People on an unshared real core task", () => {
  const cases = (["slack", "oidc", "github", "cloud", "saml"] as const).flatMap(method =>
    (["valid", "non-member", "other company", "revoked", "no grant", "unknown method"] as readonly string[]).map(scenario => ({ method, scenario })));
  cases.push({ method: "slack", scenario: "legacy-unshared" });
  it.each(cases)("$method owner: $scenario, through the broker's actual proof dependencies", async ({ method, scenario }: { method: DeveloperSignInMethod; scenario: string }) => {
    const companyId = `org_${"a".repeat(20)}` as const;
    const teamId = "T0TEAM001", slackUserId = "U0OWNER01";
    const issuer = method === "slack" ? SLACK_OIDC_ISSUER : "https://signin.example.test";
    const subject = method === "slack" ? slackUserId : "owner";
    const developerId = ownerKeyForSubject(issuer, subject);
    const h = createHarness({ companyId });
    await h.registerProject();
    const db = new FakeDynamoDb();
    db.set(companyProjectRow(companyId, "payments", 1));
    db.set({ pk: `ORG#${companyId}#MEMBER#${developerId}`, sk: "PROJECT#payments", projectName: "payments", role: "developer" });
    db.set({ pk: `ORG#${companyId}#SLACK_WORKSPACES`, sk: `TEAM#${teamId}`, entityType: "COMPANY_SLACK_WORKSPACE_VIEW", companyId, teamId, boundAt: "2026-11-01T00:00:00.000Z", boundBy: "operator" });
    db.set({ pk: `ORG#${companyId}#SLACK_BINDING#${teamId}`, sk: "CHANNEL#C0PROJECT1", teamId, channelId: "C0PROJECT1", projectName: "payments", updatedAt: "2026-11-01T00:00:00.000Z" });
    db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: method, issuer, subject, slackUserId, displayName: "Owner", revoked: false });
    db.set({ pk: `COMPANY_MEMBER#${developerId}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: developerId, companyId, role: "member", joinedAt: "2026-11-01T00:00:00.000Z" });
    const companies = { companyOf: async (id: string) => {
      const row = db.get(`COMPANY_MEMBER#${id}`, "COMPANY");
      return typeof row?.companyId === "string" ? row.companyId : undefined;
    } };
    const signIn: DeveloperRouteDependencies["developer"] = {
      signInTableName: "signin", slackTeamId: teamId, companies, taskPeopleConfiguration: { peopleChangesEnabled: true },
      taskPersonProof: async (request: TaskPersonProofRequest) => ({ ok: true, user: { id: request.slackUserId, teamId, name: "Owner" }, memberOf: [] }),
    } as unknown as DeveloperRouteDependencies["developer"];
    const inputs = brokerProofInputs({ documentClient: db, requiredEnvironment: () => "state", signIn, Date: { now: () => h.clock.now }, slackCompany: { companies, workspaces: { requireCompany: async () => companyId } } });
    const caller = { developerId, sessionId: "core", name: "Owner", amr: method, slackUserId };
    const rules = developerTaskRouteDependencies(inputs, caller, undefined, null);
    const startCaller = { ...h.owner, slackUserId, principal: { ...h.owner.principal, personId: developerId, displayName: "Owner", provider: scenario === "legacy-unshared" ? "slack" : "rovara-sign-in" } };
    const { task: started } = await h.flow.start(startCaller, { requestId: newRequestId(), project: "payments", instructions: "Fix it", workflow: true, workflowPath: "QUICK" });
    const pk = `DEVTASK#${started.taskId}`;
    for (const row of (await h.store.query({ pk })).items) db.set(row);
    const task = (await h.store.get({ pk, sk: "META" })) as unknown as DeveloperTaskRecord;
    if (scenario === "legacy-unshared") {
      await expect(rules.checkTaskPerson!(task, developerId)).rejects.toThrow("This Slack workspace is not available.");
      return;
    }
    expect(await rules.checkTaskPerson!(task, developerId)).toMatchObject({ eligible: true, channelMember: true });
    expect((await getTaskPeople(rules, caller, task.taskId)).people).toMatchObject([{ you: true, effectiveRole: "owner", method }]);
    if (scenario === "valid") return;
    const membershipKey = `COMPANY_MEMBER#${developerId}`, recordKey = `DEVELOPER#${developerId}`;
    if (scenario === "non-member") db.delete(membershipKey, "COMPANY");
    if (scenario === "other company") db.set({ ...db.get(membershipKey, "COMPANY"), companyId: `org_${"b".repeat(20)}` });
    if (scenario === "revoked") db.set({ ...db.get(recordKey, "META"), revoked: true });
    if (scenario === "no grant") db.delete(`ORG#${companyId}#MEMBER#${developerId}`, "PROJECT#payments");
    if (scenario === "unknown method") db.set({ ...db.get(recordKey, "META"), provider: "future-method" });
    const ended = scenario === "non-member" && ["slack", "oidc", "github"].includes(method);
    await expect(getTaskPeople(rules, caller, task.taskId)).rejects.toMatchObject({ code: ended ? "AUTH_REQUIRED" : expect.stringMatching(/^(TASK|PROJECT)_ACCESS_DENIED$/) as unknown, message: expect.stringContaining(ended ? "sign-in has ended" : "could not be verified") as unknown });
  });
});
