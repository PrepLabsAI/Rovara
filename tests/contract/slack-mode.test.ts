import { randomUUID } from "node:crypto";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ProjectDefinition } from "@agentx/contracts";
import { tokenStoreKey } from "../../packages/cli/src/auth.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemorySecretStore } from "../../packages/cli/src/secret-store.js";
import {
  loadSlackProjectConfiguration,
  saveSlackProjectConfiguration,
  validateSlackProjectConfiguration,
  type SlackProjectConfiguration,
} from "../../packages/cli/src/slack-config.js";
import { lastAssistantText } from "../../packages/cli/src/orchestrator.js";
import {
  SlackProjectBridge,
  formatSlackLogEntry,
  removeBotMention,
  splitSlackMessage,
  type SlackMention,
  type SlackTransport,
} from "../../packages/cli/src/slack.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

describe("Slack project configuration", () => {
  it("persists a project-scoped channel binding without credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentx-slack-"));
    const configuration = projectConfiguration();
    await saveSlackProjectConfiguration(directory, configuration);

    await expect(loadSlackProjectConfiguration(directory, "project-a")).resolves.toEqual(configuration);
    const metadata = await stat(join(directory, "project-a", "slack.json"));
    expect(metadata.mode & 0o777).toBe(0o600);
  });

  it("rejects unknown fields, malformed IDs, duplicate users, and empty allowlists", () => {
    expect(() => validateSlackProjectConfiguration({ ...projectConfiguration(), token: "xoxb-secret" }))
      .toThrow(/unknown fields/u);
    expect(() => validateSlackProjectConfiguration({ ...projectConfiguration(), channelId: "agentx-project-a" }))
      .toThrow(/invalid/u);
    expect(() => validateSlackProjectConfiguration({ ...projectConfiguration(), allowedUserIds: [] }))
      .toThrow(/invalid/u);
    expect(() => validateSlackProjectConfiguration({
      ...projectConfiguration(),
      allowedUserIds: ["U0123456789", "U0123456789"],
    })).toThrow(/unique/u);
  });
});

describe("Slack local orchestration bridge", () => {
  it("accepts only allowlisted project-channel mentions and replies in the source thread", async () => {
    const transport = new FakeSlackTransport();
    const prompt = vi.fn(async () => "Remote worker finished successfully.");
    const logs: Array<{ event: string; fields?: Readonly<Record<string, string | number | boolean>> }> = [];
    const bridge = new SlackProjectBridge(projectConfiguration(), transport, { prompt }, (entry) => logs.push(entry));

    await expect(bridge.accept(mention())).resolves.toBe(true);
    await bridge.idle();

    expect(prompt).toHaveBeenCalledWith("Inspect the project and run its tests.");
    expect(transport.messages).toEqual([
      {
        channelId: "C0123456789",
        threadTimestamp: "1710000000.000100",
        text: "Accepted for project project-a. I’ll reply in this thread when it finishes.",
      },
      {
        channelId: "C0123456789",
        threadTimestamp: "1710000000.000100",
        text: "Remote worker finished successfully.",
      },
    ]);

    await expect(bridge.accept({ ...mention(), eventId: "Ev2", userId: "U9999999999" })).resolves.toBe(false);
    await expect(bridge.accept({ ...mention(), eventId: "Ev3", channelId: "C9999999999" })).resolves.toBe(false);
    await expect(bridge.accept(mention())).resolves.toBe(false);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(logs.map((entry) => entry.event)).toEqual(expect.arrayContaining([
      "mention.accepted",
      "task.started",
      "task.completed",
      "task.finished",
    ]));
    expect(logs
      .filter((entry) => entry.event === "mention.ignored")
      .map((entry) => entry.fields?.reason)).toEqual([
      "user_not_allowed",
      "channel_mismatch",
      "duplicate_event",
    ]);
    expect(JSON.stringify(logs)).not.toContain("Inspect the project and run its tests.");
  });

  it("serializes accepted work and reports failures without breaking the queue", async () => {
    const transport = new FakeSlackTransport();
    const order: string[] = [];
    const logs: Array<{ event: string; fields?: Readonly<Record<string, string | number | boolean>> }> = [];
    const first = deferred<void>();
    const prompt = vi.fn(async (text: string) => {
      order.push(`start:${text}`);
      if (text === "first") await first.promise;
      if (text === "second") throw new Error("workspace is busy");
      order.push(`end:${text}`);
      return `done:${text}`;
    });
    const bridge = new SlackProjectBridge(
      projectConfiguration(),
      transport,
      { prompt },
      (entry) => logs.push(entry),
    );

    await bridge.accept(mention({ eventId: "Ev1", text: "<@UAGENTX01> first" }));
    await bridge.accept(mention({ eventId: "Ev2", text: "<@UAGENTX01> second", messageTimestamp: "2.0" }));
    await Promise.resolve();
    expect(order).toEqual(["start:first"]);
    first.resolve();
    await bridge.idle();

    expect(order).toEqual(["start:first", "end:first", "start:second"]);
    expect(transport.messages.at(-1)?.text).toBe("AgentX could not complete the request: workspace is busy");
    const failureLog = logs.find((entry) => entry.event === "task.failed");
    expect(failureLog?.fields).toMatchObject({
      errorType: "Error",
      errorMessage: "workspace is busy",
    });
  });

  it("normalizes mentions, extracts assistant text, and bounds Slack messages", () => {
    expect(removeBotMention(" <@UAGENTX01>  do the work ", "UAGENTX01")).toBe("do the work");
    expect(lastAssistantText([
      { role: "user", content: [{ type: "text", text: "question" }] },
      { role: "assistant", content: [{ type: "text", text: "<thinking>hidden</thinking>Answer" }] },
    ])).toBe("Answer");
    expect(() => lastAssistantText([
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Your session has expired. Please reauthenticate.",
      },
    ])).toThrow("Your session has expired. Please reauthenticate.");
    const chunks = splitSlackMessage("word ".repeat(2_000));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 3_500)).toBe(true);
    expect(formatSlackLogEntry({
      level: "warn",
      event: "mention.ignored",
      fields: { reason: "channel_mismatch", channelId: "C0123456789" },
    }, new Date("2026-09-22T12:00:00.000Z"))).toBe(
      "2026-09-22T12:00:00.000Z [agentx:slack] WARN mention.ignored reason=\"channel_mismatch\" channelId=\"C0123456789\"\n",
    );
  });
});

