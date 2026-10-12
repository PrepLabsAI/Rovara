// Sign in with ChatGPT's admin switch and preferred model (#343): off until an admin turns it on
// through the admin change path; off, nobody connects and every task runs on the default model.
import { describe, expect, it, vi } from "vitest";
import { runConfigSet, type ConfigServices } from "../../packages/cli/src/config/commands.js";
import { chatGptConnections, type ChatGptConnections, type ChatGptSealer } from "../../packages/broker/src/chatgpt/connections.js";
import { CHATGPT_SETTINGS_KEY, readChatGptSettings } from "../../packages/broker/src/chatgpt/settings.js";
import { chatGptTaskSelection } from "../../packages/broker/src/chatgpt/task-model.js";
import { createAdminChangeBroker } from "../support/admin-change-broker.js";
import { configServicesFor } from "../support/config-services.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

function brokerFetch(harness: Awaited<ReturnType<typeof createAdminChangeBroker>>): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const answer = await harness.admin(init?.method ?? "GET", `${url.pathname}${url.search}`, { ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}) });
    return Response.json(answer.body, { status: answer.status });
  };
}

async function configFor(harness: Awaited<ReturnType<typeof createAdminChangeBroker>>, answer: boolean) {
  const asked: string[] = [];
  const services: ConfigServices = await configServicesFor({
    adminSession: async () => ({ controlPlaneUrl: "https://abc123.execute-api.us-east-1.amazonaws.com", accessToken: "admin-token-for-tests" }),
    fetch: brokerFetch(harness),
    prompter: { confirm: async (question: string) => { asked.push(question); return answer; } } as never,
  });
  return { services, asked };
}

describe("rovara config set models.chatgpt.* (#343)", () => {
  it("is off until an admin turns it on, with the effect shown first and an audit record", async () => {
    const harness = await createAdminChangeBroker();
    const table = { documentClient: harness.db, tableName: "state" };
    expect(await readChatGptSettings(table)).toEqual({ enabled: false, preferredModel: "gpt-6.1-sol" });
    const { services, asked } = await configFor(harness, true);
    expect(await runConfigSet(services, "staging", { key: "models.chatgpt.enabled", value: "true", yes: false })).toEqual({ changed: true });
    expect(asked[0]).toContain("Turn Sign in with ChatGPT on: people can connect their own ChatGPT Plus or Pro plan");
    expect(asked[0]).toContain("Tasks prefer gpt-6.1-sol where a person's plan allows it.");
    expect(harness.db.get(CHATGPT_SETTINGS_KEY.pk, CHATGPT_SETTINGS_KEY.sk)).toMatchObject({ enabled: true, preferredModel: "gpt-6.1-sol", via: "cli" });
    expect(harness.db.find((item) => item.entityType === "ADMIN_CHANGE_AUDIT")[0]).toMatchObject({ kind: "set_chatgpt", methodUsed: "cli", outcome: "confirmed" });

    // The preferred model changes on its own, keeping the switch as it is.
    expect(await runConfigSet(services, "staging", { key: "models.chatgpt.preferredModel", value: "gpt-5.5", yes: true })).toEqual({ changed: true });
    expect(await readChatGptSettings(table)).toEqual({ enabled: true, preferredModel: "gpt-5.5" });

    expect(await runConfigSet(services, "staging", { key: "models.chatgpt.enabled", value: "false", yes: true })).toEqual({ changed: true });
    expect(await readChatGptSettings(table)).toEqual({ enabled: false, preferredModel: "gpt-5.5" });
  });

  it("changes nothing when the admin says no", async () => {
    const harness = await createAdminChangeBroker();
    const { services, asked } = await configFor(harness, false);
    expect(await runConfigSet(services, "staging", { key: "models.chatgpt.enabled", value: "true", yes: false })).toEqual({ changed: false });
    expect(asked[0]).toContain("Turn Sign in with ChatGPT on");
    expect(harness.db.get(CHATGPT_SETTINGS_KEY.pk, CHATGPT_SETTINGS_KEY.sk)).toBeUndefined();
  });

  it("refuses a value that is not one before anything is asked", async () => {
    const harness = await createAdminChangeBroker();
    const { services, asked } = await configFor(harness, true);
    await expect(runConfigSet(services, "staging", { key: "models.chatgpt.enabled", value: "maybe", yes: false })).rejects.toThrow("models.chatgpt.enabled must be one of true, false; nothing changed");
    await expect(runConfigSet(services, "staging", { key: "models.chatgpt.preferredModel", value: "not a model", yes: false })).rejects.toThrow("must be a model ID such as gpt-6.1-sol");
    expect(asked).toEqual([]);
  });
});

const SEALER: ChatGptSealer = { seal: async (plaintext) => `sealed:${plaintext}`, open: async (sealed) => sealed.slice("sealed:".length) };

describe("Sign in with ChatGPT while the switch is off (#343)", () => {
  it("refuses to connect, with how to turn it on, and keeps an existing connection to show and remove", async () => {
    const db = new FakeDynamoDb();
    const connections = chatGptConnections({ documentClient: db, tableName: "state", sealer: SEALER, fetch: vi.fn(), now: () => Date.now(), hostId: "urn:uuid:00000000-0000-4000-8000-000000000000" });
    await expect(connections.start("dev-1")).rejects.toThrow("FORBIDDEN: Sign in with ChatGPT is turned off in this Rovara; ask an admin to turn it on with: rovara config set models.chatgpt.enabled true");
    await expect(connections.finish("dev-1", { code: "c", state: "s", clientId: "oaiapp_x" })).rejects.toThrow("Sign in with ChatGPT is turned off");
    db.set({ pk: "CHATGPT#dev-1", sk: "CONNECTION", developerId: "dev-1", clientId: "oaiapp_x", sealedRefresh: "sealed:r", sealedAccess: "sealed:a", accessExpiresAt: 0, connectedAt: "2026-10-11T12:00:00.000Z", models: ["gpt-6.1-sol"], status: "connected", version: 1 });
    expect(await connections.view("dev-1")).toMatchObject({ connected: true });
    expect(await connections.disconnect("dev-1")).toEqual({ connected: false });
  });

  it("runs every task on the default, and uses the preferred model when it is on and the plan allows it", async () => {
    const view = vi.fn(async () => ({ connected: true, status: "connected" as const, models: ["gpt-5.5", "gpt-6.1-sol"] }));
    const service = (settings: { enabled: boolean; preferredModel: string }) => ({ settings: async () => settings, view }) as unknown as ChatGptConnections;
    expect(await chatGptTaskSelection(service({ enabled: false, preferredModel: "gpt-6.1-sol" }), "dev-1")).toBeUndefined();
    expect(view).not.toHaveBeenCalled();
    expect(await chatGptTaskSelection(service({ enabled: true, preferredModel: "gpt-5.5" }), "dev-1")).toEqual({ developerId: "dev-1", model: { provider: "openai", modelId: "gpt-5.5" } });
    expect(await chatGptTaskSelection(service({ enabled: true, preferredModel: "gpt-6-luna" }), "dev-1")).toEqual({ developerId: "dev-1", model: { provider: "openai", modelId: "gpt-6.1-sol" } });
  });
});
