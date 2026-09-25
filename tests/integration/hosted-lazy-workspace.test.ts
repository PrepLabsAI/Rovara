// tests/integration/hosted-lazy-workspace.test.ts
// The Slack processor, its real control-plane client and real tools against the real broker.
import { beforeAll, describe, expect, it } from "vitest";
import type { SlackRequestMessage } from "../../packages/contracts/src/index.js";
import { ControlPlaneApi } from "../../packages/orchestrator/src/control-plane-api.js";
import type { OrchestrationApi } from "../../packages/orchestrator/src/orchestration-tools.js";
import { LIMIT_REFUSAL, unavailableRefusal } from "../../packages/slack-service/src/lazy-worker.js";
import { processSlackRequest, type ThreadState, type ThreadStore } from "../../packages/slack-service/src/processor.js";
import { createHostedSlackRuntime } from "../../packages/slack-service/src/runtime.js";
import { createSignedServiceFetch } from "../../packages/slack-service/src/signing-fetch.js";
import { createThreadApi } from "../../packages/slack-service/src/thread-api.js";
import { createFixtureDirectory } from "../fixtures/index.js";
import { brokerFetch } from "../support/broker-fetch.js";
import {
  GITHUB_LIST_ISSUES, SLACK_CHANNEL, SLACK_TEAM, createBroker, fakeGitHubMcp, finishOperation, loadSlackBroker, registerSlackProject,
} from "../support/slack-broker.js";

const CONTROL_PLANE = "https://agentx.example.test";
const pratik = "U0123456789";
const WORKING = "Working on it now. I'll post the result in this thread when it's done.";
const SETTING_UP = "Setting up a new workspace for this thread. The first request takes a few minutes.";
const STILL = "This thread's workspace is still being set up. I'll start as soon as it's ready.";
const CONNECTOR_ANSWER = "2 issues are open.";
const CODING_ANSWER = "2 issues are open, and the coding request is handled above.";
let events = 0;

beforeAll(async () => {
  await loadSlackBroker();
});

const threadTs = (n: number) => `1695500000.${String(n).padStart(6, "0")}`;
const subject = (n: number) => `${SLACK_TEAM}/${SLACK_CHANNEL}/${threadTs(n)}`;

function memoryThreads(): ThreadStore {
  const states = new Map<string, ThreadState>();
  return {
    load: async (key) => ({ ...(states.get(key) ?? {}) }),
    saveConversation: async (key, state) => {
      states.set(key, { ...states.get(key), ...state });
    },
    saveSettingsRevision: async (key, revision) => {
      states.set(key, { ...states.get(key), settingsRevision: revision });
    },
    close: async (key, state) => {
      states.set(key, { workspaceId: state.workspaceId, closedAt: state.closedAt });
    },
    finish: async () => undefined,
  };
}

function scenario(options: { memberLimit?: number } = {}) {
  const { githubMcp, invoke } = fakeGitHubMcp();
  const broker = createBroker({ githubMcp, ...(options.memberLimit === undefined ? {} : { memberLimit: options.memberLimit }) });
  return {
    ...broker, invoke, threads: memoryThreads(), prepareOutcome: "SUCCEEDED" as "SUCCEEDED" | "FAILED",
    posts: [] as Array<{ threadTs: string; text: string }>, toolResults: [] as string[],
  };
}
type Scenario = ReturnType<typeof scenario>;

function textOf(result: { content: unknown[] }): string {
  return (result.content[0] as { text: string }).text;
}

function postsIn(s: Scenario, n: number): string[] {
  return s.posts.filter((entry) => entry.threadTs === threadTs(n)).map((entry) => entry.text);
}

