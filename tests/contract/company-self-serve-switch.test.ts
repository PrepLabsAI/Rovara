// DEC 254zg (a): self-serve company create is a stack switch of its own (CompanySelfServe, COMPANY_SELF_SERVE), served only with company sign-in on as well. The stored
// self-serve setting (absent = open) can close it further but never open it while the switch is off, so company sign-in can be on with self-serve closed (close self-serve first).
import { afterEach, describe, expect, it, vi } from "vitest";
import { newCompanyInviteCode } from "@agentx/contracts";
import { companySelfServeFromEnvironment } from "../../packages/broker/src/aws/developer-identity.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import type * as DynamoModule from "@aws-sdk/lib-dynamodb";

const wiring = vi.hoisted<{ db: unknown }>(() => ({ db: undefined }));
vi.mock("@aws-sdk/lib-dynamodb", async (original) => ({ ...await original<typeof DynamoModule>(), DynamoDBDocumentClient: { from: () => wiring.db } }));
afterEach(() => vi.unstubAllEnvs());

const PERSON = "1".repeat(64);

describe("companySelfServeFromEnvironment", () => {
  it.each([
    [{}, false],
  ])("%j -> %s (both switches, exactly enabled)", (env, open) => {
    expect(companySelfServeFromEnvironment(env)).toBe(open);
  });
});

describe("the sign-in Lambda's wiring", () => {
  it.each([
    [undefined, false], ["enabled", true],
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
