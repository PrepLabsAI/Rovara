// DEC 254zb (TE-C5 part C): a machine start's spend estimate follows the size it launches as, behind its own switch; off, nothing is read or added.
import { describe, expect, it, vi } from "vitest";
import type { OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { machineSizeCostEnabled, machineStartEstimate } from "../../packages/broker/src/core/test-env/machine-size-cost.js";
import { setMachineChoice } from "../../packages/broker/src/core/test-env/machine-size.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const ON = { ROVARA_MACHINE_SIZE: "1", ROVARA_MACHINE_SIZE_RUN: "1", ROVARA_MACHINE_SIZE_COST: "1", AWS_REGION: "us-west-2" };
const now = () => Date.parse("2026-11-17T12:00:00.000Z");

async function world(choices: Array<[OrgId, string, string]> = []) {
  const store = new MemoryDocumentStore();
  for (const [orgId, project, rowId] of choices) await setMachineChoice({ store, now, env: ON }, { orgId, project, rowId });
  return store;
}

describe("machine start estimate", () => {
  it.each([
    [{ ...ON, ROVARA_MACHINE_SIZE_COST: undefined }, false], [{ ...ON, ROVARA_MACHINE_SIZE_COST: "true" }, false],
    [{ ...ON, ROVARA_MACHINE_SIZE_RUN: undefined }, false], [ON, true],
  ])("is on only with its own switch and sized launches on: %j -> %s", (env, on) => {
    expect(machineSizeCostEnabled(env as NodeJS.ProcessEnv)).toBe(on);
  });

  it("adds nothing and reads nothing while off", async () => {
    const store = await world([[A, "api", "arm64-8-32"]]);
    const get = vi.spyOn(store, "get");
    expect(await machineStartEstimate({ store, companyId: A, projectName: "api", env: { ...ON, ROVARA_MACHINE_SIZE_COST: "0" }, now })).toEqual({});
    expect(get).not.toHaveBeenCalled();
  });

  it("estimates one hour of the chosen size, and of the default size without a choice", async () => {
    const store = await world([[A, "api", "arm64-8-32"]]);
    expect(await machineStartEstimate({ store, companyId: A, projectName: "api", env: ON, now })).toEqual({ estimate: { cost: { micros: 338_800, currency: "USD" } } });
    expect(await machineStartEstimate({ store, companyId: A, projectName: "web", env: ON, now })).toEqual({ estimate: { cost: { micros: 84_700, currency: "USD" } } });
    expect(await machineStartEstimate({ store, companyId: A, projectName: undefined, env: ON, now })).toEqual({ estimate: { cost: { micros: 84_700, currency: "USD" } } });
  });

  it("never prices another company's choice (two companies, one project name)", async () => {
    const store = await world([[B, "api", "arm64-8-32"]]);
    expect(await machineStartEstimate({ store, companyId: A, projectName: "api", env: ON, now })).toEqual({ estimate: { cost: { micros: 84_700, currency: "USD" } } });
    expect(await machineStartEstimate({ store, companyId: B, projectName: "api", env: ON, now })).toEqual({ estimate: { cost: { micros: 338_800, currency: "USD" } } });
  });

  it("prices an x86 choice the install cannot run as the default size it launches as, and as x86 once it can", async () => {
    const store = await world([[A, "api", "x86_64-8-32"]]);
    expect(await machineStartEstimate({ store, companyId: A, projectName: "api", env: ON, now })).toEqual({ estimate: { cost: { micros: 84_700, currency: "USD" } } });
    expect(await machineStartEstimate({ store, companyId: A, projectName: "api", env: { ...ON, ROVARA_MACHINE_SIZE_X86: "1" }, now })).toEqual({ estimate: { cost: { micros: 422_400, currency: "USD" } } });
  });

  it("gives no estimate (never $0) in a region without a price, and the default's when the store fails", async () => {
    const store = await world([[A, "api", "arm64-8-32"]]);
    expect(await machineStartEstimate({ store, companyId: A, projectName: "api", env: { ...ON, AWS_REGION: "eu-west-1" }, now })).toEqual({});
    expect(await machineStartEstimate({ store, companyId: A, projectName: "api", env: { ...ON, AWS_REGION: undefined }, now })).toEqual({});
    vi.spyOn(store, "get").mockRejectedValue(new Error("down"));
    expect(await machineStartEstimate({ store, companyId: A, projectName: "api", env: ON, now })).toEqual({ estimate: { cost: { micros: 84_700, currency: "USD" } } });
  });
});
