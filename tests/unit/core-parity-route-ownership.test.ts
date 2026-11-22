import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_ROUTES, DEV_ROUTES, CORE_CONTEXT_WORKER_ROUTES, SAVED_ENV_WORKER_ROUTES } from "../../packages/broker/src/aws/dev-route-scopes.js";

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("combined core parity route ownership", () => {
  it("registers every method and path exactly once across the entire route table", () => {
    const counts = new Map<string, number>();
    for (const row of [...APP_ROUTES, ...DEV_ROUTES, ...CORE_CONTEXT_WORKER_ROUTES, ...SAVED_ENV_WORKER_ROUTES]) {
      const key = `${row.method} ${row.path}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect([...counts].filter(([, count]) => count !== 1)).toEqual([]);
  });

  it("leaves no conflict markers in the three integrated files", () => {
    for (const path of ["packages/broker/src/core-host/dev-routes.ts", "packages/broker/src/core/build-step/start.ts", "tests/contract/core-app-routes.test.ts"]) {
      expect(source(path), path).not.toMatch(/^(?:<{7}|={7}|>{7})/mu);
    }
  });

  it("delegates review retries to the owning service instead of implementing review twice", () => {
    const actions = source("packages/broker/src/core-host/parity-task-actions.ts");
    expect(actions).not.toMatch(/\b(?:reviewFence|startReview)\b/u);
    expect(actions).toContain('from "../core/task-flow/manual-review.js"');
    expect(actions).toContain("await reviewTaskOnRequest(");
  });
});
