// Hosted MCP journey (turn-on lane, DEC 254zzz461): the Pi MCP switch is gone, so a HOSTED worker now always opens Pi's MCP client on the control plane's
// `POST /v1/internal/mcp` when its stage has sources. This runs that path end to end at the deepest level that runs on a Mac:
//   - the core with the hosted wiring (`createBrokerCoreRoot`, Team record on) accepts a real task's PLAN stage; the dispatch it builds says `contextSources`
//     and lists the `context-tools` capability action (a project whose Team record is off gets neither);
//   - the broker handler answers over real HTTP, each request resolved against the routes of the synthesized `agentx-staging-control-plane` template
//     (exact route, then `POST /v1/internal/{proxy+}`, authorization NONE), as API Gateway would;
//   - the WORKER is `runTaskInvocation` with the dependencies main.ts hands it (same bridge functions, same `mcp` entry, NO `ROVARA_PI_MCP` in the
//     environment), the real Pi agent loop and Pi's real MCP client, a scripted model, and no Docker.
// Not covered here (only the post-install proof on a real EC2 worker covers it): the worker process booted from boot.sh/main.ts, the real API Gateway and
// broker Lambda in front of the route, the VPC DNS firewall and the real model.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Stack } from "aws-cdk-lib";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { orgProjectCatalogKey, projectRevisionKey, type OrgId, type StoredDocument, type WorkerInvocation } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { createBrokerCoreServices } from "../../packages/broker/src/aws/core-job-services.js";
import { taskKeySigner } from "../../packages/broker/src/core-host/gateway-model-access.js";
import { CallbackCapabilities } from "../../packages/broker/src/callbacks.js";
import { createTeamRecord } from "../../packages/broker/src/team-record/record.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { acceptStep, readWorkspace } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { brokerContextCall, contextToolsCatalogSource } from "../../packages/worker/src/context-sources/bridge.js";
import { createDefaultPiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import type { WorkerEvent } from "../../packages/worker/src/events.js";
import { createAdminBroker } from "../support/admin-broker.js";
import { createFakeWorld } from "../support/core-host-fakes.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { signedRunPriceResponse } from "../support/signed-run-price-fetch.js";
import { makeKey, signerOf } from "../unit/policy-hook-fixture.js";
import { normalizedTemplate } from "../support/template-snapshot.js";

skipLambdaBundling();
const adapters = vi.hoisted(() => ({ modules: [] as unknown[] }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", async (original) => ({ ...await original<object>(), codeAdapterModules: () => adapters.modules }));
vi.mock("../../packages/broker/src/core-host/company-instructions-http.js", async (original) => ({ ...await original<object>(), companyInstructionsModules: () => [] }));

const A: OrgId = "org_aaaaaaaaaaaaaaaaaaaa";
const PERSON = "a".repeat(64);
const PROJECT = "payments";
const SIGNING_KEY = "k".repeat(32);
const TOOL = "mcp__rovara__search_team_knowledge";
const MARKER = "only-alpha-ledger-rule";
const plain = (value: unknown): StoredDocument => JSON.parse(JSON.stringify(value)) as StoredDocument;
const project = { name: PROJECT, revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }] };

// The synthesized staging API: what API Gateway would route a worker's request to.
type Route = { Type: string; Properties: { RouteKey: string; AuthorizationType: string; Target: unknown } };
const stacks = buildAgentXApp({ agentxEnv: "staging" }).node.children.filter((child): child is Stack => Stack.isStack(child));
const template = normalizedTemplate(stacks.find((stack) => stack.stackName === "agentx-staging-control-plane")!) as { Resources: Record<string, Route> };
const routes = Object.values(template.Resources).filter((resource) => resource.Type === "AWS::ApiGatewayV2::Route");

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

/** The hosted core, one company, one project, one member who owns the task; `teamOn` is the Team record switch of the install. */
async function hostedCore(teamOn: boolean) {
  const w = createFakeWorld();
  w.clock.now = Date.now();
  // The core's price read goes to the stub; the worker's own requests (to the test control plane on 127.0.0.1) go through the real fetch.
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => signedRunPriceResponse(input, [A], ["claude-sonnet-4-6"], w.clock.now) ?? (new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).hostname === "127.0.0.1" ? realFetch(input, init) : Response.json({}, { status: 404 })));
  adapters.modules = w.modules.filter((module) => ["storage", "queue", "worker-machines", "object-storage", "code-host", "check-runner", "secrets"].includes(module.point));
  const live = { member: true, grant: true };
  const client = { async send(command: unknown) {
    if (!(command instanceof GetCommand)) throw new Error("only fake point reads");
    const key = command.input.Key as { pk: string; sk: string };
    if (key.pk.startsWith("COMPANY_MEMBER#")) return { Item: live.member ? { ...key, entityType: "COMPANY_MEMBERSHIP", personId: PERSON, companyId: A, role: "owner", joinedAt: new Date(w.clock.now).toISOString() } : undefined };
    if (/^ORG#org_[0-9a-z]{20}#MEMBER#/u.test(key.pk)) return { Item: live.grant ? { ...key, projectName: PROJECT, role: "developer" } : undefined };
    return { Item: await w.store.get(key) };
  } };
  const root = createBrokerCoreRoot({
    taskRules: () => ({ taskPeopleStart: async () => [] }) as never,
    env: { ROVARA_CORE_MODEL_GATEWAY_URL: "https://gateway.example", ROVARA_CORE_AGENT_MODEL: "claude-sonnet-4-6", ...(teamOn ? { ROVARA_CORE_LESSONS: "on" } : {}) },
    taskTokens: () => ({ signer: taskKeySigner(signerOf(makeKey("t".repeat(16)))), issuer: "https://api.example/v1/auth" }),
    documentClient: client, stateTableName: "state", signInTableName: "signin", callbackSigningKey: SIGNING_KEY, repositoryGrantKey: Buffer.alloc(32, 1),
    repositoryCredential: async () => ({ token: "fake" }), codeModules: () => ({}) as never,
    origin: () => "https://api.example", now: () => new Date(w.clock.now), log: () => undefined,
    ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
    services: (companyId, flow, registry, wiring) => createBrokerCoreServices({ companyId, flow, registry, ciMode: wiring.ciMode!, now: () => new Date(w.clock.now) }),
    lessonsPeople: () => ({ approvers: async () => ({ complete: true, membershipVersion: 1, ownerIds: [], eligibleIds: [], lastEligibleLossAtMs: null }), onProjectRoster: async () => true, linkedAccounts: async () => [], displayName: async () => "Member", isErased: async () => false }),
  });
  await w.store.put({ item: plain({ ...projectRevisionKey(A, PROJECT, 1), definition: project }) });
  await w.store.put({ item: { ...orgProjectCatalogKey(A, PROJECT), latestRevision: 1 } });
  return { w, root, live };
}

