// tests/contract/mcp-confirmation.test.ts
// Spec 025 FR-041, E13, E15: the pop-up first, then the Slack button; declined, expired and stale
// changes are FR-049's errors naming the change; a Slack wait ends as awaiting_confirmation.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ADMIN_SIGN_IN_STEP, SLACK_POLL_MS, ToolError, changeError, confirmChange, createAgentXMcpServer, httpAdminClient, httpControlPlaneClient, type AdminControlPlaneClient, type ToolContext, type ToolDefinition } from "../../packages/mcp/src/index.js";
import type { AdminChangeView } from "../../packages/contracts/src/index.js";

const CHANGE = "55555555-5555-4555-8555-555555555555";
const view = (extra: Partial<AdminChangeView> = {}): AdminChangeView => ({
  changeId: CHANGE, kind: "bind_channel", status: "pending", effect: "Bind channel #ledger-dev (C0LEDGER01) to project ledger.", methodsOffered: ["elicitation", "slack"],
  createdAt: "2026-10-02T09:00:00.000Z", expiresAt: "2026-10-02T09:10:00.000Z", ...extra,
});
function run(admin: Partial<AdminControlPlaneClient>, extra: Record<string, unknown> = {}) {
  let now = Date.parse("2026-10-02T09:00:01.000Z");
  const progress = vi.fn(async () => undefined);
  return {
    progress,
    run: { admin: admin as AdminControlPlaneClient, change: view(), traceId: "trace-9", progress, sleep: async (ms: number) => { now += ms; }, now: () => now, signal: new AbortController().signal, ...extra },
  };
}

describe("the confirmation driver (FR-041)", () => {
  it("applies after the pop-up's yes, reporting when it asked and when it was answered", async () => {
    const applyChange = vi.fn(async () => view({ status: "applied", methodUsed: "elicitation" }));
    const elicit = vi.fn(async () => "accept" as const);
    const { run: r } = run({ applyChange }, { elicit });
    expect(await confirmChange(r)).toMatchObject({ outcome: "applied" });
    expect(elicit).toHaveBeenCalledWith(expect.stringContaining("Bind channel #ledger-dev"), expect.any(Number), expect.anything());
    expect(applyChange).toHaveBeenCalledWith(CHANGE, { method: "elicitation", requestedAt: expect.any(String) as unknown, answeredAt: expect.any(String) as unknown }, "trace-9");
  });

  it("declines on no or a dismissed pop-up, and says CONFIRMATION_DECLINED with the change ID", async () => {
    for (const answer of ["decline", "cancel"] as const) {
      const declineChange = vi.fn(async () => view({ status: "declined" }));
      const { run: r } = run({ declineChange }, { elicit: async () => answer });
      await expect(confirmChange(r)).rejects.toMatchObject({ code: "CONFIRMATION_DECLINED", message: expect.stringContaining(CHANGE) as unknown });
      expect(declineChange).toHaveBeenCalledWith(CHANGE, expect.objectContaining({ method: "elicitation", reason: answer === "decline" ? "declined" : "cancelled" }), "trace-9");
    }
  });

  it("falls back to Slack when the pop-up fails, and declines when there is no Slack", async () => {
    const startSlackConfirmation = vi.fn(async () => view());
    const getChange = vi.fn().mockResolvedValueOnce(view()).mockResolvedValueOnce(view({ status: "applied", methodUsed: "slack" }));
    const { run: withSlack, progress } = run({ startSlackConfirmation, getChange }, { elicit: async () => "failed" as const });
    expect(await confirmChange(withSlack)).toMatchObject({ outcome: "applied" });
    expect(progress).toHaveBeenCalledWith(expect.any(Number), 300, expect.stringContaining("the pop-up could not be shown"));
    const declineChange = vi.fn(async () => view({ status: "declined" }));
    const { run: noSlack } = run({ declineChange }, { elicit: async () => "failed" as const, change: view({ methodsOffered: ["elicitation"] }) });
    await expect(confirmChange(noSlack)).rejects.toMatchObject({ code: "CONFIRMATION_DECLINED", message: expect.stringContaining("the confirmation pop-up could not be shown") as unknown });
    expect(declineChange).toHaveBeenCalledWith(CHANGE, expect.objectContaining({ reason: "failed" }), "trace-9");
  });

  it("waits five minutes for the Slack press, with progress every 15 seconds, then says awaiting_confirmation", async () => {
    const getChange = vi.fn(async () => view({ methodsOffered: ["slack"] }));
    const { run: r, progress } = run({ startSlackConfirmation: async () => view({ methodsOffered: ["slack"] }), getChange }, { change: view({ methodsOffered: ["slack"] }) });
    expect(await confirmChange(r)).toMatchObject({ outcome: "awaiting_confirmation" });
    expect(progress.mock.calls.length).toBeGreaterThanOrEqual(19);
    expect(getChange.mock.calls.length).toBeLessThanOrEqual(61);
  });

  it("stops waiting when the tool call is cancelled, leaving the change to its button (D7)", async () => {
    const controller = new AbortController();
    controller.abort();
    const { run: r } = run({ startSlackConfirmation: async () => view(), getChange: async () => view() }, { change: view({ methodsOffered: ["slack"] }), signal: controller.signal });
    expect(await confirmChange(r)).toMatchObject({ outcome: "awaiting_confirmation" });
  });
});

