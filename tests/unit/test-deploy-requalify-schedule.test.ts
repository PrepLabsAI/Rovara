// ARGUARD: the deploy tooling's side of "the weekly renewal cannot be switched off silently". --check turns a schedule that is off after it was once on into an error, and a head
// synth carries the schedule's state forward so a control-plane update made from it does not switch it off.
import { describe, expect, it } from "vitest";
import { REQUALIFY_PROFILE_ID, requalifyScheduleEnabledKey } from "../../packages/contracts/src/index.js";
import { evaluateTestDeployCheck } from "../../scripts/test-deploy-check.js";
import { planTestDeploy, type DeployStep } from "../../scripts/test-deploy.js";
import { REQUALIFY_INFRA, readScheduleFact, requalifyFindings, requalifyHeadContext, type RequalifyFacts } from "../../scripts/test-deploy-requalify.js";
import {
  REQUALIFY_SCHEDULE_CONTEXT_KEY, REQUALIFY_SCHEDULE_LOGICAL_ID, enabledMarkerPutArgs, recordEnabledMarker, scheduleFindings, scheduleStateOf, wantsScheduleEnabled, type ScheduleFact,
} from "../../scripts/test-deploy-requalify-schedule.js";

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

describe("readScheduleFact", () => {
  const key = requalifyScheduleEnabledKey(REQUALIFY_PROFILE_ID);
  const reader = (answer: { status: number; stdout: string; stderr?: string }) => {
    const calls: string[][] = [];
    return { calls, reader: { aws: (args: readonly string[]) => { calls.push([...args]); return { status: answer.status, stdout: answer.stdout, stderr: answer.stderr ?? "" }; } } };
  };
  const input = { table: "state", region: "us-east-1" };

  it("reads the one row by key and returns when the schedule was first enabled", () => {
    const { reader: fake, calls } = reader({ status: 0, stdout: JSON.stringify({ Items: [{ pk: { S: key.pk }, sk: { S: key.sk }, entityType: { S: "RUNTIME_REQUALIFY_SCHEDULE_ENABLED" }, at: { S: AT } }] }) });
    expect(readScheduleFact(fake, input, template("DISABLED"))).toEqual({ deployed: "DISABLED", enabledOnce: { state: "yes", at: AT } });
    expect(calls[0]!.slice(0, 2)).toEqual(["dynamodb", "query"]);
    expect(JSON.parse(calls[0]![calls[0]!.indexOf("--expression-attribute-values") + 1]!)).toEqual({ ":pk": { S: key.pk }, ":sk": { S: key.sk } });
  });

  it("no row is never-enabled; a failed read or a row that is not the marker is unreadable, never 'never enabled'", () => {
    expect(readScheduleFact(reader({ status: 0, stdout: JSON.stringify({ Items: [] }) }).reader, input, template("DISABLED")).enabledOnce).toEqual({ state: "no" });
    expect(readScheduleFact(reader({ status: 254, stdout: "", stderr: "AccessDeniedException" }).reader, input, template("DISABLED")).enabledOnce.state).toBe("unreadable");
    const odd = reader({ status: 0, stdout: JSON.stringify({ Items: [{ pk: { S: key.pk }, sk: { S: key.sk }, at: { S: "yesterday" } }] }) });
    expect(readScheduleFact(odd.reader, input, template("DISABLED")).enabledOnce.state).toBe("unreadable");
  });
});

