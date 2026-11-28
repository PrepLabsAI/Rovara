// #1614: self-serve company create has no stack switch any more. The stored self-serve setting (absent = open) decides, always behind an operator's invite code, so an operator
// closes it with `company-self-serve-set` and every create is the uniform refusal.
import { afterEach, describe, expect, it, vi } from "vitest";
import { newCompanyInviteCode } from "@agentx/contracts";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import type * as DynamoModule from "@aws-sdk/lib-dynamodb";

const wiring = vi.hoisted<{ db: unknown }>(() => ({ db: undefined }));
vi.mock("@aws-sdk/lib-dynamodb", async (original) => ({ ...await original<typeof DynamoModule>(), DynamoDBDocumentClient: { from: () => wiring.db } }));
afterEach(() => vi.unstubAllEnvs());

const PERSON = "1".repeat(64);

describe("the sign-in Lambda's self-serve create", () => {
  it.each([[undefined, true], [true, true], [false, false]])("stored setting open=%s: self-create served = %s", async (open, served) => {
    vi.resetModules(); wiring.db = new FakeDynamoDb();
    for (const [key, value] of Object.entries({ AGENTX_ENV: "test", AWS_REGION: "us-east-1", DEVELOPER_TOKEN_ISSUER: "https://signin.example.test/v1/auth", DEVELOPER_SIGNIN_TABLE_NAME: "signin", STATE_TABLE_NAME: "state", DEVELOPER_TOKEN_KEY_ARN: "test-key", SLACK_SECRET_ARN: "test-slack", TASK_TOKEN_KEY_ARN: "", DEVELOPER_OIDC_ISSUER: "" })) vi.stubEnv(key, value);
    const { handler } = await import("../../packages/broker/src/aws/developer-identity.js");
    if (open !== undefined) expect(await handler({ kind: "company-self-serve-set", open } as never)).toMatchObject({ ok: true });
    const code = newCompanyInviteCode();
    expect(await handler({ kind: "company-invite-create", codeHash: code.codeHash, expiresInHours: 24 } as never)).toMatchObject({ ok: true });
    const answer = await handler({ kind: "company-self-create", personId: PERSON, name: "Acme", codeHash: code.codeHash } as never);
    expect(answer).toMatchObject(served ? { ok: true } : { ok: false, error: "refused" });
  });
});
