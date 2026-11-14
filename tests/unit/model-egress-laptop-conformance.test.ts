// TE-F1c: the laptop adapter passes F1-a's `model-egress` conformance suite and the two-company kit (DECISIONS 150(c)), and the whole suite runs under the network tripwire: zero sockets, every transport call to its row's own host.
import { afterAll, describe, expect, it } from "vitest";
import { withNetworkTripwire } from "../../packages/testing/src/ports/no-network.js";
import { modelEgressChecks } from "../../packages/testing/src/ports/model-egress-conformance.js";
import { FIXTURE_AZURE_HOST } from "../../packages/testing/src/ports/model-egress-fixtures.js";
import { laptopWorld, type LaptopWorld } from "./model-egress-laptop-support.js";

const worlds: LaptopWorld[] = [];
afterAll(() => worlds.forEach((world) => world.cleanup()));

describe("model-egress conformance: the laptop adapter", () => {
  for (const check of modelEgressChecks) {
    it(check.name, async () => {
      const world = await laptopWorld();
      worlds.push(world);
      if (check.needs !== undefined && !check.needs(world)) return;
      await check.run(world);
    }, 30_000);
  }
});

describe("no request reaches a real model host (the laptop adapter)", () => {
  it("the whole suite under the tripwire: zero sockets, and every call went to its row's own host", async () => {
    const outcome = await withNetworkTripwire(async () => {
      const destinations = new Set<string>();
      let rows: readonly { hosts: readonly string[] }[] = [];
      for (const check of modelEgressChecks) {
        const world = await laptopWorld();
        worlds.push(world);
        if (check.needs !== undefined && !check.needs(world)) continue;
        await check.run(world);
        rows = world.rowsList;
        for (const call of world.provider.calls) destinations.add(call.host);
      }
      return { destinations, rows };
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.attempts).toEqual([]);
    const known = new Set([...(outcome.result?.rows ?? []).flatMap((row) => row.hosts), FIXTURE_AZURE_HOST, "us-central1-aiplatform.googleapis.com"]);
    for (const host of outcome.result?.destinations ?? []) expect(known.has(host), host).toBe(true);
    expect((outcome.result?.destinations ?? new Set()).size).toBeGreaterThan(3);
  }, 120_000);
});
