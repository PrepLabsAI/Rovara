import { mkdtemp, rm } from "node:fs/promises";
import type * as Guard from "../../packages/worker/src/e2e-model-credential-guard.js";
import type * as Spellings from "../../packages/worker/src/e2e-secret-spellings.js";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGovernedE2EModelRoute, createInMemoryE2EDayBudget } from "../../packages/model-runtime/src/e2e-route.js";
import { createE2ESessionSyncLedger } from "../../packages/worker/src/e2e-model-session-sync.js";
import { startE2EModelProxy, type E2EModelProxy } from "../../packages/worker/src/e2e-model-proxy.js";
import { cleanRedirectingEnvironment } from "../support/e2e-clean-environment.js";
import { CASE_ID, RUN_ID, bedrockRoute, call, channelRequest, tapAnswer } from "../support/e2e-model-fixtures.js";

// MIDSTEPCOOKIE fix round 2, N-1: whatever fails while a sync is served is a fixed refusal. The spelling builder is made to throw for one marker value (it cannot throw on a real one any more),
// so this is the proof that the handler itself does not let an error end the worker.
vi.mock("../../packages/worker/src/e2e-secret-spellings.js", async (importOriginal) => {
  const original = await importOriginal<typeof Spellings>();
  return { ...original, e2eSecretSpellingsDetailed: (value: string) => {
    if (value.includes("THROW-HERE")) throw new Error("the builder failed");
    // An encoder that fails all the same: the percent forms are skipped and the ledger records the gap.
    if (value.includes("SKIP-HERE")) return { forms: [value], skipped: ["percent-encoded"] };
    return original.e2eSecretSpellingsDetailed(value);
  } };
});
// The guard cannot be built once, on demand: the failure between "the sync was understood" and "the scan was updated".
const control = vi.hoisted(() => ({ failGuardOnce: false }));
vi.mock("../../packages/worker/src/e2e-model-credential-guard.js", async (importOriginal) => {
  const original = await importOriginal<typeof Guard>();
  return { ...original, createE2ECredentialGuard: (...args: Parameters<typeof original.createE2ECredentialGuard>) => {
    if (control.failGuardOnce) { control.failGuardOnce = false; throw new Error("the guard could not be built"); }
    return original.createE2ECredentialGuard(...args);
  } };
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

describe("a sync that fails between the ledger and the scan", () => {
  it("records nothing, so the retry rebuilds the scan: a value is never recorded but not scanned for (no fail-open on retry)", async () => {
    const seen: unknown[] = [];
    const route = createGovernedE2EModelRoute(bedrockRoute(), { invoke: async (input) => { seen.push(input.call); return tapAnswer(); }, now: Date.now, dayBudget: createInMemoryE2EDayBudget() });
    const socketPath = join(dir, "g.sock");
    proxy = await startE2EModelProxy({ socketPath, runId: RUN_ID, route, credentialSet: { passwords: [], emails: [], cookieValues: [] }, evidence: { writeReceipt() { /* no */ }, writeTranscript() { /* no */ } },
      deadlineAt: Date.now() + 60_000, environment: {}, allowedSteps: [{ caseId: CASE_ID, stepIndex: 0 }] });
    proxy.beginStep({ caseId: CASE_ID, stepIndex: 0 });
    const frame = { schemaVersion: "rovara-e2e-model-channel/v1", runId: RUN_ID };
    const value = "retry-session-value-9f8e7d6c5b4a";
    control.failGuardOnce = true;
    const failed = await postJson(socketPath, "/v1/sync", { ...frame, values: [value] });
    expect(failed).toMatchObject({ status: 500, body: { code: "internal" } });
    // The executor's retry sends the same value again: it is still new, the scan is rebuilt, and a token is issued.
    const retried = await postJson(socketPath, "/v1/sync", { ...frame, values: [value] });
    expect(retried.status).toBe(200);
    const shown = await postJson(socketPath, "/v1/generate", channelRequest({ callIndex: 0, syncToken: retried.body["syncToken"] as string, callOverride: call(`#n1 text "${value}"`) }));
    expect((shown.body["result"] as { code: string }).code).toBe("refused-credential-match");
    expect(seen).toHaveLength(0);
  });

  it("records the gap when a spelling cannot be built for an accepted value", () => {
    const ledger = createE2ESessionSyncLedger();
    expect(ledger.accept({ schemaVersion: "rovara-e2e-model-channel/v1", runId: RUN_ID, values: ["SKIP-HERE-0123456789abcdef"] }, RUN_ID)).toMatchObject({ ok: true });
    expect(ledger.spellingGaps).toBe(1);
    expect(ledger.accept({ schemaVersion: "rovara-e2e-model-channel/v1", runId: RUN_ID, values: ["a-plain-value-0123456789abcdef"] }, RUN_ID)).toMatchObject({ ok: true });
    expect(ledger.spellingGaps).toBe(1);
  });
});

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
