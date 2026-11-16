import { describe, expect, it } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { buildSetupCheck } from "../../packages/broker/src/core/setup-agent/check.js";
import { workspaceCompanyReader } from "../../packages/broker/src/aws/worker-machines/workspace-company.js";
import { createHarness } from "../support/task-flow-harness.js";

const companyId = "org_bbbbbbbbbbbbbbbbbbbb";
describe("setup check discovery", () => {
  it.each([false, true])("creates a discoverable workspace atomically (candidate=%s)", async (candidate) => {
    const h = createHarness({ companyId });
    const check = buildSetupCheck(h.deps, { project: "payments", revision: 1, startedBy: "local-owner", requestId: "check", candidate });
    expect((await h.store.transact(check.items)).applied).toBe(true);
    const readCompany = workspaceCompanyReader({ send: async (command: unknown) => {
      if (!(command instanceof GetCommand)) throw new Error("unexpected command");
      return { Item: await h.store.get(command.input.Key as { pk: string; sk: string }) };
    } } as never, "state");
    expect(await readCompany(check.workspaceId)).toBe(companyId);
    // The discovery key is reserved in the same transaction: a collision must leave no scoped record.
    const collision = buildSetupCheck(h.deps, { project: "payments", revision: 1, startedBy: "local-owner", requestId: "collision", candidate });
    await h.store.put({ item: { pk: `WORKSPACE#${collision.workspaceId}`, sk: "META", entityType: "WORKSPACE_COMPANY_POINTER", workspaceId: collision.workspaceId, companyId: "org_cccccccccccccccccccc" } });
    expect((await h.store.transact(collision.items)).applied).toBe(false);
    expect(await h.store.get({ pk: `ORG#${companyId}#WORKSPACE#${collision.workspaceId}`, sk: "META" })).toBeUndefined();
  });
});
