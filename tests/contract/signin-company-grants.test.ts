// DEC 254zzz33 (staging IAM audit, 2026-11-18): the sign-in function's company calls that its role refused. Each code path below runs over a document client that answers as DynamoDB would
// for the sign-in role of the SYNTHESIZED named control plane (tests/support/signin-role-policy.ts): every sign-in table call, each TransactWriteItems item as its own action. Each path
// passes with this change and is refused without SignInCompanyGrants (the "before" policy), so each grant is needed and covers its calls. Two companies throughout.
import { beforeAll, describe, expect, it } from "vitest";
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { companyScoped, IMPLICIT_COMPANY_ID, newCompanyInviteCode } from "@agentx/contracts";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { CompanyImportStore } from "../../packages/broker/src/developer/company-import.js";
import { companyIssuerSecretName } from "../../packages/broker/src/developer/company-issuer.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { B, person, sharedSignInWorld, X, type SharedSignInWorld } from "../support/company-shared-signin-world.js";
import { signInRolePolicy, underSignInRole, type SignInRolePolicy, type TableCall } from "../support/signin-role-policy.js";

skipLambdaBundling();

/** The named (staging) control plane, synthesized here (a deployment test may import the CDK). */
function namedControlPlane(): unknown {
  const app = buildAgentXApp({ agentxEnv: "staging" });
  const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.stackName === "agentx-staging-control-plane")!;
  return Template.fromStack(stack).toJSON();
}

let now: SignInRolePolicy;
let before: SignInRolePolicy;
beforeAll(() => {
  now = signInRolePolicy({ template: namedControlPlane() });
  const template = structuredClone(now.template);
  const ids = Object.keys(template.Resources).filter((id) => /^DeveloperSignInSignInCompanyGrants[0-9A-F]{8}$/u.test(id));
  expect(ids).toHaveLength(1);
  delete template.Resources[ids[0]!];
  before = signInRolePolicy({ template });
}, 120_000);

type Seen = Array<TableCall & { allowed: boolean }>;
/** Every sign-in table call of the world from here on is authorized as the sign-in role would be (the broker's own reads there are a subset: GetItem and the member Query). */
function enforce(w: SharedSignInWorld): Seen {
  const seen: Seen = [];
  const wrapped = underSignInRole({ send: w.db.send.bind(w.db) }, now, "signin", seen);
  (w.db as unknown as { send: unknown }).send = wrapped.send;
  return seen;
}
const shape = (call: TableCall) => `${call.action} ${call.pk.replace(/org_[0-9a-z]{20}/gu, "<org>").replace(/[a-f0-9]{64}|[0-9a-f-]{36}/gu, "<id>")}`;
const distinct = (seen: Seen) => [...new Set(seen.map(shape))].sort();

