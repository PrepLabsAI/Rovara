// tests/contract/config-set-audit.test.ts
// Issue #205: every agentx config set change is in the admin change history. A stack-parameter key
// (mcp.confirmElicitation, models.*, alerts.slowTurnMinutes, ...) applies as a stack update from
// this computer, so the CLI records it through the admin API: one record, made after the yes and
// before the update (applying), then stepped to applied or failed. A secret-bearing key's record
// names the key only, never a value.
import { describe, expect, it } from "vitest";
import { exportChanges } from "../../packages/cli/src/admin/changes.js";
import { runConfigSet, type ConfigServices } from "../../packages/cli/src/config/commands.js";
import { createAdminChangeBroker } from "../support/admin-change-broker.js";
import { configServicesFor, seeded, stacks } from "../support/config-services.js";
import { fakeCloudFormation } from "../support/fake-cloudformation.js";
import { memoryInitSecrets, scriptedPrompter, T0 } from "../support/init-fakes.js";
import { lockParameterName } from "../../packages/cli/src/environments/lock.js";
import { fakeAlerts } from "../support/setup-fakes.js";

type Harness = Awaited<ReturnType<typeof createAdminChangeBroker>>;
const SESSION = { controlPlaneUrl: "https://abc123.execute-api.us-east-1.amazonaws.com", accessToken: "admin-token-for-tests" };
const WEBHOOK = "https://events.pagerduty.com/integration/SECRETkey0123456789/enqueue";

/** The CLI's fetch, into the broker in process, with the admin sign-in's claims. `fail` answers a path with an error instead. */
function brokerFetch(harness: Harness, fail?: (path: string) => Response | undefined): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const failed = fail?.(url.pathname);
    if (failed !== undefined) return failed;
    const answer = await harness.admin(init?.method ?? "GET", `${url.pathname}${url.search}`, { ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}) });
    return Response.json(answer.body, { status: answer.status });
  };
}

const audits = (harness: Harness) => harness.db.find((item) => item.entityType === "ADMIN_CHANGE_AUDIT");

/** Config services over the broker, with a control plane stack that has McpConfirmElicitation. */
async function configOver(harness: Harness, overrides: Partial<ConfigServices> = {}, mcp = "enabled") {
  const cloudFormation = fakeCloudFormation({ parameters: { McpConfirmElicitation: mcp, SlackThreadTurnsPerMinute: "6", CallbackSigningKey: "****" } });
  const services = await configServicesFor({
    adminSession: async () => SESSION,
    fetch: brokerFetch(harness),
    cloudFormation,
    stacks: stacks({ "agentx-staging-control-plane": { McpConfirmElicitation: mcp, SlackThreadTurnsPerMinute: "6" }, "agentx-staging-slack": { SlowTurnMinutes: "5", ModelId: "us.anthropic.claude-sonnet-4-6" }, "agentx-staging-runtime": { ModelId: "us.anthropic.claude-sonnet-4-6" } }),
    ...overrides,
  });
  return { services, cloudFormation };
}

