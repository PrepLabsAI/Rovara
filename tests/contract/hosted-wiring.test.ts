// Hosted wiring (plan v3.2 staging switch-over): the deployed builders for the step-up factors, the policy hook's key, the company reads, the audit caller word, the nightly
// company binding and the session cap. Offline: fake KMS, a recording SES and DynamoDB sender; no AWS call.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { describe, expect, it } from "vitest";
import { DEVELOPER_SESSION_SECONDS, IMPLICIT_COMPANY_ID, type AuditEvent, type AuditSink } from "@agentx/contracts";
import { extraPublicKeysFromEnvironment, PASSKEY_RP_NAME, stepUpFromEnvironment, taskPublicKeysFromEnvironment } from "../../packages/broker/src/aws/developer-identity.js";
import { auditSinkForDeployedCaller, companyReadsFromEnvironment, deployedAuditVia, hostedNightlyCompany, hostedSessionCapSeconds, policyHookInstallFromEnvironment } from "../../packages/broker/src/aws/hosted-wiring.js";
import { sesStepUpEmailSender, stepUpEmailSenderAddress, StepUpEmailNotSent } from "../../packages/broker/src/aws/step-up-email.js";
import { developerTokenVerifier } from "../../packages/broker/src/developer/verify-token.js";
import { issueAccessToken, POLICY_QUESTION_KEY_PURPOSE } from "../../packages/broker/src/developer/tokens.js";
import { fakeKms, httpEvent, identityHarness } from "../support/developer-fakes.js";

const TASK_KEY = "arn:aws:kms:us-west-2:123456789012:key/task-planted-arn";
const POLICY_KEY = "arn:aws:kms:us-west-2:123456789012:key/policy-planted-arn";
const ISSUER = "https://abc123.execute-api.us-west-2.amazonaws.com/v1/auth";
const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa";
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb";

/** One fake KMS per key id, so each key has its own public half. */
function kmsByKey() {
  const keys = new Map([[TASK_KEY, fakeKms()], [POLICY_KEY, fakeKms()]]);
  const calls: string[] = [];
  return { calls, keys, async send(command: unknown) {
    const keyId = (command as { input: { KeyId: string } }).input.KeyId;
    calls.push(keyId);
    const kms = keys.get(keyId);
    if (kms === undefined) throw new Error("unknown key");
    return kms.send(command);
  } };
}

function recordingSes(fail?: Error) {
  const sent: SendEmailCommand[] = [];
  return { sent, async send(command: unknown) { if (fail !== undefined) throw fail; sent.push(command as SendEmailCommand); return {}; } };
}

