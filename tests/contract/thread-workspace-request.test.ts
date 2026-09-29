import { describe, expect, it } from "vitest";
import { threadWorkspaceRequest } from "../../packages/slack-service/src/thread-workspace-request.js";

describe("the Slack service's thread workspace request", () => {
  it("opts in to every field this service can parse, including unfinished operations", () => {
    expect(threadWorkspaceRequest("request-1")).toEqual({
      requestId: "request-1", includeIntegrations: true, includeSettingsRevision: true, includeConnectors: true,
      includeAllConnectorTypes: true, includeRecoverableOperations: true, lazyPreparation: true, includeActionPolicy: true,
      includeSharedTask: true,
    });
  });
});
