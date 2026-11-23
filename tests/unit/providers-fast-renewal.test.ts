import { expect, it } from "vitest";
import { modelAccessSource } from "../../packages/worker/src/model-access.js";
import { runPriceFor } from "../support/hosted-run-price.js";

it.each(["missing", "price", "model", "revision"])("never downgrades an ordinary priced Bedrock task on %s renewal", async change => {
  let now = 1_800_000_000_000, calls = 0;
  const first = runPriceFor("claude-sonnet-5-5", now);
  const read = modelAccessSource({ controlPlaneUrl: "https://broker.example", capability: "fixture", now: () => now,
    fetch: async () => {
      calls++;
      const changed = { ...first, expiresAt: now + 300_000, ...(change === "price" ? { outputUsdPerMillion: first.outputUsdPerMillion + 1 } : change === "model" ? { model: "claude-opus-5-5" } : change === "revision" ? { connectionRevision: "r2" } : {}) };
      return Response.json({ baseUrl: "https://gateway.example", apiKey: "fixture", expiresAt: now + 120_000, ...(calls === 1 ? { runPrice: first } : change === "missing" ? {} : { runPrice: changed }) });
    } });
  expect((await read()).runPrice).toEqual(first);
  now += 60_000;
  await expect(read()).rejects.toThrow("model's price");
  expect(calls).toBe(2);
});
