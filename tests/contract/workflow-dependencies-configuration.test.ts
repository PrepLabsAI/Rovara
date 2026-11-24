import { describe, expect, it } from "vitest";
import { planDocumentInstructions } from "../../packages/broker/src/aws/broker-shared.js";
import { createDeveloperApiConfiguration } from "../../packages/broker/src/aws/workflow-dependencies-configuration.js";
import { developerTaskRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";

describe("workflow dependency runtime configuration", () => {

  it("composes the real developer route feature settings: ordered work has no switch (DEC 254zzz461), People and invitations are unchanged", () => {
    const developer = createDeveloperApiConfiguration({
      DEVELOPER_TOKEN_ISSUER: "https://issuer.example/v1/auth",
      DEVELOPER_IDENTITY_FUNCTION_ARN: "developer-identity",
      DEVELOPER_SIGNIN_TABLE_NAME: "sign-ins",
      AGENTX_ENV: "agentxlivetest123",
      DEVELOPER_SIGNIN_SLACK: "enabled",
      AGENTX_TASK_PEOPLE_CHANGES_ENABLED: "true",
      AGENTX_TASK_PEOPLE_PUBLIC_INVITATIONS_ENABLED: "false",
      AGENTX_TASK_PEOPLE_PRIVATE_INVITATIONS_ENABLED: "false",
    }, () => ({
      channelMembers: async () => ({ ok: true as const, memberOf: [] as string[] }),
      verifyAccessToken: async () => ({}),
    }));
    expect(developer).toBeDefined();
    expect(developer).not.toHaveProperty("workflowDependenciesEnabled");
    const routes = developerTaskRouteDependencies({
      documentClient: { send: async () => ({}) }, tableName: "state", developer: developer!, now: Date.now,
    }, { developerId: "dev", sessionId: "session", amr: "slack", name: "Dev" });
    expect(routes).not.toHaveProperty("workflowDependenciesEnabled");
    expect(routes.taskPeopleConfiguration).toEqual({ peopleChangesEnabled: true });
    expect(typeof routes.inviteTaskPerson).toBe("undefined");
  });

  it("adds canonical work-breakdown guidance only when the pinned task context is supplied", () => {
    const ordinary = planDocumentInstructions({ kind: "plan", path: "QUICK" });
    const eligible = planDocumentInstructions({ kind: "plan", path: "QUICK", workBreakdownContext: {
      taskId: "61dcaa71-b1d4-4b22-8174-817a62636e52",
      repositoryId: "payments-service",
    } });

    expect(ordinary).not.toContain("workBreakdown");
    for (const required of [
      "workBreakdown",
      '"schemaVersion":1',
      '"taskId":"61dcaa71-b1d4-4b22-8174-817a62636e52"',
      '"repository":"payments-service"',
      "8 items",
      "12 dependency edges",
      "16,384 canonical bytes",
      "one final pull request",
      "deterministic serial dependency order",
      "approves the whole graph",
      "Do not claim checks or review as executor self-attestation",
    ]) expect(eligible).toContain(required);
  });

});
