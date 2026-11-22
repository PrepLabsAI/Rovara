import type { serverReadWorld as createServerReadWorld } from "../support/server-read-world.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serverReadContext } from "../../packages/broker/src/aws/server-read-context.js";
import { COMPANY_READ_LIMITS } from "../../packages/broker/src/aws/company-check.js";

afterEach(() => vi.useRealTimers());
describe("one cancellable server read context", () => {
  it.each([0, 1, 100])("charges %i actual SDK rows once, including empty replies", async (count) => {
    const send = vi.fn(async () => ({ Items: Array.from({ length: count }, () => ({})) }));
    const scope = serverReadContext({ send });
    try {
      await scope.client.send({});
      await scope.budget.read(async () => Array.from({ length: COMPANY_READ_LIMITS.items - count }, () => ({})));
      await expect(scope.budget.read(async () => ({}))).rejects.toThrow();
      expect(send).toHaveBeenCalledTimes(1);
    } finally { await scope.close(); }
  });
  it("counts decoded key rows against the same aggregate, without counting the envelope as one", async () => {
    const scope = serverReadContext({ send: async () => ({}) });
    try {
      await scope.readCounted(async () => ({ Payload: "keys" }), () => 2000);
      await expect(scope.client.send({})).resolves.toEqual({});
      await expect(scope.budget.read(async () => ({}))).rejects.toThrow();
      await expect(scope.client.send({})).rejects.toThrow();
    } finally { await scope.close(); }
  });
  it("exhausts the command ceiling even on zero rows", async () => {
    const send = vi.fn(async () => ({ Items: [] }));
    const scope = serverReadContext({ send });
    try {
      for (let n = 0; n < 512; n++) await scope.client.send({});
      await expect(scope.client.send({})).rejects.toThrow();
      expect(send).toHaveBeenCalledTimes(512);
    } finally { await scope.close(); }
  });
  it("rejects bytes and files without refunding consumed allowance", async () => {
    const scope = serverReadContext({ send: async () => ({ Item: { huge: "x".repeat(8_000_000) } }) });
    try {
      await expect(scope.client.send({})).rejects.toThrow();
      expect(() => scope.check()).toThrow();
    } finally { await scope.close(); }
    const files = serverReadContext({ send: async () => ({}) });
    try { await expect(files.budget.read(async () => [], 65)).rejects.toThrow(); } finally { await files.close(); }
  });
  it("aborts the actual sender at the deadline and discards late results after settlement", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const send = vi.fn((_command: unknown, options?: { abortSignal?: AbortSignal }) => new Promise<unknown>((resolve) => {
      expect(options?.abortSignal).toBeDefined();
      options!.abortSignal!.addEventListener("abort", () => { finish = () => resolve({ Item: {} }); });
    }));
    const scope = serverReadContext({ send });
    const pending = scope.client.send({});
    const assertion = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(scope.abortSignal.aborted).toBe(true);
    let closed = false;
    const close = scope.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    finish(); await assertion; await close;
    expect(() => scope.check()).toThrow();
    await expect(scope.client.send({})).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("never admits a concurrent overflow batch's earlier rows after exhaustion", async () => {
    const scope = serverReadContext({ send: async () => ({ Items: Array.from({ length: 1100 }, () => ({})) }) });
    try {
      const results = await Promise.allSettled([scope.client.send({}), scope.client.send({})]);
      expect(results.some((result) => result.status === "rejected")).toBe(true);
      expect(() => scope.check()).toThrow();
    } finally { await scope.close(); }
  });
});

describe("deployed authentication uses the selected context", () => {
  const signed = async (w: Awaited<ReturnType<typeof createServerReadWorld>>) => {
    const { localSigner } = await import("../support/developer-fakes.js");
    const signer = localSigner(); const jwk = await signer.publicJwk();
    const claims = { ...w.claims, iss: w.config.issuer, nbf: Math.floor(Date.now() / 1000) - 1, exp: Math.floor(Date.now() / 1000) + 3600 };
    const input = `${Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
    const token = `Bearer ${input}.${(await signer.sign(Buffer.from(input))).toString("base64url")}`;
    return { jwk, token };
  };
  const response = (keys: unknown[]) => ({ Payload: Buffer.from(JSON.stringify({ statusCode: 200, body: JSON.stringify({ keys }) })) });
  it("reaches the real key decoder/SDK option path, counts every decoded key, and never reads domain facts on failure", async () => {
    const { serverReadWorld } = await import("../support/server-read-world.js");
    const { developerKeysThroughLambda } = await import("../../packages/broker/src/aws/developer-routes.js");
    const { developerTokenVerifier } = await import("../../packages/broker/src/developer/verify-token.js");
    const w = await serverReadWorld(); const { jwk, token } = await signed(w);
    const invoke = vi.fn(async (_payload: Uint8Array, options?: { abortSignal: AbortSignal }) => {
      expect(options?.abortSignal).toBeDefined();
      return response([jwk, ...Array.from({ length: 1999 }, () => ({}))]);
    });
    w.config.verifyAccessToken = developerTokenVerifier({ issuer: w.config.issuer, now: Date.now, keys: developerKeysThroughLambda(invoke) });
    const r = await w.call("GET", `/v1/dev/tasks/start-requests/${w.requestId}`, undefined, token);
    expect(r.status).toBe(503); expect(invoke).toHaveBeenCalledTimes(1);
    expect(w.send.mock.calls.some(([c]) => /IDEMPOTENCY#|DEVTASK#|TASK_ENGINE#/.test(JSON.stringify(c.input)))).toBe(false);
  });
  it("cancels a cold deployed key invocation at the original request deadline and waits for settlement", async () => {
    const { serverReadWorld } = await import("../support/server-read-world.js");
    const { developerKeysThroughLambda } = await import("../../packages/broker/src/aws/developer-routes.js");
    const { developerTokenVerifier } = await import("../../packages/broker/src/developer/verify-token.js");
    const w = await serverReadWorld(); const { token } = await signed(w);
    vi.useFakeTimers();
    let signal: AbortSignal | undefined; let settled = false;
    const invoke = vi.fn((_payload: Uint8Array, options?: { abortSignal: AbortSignal }) => new Promise<ReturnType<typeof response>>((_resolve, reject) => {
      signal = options?.abortSignal;
      signal?.addEventListener("abort", () => { settled = true; reject(new Error("private abort cause")); });
    }));
    w.config.verifyAccessToken = developerTokenVerifier({ issuer: w.config.issuer, now: Date.now, keys: developerKeysThroughLambda(invoke) });
    const pending = w.call("GET", `/v1/dev/tasks/start-requests/${w.requestId}`, undefined, token);
    for (let n = 0; n < 50 && signal === undefined; n++) await Promise.resolve();
    expect(signal).toBeDefined(); expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await pending; expect(r.status).toBe(503); expect(settled).toBe(true); expect(signal!.aborted).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain("private abort cause");
    expect(w.send.mock.calls.some(([c]) => /IDEMPOTENCY#|DEVTASK#|TASK_ENGINE#/.test(JSON.stringify(c.input)))).toBe(false);
  });
  it("charges a present SDK Item as one returned row", async () => {
    const scope = serverReadContext({ send: async () => ({ Item: {} }) });
    try {
      await scope.client.send({});
      await scope.budget.read(async () => Array.from({ length: 1999 }, () => ({})));
      await expect(scope.client.send({})).rejects.toThrow();
    } finally { await scope.close(); }
  });
});


it("classifies an initial authentication store fault as unavailable, without exposing store text", async () => {
  const { serverReadWorld } = await import("../support/server-read-world.js");
  const w = await serverReadWorld();
  w.send.mockImplementation(async command => {
    if ((command.input.Key as { pk?: string } | undefined)?.pk === `SESSION#${w.claims.sid}`) throw new Error("private store fault");
    return w.rawSend(command);
  });
  const result = await w.start();
  expect(result.status).toBe(503); expect(result.body).toEqual({ error: { code: "RUNTIME_UNAVAILABLE", message: "Start status is unavailable." } });
});
