import { legacyWorkspaceKey } from "../../packages/broker/src/core/task-flow/legacy-keys.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { createHarness } from "../support/task-flow-harness.js";

const companyId = IMPLICIT_COMPANY_ID;
function golden(name: string, value: unknown): void {
  const path = new URL(`../fixtures/t8-goldens/${name}.json`, import.meta.url);
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  expect(bytes).toBe(readFileSync(path, "utf8"));
}

describe("T8 byte-identical base goldens", () => {
  it("records an old dispatch body and operation unchanged", async () => {
    const h = createHarness();
    // This T8 golden deliberately replays a pre-migration dispatch.
    const key = { ...legacyWorkspaceKey("workspace"), sk: "OPERATION#operation" };
    await h.store.put({ item: { ...legacyWorkspaceKey("workspace"), companyId } });
    const operation = { ...key, id: "operation", workspaceId: "workspace", companyId, status: "SUCCEEDED" };
    await h.store.put({ item: operation });
    await (await h.queues.queue("task-dispatch")).enqueue({ body: { v: 1, workspaceId: "workspace", operationId: "operation" } });
    const report = await h.flow.dispatchOnce();
    const { foreign, ...oldReport } = report;
    expect(foreign).toBe(0);
    golden("dispatch", { report: oldReport, operation: await h.store.get(key) });
  });
});

import { assertTwoCompanyIsolation } from "../../packages/testing/src/isolation/two-company.js";
import { eventsCompanies } from "../support/ports/events-companies.js";
it("the event surfaces share worlds and keep both companies isolated", async () => { await assertTwoCompanyIsolation(eventsCompanies()); });
