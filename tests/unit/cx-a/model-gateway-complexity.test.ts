import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { scoreFile } from "../../../scripts/complexity.js";

const gateway = new URL("../../../packages/broker/src/core/model-gateway/", import.meta.url);

it.each([
  ["token.ts", 14], ["describer.ts", 5], ["route.ts", 1],
] as const)("keeps %s within its extraction budget of %i", (file, budget) => {
  const path = new URL(file, gateway);
  expect(scoreFile(fileURLToPath(path), readFileSync(path, "utf8")).excess).toBeLessThanOrEqual(budget);
});

it("adds helpers without moving excess complexity into them", () => {
  const helpers = new URL("cx-a/", gateway);
  const files = readdirSync(helpers).filter(file => file.endsWith(".ts"));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const path = new URL(file, helpers);
    expect(scoreFile(fileURLToPath(path), readFileSync(path, "utf8")).excess, file).toBe(0);
  }
});
