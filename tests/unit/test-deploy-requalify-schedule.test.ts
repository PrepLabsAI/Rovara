// ARGUARD: the deploy tooling's side of "the weekly renewal cannot be switched off silently". --check turns a schedule that is off after it was once on into an error, and a head
// synth carries the schedule's state forward so a control-plane update made from it does not switch it off.
import { describe, expect, it } from "vitest";
import { REQUALIFY_INFRA, requalifyHeadContext } from "../../scripts/test-deploy-requalify.js";
import { REQUALIFY_SCHEDULE_CONTEXT_KEY, REQUALIFY_SCHEDULE_LOGICAL_ID, scheduleFindings, scheduleStateOf, wantsScheduleEnabled, type ScheduleFact } from "../../scripts/test-deploy-requalify-schedule.js";

const AT = "2026-10-20T06:00:00.000Z";
const NOW_COMMAND = "npx tsx scripts/test-deploy.ts --env agentxlivetest123 --profile agentx-test --only requalify-now --apply";
const template = (state: unknown, type = "AWS::Scheduler::Schedule") => ({ Resources: { [REQUALIFY_SCHEDULE_LOGICAL_ID]: { Type: type, Properties: state === undefined ? {} : { State: state } } } });
const kinds = (fact: ScheduleFact) => scheduleFindings(fact, NOW_COMMAND).map((finding) => `${finding.severity} ${finding.kind}`);

describe("scheduleStateOf", () => {
  it("reads the schedule's State from a template; a missing State is the service default (enabled), and anything else is unknown", () => {
    expect(scheduleStateOf(template("ENABLED"))).toBe("ENABLED");
    expect(scheduleStateOf(template("DISABLED"))).toBe("DISABLED");
    expect(scheduleStateOf(template(undefined))).toBe("ENABLED");
    expect(scheduleStateOf(template("MAYBE"))).toBe("unknown");
    expect(scheduleStateOf(template("ENABLED", "AWS::SNS::Topic"))).toBe("unknown");
    expect(scheduleStateOf({ Resources: {} })).toBe("unknown");
    expect(scheduleStateOf({})).toBe("unknown");
  });
});

describe("the schedule findings", () => {
  it("is an ERROR when the schedule is off (or gone) after it was once enabled, and names when and how to switch it on again", () => {
    for (const deployed of ["DISABLED", "unknown"] as const) {
      const [finding, ...rest] = scheduleFindings({ deployed, enabledOnce: { state: "yes", at: AT } }, NOW_COMMAND);
      expect(rest).toEqual([]);
      expect(finding).toMatchObject({ kind: "requalify-schedule-off", severity: "error" });
      expect(finding!.message).toContain(AT);
      expect(finding!.message).toContain("--only requalify-schedule --apply");
      expect(finding!.message).not.toContain("--only requalify-now");
    }
  });

  it("says what is wrong in words that fit: a schedule that is gone or whose State is not a plain ENABLED/DISABLED is not called 'missing' when it may only be unreadable", () => {
    const text = (deployed: "DISABLED" | "unknown") => scheduleFindings({ deployed, enabledOnce: { state: "yes", at: AT } }, NOW_COMMAND)[0]!.message;
    expect(text("DISABLED")).toContain("is DISABLED");
    expect(text("unknown")).toContain("is not a schedule with a plain ENABLED or DISABLED State");
    expect(text("unknown")).not.toContain("missing from the stack");
  });

  it("says nothing before the first enable (the schedule is created disabled on purpose), and nothing while it is on", () => {
    expect(kinds({ deployed: "DISABLED", enabledOnce: { state: "no" } })).toEqual([]);
    expect(kinds({ deployed: "unknown", enabledOnce: { state: "no" } })).toEqual([]);
    expect(kinds({ deployed: "ENABLED", enabledOnce: { state: "yes", at: AT } })).toEqual([]);
    expect(kinds({ deployed: "ENABLED", enabledOnce: { state: "no" } })).toEqual([]);
  });

  it("warns, never stays silent, when the record of the first enable cannot be read while the schedule is off", () => {
    expect(kinds({ deployed: "DISABLED", enabledOnce: { state: "unreadable", reason: "denied" } })).toEqual(["warning requalify-unreadable"]);
    expect(kinds({ deployed: "ENABLED", enabledOnce: { state: "unreadable", reason: "denied" } })).toEqual([]);
  });

  it("wants the schedule on in a head synth when it is on now or ever was", () => {
    expect(wantsScheduleEnabled({ deployed: "ENABLED", enabledOnce: { state: "no" } })).toBe(true);
    expect(wantsScheduleEnabled({ deployed: "DISABLED", enabledOnce: { state: "yes", at: AT } })).toBe(true);
    expect(wantsScheduleEnabled({ deployed: "DISABLED", enabledOnce: { state: "no" } })).toBe(false);
    // An unreadable record is not evidence either way for a synth; --check warns about it separately.
    expect(wantsScheduleEnabled({ deployed: "DISABLED", enabledOnce: { state: "unreadable", reason: "x" } })).toBe(false);
  });
});

describe("the head synth's context", () => {
  it("is the renewal's install context, with the schedule on only when asked for, and the exact string the infra reads", () => {
    expect(requalifyHeadContext(false)).toEqual(REQUALIFY_INFRA.context);
    expect(requalifyHeadContext(undefined)).toEqual(REQUALIFY_INFRA.context);
    expect(requalifyHeadContext(true)).toEqual({ ...REQUALIFY_INFRA.context, [REQUALIFY_SCHEDULE_CONTEXT_KEY]: "enabled" });
    expect(REQUALIFY_SCHEDULE_CONTEXT_KEY).toBe("agentx:autoRequalifySchedule");
    // The first install stays disabled: its context is the install context.
    expect(REQUALIFY_INFRA.context).not.toHaveProperty(REQUALIFY_SCHEDULE_CONTEXT_KEY);
  });
});

