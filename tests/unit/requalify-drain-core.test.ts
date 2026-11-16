// Lane E2 (T1 follow-up): the renewal's drain also sees core-engine operations kept under company keys (`ORG#<company>#WORKSPACE#<id>`). The companies come from trusted state only: the
// core's in-use marks and the session row's own company, never a request. A running core operation means not drained; any read error, or a company that cannot be read, fails the drain
// (it throws, so nothing counts 0). A workflow-only install answers exactly as before. Run through the IAM-faithful client, so every read must stay within the narrowed DrainRead grant.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { companyScoped } from "@agentx/contracts";
import { requalifyDrainCount, requalifyDrainStatus } from "../../packages/broker/src/e2e/requalify-hold.js";
import { CORE_IN_USE_PARTITION } from "../../packages/broker/src/core-host/engine-stamp.js";
import { DRAIN_FIXTURE_NOW as NOW, drainFixtureRows, drainIamClient, type DrainRequest } from "../support/drain-iam-client.js";

const TABLE = "state";
const COMPANY = "org_drain00000000000000a";
const OTHER = "org_drain00000000000000b";
const iso = (ms: number) => new Date(ms).toISOString();
const mark = (orgId: unknown) => ({ pk: CORE_IN_USE_PARTITION, sk: `ORG#${String(orgId)}`, entityType: "CORE_ENGINE_IN_USE", orgId });
const session = (workspaceId: string, extra: Record<string, unknown> = {}) => ({ pk: `WORKSPACE#${workspaceId}`, sk: "SESSION", workspaceId, sessionState: "READY", ...extra });
const coreOperation = (companyId: string, workspaceId: string, extra: Record<string, unknown> = {}) => ({
  pk: companyScoped(companyId, `WORKSPACE#${workspaceId}`), sk: `OPERATION#core-${workspaceId}`, entityType: "OPERATION", kind: "implement", status: "RUNNING",
  createdAt: iso(NOW - 60_000), updatedAt: iso(NOW - 30_000), companyId, ...extra,
});
/** Only the core rows (no workflow round, no setup run), so `drained` speaks for the core operations alone. */
const status = (rows: Array<Record<string, unknown>>, deny?: (request: DrainRequest) => boolean) => requalifyDrainStatus({ documentClient: drainIamClient(rows, deny === undefined ? {} : { deny }).documentClient, tableName: TABLE }, NOW);

describe("the drain on a workflow-only install is as before", () => {
  it("answers the same status, with no new field, for the existing fixture and for an empty table", async () => {
    expect(await status(drainFixtureRows())).toStrictEqual({ drained: false, applicationRounds: 1, setupRuns: 2 });
    expect(await status([])).toStrictEqual({ drained: true, applicationRounds: 0, setupRuns: 0 });
    expect(await status([session("ws-1"), { pk: "WORKSPACE#ws-1", sk: "OPERATION#x", entityType: "OPERATION", workflowMode: "CHECKS", status: "SUCCEEDED", createdAt: iso(NOW), updatedAt: iso(NOW) }]))
      .toStrictEqual({ drained: true, applicationRounds: 0, setupRuns: 0 });
  });
});

describe("a core operation under a company key", () => {
  it("is not drained while it runs, found through the core's in-use mark (the session row names no company)", async () => {
    expect(await status([mark(COMPANY), session("ws-c"), coreOperation(COMPANY, "ws-c")])).toStrictEqual({ drained: false, applicationRounds: 0, setupRuns: 0, coreOperations: 1 });
    expect(await requalifyDrainCount({ documentClient: drainIamClient([mark(COMPANY), session("ws-c"), coreOperation(COMPANY, "ws-c")]).documentClient, tableName: TABLE }, NOW)).toBe(1);
  });

  it("is not drained while it runs, found through the session row's own company (no in-use mark)", async () => {
    expect(await status([session("ws-c", { companyId: COMPANY }), coreOperation(COMPANY, "ws-c")])).toMatchObject({ drained: false, coreOperations: 1 });
  });

  it("counts whatever its kind or mode (fail closed), but not once it ended or is older than the stale-run sweep", async () => {
    expect(await status([mark(COMPANY), session("ws-c"), coreOperation(COMPANY, "ws-c", { entityType: "SOMETHING_NEW", status: "WHATEVER" })])).toMatchObject({ drained: false, coreOperations: 1 });
    expect(await status([mark(COMPANY), session("ws-c"), coreOperation(COMPANY, "ws-c", { status: "SUCCEEDED" })])).toStrictEqual({ drained: true, applicationRounds: 0, setupRuns: 0 });
    expect(await status([mark(COMPANY), session("ws-c"), coreOperation(COMPANY, "ws-c", { createdAt: iso(NOW - 864_000_000), updatedAt: iso(NOW - 864_000_000) })])).toStrictEqual({ drained: true, applicationRounds: 0, setupRuns: 0 });
  });

  it("reads another company's key only for a company the trusted state names", async () => {
    // OTHER holds an operation of the workspace, but no mark and no session names OTHER: nothing tells the drain to look there (and no request can).
    const seen = drainIamClient([mark(COMPANY), session("ws-c"), coreOperation(OTHER, "ws-c")]);
    expect(await requalifyDrainStatus({ documentClient: seen.documentClient, tableName: TABLE }, NOW)).toStrictEqual({ drained: true, applicationRounds: 0, setupRuns: 0 });
  });
});

describe("fail closed", () => {
  it("throws, never drained, when the in-use marks query fails", async () => {
    await expect(status([mark(COMPANY), session("ws-c")], (request) => request.attributes?.includes("orgId") === true)).rejects.toThrow("refused");
  });

  it("throws, never drained, when a company-keyed operations query fails (the workflow key's query of the same workspace is let through)", async () => {
    const companyKeyed = (request: DrainRequest) => request.command === "QueryCommand" && request.indexName === undefined && request.attributes?.includes("workflowMode") === true && String(request.pk).startsWith("ORG#");
    await expect(status([mark(COMPANY), session("ws-c")], companyKeyed)).rejects.toThrow("refused");
  });

  it("throws when a mark's or a session's company cannot be read (never skipped as if absent)", async () => {
    await expect(status([mark("not-an-org"), session("ws-c")])).rejects.toThrow("a core company mark could not be read");
    await expect(status([session("ws-c", { companyId: "ORG#x" })])).rejects.toThrow("a session's company could not be read");
  });
});

describe("the IAM grant", () => {
  it("names the core's in-use partition by the same name the core host uses", () => {
    const infra = readFileSync(new URL("../../infra/lib/runtime-requalify.ts", import.meta.url), "utf8");
    expect(infra).toContain(`"${CORE_IN_USE_PARTITION}"`);
    expect(infra).toContain(`"ORG#*#WORKSPACE#*"`);
    expect(companyScoped(COMPANY, "WORKSPACE#ws")).toMatch(/^ORG#[^#]+#WORKSPACE#/u);
  });
});
