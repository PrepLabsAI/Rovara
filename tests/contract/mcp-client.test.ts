// tests/contract/mcp-client.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentXError } from "@agentx/contracts";
import { NEXT_STEPS, SHARE_BUSY_STEP, TOOL_ERROR_CODES, ToolError, UNEXPECTED_ANSWER_STEP, UPGRADE_AGENTX_STEP, httpControlPlaneClient, signInStep } from "../../packages/mcp/src/index.js";

const TOKEN = "eyJhbGciOiJSUzI1NiJ9.planted-access-token.sig";
const session = async () => ({ baseUrl: "https://agentx.example.test", accessToken: TOKEN, signInCommand: "npx @preplabs/rovara-code login https://agentx.example.test" });
const view = { taskId: "44444444-4444-4444-8444-444444444444", title: "Fix", project: "payments", status: "STARTING", startingRevision: 1, client: "Claude Code", shared: false, createdAt: "t", updatedAt: "t", events: [] };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const client = (fetch: typeof globalThis.fetch, overrides: Partial<Parameters<typeof httpControlPlaneClient>[0]> = {}) =>
  httpControlPlaneClient({ session, fetch, sleep: async () => undefined, traceId: () => "trace-1", ...overrides });
const start = { requestId: "33333333-3333-4333-8333-333333333333", project: "payments", instructions: "Fix it", client: "claude-code" };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the control-plane client (FR-027)", () => {
  it("sends the token and a trace ID, and parses a response with fields it does not know", async () => {
    const fetch = vi.fn(async () => reply(200, { task: { ...view, later: true }, requestId: "r" }));
    expect((await client(fetch).startTask(start)).status).toBe("STARTING");
    const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://agentx.example.test/v1/dev/tasks");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(new Headers(init.headers).get("x-agentx-trace-id")).toBe("trace-1");
    expect(JSON.parse(init.body as string)).toEqual(start);
  });

  it("shares a task through the share route, and a busy answer says to try the share again (spec 025 C21)", async () => {
    const request = { requestId: "33333333-3333-4333-8333-333333333333", shareMode: "continue" as const, channel: "#payments-dev" };
    const fetch = vi.fn(async () => reply(200, { task: { ...view, shared: true, share: { mode: "continue", channelId: "C0123456789", sharedReason: "requested" } } }));
    expect((await client(fetch).shareTask(view.taskId, request)).share).toMatchObject({ mode: "continue" });
    const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(`https://agentx.example.test/v1/dev/tasks/${view.taskId}/share`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(request);
    const busy = vi.fn(async () => reply(409, { error: { code: "WORKSPACE_BUSY", message: "the task changed while sharing; try agentx_share_task again" } }));
    await expect(client(busy).shareTask(view.taskId, request)).rejects.toMatchObject({ code: "TASK_BUSY", nextStep: SHARE_BUSY_STEP });
  });

  it("reads the configuration without a token", async () => {
    const fetch = vi.fn(async () => reply(200, { env: "staging", apiVersion: "1.1", issuer: "x" }));
    expect(await client(fetch).configuration()).toEqual({ env: "staging", apiVersion: "1.1", baseUrl: "https://agentx.example.test" });
    const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://agentx.example.test/v1/auth/.well-known/agentx-configuration");
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });

  it("tries three times on a network error or 5xx, then answers CONTROL_PLANE_UNAVAILABLE", async () => {
    const down = vi.fn(async () => { throw new TypeError("fetch failed"); });
    await expect(client(down).getTask(view.taskId, 10)).rejects.toMatchObject({ code: "CONTROL_PLANE_UNAVAILABLE" });
    expect(down).toHaveBeenCalledTimes(3);
    const flaky = vi.fn().mockResolvedValueOnce(reply(502, {})).mockResolvedValueOnce(reply(200, { task: view }));
    expect((await client(flaky).getTask(view.taskId, 10)).taskId).toBe(view.taskId);
  });

  it("tries a start again only with the same requestId, and waits longer each time, with jitter", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const sleep = vi.fn(async () => undefined);
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(reply(503, { error: { code: "RUNTIME_UNAVAILABLE", message: "busy" } }))
      .mockResolvedValueOnce(reply(200, { task: view }));
    expect((await client(fetch, { sleep }).startTask(start)).taskId).toBe(view.taskId);
    expect(fetch).toHaveBeenCalledTimes(3);
    const bodies = fetch.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string) as { requestId: string });
    expect(bodies.map((body) => body.requestId)).toEqual([start.requestId, start.requestId, start.requestId]);
    expect(sleep.mock.calls.map((call) => (call as unknown[])[0])).toEqual([500, 750]);
  });

  it("never tries a write without a requestId twice", async () => {
    const down = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const noRequestId = { ...start, requestId: undefined } as unknown as typeof start;
    await expect(client(down).startTask(noRequestId)).rejects.toMatchObject({ code: "CONTROL_PLANE_UNAVAILABLE" });
    expect(down).toHaveBeenCalledTimes(1);
    const failing = vi.fn(async () => reply(500, {}));
    await expect(client(failing).startTask(noRequestId)).rejects.toMatchObject({ code: "CONTROL_PLANE_UNAVAILABLE" });
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("never tries a 4xx again, nor a 5xx that names what is wrong", async () => {
    const busy = vi.fn(async () => reply(409, { error: { code: "TASK_BUSY", message: "still working" } }));
    await expect(client(busy).continueTask(view.taskId, { requestId: start.requestId, instructions: "more" })).rejects.toMatchObject({ code: "TASK_BUSY" });
    expect(busy).toHaveBeenCalledTimes(1);
    const slack = vi.fn(async () => reply(503, { error: { code: "SLACK_UNAVAILABLE", message: "Slack did not answer" } }));
    await expect(client(slack).projects()).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
    expect(slack).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["PROJECT_NOT_FOUND", 404, "PROJECT_NOT_FOUND"],
    ["PROJECT_ACCESS_DENIED", 403, "PROJECT_ACCESS_DENIED"],
    ["PROJECT_TASKS_DISABLED", 403, "PROJECT_TASKS_DISABLED"],
    ["TASK_NOT_FOUND", 404, "TASK_NOT_FOUND"],
    ["TASK_BUSY", 409, "TASK_BUSY"],
    ["WORKSPACE_BUSY", 409, "TASK_BUSY"],
    ["WORKSPACE_NOT_READY", 409, "TASK_BUSY"],
    ["STALE_FENCE", 409, "TASK_BUSY"],
    ["CHANNEL_REQUIRED", 409, "CHANNEL_REQUIRED"],
    ["CHANNEL_AMBIGUOUS", 409, "CHANNEL_AMBIGUOUS"],
    ["WORKSPACE_LIMIT", 409, "WORKSPACE_LIMIT"],
    ["SLACK_UNAVAILABLE", 503, "SLACK_UNAVAILABLE"],
    ["CONFIG_INVALID", 400, "INVALID_REQUEST"],
    ["IDEMPOTENCY_CONFLICT", 409, "INVALID_REQUEST"],
    ["AUTH_REQUIRED", 401, "SIGN_IN_REQUIRED"],
    ["FORBIDDEN", 403, "CONTROL_PLANE_UNAVAILABLE"],
  ] as const)("maps %s (HTTP %i) to %s with a next step", async (brokerCode, status, toolCode) => {
    const error = await client(async () => reply(status, { error: { code: brokerCode, message: "the broker's words" } })).getTask(view.taskId, 10).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolError);
    expect(error).toMatchObject({ code: toolCode });
    expect((error as ToolError).message).toContain("the broker's words");
    expect((error as ToolError).nextStep.length).toBeGreaterThan(0);
  });

  it("stops trying at the deadline when AgentX never answers", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const hanging = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    let settledAt = 0;
    const pending = httpControlPlaneClient({ session, fetch: hanging, traceId: () => "trace-1" })
      .getTask(view.taskId, 10).catch((caught: unknown) => { settledAt = Date.now(); return caught; });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await pending).toMatchObject({ code: "CONTROL_PLANE_UNAVAILABLE" });
    expect(settledAt - started).toBeLessThanOrEqual(45_000);
    expect(settledAt - started).toBeGreaterThanOrEqual(30_000);
    expect(hanging).toHaveBeenCalledTimes(2);
  });

  it("does not try again when the next wait would pass the deadline", async () => {
    let clock = 0;
    const slow = vi.fn(async () => { clock += 44_900; throw new TypeError("fetch failed"); });
    const sleep = vi.fn(async () => undefined);
    await expect(client(slow as unknown as typeof fetch, { now: () => clock, sleep }).projects()).rejects.toMatchObject({ code: "CONTROL_PLANE_UNAVAILABLE" });
    expect(slow).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives a wait's poll its own short deadline (Task 15 fix round 1)", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const hanging = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    let settledAt = 0;
    const pending = httpControlPlaneClient({ session, fetch: hanging, traceId: () => "trace-1" })
      .getTask(view.taskId, 10, { deadlineMs: 10_000 }).catch((caught: unknown) => { settledAt = Date.now(); return caught; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pending).toMatchObject({ code: "CONTROL_PLANE_UNAVAILABLE" });
    expect(settledAt - started).toBeLessThanOrEqual(10_000);
    expect(hanging).toHaveBeenCalledTimes(1);
  });

  it("ends a call at once, without trying again, when its signal is aborted", async () => {
    vi.useFakeTimers();
    const hanging = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const controller = new AbortController();
    let settled = false;
    const pending = httpControlPlaneClient({ session, fetch: hanging, traceId: () => "trace-1" })
      .getTask(view.taskId, 10, { signal: controller.signal }).catch((caught: unknown) => { settled = true; return caught; });
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    expect(await pending).toBeInstanceOf(ToolError);
    expect(hanging).toHaveBeenCalledTimes(1);
    // An already aborted signal sends nothing.
    await expect(httpControlPlaneClient({ session, fetch: hanging, traceId: () => "trace-1" }).getTask(view.taskId, 10, { signal: controller.signal })).rejects.toBeInstanceOf(ToolError);
    expect(hanging).toHaveBeenCalledTimes(1);
  });

  it("refreshes the sign-in once after a 401, then tries once more", async () => {
    const hook = vi.fn(async (options?: { force?: boolean }) => ({ ...(await session()), accessToken: options?.force === true ? "fresh-access-token" : TOKEN }));
    const fetch = vi.fn().mockResolvedValueOnce(reply(401, { error: { code: "AUTH_REQUIRED", message: "expired" } })).mockResolvedValueOnce(reply(200, { task: view }));
    expect((await client(fetch, { session: hook }).getTask(view.taskId, 10)).taskId).toBe(view.taskId);
    expect(hook.mock.calls).toEqual([[], [{ force: true }]]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new Headers((fetch.mock.calls[1]![1] as RequestInit).headers).get("authorization")).toBe("Bearer fresh-access-token");
  });

  it("answers SIGN_IN_REQUIRED after one forced refresh, never looping", async () => {
    const hook = vi.fn(session);
    const refused = vi.fn(async () => reply(401, { error: { code: "AUTH_REQUIRED", message: "your AgentX sign-in has ended" } }));
    const error = await client(refused, { session: hook }).startTask(start).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "SIGN_IN_REQUIRED", nextStep: "run npx @preplabs/rovara-code login https://agentx.example.test" });
    expect(refused).toHaveBeenCalledTimes(2);
    expect(hook).toHaveBeenCalledTimes(2);
    const ended = vi.fn(async (options?: { force?: boolean }) => {
      if (options?.force === true) throw agentXError("AUTH_REQUIRED", "your AgentX sign-in for staging has ended; run npx @preplabs/rovara-code login https://agentx.example.test");
      return session();
    });
    const once = vi.fn(async () => reply(401, {}));
    expect(await client(once, { session: ended }).projects().catch((caught: unknown) => caught)).toMatchObject({ code: "SIGN_IN_REQUIRED", nextStep: "run npx @preplabs/rovara-code login https://agentx.example.test" });
    expect(once).toHaveBeenCalledTimes(1);
  });

  it("hides the refused token too when the try after the refresh fails", async () => {
    const hook = vi.fn(async (options?: { force?: boolean }) => ({ ...(await session()), accessToken: options?.force === true ? "fresh-access-token" : TOKEN }));
    const fetch = vi.fn()
      .mockResolvedValueOnce(reply(401, {}))
      .mockResolvedValueOnce(reply(409, { error: { code: "TASK_BUSY", message: `old ${TOKEN} new fresh-access-token` } }));
    const error = await client(fetch, { session: hook }).getTask(view.taskId, 10).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "TASK_BUSY" });
    expect((error as Error).message).not.toContain("planted-access-token");
    expect((error as Error).message).not.toContain("fresh-access-token");
  });

  it.each([
    [403, "FORBIDDEN"],
    [429, "RATE_LIMITED"],
    [418, undefined],
  ] as const)("gives an unknown HTTP %i (%s) a next step that is not about the connection", async (status, code) => {
    const error = await client(async () => reply(status, code === undefined ? {} : { error: { code, message: "no" } })).projects().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "CONTROL_PLANE_UNAVAILABLE", nextStep: UNEXPECTED_ANSWER_STEP });
    expect(UNEXPECTED_ANSWER_STEP).toBe("ask your AgentX admin, or try again later");
  });

  it("removes the access token before the 1,000-character cap", async () => {
    const opaque = "opaque0planted0access0token0value0000000000000000";
    const fromOpaque = async () => ({ ...(await session()), accessToken: opaque });
    const message = `${"a".repeat(990)}${opaque}`;
    const error = await client(async () => reply(409, { error: { code: "TASK_BUSY", message } }), { session: fromOpaque }).projects().catch((caught: unknown) => caught);
    expect((error as Error).message).not.toContain(opaque.slice(0, 10));
    expect((error as Error).message.length).toBeLessThanOrEqual(1_000);
  });

  it("gives a cancel that raced the task a next step that names the tools", async () => {
    const error = await client(async () => reply(409, { error: { code: "STALE_FENCE", message: "the task changed while cancelling; try agentx_cancel_task again" } }))
      .cancelTask(view.taskId, start.requestId).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "TASK_BUSY", message: "the task changed while cancelling; try agentx_cancel_task again", nextStep: NEXT_STEPS.TASK_BUSY });
  });

  it("gives SIGN_IN_REQUIRED the exact sign-in command, from a 401 or from the local session", async () => {
    const refused = await client(async () => reply(401, { error: { code: "AUTH_REQUIRED", message: "your AgentX sign-in has ended" } })).projects().catch((caught: unknown) => caught);
    expect(refused).toMatchObject({ code: "SIGN_IN_REQUIRED", nextStep: "run npx @preplabs/rovara-code login https://agentx.example.test" });
    const local = await client(vi.fn(), {
      session: async () => { throw agentXError("AUTH_REQUIRED", "this computer is not signed in to AgentX environment staging; run npx @preplabs/rovara-code login https://agentx.example.test"); },
    }).projects().catch((caught: unknown) => caught);
    expect(local).toMatchObject({ code: "SIGN_IN_REQUIRED", nextStep: "run npx @preplabs/rovara-code login https://agentx.example.test" });
  });

  it("keeps the whole placeholder when no environment is signed in (ruling F16)", async () => {
    const fetch = vi.fn();
    const local = await client(fetch, {
      session: async () => { throw agentXError("AUTH_REQUIRED", "this computer is not signed in to AgentX; run npx @preplabs/rovara-code login <your AgentX URL>"); },
    }).projects().catch((caught: unknown) => caught);
    expect(local).toMatchObject({ code: "SIGN_IN_REQUIRED", message: "this computer is not signed in to AgentX; run npx @preplabs/rovara-code login <your AgentX URL>", nextStep: "run npx @preplabs/rovara-code login <your AgentX URL>" });
    expect(fetch).not.toHaveBeenCalled();
    expect(signInStep("no command here", "npx @preplabs/rovara-code login <your AgentX URL>")).toBe("run npx @preplabs/rovara-code login <your AgentX URL>");
  });

  it("answers CONTROL_PLANE_UNAVAILABLE when the local session cannot refresh", async () => {
    const error = await client(vi.fn(), {
      session: async () => { throw agentXError("RUNTIME_UNAVAILABLE", "could not reach AgentX at https://agentx.example.test; check your connection and try again"); },
    }).projects().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "CONTROL_PLANE_UNAVAILABLE", message: "could not reach AgentX at https://agentx.example.test; check your connection and try again" });
    const odd = await client(vi.fn(), { session: async () => { throw new Error(`boom ${TOKEN}`); } }).projects().catch((caught: unknown) => caught);
    expect(odd).toMatchObject({ code: "CONTROL_PLANE_UNAVAILABLE" });
    expect((odd as Error).message).not.toContain("planted-access-token");
  });

  it("never repeats the access token in an error", async () => {
    const error = await client(async () => reply(500, { error: { code: "RUNTIME_UNAVAILABLE", message: `echo ${TOKEN}` } })).projects().catch((caught: unknown) => caught);
    expect(JSON.stringify({ message: (error as Error).message, nextStep: (error as ToolError).nextStep })).not.toContain("planted-access-token");
    const refused = await client(async () => reply(401, { error: { code: "AUTH_REQUIRED", message: `bad token ${TOKEN}` } })).projects().catch((caught: unknown) => caught);
    expect(JSON.stringify({ message: (refused as Error).message, nextStep: (refused as ToolError).nextStep })).not.toContain("planted-access-token");
  });

  it("redacts secrets and control characters in the server's words", async () => {
    const error = await client(async () => reply(409, { error: { code: "TASK_BUSY", message: "slack said xoxb-1111-2222-fakefakefake\u001b[31m no" } })).projects().catch((caught: unknown) => caught);
    expect((error as Error).message).not.toContain("xoxb-1111-2222-fakefakefake");
    expect((error as Error).message).not.toContain("\u001b");
    expect((error as Error).message).toContain("[REDACTED]");
  });

  it("answers CONTROL_PLANE_UNAVAILABLE for a reply it cannot read", async () => {
    await expect(client(async () => reply(200, { task: { status: "SOMETHING" } })).getTask(view.taskId, 10)).rejects.toMatchObject({ code: "CONTROL_PLANE_UNAVAILABLE" });
    await expect(client(async () => new Response("<html>", { status: 200 })).getTask(view.taskId, 10)).rejects.toMatchObject({ code: "CONTROL_PLANE_UNAVAILABLE" });
  });

  it("has a next step for every code", () => {
    for (const code of TOOL_ERROR_CODES) expect(NEXT_STEPS[code].length, code).toBeGreaterThan(0);
    expect(TOOL_ERROR_CODES).toContain("INVALID_REQUEST");
    expect(UPGRADE_AGENTX_STEP).toContain("ask your AgentX admin to upgrade AgentX");
  });

  it("gives CHANNEL_REQUIRED and CHANNEL_AMBIGUOUS next steps that fit what is left once sharing exists (C21, ruling F22)", () => {
    expect(NEXT_STEPS.CHANNEL_REQUIRED).toBe("send channel with one of the bound channels the message names, or ask an AgentX admin to bind one");
    expect(NEXT_STEPS.CHANNEL_AMBIGUOUS).toBe("send channel with one of the channels the message names");
  });
});
