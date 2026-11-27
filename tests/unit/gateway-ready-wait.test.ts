// #1583: a self-hosted gateway runs two tasks behind its load balancer, and one can start with no prices while /healthz still answers 200 for it.
// The install's wait for a new gateway (waitForGatewayRunPrices) must not take one good answer as readiness: it needs GATEWAY_READY_STREAK in a row.
import { describe, expect, it } from "vitest";
import { GATEWAY_READY_STREAK, GATEWAY_READY_TIMEOUT_MS, waitForGatewayRunPrices } from "../../packages/cli/src/deploy/gateway-price-preflight.js";

const ORIGIN = "https://gateway.example";
const good = () => Response.json({ ok: true, runPrice: { version: 1, admissionVersion: 1, snapshotVersion: 1 } });
const noPrices = () => Response.json({ ok: true, runPrice: { version: 1, admissionVersion: 1, snapshotVersion: 0 } });

/** A load balancer over the given answers, in order, repeating the last. */
function balancer(answers: Array<() => Response>) {
  let calls = 0;
  const transport: typeof fetch = async () => { const answer = answers[Math.min(calls, answers.length - 1)]!; calls += 1; return answer(); };
  return { transport, calls: () => calls };
}

function clock() {
  let at = 0;
  return { now: () => at, sleep: async (ms: number) => { at += ms; }, at: () => at };
}

describe("waiting for a new self-hosted gateway (#1583)", () => {
  it("needs three good answers in a row: a good answer from one task, then none from the other, starts the count again", async () => {
    expect(GATEWAY_READY_STREAK).toBe(3);
    const lb = balancer([good, noPrices, good, noPrices, good, good, good]);
    const time = clock();
    await waitForGatewayRunPrices(ORIGIN, { transport: lb.transport, ...time });
    expect(lb.calls()).toBe(7);
  });

  it("waits longer than the gateway's five-minute prices reload", () => {
    expect(GATEWAY_READY_TIMEOUT_MS).toBeGreaterThan(5 * 60_000);
  });

  it("gives up with the gateway's refusal when the two tasks never both serve prices", async () => {
    let flip = 0;
    const flipping: typeof fetch = async () => (flip++ % 2 === 0 ? good() : noPrices());
    const time = clock();
    await expect(waitForGatewayRunPrices(ORIGIN, { transport: flipping, timeoutMs: 60_000, pollMs: 5_000, ...time })).rejects.toThrow("the gateway must serve run prices from a signed, versioned snapshot");
    expect(time.at()).toBeGreaterThanOrEqual(60_000);
  });

  it("returns at once for a gateway whose tasks all serve prices", async () => {
    const lb = balancer([good]);
    const time = clock();
    await waitForGatewayRunPrices(ORIGIN, { transport: lb.transport, ...time });
    expect(lb.calls()).toBe(GATEWAY_READY_STREAK);
    expect(time.at()).toBe(0);
  });
});
