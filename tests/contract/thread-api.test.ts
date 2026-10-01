import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { parseSlackThreadSubject } from "../../packages/contracts/src/slack.js";
import { createSignedServiceFetch } from "../../packages/slack-service/src/signing-fetch.js";
import { createThreadApi } from "../../packages/slack-service/src/thread-api.js";
import { brokerFetch } from "../support/broker-fetch.js";
import {
  SLACK_CHANNEL, SLACK_TEAM, createBroker, ensureWorkspace, finishOperation, lazyEnsureWorkspace, loadSlackBroker, markReady, registerSlackProject, serviceCall,
  type Handler,
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

  it("asks for the member's open AI-tool task count when it prepares a thread (spec 025 C16)", async () => {
    const { handler } = createBroker();
    await registerSlackProject(handler);
    await lazyEnsureWorkspace(handler, thread, pratik);
    const sent: unknown[] = [];
    const requestId = randomUUID();
    await threadApi(handler, sent).prepareWorkspace!(requestId);
    expect(sent).toEqual([{ requestId, includeOpenTaskCount: true, includeSharedTask: true }]);
  });

  it("opts in to the shared task refusal when it starts a close (spec 025 C11), and an ordinary thread still gets NOT_FOUND", async () => {
    const { handler } = createBroker();
    await registerSlackProject(handler);
    const sent: unknown[] = [];
    const requestId = randomUUID();
    expect(await threadApi(handler, sent).startClose(requestId)).toEqual({ outcome: "NOT_FOUND" });
    expect(sent).toEqual([{ requestId, includeSharedTask: true }]);
  });

  it("reports a refused request with the broker's code, as before the move", async () => {
    const { handler } = createBroker();
    await registerSlackProject(handler, { bind: false });
    await expect(threadApi(handler).ensureWorkspace(randomUUID())).rejects.toThrow(/^thread workspace request failed: FORBIDDEN /);
    await expect(threadApi(handler).prepareWorkspace!(randomUUID())).rejects.toThrow(/^thread workspace preparation failed: FORBIDDEN /);
    await expect(threadApi(handler).listProjectModels!()).rejects.toThrow(/^project model list failed: FORBIDDEN /);
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
      includeActionPolicy: true, includeSharedTask: true, includeOpenTaskCount: true,
    }]);
    expect(result).toMatchObject({ outcome: "WORKSPACE", status: "UNPREPARED", operationId: null, created: true });
    expect(db.find((item) => item.entityType === "OPERATION")).toHaveLength(0);
  });

  it("lists and selects the bound project's coding model through signed service routes", async () => {
    const { handler } = createBroker();
    await registerSlackProject(handler, { models: {
      default: { provider: "amazon-bedrock", modelId: "balanced", label: "Balanced" },
      approved: [
        { provider: "amazon-bedrock", modelId: "balanced", label: "Balanced" },
        { provider: "amazon-bedrock", modelId: "fast", label: "Fast" },
      ],
    } });
    const api = threadApi(handler);
    await expect(api.listProjectModels!()).resolves.toMatchObject({ source: "default", current: { label: "Balanced" } });
    await expect(api.selectProjectModel!({ provider: "amazon-bedrock", modelId: "fast" })).resolves.toMatchObject({ source: "selection", current: { label: "Fast" } });
  });

  // Issue 167: the turn that gave up for good cancels its task through the existing cancel route.
  describe("cancelling a thread's task", () => {
    async function runningTask() {
      const broker = createBroker();
      await registerSlackProject(broker.handler);
      const workspaceId = (await ensureWorkspace(broker.handler, thread, pratik)).body.workspaceId as string;
      markReady(broker.db, workspaceId);
      const conversation = await serviceCall(broker.handler, thread, pratik, "POST", `/v1/service/workspaces/${workspaceId}/conversations`);
      const task = await serviceCall(broker.handler, thread, pratik, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, {
        requestId: randomUUID(), conversationId: (conversation.body.conversation as { id: string }).id, prompt: "run the tests",
      });
      expect(task.status).toBe(202);
      return { ...broker, workspaceId, operationId: (task.body.operation as { id: string }).id };
    }

    it("asks the worker to cancel the running task through the operation cancel route", async () => {
      const { db, handler, workspaceId, operationId } = await runningTask();
      const paths: string[] = [];
      const toBroker = brokerFetch(handler);
      const signedFetch = createSignedServiceFetch({
        region: "us-east-1", credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" },
        thread: parseSlackThreadSubject(thread), userId: pratik,
        baseFetch: async (input, init) => {
          paths.push(`${init?.method ?? "GET"} ${new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname}`);
          return toBroker(input, init);
        },
      });
      expect(await createThreadApi({ controlPlaneUrl: "https://agentx.example.test", signedFetch }).cancelOperation!(workspaceId, operationId))
        .toEqual({ outcome: "requested" });
      expect(paths).toEqual([`POST /v1/service/workspaces/${workspaceId}/operations/${operationId}/cancel`]);
      expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`)).toMatchObject({ status: "CANCEL_REQUESTED" });
      const cancel = db.find((item) => item.entityType === "OUTBOX" && (item.invocation as { kind?: string } | undefined)?.kind === "cancel")[0];
      expect(cancel?.invocation).toMatchObject({ kind: "cancel", payload: { targetOperationId: operationId } });
    });

    it("answers a task that already finished as finished, with its status, and queues no cancel", async () => {
      const { db, handler, workspaceId, operationId } = await runningTask();
      await finishOperation(handler, db, workspaceId, operationId, "SUCCEEDED");
      expect(await threadApi(handler).cancelOperation!(workspaceId, operationId)).toEqual({ outcome: "finished", status: "SUCCEEDED" });
      expect(db.find((item) => item.entityType === "OUTBOX" && (item.invocation as { kind?: string } | undefined)?.kind === "cancel")).toHaveLength(0);
    });

    it("counts a queued cancel as requested without reading the rest of the broker's answer", async () => {
      const signedFetch: typeof fetch = async () => new Response(JSON.stringify({ operation: { id: randomUUID() }, duplicate: false }), { status: 202 });
      const api = createThreadApi({ controlPlaneUrl: "https://agentx.example.test", signedFetch });
      expect(await api.cancelOperation!(randomUUID(), randomUUID())).toEqual({ outcome: "requested" });
    });

    it("throws the broker's refusal, so the caller can log it", async () => {
      const { handler, workspaceId } = await runningTask();
      await expect(threadApi(handler).cancelOperation!(workspaceId, randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });
});
