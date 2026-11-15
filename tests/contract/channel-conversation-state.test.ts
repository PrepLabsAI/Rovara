// Issue #437: an adapter reads one of its conversations' current state, signed as the other channel routes are. It
// comes from Rovara's own records, so it is true whatever events were missed or dead-lettered, and it takes only the
// fields it shows from those records.
import { describe, expect, it } from "vitest";
import {
  CONFIRMATION_TTL_MS, CONVERSATION_STATE_THREAD_ATTRIBUTES, CONVERSATION_STATE_WORKSPACE_ATTRIBUTES,
  confirmationDigest, confirmationKey, conversationOwnerIssuer, conversationSubject, generateWebhookSecret, webhookHeaders,
  type ChannelAdapterRecord, type ChannelEvent, type PendingConfirmation,
} from "@agentx/contracts";
import { createChannelEventSender } from "../../packages/broker/src/aws/channel-events.js";
import { lastEventItem, lastEventKey, readConversationState, type ConversationStateDependencies } from "../../packages/broker/src/aws/channel-conversation-state.js";
import { createChannelIngressHandler, type ChannelIngressDependencies } from "../../packages/broker/src/aws/channel-ingress.js";
import { slackThreadKey } from "../../packages/broker/src/aws/failed-preparation.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const conversation = { channel: "scheduler", tenant: "acme", space: "graph-7", thread: "task-3" };
const subject = conversationSubject(conversation);
const ownerKey = ownerKeyForSubject(conversationOwnerIssuer("scheduler"), subject);
const workspaceId = "11111111-1111-4111-8111-111111111111";
const taskId = "0f0e0d0c-0b0a-4908-8706-050403020100";
const publishId = "1f0e0d0c-0b0a-4908-8706-050403020101";
const sha = "c".repeat(40);
const report = { status: "regression", source: "project", preambleVersion: "1", preambleSha256: "a".repeat(64), checks: [], extraTry: "given", agentClaim: "failure" };
const confirmation: PendingConfirmation = {
  confirmationId: "44444444-4444-5444-8444-444444444444", requesterId: "svc",
  calls: [{ tool: "tracker__close_item", argumentsHash: "a".repeat(64), summary: "tracker__close_item: id=TRK-9", kind: "admin" }],
  postedAt: new Date(NOW - 60_000).toISOString(), expiresAt: new Date(NOW - 60_000 + CONFIRMATION_TTL_MS).toISOString(),
};

function tables() {
  const state = new FakeDynamoDb();
  const threads = new FakeDynamoDb();
  const channel = new FakeDynamoDb();
  const asked: string[][] = [];
  /** As DynamoDB with a ProjectionExpression: only the named attributes come back. */
  const only = (item: Record<string, unknown> | undefined, attributes: readonly string[]) => {
    return item === undefined ? undefined : Object.fromEntries(Object.entries(item).filter(([name]) => attributes.includes(name)));
  };
  const deps: ConversationStateDependencies = {
    getState: async (key, attributes) => { asked.push([...attributes]); return only(state.get(key.pk, key.sk), attributes); },
    queryState: async (pk, prefix, attributes) => { asked.push([...attributes]); return state.find((item) => item.pk === pk && String(item.sk).startsWith(prefix)).map((item) => only(item, attributes)!); },
    getThread: async (key) => threads.get(key.pk, key.sk),
    getChannelState: async (key) => channel.get(key.pk, key.sk),
    now: () => NOW,
  };
  return { state, threads, channel, deps, asked };
}

