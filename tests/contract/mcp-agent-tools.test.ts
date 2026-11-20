// Plan 3 Task 35a: the MCP tools for agents. The start tools pass `agent` and `input` through; `agentx_list_agents` and `agentx_run_agent` reach
// the agent routes; `agentx_list_approvals` returns each pending approval with its summary, full arguments and plain confirmation link, and `agentx_open_approval` asks for one approval's ticketed link for the person. No tool decides a
// write approval, a step or chain-gate approval, a spend request or a comment-trigger opt-out (R3-4): the person decides on the page.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import type { DeveloperTaskView, StartDeveloperTaskRequest } from "@agentx/contracts";
import { createAgentXMcpServer, httpControlPlaneClient, type ControlPlaneClient, type ToolContext } from "../../packages/mcp/src/index.js";

const TASK = "44444444-4444-4444-8444-444444444444";
const AGT = "agt_aaaaaaaaaaaaaaaaaaaa";
const APR = "apr_bbbbbbbbbbbbbbbbbbbb";
const CELL = "https://abc123.execute-api.us-west-2.amazonaws.com";
const CONFIRM = `${CELL}/v1/app/approve/${APR}`;
const view: DeveloperTaskView = {
  taskId: TASK, title: "Triage", project: "payments", status: "RUNNING", startingRevision: 7, client: "Claude Code", shared: false,
  createdAt: "2026-10-22T09:00:00.000Z", updatedAt: "2026-10-22T09:00:00.000Z", events: [],
};
const structured = (result: unknown) => (result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
const text = (result: unknown) => (result as { content?: Array<{ text: string }> }).content?.[0]?.text ?? "";

async function connect(client: Partial<ControlPlaneClient>) {
  const context = (name: string | undefined): ToolContext => ({
    client: client as ControlPlaneClient, clientName: name, serverVersion: "0.4.0",
    adminSignedIn: async () => false, compatibility: async () => ({ env: "staging", apiVersion: "1.2" }),
    now: () => 0, sleep: async () => undefined, newRequestId: () => "33333333-3333-4333-8333-333333333333",
  });
  const server = createAgentXMcpServer({ version: "0.4.0", context });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: "claude-code", version: "1.0.0" });
  await mcp.connect(clientSide);
  return mcp;
}

describe("agentx_start_task and agentx_start_workflow take an agent and its input", () => {
  it("passes agent and input through, with the instructions as the input's text", async () => {
    const seen: StartDeveloperTaskRequest[] = [];
    const mcp = await connect({ startTask: async (request) => { seen.push(request); return view; } });
    await mcp.callTool({ name: "agentx_start_task", arguments: {
      project: "payments", instructions: "Triage the failing build",
      agent: { agent_id: AGT, version: "draft" }, input: { context: [{ kind: "alert", ref: "https://ci.acme.dev/run/1", title: "CI run" }] },
    } });
    await mcp.callTool({ name: "agentx_start_workflow", arguments: {
      project: "payments", instructions: "Fix it", workflow_path: "quick", agent: { agent_id: "rovara-code", version: 2 },
    } });
    expect(seen[0]).toMatchObject({ project: "payments", instructions: "Triage the failing build", agent: { agentId: AGT, version: "draft" }, input: { text: "Triage the failing build", context: [{ kind: "alert", ref: "https://ci.acme.dev/run/1", title: "CI run" }] } });
    expect(seen[1]).toMatchObject({ workflow: true, workflowPath: "QUICK", agent: { agentId: "rovara-code", version: 2 }, input: { text: "Fix it" } });
  });

});

describe("agentx_list_agents and agentx_run_agent", () => {
  it("lists the agents a project may run", async () => {
    const listAgents = vi.fn(async () => [{ agentId: AGT, name: "Triage helper", builtin: false, status: "active", access: "use" }]);
    const mcp = await connect({ listAgents });
    const result = await mcp.callTool({ name: "agentx_list_agents", arguments: { project: "payments" } });
    expect(listAgents).toHaveBeenCalledWith({ project: "payments" });
    expect(structured(result)).toMatchObject({ agents: [{ agent_id: AGT, name: "Triage helper", builtin: false }] });
  });

});

describe("agentx_run_agent when the version asked for waits for the agent's owner (owner decision 2026-10-22)", () => {
  const WAITING = { status: "NEEDS_OWNER_APPROVAL", confirmUrl: CONFIRM, changes: ["Runs version 1 of Triage on payments, which is less safe than the version that runs now (version 3)"] };

  it("is an error that says nothing started and gives the link for the owner, and no task", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json(WAITING, { status: 202 }));
    const client = httpControlPlaneClient({ session: async () => ({ baseUrl: CELL, accessToken: "t", signInCommand: "x" }), fetch: fetchImplementation, sleep: async () => undefined });
    const refused = await client.runAgent(AGT, { requestId: "33333333-3333-4333-8333-333333333333", project: "payments", version: 1, input: { text: "go" } }).then(() => undefined, (error: { code?: string; message: string; nextStep?: string }) => error);
    expect(refused).toMatchObject({ code: "OWNER_APPROVAL_NEEDED" });
    expect(refused!.message).toContain(CONFIRM);
    expect(refused!.message).toContain("Nothing started");
    expect(refused!.nextStep).toMatch(/owner/);
    const mcp = await connect({ runAgent: client.runAgent.bind(client) });
    const result = await mcp.callTool({ name: "agentx_run_agent", arguments: { agent_id: AGT, project: "payments", input: "go", version: 1 } });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text(result)).toContain(CONFIRM);
  });
});

