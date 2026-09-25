import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { parseSlackThreadSubject } from "../../packages/contracts/src/slack.js";
import { createSignedServiceFetch } from "../../packages/slack-service/src/signing-fetch.js";
import { createThreadApi } from "../../packages/slack-service/src/thread-api.js";
import { brokerFetch } from "../support/broker-fetch.js";
import {
  SLACK_CHANNEL, SLACK_TEAM, createBroker, lazyEnsureWorkspace, loadSlackBroker, registerSlackProject, type Handler,
} from "../support/slack-broker.js";

const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
const pratik = "U0123456789";

beforeAll(async () => {
  await loadSlackBroker();
});

function threadApi(handler: Handler, sent: unknown[] = []) {
  const toBroker = brokerFetch(handler);
  const baseFetch: typeof fetch = async (input, init) => {
    if (typeof init?.body === "string") sent.push(JSON.parse(init.body));
    return toBroker(input, init);
  };
  const signedFetch = createSignedServiceFetch({
    region: "us-east-1", credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" },
    thread: parseSlackThreadSubject(thread), userId: pratik, baseFetch,
  });
  return createThreadApi({ controlPlaneUrl: "https://agentx.example.test", signedFetch });
}

describe("the Slack service's thread client", () => {
  it("prepares a thread with no compute through the prepare route", async () => {
    const { handler } = createBroker();
    await registerSlackProject(handler);
    const workspaceId = (await lazyEnsureWorkspace(handler, thread, pratik)).body.workspaceId as string;
    expect(await threadApi(handler).prepareWorkspace!(randomUUID())).toEqual({
      outcome: "WORKSPACE", workspaceId, status: "PREPARING", operationId: expect.any(String) as string, created: true,
    });
  });

  it("answers a close request in an empty thread as before the move", async () => {
    const { handler } = createBroker();
    await registerSlackProject(handler);
    expect(await threadApi(handler).startClose(randomUUID())).toEqual({ outcome: "NOT_FOUND" });
  });

  it("reports a refused request with the broker's code, as before the move", async () => {
    const { handler } = createBroker();
    await registerSlackProject(handler, { bind: false });
    await expect(threadApi(handler).ensureWorkspace(randomUUID())).rejects.toThrow(/^thread workspace request failed: FORBIDDEN /);
    await expect(threadApi(handler).prepareWorkspace!(randomUUID())).rejects.toThrow(/^thread workspace preparation failed: FORBIDDEN /);
  });

  it("opts into lazy preparation, so a new thread gets a record without compute", async () => {
    const { handler, db } = createBroker();
    await registerSlackProject(handler);
    const sent: unknown[] = [];
    const requestId = randomUUID();
    const result = await threadApi(handler, sent).ensureWorkspace(requestId);
    expect(sent).toEqual([{
      requestId, includeIntegrations: true, includeSettingsRevision: true, includeConnectors: true,
      includeAllConnectorTypes: true, includeRecoverableOperations: true, lazyPreparation: true,
      includeActionPolicy: true,
    }]);
    expect(result).toMatchObject({ outcome: "WORKSPACE", status: "UNPREPARED", operationId: null, created: true });
    expect(db.find((item) => item.entityType === "OPERATION")).toHaveLength(0);
  });
});
