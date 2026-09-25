import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { SlackThreadWorkspaceResultSchema, type SlackRequestMessage } from "../../packages/contracts/src/slack.js";
import { ControlPlaneApi } from "../../packages/orchestrator/src/control-plane-api.js";
import { processSlackRequest, type ProcessorDependencies } from "../../packages/slack-service/src/processor.js";
import { createHostedSlackRuntime } from "../../packages/slack-service/src/runtime.js";
import { createSignedServiceFetch } from "../../packages/slack-service/src/signing-fetch.js";
import { createFixtureDirectory } from "../fixtures/index.js";
import { brokerFetch } from "../support/broker-fetch.js";
import { CHARTERARC_TEAM_ID } from "../support/fake-linear-mcp.js";
import { LINEAR_CHANNEL, LINEAR_MEMBER, LINEAR_TEAM, LINEAR_THREAD, LINEAR_THREAD_TS, setupLinearBroker } from "../support/linear-broker.js";
import { call, loadSlackBroker, orchestratorPrincipal } from "../support/slack-broker.js";

beforeAll(async () => { await loadSlackBroker(); });

describe("hosted Slack turn with Linear", () => {
  it("offers the Linear tools, lists the team's issues and creates one signed issue for a redelivered event", async () => {
    const message: SlackRequestMessage = {
      version: 1, eventId: "EvLIN000001", receivedAt: new Date().toISOString(), userId: LINEAR_MEMBER,
      thread: { teamId: LINEAR_TEAM, channelId: LINEAR_CHANNEL, threadTs: LINEAR_THREAD_TS },
      text: "Create a Linear issue for the flaky login test.",
    };
    const { handler, fake, workspaceId } = await setupLinearBroker({ preflight: false });
    try {
      // The same thread asks again, as the new Slack service does, to learn its connectors.
      const workspace = await call(handler, { method: "POST", path: "/v1/service/threads/workspace",
        service: { principal: orchestratorPrincipal, thread: LINEAR_THREAD, slackUser: LINEAR_MEMBER },
        body: { requestId: randomUUID(), includeConnectors: true, includeAllConnectorTypes: true, includeSettingsRevision: true } });
      // The broker's json() helper merges the HTTP-trace requestId into every response body; the
      // production Slack service strips it before parsing with the strict result schema (see
      // packages/slack-service/src/main.ts's threadApi.ensureWorkspace), and this test does the same.
      delete workspace.body.requestId;
      const resolved = SlackThreadWorkspaceResultSchema.parse(workspace.body);
      expect((resolved as { workspaceId: string }).workspaceId).toBe(workspaceId);
      expect((resolved as { connectors: unknown[] }).connectors).toEqual([{ name: "linear", type: "linear", label: "Linear issues", scopes: ["charterarc"], connected: true }]);

      const signedFetch = createSignedServiceFetch({ region: "us-east-1", credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" },
        thread: message.thread, userId: message.userId, baseFetch: brokerFetch(handler) });
      const api = new ControlPlaneApi("https://agentx.example.test", "slack-service", workspaceId, signedFetch);
      const post = vi.fn(async () => undefined);
      let turn = 0;
      const dependencies: ProcessorDependencies = {
        api: () => ({ ensureWorkspace: async () => ({ ...(resolved as object), status: "READY" }) as never, createConversation: async () => randomUUID(), waitForOperation: vi.fn(), startClose: vi.fn(), completeClose: vi.fn() }),
        threads: { load: async () => ({ workspaceId, conversationId: "11111111-1111-4111-8111-111111111111" }), saveConversation: vi.fn(), saveSettingsRevision: vi.fn(), close: vi.fn(), finish: vi.fn() },
        runTurn: async (input) => {
          const runtime = await createHostedSlackRuntime(input, { stateDirectory: await createFixtureDirectory("agentx-slack-linear-"), api, model: { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0" } });
          try {
            expect(runtime.session.getActiveToolNames()).toEqual(expect.arrayContaining(["linear__list_issues", "linear__get_issue", "linear__save_issue", "linear__save_comment"]));
            const list = runtime.session.getToolDefinition("linear__list_issues")!;
            // The vendor's own schema legitimately mentions "team" inside an unrelated enum
            // (list_issues' `fields` filter), so the routing check is scoped to the tool's own
            // top-level properties, matching linear-mcp.test.ts's discovery assertion.
            const listProperties = (list.parameters as { properties: Record<string, unknown> }).properties;
            expect(listProperties).not.toHaveProperty("team");
            expect(listProperties).not.toHaveProperty("teamId");
            await list.execute(`list-${turn}`, { state: "started" }, undefined, undefined, {} as never);
            const create = runtime.session.getToolDefinition("linear__save_issue")!;
            const callId = `create-${turn++}`;
            await create.execute(callId, { title: "Flaky login test", description: "Fails one run in five." }, undefined, undefined, {} as never);
            await create.execute(callId, { title: "Flaky login test", description: "Fails one run in five." }, undefined, undefined, {} as never);
            return "Created the Linear issue.";
          } finally { await runtime.dispose(); }
        },
        post,
      };
      await processSlackRequest(message, dependencies, { finalAttempt: false });
      await processSlackRequest(message, dependencies, { finalAttempt: false });

      const creates = fake.calls.filter((entry) => entry.name === "save_issue");
      expect(creates).toHaveLength(1);
      expect(creates[0]!.arguments).toMatchObject({ title: "Flaky login test", team: CHARTERARC_TEAM_ID });
      expect(String(creates[0]!.arguments.description)).toMatch(/^Fails one run in five\.\n\n—\nRequested by `Slack member U0123456789` via AgentX · https:\/\/slack\.com\/archives\/C0123456789\/p1695500000000001$/);
      expect(fake.calls.filter((entry) => entry.name === "list_issues").every((entry) => entry.arguments.team === CHARTERARC_TEAM_ID)).toBe(true);
      expect(post).toHaveBeenLastCalledWith(message.thread, "Created the Linear issue.");
    } finally { await fake.close(); }
  });
});