describe("the sign-in function's company grants (DEC 254zzz33)", () => {
  it("(1)(2) members, owners, pre-approvals, invite codes and self-serve create: every call allowed now; the new ones refused before", async () => {
    const w = sharedSignInWorld();
    const seen = enforce(w);
    // Self-serve create (ConditionCheck COMPANY_SELF_SERVE) and an operator's company with its first admin.
    await w.setup();
    await w.operator({ kind: "company-preapprove", companyId: X, email: "carol@example.test", role: "admin", expiresInHours: 24 });
    expect((await w.operator({ kind: "company-preapprovals-list", companyId: X })).ok).toBe(true);
    expect((await w.signIn("carol", { company: X })).refused).toBeUndefined();
    // Members list; a second owner; the first owner demoted (the last-owner check: Query MEMBERS, ConditionCheck on the witness); a revoke and a restore.
    expect((await w.operator({ kind: "company-member-list", companyId: X })).ok).toBe(true);
    expect((await w.operator({ kind: "company-member-role-set", companyId: X, personId: person("carol"), role: "owner" })).ok).toBe(true);
    expect((await w.operator({ kind: "company-member-role-set", companyId: X, personId: person("owner"), role: "admin" })).ok).toBe(true);
    expect((await w.operator({ kind: "company-member-revoke", companyId: X, personId: person("owner") })).ok).toBe(true);
    expect((await w.operator({ kind: "company-member-restore", companyId: X, personId: person("owner") })).ok).toBe(true);
    // Invite codes: create, list, revoke.
    const code = newCompanyInviteCode();
    const created = await w.operator({ kind: "company-invite-create", codeHash: code.codeHash, expiresInHours: 24 }) as { ok: boolean; codeId?: string };
    expect(created.ok).toBe(true);
    expect((await w.operator({ kind: "company-invite-list" })).ok).toBe(true);
    expect((await w.operator({ kind: "company-invite-revoke", codeId: created.codeId! })).ok).toBe(true);
    expect(seen.filter((call) => !call.allowed).map(shape)).toEqual([]);
    const needed = ["dynamodb:ConditionCheckItem COMPANY_MEMBER#<id>", "dynamodb:ConditionCheckItem COMPANY_SELF_SERVE", "dynamodb:Query COMPANY_INVITE_CODES", "dynamodb:Query ORG#<org>#MEMBERS", "dynamodb:Query ORG#<org>#PREAPPROVAL"];
    expect(distinct(seen)).toEqual(expect.arrayContaining(needed));
    // Before this change each of these was AccessDenied (the staging failures).
    for (const call of seen.filter((call) => needed.includes(shape(call)))) expect(before.allows(call), shape(call)).toBe(false);
    // Every company-scoped partition read or written is X's, B's or the built-in company's own (no other).
    expect([...new Set(seen.filter((call) => call.pk.startsWith("ORG#")).map((call) => call.pk.split("#")[1]))].filter((id) => id !== X && id !== B && id !== IMPLICIT_COMPANY_ID)).toEqual([]);
  });

  it("(5) the operator's company import undo deletes exactly the imported rows: allowed now, refused before", async () => {
    const db = new FakeDynamoDb({ seed: 5 });
    const seen: Seen = [];
    const store = new CompanyImportStore({ documentClient: underSignInRole(db, now, "signin", seen), tableName: "signin", now: () => Date.parse("2026-11-18T10:00:00.000Z") });
    const OWNER = "1".repeat(64), OTHER = "2".repeat(64);
    for (const [company, personId] of [[COMPANY_A.orgId, OWNER], [COMPANY_B.orgId, OTHER]] as const) {
      expect(await store.importCompany({ kind: "company-import", companyId: company, name: `Co ${company}`, writeCompany: true, members: [{ personId, role: "owner", joinedAt: "2026-11-01T00:00:00.000Z" }], createdBy: OWNER })).toMatchObject({ ok: true, rows: 1, company: true });
    }
    const imported = db.get(companyScoped(COMPANY_A.orgId, "COMPANY"), "META")!;
    const undone = await store.undoImport({ kind: "company-import-undo", companyId: COMPANY_A.orgId, createdBy: OWNER,
      members: [{ personId: OWNER, role: "owner", joinedAt: "2026-11-01T00:00:00.000Z", importedAt: imported.importedAt as string }],
      company: { name: imported.name as string, createdAt: imported.createdAt as string, importedAt: imported.importedAt as string } });
    expect(undone).toEqual({ ok: true, rows: 1, company: true });
    expect(seen.filter((call) => !call.allowed).map(shape)).toEqual([]);
    const deletes = seen.filter((call) => call.action === "dynamodb:DeleteItem");
    expect(distinct(deletes)).toEqual(["dynamodb:DeleteItem COMPANY_MEMBER#<id>", "dynamodb:DeleteItem ORG#<org>#COMPANY", "dynamodb:DeleteItem ORG#<org>#MEMBERS"]);
    for (const call of deletes) expect(before.allows(call), shape(call)).toBe(false);
    // B's import stands (isolation): its rows were not touched.
    expect(deletes.every((call) => !call.pk.includes(COMPANY_B.orgId) && call.pk !== `COMPANY_MEMBER#${OTHER}`)).toBe(true);
    expect(db.get(companyScoped(COMPANY_B.orgId, "COMPANY"), "META")).toBeDefined();
  });

  it("(1)(2)(4) are exactly the approved key families, and nothing wider", () => {
    for (const [action, pk, allowed] of [
      ["dynamodb:ConditionCheckItem", `COMPANY_MEMBER#${"a".repeat(64)}`, true], ["dynamodb:ConditionCheckItem", "COMPANY_SELF_SERVE", true],
      ["dynamodb:ConditionCheckItem", `DEVELOPER#${"a".repeat(64)}`, true], ["dynamodb:ConditionCheckItem", "SESSION#x", true],
      ["dynamodb:ConditionCheckItem", `ORG#${X}#COMPANY`, false], ["dynamodb:ConditionCheckItem", "COMPANY_INVITE_CODES", false],
      ["dynamodb:Query", `ORG#${X}#MEMBERS`, true], ["dynamodb:Query", `ORG#${X}#PREAPPROVAL`, true], ["dynamodb:Query", "COMPANY_INVITE_CODES", true],
      ["dynamodb:Query", `SIGNIN_LINKS#${"a".repeat(64)}`, true], ["dynamodb:Query", `ORG#${X}#COMPANY_LOG`, false], ["dynamodb:Query", "COMPANY_INVITE_LOG", false],
      ["dynamodb:Query", `DEVELOPER#${"a".repeat(64)}`, false], ["dynamodb:Query", "ORG#org_short#MEMBERS", false],
      ["dynamodb:DeleteItem", `SIGNIN_LINKS#${"a".repeat(64)}`, true], ["dynamodb:DeleteItem", `ORG#${X}#COMPANY`, true], ["dynamodb:DeleteItem", `ORG#${X}#MEMBERS`, true],
      ["dynamodb:DeleteItem", `COMPANY_MEMBER#${"a".repeat(64)}`, true],
      // The sign-in role deletes no DEVELOPER#, SESSION# or other ORG# row (an unlink keeps the linked record: sign-in-links.test.ts).
      ["dynamodb:DeleteItem", `DEVELOPER#${"a".repeat(64)}`, false], ["dynamodb:DeleteItem", "SESSION#x", false], ["dynamodb:DeleteItem", `ORG#${X}#SIGNIN_ISSUER`, false],
      ["dynamodb:DeleteItem", `ORG#${X}#PREAPPROVAL`, false], ["dynamodb:DeleteItem", "COMPANY_INVITE_CODES", false],
      ["dynamodb:Scan", `ORG#${X}#MEMBERS`, false],
      // The Null guard: no leading key, no grant (the role's unconditioned Get/Put/Update are as before).
      ["dynamodb:Query", "", false], ["dynamodb:DeleteItem", "", false], ["dynamodb:ConditionCheckItem", "", false],
    ] as const) expect(now.allows({ action, pk }), `${action} ${pk}`).toBe(allowed);
  });

  it("(3) reads a company's own OIDC client secret by the name the code builds, and no other secret family", () => {
    const secretStatements = now.statements.filter((statement) => [statement.Action].flat().includes("secretsmanager:GetSecretValue") && JSON.stringify(statement.Resource).includes("org-signin"));
    expect(secretStatements).toHaveLength(1);
    const resource = secretStatements[0]!.Resource as { "Fn::Join": [string, unknown[]] };
    const arn = resource["Fn::Join"][1].map((part) => (typeof part === "string" ? part : ({ "AWS::Partition": "aws", "AWS::Region": "us-west-2", "AWS::AccountId": "111122223333" } as Record<string, string>)[(part as { Ref: string }).Ref]!)).join(resource["Fn::Join"][0]);
    expect(arn).toBe("arn:aws:secretsmanager:us-west-2:111122223333:secret:agentx/staging/org-signin/*/oidc-??????");
    const matches = (name: string) => new RegExp(`^${arn.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`, "u").test(`arn:aws:secretsmanager:us-west-2:111122223333:secret:${name}-AbCdEf`);
    for (const company of [COMPANY_A.orgId, COMPANY_B.orgId]) expect(matches(companyIssuerSecretName("staging", company)), company).toBe(true);
    for (const name of ["agentx/staging/org-connectors/x/oidc", "agentx/other/org-signin/x/oidc", "agentx/staging/org-signin/x/oidc-extra", "agentx/staging/slack-workspaces/x"]) expect(matches(name), name).toBe(false);
    // Read-only: nothing writes or deletes the family from this role.
    expect(now.statements.filter((statement) => JSON.stringify(statement.Resource).includes("org-signin")).flatMap((statement) => [statement.Action].flat())).toEqual(["secretsmanager:GetSecretValue"]);
    // Before: no grant for the family at all.
    expect(before.statements.some((statement) => JSON.stringify(statement.Resource).includes("org-signin"))).toBe(false);
  });
});