describe("the confirmation driver's edges (FR-041, FR-052, R1)", () => {
  it("shows the planning admin's confirmationEffect in the pop-up when the view carries one", async () => {
    const elicit = vi.fn(async () => "accept" as const);
    const change = { ...view({ effect: "Bind channel C0SECRET01 to project ledger." }), confirmationEffect: "Bind private channel #payroll (C0SECRET01) to project ledger." };
    const { run: r } = run({ applyChange: async () => view({ status: "applied" }) }, { elicit, change });
    await confirmChange(r);
    expect(elicit.mock.calls[0]?.[0]).toContain("#payroll");
  });

  it("gives the pop-up at most 9 minutes, and always ends it before the change expires", async () => {
    const elicit = vi.fn(async () => "accept" as const);
    const { run: r } = run({ applyChange: async () => view({ status: "applied" }) }, { elicit });
    await confirmChange(r);
    const timeout = elicit.mock.calls[0]?.[1] ?? 0;
    expect(timeout).toBeLessThanOrEqual(9 * 60_000);
    expect(Date.parse("2026-10-02T09:00:01.000Z") + timeout).toBeLessThan(Date.parse(view().expiresAt));
  });

  it("uses Slack when the client has no pop-up, and CONFIRMATION_UNAVAILABLE when nothing fits", async () => {
    const startSlackConfirmation = vi.fn(async () => view());
    const { run: r, progress } = run({ startSlackConfirmation, getChange: async () => view({ status: "applied", methodUsed: "slack" }) });
    expect(await confirmChange(r)).toMatchObject({ outcome: "applied" });
    expect(startSlackConfirmation).toHaveBeenCalledWith(CHANGE, "trace-9");
    expect(JSON.stringify(progress.mock.calls)).not.toContain("pop-up");
    const { run: none } = run({}, { change: view({ methodsOffered: ["elicitation"] }) });
    await expect(confirmChange(none)).rejects.toMatchObject({ code: "CONFIRMATION_UNAVAILABLE", message: expect.stringContaining(CHANGE) as unknown });
    const { run: cliOnly } = run({}, { change: view({ methodsOffered: ["cli"] }), elicit: async () => "accept" as const });
    await expect(confirmChange(cliOnly)).rejects.toMatchObject({ code: "CONFIRMATION_UNAVAILABLE" });
  });

  it("sends the one trace ID on every call of the change (FR-052)", async () => {
    const startSlackConfirmation = vi.fn(async () => view());
    const getChange = vi.fn().mockResolvedValueOnce(view()).mockResolvedValueOnce(view({ status: "applied" }));
    const { run: r } = run({ startSlackConfirmation, getChange }, { elicit: async () => "failed" as const });
    await confirmChange(r);
    // The trace ID is each call's second argument (a poll's third is its options).
    for (const call of [...startSlackConfirmation.mock.calls, ...getChange.mock.calls] as unknown[][]) expect(call[1]).toBe("trace-9");
  });

  it("tries a failed Slack check again at the next poll, logging only the event, change and code", async () => {
    const log = vi.fn();
    const getChange = vi.fn()
      .mockRejectedValueOnce(new ToolError("CONTROL_PLANE_UNAVAILABLE", "could not reach AgentX planted-words"))
      .mockResolvedValueOnce(view({ status: "applied", methodUsed: "slack" }));
    const { run: r } = run({ startSlackConfirmation: async () => view(), getChange }, { change: view({ methodsOffered: ["slack"] }), log });
    expect(await confirmChange(r)).toMatchObject({ outcome: "applied" });
    expect(log).toHaveBeenCalledWith({ event: "change.poll_failed", changeId: CHANGE, code: "CONTROL_PLANE_UNAVAILABLE" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("planted-words");
  });

  it("says why a Slack wait ended without applying: declined, expired or stale", async () => {
    for (const [ending, code] of [[view({ status: "declined", methodUsed: "slack" }), "CONFIRMATION_DECLINED"], [view({ status: "expired" }), "CONFIRMATION_EXPIRED"], [view({ status: "failed", error: { code: "CHANGE_STALE", message: "what it was planned against has changed" } }), "CHANGE_STALE"]] as const) {
      const { run: r } = run({ startSlackConfirmation: async () => view(), getChange: async () => ending }, { change: view({ methodsOffered: ["slack"] }) });
      await expect(confirmChange(r)).rejects.toMatchObject({ code, message: expect.stringContaining(CHANGE) as unknown });
    }
  });

  it("passes an apply's refusal through, and never reads an answer it does not know as applied (R1)", async () => {
    const stale = new ToolError("CHANGE_STALE", `what change ${CHANGE} was planned against has changed; ask for the change again`);
    const { run: refused } = run({ applyChange: async () => { throw stale; } }, { elicit: async () => "accept" as const });
    await expect(confirmChange(refused)).rejects.toBe(stale);
    const unknown = { ...view(), status: "queued_somewhere_new" } as unknown as AdminChangeView;
    const { run: odd } = run({ applyChange: async () => unknown }, { elicit: async () => "accept" as const });
    const failure = await confirmChange(odd).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ToolError);
    expect((failure as ToolError).message).toContain(CHANGE);
    expect((failure as ToolError).message).not.toMatch(/\bapplied\b(?! as)/);
    // A Slack wait that reads an unknown status stops, and does not claim the change is still waiting either.
    const { run: slackOdd } = run({ startSlackConfirmation: async () => view(), getChange: async () => unknown }, { change: view({ methodsOffered: ["slack"] }) });
    await expect(confirmChange(slackOdd)).rejects.toBeInstanceOf(ToolError);
  });

  it("says the pop-up failed even when its decline could not be sent, and logs no words", async () => {
    const log = vi.fn();
    const { run: r } = run({ declineChange: async () => { throw new ToolError("CONTROL_PLANE_UNAVAILABLE", "down planted-words"); } }, { elicit: async () => "failed" as const, change: view({ methodsOffered: ["elicitation"] }), log });
    await expect(confirmChange(r)).rejects.toMatchObject({ code: "CONFIRMATION_DECLINED", message: expect.stringContaining("the confirmation pop-up could not be shown") as unknown });
    expect(JSON.stringify(log.mock.calls)).not.toContain("planted-words");
  });

  it("ends a Slack wait whose sleep is interrupted by the tool call's cancel", async () => {
    const controller = new AbortController();
    const sleep = vi.fn(async () => { controller.abort(); throw new DOMException("aborted", "AbortError"); });
    const { run: r } = run({ startSlackConfirmation: async () => view(), getChange: async () => view() }, { change: view({ methodsOffered: ["slack"] }), signal: controller.signal, sleep });
    expect(await confirmChange(r)).toMatchObject({ outcome: "awaiting_confirmation" });
  });

  it("polls every 5 seconds", () => {
    expect(SLACK_POLL_MS).toBe(5_000);
  });
});

describe("change errors (E15, Q9)", () => {
  it("maps each ending to FR-049's code, naming the change", () => {
    expect(changeError(view({ status: "declined" }))).toMatchObject({ code: "CONFIRMATION_DECLINED" });
    expect(changeError(view({ status: "expired" }))).toMatchObject({ code: "CONFIRMATION_EXPIRED" });
    expect(changeError(view({ status: "failed", error: { code: "CHANGE_STALE", message: "what it was planned against has changed" } }))).toMatchObject({ code: "CHANGE_STALE" });
    const failed = changeError(view({ status: "failed", error: { code: "CONFIG_INVALID", message: "the per-person limit cannot be more than the organization limit" } }));
    expect(failed).toBeInstanceOf(ToolError);
    expect(failed).toMatchObject({ code: "INVALID_REQUEST", message: expect.stringContaining(`change ${CHANGE}`) as unknown });
  });

  it("says try again for a transient failure, and never uses an em dash", () => {
    expect(changeError(view({ status: "failed", error: { code: "RUNTIME_UNAVAILABLE", message: "the apply did not finish" } }))).toMatchObject({ code: "CONTROL_PLANE_UNAVAILABLE" });
    for (const status of ["declined", "expired", "failed", "something_new"]) expect(changeError({ ...view(), status }).message).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("the admin client's change calls (E4, FR-052, R1)", () => {
  const PLANTED = "planted-admin-token-7c2d41";
  const session = async () => ({ baseUrl: "https://abc123.execute-api.us-east-1.amazonaws.com", accessToken: PLANTED });
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const answering = (status: number, body: unknown) => vi.fn(async () => reply(status, body));
  const sent = (fetch: ReturnType<typeof vi.fn>, index = 0) => {
    const [url, init] = fetch.mock.calls[index] as unknown as [string, RequestInit];
    return { url: String(url), method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body as string) as unknown, trace: new Headers(init.headers).get("x-agentx-trace-id"), auth: new Headers(init.headers).get("authorization") };
  };
  const request = { requestId: "66666666-6666-4666-8666-666666666666", change: { kind: "bind_channel" as const, channel: "C0LEDGER01", project: "ledger" }, client: { cliVersion: "0.6.0" }, methods: ["elicitation" as const, "slack" as const] };

  it("sends each change call to its route with the tool call's trace ID", async () => {
    const fetch = answering(200, { change: view() });
    const client = httpAdminClient({ session, fetch, traceId: () => "ignored-for-change-calls" });
    await client.proposeChange(request, "trace-7");
    await client.getChange(CHANGE, "trace-7");
    await client.startSlackConfirmation(CHANGE, "trace-7");
    await client.applyChange(CHANGE, { method: "elicitation", requestedAt: "2026-10-02T09:00:01.000Z", answeredAt: "2026-10-02T09:00:05.000Z" }, "trace-7");
    await client.declineChange(CHANGE, { method: "elicitation", reason: "cancelled" }, "trace-7");
    const base = "https://abc123.execute-api.us-east-1.amazonaws.com/v1/admin/changes";
    expect([0, 1, 2, 3, 4].map((index) => sent(fetch, index))).toEqual([
      { url: base, method: "POST", body: request, trace: "trace-7", auth: `Bearer ${PLANTED}` },
      { url: `${base}/${CHANGE}`, method: "GET", body: undefined, trace: "trace-7", auth: `Bearer ${PLANTED}` },
      { url: `${base}/${CHANGE}/slack`, method: "POST", body: {}, trace: "trace-7", auth: `Bearer ${PLANTED}` },
      { url: `${base}/${CHANGE}/apply`, method: "POST", body: { method: "elicitation", requestedAt: "2026-10-02T09:00:01.000Z", answeredAt: "2026-10-02T09:00:05.000Z" }, trace: "trace-7", auth: `Bearer ${PLANTED}` },
      { url: `${base}/${CHANGE}/decline`, method: "POST", body: { method: "elicitation", reason: "cancelled" }, trace: "trace-7", auth: `Bearer ${PLANTED}` },
    ]);
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
  });

  it("reads a newer control plane's change answer: an unknown status, kind, method and field (R1)", async () => {
    const newer = { change: { ...view(), kind: "rename_project", status: "queued", methodsOffered: ["elicitation", "passkey"], methodUsed: "passkey", confirmationEffect: "Bind private channel #payroll.", addedLater: { x: 1 }, error: { code: "NEW_CODE", message: "m", hint: "h" } } };
    const change = await httpAdminClient({ session, fetch: answering(200, newer) }).getChange(CHANGE, "trace-7");
    expect(change).toMatchObject({ status: "queued", kind: "rename_project", methodsOffered: ["elicitation", "passkey"], confirmationEffect: "Bind private channel #payroll." });
  });

  it("reads the change list with its query, loosely", async () => {
    const fetch = answering(200, { changes: [{ changeId: CHANGE, kind: "bind_channel", traceId: "t", admin: { issuer: "i", subject: "s" }, client: { cliVersion: "0.6.0" }, change: {}, effect: "e", methodsOffered: ["slack"], status: "someday", outcome: "brand_new", proposedAt: "2026-10-02T09:00:00.000Z" }], cursor: "c1" });
    const page = await httpAdminClient({ session, fetch }).changes({ since: "2026-10-01T00:00:00.000Z", outcome: "declined", limit: 5, cursor: "c0" });
    expect(page.cursor).toBe("c1");
    expect(page.changes[0]).toMatchObject({ status: "someday", outcome: "brand_new" });
    expect(sent(fetch).url).toBe("https://abc123.execute-api.us-east-1.amazonaws.com/v1/admin/changes?since=2026-10-01T00%3A00%3A00.000Z&outcome=declined&limit=5&cursor=c0");
  });

  it("retries only the proposal: an apply, a decline and a Slack step are sent once", async () => {
    const outage = () => vi.fn().mockResolvedValueOnce(reply(503, { error: { code: "INTERNAL", message: "down" } })).mockResolvedValue(reply(200, { change: view() }));
    const propose = outage();
    await httpAdminClient({ session, fetch: propose as never, sleep: async () => undefined }).proposeChange(request, "trace-7");
    expect(propose).toHaveBeenCalledTimes(2);
    expect(sent(propose, 1).trace).toBe("trace-7");
    for (const step of [
      (client: AdminControlPlaneClient) => client.applyChange(CHANGE, { method: "elicitation" }, "trace-7"),
      (client: AdminControlPlaneClient) => client.declineChange(CHANGE, { method: "elicitation", reason: "declined" }, "trace-7"),
      (client: AdminControlPlaneClient) => client.startSlackConfirmation(CHANGE, "trace-7"),
    ]) {
      const fetch = outage();
      await expect(step(httpAdminClient({ session, fetch: fetch as never, sleep: async () => undefined }))).rejects.toMatchObject({ code: "CONTROL_PLANE_UNAVAILABLE" });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("maps the change refusals to FR-049's codes, keeping the broker's words that name the change", async () => {
    const cases: Array<[number, string, string, string]> = [
      [409, "CONFIRMATION_DECLINED", `change ${CHANGE} was declined; ask for the change again`, "CONFIRMATION_DECLINED"],
      [409, "CONFIRMATION_EXPIRED", `change ${CHANGE} expired at 2026-10-02T09:10:00.000Z; ask for the change again`, "CONFIRMATION_EXPIRED"],
      [409, "CHANGE_STALE", `what change ${CHANGE} was planned against has changed; ask for the change again`, "CHANGE_STALE"],
      [409, "CONFIRMATION_UNAVAILABLE", `the Slack Confirm button was not offered for change ${CHANGE}; confirm it with the agentx CLI`, "CONFIRMATION_UNAVAILABLE"],
      [503, "SLACK_UNAVAILABLE", "Slack could not be reached; try again", "SLACK_UNAVAILABLE"],
      [503, "RUNTIME_UNAVAILABLE", `change ${CHANGE} could not be applied just now; try again`, "CONTROL_PLANE_UNAVAILABLE"],
      [404, "NOT_FOUND", "project not found", "INVALID_REQUEST"],
      [409, "PROJECT_REVISION_MISMATCH", "the project's revision changed", "INVALID_REQUEST"],
      [409, "WORKSPACE_BUSY", "the workspace is busy", "INVALID_REQUEST"],
      [409, "IDEMPOTENCY_CONFLICT", "that request ID was used for another change", "INVALID_REQUEST"],
    ];
    for (const [status, code, message, expected] of cases) {
      const failure = await httpAdminClient({ session, fetch: answering(status, { error: { code, message } }), tries: 1 }).applyChange(CHANGE, { method: "elicitation" }, "trace-7").catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ToolError);
      expect(failure).toMatchObject({ code: expected, message });
    }
    const membership = await httpAdminClient({ session, fetch: answering(403, { error: { code: "FORBIDDEN", message: "administrator project membership is required" } }) }).proposeChange(request, "trace-7").catch((error: unknown) => error);
    expect(membership).toMatchObject({ code: "ADMIN_REQUIRED", nextStep: "ask an AgentX admin who administers that project to make this change" });
    // 25d's mappings still hold.
    await expect(httpAdminClient({ session, fetch: answering(401, {}) }).getChange(CHANGE, "t")).rejects.toMatchObject({ code: "ADMIN_REQUIRED", nextStep: ADMIN_SIGN_IN_STEP });
    await expect(httpAdminClient({ session, fetch: answering(403, { error: { code: "FORBIDDEN", message: "administrator claim is required" } }) }).getChange(CHANGE, "t")).rejects.toMatchObject({ code: "ADMIN_REQUIRED", nextStep: ADMIN_SIGN_IN_STEP });
  });

  it("never repeats the token in a change call's error, even when the answer quotes it", async () => {
    const everywhere = (failure: unknown) => JSON.stringify({ failure, message: (failure as Error).message, nextStep: (failure as ToolError).nextStep, stack: (failure as Error).stack });
    for (const code of ["CONFIRMATION_DECLINED", "CHANGE_STALE", "SLACK_UNAVAILABLE", "NOT_FOUND", "CONFIRMATION_UNAVAILABLE"]) {
      const failure = await httpAdminClient({ session, fetch: answering(409, { error: { code, message: `refused ${PLANTED}` } }) }).declineChange(CHANGE, { method: "cli", reason: "declined" }, "t").catch((error: unknown) => error);
      expect(everywhere(failure)).not.toContain(PLANTED);
    }
    const membership = await httpAdminClient({ session, fetch: answering(403, { error: { code: "FORBIDDEN", message: `membership ${PLANTED}` } }) }).proposeChange(request, "t").catch((error: unknown) => error);
    expect(everywhere(membership)).not.toContain(PLANTED);
  });
});

describe("the developer client reads the environment's confirmation methods (C22, E16)", () => {
  it("passes confirm through when the configuration has it, and reads an older one without it", async () => {
    const base = { env: "staging", apiVersion: "1.2", adminApiVersion: "1.1" };
    for (const [body, expected] of [[{ ...base, confirm: { elicitation: true, slack: false } }, { elicitation: true, slack: false }], [base, undefined]] as const) {
      const client = httpControlPlaneClient({ session: async () => ({ baseUrl: "https://abc123.execute-api.us-east-1.amazonaws.com", accessToken: "t", signInCommand: "x" }), fetch: vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) });
      const configuration = await client.configuration();
      expect(configuration.confirm).toEqual(expected);
      expect(configuration).toMatchObject({ env: "staging", apiVersion: "1.2", adminApiVersion: "1.1" });
    }
  });
});

describe("the server's pop-up (FR-041)", () => {
  async function connectWith(elicitation: Record<string, unknown> | undefined, answer: (message: string) => ElicitResult | Promise<ElicitResult>, log?: (entry: Record<string, unknown>) => void) {
    const seen: { hadElicit?: boolean; answers: string[]; messages: string[] } = { answers: [], messages: [] };
    const probe: ToolDefinition = {
      name: "agentx_probe_confirm", title: "Probe", description: "A test tool.", inputSchema: {}, outputSchema: { answer: z.string() },
      handler: async (_context, _input, call) => {
        seen.hadElicit = call.elicit !== undefined;
        const got = call.elicit === undefined ? "absent" : await call.elicit("Bind channel #ledger-dev. token agxr_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG", 5_000, call.signal);
        seen.answers.push(got);
        return { structured: { answer: got }, text: got };
      },
    };
    const context = (): ToolContext => ({
      client: {} as never, clientName: "claude-code", serverVersion: "0.5.0", adminSignedIn: async () => true,
      compatibility: async () => ({ env: "staging", apiVersion: "1.2", adminApiVersion: "1.1" }), now: () => 0, sleep: async () => undefined, newRequestId: () => "33333333-3333-4333-8333-333333333333",
    });
    const server = createAgentXMcpServer({ version: "0.5.0", context, adminTools: [probe], adminOffer: async () => ({ admin: undefined }), ...(log === undefined ? {} : { log }) });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "claude-code", version: "1.0.0" }, { capabilities: elicitation === undefined ? {} : { elicitation } });
    if (elicitation !== undefined) client.setRequestHandler(ElicitRequestSchema, async (request) => { seen.messages.push(request.params.message); return answer(request.params.message); });
    await client.connect(clientSide);
    // The admin offer switches the probe on after initialization.
    await vi.waitFor(async () => expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("agentx_probe_confirm"));
    const call = async () => (await client.callTool({ name: "agentx_probe_confirm", arguments: {} })).structuredContent as { answer: string };
    return { seen, call, close: () => server.close() };
  }

  it("asks the client that declared elicitation, and reads its answer", async () => {
    const answers: ElicitResult[] = [{ action: "accept", content: { confirm: true } }, { action: "accept", content: { confirm: false } }, { action: "accept" }, { action: "decline" }, { action: "cancel" }];
    let next = 0;
    const { call, seen, close } = await connectWith({}, () => answers[next++] ?? { action: "cancel" });
    const results: string[] = [];
    for (let index = 0; index < answers.length; index += 1) results.push((await call()).answer);
    expect(results).toEqual(["accept", "decline", "decline", "decline", "cancel"]);
    expect(seen.messages[0]).toContain("Bind channel #ledger-dev");
    // The message goes into the client's pop-up, so it is redacted like every other text.
    expect(seen.messages[0]).not.toContain("agxr_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG");
    await close();
  });

  it("answers failed when the client's pop-up errors, and offers no pop-up to a client without elicitation or with URL mode only", async () => {
    const failing = await connectWith({ form: {} }, () => { throw new Error("the client could not show it"); });
    expect((await failing.call()).answer).toBe("failed");
    await failing.close();
    const none = await connectWith(undefined, () => ({ action: "accept", content: { confirm: true } }));
    expect((await none.call()).answer).toBe("absent");
    expect(none.seen.hadElicit).toBe(false);
    await none.close();
    const urlOnly = await connectWith({ url: {} }, () => ({ action: "accept", content: { confirm: true } }));
    expect((await urlOnly.call()).answer).toBe("absent");
    await urlOnly.close();
  });

  it("logs a failed pop-up by the error's name only (fix round 1, c)", async () => {
    const log = vi.fn();
    const failing = await connectWith({ form: {} }, () => { throw new Error("planted-client-words"); }, log);
    expect((await failing.call()).answer).toBe("failed");
    expect(log).toHaveBeenCalledWith({ event: "elicitation.failed", error: expect.any(String) as unknown });
    expect(JSON.stringify(log.mock.calls)).not.toContain("planted-client-words");
    expect(JSON.stringify(log.mock.calls)).not.toContain("ledger-dev");
    await failing.close();
  });
});

describe("fix round 1: a cancelled tool call opens no new confirmation path", () => {
  it("declines with reason cancelled when the tool call is cancelled while the pop-up is open, with or without Slack", async () => {
    for (const [methodsOffered, answer] of [[["elicitation", "slack"], "failed"], [["elicitation"], "failed"], [["elicitation", "slack"], "accept"]] as const) {
      const controller = new AbortController();
      const declineChange = vi.fn(async () => view({ status: "declined" }));
      const startSlackConfirmation = vi.fn(async () => view());
      const applyChange = vi.fn(async () => view({ status: "applied" }));
      const elicit = async () => { controller.abort(); return answer; };
      const { run: r } = run({ declineChange, startSlackConfirmation, applyChange }, { elicit, change: view({ methodsOffered: [...methodsOffered] }), signal: controller.signal });
      await expect(confirmChange(r)).rejects.toMatchObject({ code: "CONFIRMATION_DECLINED", message: expect.stringContaining(CHANGE) as unknown });
      expect(declineChange).toHaveBeenCalledWith(CHANGE, expect.objectContaining({ method: "elicitation", reason: "cancelled" }), "trace-9");
      expect(startSlackConfirmation).not.toHaveBeenCalled();
      expect(applyChange).not.toHaveBeenCalled();
    }
  });

  it("polls with the tool call's signal and one try (a)", async () => {
    const getChange = vi.fn(async () => view({ status: "applied" }));
    const signal = new AbortController().signal;
    const { run: r } = run({ startSlackConfirmation: async () => view(), getChange }, { change: view({ methodsOffered: ["slack"] }), signal });
    await confirmChange(r);
    expect(getChange).toHaveBeenCalledWith(CHANGE, "trace-9", { signal, tries: 1 });
  });

  it("does not fall back to Slack with under a minute left before the change expires (b)", async () => {
    const declineChange = vi.fn(async () => view({ status: "declined" }));
    const startSlackConfirmation = vi.fn(async () => view());
    const { run: r } = run({ declineChange, startSlackConfirmation }, { elicit: async () => "failed" as const, change: view({ expiresAt: "2026-10-02T09:00:40.000Z" }) });
    await expect(confirmChange(r)).rejects.toMatchObject({ code: "CONFIRMATION_DECLINED", message: expect.stringContaining("too little time is left to confirm in Slack") as unknown });
    expect(startSlackConfirmation).not.toHaveBeenCalled();
    expect(declineChange).toHaveBeenCalledWith(CHANGE, expect.objectContaining({ method: "elicitation", reason: "failed" }), "trace-9");
  });

  it("logs why the pop-up failed: its timeout or an error, never words (c)", async () => {
    for (const failure of ["timeout", "error"] as const) {
      let clock = Date.parse("2026-10-02T09:00:01.000Z");
      const log = vi.fn();
      const elicit = async (_message: string, timeoutMs: number) => { clock += failure === "timeout" ? timeoutMs : 100; return "failed" as const; };
      const { run: r } = run({ startSlackConfirmation: async () => view(), getChange: async () => view({ status: "applied" }), declineChange: async () => view({ status: "declined" }) }, { elicit, now: () => clock, sleep: async (ms: number) => { clock += ms; }, log });
      // A timed-out pop-up leaves under a minute, so (b) declines instead of Slack; only the log matters here.
      await confirmChange(r).catch(() => undefined);
      expect(log).toHaveBeenCalledWith({ event: "change.elicitation_failed", changeId: CHANGE, failure });
    }
  });

  it("says a transient apply, decline or Slack failure leaves the change pending, and to ask again (d)", async () => {
    const session = async () => ({ baseUrl: "https://abc123.execute-api.us-east-1.amazonaws.com", accessToken: "t" });
    const transient = () => vi.fn(async () => new Response(JSON.stringify({ error: { code: "RUNTIME_UNAVAILABLE", message: `change ${CHANGE} could not be applied just now; try again` } }), { status: 503 }));
    for (const step of [
      (client: AdminControlPlaneClient) => client.applyChange(CHANGE, { method: "elicitation" }, "t"),
      (client: AdminControlPlaneClient) => client.declineChange(CHANGE, { method: "elicitation", reason: "declined" }, "t"),
      (client: AdminControlPlaneClient) => client.startSlackConfirmation(CHANGE, "t"),
    ]) {
      const failure = await step(httpAdminClient({ session, fetch: transient() })).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "CONTROL_PLANE_UNAVAILABLE" });
      expect((failure as ToolError).nextStep).toContain("still pending");
      expect((failure as ToolError).nextStep).toContain("ask for the change again");
    }
    // A proposal that could not be planned made no pending change.
    const planned = await httpAdminClient({ session, fetch: transient(), tries: 1 }).proposeChange({ requestId: "66666666-6666-4666-8666-666666666666", change: { kind: "unbind_channel", channel: "C0LEDGER01" }, client: { cliVersion: "0.6.0" }, methods: ["slack"] }, "t").catch((error: unknown) => error);
    expect((planned as ToolError).nextStep).not.toContain("still pending");
  });

  it("passes the tool call's signal to a poll's fetch, and tries it once", async () => {
    const session = async () => ({ baseUrl: "https://abc123.execute-api.us-east-1.amazonaws.com", accessToken: "t" });
    const controller = new AbortController();
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => { controller.abort(); expect(init?.signal?.aborted).toBe(true); return new Response(JSON.stringify({ error: { code: "INTERNAL", message: "down" } }), { status: 503 }); });
    await expect(httpAdminClient({ session, fetch: fetch as never, sleep: async () => undefined }).getChange(CHANGE, "t", { signal: controller.signal, tries: 1 })).rejects.toBeInstanceOf(ToolError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
