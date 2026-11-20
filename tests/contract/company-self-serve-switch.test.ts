// DEC 254zg (a): self-serve company create is a stack switch of its own (CompanySelfServe, COMPANY_SELF_SERVE), served only with company sign-in on as well. The stored
// self-serve setting (absent = open) can close it further but never open it while the switch is off, so company sign-in can be on with self-serve closed (close self-serve first).
import { afterEach, describe, expect, it, vi } from "vitest";
import { newCompanyInviteCode } from "@agentx/contracts";
import { CompanyInviteStore } from "../../packages/broker/src/developer/company-invites.js";
import { CompanySignInStore } from "../../packages/broker/src/developer/company-membership.js";
import { companySelfServeFromEnvironment } from "../../packages/broker/src/aws/developer-identity.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import type * as DynamoModule from "@aws-sdk/lib-dynamodb";

const wiring = vi.hoisted<{ db: unknown }>(() => ({ db: undefined }));
vi.mock("@aws-sdk/lib-dynamodb", async (original) => ({ ...await original<typeof DynamoModule>(), DynamoDBDocumentClient: { from: () => wiring.db } }));
afterEach(() => vi.unstubAllEnvs());

const PERSON = "1".repeat(64);
const at = Date.parse("2026-11-17T00:00:00Z");

describe("companySelfServeFromEnvironment", () => {
  it.each([
    [{}, false], [{ COMPANY_SIGNIN: "enabled" }, false], [{ COMPANY_SELF_SERVE: "enabled" }, false],
    [{ COMPANY_SIGNIN: "enabled", COMPANY_SELF_SERVE: "disabled" }, false], [{ COMPANY_SIGNIN: "disabled", COMPANY_SELF_SERVE: "enabled" }, false],
    [{ COMPANY_SIGNIN: "enabled", COMPANY_SELF_SERVE: "Enabled" }, false], [{ COMPANY_SIGNIN: "enabled", COMPANY_SELF_SERVE: "true" }, false],
    [{ COMPANY_SIGNIN: "enabled", COMPANY_SELF_SERVE: "enabled" }, true],
  ])("%j -> %s (both switches, exactly enabled)", (env, open) => {
    expect(companySelfServeFromEnvironment(env)).toBe(open);
  });
});

describe("CompanyInviteStore with the stack switch", () => {
  const world = (selfServeAllowed: boolean) => {
    const db = new FakeDynamoDb();
    const company = new CompanySignInStore({ documentClient: db, tableName: "signin", now: () => at });
    return { db, invites: new CompanyInviteStore({ documentClient: db, tableName: "signin", now: () => at, company, selfServeAllowed, newCompanyId: () => "org_" + "b".repeat(20) }) };
  };

  it.each([["absent", undefined], ["stored open", true]])("off: refuses every create with the uniform answer, the stored setting %s", async (_label, open) => {
    const { db, invites } = world(false);
    if (open !== undefined) await invites.setSelfServe(open);
    const code = newCompanyInviteCode();
    await invites.create(code.codeHash, 24);
    expect(await invites.selfServeOpen()).toBe(false);
    expect(await invites.selfCreate({ personId: PERSON, name: "Acme", codeHash: code.codeHash })).toEqual({ ok: false, error: "refused" });
    expect(db.find((row) => row.entityType === "COMPANY")).toEqual([]);
    expect(db.find((row) => row.entityType === "COMPANY_INVITE_CODE")).toEqual([expect.objectContaining({ status: "live" })]);
  });

  it("on: the stored setting still decides (absent open, closed refused)", async () => {
    const { invites } = world(true);
    expect(await invites.selfServeOpen()).toBe(true);
    await invites.setSelfServe(false);
    expect(await invites.selfServeOpen()).toBe(false);
    await invites.setSelfServe(true);
    const code = newCompanyInviteCode();
    await invites.create(code.codeHash, 24);
    expect(await invites.selfCreate({ personId: PERSON, name: "Acme", codeHash: code.codeHash })).toMatchObject({ ok: true });
  });
});

describe("the sign-in Lambda's wiring", () => {
  it.each([
    [undefined, false], ["disabled", false], ["enabled", true],
  ])("COMPANY_SIGNIN=enabled, COMPANY_SELF_SERVE=%s: self-create served = %s", async (flag, served) => {
    vi.resetModules(); wiring.db = new FakeDynamoDb();
    for (const [key, value] of Object.entries({ AGENTX_ENV: "test", AWS_REGION: "us-east-1", DEVELOPER_TOKEN_ISSUER: "https://signin.example.test/v1/auth", DEVELOPER_SIGNIN_TABLE_NAME: "signin", STATE_TABLE_NAME: "state", DEVELOPER_TOKEN_KEY_ARN: "test-key", SLACK_SECRET_ARN: "test-slack", TASK_TOKEN_KEY_ARN: "", DEVELOPER_OIDC_ISSUER: "", COMPANY_SIGNIN: "enabled" })) vi.stubEnv(key, value);
    vi.stubEnv("COMPANY_SELF_SERVE", flag);
    const { handler } = await import("../../packages/broker/src/aws/developer-identity.js");
    const code = newCompanyInviteCode();
    expect(await handler({ kind: "company-invite-create", codeHash: code.codeHash, expiresInHours: 24 } as never)).toMatchObject({ ok: true });
    const answer = await handler({ kind: "company-self-create", personId: PERSON, name: "Acme", codeHash: code.codeHash } as never);
    expect(answer).toMatchObject(served ? { ok: true } : { ok: false, error: "refused" });
  });
});