/** A task started on the hosted core and its PLAN stage accepted: the operation the worker is dispatched for, and the dispatch the core built for it. */
async function acceptedPlanStage(teamOn: boolean) {
  const core = await hostedCore(teamOn);
  const reply = await core.root.coreTasks!.route({ method: "POST", path: "/v1/dev/tasks", headers: {}, body: JSON.stringify({ requestId: randomUUID(), project: PROJECT, instructions: "Add a health endpoint", workflow: true }) }, { developerId: PERSON, sessionId: "session", name: "Member" });
  expect(reply?.statusCode, reply?.body).toBe(200);
  const deps = (await core.root.app.runtimeFor(A)).flow.deps;
  const taskId = (JSON.parse(reply!.body) as { task: { taskId: string } }).task.taskId;
  const task = (await readTask(deps, taskId))!;
  // The workspace is free for a step (the machine handshake is not what this file is about).
  const held = (await readWorkspace(deps, task.workspaceId))!;
  await core.w.store.put({ item: plain({ ...held, status: "READY", activeOperationId: null }) });
  const workspace = (await readWorkspace(deps, task.workspaceId))!;
  // The Team record of the project holds a decision written by another task of the same company.
  await createTeamRecord({ store: core.w.store, companyId: A, now: () => core.w.clock.now }).put({ project: PROJECT, taskId: randomUUID(), authorId: PERSON, kind: "decision", text: `ledger rule ${MARKER}: every refund is booked twice`, sourceRef: "decision-1", occurredAt: new Date(core.w.clock.now).toISOString() });
  const accepted = await acceptStep(deps, { task, workspace, requestId: randomUUID(), prompt: "plan it", workflowMode: "PLAN" });
  expect(accepted.result).toBe("STARTED");
  const operation = accepted.operation!;
  return { ...core, task, taskId, workspaceId: task.workspaceId, operation, dispatch: operation.dispatch };
}