function seeded() {
  const t = tables();
  t.state.set({ ...slackThreadKey(ownerKey), workspaceId, thread: "never read", starterUserId: "svc" });
  t.state.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", status: "BUSY", ownerKey });
  t.state.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${taskId}`, entityType: "OPERATION", id: taskId, kind: "task", status: "SUCCEEDED", createdAt: "2026-11-11T11:00:00.000Z", updatedAt: "2026-11-11T11:20:00.000Z", prompt: "never read", result: { response: "done", checks: report } });
  t.state.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${publishId}`, entityType: "OPERATION", id: publishId, kind: "publish", status: "RUNNING", createdAt: "2026-11-11T11:30:00.000Z", updatedAt: "2026-11-11T11:31:00.000Z" });
  t.state.set({ pk: `WORKSPACE#${workspaceId}`, sk: "OPERATION#prepare", entityType: "OPERATION", id: "22222222-2222-4222-8222-222222222222", kind: "prepare", status: "SUCCEEDED", createdAt: "2026-11-11T11:40:00.000Z", updatedAt: "2026-11-11T11:41:00.000Z" });
  t.state.set({ pk: `WORKSPACE#${workspaceId}`, sk: "PULL_REQUEST#web#000000000042", entityType: "PULL_REQUEST", repository: "web", number: 42, url: "https://github.com/acme/web/pull/42", state: "open", expectedHeadCommit: sha, baseBranch: "main", createdByOperationId: publishId, body: "never read" });
  t.threads.set({ ...confirmationKey(subject), confirmationId: confirmation.confirmationId, confirmation, validUntil: Date.parse(confirmation.expiresAt) });
  t.channel.set(lastEventItem({ version: 1, id: "evt_AAAAAAAAAAAAAAAAAAAA", channel: "scheduler", conversation, createdAt: "2026-11-11T11:31:05.000Z", type: "progress", data: { text: "Publishing…" } }));
  return t;
}

describe("a conversation's state (#437)", () => {
  it("names the workspace, the current task, the pending decision, the latest checks, the pull requests and the newest event", async () => {
    const { deps } = seeded();
    expect(await readConversationState(deps, conversation)).toEqual({
      conversation,
      workspace: { state: "ready" },
      task: { taskId: publishId, kind: "publish", status: "running", startedAt: "2026-11-11T11:30:00.000Z" },
      pendingDecision: { requestId: confirmation.confirmationId, kind: "admin", expectedRevision: 1, artifactDigest: confirmationDigest(confirmation), expiresAt: confirmation.expiresAt },
      checks: { taskId, status: "failed" },
      pullRequests: [{ repository: "acme/web", number: 42, url: "https://github.com/acme/web/pull/42", state: "open", headSha: sha, baseBranch: "main", taskId: publishId }],
      lastEvent: { id: "evt_AAAAAAAAAAAAAAAAAAAA", type: "progress", createdAt: "2026-11-11T11:31:05.000Z" },
    });
  });

  it("asks the state table only for the fields it shows", async () => {
    const { deps, asked } = seeded();
    await readConversationState(deps, conversation);
    const workspaceFields = [...CONVERSATION_STATE_WORKSPACE_ATTRIBUTES];
    expect(asked).toEqual([[...CONVERSATION_STATE_THREAD_ATTRIBUTES], workspaceFields, workspaceFields, workspaceFields]);
    for (const attributes of asked) expect(attributes).not.toContain("prompt");
  });

  it("shows a finished task with when it ended, and no decision once it is answered or expired", async () => {
    const t = seeded();
    t.state.set({ ...t.state.get(`WORKSPACE#${workspaceId}`, `OPERATION#${publishId}`)!, status: "FAILED", updatedAt: "2026-11-11T11:35:00.000Z" });
    t.threads.set({ ...t.threads.get(confirmationKey(subject).pk, confirmationKey(subject).sk)!, retiredAt: new Date(NOW).toISOString() });
    const state = await readConversationState(t.deps, conversation);
    expect(state.task).toEqual({ taskId: publishId, kind: "publish", status: "failed", startedAt: "2026-11-11T11:30:00.000Z", endedAt: "2026-11-11T11:35:00.000Z" });
    expect(state.pendingDecision).toBeNull();
  });

  it("is empty for a conversation Rovara has never worked in", async () => {
    const { deps } = tables();
    expect(await readConversationState(deps, conversation)).toEqual({ conversation, workspace: null, task: null, pendingDecision: null, checks: null, pullRequests: [], lastEvent: null });
  });
});