describe("agentx_list_approvals", () => {
  it("returns each pending approval with its summary, full arguments and the bare confirmation link, and mints no ticket (review M2)", async () => {
    const args = { title: "Flaky retry test", labels: ["bug"] };
    const approvalConfirmLink = vi.fn(async () => ({ confirmUrl: `${CONFIRM}?ticket=t1`, ticketed: true }));
    const client: Partial<ControlPlaneClient> = {
      listApprovals: vi.fn(async () => [{ approvalId: APR, kind: "write", status: "PENDING", summary: "Create a Linear issue", confirmUrl: CONFIRM }]),
      getApproval: vi.fn(async () => ({ approvalId: APR, kind: "write", status: "PENDING", summary: "Create a Linear issue", arguments: args, confirmUrl: CONFIRM })),
      approvalConfirmLink,
    };
    const result = await (await connect(client)).callTool({ name: "agentx_list_approvals", arguments: {} });
    expect(structured(result)).toEqual({ approvals: [{ approval_id: APR, kind: "write", status: "PENDING", summary: "Create a Linear issue", arguments: args, confirm_url: CONFIRM }] });
    expect(text(result)).toContain(CONFIRM);
    expect(text(result)).not.toContain("ticket=");
    expect(approvalConfirmLink).not.toHaveBeenCalled();
  });

  it("names the connector scope and, for GitHub, the repository of a write, so two calls that differ only by them read differently (final review access I-1)", async () => {
    const one = { approvalId: APR, kind: "write", status: "PENDING", summary: "Review a pull request", connector: "github", tool: "create_pull_request_review", scope: "payments-api", repository: "acme/payments-api", arguments: { pull_number: 12 }, confirmUrl: CONFIRM };
    const client: Partial<ControlPlaneClient> = {
      listApprovals: vi.fn(async () => [{ approvalId: APR, kind: "write", status: "PENDING", confirmUrl: CONFIRM }]),
      getApproval: vi.fn(async () => one),
    };
    const result = await (await connect(client)).callTool({ name: "agentx_list_approvals", arguments: {} });
    expect((structured(result)["approvals"] as Array<Record<string, unknown>>)[0]).toMatchObject({ scope: "payments-api", repository: "acme/payments-api" });
    expect(text(result)).toContain("acme/payments-api");
  });

  it("reaches the routes: the list, each approval, and the confirm-link POST, never the decide route", async () => {
    const calls: string[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
      if (url.pathname === "/v1/app/approvals") return Response.json({ approvals: [{ approvalId: APR, kind: "write", status: "PENDING", summary: "s", confirmUrl: CONFIRM }] });
      if (url.pathname === `/v1/app/approvals/${APR}`) return Response.json({ approval: { approvalId: APR, kind: "write", status: "PENDING", summary: "s", arguments: { a: 1 }, confirmUrl: CONFIRM } });
      if (url.pathname === `/v1/app/approvals/${APR}/confirm-link`) return Response.json({ confirmUrl: CONFIRM, ticketed: false });
      if (url.pathname === "/v1/app/agents") return Response.json({ agents: [] });
      if (url.pathname === `/v1/app/agents/${AGT}/runs`) return Response.json({ task: view }, { status: 202 });
      return Response.json({ error: { code: "NOT_FOUND", message: "no" } }, { status: 404 });
    });
    const client = httpControlPlaneClient({ session: async () => ({ baseUrl: CELL, accessToken: "t", signInCommand: "x" }), fetch: fetchImplementation, sleep: async () => undefined });
    expect(await client.listApprovals()).toHaveLength(1);
    expect(await client.getApproval(APR)).toMatchObject({ arguments: { a: 1 } });
    expect(await client.approvalConfirmLink(APR)).toEqual({ confirmUrl: CONFIRM, ticketed: false });
    expect(await client.listAgents({ project: "payments" })).toEqual([]);
    expect((await client.runAgent(AGT, { requestId: "33333333-3333-4333-8333-333333333333", project: "payments", input: { text: "go" } })).taskId).toBe(TASK);
    expect(calls).toEqual([
      "GET /v1/app/approvals?status=PENDING", `GET /v1/app/approvals/${APR}`, `POST /v1/app/approvals/${APR}/confirm-link`,
      "GET /v1/app/agents?project=payments", `POST /v1/app/agents/${AGT}/runs`,
    ]);
  });

});

describe("agentx_open_approval (review M2)", () => {
  it("asks for one approval's confirmation link, once, and decides nothing", async () => {
    const approvalConfirmLink = vi.fn(async () => ({ confirmUrl: `${CONFIRM}?ticket=t1`, ticketed: true }));
    const result = await (await connect({ approvalConfirmLink })).callTool({ name: "agentx_open_approval", arguments: { approval_id: APR } });
    expect(approvalConfirmLink).toHaveBeenCalledTimes(1);
    expect(approvalConfirmLink).toHaveBeenCalledWith(APR);
    expect(structured(result)).toEqual({ approval_id: APR, confirm_url: `${CONFIRM}?ticket=t1` });
    expect(text(result)).toContain(`${CONFIRM}?ticket=t1`);
  });

});

describe("the start tools with an agent (review M10)", () => {
  it("names the instructions' 8,192-byte limit, not the context, when they are too long for an agent", async () => {
    const startTask = vi.fn(async () => view);
    const result = await (await connect({ startTask })).callTool({ name: "agentx_start_task", arguments: { project: "payments", instructions: "x".repeat(9_000), agent: { agent_id: AGT } } });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text(result)).toContain("8,192");
    expect(text(result)).toMatch(/instructions/);
    expect(startTask).not.toHaveBeenCalled();
  });
});