describe("the check", () => {
  const installed = (schedule?: ScheduleFact): RequalifyFacts => ({ state: "installed", lock: { state: "free" }, hold: "none", lastRun: { state: "none" }, ...(schedule === undefined ? {} : { schedule }) });

  it("shows the schedule error with the renewal's other findings, and it makes the check fail", () => {
    const off: ScheduleFact = { deployed: "DISABLED", enabledOnce: { state: "yes", at: AT } };
    expect(requalifyFindings(installed(off), NOW_COMMAND).map((finding) => `${finding.severity} ${finding.kind}`)).toContain("error requalify-schedule-off");
    const result = evaluateTestDeployCheck({ headTemplate: {}, deployedTemplate: {}, lambdaCodeShas: {}, builtZipShas: {}, runnerFacts: undefined, now: new Date("2026-10-27T00:00:00Z"), catalogRows: [], requalify: installed(off), renewCommand: NOW_COMMAND });
    expect(result.findings.filter((finding) => finding.severity === "error" && finding.kind.startsWith("requalify")).map((finding) => finding.kind)).toEqual(["requalify-schedule-off"]);
    expect(result.findings.some((finding) => finding.severity === "error")).toBe(true);
    // Before the first enable, and on a facts object from before this change, nothing is added.
    expect(requalifyFindings(installed({ deployed: "DISABLED", enabledOnce: { state: "no" } }), NOW_COMMAND).filter((finding) => finding.severity === "error")).toEqual([]);
    expect(requalifyFindings(installed(), NOW_COMMAND).filter((finding) => finding.kind === "requalify-schedule-off")).toEqual([]);
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

describe("the requalify-schedule unit records that the schedule was enabled", () => {
  const plan = (): DeployStep[] => planTestDeploy({
    env: "agentxlivetest123", only: ["requalify-schedule"], artifacts: { revision: "0123456789ab", outputDir: "/tmp/test-deploy-0123456789ab" }, previous: { "control-plane": { OidcIssuer: "https://issuer.example" }, runtime: {} },
    requalifyInstalled: true,
  });

  it("after the change set is verified, never before: a schedule that did not turn on is not recorded as on", () => {
    const steps = plan();
    const ids = steps.map((step) => step.kind);
    expect(ids.indexOf("record-requalify-enabled")).toBeGreaterThan(ids.indexOf("verify-requalify-schedule"));
    expect(ids.filter((id) => id === "record-requalify-enabled")).toHaveLength(1);
    expect(ids.at(-1)).toBe("record-requalify-enabled");
  });

  it("writes one conditional row so a later run never moves the first-enabled time", () => {
    const args = enabledMarkerPutArgs({ table: "state", region: "us-east-1", now: new Date(AT) });
    expect(args.slice(0, 2)).toEqual(["dynamodb", "put-item"]);
    expect(args[args.indexOf("--condition-expression") + 1]).toBe("attribute_not_exists(pk)");
    expect(JSON.parse(args[args.indexOf("--item") + 1]!)).toEqual({
      pk: { S: requalifyScheduleEnabledKey(REQUALIFY_PROFILE_ID).pk }, sk: { S: "SCHEDULE_ENABLED" }, entityType: { S: "RUNTIME_REQUALIFY_SCHEDULE_ENABLED" }, at: { S: AT },
    });
  });
});

describe("recordEnabledMarker (the requalify-schedule unit's last step)", () => {
  const run = (answer: { status: number; stderr?: string }) => {
    const calls: string[][] = [];
    return { calls, runner: { aws: (args: readonly string[]) => { calls.push([...args]); return { status: answer.status, stdout: "", stderr: answer.stderr ?? "" }; } } };
  };
  const input = { table: "state", region: "us-east-1", now: new Date(AT) };

  it("puts the conditional row once", () => {
    const { runner, calls } = run({ status: 0 });
    expect(recordEnabledMarker(runner, input)).toBe("written");
    expect(calls).toEqual([enabledMarkerPutArgs(input)]);
  });

  it("treats 'already recorded' as success (a second run of the unit), so the first-enabled time is never moved", () => {
    expect(recordEnabledMarker(run({ status: 254, stderr: "An error occurred (ConditionalCheckFailedException) when calling the PutItem operation" }).runner, input)).toBe("already-recorded");
  });

  it("stops with the owner's next step when the write is refused (a denied profile), naming that the daily check will write it", () => {
    expect(() => recordEnabledMarker(run({ status: 254, stderr: "AccessDeniedException: not authorized to perform: dynamodb:PutItem" }).runner, input)).toThrow(/schedule is ENABLED.*daily check writes it/);
  });

  it("never echoes the CLI's error text", () => {
    try { recordEnabledMarker(run({ status: 254, stderr: "AccessDeniedException arn:aws:iam::123456789012:user/someone" }).runner, input); } catch (error) { expect((error as Error).message).not.toContain("123456789012"); }
  });
});