interface Seen { method: string; path: string; rpc?: string; status: number; authorization: boolean }

/** The control plane over real HTTP: every request goes through the staging template's route table, then the broker handler (the hosted core root behind it). */
async function controlPlane(core: Awaited<ReturnType<typeof acceptedPlanStage>>, onRequest: (rpc: string | undefined) => Promise<void> = async () => undefined) {
  const { handler } = await createAdminBroker({ core: core.root });
  const seen: Seen[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const url = new URL(request.url ?? "/", "http://control-plane.test");
        const method = request.method ?? "GET";
        // HTTP API priority: exact method and path, then the method's greedy route, then ANY greedy.
        const route = routes.find((entry) => entry.Properties.RouteKey === `${method} ${url.pathname}`)
          ?? routes.find((entry) => entry.Properties.RouteKey === `${method} /v1/internal/{proxy+}`)
          ?? routes.find((entry) => entry.Properties.RouteKey === "ANY /{proxy+}");
        expect(route?.Properties.AuthorizationType).toBe("NONE");
        const rpc = body.startsWith("{") ? (JSON.parse(body) as { method?: string }).method : undefined;
        await onRequest(rpc);
        const headers = Object.fromEntries(Object.entries(request.headers).flatMap(([name, value]) => (typeof value === "string" ? [[name, value]] : [])));
        const reply = await handler({ version: "2.0", rawPath: url.pathname, rawQueryString: url.search.slice(1), headers, ...(body === "" ? {} : { body }), requestContext: { requestId: randomUUID(), http: { method } } });
        seen.push({ method, path: url.pathname, ...(rpc === undefined ? {} : { rpc }), status: reply.statusCode, authorization: headers.authorization?.startsWith("Bearer ") === true });
        response.writeHead(reply.statusCode, { "content-type": "application/json" }).end(reply.body);
      })().catch((error: unknown) => { response.writeHead(500).end(String(error)); });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, seen };
}

const toolNames = (context: TranscriptContext) => getCurrentTools(context.messages).map((tool) => tool.name).sort();
const PLAN = planAnswer(planDocument({ title: "Add the health endpoint" }));

/** The worker, as hosted runs it: `runTaskInvocation` with main.ts's context-source wiring over the control plane's URL, and no ROVARA_PI_MCP anywhere. */
async function runWorker(core: Awaited<ReturnType<typeof acceptedPlanStage>>, cp: { url: string }, capability: string) {
  expect(process.env.ROVARA_PI_MCP).toBeUndefined();
  const rootPath = await mkdtemp(join(tmpdir(), "hosted-mcp-journey-"));
  cleanup.push(() => rm(rootPath, { recursive: true, force: true }));
  await mkdir(join(rootPath, ".agentx"));
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({ schemaVersion: 2, projectName: PROJECT, projectRevision: 1, repositories: [], completedSetupSteps: [], readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: new Date().toISOString() }));
  const state = await mkdtemp(join(tmpdir(), "hosted-mcp-state-"));
  cleanup.push(() => rm(state, { recursive: true, force: true }));
  vi.stubEnv("AGENTX_WORKER_STATE_DIR", state);
  const offered: string[][] = [];
  const seenByModel: string[] = [];
  const { modelRuntime, faux } = await fauxModelRuntime();
  faux.setResponses([
    (context: TranscriptContext) => { offered.push(toolNames(context)); return fauxAssistantMessage([fauxToolCall(TOOL, { query: "ledger rule" }, { id: "t1" })], { stopReason: "toolUse" }); },
    (context: TranscriptContext) => { seenByModel.push(JSON.stringify(context.messages.at(-1))); return fauxAssistantMessage(PLAN); },
  ]);
  const piAdapter = createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) });
  const sent: WorkerEvent[] = [];
  const artifacts: Array<{ name: string; content: string }> = [];
  const bridgeCalls: unknown[] = [];
  const operation = core.operation;
  const invocation: WorkerInvocation = {
    protocolVersion: 1, kind: "task", operationId: operation.id, workspaceId: core.workspaceId, fence: operation.fence, projectRevision: 1, callbackCapability: capability,
    // The payload is what the hosted core built for the stage (conversation, prompt, mode and `contextSources` when the Team record is on).
    payload: core.dispatch.payload as never,
  };
  const controlPlaneUrl = cp.url;
  // main.ts's `contextSources` (packages/worker/src/main.ts, task invocation): the catalog and call over the control plane, and the rovara MCP server, no switch.
  const contextSources = {
    catalog: contextToolsCatalogSource({ brokerUrl: controlPlaneUrl, capability: invocation.callbackCapability }),
    call: (async (...args: Parameters<ReturnType<typeof brokerContextCall>>) => { bridgeCalls.push(args[0]); return brokerContextCall({ brokerUrl: controlPlaneUrl, capability: invocation.callbackCapability })(...args); }) as ReturnType<typeof brokerContextCall>,
    mcp: { brokerUrl: controlPlaneUrl, capability: invocation.callbackCapability },
  };
  const settled = await runTaskInvocation(invocation, {
    rootPath, model: FAUX_MODEL, piAdapter, eventSink: async (batch) => { sent.push(...batch); }, artifactSink: async (artifact) => { artifacts.push({ name: artifact.name, content: String(artifact.content) }); },
    log: () => undefined, contextSources,
  }).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error: error as { code?: string; message: string } }));
  return { settled, offered, seenByModel, sent, artifacts, bridgeCalls, faux };
}

