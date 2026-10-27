// ARGUARD: the weekly renewal must not be switchable off silently. What test-deploy knows about the renewal's daily schedule: its state in a template, whether it was ever enabled (a record the
// `requalify-schedule` unit and the renewal's own daily check write), and the --check finding when it is off after it was on. Pure code; the readers live in test-deploy-requalify.ts.
import { REQUALIFY_PROFILE_ID, requalifyScheduleEnabledKey } from "../packages/contracts/src/index.js";
import type { CheckTemplate, Finding } from "./test-deploy-check.js";

/** The daily schedule's logical ID (CDK's id of `RuntimeRequalify/DailyCheck`). It is created DISABLED by `requalify-infra`; the `requalify-schedule` unit is the explicit first switch-on. */
export const REQUALIFY_SCHEDULE_LOGICAL_ID = "RuntimeRequalifyDailyCheckFBF4C861";

/** The CDK context that makes the infra create the schedule ENABLED (exactly "enabled"). Head synths carry it once the schedule has been on, so a stack update made from them keeps it on. */
export const REQUALIFY_SCHEDULE_CONTEXT_KEY = "agentx:autoRequalifySchedule";

export type ScheduleState = "ENABLED" | "DISABLED" | "unknown";

/** The schedule's State in a (deployed or head) template. An absent State is the service's default, ENABLED; a missing resource, another type or another value is `unknown`. */
export function scheduleStateOf(template: CheckTemplate): ScheduleState {
  const resource = template.Resources?.[REQUALIFY_SCHEDULE_LOGICAL_ID];
  if (resource?.Type !== "AWS::Scheduler::Schedule") return "unknown";
  const state = (resource.Properties as { State?: unknown } | undefined)?.State;
  return state === undefined || state === "ENABLED" ? "ENABLED" : state === "DISABLED" ? "DISABLED" : "unknown";
}

export type EnabledOnce = { state: "no" } | { state: "yes"; at: string } | { state: "unreadable"; reason: string };
export interface ScheduleFact {
  /** What the deployed template says. */
  deployed: ScheduleState;
  /** Whether the schedule was ever enabled (the record the `requalify-schedule` unit writes and the daily check keeps). */
  enabledOnce: EnabledOnce;
}

/** Whether a head synth should create the schedule enabled: it is on now, or it was once. An unreadable record proves nothing, so it does not switch anything on. */
export const wantsScheduleEnabled = (fact: ScheduleFact): boolean => fact.deployed === "ENABLED" || fact.enabledOnce.state === "yes";

/** The `requalify-schedule` command, derived from the renewal command the check already prints. */
const scheduleCommand = (renewNow: string): string => (renewNow.includes("--only requalify-now") ? renewNow.replace("--only requalify-now", "--only requalify-schedule") : "test-deploy --only requalify-schedule --apply");

/**
 * An ERROR when the schedule is off (or missing) although it was once enabled: from then on the renewal starts only when someone remembers. Before the first enable nothing is said (the
 * schedule is created disabled on purpose). A record that cannot be read while the schedule is off is a warning, never silence.
 */
export function scheduleFindings(fact: ScheduleFact, renewNow: string): Finding[] {
  const finding = (kind: Finding["kind"], severity: Finding["severity"], message: string): Finding => ({ kind, severity, subject: "requalify", label: "requalify schedule", message });
  if (fact.deployed === "ENABLED") return [];
  if (fact.enabledOnce.state === "yes") {
    return [finding("requalify-schedule-off", "error",
      `the daily renewal schedule is ${fact.deployed === "DISABLED" ? "DISABLED" : "missing from the stack"}, but it was enabled on ${fact.enabledOnce.at}: something switched it off (a stack update made without the schedule's context, or by hand), so the test machine is no longer renewed by itself. Switch it on again with: ${scheduleCommand(renewNow)}`)];
  }
  if (fact.enabledOnce.state === "unreadable") return [finding("requalify-unreadable", "warning", `the daily renewal schedule is off and the record of whether it was ever enabled cannot be read: ${fact.enabledOnce.reason}`)];
  return [];
}

/** The AWS call that records, once, that the schedule was enabled: conditional, so a later run never moves the first-enabled time. */
export function enabledMarkerPutArgs(input: { table: string; region: string; now: Date }): string[] {
  const key = requalifyScheduleEnabledKey(REQUALIFY_PROFILE_ID);
  return [
    "dynamodb", "put-item", "--table-name", input.table, "--region", input.region,
    "--item", JSON.stringify({ pk: { S: key.pk }, sk: { S: key.sk }, entityType: { S: "RUNTIME_REQUALIFY_SCHEDULE_ENABLED" }, at: { S: input.now.toISOString() } }),
    "--condition-expression", "attribute_not_exists(pk)",
  ];
}
