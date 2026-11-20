// DEC 254zb (TE-C5 part C): the size a workspace's next worker launches as comes from its own project's stored choice, behind ROVARA_MACHINE_SIZE_RUN.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { companyScoped } from "@agentx/contracts";
import { machineSizePicker, machineSizeRunEnabled } from "../../packages/broker/src/aws/worker-machines/machine-size-pick.js";
import { testEnvMachineChoiceKey } from "../../packages/broker/src/core/test-env/machine-size.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const COMPANY_A = "org_aaaaaaaaaaaaaaaaaaaa";
const COMPANY_B = "org_bbbbbbbbbbbbbbbbbbbb";
const ON = { ROVARA_MACHINE_SIZE: "1", ROVARA_MACHINE_SIZE_RUN: "1" };

function world(env: NodeJS.ProcessEnv = ON) {
  const db = new FakeDynamoDb();
  const log = vi.fn();
  const workspace = (companyId: string, projectName: string, extra: Record<string, unknown> = {}) => {
    const id = randomUUID();
    db.set({ pk: companyScoped(companyId, `WORKSPACE#${id}`), sk: "META", entityType: "WORKSPACE", id, companyId, orgId: companyId, projectName, ...extra });
    db.set({ pk: `WORKSPACE#${id}`, sk: "META", entityType: "WORKSPACE_COMPANY_POINTER", companyId, orgId: companyId });
    return id;
  };
  const choose = (companyId: string, project: string, rowId: unknown, extra: Record<string, unknown> = {}) => {
    db.set({ ...testEnvMachineChoiceKey(companyId, project), entityType: "TEST_ENV_MACHINE_CHOICE", orgId: companyId, project, rowId, chosenAt: "2026-11-17T00:00:00.000Z", ...extra });
  };
  const pick = machineSizePicker({ documentClient: db, tableName: "state", env, now: () => Date.parse("2026-11-17T12:00:00.000Z"), log });
  return { db, log, workspace, choose, pick };
}

describe("machine size pick: the switch", () => {
  it.each([
    [{}, false],
  ])("is on only with exactly \"1\" and the choice switch not turned off (it is on by default, DEC 254zr stack): %j -> %s", (env, on) => {
    expect(machineSizeRunEnabled(env)).toBe(on);
  });

});

describe("machine size pick: the install's largest size (DEC 254zv)", () => {
  it("launches the default, not a stored size above the maximum", async () => {
    const w = world({ ...ON, ROVARA_MACHINE_SIZE_MAX_VCPU: "8" });
    const id = w.workspace(COMPANY_A, "api");
    w.choose(COMPANY_A, "api", "arm64-32-128");
    expect(await w.pick!(id)).toEqual({});
    w.choose(COMPANY_A, "api", "arm64-8-32");
    expect(await w.pick!(id)).toEqual({ machine: { instanceType: "m6g.2xlarge", chip: "arm64" } });
  });
});

describe("machine size pick: whose choice", () => {

  it("treats a workspace whose record disagrees about its company, or names no project, as having no choice", async () => {
    const w = world();
    const mixed = w.workspace(COMPANY_A, "api", { orgId: COMPANY_B });
    const unnamed = w.workspace(COMPANY_A, "api", { projectName: "" });
    w.choose(COMPANY_A, "api", "arm64-8-32");
    expect(await w.pick!(mixed)).toEqual({});
    expect(await w.pick!(unnamed)).toEqual({});
    expect(await w.pick!(randomUUID())).toEqual({});
  });
});

describe("machine size pick: an older workspace record (no company pointer)", () => {
  const legacy = (w: ReturnType<typeof world>, fields: Record<string, unknown>) => {
    const id = randomUUID();
    w.db.set({ pk: `WORKSPACE#${id}`, sk: "META", entityType: "WORKSPACE", id, projectName: "api", ...fields });
    return id;
  };

  it("treats a record whose orgId names another company, or with no valid company, as nobody's", async () => {
    const w = world();
    w.choose(COMPANY_A, "api", "arm64-4-16");
    w.choose(COMPANY_B, "api", "arm64-8-32");
    expect(await w.pick!(legacy(w, { companyId: COMPANY_A, orgId: COMPANY_B }))).toEqual({});
    expect(await w.pick!(legacy(w, { companyId: "not-a-company" }))).toEqual({});
    expect(await w.pick!(legacy(w, {}))).toEqual({});
  });
});

describe("machine size pick: what launches", () => {
  it("launches the default with a fixed note for an x86 choice while the install has no x86 worker image", async () => {
    const w = world();
    const id = w.workspace(COMPANY_A, "api");
    w.choose(COMPANY_A, "api", "x86_64-4-16");
    expect(await w.pick!(id)).toEqual({ fallback: "x86-unavailable" });
  });


});
