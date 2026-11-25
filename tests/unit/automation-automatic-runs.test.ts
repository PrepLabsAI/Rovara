// The live monthly cap of automatic runs (`automatic-runs/cap.ts`) and the one door unattended work goes through (`automation/run-seam.ts`). The rules that matter:
//   1. while automation is off nothing starts, and nothing is counted or asked of Admission;
//   2. a project's monthly cap holds: at the cap the claim is refused, and the pause is recorded once per refusal's audit event;
//   3. a repeat of a request is one run and counts once, even after the cap was lowered;
//   4. a cap change applies once per request id, and a cap or request id out of range is refused.
// The older start/end/view modules and their cases were deleted with those modules (lane D4b); these cases test only what stayed.
import { describe, expect, it } from "vitest";
import { startUnattendedRun, type AutomatedRunRequest } from "../../packages/broker/src/core/automation/run-seam.js";
import { claimAutomaticRun, readAutomaticRunsUse, setAutomaticRunsCap } from "../../packages/broker/src/core/automatic-runs/cap.js";
import { COMPANY, OWNER, PROJECT, createAutomationWorld, type AutomationWorld } from "../support/automation-world.js";

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const deps = (world: AutomationWorld) => ({ store: world.store, now: () => world.clock.now, companyId: COMPANY, audit: { stage: (e: never) => { world.audit.push(e); return []; }, record: async () => undefined } });
const request = (n: number): AutomatedRunRequest => ({ requestId: uuid(n), project: PROJECT, agent: { agentId: "rovara-code" }, input: { text: "Go." }, origin: "automatic", limits: { maxMinutes: 5 } });

describe("the unattended door", () => {
  it("starts nothing, asks nothing and counts nothing while automation is off", async () => {
    const world = createAutomationWorld({ on: false });
    await expect(startUnattendedRun(world.unattended, request(1))).rejects.toThrow(/not switched on/u);
    expect(world.admissions).toHaveLength(0);
    expect(world.starts).toHaveLength(0);
    expect((await readAutomaticRunsUse(deps(world), COMPANY, PROJECT)).used).toBe(0);
  });
});

describe("the monthly cap of automatic runs", () => {
  it("counts a retried claim once and stops at the cap, recording the pause once", async () => {
    const world = createAutomationWorld();
    await setAutomaticRunsCap(deps(world), { orgId: COMPANY, project: PROJECT, changedBy: OWNER.personId, cap: 2, requestId: "cap-request-1" });
    const claim = (n: number) => claimAutomaticRun(deps(world), { orgId: COMPANY, project: PROJECT, requestId: uuid(n), job: "nightly" });
    expect((await claim(1)).claimed).toBe(true);
    expect(await claim(1)).toMatchObject({ claimed: true, replay: true, used: 1 });
    expect((await claim(2)).claimed).toBe(true);
    expect(await claim(3)).toMatchObject({ claimed: false, used: 2, cap: 2 });
    expect(await claim(4)).toMatchObject({ claimed: false });
    expect(world.audit.filter((event) => event.action === "automatic_runs.paused")).toHaveLength(2);
    // A new month starts again.
    world.clock.now = Date.parse("2026-12-01T00:00:00.000Z");
    expect((await claim(5)).claimed).toBe(true);
  });

  it("answers a retried claim as claimed even after the cap was lowered to 0, because its run exists", async () => {
    const world = createAutomationWorld();
    const claim = (n: number) => claimAutomaticRun(deps(world), { orgId: COMPANY, project: PROJECT, requestId: uuid(n), job: "scheduled_check" });
    expect(await claim(20)).toMatchObject({ claimed: true, replay: false });
    await setAutomaticRunsCap(deps(world), { orgId: COMPANY, project: PROJECT, changedBy: OWNER.personId, cap: 0, requestId: "cap-request-9" });
    // The same request again is the same run (claimed once), not refused; a new request is refused.
    expect(await claim(20)).toMatchObject({ claimed: true, replay: true });
    expect(await claim(21)).toMatchObject({ claimed: false });
  });

  it("applies a cap change once per request id and refuses a cap out of range", async () => {
    const world = createAutomationWorld();
    const set = (cap: number, requestId: string) => setAutomaticRunsCap(deps(world), { orgId: COMPANY, project: PROJECT, changedBy: OWNER.personId, cap, requestId });
    expect((await set(5, "request-aaaa")).cap).toBe(5);
    expect((await set(9, "request-aaaa")).cap).toBe(5);
    await expect(set(100_000, "request-bbbb")).rejects.toThrow(/whole number from 0 to/u);
    await expect(set(3, "x")).rejects.toThrow(/request id of 8 to 64/u);
  });
});
