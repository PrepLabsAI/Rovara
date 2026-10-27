import { request } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { e2eModelRouteRevision } from "../../packages/contracts/src/e2e-model-channel.js";
import { createInMemoryE2EDayBudget, type E2EInvoke } from "../../packages/model-runtime/src/e2e-route.js";
import { deriveE2EAgentRoute, e2eAgentInstallationFromEnvironment, scriptedE2ERouteDefinition } from "../../packages/model-runtime/src/e2e-route-derive.js";
import {
  E2EModelChannelUnavailableError, createE2EModelEvidenceCollector, defaultE2EModelSocketOwner, openE2EModelChannelSession,
  type E2EModelChannelSession, type OpenE2EModelChannelSessionOptions,
} from "../../packages/worker/src/e2e-model-channel-session.js";
import { cleanRedirectingEnvironment } from "../support/e2e-clean-environment.js";
import { CASE_ID, RUN_ID, SECRET_ARN, call, channelRequest, tapAnswer } from "../support/e2e-model-fixtures.js";

// Task 4.3a, test case 5: the session opens only for a group with an agent step, runs the guards before it listens, and closes on every exit.

let dir: string;
let socketPath: string;
let sessions: E2EModelChannelSession[] = [];

beforeEach(async () => {
  cleanRedirectingEnvironment();
  dir = await mkdtemp(join(tmpdir(), "rs-"));
  socketPath = join(dir, "model", "model.sock");
  sessions = [];
  syncSeq = 0;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const session of sessions) await session.close().catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

const scripted = { routeId: "rovara-scripted/v1", routeRevision: e2eModelRouteRevision(scriptedE2ERouteDefinition()) };
const scriptedEnv = { ROVARA_E2E_SCRIPTED_MODEL: "1" };
const anthropicEnv = { AGENTX_MODEL_PROVIDER: "anthropic", AGENTX_ANTHROPIC_SECRET_ARN: SECRET_ARN, AWS_REGION: "us-east-1" };
const anthropicRoute = (() => {
  const derived = deriveE2EAgentRoute(e2eAgentInstallationFromEnvironment(anthropicEnv), 1);
  if (derived.status !== "available") throw new Error("fixture");
  return { routeId: derived.definition.routeId, routeRevision: e2eModelRouteRevision(derived.definition) };
})();
const okInvoke: E2EInvoke = async () => tapAnswer();

function options(overrides: Partial<OpenE2EModelChannelSessionOptions> = {}): OpenE2EModelChannelSessionOptions {
  return {
    runId: RUN_ID, modelRoute: scripted, policyScope: "standard", socketPath, allowedSteps: [{ caseId: CASE_ID, stepIndex: 0 }],
    credentialSet: { passwords: ["Sup3r-Secret-Pa$$w0rd!"], emails: ["rovara-owner-a1b2c3@example.test"], cookieValues: [] },
    deadlineAt: Date.now() + 60_000, dayBudget: createInMemoryE2EDayBudget(), evidence: createE2EModelEvidenceCollector(), signal: new AbortController().signal,
    environment: scriptedEnv, invoke: okInvoke, ...overrides,
  };
}
async function open(overrides: Partial<OpenE2EModelChannelSessionOptions> = {}): Promise<E2EModelChannelSession> {
  const session = await openE2EModelChannelSession(options(overrides));
  sessions.push(session);
  return session;
}
const exists = (path: string) => stat(path).then(() => true, () => false);

/** Every model call is made under a session sync (MIDSTEPCOOKIE): a call posted here is first preceded by its own sync, as the executor's client does. */
let syncSeq = 0;
async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  if (path === "/v1/generate" && typeof body === "object" && body !== null && !("syncSeq" in body)) {
    syncSeq += 1;
    await rawPost("/v1/sync", { schemaVersion: "rovara-e2e-model-channel/v1", runId: RUN_ID, syncSeq, values: [] });
    return rawPost(path, { ...body, syncSeq });
  }
  return rawPost(path, body);
}
function rawPost(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}
const marker = (kind: "begin" | "end") => ({ schemaVersion: "rovara-e2e-model-channel/v1", runId: RUN_ID, marker: kind, caseId: CASE_ID, stepIndex: 0 });