/** The capability the dispatcher mints for the operation: the same signing key as the core's, the dispatch's own actions. */
function capabilityFor(core: Awaited<ReturnType<typeof acceptedPlanStage>>): string {
  return new CallbackCapabilities(Buffer.from(SIGNING_KEY)).issue({ workspaceId: core.workspaceId, operationId: core.operation.id, fence: core.operation.fence, actions: ["artifacts", "events", "result", ...(core.dispatch.extraActions ?? [])] as never, expiresInSeconds: 600 });
}

describe("hosted worker, Team record on: the stage opens the MCP session on /v1/internal/mcp and reads a Team record result", () => {
  it("dispatches the stage with sources, then the worker's MCP client lists and calls search_team_knowledge over the hosted route", async () => {
    const core = await acceptedPlanStage(true);
    expect(core.dispatch.payload).toMatchObject({ contextSources: true, workflowMode: "PLAN" });
    expect(core.dispatch.extraActions).toContain("context-tools");
    expect(core.dispatch.requires).toContain("task.contextSources.v1");
    const cp = await controlPlane(core);
    const run = await runWorker(core, cp, capabilityFor(core));
    expect(run.settled).toEqual({ ok: true });

    // Pi's MCP client did the session: initialize, tools/list and one tools/call, all POST /v1/internal/mcp with the capability as the bearer.
    const mcp = cp.seen.filter((request) => request.path === "/v1/internal/mcp");
    expect(mcp.every((request) => request.method === "POST" && request.authorization && request.status < 400)).toBe(true);
    expect(mcp.map((request) => request.rpc)).toEqual(expect.arrayContaining(["initialize", "tools/list", "tools/call"]));
    // The model was offered the MCP tool (and not the bridge's bare tool) and was shown the Team record's answer, framed as untrusted source text.
    expect(run.offered[0]).toContain(TOOL);
    expect(run.offered[0]).not.toContain("search_team_knowledge");
    const shown = JSON.parse(run.seenByModel[0]!) as { content: Array<{ text: string }> };
    const text = shown.content.map((block) => block.text).join("\n");
    expect(text).toContain(MARKER);
    expect(text).toContain("<source-result");
    // The stage finished with its plan, and the source's words are in no stored event (the stub replaces them).
    expect(run.artifacts.map((artifact) => artifact.name)).toContain("plan.md");
    expect(JSON.stringify(run.sent)).toContain(TOOL);
    expect(JSON.stringify(run.sent)).not.toContain(MARKER);
  }, 60_000);

  it("uses no bridge tool path: no call to context-tools/call, none of the worker's own context tools; only the catalog list is read", async () => {
    const core = await acceptedPlanStage(true);
    const cp = await controlPlane(core);
    const run = await runWorker(core, cp, capabilityFor(core));
    expect(run.settled).toEqual({ ok: true });
    expect(run.bridgeCalls).toEqual([]);
    expect(cp.seen.filter((request) => request.path === "/v1/internal/context-tools/call")).toEqual([]);
    expect(cp.seen.filter((request) => request.path === "/v1/internal/context-tools").map((request) => request.method)).toEqual(["GET"]);
    expect(run.offered.flat().filter((name) => name === "search_team_knowledge" || name.startsWith("src_"))).toEqual([]);
  }, 60_000);

  it.each([
    ["the owner's project grant is revoked", (core: Awaited<ReturnType<typeof acceptedPlanStage>>) => { core.live.grant = false; }],
    ["the owner leaves the company", (core: Awaited<ReturnType<typeof acceptedPlanStage>>) => { core.live.member = false; }],
  ])("%s while the stage runs: the MCP call is refused and the stage ends with CALLBACK_FORBIDDEN, before the model reads any record", async (_name, revoke) => {
    const core = await acceptedPlanStage(true);
    const cp = await controlPlane(core, async (rpc) => { if (rpc === "tools/call") revoke(core); });
    const run = await runWorker(core, cp, capabilityFor(core));
    expect(run.settled).toMatchObject({ ok: false, error: { code: "CALLBACK_FORBIDDEN" } });
    const call = cp.seen.filter((request) => request.path === "/v1/internal/mcp" && request.rpc === "tools/call");
    expect(call.map((request) => request.status)).toEqual([403]);
    expect(run.seenByModel).toEqual([]);
    // Only the evidence files remain; no plan was saved, and no record text is in any artifact.
    expect(run.artifacts.map((artifact) => artifact.name)).not.toContain("plan.md");
    expect(JSON.stringify(run.artifacts)).not.toContain(MARKER);
    expect(JSON.stringify(run.sent)).not.toContain(MARKER);
    expect(run.bridgeCalls).toEqual([]);
  }, 60_000);

  it("a capability the core does not accept (signed by another key) is refused on the hosted route and the stage ends with CALLBACK_FORBIDDEN", async () => {
    const core = await acceptedPlanStage(true);
    const cp = await controlPlane(core);
    const foreign = new CallbackCapabilities(Buffer.from("x".repeat(32))).issue({ workspaceId: core.workspaceId, operationId: core.operation.id, fence: core.operation.fence, actions: ["context-tools"], expiresInSeconds: 600 });
    const run = await runWorker(core, cp, foreign);
    expect(run.settled).toMatchObject({ ok: false, error: { code: "CALLBACK_FORBIDDEN" } });
    expect(cp.seen.every((request) => request.status === 403)).toBe(true);
    expect(run.offered).toEqual([]);
  }, 60_000);
});

