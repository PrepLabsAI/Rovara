import { describe, expect, it } from "vitest";
import { companyScoped } from "@agentx/contracts";
import { requalifyDrainStatus } from "../../packages/broker/src/e2e/requalify-hold.js";
import { CORE_IN_USE_PARTITION } from "../../packages/broker/src/core-host/engine-stamp.js";
import { DRAIN_FIXTURE_NOW as NOW, drainIamClient, type DrainRequest } from "../support/drain-iam-client.js";

const TABLE = "state";
const COMPANY = "org_drain00000000000000a";
const iso = (ms: number) => new Date(ms).toISOString();
const mark = (orgId: unknown) => ({ pk: CORE_IN_USE_PARTITION, sk: `ORG#${String(orgId)}`, entityType: "CORE_ENGINE_IN_USE", orgId });
const session = (workspaceId: string, extra: Record<string, unknown> = {}) => ({ pk: `WORKSPACE#${workspaceId}`, sk: "SESSION", workspaceId, sessionState: "READY", ...extra });
const coreOperation = (companyId: string, workspaceId: string, extra: Record<string, unknown> = {}) => ({
  pk: companyScoped(companyId, `WORKSPACE#${workspaceId}`), sk: `OPERATION#core-${workspaceId}`, entityType: "OPERATION", kind: "implement", status: "RUNNING",
  createdAt: iso(NOW - 60_000), updatedAt: iso(NOW - 30_000), companyId, ...extra,
});
/** Only the core rows (no workflow round, no setup run), so `drained` speaks for the core operations alone. */
const status = (rows: Array<Record<string, unknown>>, deny?: (request: DrainRequest) => boolean) => requalifyDrainStatus({ documentClient: drainIamClient(rows, deny === undefined ? {} : { deny }).documentClient, tableName: TABLE }, NOW);

describe("a core operation under a company key", () => {

  it("is not drained while it runs, found through the session row's own company (no in-use mark)", async () => {
    expect(await status([session("ws-c", { companyId: COMPANY }), coreOperation(COMPANY, "ws-c")])).toMatchObject({ drained: false, coreOperations: 1 });
  });

  it("counts whatever its kind or mode (fail closed), but not once it ended or is older than the stale-run sweep", async () => {
    expect(await status([mark(COMPANY), session("ws-c"), coreOperation(COMPANY, "ws-c", { entityType: "SOMETHING_NEW", status: "WHATEVER" })])).toMatchObject({ drained: false, coreOperations: 1 });
    expect(await status([mark(COMPANY), session("ws-c"), coreOperation(COMPANY, "ws-c", { status: "SUCCEEDED" })])).toStrictEqual({ drained: true, applicationRounds: 0, setupRuns: 0 });
    expect(await status([mark(COMPANY), session("ws-c"), coreOperation(COMPANY, "ws-c", { createdAt: iso(NOW - 864_000_000), updatedAt: iso(NOW - 864_000_000) })])).toStrictEqual({ drained: true, applicationRounds: 0, setupRuns: 0 });
  });

});

describe("fail closed", () => {

  it("throws when a mark's or a session's company cannot be read (never skipped as if absent)", async () => {
    await expect(status([mark("not-an-org"), session("ws-c")])).rejects.toThrow("a core company mark could not be read");
    await expect(status([session("ws-c", { companyId: "ORG#x" })])).rejects.toThrow("a session's company could not be read");
  });
});