describe("agentx config set records stack-parameter changes in the admin change history (#205)", () => {
  it("mcp.confirmElicitation disabled writes one record: admin, cli client, before enabled, after disabled, applied", async () => {
    const harness = await createAdminChangeBroker();
    const { services, cloudFormation } = await configOver(harness);
    expect(await runConfigSet(services, "staging", { key: "mcp.confirmElicitation", value: "disabled", yes: true })).toEqual({ changed: true });
    expect(cloudFormation.parameters.McpConfirmElicitation).toBe("disabled");
    const records = audits(harness);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record).toMatchObject({
      kind: "set_config",
      admin: { subject: "admin-subject", displayName: "Ada" },
      client: { cliVersion: expect.any(String) as unknown },
      change: { kind: "set_config", key: "mcp.confirmElicitation", target: "stack parameter McpConfirmElicitation on agentx-staging-control-plane", before: "enabled", after: "disabled" },
      methodsOffered: ["cli"], methodUsed: "cli", status: "applied", outcome: "confirmed",
    });
    expect(record.effect).toBe("mcp.confirmElicitation: enabled -> disabled (stack parameter McpConfirmElicitation on agentx-staging-control-plane)");
    for (const time of ["proposedAt", "answeredAt", "appliedAt"]) expect(Date.parse(record[time] as string)).not.toBeNaN();
    expect(record.failedAt).toBeUndefined();
    expect(harness.metrics).toEqual(["confirmed"]);
  });

  it("setting it back to enabled writes a second record the other way", async () => {
    const harness = await createAdminChangeBroker();
    const { services } = await configOver(harness, {}, "disabled");
    await runConfigSet(services, "staging", { key: "mcp.confirmElicitation", value: "enabled", yes: true });
    expect(audits(harness).map((record) => record.change)).toEqual([expect.objectContaining({ before: "disabled", after: "enabled" })]);
  });

  it("keeps the existing prompt; a no records nothing and changes nothing", async () => {
    const harness = await createAdminChangeBroker();
    const prompter = scriptedPrompter([false]);
    const { services, cloudFormation } = await configOver(harness, { prompter });
    await expect(runConfigSet(services, "staging", { key: "mcp.confirmElicitation", value: "disabled", yes: false }))
      .rejects.toThrow("the config change to agentx-staging-control-plane was not applied; nothing changed");
    expect(prompter.asked).toEqual(["Apply this change to agentx-staging-control-plane?"]);
    expect(cloudFormation.calls.filter((call) => call.name === "ExecuteChangeSetCommand")).toEqual([]);
    expect(audits(harness)).toEqual([]);
  });

  it("records a yes at the prompt with when it was asked and answered", async () => {
    const harness = await createAdminChangeBroker();
    const { services } = await configOver(harness, { prompter: scriptedPrompter([true]) });
    await runConfigSet(services, "staging", { key: "mcp.confirmElicitation", value: "disabled", yes: false });
    const record = audits(harness)[0]!;
    expect(record).toMatchObject({ status: "applied", methodUsed: "cli" });
    expect(Date.parse(record.confirmationRequestedAt as string)).not.toBeNaN();
    expect(Date.parse(record.answeredAt as string)).toBeGreaterThanOrEqual(Date.parse(record.proposedAt as string));
  });

  it("records a stack update that fails as failed, with its error, and the command still fails", async () => {
    const harness = await createAdminChangeBroker();
    const cloudFormation = fakeCloudFormation({ parameters: { McpConfirmElicitation: "enabled" }, finalStatus: "UPDATE_ROLLBACK_COMPLETE" });
    const { services } = await configOver(harness, { cloudFormation });
    await expect(runConfigSet(services, "staging", { key: "mcp.confirmElicitation", value: "disabled", yes: true })).rejects.toThrow("ended in UPDATE_ROLLBACK_COMPLETE");
    const records = audits(harness);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: "set_config", status: "failed", outcome: "failed", error: { code: "CONFIG_INVALID", message: expect.stringContaining("stack agentx-staging-control-plane ended in UPDATE_ROLLBACK_COMPLETE") as unknown } });
    expect(Date.parse(records[0]!.failedAt as string)).not.toBeNaN();
    expect(records[0]!.appliedAt).toBeUndefined();
    expect(harness.metrics).toEqual(["failed"]);
  });

  it("changes nothing when the change cannot be recorded first, and says why", async () => {
    const harness = await createAdminChangeBroker();
    const fetch = brokerFetch(harness, (path) => (path === "/v1/admin/changes/config" ? Response.json({ error: { code: "RUNTIME_UNAVAILABLE", message: "busy" } }, { status: 503 }) : undefined));
    const { services, cloudFormation } = await configOver(harness, { fetch });
    await expect(runConfigSet(services, "staging", { key: "mcp.confirmElicitation", value: "disabled", yes: true }))
      .rejects.toThrow("mcp.confirmElicitation was not changed: AgentX could not record the change in the admin change history (busy); nothing changed, try again");
    expect(cloudFormation.calls.filter((call) => call.name === "ExecuteChangeSetCommand")).toEqual([]);
    expect(cloudFormation.calls.filter((call) => call.name === "DeleteChangeSetCommand")).toHaveLength(1);
    expect(cloudFormation.parameters.McpConfirmElicitation).toBe("enabled");
  });

  it("names agentx upgrade when the control plane is too old to record it", async () => {
    const harness = await createAdminChangeBroker();
    const fetch = brokerFetch(harness, (path) => (path === "/v1/admin/changes/config" ? Response.json({ error: { code: "NOT_FOUND", message: "route not found" } }, { status: 404 }) : undefined));
    const { services, cloudFormation } = await configOver(harness, { fetch });
    await expect(runConfigSet(services, "staging", { key: "mcp.confirmElicitation", value: "disabled", yes: true }))
      .rejects.toThrow("mcp.confirmElicitation was not changed: this environment's control plane cannot record config changes yet; upgrade it with agentx --env staging upgrade, then try again; nothing changed");
    expect(cloudFormation.calls.filter((call) => call.name === "ExecuteChangeSetCommand")).toEqual([]);
  });

  it("warns, and the record stays applying, when the outcome cannot be recorded after the stack changed", async () => {
    const harness = await createAdminChangeBroker();
    const fetch = brokerFetch(harness, (path) => (path.endsWith("/outcome") ? Response.json({ error: { code: "RUNTIME_UNAVAILABLE", message: "busy" } }, { status: 503 }) : undefined));
    const { services, cloudFormation } = await configOver(harness, { fetch });
    expect(await runConfigSet(services, "staging", { key: "mcp.confirmElicitation", value: "disabled", yes: true })).toEqual({ changed: true });
    expect(cloudFormation.parameters.McpConfirmElicitation).toBe("disabled");
    const record = audits(harness)[0]!;
    expect(record).toMatchObject({ status: "applying" });
    expect(record.outcome).toBeUndefined();
    expect(services.lines).toContain(`Warning: mcp.confirmElicitation changed, but AgentX could not record that it applied, so agentx admin changes shows change ${record.changeId as string} as applying.`);
  });

  it("without the admin sign-in, warns first and the change goes ahead unrecorded, as the operator role alone may (SC-005)", async () => {
    const harness = await createAdminChangeBroker();
    let fetched = 0;
    const { services, cloudFormation } = await configOver(harness, { adminSession: async () => undefined, fetch: (async () => { fetched += 1; return Response.json({}); }) as unknown as typeof fetch });
    expect(await runConfigSet(services, "staging", { key: "mcp.confirmElicitation", value: "disabled", yes: true })).toEqual({ changed: true });
    expect(services.lines[0]).toBe("Warning: this change to mcp.confirmElicitation will not be recorded in the admin change history, because this computer has no admin sign-in for staging; it goes ahead now. To record config changes, run agentx --env staging login --admin before config set.");
    expect(cloudFormation.parameters.McpConfirmElicitation).toBe("disabled");
    expect(fetched).toBe(0);
  });

  it("refuses a sign-in that ends before a stack update could finish and be recorded, before any change set is made", async () => {
    const harness = await createAdminChangeBroker();
    const { services, cloudFormation } = await configOver(harness, { adminSession: async () => ({ ...SESSION, expiresAt: T0 + 20 * 60_000 }) });
    await expect(runConfigSet(services, "staging", { key: "mcp.confirmElicitation", value: "disabled", yes: true }))
      .rejects.toMatchObject({ code: "AUTH_REQUIRED", message: expect.stringContaining("this computer's admin sign-in for staging ends in 20 minutes, too soon to record how this mcp.confirmElicitation change ends; run agentx --env staging login --admin again, then try again; nothing changed") as unknown });
    expect(cloudFormation.calls.filter((call) => call.name === "CreateChangeSetCommand")).toEqual([]);
    const later = await configOver(harness, { adminSession: async () => ({ ...SESSION, expiresAt: T0 + 50 * 60_000 }) });
    expect(await runConfigSet(later.services, "staging", { key: "mcp.confirmElicitation", value: "disabled", yes: true })).toEqual({ changed: true });
  });

  it("checks the sign-in again after the prompt, which may have stayed open, and changes nothing if too little is left", async () => {
    const harness = await createAdminChangeBroker();
    let now = T0;
    const prompter = { ...scriptedPrompter([]), confirm: async () => { now += 20 * 60_000; return true; } };
    const { services, cloudFormation } = await configOver(harness, { now: () => now, prompter, adminSession: async () => ({ ...SESSION, expiresAt: T0 + 50 * 60_000 }) });
    await expect(runConfigSet(services, "staging", { key: "mcp.confirmElicitation", value: "disabled", yes: false }))
      .rejects.toMatchObject({ code: "AUTH_REQUIRED", message: expect.stringContaining("ends in 30 minutes, too soon to record how this mcp.confirmElicitation change ends") as unknown });
    expect(cloudFormation.calls.filter((call) => call.name === "ExecuteChangeSetCommand")).toEqual([]);
    expect(audits(harness)).toEqual([]);
  });

  it("without the admin sign-in at the prompt, says to answer no and sign in first", async () => {
    const harness = await createAdminChangeBroker();
    const { services } = await configOver(harness, { adminSession: async () => undefined, prompter: scriptedPrompter([false]) });
    await expect(runConfigSet(services, "staging", { key: "mcp.confirmElicitation", value: "disabled", yes: false })).rejects.toThrow("was not applied");
    expect(services.lines[0]).toBe("Warning: this change to mcp.confirmElicitation will not be recorded in the admin change history, because this computer has no admin sign-in for staging. To record it, answer no, run agentx --env staging login --admin, then run this again.");
  });

  it("says to sign in again when AgentX refuses the sign-in it is recorded with", async () => {
    const harness = await createAdminChangeBroker();
    const fetch = brokerFetch(harness, (path) => (path === "/v1/admin/changes/config" ? Response.json({ error: { code: "AUTH_REQUIRED", message: "the token has expired" } }, { status: 401 }) : undefined));
    const { services, cloudFormation } = await configOver(harness, { fetch });
    await expect(runConfigSet(services, "staging", { key: "mcp.confirmElicitation", value: "disabled", yes: true }))
      .rejects.toMatchObject({ code: "AUTH_REQUIRED", message: expect.stringContaining("mcp.confirmElicitation was not changed: AgentX would not record the change with this computer's admin sign-in (the token has expired); run agentx --env staging login --admin, then try again; nothing changed") as unknown });
    expect(cloudFormation.calls.filter((call) => call.name === "ExecuteChangeSetCommand")).toEqual([]);
  });

  it("asks once more with the same request ID when an answer is lost, and records the change once", async () => {
    const harness = await createAdminChangeBroker();
    let lost = 0;
    const real = brokerFetch(harness);
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const answer = await real(input, init);
      // The first record request is written, and its answer lost on the way back.
      if (new URL(input instanceof Request ? input.url : input).pathname === "/v1/admin/changes/config" && lost === 0) { lost += 1; throw new TypeError("fetch failed"); }
      return answer;
    }) as typeof globalThis.fetch;
    const { services } = await configOver(harness, { fetch });
    expect(await runConfigSet(services, "staging", { key: "mcp.confirmElicitation", value: "disabled", yes: true })).toEqual({ changed: true });
    expect(audits(harness)).toEqual([expect.objectContaining({ status: "applied", change: expect.objectContaining({ before: "enabled", after: "disabled" }) as unknown })]);
  });

  it("leaves the record applying, and says so, when the stack update may still be running", async () => {
    const harness = await createAdminChangeBroker();
    const inner = fakeCloudFormation({ parameters: { McpConfirmElicitation: "enabled" } });
    let executed = false;
    const cloudFormation = {
      calls: inner.calls, parameters: inner.parameters,
      async send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> {
        if (executed && command.constructor.name === "DescribeChangeSetCommand") throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
        if (command.constructor.name === "ExecuteChangeSetCommand") executed = true;
        return inner.send(command);
      },
    };
    const { services } = await configOver(harness, { cloudFormation });
    await expect(runConfigSet(services, "staging", { key: "mcp.confirmElicitation", value: "disabled", yes: true })).rejects.toThrow("Rate exceeded");
    const record = audits(harness)[0]!;
    expect(record).toMatchObject({ status: "applying" });
    expect(record.outcome).toBeUndefined();
    expect(services.lines).toContain(`Warning: the mcp.confirmElicitation change may still be applying, so agentx admin changes shows change ${record.changeId as string} as applying; check agentx-staging-control-plane in the CloudFormation console.`);
  });

  it("with --yes, records no prompt time", async () => {
    const harness = await createAdminChangeBroker();
    const { services } = await configOver(harness);
    await runConfigSet(services, "staging", { key: "mcp.confirmElicitation", value: "disabled", yes: true });
    expect(audits(harness)[0]!.confirmationRequestedAt).toBeUndefined();
  });

  it.each([
    ["alerts.slowTurnMinutes", "9", "5", "stack parameter SlowTurnMinutes on agentx-staging-slack"],
    ["limits.threadTurnsPerMinute", "12", "6", "stack parameter SlackThreadTurnsPerMinute on agentx-staging-control-plane"],
    ["models.worker", "zai.glm-4.7", "us.anthropic.claude-sonnet-4-6", "stack parameter ModelId on agentx-staging-runtime"],
  ])("records %s, which shares the stack-parameter path", async (key, value, before, target) => {
    const harness = await createAdminChangeBroker();
    const cloudFormation = fakeCloudFormation({ parameters: { SlowTurnMinutes: "5", SlackThreadTurnsPerMinute: "6", ModelId: "us.anthropic.claude-sonnet-4-6" } });
    const { services } = await configOver(harness, { cloudFormation });
    await runConfigSet(services, "staging", { key, value, yes: true });
    expect(audits(harness)).toEqual([expect.objectContaining({ kind: "set_config", status: "applied", change: { kind: "set_config", key, target, before, after: value } })]);
  });

  it("records nothing when the value is already set", async () => {
    const harness = await createAdminChangeBroker();
    const { services } = await configOver(harness);
    expect(await runConfigSet(services, "staging", { key: "mcp.confirmElicitation", value: "enabled", yes: true })).toEqual({ changed: false });
    expect(audits(harness)).toEqual([]);
  });
});