async function turnIn(s: Scenario, n: number, text: string, work: { coding: boolean }): Promise<void> {
  events += 1;
  const message: SlackRequestMessage = {
    version: 1, eventId: `EvLAZY${String(events).padStart(6, "0")}`, receivedAt: new Date().toISOString(), userId: pratik,
    thread: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: threadTs(n) }, text,
  };
  const signedFetch = createSignedServiceFetch({
    region: "us-east-1", credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" },
    thread: message.thread, userId: message.userId, baseFetch: brokerFetch(s.handler),
  });
  await processSlackRequest(message, {
    api: () => ({
      ...createThreadApi({ controlPlaneUrl: CONTROL_PLANE, signedFetch }),
      // The fake table has no BETWEEN key condition for event pages, so wait by reading the operation alone.
      waitForOperation: async (workspaceId: string, operationId: string) => {
        const operation = await new ControlPlaneApi(CONTROL_PLANE, "slack-service", workspaceId, signedFetch).getOperation(operationId);
        return { status: operation.status, ...(operation.error === undefined ? {} : { error: operation.error }) };
      },
    }),
    threads: s.threads,
    runTurn: async (input) => {
      const base = new ControlPlaneApi(CONTROL_PLANE, "slack-service", input.workspaceId, signedFetch);
      const api: OrchestrationApi = {
        discoverConnectorTools: (request) => base.discoverConnectorTools(request),
        callConnectorTool: (request) => base.callConnectorTool(request),
        submitTask: (request) => base.submitTask(request),
        taskStatus: (request) => base.taskStatus(request),
        // No worker runs in this test: report the accepted task instead of waiting for it.
        taskResult: async (request) => ({ operationId: request.operationId, status: "ACCEPTED" }),
        followUp: (request) => base.followUp(request),
        createPullRequest: (request) => base.createPullRequest(request),
        managePullRequest: (request) => base.managePullRequest(request),
        pullRequestResult: (request, options) => base.pullRequestResult(request, options),
      };
      const runtime = await createHostedSlackRuntime(input, {
        stateDirectory: await createFixtureDirectory("agentx-hosted-lazy-"), api, model: { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0" },
      });
      try {
        const listed = await runtime.session.getToolDefinition("github__list_issues")!.execute(`list-${message.eventId}`, {}, undefined, undefined, {} as never);
        s.toolResults.push(textOf(listed));
        if (!work.coding) return CONNECTOR_ANSWER;
        const submitted = await runtime.session.getToolDefinition("agentx_submit_task")!
          .execute(`submit-${message.eventId}`, { prompt: "List the files in the repository." }, undefined, undefined, {} as never);
        s.toolResults.push(textOf(submitted));
        return CODING_ANSWER;
      } finally {
        await runtime.dispose();
      }
    },
    post: async (_thread, posted) => {
      s.posts.push({ threadTs: message.thread.threadTs, text: posted });
      // Plays the worker: a preparation the thread was just told about finishes now.
      if (posted === SETTING_UP || posted === STILL) {
        const pending = s.db.find((item) => item.entityType === "OPERATION" && item.kind === "prepare" && item.status === "ACCEPTED");
        for (const operation of pending) await finishOperation(s.handler, s.db, operation.workspaceId as string, operation.id as string, s.prepareOutcome);
      }
    },
  }, { finalAttempt: false });
}

