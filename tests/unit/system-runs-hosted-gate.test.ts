// L4-P1 (owner DEC 254zzl): an ABSENT systemRuns gate on a task flow means ON (the laptop's rule), so a hosted runtime must ALWAYS carry one, default off, or every hosted company would get Rovara's automatic
// re-checks. The root builds a runtime per company inside a fixture too big for a unit test, so this holds the function the root calls and, at source level, that the root calls it for every runtime.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, type OrgId } from "@agentx/contracts";
import { hostedSystemRunsFor } from "../../packages/broker/src/aws/core-engine-root.js";
import { parseCoreSwitch } from "../../packages/broker/src/core-host/flags.js";

const A: OrgId = IMPLICIT_COMPANY_ID;
const B: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";

describe("the hosted SystemRuns gate is always supplied", () => {
  it("sets a gate on the flow's deps for every flag value, default off", () => {
    for (const raw of [undefined, "", "off", "typo", "drain", `on:${B}`, "on", `on:${A}`]) {
      const deps: { systemRuns?: { enabled(): boolean } } = {};
      const gate = hostedSystemRunsFor(deps, A, parseCoreSwitch(raw).value);
      expect(deps.systemRuns, String(raw)).toBe(gate);
      expect(typeof deps.systemRuns?.enabled).toBe("function");
    }
  });

  it("is off by default and for a company the flag does not name, on only where it does (two companies)", () => {
    const flagB = parseCoreSwitch(`on:${B}`).value;
    const a: { systemRuns?: { enabled(): boolean } } = {};
    const b: { systemRuns?: { enabled(): boolean } } = {};
    hostedSystemRunsFor(a, A, flagB);
    hostedSystemRunsFor(b, B, flagB);
    expect(a.systemRuns!.enabled()).toBe(false);
    expect(b.systemRuns!.enabled()).toBe(true);
    const off: { systemRuns?: { enabled(): boolean } } = {};
    hostedSystemRunsFor(off, A, parseCoreSwitch(undefined).value);
    expect(off.systemRuns!.enabled()).toBe(false);
  });

  it("the root calls it for every company's runtime, in the services builder that every hosted runtime goes through (kills: the call removed)", () => {
    const root = readFileSync("packages/broker/src/aws/core-engine-root.ts", "utf8");
    const calls = root.split("\n").filter((line) => line.includes("hostedSystemRunsFor(flow.deps, companyId, systemRunsFlag.value)"));
    expect(calls).toHaveLength(1);
    // The call sits inside `services: (flow, wiring) => {`, before that builder returns the runtime's services, and is not conditional on the flag covering the company.
    expect(calls[0]!.trim().startsWith("hostedSystemRunsFor(")).toBe(true);
    const at = root.indexOf(calls[0]!);
    const builder = root.lastIndexOf("services: (flow, wiring) => {", at);
    expect(builder).toBeGreaterThan(0);
    const before = root.slice(builder, at);
    expect(before.split("\n").some((line) => /^\s*if \(systemRunsFlag/u.test(line) || /^\s*if \(.*switchCovers/u.test(line))).toBe(false);
    expect(root).not.toContain("flow.deps.systemRuns =");
  });
});