describe("agentx config set alerts.address, a secret-bearing key (#205)", () => {
  it("records a webhook change as changed, never its value", async () => {
    const harness = await createAdminChangeBroker();
    const { services } = await configOver(harness, { secrets: memoryInitSecrets(), alerts: fakeAlerts({ confirmAfterPolls: 0 }), processEnv: { HOOK: WEBHOOK } });
    await runConfigSet(services, "staging", { key: "alerts.address", valueSource: { envName: "HOOK" }, yes: true });
    const records = audits(harness);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: "set_config", status: "applied", outcome: "confirmed", change: { kind: "set_config", key: "alerts.address", valueHidden: true }, effect: "alerts.address changed; the value is secret, so it is not recorded" });
    expect(records[0]!.change).not.toHaveProperty("before");
    expect(records[0]!.change).not.toHaveProperty("after");
    const stored = JSON.stringify(harness.db.find(() => true));
    expect(stored).not.toContain("SECRETkey");
    expect(stored).not.toContain("pagerduty");
  });

  it("records an email change without the address, and a failed subscribe as failed without its words", async () => {
    const harness = await createAdminChangeBroker();
    const ok = await configOver(harness, { alerts: fakeAlerts({ confirmAfterPolls: 0 }) });
    await runConfigSet(ok.services, "staging", { key: "alerts.address", value: "ops@example.com", yes: true });
    const failing = { ...fakeAlerts({ confirmAfterPolls: 0 }), subscribe: async () => { throw Object.assign(new Error(`Invalid endpoint ${WEBHOOK}`), { name: "InvalidParameterException" }); } };
    const bad = await configOver(harness, { alerts: failing, processEnv: { HOOK: WEBHOOK } });
    await expect(runConfigSet(bad.services, "staging", { key: "alerts.address", valueSource: { envName: "HOOK" }, yes: true })).rejects.toThrow("Invalid endpoint");
    const records = audits(harness);
    expect(records.map((record) => record.status).sort()).toEqual(["applied", "failed"]);
    expect(records.find((record) => record.status === "failed")).toMatchObject({ error: { code: "RUNTIME_UNAVAILABLE", message: "the change did not finish; its error is not recorded, since this setting is secret" } });
    const stored = JSON.stringify(harness.db.find((item) => item.entityType === "ADMIN_CHANGE_AUDIT"));
    expect(stored).not.toContain("ops@example.com");
    expect(stored).not.toContain("SECRETkey");
  });

  it("records nothing when the environment lock is held, since nothing started", async () => {
    const harness = await createAdminChangeBroker();
    const store = await seeded();
    const { services } = await configOver(harness, { store, alerts: fakeAlerts({ confirmAfterPolls: 0 }) });
    store.values.set(lockParameterName("staging"), JSON.stringify({ holder: "arn:aws:sts::123456789012:assumed-role/agentx-staging-operator/bob", command: "upgrade", acquiredAt: new Date(T0).toISOString() }));
    await expect(runConfigSet(services, "staging", { key: "alerts.address", value: "ops@example.com", yes: true })).rejects.toThrow("locked by");
    expect(audits(harness)).toEqual([]);
  });

  it("the broker refuses a secret-bearing key's record that carries a value", async () => {
    const harness = await createAdminChangeBroker();
    const answer = await harness.admin("POST", "/v1/admin/changes/config", { body: { change: { kind: "set_config", key: "alerts.address", target: "SSM", before: "none", after: "ops@example.com" }, client: { cliVersion: "0.0.7" } } });
    expect(answer.status).toBe(400);
    expect(JSON.stringify(harness.db.find(() => true))).not.toContain("ops@example.com");
  });
});

