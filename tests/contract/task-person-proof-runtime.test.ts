import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDispatchProofRequest } from "@agentx/contracts";

const runtimeModulePath: string = "../../../packages/broker/src/aws/task-person-proof-runtime.js";
type RuntimeModule = {
  handler(event: unknown, context: { getRemainingTimeInMillis(): number }): Promise<unknown>;
};
const loadRuntime = async (): Promise<RuntimeModule | undefined> => {
  try {
    return await import(runtimeModulePath) as RuntimeModule;
  } catch {
    return undefined;
  }
};

const TEAM = "T0BSHLLUGBD";
const USER = "U12345678";
const CHANNEL = "C12345678";
const SECRET_ARN = "arn:aws:secretsmanager:us-east-1:944937319445:secret:agentx/agentxlivetest123/slack-z7WaUV";
const request = (id: string): TaskDispatchProofRequest => ({
  kind: "task-dispatch-person-proof",
  request: { kind: "task-person-proof", slackUserId: USER, channelIds: [CHANNEL] },
  admission: { version: 1, id, deadlineAt: 1_700_000_006_000, remainingMs: 6_000, slackCallsLimit: 10 },
});
const context = { getRemainingTimeInMillis: () => 7_000 };

function slackReply(url: URL): Response {
  if (url.pathname.endsWith("users.info")) {
    return new Response(JSON.stringify({ ok: true, user: {
      id: USER, team_id: TEAM, deleted: false, is_bot: false, is_stranger: false,
      profile: { display_name: "Maya Chen" },
    } }), { status: 200 });
  }
  return new Response(JSON.stringify({ ok: true, members: [USER], response_metadata: { next_cursor: "" } }), { status: 200 });
}