describe("the newest event, kept by the sender (#437)", () => {
  const adapter: ChannelAdapterRecord = {
    channel: "scheduler", callbackUrl: "https://scheduler.example.com/rovara",
    capabilities: { threads: true, buttons: 3, edits: false, maxTextLength: 4096, proactive: false },
    projects: ["web"], stepUp: [], secretName: "agentx/test/channel-adapter/scheduler",
    createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", updatedBy: "admin",
  };
  it("is recorded even when the adapter never takes it, so a dead-lettered event still shows", async () => {
    const recorded: ChannelEvent[] = [];
    const send = createChannelEventSender({
      getAdapter: async () => adapter, getSecret: async () => generateWebhookSecret(), checkAddresses: async () => undefined,
      fetch: async () => new Response("down", { status: 503 }), recordLastEvent: async (event) => { recorded.push(event); }, now: () => NOW, log: () => undefined,
    });
    const event = { version: 1, id: "evt_BBBBBBBBBBBBBBBBBBBB", channel: "scheduler", conversation, createdAt: new Date(NOW).toISOString(), type: "progress", data: { text: "Still working." } };
    const answer = await send({ Records: [{ messageId: "m1", body: JSON.stringify(event), attributes: { ApproximateReceiveCount: "8", MessageGroupId: "g" } }] });
    expect(answer.batchItemFailures).toHaveLength(1);
    expect(recorded.map((entry) => entry.id)).toEqual(["evt_BBBBBBBBBBBBBBBBBBBB"]);
    expect(lastEventItem(recorded[0] as never)).toMatchObject({ ...lastEventKey(conversation), eventId: "evt_BBBBBBBBBBBBBBBBBBBB", type: "progress" });
  });
});

describe("POST /v1/channels/{channel}/conversation-state (#437)", () => {
  const secret = generateWebhookSecret();
  const adapter: ChannelAdapterRecord = {
    channel: "scheduler", callbackUrl: "https://scheduler.example.com/rovara",
    capabilities: { threads: true, buttons: 3, edits: false, maxTextLength: 4096, proactive: false },
    projects: ["web"], stepUp: [], secretName: "agentx/test/channel-adapter/scheduler",
    createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", updatedBy: "admin",
  };
  function harness() {
    const { deps: stateDeps } = seeded();
    const deps: ChannelIngressDependencies = {
      getAdapter: async (channel) => (channel === "scheduler" ? adapter : channel === "other" ? { ...adapter, channel: "other" } : undefined),
      getSecret: async () => secret,
      getBinding: async (ref) => (ref.space === conversation.space ? { ...ref, projectName: "web", updatedAt: "2026-11-01T00:00:00.000Z" } : ref.space === "elsewhere" ? { ...ref, projectName: "billing", updatedAt: "2026-11-01T00:00:00.000Z" } : undefined),
      linkedDeveloper: async () => "dev-1", issueLinkCode: async () => ({ code: "c".repeat(32), expiresAt: 0 }), linkUrl: (code) => code,
      claim: async () => true, release: async () => undefined, enqueue: async () => undefined, sendEvent: async () => undefined,
      conversationState: (ref) => readConversationState(stateDeps, ref),
      now: () => NOW, log: () => undefined,
    };
    const handler = createChannelIngressHandler(deps);
    const read = (channel: string, value: unknown, signWith = secret) => {
      const body = JSON.stringify(value);
      return handler({ rawPath: `/v1/channels/${channel}/conversation-state`, body, headers: webhookHeaders({ secret: signWith, id: "msg_1", timestamp: NOW / 1000, body }), requestContext: { http: { method: "POST" } } });
    };
    return { read };
  }
  const answer = (response: { statusCode: number; body: string }) => ({ statusCode: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> });

  it("answers the adapter's own conversation", async () => {
    const response = answer(await harness().read("scheduler", { conversation }));
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ conversation, task: { taskId: publishId, status: "running" }, lastEvent: { id: "evt_AAAAAAAAAAAAAAAAAAAA" } });
  });

  it("refuses as the other routes do: a bad signature, another adapter's conversation, a space it does not serve, an unknown channel", async () => {
    const { read } = harness();
    expect(answer(await read("scheduler", { conversation }, generateWebhookSecret())).statusCode).toBe(401);
    expect(answer(await read("other", { conversation }))).toMatchObject({ statusCode: 403, body: { error: "channel_mismatch" } });
    expect(answer(await read("scheduler", { conversation: { ...conversation, space: "elsewhere" } }))).toMatchObject({ statusCode: 403, body: { error: "space_not_bound" } });
    expect(answer(await read("scheduler", { conversation: { ...conversation, space: "unbound" } }))).toMatchObject({ statusCode: 403, body: { error: "space_not_bound" } });
    expect(answer(await read("unknown", { conversation })).statusCode).toBe(404);
    expect(answer(await read("scheduler", { conversation, extra: true })).statusCode).toBe(400);
  });
});
