import { expect, it } from "vitest";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { COMPANY_SIGN_IN_METHODS, createCompanySignInAuditWriter } from "../../packages/broker/src/developer/company-signin-audit.js";

it("writes one allowlisted company-audit row and no sign-in credential material", async () => {
  let written: Record<string, unknown> | undefined;
  const writer = createCompanySignInAuditWriter({
    tableName: "state",
    now: () => Date.parse("2026-11-19T18:00:00.000Z"),
    documentClient: { async send(command: unknown) {
      expect(command).toBeInstanceOf(PutCommand);
      written = (command as PutCommand).input.Item as Record<string, unknown>;
      return {};
    } },
  });
  await writer({ companyId: "org_aaaaaaaaaaaaaaaaaaaa", developerId: "a".repeat(64), method: "web", outcome: "succeeded", token: "credential-canary" } as never);
  expect(written).toMatchObject({
    pk: "ORG#org_aaaaaaaaaaaaaaaaaaaa#AUDIT", entityType: "AUDIT", companyId: "org_aaaaaaaaaaaaaaaaaaaa",
    actor: { type: "person", id: "a".repeat(64) }, action: "signin.succeeded",
    details: { method: "web" }, at: "2026-11-19T18:00:00.000Z",
  });
  const serialized = JSON.stringify(written);
  expect(serialized).not.toContain("credential-canary");
  for (const field of ["token", "code", "cookie", "secret", "email", "ip", "authorization"]) expect(serialized.toLowerCase()).not.toContain(`"${field}"`);
});

it("writes only a fixed cause for a failed sign-in", async () => {
  let written: Record<string, unknown> | undefined;
  const writer = createCompanySignInAuditWriter({ tableName: "state", now: () => 0, documentClient: { async send(command: unknown) {
    written = (command as PutCommand).input.Item as Record<string, unknown>; return {};
  } } });
  await writer({ companyId: "org_aaaaaaaaaaaaaaaaaaaa", developerId: "a".repeat(64), method: "invite", outcome: "refused", cause: "not_invited" });
  expect(written).toMatchObject({ action: "signin.refused", details: { method: "invite", cause: "not_invited" } });
});

it("writes success and failure rows for every supported sign-in method", async () => {
  const written: Array<Record<string, unknown>> = [];
  const writer = createCompanySignInAuditWriter({ tableName: "state", now: () => 0, documentClient: { async send(command: unknown) {
    written.push((command as PutCommand).input.Item as Record<string, unknown>); return {};
  } } });
  for (const method of COMPANY_SIGN_IN_METHODS) {
    await writer({ companyId: "org_aaaaaaaaaaaaaaaaaaaa", developerId: "a".repeat(64), method, outcome: "succeeded" });
    await writer({ companyId: "org_aaaaaaaaaaaaaaaaaaaa", developerId: "a".repeat(64), method, outcome: "refused", cause: "sign_in_failed" });
  }
  expect(written).toHaveLength(COMPANY_SIGN_IN_METHODS.length * 2);
  for (const method of COMPANY_SIGN_IN_METHODS) {
    expect(written.filter((row) => (row.details as { method: string }).method === method).map((row) => row.action)).toEqual(["signin.succeeded", "signin.refused"]);
  }
  const text = JSON.stringify(written).toLowerCase();
  for (const marker of ["token", "code", "cookie", "secret", "email", "ip", "authorization"]) expect(text).not.toContain(`"${marker}"`);
});
