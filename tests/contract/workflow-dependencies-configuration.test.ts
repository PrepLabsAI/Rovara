import { describe, expect, it } from "vitest";
import { planDocumentInstructions } from "../../packages/broker/src/aws/broker-shared.js";
import { createDeveloperApiConfiguration, workflowDependenciesConfigurationFromEnvironment } from "../../packages/broker/src/aws/workflow-dependencies-configuration.js";
import { developerTaskRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";

describe("workflow dependency runtime configuration", () => {
  it("is disabled unless the exact runtime value is true", () => {
    for (const value of [undefined, "", "false", "FALSE", "1"]) {
      expect(workflowDependenciesConfigurationFromEnvironment({ AGENTX_WORKFLOW_DEPENDENCIES_ENABLED: value }))
        .toEqual({ workflowDependenciesEnabled: false });
    }
    expect(workflowDependenciesConfigurationFromEnvironment({ AGENTX_WORKFLOW_DEPENDENCIES_ENABLED: "true" }))
      .toEqual({ workflowDependenciesEnabled: true });
  });

  it("composes the real developer route feature settings without changing People or invitations", () => {
    const build = (flag: string | undefined) => createDeveloperApiConfiguration({
      DEVELOPER_TOKEN_ISSUER: "https://issuer.example/v1/auth",
      DEVELOPER_IDENTITY_FUNCTION_ARN: "developer-identity",
      DEVELOPER_SIGNIN_TABLE_NAME: "sign-ins",
      AGENTX_ENV: "agentxlivetest123",
      DEVELOPER_SIGNIN_SLACK: "enabled",
      AGENTX_WORKFLOW_DEPENDENCIES_ENABLED: flag,
      AGENTX_TASK_PEOPLE_CHANGES_ENABLED: "true",
      AGENTX_TASK_PEOPLE_PUBLIC_INVITATIONS_ENABLED: "false",
      AGENTX_TASK_PEOPLE_PRIVATE_INVITATIONS_ENABLED: "false",
    }, () => ({
      channelMembers: async () => ({ ok: true as const, memberOf: [] as string[] }),
      verifyAccessToken: async () => ({}),
    }));
    const routesFor = (developer: NonNullable<ReturnType<typeof build>>) => developerTaskRouteDependencies({
      documentClient: { send: async () => ({}) }, tableName: "state", developer, now: Date.now,
    }, { developerId: "dev", sessionId: "session", amr: "slack", name: "Dev" });

    const enabled = build("true");
    expect(enabled).toBeDefined();
    const enabledRoutes = routesFor(enabled!);
    expect(enabledRoutes.workflowDependenciesEnabled).toBe(true);
    expect(enabledRoutes.taskPeopleConfiguration).toEqual({ peopleChangesEnabled: true });
    expect(typeof enabledRoutes.inviteTaskPerson).toBe("undefined");

    const disabled = build("false");
    expect(disabled).toBeDefined();
    const disabledRoutes = routesFor(disabled!);
    expect(disabledRoutes.workflowDependenciesEnabled).toBe(false);
    expect(disabledRoutes.taskPeopleConfiguration).toEqual({ peopleChangesEnabled: true });
    expect(typeof disabledRoutes.inviteTaskPerson).toBe("undefined");
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

  it("does not add work-breakdown guidance to requirements or design documents", () => {
    for (const kind of ["requirements", "design"] as const) {
      expect(planDocumentInstructions({ kind, path: "FULL", workBreakdownContext: {
        taskId: "61dcaa71-b1d4-4b22-8174-817a62636e52",
        repositoryId: "payments-service",
      } })).not.toContain("workBreakdown");
    }
  });
});
