import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONFIG_KEYS, configKey, savedEnvRegistryReadiness, whereText } from "../../packages/cli/src/config/keys.js";
import { OPERATOR_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";

const infraSource = readdirSync("infra/lib").filter((file) => file.endsWith(".ts")).map((file) => readFileSync(`infra/lib/${file}`, "utf8")).join("\n");
const declaredInInfra = (parameter: string) => new RegExp(`CfnParameter\\((this|stack|scope), (?:"${parameter}"|${parameter === "SavedEnvironments" ? "SAVED_ENVIRONMENTS_PARAMETER" : "(?!)"})`).test(infraSource);

describe("config keys (FR-048)", () => {
  it("requires every registry output and checks readiness, role ARNs, account and prefix", () => {
    const valid = {
      SavedEnvImgPushRoleArn: "arn:aws:iam::123456789012:role/agentx/staging/agentx-staging-img-push",
      SavedEnvImgPullRoleArn: "arn:aws:iam::123456789012:role/agentx/staging/agentx-staging-img-pull",
      SavedEnvImgManageRoleArn: "arn:aws:iam::123456789012:role/agentx/staging/agentx-staging-img-manage",
      SavedEnvRepoPrefix: "rovara-env/staging", SavedEnvRegistryReady: "1",
    };
    expect(savedEnvRegistryReadiness(undefined, "staging", "123456789012")).toHaveLength(5);
    for (const role of ["SavedEnvImgPushRoleArn", "SavedEnvImgPullRoleArn", "SavedEnvImgManageRoleArn"] as const) {
      for (const bad of ["not-an-arn", valid[role].replace("123456789012", "999999999999"), valid[role].replace("staging", "other"), valid[role].replace("role/agentx/staging/", "role/")]) expect(savedEnvRegistryReadiness({ ...valid, [role]: bad }, "staging", "123456789012")).toEqual([role]);
    }
    for (const key of Object.keys(valid)) expect(savedEnvRegistryReadiness({ ...valid, [key]: "" }, "staging", "123456789012")).toContain(key);
    expect(savedEnvRegistryReadiness({ ...valid, SavedEnvRegistryReady: "0" }, "staging", "123456789012")).toEqual(["SavedEnvRegistryReady"]);
    expect(savedEnvRegistryReadiness({ ...valid, SavedEnvImgPushRoleArn: "arn:aws:iam::210987654321:role/agentx/staging/agentx-staging-img-push" }, "staging", "123456789012")).toEqual(["SavedEnvImgPushRoleArn"]);
    expect(savedEnvRegistryReadiness({ ...valid, SavedEnvImgPullRoleArn: "arn:aws:iam::123456789012:role/agentx/other/agentx-other-img-pull" }, "staging", "123456789012")).toEqual(["SavedEnvImgPullRoleArn"]);
    expect(savedEnvRegistryReadiness({ ...valid, SavedEnvRepoPrefix: "rovara-env/production" }, "staging", "123456789012")).toEqual(["SavedEnvRepoPrefix"]);
  });
  it("has every key the spec names, plus the budget", () => {
    expect(CONFIG_KEYS.map((entry) => entry.key)).toEqual([
      "models.orchestrator", "models.classifier", "models.worker", "models.e2eAgent", "models.fallback", "models.chatgpt.enabled", "models.chatgpt.preferredModel",
      "limits.workspacesPerMember", "limits.workspacesPerOrg", "limits.threadTurnsPerMinute",
      "slack.appPostedMessages", "alerts.address", "alerts.slowTurnMinutes",
      "budget.monthlyUsd", "budget.scope", "channels.adapters", "slack.viaChannel", "coreEngine.switch", "coreEngine.modelGatewayUrl", "coreEngine.agentModel", "testServices.images", "savedEnvironments.switch", "coreEngine.answersModel", "coreEngine.learningModel", "mcp.confirmElicitation",
      // DEC 254zg (a), 254zk: Code's company layer, self-serve create and per-company Slack bots.
      "company.signIn", "company.selfServe", "slack.companyWorkspaces",
    ]);
  });

  it("maps the saved-environment CLI words to the stack's 0/1 parameter", () => {
    const key = configKey("savedEnvironments.switch");
    expect(key.parse("on")).toBe("1");
    expect(key.parse("off")).toBe("0");
    expect(key.shown?.("0")).toBe("off");
    expect(key.shown?.("1")).toBe("on");
    expect(() => key.parse("1")).toThrow("savedEnvironments.switch must be on or off; nothing changed");
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

  it("routes Sign in with ChatGPT's switch and preferred model to the control plane alone, off by default (#343)", () => {
    expect(configKey("models.chatgpt.enabled")).toMatchObject({ target: { kind: "chatgpt-setting", field: "enabled" }, defaultValue: "false" });
    expect(configKey("models.chatgpt.preferredModel")).toMatchObject({ target: { kind: "chatgpt-setting", field: "preferredModel" }, defaultValue: "gpt-6.1-sol" });
    expect(configKey("models.chatgpt.enabled").parse(" true ")).toBe("true");
    expect(() => configKey("models.chatgpt.enabled").parse("yes")).toThrow("models.chatgpt.enabled must be one of true, false; nothing changed");
    expect(configKey("models.chatgpt.preferredModel").parse("gpt-5.5")).toBe("gpt-5.5");
    expect(() => configKey("models.chatgpt.preferredModel").parse("gpt 5")).toThrow("models.chatgpt.preferredModel must be a model ID such as gpt-6.1-sol; nothing changed");
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