describe("hosted worker, Team record off: no sources, so no MCP session", () => {
  it("dispatches the stage without sources and the worker sends no request to /v1/internal/mcp or to any context route", async () => {
    const core = await acceptedPlanStage(false);
    expect(core.dispatch.payload).not.toHaveProperty("contextSources");
    expect(core.dispatch.extraActions ?? []).not.toContain("context-tools");
    const cp = await controlPlane(core);
    const run = await runWorker(core, cp, capabilityFor(core));
    expect(cp.seen.filter((request) => request.path.startsWith("/v1/internal/"))).toEqual([]);
    expect(run.offered[0] ?? []).not.toContain(TOOL);
  }, 60_000);
});

describe("wiring pin: main.ts hands the hosted worker the MCP session with no switch", () => {
  it("passes the rovara MCP server unconditionally and nothing in the worker reads ROVARA_PI_MCP", async () => {
    const main = await readFile(join(process.cwd(), "packages/worker/src/main.ts"), "utf8");
    const block = main.slice(main.indexOf("contextSources: {"), main.indexOf("workflowE2EAdmission"));
    expect(block).toContain("catalog: contextToolsCatalogSource({ brokerUrl: controlPlaneUrl, capability: invocation.callbackCapability");
    expect(block).toContain("call: brokerContextCall({ brokerUrl: controlPlaneUrl, capability: invocation.callbackCapability })");
    // Unconditional: no environment read, no ternary, no spread around it.
    expect(block).toMatch(/\n\s*mcp: \{ brokerUrl: controlPlaneUrl, capability: invocation\.callbackCapability \},/u);
    for (const file of ["main.ts", "run-task.ts", "pi-session.ts", "context-sources/bridge.ts", "context-sources/pi-mcp.ts"]) {
      expect(await readFile(join(process.cwd(), "packages/worker/src", file), "utf8"), file).not.toContain("ROVARA_PI_MCP");
    }
  });
});