describe("Slack CLI workflow", () => {
  it("configures, stores credentials, and starts the selected project's local orchestrator", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentx-slack-cli-"));
    const definition = projectDefinition();
    await writeFile(join(directory, "project-a.yaml"), JSON.stringify(definition), "utf8");
    const tokenStore = new InMemoryTokenStore();
    const secretStore = new InMemorySecretStore();
    const runSlack = vi.fn(async () => undefined);
    let output = "";
    const dependencies = {
      tokenStore,
      slackSecretStore: secretStore,
      runSlack,
      stdout: { write(text: string) { output += text; } },
      stderr: { write(text: string) { throw new Error(text); } },
    };

    expect(await executeCli([
      "--project", "project-a",
      "--config-dir", directory,
      "--state-dir", directory,
      "--allow-loopback",
      "slack", "configure",
      "--team", "T0BSHLLUGBD",
      "--channel", "C0123456789",
      "--allow-user", "U0123456789",
    ], dependencies)).toBe(0);

    vi.stubEnv("SLACK_APP_TOKEN", "xapp-test-app-token");
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test-bot-token");
    expect(await executeCli([
      "--project", "project-a",
      "--config-dir", directory,
      "--state-dir", directory,
      "--allow-loopback",
      "slack", "login",
    ], dependencies)).toBe(0);
    vi.unstubAllEnvs();

    await tokenStore.set(tokenStoreKey({
      issuer: definition.auth.issuer,
      clientId: definition.auth.clientId,
      audience: definition.auth.audience,
    }), { accessToken: "agentx-access", expiresAt: Date.now() + 60_000 });
    const workspaceId = randomUUID();
    const conversationId = randomUUID();
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/v1/projects/project-a/workspace") {
        return Response.json({ workspace: {
          id: workspaceId,
          projectName: "project-a",
          projectRevision: 1,
          deploymentMode: "demo-microvm",
          status: "READY",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } });
      }
      if (url.pathname.endsWith("/conversations")) {
        return Response.json({ conversation: { id: conversationId, workspaceId } });
      }
      throw new Error(`unexpected request ${url.pathname}`);
    });

    expect(await executeCli([
      "--project", "project-a",
      "--config-dir", directory,
      "--state-dir", directory,
      "--allow-loopback",
      "--orchestrator-provider", "amazon-bedrock",
      "--orchestrator-model", "amazon.nova-pro-v1:0",
      "slack", "run",
    ], { ...dependencies, fetchImplementation })).toBe(0);

    expect(runSlack).toHaveBeenCalledOnce();
    expect(runSlack.mock.calls[0]?.[0]).toMatchObject({
      configuration: projectConfiguration(),
      appToken: "xapp-test-app-token",
      botToken: "xoxb-test-bot-token",
      orchestrator: {
        context: { workspaceId, conversationId },
        model: { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0" },
      },
    });
    expect(output).not.toContain("xapp-test-app-token");
    expect(output).not.toContain("xoxb-test-bot-token");
  });
});

class FakeSlackTransport implements SlackTransport {
  readonly messages: Array<{ channelId: string; threadTimestamp: string; text: string }> = [];

  async start(): Promise<void> {}

  async postMessage(input: { channelId: string; threadTimestamp: string; text: string }): Promise<void> {
    this.messages.push(input);
  }

  async stop(): Promise<void> {}
}

function projectConfiguration(): SlackProjectConfiguration {
  return {
    schemaVersion: 1,
    projectName: "project-a",
    teamId: "T0BSHLLUGBD",
    channelId: "C0123456789",
    allowedUserIds: ["U0123456789"],
  };
}

function mention(overrides: Partial<SlackMention> = {}): SlackMention {
  return {
    eventId: "Ev1",
    teamId: "T0BSHLLUGBD",
    channelId: "C0123456789",
    userId: "U0123456789",
    text: "<@UAGENTX01> Inspect the project and run its tests.",
    messageTimestamp: "1710000000.000100",
    botUserId: "UAGENTX01",
    ...overrides,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function projectDefinition(): ProjectDefinition {
  return {
    schemaVersion: 2,
    name: "project-a",
    revision: 1,
    controlPlaneUrl: "http://127.0.0.1:8787",
    auth: {
      issuer: "https://identity.example.test",
      clientId: "agentx-client",
      audience: "agentx-api",
    },
    environment: {
      image: `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx@sha256:${"a".repeat(64)}`,
    },
    repositories: [{
      name: "project-a",
      url: "https://github.com/example/project-a.git",
      path: "repo/project-a",
      defaultBranch: "main",
      credentialRef: "github-agentx-sdlc",
    }],
    setup: [],
    readiness: [],
    orchestratorInstructions: "Delegate coding work to the remote worker.",
  };
}
