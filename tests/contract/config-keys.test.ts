import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONFIG_KEYS, configKey, whereText } from "../../packages/cli/src/config/keys.js";
import { OPERATOR_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";

const infraSource = readdirSync("infra/lib").filter((file) => file.endsWith(".ts")).map((file) => readFileSync(`infra/lib/${file}`, "utf8")).join("\n");
const declaredInInfra = (parameter: string) => new RegExp(`CfnParameter\\((this|stack|scope), "${parameter}"`).test(infraSource);

describe("config keys (FR-048)", () => {
  it("has every key the spec names, plus the budget", () => {
    expect(CONFIG_KEYS.map((entry) => entry.key)).toEqual([
      "models.orchestrator", "models.classifier", "models.worker",
      "limits.workspacesPerMember", "limits.workspacesPerOrg", "limits.threadTurnsPerMinute",
      "slack.appPostedMessages", "alerts.address", "alerts.slowTurnMinutes",
      "budget.monthlyUsd", "budget.scope", "mcp.confirmElicitation",
    ]);
  });

  it("maps each key to exactly one place, and no two keys to the same place", () => {
    const places = CONFIG_KEYS.map((entry) => JSON.stringify(entry.target));
    expect(new Set(places).size).toBe(places.length);
  });

  it("routes limits.threadTurnsPerMinute to SlackThreadTurnsPerMinute, as the spec says", () => {
    expect(configKey("limits.threadTurnsPerMinute").target).toEqual({ kind: "stack-parameter", part: "control-plane", parameter: "SlackThreadTurnsPerMinute" });
  });

  it("routes the workspace limits to the control plane's setting, with the stack parameters as install-time defaults (spec 025 FR-053)", () => {
    expect(configKey("limits.workspacesPerMember").target).toEqual({ kind: "control-plane-setting", field: "perPerson", installDefault: { part: "control-plane", parameter: "SlackMemberWorkspaceLimit" } });
    expect(configKey("limits.workspacesPerOrg").target).toEqual({ kind: "control-plane-setting", field: "perOrganization", installDefault: { part: "control-plane", parameter: "SlackOrganizationWorkspaceLimit" } });
  });

  it("names only stack parameters the infrastructure declares", () => {
    for (const entry of CONFIG_KEYS) {
      if (entry.target.kind === "stack-parameter") expect(declaredInInfra(entry.target.parameter), entry.key).toBe(true);
      if (entry.target.kind === "control-plane-setting") expect(declaredInInfra(entry.target.installDefault.parameter), entry.key).toBe(true);
    }
  });

  it("keeps every non-model stack-parameter key across upgrades (OPERATOR_PARAMETERS)", () => {
    for (const entry of CONFIG_KEYS) {
      if (entry.target.kind !== "stack-parameter" || entry.model !== undefined) continue;
      expect(OPERATOR_PARAMETERS[entry.target.part], entry.key).toContain(entry.target.parameter);
    }
  });

  it.each([
    ["limits.threadTurnsPerMinute", "12", "12"], ["limits.threadTurnsPerMinute", " 07 ", "7"],
    ["alerts.slowTurnMinutes", "60", "60"], ["budget.monthlyUsd", "0", "0"], ["budget.monthlyUsd", "1500", "1500"], ["budget.monthlyUsd", "1000000", "1000000"],
    ["budget.scope", "account", "account"], ["slack.appPostedMessages", "ignore", "ignore"],
    ["models.orchestrator", "us.anthropic.claude-sonnet-4-6", "us.anthropic.claude-sonnet-4-6"],
    ["alerts.address", "ops@example.com", "ops@example.com"], ["limits.workspacesPerMember", "5", "5"],
  ])("accepts %s = %j", (key, value, stored) => {
    expect(configKey(key).parse(value)).toBe(stored);
  });

  it.each([
    ["limits.threadTurnsPerMinute", "0", "a whole number from 1 to 60"], ["limits.threadTurnsPerMinute", "6.5", "a whole number from 1 to 60"],
    ["alerts.slowTurnMinutes", "61", "a whole number from 1 to 60"], ["budget.monthlyUsd", "-1", "a whole number from 0 to 1000000"],
    ["budget.monthlyUsd", "1000001", "a whole number from 0 to 1000000"], ["budget.scope", "org", "one of tag, account"],
    ["slack.appPostedMessages", "yes", "one of accept, ignore"], ["models.worker", "", "a model id"], ["models.worker", "bad model", "a model id"],
    ["alerts.address", "not-an-address", "an email address"], ["limits.workspacesPerOrg", "1001", "a whole number from 1 to 1000"],
  ])("refuses %s = %j, saying what is allowed", (key, value, allowed) => {
    expect(() => configKey(key).parse(value)).toThrow(`${key} must be ${allowed}; nothing changed`);
  });

  it("refuses an unknown key and points at config list", () => {
    expect(() => configKey("models.checker")).toThrow("unknown config key models.checker; agentx config list shows every key");
  });

  it("says where each key lives", () => {
    expect(whereText(configKey("alerts.slowTurnMinutes").target, "staging")).toBe("stack parameter SlowTurnMinutes on agentx-staging-slack");
    expect(whereText(configKey("alerts.address").target, "staging")).toBe("SSM /agentx/staging/settings (alertAddress)");
    expect(whereText(configKey("limits.workspacesPerOrg").target, "staging")).toBe("control-plane setting WORKSPACE_LIMITS.perOrganization (install-time default SlackOrganizationWorkspaceLimit)");
  });
});
