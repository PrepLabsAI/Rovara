// tests/contract/admin-change-plans.test.ts
// Spec 025 E6, E7, E11, E12: a plan says exactly what will happen, against current state, and
// changes nothing; its hash moves when the state it covers moves.
import { describe, expect, it, vi } from "vitest";
import { CredentialUnavailable } from "@agentx/gateway";
import { redactSecrets, type ChannelInfoRequest, type ChannelMembersRequest } from "@agentx/contracts";
import { fieldDiff, looksLikeSecret, planChange, stateHash, type PlanDependencies } from "../../packages/broker/src/aws/admin-change-plans.js";
import { CredentialRegistry } from "../../packages/broker/src/aws/credentials.js";
import { createAdminReadBroker } from "../support/admin-read-broker.js";
import { bindChannel, registerRevision } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";

const PLANTED = `ghp_${"D".repeat(36)}`;
const admin = { issuer: "https://identity.example.test", subject: "admin-subject", ownerKey: "", isAdministrator: true, claims: {} };
const MEMBER_ADMIN = "U0ADMIN001";
const githubApp = { ref: "github-app", secretName: "arn:aws:secretsmanager:us-east-1:111122223333:secret:github-key" };
const repository = { name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" };

async function harness(options: { channelByName?: PlanDependencies["channelByName"]; secrets?: { read(name: string): Promise<string | undefined> } } = {}) {
  const channelInfo = vi.fn(async (request: ChannelInfoRequest) => ({
    ok: true as const,
    channels: request.channelIds.map((channelId) => ({
      channelId,
      name: channelId === SLACK_CHANNEL ? "payments-dev" : channelId === "C0PRIVATE01" ? "secret-launch" : "ledger-dev",
      isPrivate: channelId === "C0PRIVATE01",
    })),
  }));
  const channelMembers = vi.fn(async (request: ChannelMembersRequest) => ({ ok: true as const, memberOf: request.slackUserId === MEMBER_ADMIN ? request.channelIds.filter((id) => id === "C0PRIVATE01") : [] }));
  const broker = await createAdminReadBroker({
    channelInfo, channelMembers,
    ...(options.secrets === undefined ? {} : { brokerExtra: { connectorCredentials: { secrets: options.secrets, githubApp } } }),
  });
  const module = await import("../../packages/broker/src/aws/broker.js") as unknown as { createPlanDependencies(input: never): PlanDependencies };
  const developer = (broker.brokerInput as { developer: object }).developer;
  const deps = module.createPlanDependencies({ ...broker.brokerInput, ...(options.channelByName ? { developer: { ...developer, channelByName: options.channelByName } } : {}) } as never);
  // The registering admin's owner key: registration wrote its administrator membership.
  const membership = broker.db.find((item) => item.entityType === "MEMBERSHIP" && item.role === "administrator")[0]!;
  return { ...broker, deps, channelMembers, identity: { ...admin, ownerKey: String(membership.ownerKey) } };
}

describe("binding and unbinding (E7, E12)", () => {
  it("shows the channel, its current binding and the revision new threads use, and changes nothing", async () => {
    const { deps, identity, db, handler } = await harness({ channelByName: async () => ({ ok: true, channel: { channelId: "C0LEDGER01", name: "ledger-dev" } }) });
    await registerRevision(handler, 7, {});
    const plan = await planChange(deps, identity, { kind: "bind_channel", channel: "#ledger-dev", project: "payments" });
    expect(plan.effect).toBe("Bind channel #ledger-dev (C0LEDGER01) to project payments. It is bound to nothing today. New threads in #ledger-dev will use payments revision 7.");
    expect(plan.confirmationEffect).toBeUndefined();
    expect(db.get(`SLACK_BINDING#${SLACK_TEAM}`, "CHANNEL#C0LEDGER01")).toBeUndefined();
    // E12: with or without the "#".
    const bare = await planChange(deps, identity, { kind: "bind_channel", channel: "ledger-dev", project: "payments" });
    expect(bare.effect).toBe(plan.effect);
    const again = await planChange(deps, identity, { kind: "bind_channel", channel: "C0LEDGER01", project: "payments" });
    expect(stateHash(again.snapshot)).toBe(stateHash(plan.snapshot));
    await bindChannel(handler, "C0LEDGER01", "payments");
    await expect(planChange(deps, identity, { kind: "bind_channel", channel: "C0LEDGER01", project: "payments" })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: channel #ledger-dev (C0LEDGER01) is already bound to payments; there is nothing to change" });
  });

  it("moves the hash when the binding moves, and applies through the binding handler", async () => {
    const { deps, identity, db, handler } = await harness();
    const before = await planChange(deps, identity, { kind: "bind_channel", channel: "C0LEDGER01", project: "payments" });
    await registerRevision(handler, 2, {});
    const after = await planChange(deps, identity, { kind: "bind_channel", channel: "C0LEDGER01", project: "payments" });
    expect(stateHash(after.snapshot)).not.toBe(stateHash(before.snapshot));
    await after.apply(identity);
    expect(db.get(`SLACK_BINDING#${SLACK_TEAM}`, "CHANNEL#C0LEDGER01")).toMatchObject({ projectName: "payments" });
  });

  it("names a private channel by ID only, and refuses a private channel's name", async () => {
    const { deps, identity } = await harness({ channelByName: async () => ({ ok: true }) });
    const plan = await planChange(deps, identity, { kind: "bind_channel", channel: "C0PRIVATE01", project: "payments" });
    expect(plan.effect).toContain("Bind channel C0PRIVATE01 (a private channel) to project payments.");
    expect(JSON.stringify(plan)).not.toContain("secret-launch");
    await expect(planChange(deps, identity, { kind: "bind_channel", channel: "#secret-launch", project: "payments" })).rejects.toMatchObject({ code: "NOT_FOUND", message: "NOT_FOUND: no public channel named #secret-launch in this Slack workspace; give a private channel by its ID" });
  });

  it("names a private channel to a member admin in the confirmation only; the stored effect, details and hash keep the ID (B4, R4)", async () => {
    const { deps, identity, channelMembers } = await harness();
    const member = await planChange(deps, identity, { kind: "bind_channel", channel: "C0PRIVATE01", project: "payments" }, { slackUserId: MEMBER_ADMIN });
    expect(member.confirmationEffect).toBe("Bind channel #secret-launch (C0PRIVATE01, a private channel) to project payments. It is bound to nothing today. New threads in #secret-launch will use payments revision 1.");
    expect(member.effect).toBe("Bind channel C0PRIVATE01 (a private channel) to project payments. It is bound to nothing today. New threads in C0PRIVATE01 will use payments revision 1.");
    expect(JSON.stringify([member.effect, member.details, member.snapshot])).not.toContain("secret-launch");
    expect(channelMembers).toHaveBeenCalledWith({ kind: "channel-members", slackUserId: MEMBER_ADMIN, channelIds: ["C0PRIVATE01"] });
    const outsider = await planChange(deps, identity, { kind: "bind_channel", channel: "C0PRIVATE01", project: "payments" }, { slackUserId: "U0OUTSIDE1" });
    expect(outsider.effect).toBe(member.effect);
    expect(outsider.confirmationEffect).toBeUndefined();
    expect(JSON.stringify(outsider)).not.toContain("secret-launch");
    expect(stateHash(outsider.snapshot)).toBe(stateHash(member.snapshot));
  });

  it("unbinds a bound channel, saying new messages there get no reply, and refuses an unbound one", async () => {
    const { deps, identity, db } = await harness();
    const plan = await planChange(deps, identity, { kind: "unbind_channel", channel: SLACK_CHANNEL });
    expect(plan.effect).toBe(`Unbind channel #payments-dev (${SLACK_CHANNEL}) from project payments. New messages there will get no reply; existing thread workspaces are kept.`);
    await expect(planChange(deps, identity, { kind: "unbind_channel", channel: "C0NOTBOUND1" })).rejects.toMatchObject({ code: "NOT_FOUND", message: "NOT_FOUND: channel #ledger-dev (C0NOTBOUND1) is not bound to any project; list the bindings with agentx admin slack bindings" });
    expect(db.get(`SLACK_BINDING#${SLACK_TEAM}`, `CHANNEL#${SLACK_CHANNEL}`)).toBeDefined();
    await plan.apply(identity);
    expect(db.get(`SLACK_BINDING#${SLACK_TEAM}`, `CHANNEL#${SLACK_CHANNEL}`)).toBeUndefined();
  });

  it("rechecks project administration at apply: a bind or unbind by an admin who lost it changes nothing (E6, FR-015)", async () => {
    const { deps, identity, db } = await harness();
    const bind = await planChange(deps, identity, { kind: "bind_channel", channel: "C0LEDGER01", project: "payments" });
    const unbind = await planChange(deps, identity, { kind: "unbind_channel", channel: SLACK_CHANNEL });
    db.delete(`MEMBER#${identity.ownerKey}`, "PROJECT#payments");
    await expect(bind.apply(identity)).rejects.toMatchObject({ code: expect.stringMatching(/^(FORBIDDEN|NOT_FOUND)$/) as unknown });
    await expect(unbind.apply(identity)).rejects.toMatchObject({ code: expect.stringMatching(/^(FORBIDDEN|NOT_FOUND)$/) as unknown });
    expect(db.get(`SLACK_BINDING#${SLACK_TEAM}`, "CHANNEL#C0LEDGER01")).toBeUndefined();
    expect(db.get(`SLACK_BINDING#${SLACK_TEAM}`, `CHANNEL#${SLACK_CHANNEL}`)).toMatchObject({ projectName: "payments" });
  });

  it("refuses an admin who does not administer the project (FR-015)", async () => {
    const { deps } = await harness();
    await expect(planChange(deps, { ...admin, ownerKey: "f".repeat(64) }, { kind: "unbind_channel", channel: SLACK_CHANNEL })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a channel that is neither an ID nor a channel name", async () => {
    const { deps, identity } = await harness();
    await expect(planChange(deps, identity, { kind: "unbind_channel", channel: "Not A Channel!" })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: channel must be a Slack channel ID such as C0123456789, or a public channel's name such as #payments-dev" });
  });
});

describe("a project revision (E7, E11)", () => {
  it("shows the new number, each changed field and the preflight, keeping the latest runtime binding", async () => {
    const { deps, identity } = await harness();
    const latest = { name: "payments", revision: 2, repositories: [repository], setup: [], readiness: [], orchestratorInstructions: `Delegate work. Token ${PLANTED}` };
    const plan = await planChange(deps, identity, { kind: "register_project_revision", definition: latest });
    expect(plan.effect).toContain("Register revision 2 of project payments (the latest is 1).");
    expect(plan.effect).toContain("orchestratorInstructions:");
    expect(plan.effect).toContain("[REDACTED]");
    expect(JSON.stringify(plan)).not.toContain(PLANTED);
    expect(plan.details).toMatchObject({ revision: 2, runtimeMode: "ec2-ebs" });
  });

  it("applies without contacting vendors again: the preflight ran at planning (C8)", async () => {
    const { deps, identity, db } = await harness();
    const plan = await planChange(deps, identity, { kind: "register_project_revision", definition: { name: "payments", revision: 2, repositories: [repository], setup: [], readiness: [], orchestratorInstructions: "Delegate." } });
    const result = await plan.apply(identity);
    expect(result).not.toHaveProperty("preflight");
    expect(db.get("PROJECT#payments", `REV#${"2".padStart(12, "0")}`)).toMatchObject({ entityType: "PROJECT" });
  });

  it("rechecks project administration at apply: a revision by an admin who lost it is refused and writes nothing (E6, FR-015)", async () => {
    const { deps, identity, db } = await harness();
    const plan = await planChange(deps, identity, { kind: "register_project_revision", definition: { name: "payments", revision: 2, repositories: [repository], setup: [], readiness: [], orchestratorInstructions: "Delegate." } });
    db.delete(`MEMBER#${identity.ownerKey}`, "PROJECT#payments");
    await expect(plan.apply(identity)).rejects.toMatchObject({ code: expect.stringMatching(/^(FORBIDDEN|NOT_FOUND)$/) as unknown });
    expect(db.get("PROJECT#payments", `REV#${"2".padStart(12, "0")}`)).toBeUndefined();
    expect(db.get(`MEMBER#${identity.ownerKey}`, "PROJECT#payments")).toBeUndefined();
  });

  it("redacts a planted secret in a revision's diff, and refuses a secret-looking credential input", async () => {
    const { deps, identity, db } = await harness();
    const plan = await planChange(deps, identity, { kind: "register_project_revision", definition: { name: "payments", revision: 3, repositories: [repository], setup: [], readiness: [], orchestratorInstructions: PLANTED } });
    expect(JSON.stringify([plan.effect, plan.details])).not.toContain(PLANTED);
    expect(plan.effect).toContain("[REDACTED]");
    expect(JSON.stringify(plan.details)).toContain("[REDACTED]");
    const items = db.find(() => true).length;
    await expect(planChange(deps, identity, { kind: "register_credential", ref: "linear", type: "static-secret", secretName: `agentx/connectors/${PLANTED}` })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: that input looks like a secret value; give the secret's name under agentx/connectors/, never its value" });
    expect(db.find(() => true).length).toBe(items);
    expect(JSON.stringify(db.find(() => true))).not.toContain(PLANTED);
  });

  it("applies every redactSecrets rule to a diff's values: argv flags and header tuples", async () => {
    const { deps, identity } = await harness();
    const setup = [
      { cwd: "repo/demo", executable: "npm", args: ["run", "seed", "--password", "plain-pass-123"], timeoutSeconds: 60 },
      { cwd: "repo/demo", executable: "docker", args: ["exec", "db", "mysql", "-p", "plain-mysql-456"], timeoutSeconds: 60 },
      { cwd: "repo/demo", executable: "curl", args: ["Authorization", "Bearer plain-bearer-789"], timeoutSeconds: 60 },
    ];
    const plan = await planChange(deps, identity, { kind: "register_project_revision", definition: { name: "payments", revision: 2, repositories: [repository], setup, readiness: [], orchestratorInstructions: "Delegate." } });
    expect(JSON.stringify([plan.effect, plan.confirmationEffect, plan.details])).not.toMatch(/plain-pass-123|plain-mysql-456|plain-bearer-789/);
    expect(plan.effect).toContain("setup[0].args[3]");
    expect(plan.effect).toContain("[REDACTED]");
  });

  it("refuses a first revision, an existing revision, a retired field and an invalid definition", async () => {
    const { deps, identity } = await harness();
    await expect(planChange(deps, identity, { kind: "register_project_revision", definition: { name: "ledger", revision: 1 } })).rejects.toMatchObject({ code: "NOT_FOUND", message: "NOT_FOUND: project ledger has no revision yet; register its first revision with agentx admin project register" });
    await expect(planChange(deps, identity, { kind: "register_project_revision", definition: { name: "payments", revision: 1, repositories: [repository], setup: [], readiness: [], orchestratorInstructions: "x" } })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: revision 1 is not newer than the latest, 1; use 2" });
    await expect(planChange(deps, identity, { kind: "register_project_revision", definition: { name: "payments", revision: 2, schemaVersion: 1, repositories: [repository], setup: [], readiness: [], orchestratorInstructions: "x" } })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: project definition must not contain schemaVersion; remove them and register again" });
    await expect(planChange(deps, identity, { kind: "register_project_revision", definition: { name: "payments", revision: 2 } })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringMatching(/^CONFIG_INVALID: the project definition is invalid: repositories: .+; fix it and plan again$/) as unknown });
  });
});

describe("a credential (E7, Q7)", () => {
  it("shows whether the secret reads as that type, which projects name it, and whether it replaces one", async () => {
    const { deps, identity } = await harness();
    deps.credentials = { registration: vi.fn(async () => undefined), checkSecret: vi.fn(async () => "missing" as const) };
    const plan = await planChange(deps, identity, { kind: "register_credential", ref: "linear", type: "static-secret", secretName: "agentx/connectors/linear" });
    expect(plan.effect).toBe("Register credential linear as static-secret, read from agentx/connectors/linear. That secret does not exist yet, so connectors naming linear will fail until it does. No project names linear today. It is a new registration.");
  });

  it("reads the real registry, keeps its details through redactSecrets, and applies once confirmed (C7)", async () => {
    const values: Record<string, string> = { "agentx/connectors/linear": JSON.stringify({ apiKey: "linear-key-value" }) };
    const { deps, identity, db } = await harness({ secrets: { read: async (name) => values[name] } });
    const plan = await planChange(deps, identity, { kind: "register_credential", ref: "linear", type: "static-secret", secretName: "agentx/connectors/linear" });
    expect(plan.effect).toBe("Register credential linear as static-secret, read from agentx/connectors/linear. That secret exists and reads as static-secret. No project names linear today. It is a new registration.");
    expect(redactSecrets(plan.details)).toEqual(plan.details);
    expect(JSON.stringify(plan)).not.toContain("linear-key-value");
    expect(db.get("CREDENTIALS", "REF#linear")).toBeUndefined();
    await plan.apply(identity);
    expect(db.get("CREDENTIALS", "REF#linear")).toMatchObject({ ref: "linear", type: "static-secret" });
    const replacing = await planChange(deps, identity, { kind: "register_credential", ref: "linear", type: "static-secret", secretName: "agentx/connectors/linear" });
    expect(replacing.effect).toContain("It replaces the registration from ");
    expect(stateHash(replacing.snapshot)).not.toBe(stateHash(plan.snapshot));
  });

  it("refuses a caller without the admin claim, and says when credentials are not configured before any other check", async () => {
    const { deps, identity } = await harness();
    await expect(planChange(deps, { ...identity, isAdministrator: false }, { kind: "register_credential", ref: "linear", type: "static-secret", secretName: "agentx/connectors/linear" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const bare: PlanDependencies = { ...deps };
    delete bare.credentials;
    await expect(planChange(bare, identity, { kind: "register_credential", ref: "github-app", type: "static-secret", secretName: "agentx/other/linear" })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("refuses the built-in GitHub App reference and a name outside the connector prefix (C6)", async () => {
    const { deps, identity } = await harness();
    await expect(planChange(deps, identity, { kind: "register_credential", ref: "github-app", type: "static-secret", secretName: "agentx/connectors/linear" })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: github-app is the built-in GitHub App credential and cannot be replaced; register the connector's credential under another reference" });
    await expect(planChange(deps, identity, { kind: "register_credential", ref: "linear", type: "static-secret", secretName: "agentx/other/linear" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("the credential registry's secret check (C3)", () => {
  const registry = (read: (name: string) => Promise<string | undefined>) => new CredentialRegistry({ secrets: { read }, githubApp, documentClient: {} as never, tableName: "state" });
  const registration = { ref: "linear", type: "static-secret" as const, secretName: "agentx/connectors/linear" };
  it("classifies a secret the same way registration validates it, and never returns the value", async () => {
    expect(await registry(async () => JSON.stringify({ apiKey: "value" })).checkSecret(registration)).toBe("reads");
    expect(await registry(async () => undefined).checkSecret(registration)).toBe("missing");
    expect(await registry(async () => "not json").checkSecret(registration)).toBe("wrong_type");
    expect(await registry(async () => { throw new CredentialUnavailable("denied"); }).checkSecret(registration)).toBe("unavailable");
    expect(await registry(async () => { throw Object.assign(new Error("slow"), { name: "ThrottlingException" }); }).checkSecret(registration)).toBe("unavailable");
  });
});

describe("the helpers", () => {
  it("diffs leaves by path and shows values redacted and short", () => {
    expect(fieldDiff({ a: 1, b: { c: "x" }, d: [1] }, { a: 2, b: { c: "x", e: PLANTED }, d: [] })).toEqual([
      { field: "a", from: "1", to: "2" }, { field: "b.e", to: '"[REDACTED]"' }, { field: "d[0]", from: "1" },
    ]);
  });

  it("shows a value under a credential-named key, or a credential-named pair's value, as redacted", () => {
    const before = { integrations: { connectors: [{ name: "linear" }, { name: "jira", apiKey: "plain-value-1" }] }, env: [{ name: "DB_PASSWORD", value: "plain-value-2" }] };
    const after = { integrations: { connectors: [{ name: "linear" }] }, env: [{ name: "DB_PASSWORD", value: "plain-value-3" }] };
    const changes = fieldDiff(before, after);
    expect(changes).toContainEqual({ field: "integrations.connectors[1].apiKey", from: '"[REDACTED]"' });
    expect(changes).toContainEqual({ field: "env[0].value", from: '"[REDACTED]"', to: '"[REDACTED]"' });
    expect(JSON.stringify(changes)).not.toMatch(/plain-value/);
  });

  it("knows a secret-looking value", () => {
    expect(looksLikeSecret(PLANTED)).toBe(true);
    expect(looksLikeSecret("x".repeat(40))).toBe(true);
    expect(looksLikeSecret("agentx/connectors/linear")).toBe(false);
    // Only "/" and "." separate: a base64url secret with "_" or "-" inside is caught.
    expect(looksLikeSecret(`agentx/connectors/${"Ab3_".repeat(5)}${"x-9Z".repeat(5)}`)).toBe(true);
    expect(looksLikeSecret("agentx/connectors/linear.production.api.key.for.payments")).toBe(false);
  });
});