describe("workspace only when needed, end to end", () => {
  it("answers connector questions in four new threads without a workspace, then prepares only the thread that needs the worker", async () => {
    const s = scenario();
    await registerSlackProject(s.handler, { connectors: GITHUB_LIST_ISSUES });
    for (const n of [1, 2, 3, 4]) await turnIn(s, n, "what's open in GitHub issues?", { coding: false });
    for (const n of [1, 2, 3, 4]) expect(postsIn(s, n)).toEqual([WORKING, CONNECTOR_ANSWER]);
    expect(s.invoke).toHaveBeenCalledTimes(4);
    expect(s.db.find((item) => item.entityType === "SLACK_LIMIT")).toHaveLength(0);
    expect(s.db.find((item) => item.entityType === "OPERATION")).toHaveLength(0);

    await turnIn(s, 1, "list the files in the repository", { coding: true });
    expect(postsIn(s, 1).slice(-3)).toEqual([WORKING, SETTING_UP, CODING_ANSWER]);
    expect(s.db.find((item) => item.entityType === "OPERATION" && item.kind === "prepare")).toHaveLength(1);
    expect(s.db.find((item) => item.entityType === "OPERATION" && item.kind === "task")).toHaveLength(1);
    expect(s.db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${pratik}`)).toMatchObject({ count: 1, threads: [subject(1)] });
    expect(s.toolResults.at(-1)).toContain("\"status\":\"ACCEPTED\"");
  });

  it("still answers the connector part when the member's limit stops preparation", async () => {
    const s = scenario({ memberLimit: 1 });
    await registerSlackProject(s.handler, { connectors: GITHUB_LIST_ISSUES });
    await turnIn(s, 1, "list the files in the repository", { coding: true });
    await turnIn(s, 2, "what's open, and list the files", { coding: true });
    expect(postsIn(s, 2)).toEqual([
      WORKING,
      [
        "You already have 1 AgentX workspaces, the most one person can have, so I can't start a new one. Continue in one of your existing threads instead:",
        `• <https://slack.com/archives/${SLACK_CHANNEL}/p${threadTs(1).replace(".", "")}|Thread 1>`,
      ].join("\n"),
      CODING_ANSWER,
    ]);
    expect(s.toolResults.at(-2)).toContain("SUCCEEDED");
    expect(s.toolResults.at(-1)).toBe(JSON.stringify(LIMIT_REFUSAL));
    expect(s.db.find((item) => item.entityType === "OPERATION" && item.kind === "task")).toHaveLength(1);
    expect(s.db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${pratik}`)).toMatchObject({ count: 1 });
    const threadTwo = s.db.find((item) => item.entityType === "SLACK_THREAD" && item.thread === subject(2))[0];
    expect(s.db.get(`WORKSPACE#${String(threadTwo?.workspaceId)}`, "META")).toMatchObject({ status: "UNPREPARED" });
  });

  it("fails only the worker part when preparation fails mid-turn, and retries it as today on the next message", async () => {
    const s = scenario();
    await registerSlackProject(s.handler, { connectors: GITHUB_LIST_ISSUES });
    s.prepareOutcome = "FAILED";
    await turnIn(s, 1, "list the files in the repository", { coding: true });
    expect(postsIn(s, 1)).toEqual([
      WORKING, SETTING_UP, "AgentX could not set up this thread's workspace (FAILED). Mention me again in this thread to retry.", CODING_ANSWER,
    ]);
    expect(s.toolResults.at(-1)).toBe(JSON.stringify(unavailableRefusal("workspace setup failed")));
    expect(s.db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${pratik}`)).toMatchObject({ count: 1 });

    s.prepareOutcome = "SUCCEEDED";
    await turnIn(s, 1, "what's open?", { coding: false });
    expect(postsIn(s, 1).slice(-3)).toEqual([STILL, WORKING, CONNECTOR_ANSWER]);
    expect(s.db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${pratik}`)).toMatchObject({ count: 1 });
  });

  it("tells a connector-only thread there is nothing to close, and keeps answering in it", async () => {
    const s = scenario();
    await registerSlackProject(s.handler, { connectors: GITHUB_LIST_ISSUES });
    await turnIn(s, 1, "what's open?", { coding: false });
    await turnIn(s, 1, "<@U0AGENTX01> close this workspace", { coding: false });
    expect(postsIn(s, 1).at(-1)).toBe("This thread does not have a workspace to close.");
    expect(s.deleteWorkspaceSession).not.toHaveBeenCalled();
    await turnIn(s, 1, "what's open now?", { coding: false });
    expect(postsIn(s, 1).at(-1)).toBe(CONNECTOR_ANSWER);
    expect(s.db.find((item) => item.entityType === "WORKSPACE")[0]).toMatchObject({ status: "UNPREPARED" });
    expect(s.db.find((item) => item.entityType === "SLACK_LIMIT")).toHaveLength(0);
  });
});
