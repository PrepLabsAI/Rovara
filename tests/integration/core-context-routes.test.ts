import { artifactObjectKey } from "../../packages/broker/src/services/callbacks.js";
import { createHash } from "node:crypto";
import { world as reviewWorld, toRound, nextJob, taskOf, NOW } from "../support/design-review-flow-world.js";
import { COMPANY, SIGNING_KEY } from "../support/task-flow-harness.js";
import { engineStampKey } from "../../packages/broker/src/core-host/engine-stamp.js";
import { allocateSlotBudgets } from "../../packages/broker/src/core/design-review/slot-keys.js";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpClient } from "@earendil-works/pi-mcp";
import { Stack } from "aws-cdk-lib";
import { DesignReviewBindingSchema, DESIGN_REVIEW_INFO_STRING, DesignReviewWorkerResultSchema, agentModelIdentity } from "@agentx/contracts";
import { coreContextWorld, caps, A } from "../support/core-context-world.js";
import { createAdminBroker } from "../support/admin-broker.js";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { normalizedTemplate } from "../support/template-snapshot.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { contextToolsCatalogSource, brokerContextCall } from "../../packages/worker/src/context-sources/bridge.js";
import { brokerPacketSource } from "../../packages/worker/src/design-review-sessions.js";
import { rovaraMcpConfig, rovaraMcpTransport } from "../../packages/worker/src/context-sources/pi-mcp.js";
import { buildReviewerPacket } from "../../packages/broker/src/core/design-review/packet.js";
import { putSlotPackets } from "../../packages/broker/src/core/design-review/packet-store.js";
import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";
import { operationKey, workspaceKey, taskKey } from "../../packages/broker/src/core/task-flow/keys.js";

skipLambdaBundling();
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const stacks = buildAgentXApp({ agentxEnv: "staging" }).node.children.filter((child): child is Stack => Stack.isStack(child));
type Route = { Type: string; Properties: { RouteKey: string; AuthorizationType: string; Target: unknown } };
const template = normalizedTemplate(stacks.find(s => s.stackName === "agentx-staging-control-plane")!) as { Resources: Record<string, Route> };
const routes = Object.values(template.Resources).filter(r => r.Type === "AWS::ApiGatewayV2::Route");
const contextPath = "/v1/internal/context-tools";
const packetPath = "/v1/internal/design-review/packet?slot=r1-critic";

async function setup(models = false, backend?: NonNullable<Parameters<typeof coreContextWorld>[0]>["backend"]) {
  const w = await coreContextWorld({ models, ...(backend === undefined ? {} : { backend }) });
  for (const run of [w.a, w.b]) {
    const packet = await buildReviewerPacket({ role: "critic", design: { ref: "design.md", revision: "r1", text: `## §3 Proposed design\n${run.companyId === A ? "only-alpha" : "only-bravo"}` }, requirements: { ref: "requirements.md", revision: "r1", text: "Add an endpoint." }, baseCommits: {}, sources: [] }, { readRepoFile: async () => undefined, readMetaFile: async () => undefined, fetchMcpItem: async () => ({ ok: false }) });
    const binding = DesignReviewBindingSchema.parse({ version: 1, round: 1, reviewers: [{ role: "critic", model: { provider: "anthropic", modelId: "claude-sonnet-4-6" }, keySlot: "r1-critic", packetDigest: packet.packetDigest }], merge: { keySlot: "r1-merge", model: { provider: "anthropic", modelId: "claude-sonnet-4-6" }, prompt: { id: "merge", version: 1, text: "Merge the reviews." } } });
    await run.put({ ...(await w.world.store.get(operationKey(run.companyId, run.workspaceId, run.operationId)))!, kind: "task", workflowMode: "PLAN_CRITIQUE", designReview: binding });
    if (models) {
      await allocateSlotBudgets(w.world.store, { orgId: run.companyId, operationId: run.operationId, binding, taskRoomUsd: 2, reviewRoomUsd: 2, nowMs: w.world.clock.now });
      await run.put({ ...(await w.world.store.get(operationKey(run.companyId, run.workspaceId, run.operationId)))!, requester: { personId: "a".repeat(64) } });
      await run.put({ ...(await w.world.store.get(taskKey(run.taskId)))!, origin: "app", workflow: { stage: "PLAN_CRITIQUE", designReview: { status: "running", rounds: [] } } });
    }
    await putSlotPackets(w.world.store, { orgId: run.companyId, operationId: run.operationId, round: 1, packets: [{ keySlot: "r1-critic", packet }], nowMs: Date.now() });

  }
  const { handler } = await createAdminBroker({ core: w.root });
  const seen: Array<{ method: string; path: string; headers: Record<string, string>; auth: string }> = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    // HTTP API priority: exact method/path, then method greedy, then ANY greedy.
    const route = routes.find(r => r.Properties.RouteKey === `${method} ${url.pathname}`)
      ?? routes.find(r => r.Properties.RouteKey === `${method} /v1/internal/{proxy+}`)
      ?? routes.find(r => r.Properties.RouteKey === "ANY /{proxy+}");
    expect(route?.Properties.AuthorizationType).toBe("NONE");
    expect(route?.Properties.Target).toEqual(template.Resources.ModelAccessRoute!.Properties.Target);
    seen.push({ method, path: url.pathname, headers, auth: route!.Properties.AuthorizationType });
    const response = await handler({ version: "2.0", rawPath: url.pathname, rawQueryString: url.search.slice(1), headers,
      ...(init?.body === undefined ? {} : { body: init.body }), requestContext: { requestId: randomUUID(), http: { method } } });
    return new Response(response.body || null, { status: response.statusCode, headers: { "content-type": "application/json" } });
  };
  const ask = (path: string, token: string | undefined = w.a.headers["x-agentx-callback-capability"]) => transport(`https://api.example${path}`, { method: "GET", headers: token === undefined ? {} : { "x-agentx-callback-capability": token } });
  return { ...w, transport, seen, ask };
}

