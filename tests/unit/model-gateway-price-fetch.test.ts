import { beforeAll, expect, it, vi } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
it("bounds streaming bytes, total deadline, status and final URL without real fetch", async () => {
  const { fetchTransport, LITELLM_URL } = await import("../../packages/model-gateway/src/price-sources.js");
  const fake = (body: ConstructorParameters<typeof Response>[0], url = LITELLM_URL, status = 200): typeof fetch => async (_input, init) => { expect(init?.redirect).toBe("error"); const response = new Response(body, { status }); Object.defineProperty(response, "url", { value: url }); return response; };
  const options = { maxBytes: 3, timeoutMs: 100, signal: new AbortController().signal };
  expect((await fetchTransport(fake("abc")).get(LITELLM_URL, options)).body).toEqual(Buffer.from("abc"));
  for (const fn of [fake("abcd"), fake("abc", "https://example.invalid/private"), fake("abc", LITELLM_URL, 500)]) await expect(fetchTransport(fn).get(LITELLM_URL, options)).rejects.toThrow("price fetch unavailable");
  for (const url of ["http://raw.githubusercontent.com/a", "https://example.invalid/a", `${LITELLM_URL}?private-canary`]) await expect(fetchTransport(fake("abc")).get(url, options)).rejects.toThrow("price fetch unavailable");
  vi.useFakeTimers();
  try { const pending = fetchTransport(async () => new Promise<Response>(() => undefined)).get(LITELLM_URL, options); const assertion = expect(pending).rejects.toThrow("price fetch unavailable"); await vi.advanceTimersByTimeAsync(100); await assertion; } finally { vi.useRealTimers(); }
});
it("schedule runs immediately, retries failures, never overlaps, unrefs and stops", async () => {
  const { startPriceRefresh } = await import("../../packages/model-gateway/src/price-refresh.js");
  const scheduled: Array<{ fn: () => void; ms: number; unref: ReturnType<typeof vi.fn> }> = []; const cleared: unknown[] = []; let runs = 0;
  const refresher = { run: async () => ({ ok: ++runs > 1, gained: 0 }) };
  const schedule = startPriceRefresh({ refresher, intervalMs: 100, retryMs: 10, random: () => 0, timers: { setTimer: (fn, ms) => { const handle = { fn, ms, unref: vi.fn() }; scheduled.push(handle); return handle; }, clearTimer: (timer) => { cleared.push(timer); } } });
  await Promise.resolve(); expect(runs).toBe(1); expect(scheduled[0]?.ms).toBe(10); expect(scheduled[0]?.unref).toHaveBeenCalledOnce();
  scheduled[0]!.fn(); await Promise.resolve(); expect(runs).toBe(2); expect(scheduled[1]?.ms).toBe(100);
  schedule.stop(); expect(cleared).toEqual([scheduled[1]]); scheduled[1]!.fn(); await Promise.resolve(); expect(runs).toBe(2);
});
it("a whole-source deadline bounds a transport that ignores abort", async () => {
  const { fetchLiteLLM } = await import("../../packages/model-gateway/src/price-sources.js");
  vi.useFakeTimers();
  try { const pending = fetchLiteLLM({ get: () => new Promise(() => undefined) }, { deadlineMs: 50 }); await vi.advanceTimersByTimeAsync(50); expect(await pending).toEqual({ ok: false, reason: "invalid source" }); } finally { vi.useRealTimers(); }
});
it("jitter never delays a refresh beyond its daily interval", async () => {
  const { startPriceRefresh } = await import("../../packages/model-gateway/src/price-refresh.js");
  let delay = 0;
  const handle = startPriceRefresh({ refresher: { run: async () => ({ ok: true, gained: 0 }) }, intervalMs: 100, random: () => 1, timers: { setTimer: (_fn, ms) => { delay = ms; return {}; }, clearTimer: () => undefined } });
  await Promise.resolve(); expect(delay).toBeGreaterThanOrEqual(95); expect(delay).toBeLessThanOrEqual(100); handle.stop();
});
