import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SETUP_AGENT_LIMITS_DEFAULT, WorkerInvocationSchema, type InvocationModelRoute } from "@agentx/contracts";
import { CallbackCapabilities } from "../../packages/broker/src/callbacks.js";
import { createCallbackHandler } from "../../packages/broker/src/services/callbacks.js";
import { createDocumentObjectStorage } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { createTaskTokenDescriber } from "../../packages/broker/src/core/model-gateway/describer.js";
import { operationKey, workspaceKey, taskPointerKey, taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { operationModelProxy } from "../../packages/worker/src/design-review-sessions.js";
import { resolveTaskSessionModel } from "../../packages/worker/src/task-model.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { useScratchDeviceProbeForTests } from "../../packages/worker/src/worker-scratch.js";
import * as nameFiles from "../../packages/worker/src/gateway-name-files.js";
import * as setupNetwork from "../../packages/worker/src/setup-network.js";
import { createHarness, COMPANY } from "../support/task-flow-harness.js";
import { signingWorld } from "../support/model-gateway.js";
import { runPriceFor } from "../support/hosted-run-price.js";
import { hostedBootEnvironment } from "../support/hosted-boot-environment.js";
import { createAdminBroker } from "../support/admin-broker.js";
import type { BrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
const roots: string[] = [];
let restoreScratch: (() => void) | undefined;
afterEach(async () => { restoreScratch?.(); restoreScratch = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
function response(text: string, inputTokens = 1000) {
  return new Response([
    sse("message_start", { type: "message_start", message: { id: "fixture", type: "message", role: "assistant", model: "fixture", content: [], usage: { input_tokens: inputTokens, output_tokens: 0 } } }),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 100 } }),
    sse("message_stop", { type: "message_stop" }),
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}
async function world(mode: "SETUP_AGENT" | "WIKI_BUILD", egress: "bridge" | "gateway", route: InvocationModelRoute, tight = false) {
  const root = await mkdtemp(join(tmpdir(), "hosted-composed-")); roots.push(root);
  const workspaceId = randomUUID(), operationId = randomUUID(), taskId = randomUUID(), person = "a".repeat(64);
  const environment = hostedBootEnvironment(root, workspaceId, egress);
  restoreScratch = useScratchDeviceProbeForTests(async path => path === root ? 1 : 2);
  const createNames = nameFiles.createGatewayNameFiles;
  vi.spyOn(nameFiles, "createGatewayNameFiles").mockImplementation((workspace, dns) => createNames(workspace, dns, join(root, "name-files")));
  expect(environment.AGENTX_MODEL_PROXY_URL).toBeUndefined(); expect(environment.AGENTX_CONTROL_PLANE_URL).toBe("https://broker.example");
  for (const [name, value] of Object.entries(environment)) if (value !== undefined) vi.stubEnv(name, value);
  for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AGENTX_MODEL_PROXY_URL"]) vi.stubEnv(name, "");
  // The worker refuses a state directory inside the workspace (MOUNT_PATH = root here), so it lives in its own temp root.
  // (It passed on macOS only because /var -> /private/var hid the nesting from the unresolved path comparison.)
  const state = await mkdtemp(join(tmpdir(), "hosted-composed-state-")); roots.push(state);
  vi.stubEnv("AGENTX_WORKER_STATE_DIR", state); vi.stubEnv("AGENTX_RUNTIME", "ec2");
  // The real launcher supplies this root-owned firewall fact; Docker is a fake here.
  vi.stubEnv("AGENTX_SETUP_ISOLATION", "ready");
  const directory = join(root, "repo/api"); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), '{"scripts":{"test":"echo ok"}}\n');
  const git = (...args: string[]) => execFileSync("git", ["-C", directory, "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  git("init", "-q"); git("add", "package.json"); git("commit", "-qm", "fixture"); const commit = git("rev-parse", "HEAD").trim();
  await mkdir(join(root, ".agentx"));
  await writeFile(join(root, ".agentx/preparation-manifest.json"), JSON.stringify({ complete: true, projectRevision: 1, repositories: [{ name: "api", path: "repo/api", defaultBranch: "main", resolvedCommit: commit }] }));
  const h = createHarness(); h.clock.now = Date.now(); const tokens = signingWorld();
  h.deps.modelAccess = { route: async () => route };
  const caps = new CallbackCapabilities(Buffer.from(h.deps.callbackSigningKey));
  const capability = caps.issue({ workspaceId, operationId, fence: 1, actions: ["model-access"], expiresInSeconds: 900 });
  await h.store.put({ item: { ...operationKey(COMPANY, workspaceId, operationId), id: operationId, workspaceId, companyId: COMPANY, kind: "task", workflowMode: mode, fence: 1, status: "RUNNING", requester: { personId: person } } });
  await h.store.put({ item: { ...workspaceKey(COMPANY, workspaceId), id: workspaceId, companyId: COMPANY, projectName: "payments", activeOperationId: operationId, fence: 1, status: "BUSY" } });
  await h.store.put({ item: { ...taskPointerKey(COMPANY, workspaceId), taskId } });
  await h.store.put({ item: { ...taskKey(taskId), taskId, workspaceId, project: "payments", companyId: COMPANY, origin: "app", ...(mode === "WIKI_BUILD" ? { purpose: "wiki_build" } : {}) } });
  let price = runPriceFor(route.alias, h.clock.now);
  const handler = createCallbackHandler({ flow: h.deps, blobs: createDocumentObjectStorage(h.store, { companyId: COMPANY }), grants: { exchange: async () => ({ token: "unused" }) }, modelGateway: { gatewayUrl: "https://gateway.example", issuer: "https://install-a.example/v1/auth", signer: tokens.signer, describer: createTaskTokenDescriber(h.deps), runPrice: async () => route.catalog === "unpriced" ? undefined : price } });
  const broker = await createAdminBroker({ core: { callback: handler } as BrokerCoreRoot });
  const get = (token = capability) => broker.handler({ version: "2.0", routeKey: "GET /v1/internal/model-access", rawPath: "/v1/internal/model-access", rawQueryString: "", headers: { "x-agentx-callback-capability": token }, requestContext: { requestId: randomUUID(), http: { method: "GET" } } });
  const payload = { conversationId: randomUUID(), prompt: "Build pinned context", workflowMode: mode, modelRoute: route,
    ...(mode === "SETUP_AGENT" ? { setupAgent: { limits: { ...SETUP_AGENT_LIMITS_DEFAULT, ...(tight ? { budgetCents: 100 } : {}) }, commits: [{ repository: "api", commit }] } } : { wikiBuild: { limits: { pages: 1, budgetCents: 10000, wallClockMin: 1, pageReserveCents: 10 }, pins: [{ repo: "api", commit }] } }) };
  const job = WorkerInvocationSchema.parse({ protocolVersion: 1, kind: "task", operationId, workspaceId, fence: 1, projectRevision: 1, callbackCapability: capability, payload });
  if (job.kind !== "task") throw new Error("task expected");
  let accessCapability = capability;
  const proxy = operationModelProxy({ payload: job.payload, proxyUrl: undefined, controlPlaneUrl: environment.AGENTX_CONTROL_PLANE_URL!, capability, fetch: async () => { const answer = await get(accessCapability); return new Response(answer.body, { status: answer.statusCode }); } })!;
  const selected = await resolveTaskSessionModel(job.payload, undefined, environment, undefined, proxy);
  const outbound: Array<{ url: string; model: unknown; claims: unknown }> = [];
  const proposal = `\`\`\`agentx-setup-proposal\n${JSON.stringify({ setup: [{ repo: "api", commands: ["npm test"], from: [{ kind: "file", repo: "api", path: "package.json", line: 1, quote: '"scripts"' }] }] })}\n\`\`\``;
  const draft = { pageId: "overview", sections: [{ heading: "API", claims: [{ text: "The API defines a test script.", citations: [{ repo: "api", path: "package.json", commit, startLine: 1, endLine: 1 }] }] }], links: [] };
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const address = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (new URL(address).origin + new URL(address).pathname !== "https://gateway.example/v1/messages" || [...new URL(address).searchParams].some(([key, value]) => key !== "beta" || value !== "true")) throw new Error(`unexpected outbound ${address}`);
    const key = new Headers(init?.headers).get("x-api-key")!;
    outbound.push({ url: new URL(address).origin + new URL(address).pathname, model: (JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { model: unknown }).model, claims: tokens.reference(key, Math.floor(h.clock.now / 1000)) });
    return response(mode === "SETUP_AGENT" ? proposal : JSON.stringify(draft), tight ? 20_000 : 1_000);
  });
  const dockerCalls: string[][] = [];
  const docker = { run: async (args: readonly string[]) => { dockerCalls.push([...args]);
    if (args[0] === "inspect" && args.some(arg => arg.includes("MacAddress"))) return { exitCode: 0, stdout: "02:42:ac:1c:fa:02", stderr: "" };
    if (args[0] === "exec" && args.some(arg => arg.includes("/sys/class/net/"))) return { exitCode: 0, stdout: "123", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" }; } };
  vi.spyOn(setupNetwork, "startRunNetwork").mockImplementation(async () => { dockerCalls.push(["network"]); return { name: "fixture", subnet: "172.29.1.0/24", gateway: "172.29.1.1", helperName: "fixture-helper", helperIp: "172.29.1.2", sandboxIp: "172.29.1.3", readBlocked: async () => [], stop: async () => undefined }; });
  const bodies: unknown[] = [];
  let next = 0;
  const callback = async (body: unknown) => { bodies.push(body);
    const stored = (await h.store.get(operationKey(COMPANY, workspaceId, operationId)))!;
    await h.store.put({ item: { ...stored, testCallbackReport: JSON.parse(JSON.stringify(body)) as never } }); if ((body as { kind: string }).kind === "next") return next++ === 0 ? { kind: "page", page: { id: "overview", kind: "overview" }, pins: [{ repo: "api", commit }], instructions: "Return the cited page JSON", spendCeilingCents: tight ? 100 : 10000 } : { kind: "end", word: "built" }; return { ok: true, kept: true, complete: true }; };
  return { get, h, job, root, environment, selected, outbound, bodies, dockerCalls, callback, docker, person, commit, setAccessToken: (token: string) => { accessCapability = token; }, setPrice: (value: typeof price) => { price = value; },
    run: () => runTaskInvocation(job, { rootPath: root, ...selected, eventSink: async () => undefined, artifactSink: async () => undefined,
      taskShell: { kind: "sandbox", environment, docker, image: environment.AGENTX_SANDBOX_IMAGE! }, docker, setupAgent: callback, wikiBuild: callback }) };
}
describe("composed generated boot / broker / selected session / setup and wiki", () => {
  for (const mode of ["SETUP_AGENT", "WIKI_BUILD"] as const) for (const egress of ["bridge", "gateway"] as const) {
    it(`${mode} runs without a laptop proxy in ${egress} mode with exact company/model claims and positive spend`, async () => {
      const t = await world(mode, egress, { alias: "zai.glm-5", api: "anthropic-messages", catalog: "zai.glm-5" });
      const result = await t.run();
      expect(result).toBeDefined(); expect(t.outbound).toHaveLength(1);
      expect(t.outbound[0]).toMatchObject({ url: "https://gateway.example/v1/messages", model: "zai.glm-5", claims: { cid: COMPANY, ws: t.job.workspaceId, op: t.job.operationId, mdl: ["zai.glm-5"], runPrice: { model: "zai.glm-5", sourceId: "operator-ai" } } });
      expect(JSON.stringify({ result, callbacks: t.bodies })).toMatch(/spen[dt]Cents[^0-9]*[1-9]/);
      if (mode === "SETUP_AGENT") expect(result).toHaveProperty("setupProposal");
      else expect(t.bodies).toContainEqual(expect.objectContaining({ kind: "page", answer: expect.objectContaining({ draft: expect.objectContaining({ pageId: "overview" }) as unknown }) as unknown }));
    });
  }
  it.each(["SETUP_AGENT", "WIKI_BUILD"] as const)("%s refuses absent authority before network, sandbox or provider session", async mode => {
    const t = await world(mode, "bridge", { alias: "unpriced", api: "anthropic-messages", catalog: "unpriced" });
    await expect(t.run()).rejects.toThrow("model's price");
    expect(t.dockerCalls).toEqual([]); expect(t.outbound).toEqual([]); expect(t.bodies).toEqual([]);
  });
});

for (const mode of ["SETUP_AGENT", "WIKI_BUILD"] as const) {
  it.each([
    { alias: "claude-haiku-4-5", catalog: "claude-haiku-4-5", api: "anthropic-messages" },
    { alias: "company-alias", catalog: "zai.glm-5", api: "anthropic-messages" },
  ] as const)(`${mode} binds the wire alias to the gateway price ($alias)`, async route => {
    const t = await world(mode, "bridge", route);
    await t.run(); expect(t.outbound).toHaveLength(1); expect(t.outbound[0]?.model).toBe(route.alias);
  });
  it(`${mode} ends before another model call when the next turn no longer fits`, async () => {
    const t = await world(mode, "bridge", { alias: "zai.glm-5", catalog: "zai.glm-5", api: "anthropic-messages" }, true);
    const result = await t.run(); expect(t.outbound).toHaveLength(1);
    expect(JSON.stringify({ result, bodies: t.bodies })).toContain("budget_used");
  });
  it.each(["capability", "stale-fence", "wrong-company"])(`${mode} refuses %s access before allocation`, async denial => {
    const t = await world(mode, "bridge", { alias: "zai.glm-5", catalog: "zai.glm-5", api: "anthropic-messages" });
    if (denial === "capability") t.setAccessToken("invalid");
    else {
      const key = operationKey(COMPANY, t.job.workspaceId, t.job.operationId);
      const operation = (await t.h.store.get(key))!;
      await t.h.store.put({ item: { ...operation, ...(denial === "stale-fence" ? { fence: 2 } : { companyId: "org_bbbbbbbbbbbbbbbbbbbb" }) } });
    }
    await expect(t.run()).rejects.toThrow("model access request failed");
    expect(t.outbound).toEqual([]); expect(t.dockerCalls).toEqual([]); expect(t.bodies).toEqual([]);
  });
}
