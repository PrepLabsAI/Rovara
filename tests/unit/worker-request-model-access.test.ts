import { expect, it, vi } from "vitest";
import { createConfiguredModelRuntime } from "../../packages/model-runtime/src/index.js";
import { modelAccessSource } from "../../packages/worker/src/model-access.js";
import { operationModelProxy } from "../../packages/worker/src/design-review-sessions.js";

const route = { alias: "claude-sonnet-4-6", api: "anthropic-messages", catalog: "claude-sonnet-4-6" } as const;
const boot = "https://old-proxy.example";
const gateway = "https://core-gateway.example";
const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 0 }] };

async function calls(answers: unknown[], proxyUrl: string | undefined) {
  let asked = 0;
  const sent: Array<{ url: string; key: string | null }> = [];
  const proxy = operationModelProxy({ payload: { modelRoute: route }, proxyUrl, controlPlaneUrl: "https://broker.example", capability: "fake",
    fetch: async () => { asked++; return Response.json(answers.shift()); } })!;
  const runtime = await createConfiguredModelRuntime({ provider: "anthropic", modelId: route.alias }, { proxy: { ...proxy, route }, onUsage: () => undefined,
    fetch: async (url, init) => {
      const address = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      sent.push({ url: `${address.origin}${address.pathname}`, key: new Headers(init?.headers).get("x-api-key") });
      return new Response("{}", { status: 400 });
    } });
  const model = runtime.getModel("rovara-route", route.alias)!;
  return { sent, asked: () => asked, call: () => runtime.completeSimple(model, context) };
}

it.each([boot, undefined])("uses the core answer's URL even with boot proxy %s", async (proxyUrl) => {
  const h = await calls([{ baseUrl: gateway, apiKey: "core-key", expiresAt: Date.now() + 120_000 }], proxyUrl);
  await h.call();
  expect(h.sent).toEqual([{ url: `${gateway}/v1/messages`, key: "core-key" }]);
  expect(h.asked()).toBe(1);
});

it("keeps today's proxy when the unswitched broker answers it", async () => {
  const h = await calls([{ baseUrl: boot, apiKey: "legacy-key", expiresAt: Date.now() + 120_000 }], boot);
  await h.call();
  expect(h.sent).toEqual([{ url: `${boot}/v1/messages`, key: "legacy-key" }]);
});

it.each([undefined, "http://rovara-broker:8081/v1/internal/model-proxy", "http://remote.example", "https://user:pass@gateway.example", "https://gateway.example?secret=x", "https://gateway.example#x", "bad"])("falls back for an invalid/absent answer URL (%s), or refuses in fixed words without boot", async (baseUrl) => {
  const answer = { baseUrl, apiKey: "key", expiresAt: Date.now() + 120_000 };
  const h = await calls([answer], boot);
  await h.call();
  expect(h.sent).toEqual([{ url: `${boot}/v1/messages`, key: "key" }]);
  await expect(calls([answer], "")).rejects.toThrow("model access has no usable proxy address");
});

it("refreshes the URL and key together and shares one broker fetch between concurrent callers", async () => {
  let now = 1_000_000, asked = 0;
  const source = modelAccessSource({ controlPlaneUrl: "https://broker.example", capability: "fake", now: () => now,
    fetch: async () => { const n = ++asked; return Response.json({ baseUrl: `https://proxy-${n}.example`, apiKey: `key-${n}`, expiresAt: now + 120_000 }); } });
  expect(await Promise.all([source(), source()])).toEqual(Array(2).fill({ baseUrl: "https://proxy-1.example", apiKey: "key-1", expiresAt: now + 120_000 }));
  now += 60_000;
  expect(await Promise.all([source(), source()])).toEqual(Array(2).fill({ baseUrl: "https://proxy-2.example", apiKey: "key-2", expiresAt: now + 120_000 }));
  expect(asked).toBe(2);
});

it("keeps URL/key pairs through runtime refreshes and concurrent requests", async () => {
  let now = 1_000_000;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const h = await calls([{ baseUrl: "https://first.example", apiKey: "first", expiresAt: now + 120_000 }, { baseUrl: "https://second.example", apiKey: "second", expiresAt: now + 240_000 }], boot);
    await h.call();
    now += 60_000;
    await Promise.all([h.call(), h.call()]);
    expect(h.sent).toEqual([{ url: "https://first.example/v1/messages", key: "first" }, ...Array.from({ length: 2 }, () => ({ url: "https://second.example/v1/messages", key: "second" }))]);
    expect(h.asked()).toBe(2);
  } finally { clock.mockRestore(); }
});

it("keeps an unswitched worker with no boot proxy and no route unchanged", () => {
  expect(operationModelProxy({ payload: {}, proxyUrl: undefined, controlPlaneUrl: "https://broker.example", capability: "fake" })).toBeUndefined();
});

it.each(["http://127.0.0.1:8888", "http://localhost:8888", "http://[::1]:8888"])("permits loopback HTTP in tests (%s)", async (baseUrl) => {
  const source = modelAccessSource({ controlPlaneUrl: "https://broker.example", capability: "fake", fetch: async () => Response.json({ baseUrl, apiKey: "loopback-key", expiresAt: Date.now() + 120_000 }) });
  expect((await source()).baseUrl).toBe(baseUrl);
});
