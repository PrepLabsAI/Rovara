// tests/contract/admin-change-plans.test.ts
// Spec 025 E6, E7, E11, E12: a plan says exactly what will happen, against current state, and
// changes nothing; its hash moves when the state it covers moves.
import { describe, expect, it, vi } from "vitest";
import { CredentialUnavailable } from "@agentx/gateway";
import { redactSecrets, type ChannelInfoRequest, type ChannelMembersRequest } from "@agentx/contracts";
import { fieldDiff, looksLikeSecret, planChange, stateHash, type PlanDependencies } from "../../packages/broker/src/aws/admin-change-plans.js";
import { CredentialRegistry } from "../../packages/broker/src/aws/credentials.js";
import { createAdminReadBroker } from "../support/admin-read-broker.js";
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

  it("D045 bind/unbind exposes six unknown categories before confirm", async () => {
    const { deps, identity, db } = await harness();
    const input = { kind: "bind_channel" as const, channel: "C0LEDGER01", project: "payments" };
    const unbound = await planChange(deps, identity, input);
    expect(unbound.effect).toContain("It is bound to nothing today.");
    expect(unbound.effect).toContain("New threads in #ledger-dev will use payments revision 1.");
    expect(unbound.details).toEqual({ channelId: input.channel, project: "payments", currentProject: null, revision: 1 });
    expect(unbound.snapshot).toEqual({ binding: null, latestRevision: 1 });
    const previous = { projectName: "ledger", updatedAt: "2026-11-20T12:00:00.000Z" };
    const membership = db.find((item) => item.entityType === "MEMBERSHIP" && item.role === "administrator")[0]!;
    db.set({ ...membership, sk: "PROJECT#ledger", projectName: "ledger" });
    db.set({ pk: `SLACK_BINDING#${SLACK_TEAM}`, sk: "CHANNEL#C0LEDGER01", ...previous });
    const replacing = await planChange(deps, identity, input);
    expect(replacing.effect).toContain("It is bound to ledger today; its existing threads keep their workspaces.");
    expect(replacing.details).toEqual({ channelId: input.channel, project: "payments", currentProject: "ledger", revision: 1 });
    expect(replacing.snapshot).toEqual({ binding: previous, latestRevision: 1 });
    expect(stateHash(replacing.snapshot)).not.toBe(stateHash(unbound.snapshot));
    const revision = db.find((item) => item.pk === "PROJECT#payments" && String(item.sk).startsWith("REV#"))[0]!;
    db.set({ ...revision, sk: "REV#000000000002", definition: { ...revision.definition as object, revision: 2 } });
    const latest = await planChange(deps, identity, input);
    expect(latest.effect).toContain("payments revision 2.");
    expect(latest.snapshot).toEqual({ binding: previous, latestRevision: 2 });
    expect(stateHash(latest.snapshot)).not.toBe(stateHash(replacing.snapshot));
    const unbind = await planChange(deps, identity, { kind: "unbind_channel", channel: input.channel });
    expect(unbind.details).toEqual({ channelId: input.channel, project: "ledger" });
    expect(unbind.snapshot).toEqual({ binding: previous });
    expect(unbind.effect).toContain("Unbind channel #ledger-dev (C0LEDGER01) from project ledger.");
    expect(unbind.effect).toContain("New messages there will get no reply; existing thread workspaces are kept.");
    for (const plan of [unbound, replacing, latest, unbind]) {
      for (const category of ["Projects", "Running work", "Queued work", "Schedules", "People", "Channels"]) {
        expect(plan.effect).toContain(`${category}: unknown (freshness unknown).`);
      }
      expect(plan.effect).toContain("Dependency counts are not available from this plan.");
      expect(plan.effect).toContain("Keep the current binding");
      expect(plan.effect).toContain("Test the replacement first; this plan does not test replacement routing.");
    }
    expect(unbind.effect).toContain("Retained workspaces do not establish ongoing task permission.");
    db.set({ pk: `SLACK_BINDING#${SLACK_TEAM}`, sk: "CHANNEL#C0LEDGER01", projectName: "payments", updatedAt: previous.updatedAt });
    await expect(planChange(deps, identity, input)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(planChange(deps, identity, { kind: "unbind_channel", channel: "C0UNBOUND01" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("D045 private member vs outsider projection", async () => {
    const { deps, identity } = await harness();
    const input = { kind: "bind_channel" as const, channel: "C0PRIVATE01", project: "payments" };
    const member = await planChange(deps, identity, input, { slackUserId: MEMBER_ADMIN });
    const outsider = await planChange(deps, identity, input, { slackUserId: "U0OUTSIDER" });
    expect(member.confirmationEffect).toContain("#secret-launch");
    expect(member.effect).not.toContain("secret-launch");
    expect(JSON.stringify([member.details, member.snapshot, outsider])).not.toContain("secret-launch");
    expect(stateHash(member.snapshot)).toBe(stateHash(outsider.snapshot));
    for (const effect of [member.effect, member.confirmationEffect!, outsider.effect]) {
      expect(effect).toContain("Channels: unknown (freshness unknown).");
      expect(effect).toContain("Keep the current binding until you have checked the replacement channel and its audience.");
    }
  });

  it("D045 preview never binds or unbinds", async () => {
    const { deps, identity, db } = await harness();
    const bind = vi.spyOn(deps.handlers, "bindChannel");
    const unbind = vi.spyOn(deps.handlers, "unbindChannel");
    const plannedBind = await planChange(deps, identity, { kind: "bind_channel", channel: "C0LEDGER01", project: "payments" });
    const plannedUnbind = await planChange(deps, identity, { kind: "unbind_channel", channel: SLACK_CHANNEL });
    expect(bind).not.toHaveBeenCalled();
    expect(unbind).not.toHaveBeenCalled();
    await plannedBind.apply(identity);
    expect(bind).toHaveBeenCalledExactlyOnceWith(identity, SLACK_TEAM, "C0LEDGER01", "payments");
    expect(db.get(`SLACK_BINDING#${SLACK_TEAM}`, "CHANNEL#C0LEDGER01")).toMatchObject({ projectName: "payments" });
    await plannedUnbind.apply(identity);
    expect(unbind).toHaveBeenCalledExactlyOnceWith(identity, SLACK_TEAM, SLACK_CHANNEL);
    expect(db.get(`SLACK_BINDING#${SLACK_TEAM}`, `CHANNEL#${SLACK_CHANNEL}`)).toBeUndefined();
  });

  it("names a private channel by ID only, and refuses a private channel's name", async () => {
    const { deps, identity } = await harness({ channelByName: async () => ({ ok: true }) });
    const plan = await planChange(deps, identity, { kind: "bind_channel", channel: "C0PRIVATE01", project: "payments" });
    expect(plan.effect).toContain("Bind channel C0PRIVATE01 (a private channel) to project payments.");
    expect(JSON.stringify(plan)).not.toContain("secret-launch");
    await expect(planChange(deps, identity, { kind: "bind_channel", channel: "#secret-launch", project: "payments" })).rejects.toMatchObject({ code: "NOT_FOUND", message: "NOT_FOUND: no public channel with that name in this Slack workspace; give a private channel by its ID" });
  });

  it("refuses a channel that is neither an ID nor a channel name", async () => {
    const { deps, identity } = await harness();
    await expect(planChange(deps, identity, { kind: "unbind_channel", channel: "Not A Channel!" })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: channel must be a Slack channel ID such as C0123456789, or a public channel's name such as #payments-dev" });
  });
});

describe("a project revision (E7, E11)", () => {

  it("refuses a first revision, an existing revision, a retired field and an invalid definition", async () => {
    const { deps, identity } = await harness();
    await expect(planChange(deps, identity, { kind: "register_project_revision", definition: { name: "ledger", revision: 1 } })).rejects.toMatchObject({ code: "NOT_FOUND", message: "NOT_FOUND: project ledger has no revision yet; register its first revision with agentx admin project register" });
    await expect(planChange(deps, identity, { kind: "register_project_revision", definition: { name: "payments", revision: 1, repositories: [repository], setup: [], readiness: [], orchestratorInstructions: "x" } })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: revision 1 is not newer than the latest, 1; use 2" });
    await expect(planChange(deps, identity, { kind: "register_project_revision", definition: { name: "payments", revision: 2, schemaVersion: 1, repositories: [repository], setup: [], readiness: [], orchestratorInstructions: "x" } })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: project definition must not contain schemaVersion; remove them and register again" });
    await expect(planChange(deps, identity, { kind: "register_project_revision", definition: { name: "payments", revision: 2 } })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringMatching(/^CONFIG_INVALID: the project definition is invalid: repositories: .+; fix it and plan again$/) as unknown });
  });
});

describe("a credential (E7, Q7)", () => {

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

  it("knows a secret-looking value", () => {
    expect(looksLikeSecret(PLANTED)).toBe(true);
    expect(looksLikeSecret("x".repeat(40))).toBe(true);
    expect(looksLikeSecret("agentx/connectors/linear")).toBe(false);
    // Only "/" and "." separate: a base64url secret with "_" or "-" inside is caught.
    expect(looksLikeSecret(`agentx/connectors/${"Ab3_".repeat(5)}${"x-9Z".repeat(5)}`)).toBe(true);
    expect(looksLikeSecret("agentx/connectors/linear.production.api.key.for.payments")).toBe(false);
  });
});