describe("hosted context routes through API priority, outer broker and real company runtimes", () => {
  it("serves both companies through the real worker request builders without laptop or JWT headers", async () => {
    const w = await setup();
    for (const [run, own, foreign] of [[w.a, "only-alpha", "only-bravo"], [w.b, "only-bravo", "only-alpha"]] as const) {
      const input = { brokerUrl: "https://api.example", capability: run.headers["x-agentx-callback-capability"], fetch: w.transport };
      expect((await contextToolsCatalogSource(input)())?.searchTeamKnowledge).toBe(true);
      const answer = await brokerContextCall(input)({ requestId: randomUUID(), tool: "search_team_knowledge", arguments: { query: "shared query" } });
      expect(answer.text).toContain(own);
      expect(answer.text).not.toContain(foreign);
      expect(answer.text).toContain('standing="outsider"');
      const packet = await brokerPacketSource(input)({ role: "critic", keySlot: "r1-critic" });
      expect(JSON.stringify(packet)).toContain(own);
      expect(JSON.stringify(packet)).not.toContain(foreign);
    }
    for (const request of w.seen) {
      expect(request.headers).not.toHaveProperty("x-rovara-workspace");
      expect(request.headers).not.toHaveProperty("authorization");
    }
  });

  it("serves reviewer packets and independently checked reviewer and synthesis model access, then refuses a recorded round", async () => {
    const w = await setup(true);
    const packet = await w.ask(packetPath);
    expect(packet.status).toBe(200);
    expect(await packet.text()).toContain("only-alpha");
    const scopes: string[] = [];
    for (const slot of ["r1-critic", "r1-merge"]) {
      const answer = await w.ask(`/v1/internal/model-access?slot=${slot}`);
      const body = await answer.text();
      expect(answer.status, body).toBe(200);
      const token = (JSON.parse(body) as { apiKey: string }).apiKey;
      const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as { cid: string; reviewer: { slot: string } };
      expect(claims.cid).toBe(w.a.companyId);
      expect(claims.reviewer.slot).toBe(slot);
      scopes.push(token);
    }
    expect(scopes[0]).not.toBe(scopes[1]);
    expect((await w.ask("/v1/internal/design-review/packet?slot=r1-merge")).status).toBe(403);
    const task = (await w.world.store.get(taskKey(w.a.taskId)))!;
    await w.a.put({ ...task, workflow: { stage: "PLAN_CRITIQUE", designReview: { status: "done", rounds: [{ round: 1 }] } } });
    expect((await w.ask(packetPath)).status).toBe(403);
    expect((await w.ask("/v1/internal/model-access?slot=r1-critic")).status).toBeGreaterThanOrEqual(400);
  });

  it("records a complete review round through real outer artifact and result callbacks after packet and model delivery", async () => {
    const review = await reviewWorld({ tier: "standard", capUsd: 60 });
    review.runtime.model = async () => ({ selection: agentModelIdentity("claude-sonnet-4-6"), route: { alias: "claude-sonnet-4-6", api: "anthropic-messages", catalog: "claude-sonnet-4-6" }, sourceId: "company-gateway" });
    review.h.deps.modelAccess = { route: async () => ({ alias: "claude-sonnet-4-6", api: "anthropic-messages", catalog: "claude-sonnet-4-6" }) };
    await toRound(review);
    const round = await nextJob(review);
    const binding = DesignReviewBindingSchema.parse(round.operation.designReview);
    // The core hands over at DISPATCHING; its event callback does not rewrite this to RUNNING.
    expect(round.operation.status).toBe("DISPATCHING");
    const w = await setup(true, { store: review.h.store, clock: review.h.clock, signingKey: SIGNING_KEY, companyId: COMPANY, developerId: (await taskOf(review)).developerId });
    await review.h.store.put({ item: { ...engineStampKey(review.taskId), coreEngine: { engine: "core", areas: { flow: "core", build: "core", merge: "core" }, flags: "on", stampedAt: NOW } } });
    await review.h.store.put({ item: { pk: `WORKSPACE#${review.workspaceId}`, sk: "META", entityType: "WORKSPACE_COMPANY_POINTER", workspaceId: review.workspaceId, companyId: COMPANY } });
    const opKey = operationKey(COMPANY, review.workspaceId, round.operation.id);
    await review.h.store.put({ item: { ...(await review.h.store.get(opKey))!, requester: { personId: "a".repeat(64) } } });
    const input = { brokerUrl: "https://api.example", capability: round.invocation.callbackCapability, fetch: w.transport };
    const storedWorkspace = (await review.h.store.get(workspaceKey(COMPANY, review.workspaceId)))!;
    expect({ activeOperationId: storedWorkspace["activeOperationId"], fence: storedWorkspace["fence"] }).toEqual({ activeOperationId: round.operation.id, fence: round.operation.fence });
    const probe = await w.transport(`https://api.example/v1/internal/design-review/packet?slot=${binding.reviewers[0]!.keySlot}`, { method: "GET", headers: { "x-agentx-callback-capability": input.capability } });
    expect(probe.status, await probe.text()).toBe(200);
    const keyIds = new Map<string, string>();
    for (const slot of [...binding.reviewers.map(r => r.keySlot), ...(binding.merge === undefined ? [] : [binding.merge.keySlot])]) {
      const reviewer = binding.reviewers.find(r => r.keySlot === slot);
      if (reviewer !== undefined) expect(await brokerPacketSource(input)({ role: reviewer.role, keySlot: slot })).toMatchObject({ role: reviewer.role });
      const response = await w.transport(`https://api.example/v1/internal/model-access?slot=${slot}`, { method: "GET", headers: { "x-agentx-callback-capability": input.capability } });
      const body = await response.text();
      expect(response.status, body).toBe(200);
      const token = (JSON.parse(body) as { apiKey: string }).apiKey;
      keyIds.set(slot, createHash("sha256").update(token).digest("hex"));
    }
    const result = DesignReviewWorkerResultSchema.parse({ version: 1, round: binding.round, reviewers: binding.reviewers.map((r, index) => ({
      role: r.role, keySlot: r.keySlot, status: "answered", retried: false,
      report: { sessionId: `session-${index}`, packetDigest: r.packetDigest, firstRequestMessages: 2, filesRead: [], tools: ["read"], modelKeyId: keyIds.get(r.keySlot)! },
      answer: `Reviewed.\n\n\`\`\`${DESIGN_REVIEW_INFO_STRING}\n${JSON.stringify({ ...(r.role === "critic" ? { paraphrase: { proposes: "Retry once.", today: "Fails." } } : {}), findings: [] })}\n\`\`\`\n`,
      tokensIn: 100, tokensOut: 10, costUsd: 0.001, startedAt: NOW, endedAt: NOW,
    })), merge: { status: "skipped", tokensIn: 0, tokensOut: 0, costUsd: 0 }, findings: [], mergeSource: "code", omitted: 0, droppedCitations: [], droppedFindings: [], stageTimedOut: false });
    const callbackPath = `https://api.example/v1/internal/workspaces/${review.workspaceId}/operations/${round.operation.id}`;
    // The workflow fixture keeps its earlier documents in memory. File them through the real
    // artifact callback and rebind their identical bytes to the company's hosted artifact keys.
    const task = await taskOf(review);
    const replacements = new Map<string, string>();
    for (const artifact of task.workflow.artifacts) {
      const text = review.blobs.get(artifact.objectKey);
      if (text === undefined) continue;
      const name = `seed-${artifact.type}-${artifact.version}.md`;
      const saved = await w.transport(`${callbackPath}/artifacts`, { method: "POST", headers: { "x-agentx-callback-capability": input.capability }, body: JSON.stringify({ name, mediaType: "text/markdown", content: text }) });
      expect(saved.status, await saved.text()).toBe(200);
      replacements.set(artifact.objectKey, artifactObjectKey(review.workspaceId, round.operation.id, name));
    }
    const workflow = JSON.parse(JSON.stringify(task.workflow), (_key: string, value: unknown) => typeof value === "string" ? replacements.get(value) ?? value : value) as typeof task.workflow;
    await review.h.store.put({ item: toDocument({ ...task, workflow }) });
    for (const [action, body] of [["artifacts", { name: "design-review.json", mediaType: "application/json", content: JSON.stringify(result) }], ["result", { status: "SUCCEEDED" }]] as const) {
      const answer = await w.transport(`${callbackPath}/${action}`, { method: "POST", headers: { "x-agentx-callback-capability": input.capability }, body: JSON.stringify(body) });
      expect(answer.status, await answer.text()).toBe(200);
    }
    expect((await taskOf(review)).workflow.designReview?.rounds).toHaveLength(1);
    expect((await taskOf(review)).workflow.designReview?.rounds[0]?.round).toBe(binding.round);
  });

  it("unsigned callers cannot reach protected data or construct a company runtime", async () => {
    const w = await setup();
    const runtime = vi.spyOn(w.root.app, "runtimeFor");
    const get = vi.spyOn(w.world.store, "get");
    const request = w.a.request();
    const unsigned = await w.transport(`https://api.example${request.path}`, { method: request.method,
      headers: { "x-rovara-workspace": w.a.workspaceId, "x-test-operation": w.a.operationId }, body: request.body });
    expect(await unsigned.text()).not.toContain("only-alpha");
    expect(unsigned.status).toBe(403);
    for (const path of [contextPath, packetPath]) {
      const answer = await w.transport(`https://api.example${path}`, { method: "GET", headers: {} });
      expect(answer.status).toBe(403);
      expect(await answer.text()).not.toContain("only-");
    }
    expect(runtime).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("verifies malformed, expired, wrong-action and unreadable signed claims before company discovery", async () => {
    const w = await setup();
    const runtime = vi.spyOn(w.root.app, "runtimeFor");
    w.reads.length = 0;
    for (const path of [contextPath, packetPath]) for (const token of ["invalid.signature", "x".repeat(4097),
      caps.issue({ workspaceId: w.a.workspaceId, operationId: w.a.operationId, fence: 1, actions: ["context-tools", "design-review-packet"], expiresInSeconds: -1 }),
      caps.issue({ workspaceId: w.a.workspaceId, operationId: w.a.operationId, fence: 1, actions: ["events"], expiresInSeconds: 60 }),
      caps.issue({ workspaceId: "bad", operationId: w.a.operationId, fence: 1, actions: ["context-tools", "design-review-packet"], expiresInSeconds: 60 })]) {
      expect((await w.ask(path, token)).status).toBe(403);
    }
    expect(w.reads).toEqual([]);
    expect(runtime).not.toHaveBeenCalled();
  });

  it("foreign binding cannot read another workspace's data", async () => {
    const w = await setup();
    // A correctly signed B workspace token is paired with A's operation id. Seed an adversarial
    // scoped row so the operation.workspaceId guard, rather than a missing row, must reject it.
    const aOperation = (await w.world.store.get(operationKey(w.a.companyId, w.a.workspaceId, w.a.operationId)))!;
    const bWorkspace = (await w.world.store.get(workspaceKey(w.b.companyId, w.b.workspaceId)))!;
    await w.b.put({ ...bWorkspace, activeOperationId: w.a.operationId });
    await w.b.put({ ...aOperation, ...operationKey(w.b.companyId, w.b.workspaceId, w.a.operationId), companyId: w.b.companyId });
    const token = caps.issue({ workspaceId: w.b.workspaceId, operationId: w.a.operationId, fence: 1, actions: ["context-tools", "design-review-packet"], expiresInSeconds: 60 });
    const query = vi.spyOn(w.world.store, "query");
    const get = vi.spyOn(w.world.store, "get");
    for (const path of [contextPath, packetPath]) expect((await w.ask(path, token)).status).toBeGreaterThanOrEqual(400);
    const request = w.a.request();
    const answer = await w.transport(`https://api.example${request.path}`, { method: request.method, headers: { "x-agentx-callback-capability": token, "x-rovara-workspace": w.a.workspaceId }, body: request.body });
    expect(await answer.text()).not.toContain("only-alpha");
    expect(answer.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
    expect(get.mock.calls.filter(([key]) => key.pk.includes("#DESIGN_REVIEW#"))).toEqual([]);
  });

  it.each(["fence", "inactive", "stage", "cancel", "terminal", "unknown-status", "closed-workspace", "stopped-workspace", "task-stop", "task-released", "task-closed", "task-merged", "membership", "project"])("refuses %s before a packet or Team record read on both GET routes", async kind => {
    const w = await setup();
    const workspace = (await w.world.store.get(workspaceKey(w.a.companyId, w.a.workspaceId)))!;
    const operation = (await w.world.store.get(operationKey(w.a.companyId, w.a.workspaceId, w.a.operationId)))!;
    const task = (await w.world.store.get(taskKey(w.a.taskId)))!;
    if (kind === "fence") await w.a.put({ ...workspace, fence: 2 });
    if (kind === "inactive") await w.a.put({ ...workspace, activeOperationId: randomUUID() });
    if (kind === "stage") await w.a.put({ ...operation, workflowMode: "IMPLEMENT" });
    if (kind === "cancel") await w.a.put({ ...operation, status: "CANCEL_REQUESTED" });
    if (kind === "terminal") await w.a.put({ ...operation, status: "SUCCEEDED" });
    if (kind === "unknown-status") await w.a.put({ ...operation, status: "UNKNOWN" });
    if (kind === "closed-workspace") await w.a.put({ ...workspace, closedAt: new Date().toISOString() });
    if (kind === "stopped-workspace") await w.a.put({ ...workspace, status: "STOPPED" });
    if (kind === "task-stop") await w.a.put({ ...task, stopRequest: { requestId: randomUUID() } });
    if (kind === "task-released") await w.a.put({ ...task, releasedAt: new Date().toISOString() });
    if (kind === "task-closed") await w.a.put({ ...task, closedAt: new Date().toISOString() });
    if (kind === "task-merged") await w.a.put({ ...task, workflow: { stage: "MERGED" } });
    if (kind === "membership") w.members.delete("owner-a");
    if (kind === "project") w.revokeProject();
    const get = vi.spyOn(w.world.store, "get");
    const query = vi.spyOn(w.world.store, "query");
    for (const path of [contextPath, packetPath]) {
      const answer = await w.ask(path);
      expect(answer.status).toBeGreaterThanOrEqual(400);
      expect(await answer.text()).not.toContain("only-");
    }
    expect(query).not.toHaveBeenCalled();
    expect(get.mock.calls.filter(([key]) => key.pk.includes("#DESIGN_REVIEW#"))).toEqual([]);
  });

  it("Pi transport initializes, lists and calls hosted Team record, then receives fatal HTTP 403 after revocation", async () => {
    const w = await setup();
    const url = "https://api.example";
    const transport = rovaraMcpTransport(url, w.a.headers["x-agentx-callback-capability"], w.transport)(rovaraMcpConfig(url).servers[0]!, process.cwd(), undefined);
    const client = new McpClient({ name: "fixture", version: "1", requestTimeoutMs: 2000 });
    try {
      const init = await client.connect(transport);
      expect(JSON.stringify(init)).toContain("serverInfo");
      const list = await client.listTools();
      expect(list.map(tool => tool.name)).toEqual(["search_team_knowledge"]);
      const answer = await client.callTool("search_team_knowledge", { query: "shared query" });
      expect(JSON.stringify(answer)).toContain("only-alpha");
      expect(JSON.stringify(answer)).not.toContain("only-bravo");
      w.revokeProject();
      const query = vi.spyOn(w.world.store, "query");
      await expect(client.callTool("search_team_knowledge", { query: "shared query" })).rejects.toThrow();
      expect(query).not.toHaveBeenCalled();
    } finally { await client.close(); }
    expect(w.seen.every(request => request.headers.authorization?.startsWith("Bearer ") === true)).toBe(true);
  });
});