describe("openE2EModelChannelSession", () => {
  it("opens a listening socket for a group with an agent step, and serves a marker, a call and the end marker (positive control)", async () => {
    const evidence = createE2EModelEvidenceCollector();
    const session = await open({ evidence });
    expect(session.socketPath).toBe(socketPath);
    expect((await stat(socketPath)).isSocket()).toBe(true);
    expect((await post("/v1/step", marker("begin"))).status).toBe(200);
    const reply = await post("/v1/generate", channelRequest({ callOverride: call() }));
    expect((reply.body.result as { status: string }).status).toBe("ok");
    expect((await post("/v1/step", marker("end"))).status).toBe(200);
    const summary = await session.close();
    expect(summary.receipts.map((receipt) => receipt.outcome)).toEqual(["ok"]);
    expect(summary).toMatchObject({ routeId: "rovara-scripted/v1", routeRevision: scripted.routeRevision, droppedRequests: 0, unscopedRequests: 0 });
    expect(evidence.receipts()).toHaveLength(1);
    expect(await exists(socketPath)).toBe(false);
  });

  it("never opens for a group with no agent step, even though the admission names a route: nothing listens and no directory is made", async () => {
    await expect(openE2EModelChannelSession(options({ allowedSteps: [] }))).rejects.toMatchObject({ name: "E2EModelChannelUnavailableError", code: "model-channel-not-needed" });
    expect(await exists(socketPath)).toBe(false);
    expect(await exists(join(dir, "model"))).toBe(false);
  });

  it("refuses a route the worker's settings do not reproduce with model-route-changed-reapprove, before anything listens or a provider is built", async () => {
    const invoke = vi.fn(okInvoke);
    await expect(openE2EModelChannelSession(options({ modelRoute: anthropicRoute, environment: { ...anthropicEnv, AGENTX_ANTHROPIC_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/test/other-key-ZyXwVu" }, invoke })))
      .rejects.toMatchObject({ code: "model-route-changed-reapprove" });
    await expect(openE2EModelChannelSession(options({ modelRoute: { ...scripted, routeRevision: "r1-ffffffffffff" }, invoke }))).rejects.toMatchObject({ code: "model-route-changed-reapprove" });
    expect(invoke).not.toHaveBeenCalled();
    expect(await exists(socketPath)).toBe(false);
  });

  it("refuses a scripted route outside a qualification policy unless ROVARA_E2E_SCRIPTED_MODEL=1, and one with no script in this process", async () => {
    await expect(openE2EModelChannelSession(options({ environment: {} }))).rejects.toMatchObject({ code: "agent-route-not-approved" });
    await expect(openE2EModelChannelSession(options({ environment: scriptedEnv, invoke: undefined as never }))).rejects.toMatchObject({ code: "agent-route-not-approved" });
    expect((await open({ environment: {}, policyScope: "qualification" })).socketPath).toBe(socketPath);
  });

  it("runs the environment guard before it listens, naming the variable and never its value", async () => {
    const guarded = await openE2EModelChannelSession(options({ modelRoute: anthropicRoute, environment: { ...anthropicEnv, AWS_ACCESS_KEY_ID: "AKIASECRETVALUE000000" }, assertSharedConfig: () => undefined }))
      .catch((error: unknown) => error);
    expect(guarded).toBeInstanceOf(E2EModelChannelUnavailableError);
    expect((guarded as E2EModelChannelUnavailableError).code).toBe("model-environment-unsafe");
    expect((guarded as Error).message).toMatch(/AWS_ACCESS_KEY_ID/);
    expect((guarded as Error).message).not.toContain("AKIASECRETVALUE000000");
    expect(await exists(socketPath)).toBe(false);
  });

  it("runs the shared-config guard before it listens", async () => {
    const shared = vi.fn(() => { throw new Error("this worker's shared AWS files can redirect or re-authenticate model calls (~/.aws/config sets endpoint_url)"); });
    await expect(openE2EModelChannelSession(options({ modelRoute: anthropicRoute, environment: anthropicEnv, assertSharedConfig: shared })))
      .rejects.toMatchObject({ code: "model-environment-unsafe", message: expect.stringMatching(/endpoint_url/) as string });
    expect(shared).toHaveBeenCalledTimes(1);
    expect(await exists(socketPath)).toBe(false);
    // Positive control: with both guards quiet, the same real route listens.
    expect((await open({ modelRoute: anthropicRoute, environment: anthropicEnv, assertSharedConfig: () => undefined })).socketPath).toBe(socketPath);
  });

  it("the scripted route is exempt from the two guards, because it calls no provider", async () => {
    const shared = vi.fn(() => { throw new Error("must not run"); });
    const session = await open({ environment: { ...scriptedEnv, AWS_ACCESS_KEY_ID: "AKIAEXEMPTSCRIPTED0000" }, assertSharedConfig: shared });
    expect(shared).not.toHaveBeenCalled();
    expect(session.socketPath).toBe(socketPath);
  });

  it("close() unlinks the socket, returns the receipts, and is safe to call again", async () => {
    const session = await open();
    const first = await session.close();
    expect(await exists(socketPath)).toBe(false);
    expect(await session.close()).toBe(first);
  });

  it("closes itself when the run is aborted, and unlinks the socket", async () => {
    const abort = new AbortController();
    const session = await open({ signal: abort.signal });
    expect(await exists(socketPath)).toBe(true);
    abort.abort();
    const summary = await session.close();
    expect(summary.receipts).toEqual([]);
    expect(await exists(socketPath)).toBe(false);
  });

  it("holds the executor's markers to the steps it was given and to its run", async () => {
    await open();
    expect((await post("/v1/step", { ...marker("begin"), stepIndex: 9 })).status).toBe(403);
    expect((await post("/v1/step", { ...marker("begin"), runId: "11111111-2222-4333-8444-555555555555" })).status).toBe(403);
    expect((await post("/v1/step", marker("begin"))).status).toBe(200);
  });

  it("hands the socket to the executor's user (1000) when the worker runs as root, and to no one otherwise", () => {
    vi.spyOn(process, "getuid").mockReturnValue(0);
    expect(defaultE2EModelSocketOwner()).toEqual({ uid: 1000, gid: 1000 });
    vi.spyOn(process, "getuid").mockReturnValue(501);
    expect(defaultE2EModelSocketOwner()).toBeUndefined();
  });
});
