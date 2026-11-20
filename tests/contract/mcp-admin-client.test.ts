// tests/contract/mcp-admin-client.test.ts
// Spec 025 A14: the admin client reads /v1/admin/* with the admin sign-in, and maps refusals to FR-049's codes.
import { describe, expect, it, vi } from "vitest";
import { ADMIN_SIGN_IN_STEP, ToolError, compatibilityChecker, httpAdminClient, type ControlPlaneClient } from "../../packages/mcp/src/index.js";

const session = async () => ({ baseUrl: "https://abc123.execute-api.us-east-1.amazonaws.com", accessToken: "admin-access-token" });
const answering = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("the admin client (A14)", () => {
  it("sends the admin token and a trace ID, and reads the answer", async () => {
    const fetch = answering(200, { projects: [] });
    const client = httpAdminClient({ session, fetch: fetch, traceId: () => "trace-1" });
    expect(await client.projects()).toEqual({ projects: [] });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://abc123.execute-api.us-east-1.amazonaws.com/v1/admin/projects");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer admin-access-token");
    expect(new Headers(init.headers).get("x-agentx-trace-id")).toBe("trace-1");
  });

  it("builds each read's query string", async () => {
    const fetch = answering(200, { turns: [] });
    const client = httpAdminClient({ session, fetch: fetch });
    await client.turns({ since: "2026-09-29T00:00:00.000Z", task: "33333333-3333-4333-8333-333333333333", limit: 5 });
    expect(String((fetch.mock.calls[0] as unknown as [string])[0])).toBe("https://abc123.execute-api.us-east-1.amazonaws.com/v1/admin/turns?since=2026-09-29T00%3A00%3A00.000Z&task=33333333-3333-4333-8333-333333333333&limit=5");
  });

});

describe("the admin client's refusals and outages (A14, secrets)", () => {
  const PLANTED = "planted-admin-token-5f1e9c";
  const planted = async () => ({ baseUrl: "https://abc123.execute-api.us-east-1.amazonaws.com", accessToken: PLANTED });
  const everywhere = (failure: unknown) => JSON.stringify({ failure, message: (failure as Error).message, nextStep: (failure as ToolError).nextStep, stack: (failure as Error).stack });

  it("never repeats the token, even when AgentX's answer quotes it", async () => {
    const answers: Array<[number, unknown]> = [
      [401, { error: { code: "AUTH_REQUIRED", message: `token ${PLANTED} expired` } }],
      [403, { error: { code: "FORBIDDEN", message: `token ${PLANTED} lacks the administrator claim` } }],
      [403, { error: { code: "FORBIDDEN", message: `${PLANTED}: this endpoint serves administration only` } }],
      [400, { error: { code: "CONFIG_INVALID", message: `limit ${PLANTED} must be a whole number` } }],
      [404, { error: { code: "NOT_FOUND", message: `no route for ${PLANTED}` } }],
      [503, { error: { code: "INTERNAL", message: `down, token ${PLANTED}` } }],
    ];
    for (const [status, body] of answers) {
      const client = httpAdminClient({ session: planted, fetch: answering(status, body), sleep: async () => undefined });
      const failure = await client.health().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ToolError);
      expect(everywhere(failure)).not.toContain(PLANTED);
    }
    const unreadable = httpAdminClient({ session: planted, fetch: answering(200, { unexpected: PLANTED }) });
    expect(everywhere(await unreadable.health().catch((error: unknown) => error))).not.toContain(PLANTED);
    const unreachable = httpAdminClient({ session: planted, fetch: vi.fn(async () => { throw new TypeError(`fetch failed ${PLANTED}`); }), sleep: async () => undefined });
    expect(everywhere(await unreachable.health().catch((error: unknown) => error))).not.toContain(PLANTED);
  });

  it("gives up within one overall deadline across its tries (45 seconds, like the developer client)", async () => {
    let now = 0;
    const slow = vi.fn(async () => { now += 44_900; throw new TypeError("fetch failed"); });
    const sleeps: number[] = [];
    const client = httpAdminClient({ session, fetch: slow, now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; }, tries: 3 });
    await expect(client.projects()).rejects.toMatchObject({ code: "CONTROL_PLANE_UNAVAILABLE" });
    // The first try used 44.9 s; the back-off alone would pass 45 s, so no second try starts.
    expect(slow).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    let later = 0;
    // Two 22.4 s answers and a 250 ms back-off leave no room for the third try's 500 ms back-off.
    const outage = vi.fn(async () => { later += 22_400; return new Response("{}", { status: 503 }); });
    const outageSleeps: number[] = [];
    const failing = httpAdminClient({ session, fetch: outage, now: () => later, sleep: async (ms) => { outageSleeps.push(ms); later += ms; }, tries: 3 });
    await expect(failing.projects()).rejects.toMatchObject({ code: "CONTROL_PLANE_UNAVAILABLE" });
    expect(outage).toHaveBeenCalledTimes(2);
    expect(outageSleeps).toEqual([250]);
  });

  it("reads every route at its path", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = httpAdminClient({ session, fetch: fetch });
    await Promise.allSettled([
      client.me(), client.health(), client.failures({}), client.usage({ groupBy: "day", since: "a" }), client.projects(),
      client.bindings(), client.credentials(), client.workspaces({ project: "payments", limit: 2 }),
    ]);
    const paths = fetch.mock.calls.map((call) => new URL(String((call as unknown as [string])[0])).pathname + new URL(String((call as unknown as [string])[0])).search);
    expect(paths).toEqual([
      "/v1/admin/me", "/v1/admin/health", "/v1/admin/failures", "/v1/admin/usage?since=a&group_by=day", "/v1/admin/projects",
      "/v1/admin/slack/bindings", "/v1/admin/credentials", "/v1/admin/workspaces?project=payments&limit=2",
    ]);
  });

  it("uses no em dash in any of its words", async () => {
    const answers: Array<[number, unknown]> = [
      [401, {}], [403, { error: { code: "FORBIDDEN", message: "x" } }], [403, { error: { code: "FORBIDDEN", message: "this endpoint serves administration only" } }],
      [404, {}], [500, {}], [200, { nope: true }],
    ];
    for (const [status, body] of answers) {
      const failure = await httpAdminClient({ session, fetch: answering(status, body), sleep: async () => undefined }).health().catch((error: unknown) => error) as ToolError;
      expect(`${failure.message} ${failure.nextStep}`).not.toContain("—");
    }
    expect(ADMIN_SIGN_IN_STEP).not.toContain("—");
  });
});

describe("the configuration's admin API version (A1)", () => {

  it("carries adminApiVersion in the compatibility it keeps", async () => {
    const configuration = vi.fn(async () => ({ env: "staging", apiVersion: "1.2", adminApiVersion: "1.0", baseUrl: "https://x" }));
    const check = compatibilityChecker({ configuration } as unknown as ControlPlaneClient, { now: () => 0 });
    expect(await check()).toEqual({ env: "staging", apiVersion: "1.2", adminApiVersion: "1.0" });
    expect(await check()).toEqual({ env: "staging", apiVersion: "1.2", adminApiVersion: "1.0" });
    expect(configuration).toHaveBeenCalledTimes(1);
    const older = compatibilityChecker({ configuration: async () => ({ env: "staging", apiVersion: "1.2", baseUrl: "https://x" }) } as unknown as ControlPlaneClient);
    expect(await older()).toEqual({ env: "staging", apiVersion: "1.2" });
  });
});
