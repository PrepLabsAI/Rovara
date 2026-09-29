import { describe, expect, it } from "vitest";
import { alertChecks, capacityChecks, modelChecks, signInChecks } from "../../packages/cli/src/doctor/account.js";
import { reportText } from "../../packages/cli/src/doctor/checks.js";
import { runDoctor } from "../../packages/cli/src/doctor/run.js";
import { writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { writeInstallAnswers, writeInstallProgress } from "../../packages/cli/src/init/install-state.js";
import { doctorContext, doctorServices, healthyStacks, PROGRESS, SECRETS, SETTINGS } from "../support/doctor-fakes.js";
import { fakeSlackApi, memoryInitSecrets, passingChecks, sampleAnswers, TEST_BOT_TOKEN, TEST_PRIVATE_KEY, TEST_SIGNING_SECRET } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";
import { fakeAlerts } from "../support/setup-fakes.js";

describe("doctor: models (FR-050)", () => {
  it("tests each distinct model once and fails one the account cannot use, with the config command to change it", async () => {
    const checks = passingChecks({ converse: async (id) => { if (id === "amazon.nova-pro-v1:0") throw Object.assign(new Error("no access"), { name: "AccessDeniedException" }); } });
    const found = await modelChecks(doctorContext({ services: doctorServices({ checks }) }));
    expect(found.map((entry) => [entry.name, entry.status])).toEqual([["orchestrator", "ok"], ["classifier", "ok"], ["worker", "fail"]]);
    expect(found[2]!.fix).toBe("choose another model with agentx --env staging config set models.worker <model id>");
  });
});

describe("doctor: models (Task 8 polish)", () => {
  it("calls each distinct model once, however many roles share it", async () => {
    const checks = passingChecks();
    const settings = { ...SETTINGS, models: { ...SETTINGS.models, classifier: "amazon.nova-pro-v1:0", worker: "amazon.nova-pro-v1:0" } };
    const found = await modelChecks(doctorContext({ settings, services: doctorServices({ checks }) }));
    expect(found.map((entry) => entry.status)).toEqual(["ok", "ok", "ok"]);
    expect(checks.models).toEqual(["us.anthropic.claude-sonnet-4-6", "amazon.nova-pro-v1:0"]);
  });

  it("words a failed model in doctor's terms: agentx config set, never init's flags", async () => {
    for (const error of [
      Object.assign(new Error("no access"), { name: "AccessDeniedException" }),
      Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" }),
      Object.assign(new Error("model use case details have not been submitted"), { name: "ResourceNotFoundException" }),
      Object.assign(new Error("Invocation with on-demand throughput isn't supported"), { name: "ValidationException" }),
      Object.assign(new Error("The provided model identifier is invalid"), { name: "ValidationException" }),
      new Error("socket hang up"),
      Object.assign(new Error("getaddrinfo ENOTFOUND bedrock-runtime.us-east-1.amazonaws.com"), { code: "ENOTFOUND" }),
    ]) {
      const checks = passingChecks({ converse: async (id) => { if (id === "amazon.nova-pro-v1:0") throw error; } });
      const worker = (await modelChecks(doctorContext({ services: doctorServices({ checks }) })))[2]!;
      expect(worker.status).toBe("fail");
      expect(worker.detail).not.toContain("--worker-model");
      expect(worker.detail).not.toContain("agentx init");
      expect(worker.detail).not.toContain("--region");
    }
    const denied = passingChecks({ converse: async (id) => { if (id === "amazon.nova-pro-v1:0") throw Object.assign(new Error("no access"), { name: "AccessDeniedException" }); } });
    expect((await modelChecks(doctorContext({ services: doctorServices({ checks: denied }) })))[2]!.detail).toContain("agentx --env staging config set models.worker <model id>");
  });
});

describe("doctor: alerts and the budget (FR-050)", () => {
  it("passes a confirmed subscription and a budget that matches its parameter", async () => {
    expect((await alertChecks(doctorContext())).map((entry) => [entry.name, entry.status])).toEqual([["subscription", "ok"], ["budget", "ok"]]);
  });

  it("fails when an address is set but nobody is subscribed, and warns when nothing is confirmed yet", async () => {
    expect((await alertChecks(doctorContext({ services: doctorServices({ alerts: fakeAlerts({ budgetUsd: 100 }) }) })))[0]).toMatchObject({ status: "fail", fix: "agentx --env staging config set alerts.address <email>" });
    const pending = fakeAlerts({ existing: [{ arn: "PendingConfirmation", protocol: "email", endpoint: "ops@example.com" }], confirmAfterPolls: 99, budgetUsd: 100 });
    expect((await alertChecks(doctorContext({ services: doctorServices({ alerts: pending }) })))[0]?.status).toBe("warn");
  });

  it("warns, and does not fail, when no alert address was ever set", async () => {
    const context = doctorContext({ answers: sampleAnswers({ alert: { kind: "none" } }), services: doctorServices({ alerts: fakeAlerts({ budgetUsd: 100 }) }) });
    expect((await alertChecks(context))[0]).toMatchObject({ status: "warn", detail: "no alert address is set, so alarms go nowhere" });
  });

  it("fails a missing budget and passes budget.monthlyUsd 0 as no budget", async () => {
    expect((await alertChecks(doctorContext({ services: doctorServices({ alerts: fakeAlerts({ existing: [{ arn: "arn:aws:sns:us-east-1:123456789012:agentx-staging-alerts:1", protocol: "email", endpoint: "ops@example.com" }] }) }) })))[1]).toMatchObject({ status: "fail", detail: "the budget agentx-staging-monthly is missing" });
    const stacks = healthyStacks();
    stacks["agentx-staging-control-plane"] = { ...stacks["agentx-staging-control-plane"]!, parameters: { ...stacks["agentx-staging-control-plane"]!.parameters, BudgetMonthlyUsd: "0" } };
    expect((await alertChecks(doctorContext({ services: doctorServices({ stackMap: stacks }) })))[1]).toMatchObject({ status: "ok", detail: "no budget (budget.monthlyUsd is 0)" });
  });
});

describe("doctor: capacity (item 5)", () => {
  it("reports free Elastic IPs and warns when a second environment would not fit", async () => {
    expect((await capacityChecks(doctorContext())).find((entry) => entry.name === "Elastic IPs")).toMatchObject({ status: "ok", detail: "5 of 5 EC2-VPC Elastic IPs free in us-east-1" });
    const tight = passingChecks({ elasticIps: async () => ({ quota: 5, allocated: 4 }) });
    const found = (await capacityChecks(doctorContext({ services: doctorServices({ checks: tight }) }))).find((entry) => entry.name === "Elastic IPs")!;
    expect(found.status).toBe("warn");
    expect(found.fix).toContain("aws service-quotas request-service-quota-increase --service-code ec2 --quota-code L-0263D0A3 --desired-value 6 --region us-east-1");
  });
});

describe("doctor: developer sign-in (spec 025 FR-046)", () => {
  it("shows agentx signin check's checks as they are", async () => {
    const services = doctorServices({ signIn: async () => [{ name: "Slack redirect URL", ok: true, warn: true, detail: "not verified" }, { name: "Slack team ID", ok: false, detail: "no team ID is recorded" }] });
    expect((await signInChecks(doctorContext({ services }))).map((entry) => [entry.name, entry.status])).toEqual([["Slack redirect URL", "warn"], ["Slack team ID", "fail"]]);
  });
});

describe("runDoctor", () => {
  async function store(settings = SETTINGS): Promise<MemoryParameterStore> {
    const seeded = new MemoryParameterStore();
    await writeEnvironmentSettings(seeded, settings);
    await writeInstallAnswers(seeded, sampleAnswers());
    await writeInstallProgress(seeded, PROGRESS);
    return seeded;
  }

  it("passes a healthy environment", async () => {
    const report = await runDoctor({ env: "staging", store: await store(), services: () => doctorServices() });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
    expect(report.failed).toBe(0);
  });

  it("reports every broken piece at once, and no secret value in text or JSON", async () => {
    const services = () => doctorServices({
      secrets: memoryInitSecrets({ ...SECRETS, "agentx/staging/slack": JSON.stringify({ botToken: TEST_BOT_TOKEN, signingSecret: "not-hex" }) }),
      slackApi: fakeSlackApi({ authTest: async () => ({ ok: false, error: "invalid_auth" }) }),
      checks: passingChecks({ converse: async () => { throw new Error("throttled"); } }),
      github: { ...doctorServices().github, listInstallations: async () => { throw new Error("401"); } },
    });
    const report = await runDoctor({ env: "staging", store: await store(), services });
    expect(report.failed).toBeGreaterThanOrEqual(4);
    for (const output of [JSON.stringify(report), reportText(report)]) {
      for (const secret of [TEST_BOT_TOKEN, TEST_SIGNING_SECRET, TEST_PRIVATE_KEY.slice(40, 80), SECRETS["agentx/staging/callback-signing-key"]!]) expect(output).not.toContain(secret);
    }
  });

  it("refuses an environment that is not installed, and the legacy deployment", async () => {
    await expect(runDoctor({ env: "staging", store: new MemoryParameterStore(), services: () => doctorServices() })).rejects.toThrow("environment staging is not installed in this account and region");
    await expect(runDoctor({ env: "staging", store: await store({ ...SETTINGS, naming: "legacy" }), services: () => doctorServices() })).rejects.toThrow("agentx doctor checks environments installed with agentx init; staging uses the legacy stack names");
  });

  it("skips the budget check, not passes it, when the control-plane stack is missing", async () => {
    const stacks = healthyStacks();
    delete stacks["agentx-staging-control-plane"];
    const budget = (await alertChecks(doctorContext({ services: doctorServices({ stackMap: stacks }) })))[1]!;
    expect(budget).toMatchObject({ name: "budget", status: "skip" });
    expect(budget.detail).toContain("agentx-staging-control-plane does not exist");
  });

  it("runs the later groups when an early group throws", async () => {
    const services = () => doctorServices({ stacks: { describe: async () => { throw new Error("CloudFormation is unreachable"); } } });
    const report = await runDoctor({ env: "staging", store: await store(), services });
    expect(report.checks).toContainEqual(expect.objectContaining({ group: "stacks", name: "stacks checks", status: "fail" }));
    expect(report.checks.filter((entry) => entry.group === "capacity").map((entry) => entry.status)).toEqual(["ok", "ok"]);
    expect(report.checks.filter((entry) => entry.group === "sign-in").map((entry) => entry.status)).toEqual(["ok"]);
    expect(report.checks.some((entry) => entry.group === "models" && entry.status === "ok")).toBe(true);
  });

  it("says what to do when doctor's clients cannot be set up", async () => {
    await expect(runDoctor({ env: "staging", store: await store(), services: () => { throw new Error("Could not load credentials from any providers"); } }))
      .rejects.toThrow("could not set up doctor's AWS, Slack and GitHub clients (Could not load credentials from any providers); sign in to AWS for this account and region, then run agentx doctor again");
  });

  it("keeps going when a group throws, reporting it as one failed check", async () => {
    const services = () => doctorServices({ signIn: async () => { throw new Error("SSM read failed"); } });
    const report = await runDoctor({ env: "staging", store: await store(), services });
    expect(report.checks).toContainEqual({ group: "sign-in", name: "sign-in checks", status: "fail", detail: "could not run the sign-in checks: SSM read failed", fix: "fix the problem named above, then run agentx doctor again" });
  });
});