describe("hosted wiring (c): the policy hook's question key in the JWKS", () => {
  it("publishes nothing new without POLICY_HOOK_KEY_ARN: the task-only list is as before", async () => {
    for (const env of [{ TASK_TOKEN_KEY_ARN: TASK_KEY }, { TASK_TOKEN_KEY_ARN: TASK_KEY, POLICY_HOOK_KEY_ARN: "" }]) {
      const kms = kmsByKey();
      const extras = extraPublicKeysFromEnvironment(env, kms);
      expect(extras.map((extra) => extra.purpose)).toEqual(["task"]);
      const before = taskPublicKeysFromEnvironment(env, kms);
      expect(await extras[0]!.publicJwk()).toEqual(await before[0]!.publicJwk());
      expect(kms.calls.every((keyId) => keyId === TASK_KEY)).toBe(true);
    }
    expect(extraPublicKeysFromEnvironment({}, { send: () => { throw new Error("no KMS call"); } })).toEqual([]);
  });

  it("publishes developer, task and policy-question keys, each with a distinct kid, and never the key ARNs", async () => {
    const h = identityHarness();
    const kms = kmsByKey();
    h.deps.extraPublicKeys = extraPublicKeysFromEnvironment({ TASK_TOKEN_KEY_ARN: TASK_KEY, POLICY_HOOK_KEY_ARN: POLICY_KEY }, kms);
    const response = await h.http(httpEvent("GET", "/v1/auth/.well-known/jwks.json"));
    const keys = (JSON.parse(response.body) as { keys: Array<{ kid: string; rovara_purpose: string }> }).keys;
    expect(keys.map((key) => key.rovara_purpose)).toEqual(["developer", "task", POLICY_QUESTION_KEY_PURPOSE]);
    expect(new Set(keys.map((key) => key.kid)).size).toBe(3);
    expect(kms.calls).toEqual([TASK_KEY, POLICY_KEY]);
    expect(response.body).not.toContain(POLICY_KEY);
    expect(response.body).not.toContain(TASK_KEY);
    expect(h.logs).toEqual([]);
  });

  it("leaves out a policy key it cannot read, with fixed words, and sign-in stays up", async () => {
    const h = identityHarness();
    const secret = "planted-policy-key-failure";
    const kms = kmsByKey();
    h.deps.extraPublicKeys = extraPublicKeysFromEnvironment({ TASK_TOKEN_KEY_ARN: TASK_KEY, POLICY_HOOK_KEY_ARN: POLICY_KEY }, {
      send: (command: unknown) => ((command as { input: { KeyId: string } }).input.KeyId === POLICY_KEY ? Promise.reject(new Error(secret)) : kms.send(command)),
    });
    const response = await h.http(httpEvent("GET", "/v1/auth/.well-known/jwks.json"));
    expect(response.statusCode).toBe(200);
    expect((JSON.parse(response.body) as { keys: Array<{ rovara_purpose: string }> }).keys.map((key) => key.rovara_purpose)).toEqual(["developer", "task"]);
    expect(h.logs).toEqual([{ event: "developer.jwks_policy_key_failed" }]);
    expect(JSON.stringify([response, h.logs])).not.toContain(secret);
  });

  it("a developer token signed with the policy key is refused by the developer verifier", async () => {
    const kms = kmsByKey();
    const [, policy] = extraPublicKeysFromEnvironment({ TASK_TOKEN_KEY_ARN: TASK_KEY, POLICY_HOOK_KEY_ARN: POLICY_KEY }, kms);
    const install = policyHookInstallFromEnvironment({ DEVELOPER_TOKEN_ISSUER: ISSUER, POLICY_HOOK_KEY_ARN: POLICY_KEY }, kms)!;
    const now = Date.UTC(2026, 10, 15, 12);
    const { token } = await issueAccessToken(install.signer, { issuer: ISSUER, subject: "dev-1", amr: "slack", env: "staging", sessionId: "s-1", now });
    const jwk = { ...await policy!.publicJwk(), rovara_purpose: POLICY_QUESTION_KEY_PURPOSE };
    const verify = developerTokenVerifier({ issuer: ISSUER, keys: async () => [jwk], now: () => now });
    await expect(verify(`Bearer ${token}`)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("builds the policy hook's asker only with both the issuer and the key", () => {
    const kms = kmsByKey();
    expect(policyHookInstallFromEnvironment({}, kms)).toBeUndefined();
    expect(policyHookInstallFromEnvironment({ DEVELOPER_TOKEN_ISSUER: ISSUER }, kms)).toBeUndefined();
    expect(policyHookInstallFromEnvironment({ POLICY_HOOK_KEY_ARN: POLICY_KEY }, kms)).toBeUndefined();
    expect(policyHookInstallFromEnvironment({ DEVELOPER_TOKEN_ISSUER: ISSUER, POLICY_HOOK_KEY_ARN: POLICY_KEY }, kms)?.issuer).toBe(ISSUER);
    expect(kms.calls).toEqual([]);
  });
});

describe("hosted wiring (a) and (b): the step-up factors", () => {
  const noSes = () => { throw new Error("SES is not built without a sender"); };

  it("turns nothing on without the settings (a step-up stays refused, as before)", () => {
    const logs: unknown[] = [];
    expect(stepUpFromEnvironment({}, ISSUER, noSes, (entry) => logs.push(entry))).toBeUndefined();
    expect(stepUpFromEnvironment({ STEP_UP_EMAIL_FROM: "", DEVELOPER_PASSKEYS: "disabled" }, ISSUER, noSes, (entry) => logs.push(entry))).toBeUndefined();
    expect(logs).toEqual([]);
  });

  it("passkeys use the API's own host as the relying-party id", () => {
    expect(stepUpFromEnvironment({ DEVELOPER_PASSKEYS: "enabled" }, ISSUER, noSes, () => undefined)).toEqual({ passkeys: { rpId: "abc123.execute-api.us-west-2.amazonaws.com", rpName: PASSKEY_RP_NAME } });
  });

  it("an unusable sender builds no email factor and logs fixed words, never the value", () => {
    for (const bad of ["Codes <codes@example.com>", "codes@", "two@@example.com", "a b@example.com", "codes@example", "x".repeat(250) + "@example.com"]) {
      const logs: unknown[] = [];
      expect(stepUpFromEnvironment({ STEP_UP_EMAIL_FROM: bad }, ISSUER, noSes, (entry) => logs.push(entry)), bad).toBeUndefined();
      expect(logs).toEqual([{ event: "signin.step_up_email_not_configured", detail: "STEP_UP_EMAIL_FROM is not one plain address" }]);
      expect(stepUpEmailSenderAddress(bad)).toBeUndefined();
    }
  });

  it("sends the code through SES from the configured identity only, and the message is in no error", async () => {
    const ses = recordingSes();
    const stepUp = stepUpFromEnvironment({ STEP_UP_EMAIL_FROM: "codes@example.com", DEVELOPER_PASSKEYS: "enabled" }, ISSUER, () => ses, () => undefined)!;
    expect(stepUp.passkeys?.rpId).toBe("abc123.execute-api.us-west-2.amazonaws.com");
    await stepUp.email!.send({ to: "maya@example.com", subject: "Your code", text: "123456" });
    expect(ses.sent.map((command) => command.input)).toEqual([{
      FromEmailAddress: "codes@example.com",
      Destination: { ToAddresses: ["maya@example.com"] },
      Content: { Simple: { Subject: { Data: "Your code", Charset: "UTF-8" }, Body: { Text: { Data: "123456", Charset: "UTF-8" } } } },
    }]);
    const failing = sesStepUpEmailSender({ ses: recordingSes(new Error("MessageRejected: maya@example.com 654321")), from: "codes@example.com" });
    const error = await failing.send({ to: "maya@example.com", subject: "s", text: "654321" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StepUpEmailNotSent);
    expect(JSON.stringify([String(error), (error as Error).message, (error as Error).stack])).not.toMatch(/654321|maya@example\.com/u);
    expect(() => sesStepUpEmailSender({ ses: recordingSes(), from: "not an address" })).toThrow();
  });
});

describe("hosted wiring (d): company reads and the audit caller word", () => {
  function senders() {
    const dynamo: unknown[] = [];
    const document: unknown[] = [];
    let membership: unknown;
    return {
      dynamo: { send: async (command: unknown) => { dynamo.push(command); return { Items: [] }; } },
      documentClient: { send: async (command: unknown) => { document.push(command); return { Item: membership }; } },
      calls: { dynamo, document },
      setMembership(value: unknown) { membership = value; },
    };
  }
  const env = { COMPANY_READS: "enabled", STATE_TABLE_NAME: "agentx-staging-state", DEVELOPER_SIGNIN_TABLE_NAME: "agentx-staging-signin", AWS_REGION: "us-west-2" };

  it("is off unless turned on with both tables named, and builds no client call", () => {
    const s = senders();
    expect(companyReadsFromEnvironment({}, s)).toBeUndefined();
    expect(companyReadsFromEnvironment({ ...env, COMPANY_READS: "on" }, s)).toBeUndefined();
    expect(companyReadsFromEnvironment({ ...env, STATE_TABLE_NAME: "" }, s)).toBeUndefined();
    expect(companyReadsFromEnvironment({ ...env, DEVELOPER_SIGNIN_TABLE_NAME: undefined }, s)).toBeUndefined();
    expect(companyReadsFromEnvironment(env, s)).toBeDefined();
    expect(s.calls).toEqual({ dynamo: [], document: [] });
  });

  it("resolves the company from the person's membership in the sign-in table, never another source", async () => {
    const s = senders();
    const reads = companyReadsFromEnvironment(env, s)!;
    s.setMembership({ entityType: "COMPANY_MEMBERSHIP", personId: "dev-1", companyId: ORG_A, role: "admin", joinedAt: "2026-11-15T00:00:00.000Z" });
    expect(await reads.companyOf!("dev-1")).toBe(ORG_A);
    const get = s.calls.document[0] as GetCommand;
    expect(get).toBeInstanceOf(GetCommand);
    expect(get.input).toEqual({ TableName: "agentx-staging-signin", Key: { pk: "COMPANY_MEMBER#dev-1", sk: "COMPANY" }, ConsistentRead: true });
    s.setMembership({ entityType: "COMPANY_MEMBERSHIP", personId: "dev-2", companyId: ORG_A, role: "admin", joinedAt: "2026-11-15T00:00:00.000Z" });
    expect(await reads.companyOf!("dev-1")).toBeUndefined();
    s.setMembership(undefined);
    expect(await reads.companyOf!("dev-1")).toBeUndefined();
  });

  it("hands on the live role from the same membership row, read now; a revoked or another person's row is none (audit gap 4)", async () => {
    const s = senders();
    const reads = companyReadsFromEnvironment(env, s)!;
    s.setMembership({ entityType: "COMPANY_MEMBERSHIP", personId: "dev-1", companyId: ORG_A, role: "owner", joinedAt: "2026-11-15T00:00:00.000Z" });
    expect(await reads.membershipOf!("dev-1")).toEqual({ companyId: ORG_A, role: "owner" });
    expect((s.calls.document.at(-1) as GetCommand).input).toEqual({ TableName: "agentx-staging-signin", Key: { pk: "COMPANY_MEMBER#dev-1", sk: "COMPANY" }, ConsistentRead: true });
    s.setMembership({ entityType: "COMPANY_MEMBERSHIP", personId: "dev-1", companyId: ORG_A, role: "admin", joinedAt: "2026-11-15T00:00:00.000Z", revokedAt: "2026-11-16T00:00:00.000Z" });
    expect(await reads.membershipOf!("dev-1")).toBeUndefined();
    s.setMembership({ entityType: "COMPANY_MEMBERSHIP", personId: "dev-2", companyId: ORG_A, role: "owner", joinedAt: "2026-11-15T00:00:00.000Z" });
    expect(await reads.membershipOf!("dev-1")).toBeUndefined();
  });

  it("hands on only a query over the State table", async () => {
    const s = senders();
    const reads = companyReadsFromEnvironment(env, s)!;
    expect(Object.keys(reads.store)).toEqual(["query"]);
    await reads.store.query({ pk: `${ORG_A}#AUDIT`, limit: 5 }).catch(() => undefined);
    expect(s.calls.dynamo.length).toBeGreaterThan(0);
    expect(JSON.stringify(s.calls.dynamo)).toContain("agentx-staging-state");
    expect(JSON.stringify(s.calls.dynamo)).not.toContain("signin");
  });

  it("names the caller each engine audit event came through", async () => {
    expect(deployedAuditVia({})).toBe("cli");
    expect(deployedAuditVia({ client: "web-app" })).toBe("client:web-app");
    expect(deployedAuditVia({ client: "Web App" })).toBe("client");
    expect(deployedAuditVia({ client: "x".repeat(80) })).toBe("client");
    const seen: AuditEvent[] = [];
    const sink: AuditSink = { stage: (event) => { seen.push(event); return []; }, record: async (event) => { seen.push(event); } };
    const event = { action: "task.start", actor: { type: "person", developerId: "dev-1" }, details: { via: "spoofed" } } as unknown as AuditEvent;
    await auditSinkForDeployedCaller(sink, { client: "web-app" }).record(event);
    auditSinkForDeployedCaller(sink, {}).stage(event);
    expect(seen.map((entry) => entry.details?.via)).toEqual(["client:web-app", "cli"]);
  });
});

describe("hosted wiring (e) and (f): the nightly company binding and the session cap", () => {
  it("binds T8's nightly check to the consumer's own company and requires it", async () => {
    const records: Record<string, Record<string, unknown> | undefined> = { own: { companyId: ORG_A }, other: { companyId: ORG_B }, legacy: {}, broken: { companyId: "nope" } };
    const binding = hostedNightlyCompany(ORG_A, async (project) => records[project]);
    expect(binding.projectCompanyRequired).toBe(true);
    expect(await binding.projectCompany("own")).toBe(ORG_A);
    for (const project of ["other", "legacy", "broken", "missing"]) expect(await binding.projectCompany(project), project).toBeUndefined();
    // A record with no company belongs to the implicit company only.
    expect(await hostedNightlyCompany(IMPLICIT_COMPANY_ID, async (project) => records[project]).projectCompany("legacy")).toBe(IMPLICIT_COMPANY_ID);
    for (const bad of ["", "org_short", "ORG_AAAAAAAAAAAAAAAAAAAA", undefined as never]) expect(() => hostedNightlyCompany(bad, async () => undefined), String(bad)).toThrow();
  });

  it("caps a token made on the deployed API at a developer session's length", () => {
    expect(hostedSessionCapSeconds()).toBe(DEVELOPER_SESSION_SECONDS);
    expect(Number.isSafeInteger(hostedSessionCapSeconds()) && hostedSessionCapSeconds() > 0).toBe(true);
  });
});