describe("the dedicated Task Person proof Lambda entrypoint", () => {
  beforeEach(() => {
    vi.stubEnv("AGENTX_ENV", "agentxlivetest123");
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("SLACK_TEAM_ID", TEAM);
    vi.stubEnv("SLACK_SECRET_ARN", SECRET_ARN);
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("exports the actual dedicated handler", async () => {
    expect(await loadRuntime()).toBeDefined();
  });

  it("uses one fresh exact-secret read and the bounded Slack proof for each invocation", async () => {
    const runtime = await loadRuntime();
    expect(runtime).toBeDefined();
    const secretReads: Array<{ command: unknown; signal: AbortSignal | undefined }> = [];
    const clientRetries: number[] = [];
    const secretSend = vi.spyOn(SecretsManagerClient.prototype, "send").mockImplementation((async function (this: SecretsManagerClient, command: unknown, options?: { abortSignal?: AbortSignal }) {
      clientRetries.push(await this.config.maxAttempts());
      secretReads.push({ command, signal: options?.abortSignal });
      return { SecretString: JSON.stringify({ botToken: "xoxb-test-token", OAuthAccessToken: "xoxp-not-used" }) };
    }) as never);
    const slackCalls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      slackCalls.push(url.href);
      return slackReply(url);
    });

    const first = await runtime!.handler(request("3b19f06a-6d14-4ef6-94b7-62cbcc3a8661"), context) as {
      admissionId: string; usage: { slackCallsUsed: number }; result: { ok: boolean; memberOf?: string[] };
    };
    const second = await runtime!.handler(request("9c1899f2-ef3c-4d89-9a71-785681d497c2"), context) as typeof first;

    expect(first).toMatchObject({ admissionId: "3b19f06a-6d14-4ef6-94b7-62cbcc3a8661", usage: { slackCallsUsed: 2 }, result: { ok: true, memberOf: [CHANNEL] } });
    expect(second.admissionId).toBe("9c1899f2-ef3c-4d89-9a71-785681d497c2");
    expect(secretSend).toHaveBeenCalledTimes(2);
    expect(clientRetries).toEqual([1, 1]);
    expect(secretReads.every(({ command }) => command instanceof GetSecretValueCommand && command.input.SecretId === SECRET_ARN)).toBe(true);
    expect(secretReads.every(({ signal }) => signal instanceof AbortSignal)).toBe(true);
    expect(slackCalls.map((url) => new URL(url).pathname)).toEqual([
      "/api/users.info", "/api/conversations.members", "/api/users.info", "/api/conversations.members",
    ]);
    expect(JSON.stringify(first)).not.toContain("xoxb-test-token");
    expect(JSON.stringify(first)).not.toContain("xoxp-not-used");
  });

  it("fails closed before secret or Slack issuance when the named environment is absent", async () => {
    const runtime = await loadRuntime();
    expect(runtime).toBeDefined();
    vi.stubEnv("AGENTX_ENV", "staging");
    const secretSend = vi.spyOn(SecretsManagerClient.prototype, "send").mockRejectedValue(new Error("must not read"));
    const slackFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", slackFetch);

    await expect(runtime!.handler(request("6a65246d-b20c-4c69-a1f0-ed9d834221f7"), context)).rejects.toThrow("unavailable");

    expect(secretSend).not.toHaveBeenCalled();
    expect(slackFetch).not.toHaveBeenCalled();
  });

  it("fails closed before issuance when the configured team is invalid", async () => {
    const runtime = await loadRuntime();
    expect(runtime).toBeDefined();
    vi.stubEnv("SLACK_TEAM_ID", "not-a-team");
    const secretSend = vi.spyOn(SecretsManagerClient.prototype, "send").mockRejectedValue(new Error("must not read"));
    const slackFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", slackFetch);

    await expect(runtime!.handler(request("fe4e99ef-15a5-45be-a60f-f204b72bb970"), context)).rejects.toThrow("unavailable");

    expect(secretSend).not.toHaveBeenCalled();
    expect(slackFetch).not.toHaveBeenCalled();
  });

  it("does not issue a secret read when Lambda has no proof deadline reserve", async () => {
    const runtime = await loadRuntime();
    expect(runtime).toBeDefined();
    const secretSend = vi.spyOn(SecretsManagerClient.prototype, "send").mockRejectedValue(new Error("must not read"));
    const slackFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", slackFetch);

    await expect(runtime!.handler(request("b1166ae6-7260-41c3-a63f-5b0748af5e87"), { getRemainingTimeInMillis: () => 200 })).rejects.toThrow("unavailable");

    expect(secretSend).not.toHaveBeenCalled();
    expect(slackFetch).not.toHaveBeenCalled();
  });

  it("does not issue a secret read when the admission deadline has expired", async () => {
    const runtime = await loadRuntime();
    expect(runtime).toBeDefined();
    const secretSend = vi.spyOn(SecretsManagerClient.prototype, "send").mockRejectedValue(new Error("must not read"));
    const slackFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", slackFetch);
    const expired = request("9a230cb8-c6ad-428b-a578-1d8369ee869c");
    expired.admission.deadlineAt = 1_700_000_000_000;

    await expect(runtime!.handler(expired, context)).rejects.toThrow("unavailable");

    expect(secretSend).not.toHaveBeenCalled();
    expect(slackFetch).not.toHaveBeenCalled();
  });

  it("preserves zero-call UNKNOWN when the Slack call allowance ends after users.info", async () => {
    const runtime = await loadRuntime();
    expect(runtime).toBeDefined();
    const secretSend = vi.spyOn(SecretsManagerClient.prototype, "send").mockResolvedValue({ SecretString: JSON.stringify({ botToken: "xoxb-test-token" }) } as never);
    const slackCalls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      slackCalls.push(url.href);
      return slackReply(url);
    });
    const bounded = request("767e2f02-53e7-4b40-a58b-35bb8b026958");
    bounded.admission.slackCallsLimit = 1;

    const response = await runtime!.handler(bounded, context) as { result: { ok: boolean; error?: string }; usage: { slackCallsUsed: number } };

    expect(secretSend).toHaveBeenCalledTimes(1);
    expect(slackCalls.map((url) => new URL(url).pathname)).toEqual(["/api/users.info"]);
    expect(response).toMatchObject({ result: { ok: false, error: "slack_unavailable" }, usage: { slackCallsUsed: 1 } });
  });

  it("does not call Slack when the one-shot secret response is malformed", async () => {
    const runtime = await loadRuntime();
    expect(runtime).toBeDefined();
    const secretSend = vi.spyOn(SecretsManagerClient.prototype, "send").mockResolvedValue({ SecretString: "not-json" } as never);
    const slackFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", slackFetch);

    const response = await runtime!.handler(request("b414ff95-0823-47f2-8c5a-c124f7d94038"), context);

    expect(secretSend).toHaveBeenCalledTimes(1);
    expect(slackFetch).not.toHaveBeenCalled();
    expect(response).toMatchObject({ result: { ok: false, error: "slack_unavailable" }, usage: { slackCallsUsed: 0 } });
    expect(JSON.stringify(response)).not.toContain("not-json");
  });

  it("does not call Slack when the secret has no valid bot token", async () => {
    const runtime = await loadRuntime();
    expect(runtime).toBeDefined();
    const secretSend = vi.spyOn(SecretsManagerClient.prototype, "send").mockResolvedValue({ SecretString: JSON.stringify({ botToken: "xoxp-user-token" }) } as never);
    const slackFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", slackFetch);

    const response = await runtime!.handler(request("068f2e11-2e1c-48eb-bd6d-ff856dff98de"), context) as { result: { ok: boolean; error?: string }; usage: { slackCallsUsed: number } };

    expect(secretSend).toHaveBeenCalledTimes(1);
    expect(slackFetch).not.toHaveBeenCalled();
    expect(response).toMatchObject({ result: { ok: false, error: "slack_unavailable" }, usage: { slackCallsUsed: 0 } });
  });

  it("maps denied or missing secret reads to UNKNOWN without Slack calls", async () => {
    const runtime = await loadRuntime();
    expect(runtime).toBeDefined();
    const secretSend = vi.spyOn(SecretsManagerClient.prototype, "send").mockRejectedValue(Object.assign(new Error("secret denied"), { name: "AccessDeniedException" }));
    const slackFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", slackFetch);

    const response = await runtime!.handler(request("620503f7-b8f8-4691-9fa7-7fcb2179e4f0"), context) as { result: { ok: boolean; error?: string }; usage: { slackCallsUsed: number } };

    expect(secretSend).toHaveBeenCalledTimes(1);
    expect(slackFetch).not.toHaveBeenCalled();
    expect(response).toMatchObject({ result: { ok: false, error: "slack_unavailable" }, usage: { slackCallsUsed: 0 } });
    expect(JSON.stringify(response)).not.toContain("secret denied");
  });

  it("returns fresh proof with empty membership when the person is outside the requested channel", async () => {
    const runtime = await loadRuntime();
    expect(runtime).toBeDefined();
    vi.spyOn(SecretsManagerClient.prototype, "send").mockResolvedValue({ SecretString: JSON.stringify({ botToken: "xoxb-test-token" }) } as never);
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith("users.info")) return slackReply(url);
      return new Response(JSON.stringify({ ok: true, members: [], response_metadata: { next_cursor: "" } }), { status: 200 });
    });

    const response = await runtime!.handler(request("a67956cb-8773-43e7-8cb5-6863bd9f9f65"), context) as { result: { ok: boolean; memberOf?: string[] }; usage: { slackCallsUsed: number } };

    expect(response).toMatchObject({ result: { ok: true, memberOf: [] }, usage: { slackCallsUsed: 2 } });
  });

  it.each([
    { label: "deleted", user: { id: USER, team_id: TEAM, deleted: true, is_bot: false, is_stranger: false } },
    { label: "foreign-team", user: { id: USER, team_id: "TOTHER123", deleted: false, is_bot: false, is_stranger: false } },
    { label: "bot", user: { id: USER, team_id: TEAM, deleted: false, is_bot: true, is_stranger: false } },
    { label: "mismatched-user", user: { id: "U87654321", team_id: TEAM, deleted: false, is_bot: false, is_stranger: false } },
  ])("does not read membership for a $label users.info reply", async ({ user }) => {
    const runtime = await loadRuntime();
    expect(runtime).toBeDefined();
    vi.spyOn(SecretsManagerClient.prototype, "send").mockResolvedValue({ SecretString: JSON.stringify({ botToken: "xoxb-test-token" }) } as never);
    const slackCalls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      slackCalls.push(url.pathname);
      return new Response(JSON.stringify({ ok: true, user }), { status: 200 });
    });

    const response = await runtime!.handler(request("78165c03-5936-4da2-9a74-1c5570db488a"), context) as { result: { ok: boolean; error?: string }; usage: { slackCallsUsed: number } };

    expect(slackCalls).toEqual(["/api/users.info"]);
    expect(response.usage.slackCallsUsed).toBe(1);
    expect(response.result.ok).toBe(false);
  });

  it("refuses a secret result that resolves after the effective proof deadline", async () => {
    const runtime = await loadRuntime();
    expect(runtime).toBeDefined();
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const secretSend = vi.spyOn(SecretsManagerClient.prototype, "send").mockImplementation((async () => {
      now += 6_000;
      return { SecretString: JSON.stringify({ botToken: "xoxb-late-token" }) };
    }) as never);
    const slackFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", slackFetch);

    await expect(runtime!.handler(request("facf278f-036a-4c90-996a-523e3e9c71d0"), context)).rejects.toThrow("unavailable");

    expect(secretSend).toHaveBeenCalledTimes(1);
    expect(slackFetch).not.toHaveBeenCalled();
  });
});
