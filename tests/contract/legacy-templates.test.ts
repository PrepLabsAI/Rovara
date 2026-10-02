import { describe, expect, it } from "vitest";
import { legacyProductionStacks, normalizedTemplate } from "../support/template-snapshot.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

// Spec 015 phase 15a: environments must not change the live deployment. These snapshots were
// recorded before any naming change and must not be updated by phase 15a.
describe("legacy production templates", () => {
  for (const stack of legacyProductionStacks()) {
    it(`${stack.stackName} is unchanged`, () => {
      expect(normalizedTemplate(stack)).toMatchSnapshot();
    }, 120_000);
  }
});