describe("the recorded config change routes (#205)", () => {
  const record = (harness: Harness, subject?: string) => harness.admin("POST", "/v1/admin/changes/config", {
    ...(subject === undefined ? {} : { subject }),
    body: { change: { kind: "set_config", key: "budget.monthlyUsd", target: "stack parameter BudgetMonthlyUsd on agentx-staging-control-plane", before: "100", after: "250" }, client: { cliVersion: "0.0.7" } },
  });

  it("records once: a second outcome, another admin's outcome and an outcome for a confirmable change are refused", async () => {
    const harness = await createAdminChangeBroker();
    const created = await record(harness);
    expect(created.status).toBe(201);
    const changeId = (created.body.change as { changeId: string }).changeId;
    expect(created.body.change).toMatchObject({ status: "applying", kind: "set_config" });

    const other = await harness.admin("POST", `/v1/admin/changes/${changeId}/outcome`, { subject: "another-admin", body: { outcome: "applied" } });
    expect(other).toMatchObject({ status: 403 });
    expect(harness.audit(changeId)).toMatchObject({ status: "applying", refusedAttempts: [expect.objectContaining({ reason: "another_admin" })] });

    expect(await harness.admin("POST", `/v1/admin/changes/${changeId}/outcome`, { body: { outcome: "applied" } })).toMatchObject({ status: 200, body: { change: { status: "applied", outcome: "confirmed" } } });
    const again = await harness.admin("POST", `/v1/admin/changes/${changeId}/outcome`, { body: { outcome: "failed", error: { code: "CONFIG_INVALID", message: "late" } } });
    expect(again.status).toBe(400);
    expect(harness.audit(changeId)).toMatchObject({ status: "applied", outcome: "confirmed" });

    const proposed = await harness.propose({ kind: "unbind_channel", channel: "C0123456789" }, ["cli"]);
    const proposedId = (proposed.body.change as { changeId: string }).changeId;
    expect((await harness.admin("POST", `/v1/admin/changes/${proposedId}/outcome`, { body: { outcome: "applied" } })).status).toBe(400);
    expect(harness.audit(proposedId)).toMatchObject({ status: "pending" });
  });

  it("refuses an outcome it cannot read, and answers a repeated request ID with the record it made", async () => {
    const harness = await createAdminChangeBroker();
    const changeId = ((await record(harness)).body.change as { changeId: string }).changeId;
    expect((await harness.admin("POST", `/v1/admin/changes/${changeId}/outcome`, { body: { outcome: "failed" } })).status).toBe(400);
    expect((await harness.admin("POST", `/v1/admin/changes/${changeId}/outcome`, { body: { outcome: "applied", extra: 1 } })).status).toBe(400);
    expect(harness.audit(changeId)).toMatchObject({ status: "applying" });

    const requestId = "7d7a3c1e-1b2f-4c3d-8e9f-0a1b2c3d4e5f";
    const body = { requestId, change: { kind: "set_config", key: "budget.scope", target: "stack parameter BudgetScope on agentx-staging-control-plane", before: "tag", after: "account" }, client: { cliVersion: "0.0.7" } };
    const first = await harness.admin("POST", "/v1/admin/changes/config", { body });
    const second = await harness.admin("POST", "/v1/admin/changes/config", { body });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((second.body.change as { changeId: string }).changeId).toBe((first.body.change as { changeId: string }).changeId);
    const other = await harness.admin("POST", "/v1/admin/changes/config", { body: { ...body, change: { ...body.change, after: "tag", before: "account" } } });
    expect(other).toMatchObject({ status: 409 });
    expect(audits(harness).filter((item) => (item.change as { key?: string }).key === "budget.scope")).toHaveLength(1);
  });

  it("a recorded change cannot be applied or declined through the confirmation routes", async () => {
    const harness = await createAdminChangeBroker();
    const changeId = ((await record(harness)).body.change as { changeId: string }).changeId;
    expect((await harness.apply(changeId, "cli")).status).toBe(404);
    expect((await harness.decline(changeId)).status).toBe(404);
    expect(harness.audit(changeId)).toMatchObject({ status: "applying" });
  });

  it("refuses a non-admin", async () => {
    const harness = await createAdminChangeBroker();
    const answer = await harness.admin("POST", "/v1/admin/changes/config", { admin: false, body: { change: { kind: "set_config", key: "budget.monthlyUsd", target: "t", before: "1", after: "2" }, client: { cliVersion: "0.0.7" } } });
    expect(answer.status).toBe(403);
    expect(audits(harness)).toEqual([]);
  });

  it("stays applying on a list read, unlike a confirmable change stuck applying", async () => {
    const harness = await createAdminChangeBroker();
    const changeId = ((await record(harness)).body.change as { changeId: string }).changeId;
    harness.clock.advance(60 * 60_000);
    const listed = await harness.list("?outcome=failed");
    expect(listed.body.changes).toEqual([]);
    expect(harness.audit(changeId)).toMatchObject({ status: "applying" });
  });
});

describe("agentx admin changes shows config set changes (#205)", () => {
  it("lists the change with its key in text, and with before and after in JSON", async () => {
    const harness = await createAdminChangeBroker();
    const { services } = await configOver(harness);
    await runConfigSet(services, "staging", { key: "mcp.confirmElicitation", value: "disabled", yes: true });
    const changeId = audits(harness)[0]!.changeId as string;
    const text: string[] = [];
    const since = new Date(Date.now() - 3_600_000).toISOString();
    await exportChanges({ ...SESSION, since, write: (line) => { text.push(line); }, json: false }, brokerFetch(harness));
    expect(text).toHaveLength(1);
    expect(text[0]).toMatch(new RegExp(`^\\S+  confirmed  set_config mcp\\.confirmElicitation  Ada  ${changeId}\\n$`));
    const json: string[] = [];
    await exportChanges({ ...SESSION, since, write: (line) => { json.push(line); }, json: true }, brokerFetch(harness));
    expect(JSON.parse(json[0]!)).toMatchObject({ changeId, kind: "set_config", change: { key: "mcp.confirmElicitation", before: "enabled", after: "disabled" }, status: "applied", outcome: "confirmed" });
  });
});
