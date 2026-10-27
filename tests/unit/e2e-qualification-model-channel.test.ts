import { request } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WEB_API_AGENT_PROBE_GOAL, WEB_API_AGENT_PROBE_ROUTE } from "../../packages/contracts/src/index.js";
import type { WebApiProbeModelChannelRequest } from "../../packages/verifier/src/host/web-api-probe-runner.js";
import { createScriptedQualificationModelChannel } from "../../packages/worker/src/e2e-qualification-model-channel.js";
import { installedScriptedModelChannelFactory } from "../../packages/verifier/src/install-qualification-cli.js";
import { CASE_ID, RUN_ID, call, channelRequest } from "../support/e2e-model-fixtures.js";

// Task 4.5: the model channel the agent qualification probes run behind. The worker's real proxy listens on a real socket and answers from the scripted double under a qualification
// policy: no provider, no secret, no spend.
let dir: string;
let socketPath: string;
const closers: Array<() => Promise<unknown>> = [];
beforeEach(async () => { syncSeq = 0; dir = await mkdtemp("/tmp/rvq-"); socketPath = join(dir, "model", "model.sock"); });
afterEach(async () => { for (const close of closers.splice(0)) await close().catch(() => undefined); await rm(dir, { recursive: true, force: true }); });

const probeRequest = (overrides: Partial<WebApiProbeModelChannelRequest> = {}): WebApiProbeModelChannelRequest => ({ probeId: "web-agent-scripted-v1", runId: RUN_ID,
  script: [{ kind: "tap", name: "^Export orders$" }, { kind: "done" }], goal: "export the orders", modelRoute: { ...WEB_API_AGENT_PROBE_ROUTE }, allowedSteps: [{ caseId: CASE_ID, stepIndex: 0 }], ...overrides });
const openInput = (valueKey = "b".repeat(64)) => ({ socketPath, credentialSet: { passwords: ["Sup3r-Secret-Pa$$w0rd!"], emails: ["rovara-owner-a1b2c3@example.test"] }, deadlineAt: Date.now() + 60_000,
  signal: new AbortController().signal, valueKey });
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

describe("the scripted model channel of the agent qualification probes", () => {
  it("listens under a qualification policy with no environment of its own, and answers the first turn with a tap on the node the script names", async () => {
    const opened = await createScriptedQualificationModelChannel(probeRequest(), { environment: {} }).open(openInput());
    closers.push(() => opened.close());
    expect((await stat(socketPath)).isSocket()).toBe(true);
    expect((await post("/v1/step", marker("begin"))).status).toBe(200);
    const reply = await post("/v1/generate", channelRequest({ callOverride: call() }));
    const result = reply.body.result as { status: string; content: Array<{ toolName: string; input: string }> };
    expect(result.status).toBe("ok");
    expect(result.content.map((part) => [part.toolName, JSON.parse(part.input) as unknown])).toEqual([["tap", { target: "n1" }]]);
    expect((await post("/v1/step", marker("end"))).status).toBe(200);
  });

  it("closes with the receipts, the run's own value key, the transcripts and the scripted route's definition, and unlinks the socket", async () => {
    const opened = await createScriptedQualificationModelChannel(probeRequest(), { environment: {} }).open(openInput("c".repeat(64)));
    await post("/v1/step", marker("begin"));
    await post("/v1/generate", channelRequest({ callOverride: call() }));
    await post("/v1/step", marker("end"));
    const closed = await opened.close();
    expect(closed.receipts.map((receipt) => receipt.outcome)).toEqual(["ok"]);
    expect(closed).toMatchObject({ valueKey: "c".repeat(64), routeId: "rovara-scripted/v1", routeRevision: WEB_API_AGENT_PROBE_ROUTE.routeRevision, droppedRequests: 0, unscopedRequests: 0, overrun: false });
    expect(closed.definition).toMatchObject({ routeId: "rovara-scripted/v1", provider: "rovara-scripted", scope: "qualification", secretArn: null });
    expect(closed.transcripts).toHaveLength(1);
    expect(await exists(socketPath)).toBe(false);
  });

  it("refuses a route that is not the scripted one, and a revision of it that is not the worker's, before anything listens", async () => {
    await expect(createScriptedQualificationModelChannel(probeRequest({ modelRoute: { routeId: "rovara-e2e-default", routeRevision: WEB_API_AGENT_PROBE_ROUTE.routeRevision } }), { environment: {} }).open(openInput()))
      .rejects.toMatchObject({ name: "E2EModelChannelUnavailableError" });
    await expect(createScriptedQualificationModelChannel(probeRequest({ modelRoute: { ...WEB_API_AGENT_PROBE_ROUTE, routeRevision: "r1-ffffffffffff" } }), { environment: {} }).open(openInput()))
      .rejects.toMatchObject({ code: "model-route-changed-reapprove" });
    expect(await exists(socketPath)).toBe(false);
  });

  it("refuses a call for a step the group does not have, and answers no goal it has no script for with a receipt that is not ok", async () => {
    const opened = await createScriptedQualificationModelChannel(probeRequest({ goal: "another goal entirely" }), { environment: {} }).open(openInput());
    closers.push(() => opened.close());
    expect((await post("/v1/step", { ...marker("begin"), stepIndex: 5 })).status).not.toBe(200);
    await post("/v1/step", marker("begin"));
    const reply = await post("/v1/generate", channelRequest({ callOverride: call() }));
    expect((reply.body.result as { status: string }).status).toBe("error");
    const closed = await opened.close();
    expect(closed.receipts.map((receipt) => receipt.outcome)).not.toContain("ok");
  });

  it("runs the test seam once the socket is listening, and closes and rethrows when it fails", async () => {
    const seen: string[] = [];
    const opened = await createScriptedQualificationModelChannel(probeRequest(), { environment: {}, afterOpen: (path) => { seen.push(path); } }).open(openInput());
    closers.push(() => opened.close());
    expect(seen).toEqual([socketPath]);
    await opened.close();
    await expect(createScriptedQualificationModelChannel(probeRequest(), { environment: {}, afterOpen: () => { throw new Error("seam failed"); } }).open(openInput())).rejects.toThrow("seam failed");
    expect(await exists(socketPath)).toBe(false);
  });

  it("uses the pinned goal the asset names, and the qualification CLI can load this module from the worker build that sits beside the verifier's", async () => {
    expect(WEB_API_AGENT_PROBE_GOAL).toBe("Export the orders as a CSV file");
    const factory = await installedScriptedModelChannelFactory();
    expect(typeof factory).toBe("function");
    // A worker build that is not there, or does not export the factory, gives none: the agent probes then do not run. Each says so in the log with a fixed, path-free code.
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => { written.push(String(chunk)); return true; }) as never);
    try {
      expect(await installedScriptedModelChannelFactory(new URL("file:///nonexistent/e2e-qualification-model-channel.js"))).toBeUndefined();
      expect(await installedScriptedModelChannelFactory(new URL("../../packages/worker/dist/e2e-model-scripted.js", import.meta.url))).toBeUndefined();
    } finally { spy.mockRestore(); }
    expect(written).toEqual(["worker-scripted-channel-missing\n", "worker-scripted-channel-invalid\n"]);
  });
});
