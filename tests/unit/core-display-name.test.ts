// The deployed core identity names a person from their sign-in record through the one display helper (DEC 254p (a), #846's follow-up): a GitHub person's name is clean text, anyone else's is as stored.
import { describe, expect, it } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { OrgId } from "@agentx/contracts";
import { hostedDisplayNameOf } from "../../packages/broker/src/aws/core-engine-root.js";
import { createHostedIdentity } from "../../packages/broker/src/core-host/hosted-modules.js";

const TABLE = "signin-table";
const ORG = "org_staging0000000000001" as OrgId;
const PERSON = "a".repeat(64);

function clientWith(record: Record<string, unknown> | undefined) {
  const reads: string[] = [];
  return {
    reads,
    client: {
      async send(command: unknown) {
        if (!(command instanceof GetCommand)) throw new Error("only reads");
        const input = command.input as unknown as { Key: { pk: string; sk: string } };
        reads.push(`${input.Key.pk}|${input.Key.sk}`);
        return { Item: record === undefined ? undefined : { pk: input.Key.pk, sk: input.Key.sk, ...record } };
      },
    },
  };
}
const nameOf = async (record: Record<string, unknown> | undefined, table: string | undefined = TABLE, person = PERSON) => hostedDisplayNameOf(clientWith(record).client, table)(person);
const noTable = async () => hostedDisplayNameOf(clientWith(github("Dana")).client, undefined)(PERSON);
const github = (displayName: unknown, subject = "12345") => ({ provider: "github", issuer: "https://github.com", subject, displayName });

describe("the deployed identity's display name", () => {
  it("cleans a GitHub person's name: markup and email-shaped parts do not come out", async () => {
    const dirty = await nameOf(github("**Dana** <img src=x onerror=alert(1)> [click](http://evil.example) dana@example.com"));
    expect(dirty).toBeDefined();
    expect(dirty).not.toMatch(/[<>[\]*&`]/u);
    expect(dirty).not.toContain("@");
    expect(dirty).toContain("Dana");
  });

  it("leaves an ordinary GitHub name unchanged", async () => {
    expect(await nameOf(github("Dana Whitfield"))).toBe("Dana Whitfield");
    expect(await nameOf(github("dana-w"))).toBe("dana-w");
  });

  it("cuts a very long GitHub name to 80 code points and falls back to a plain label when nothing usable is left", async () => {
    expect([...(await nameOf(github("x".repeat(5_000))) ?? "")].length).toBeLessThanOrEqual(80);
    expect(await nameOf(github("<>"))).toBe("GitHub user 12345");
  });

  it("returns every other person's name exactly as stored", async () => {
    expect(await nameOf({ provider: "slack", subject: "U1", displayName: "**Dana** <b>W</b>" })).toBe("**Dana** <b>W</b>");
    expect(await nameOf({ provider: "oidc", subject: "s", displayName: "Dana [x] <y>" })).toBe("Dana [x] <y>");
  });

  it("knows nobody who is revoked, unknown, without a name, or asked about in a malformed way, and reads nothing for the last", async () => {
    expect(await nameOf({ ...github("Dana"), revoked: true })).toBeUndefined();
    expect(await nameOf(undefined)).toBeUndefined();
    expect(await nameOf({ provider: "github", subject: "1" })).toBeUndefined();
    expect(await nameOf(github("Dana"), "")).toBeUndefined();
    expect(await noTable()).toBeUndefined();
    const spy = clientWith(github("Dana"));
    const read = hostedDisplayNameOf(spy.client, TABLE);
    for (const bad of ["", "a#b", "a b"]) expect(await read(bad)).toBeUndefined();
    expect(spy.reads).toEqual([]);
    expect(await read(PERSON)).toBe("Dana");
    expect(spy.reads).toEqual([`DEVELOPER#${PERSON}|META`]);
  });

  it("is what the principal of a member carries", async () => {
    const identity = createHostedIdentity({
      membershipOf: async () => ({ companyId: ORG, role: "member" }),
      displayNameOf: hostedDisplayNameOf(clientWith(github("**Dana**<script>")).client, TABLE),
    });
    const principal = await identity.getPrincipal(ORG, PERSON);
    expect(principal?.displayName).toBeDefined();
    expect(principal?.displayName).not.toMatch(/[<>*]/u);
  });
});
