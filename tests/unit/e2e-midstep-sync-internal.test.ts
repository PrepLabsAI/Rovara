import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGovernedE2EModelRoute, createInMemoryE2EDayBudget } from "../../packages/model-runtime/src/e2e-route.js";
import { startE2EModelProxy, type E2EModelProxy } from "../../packages/worker/src/e2e-model-proxy.js";
import { cleanRedirectingEnvironment } from "../support/e2e-clean-environment.js";
import { CASE_ID, RUN_ID, bedrockRoute, call, channelRequest, tapAnswer } from "../support/e2e-model-fixtures.js";

// MIDSTEPCOOKIE fix round 2, N-1: whatever fails while a sync is served is a fixed refusal. The spelling builder is made to throw for one marker value (it cannot throw on a real one any more),
// so this is the proof that the handler itself does not let an error end the worker.
vi.mock("../../packages/worker/src/e2e-secret-spellings.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../packages/worker/src/e2e-secret-spellings.js")>();
  return { ...original, e2eSecretSpellingsDetailed: (value: string) => { if (value.includes("THROW-HERE")) throw new Error("the builder failed"); return original.e2eSecretSpellingsDetailed(value); } };
});

let dir: string;
let proxy: E2EModelProxy | undefined;
const unhandled: unknown[] = [];
const onUnhandled = (error: unknown) => { unhandled.push(error); };
beforeEach(async () => { cleanRedirectingEnvironment(); dir = await mkdtemp(join(tmpdir(), "si-")); unhandled.length = 0; process.on("unhandledRejection", onUnhandled); process.on("uncaughtException", onUnhandled); });
afterEach(async () => { process.off("unhandledRejection", onUnhandled); process.off("uncaughtException", onUnhandled); await proxy?.close().catch(() => undefined); proxy = undefined; await rm(dir, { recursive: true, force: true }); });

function postJson(socketPath: string, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

describe("a sync that throws inside the worker", () => {
  it("is answered with a fixed refusal, leaves no token, ends no one, and the next sync and call work", async () => {
    const seen: unknown[] = [];
    const route = createGovernedE2EModelRoute(bedrockRoute(), { invoke: async (input) => { seen.push(input.call); return tapAnswer(); }, now: Date.now, dayBudget: createInMemoryE2EDayBudget() });
    const socketPath = join(dir, "m.sock");
    proxy = await startE2EModelProxy({ socketPath, runId: RUN_ID, route, credentialSet: { passwords: [], emails: [], cookieValues: [] }, evidence: { writeReceipt() { /* no */ }, writeTranscript() { /* no */ } },
      deadlineAt: Date.now() + 60_000, environment: {}, allowedSteps: [{ caseId: CASE_ID, stepIndex: 0 }] });
    proxy.beginStep({ caseId: CASE_ID, stepIndex: 0 });
    const frame = { schemaVersion: "rovara-e2e-model-channel/v1", runId: RUN_ID };
    const refused = await postJson(socketPath, "/v1/sync", { ...frame, values: ["THROW-HERE-0123456789abcdef"] });
    expect(refused).toMatchObject({ status: 500, body: { status: "refused", code: "internal" } });
    expect(JSON.stringify(refused.body)).not.toMatch(/builder|failed|THROW/);
    // No token came out of it: a call cannot cover itself.
    const uncovered = await postJson(socketPath, "/v1/generate", channelRequest({ callIndex: 0, syncToken: "c".repeat(32) }));
    expect((uncovered.body["result"] as { message: string }).message).toMatch(/^session-sync-stale:/);
    // The worker is still up: the next sync is accepted and its call is served.
    const synced = await postJson(socketPath, "/v1/sync", { ...frame, values: [] });
    expect(synced.status).toBe(200);
    const served = await postJson(socketPath, "/v1/generate", channelRequest({ callIndex: 1, syncToken: synced.body["syncToken"] as string, callOverride: call() }));
    expect((served.body["result"] as { status: string }).status).toBe("ok");
    expect(seen).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(unhandled).toEqual([]);
  });
});
