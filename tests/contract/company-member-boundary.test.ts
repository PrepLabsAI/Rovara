import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { MEMBER_FORWARDER, memberBoundary, scanMemberBoundary } from "../support/company-member-boundary.js";

const helper = { path: MEMBER_FORWARDER, text: readFileSync(MEMBER_FORWARDER, "utf8") };
const source = (text: string, path = "packages/broker/src/second-forwarder.ts") => ({ path, text });
const refusal = /^Company member boundary unclassifiable\.$/;

it("only the member helper constructs member payloads and derives company/actor from live membership", () => {
  const boundary = scanMemberBoundary(process.cwd());
  // Exact file/kind/role multiset: no directory exemption or whole-file fingerprints.
  expect(boundary.roles).toMatchInlineSnapshot(`
    [
      "packages/broker/src/aws/company-member-forwarding.ts | company-member-list | action",
      "packages/broker/src/aws/company-member-forwarding.ts | company-member-list | comparison",
      "packages/broker/src/aws/company-member-forwarding.ts | company-member-list | comparison",
      "packages/broker/src/aws/company-member-forwarding.ts | company-member-list | comparison",
      "packages/broker/src/aws/company-member-forwarding.ts | company-member-list | schema",
      "packages/broker/src/aws/company-member-forwarding.ts | company-member-revoke | action",
      "packages/broker/src/aws/company-member-forwarding.ts | company-member-revoke | schema",
      "packages/broker/src/aws/company-member-forwarding.ts | company-member-role-set | action",
      "packages/broker/src/aws/company-member-forwarding.ts | company-member-role-set | schema",
      "packages/broker/src/developer/company-membership.ts | company-member-revoke | audit",
      "packages/broker/src/developer/company-membership.ts | company-member-role-set | audit",
      "packages/broker/src/developer/company-operator.ts | company-member-list | case",
      "packages/broker/src/developer/company-operator.ts | company-member-list | schema",
      "packages/broker/src/developer/company-operator.ts | company-member-revoke | case",
      "packages/broker/src/developer/company-operator.ts | company-member-revoke | comparison",
      "packages/broker/src/developer/company-operator.ts | company-member-revoke | schema",
      "packages/broker/src/developer/company-operator.ts | company-member-role-set | case",
      "packages/broker/src/developer/company-operator.ts | company-member-role-set | schema",
    ]
  `);
  // Reviewed live-read -> validated member -> forwarded company/actor authority facts.
  expect(boundary.helper).toMatchInlineSnapshot(`
    [
      " | ImportDeclaration: import { GetCommand } from "@aws-sdk/lib-dynamodb";",
      " | ImportDeclaration: import { z } from "zod";",
      " | ImportDeclaration: import { membershipKey } from "./company-check.js";",
      " | ImportDeclaration: import { CompanyMember, MemberListInput, MemberPersonId, MemberReply, memberCursorPerson, type CompanyMemberReply } from "../developer/company-member-contract.js";",
      " | VariableDeclaration: Request = z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("company-member-revoke"), companyId: OrgIdSchema, personId: MemberPersonId }).strict(),
        z.object({ kind: z.literal("company-member-role-set"), companyId: OrgIdSchema, personId: MemberPersonId, role: OrgRoleSchema }).strict(),
        MemberListInput.extend({ kind: z.literal("company-member-list") }).strict(),
    ])",
      " | VariableDeclaration: Caller = z.object({ developerId: MemberPersonId, sessionId: z.string().min(1).max(256), amr: z.enum(["oidc", "slack"]), name: z.string(), slackUserId: z.string().optional(), email: z.string().optional(), clientId: z.string().optional() }).strict()",
      "function:companyMembersThroughLambda(deps) | Parameter: deps: {
        documentClient: {
            send(command: unknown): Promise<unknown>;
        };
        tableName: string;
        invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>;
    }",
      "function:companyMembersThroughLambda(deps) > function:anonymous(caller,request) | VariableDeclaration: input = Request.safeParse(request)",
      "function:companyMembersThroughLambda(deps) > function:anonymous(caller,request) > if:!input.success:condition | PrefixUnaryExpression: !input.success",
      "function:companyMembersThroughLambda(deps) > function:anonymous(caller,request) | VariableDeclaration: authenticated = Caller.safeParse(caller)",
      "function:companyMembersThroughLambda(deps) > function:anonymous(caller,request) > if:!authenticated.success:condition | PrefixUnaryExpression: !authenticated.success",
      "function:companyMembersThroughLambda(deps) > function:anonymous(caller,request) | VariableDeclaration: member: z.infer<typeof CompanyMember>",
      "function:companyMembersThroughLambda(deps) > function:anonymous(caller,request) > try:body;catch:catch {
        return { ok: false, error: "not_found" };
    };finally:none | VariableDeclaration: response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: membershipKey(authenticated.data.developerId), ConsistentRead: true })) as {
        Item?: unknown;
    }",
      "function:companyMembersThroughLambda(deps) > function:anonymous(caller,request) > try:body;catch:catch {
        return { ok: false, error: "not_found" };
    };finally:none > if:Buffer.byteLength(JSON.stringify(response)) > 409600:condition | BinaryExpression: Buffer.byteLength(JSON.stringify(response)) > 409600",
      "function:companyMembersThroughLambda(deps) > function:anonymous(caller,request) > try:body;catch:catch {
        return { ok: false, error: "not_found" };
    };finally:none | ExpressionStatement: member = CompanyMember.parse(response.Item);",
      "function:companyMembersThroughLambda(deps) > function:anonymous(caller,request) > try:body;catch:catch {
        return { ok: false, error: "not_found" };
    };finally:none > if:member.personId !== authenticated.data.developerId || member.companyId !== input.data.companyId || member.revokedAt !== undefined || (member.role !== "admin" && member.role !== "owner"):condition | BinaryExpression: member.personId !== authenticated.data.developerId || member.companyId !== input.data.companyId || member.revokedAt !== undefined || (member.role !== "admin" && member.role !== "owner")",
      "function:companyMembersThroughLambda(deps) > function:anonymous(caller,request) > try:body;catch:catch {
        return { ok: false, error: "unavailable" };
    };finally:none | VariableDeclaration: forwarded = { ...input.data, companyId: member.companyId,
        ...(input.data.kind === "company-member-list" ? {} : { createdBy: member.personId }),
    }",
      "function:companyMembersThroughLambda(deps) > function:anonymous(caller,request) > try:body;catch:catch {
        return { ok: false, error: "unavailable" };
    };finally:none > if:input.data.kind === "company-member-list" && input.data.cursor !== undefined:condition | BinaryExpression: input.data.kind === "company-member-list" && input.data.cursor !== undefined",
      "function:companyMembersThroughLambda(deps) > function:anonymous(caller,request) > try:body;catch:catch {
        return { ok: false, error: "unavailable" };
    };finally:none > if:input.data.kind === "company-member-list" && input.data.cursor !== undefined:then | ExpressionStatement: memberCursorPerson(member.companyId, input.data.cursor);",
      "function:companyMembersThroughLambda(deps) > function:anonymous(caller,request) > try:body;catch:catch {
        return { ok: false, error: "unavailable" };
    };finally:none | VariableDeclaration: answer = await deps.invoke(Buffer.from(JSON.stringify(forwarded)))",
      "function:companyMembersThroughLambda(deps) > function:anonymous(caller,request) > try:body;catch:catch {
        return { ok: false, error: "unavailable" };
    };finally:none | VariableDeclaration: parsed = MemberReply.safeParse(JSON.parse(Buffer.from(answer.Payload).toString("utf8")))",
      "function:companyMembersThroughLambda(deps) > function:anonymous(caller,request) > try:body;catch:catch {
        return { ok: false, error: "unavailable" };
    };finally:none > if:reply.ok:then > if:input.data.kind === "company-member-list":condition | BinaryExpression: input.data.kind === "company-member-list"",
      "function:companyMembersThroughLambda(deps) > function:anonymous(caller,request) > try:body;catch:catch {
        return { ok: false, error: "unavailable" };
    };finally:none > if:reply.ok:then > if:input.data.kind === "company-member-list":then > if:!("members" in reply) || reply.members.length > (input.data.limit ?? 100) || reply.members.some((row) => row.companyId !== member.companyId):condition | BinaryExpression: !("members" in reply) || reply.members.length > (input.data.limit ?? 100) || reply.members.some((row) => row.companyId !== member.companyId)",
      "function:companyMembersThroughLambda(deps) > function:anonymous(caller,request) > try:body;catch:catch {
        return { ok: false, error: "unavailable" };
    };finally:none > if:reply.ok:then > if:input.data.kind === "company-member-list":then > if:!("members" in reply) || reply.members.length > (input.data.limit ?? 100) || reply.members.some((row) => row.companyId !== member.companyId):condition > function:anonymous(row) | BinaryExpression: row.companyId !== member.companyId",
      "function:companyMembersThroughLambda(deps) > function:anonymous(caller,request) > try:body;catch:catch {
        return { ok: false, error: "unavailable" };
    };finally:none > if:reply.ok:then > if:input.data.kind === "company-member-list":then > if:reply.cursor !== undefined:then | ExpressionStatement: memberCursorPerson(member.companyId, reply.cursor);",
      "function:companyMemberActionsThroughLambda(deps) | Parameter: deps: Parameters<typeof companyMembersThroughLambda>[0]",
      "function:companyMemberActionsThroughLambda(deps) | VariableDeclaration: forward = companyMembersThroughLambda(deps)",
      "function:companyMemberActionsThroughLambda(deps) > function:anonymous(schema,kind) | Parameter: schema: z.ZodObject",
      "function:companyMemberActionsThroughLambda(deps) > function:anonymous(schema,kind) | Parameter: kind: z.infer<typeof Request>["kind"]",
      "function:companyMemberActionsThroughLambda(deps) | ReturnStatement: return {
        revoke: action(Request.options[0].omit({ kind: true }), "company-member-revoke"),
        setRole: action(Request.options[1].omit({ kind: true }), "company-member-role-set"),
        list: action(Request.options[2].omit({ kind: true }), "company-member-list"),
    };",
    ]
  `);
});

it.each([
  'const payload = { kind: "company-member-revoke" };',
  'const alias = "company-member-role-set"; const payload = { kind: alias };',
  'const field = "kind"; const payload = { [field]: "company-member-list" };',
  'const payload = {}; payload["kind"] = "company-member-list";',
  'const payload = { kind: "company-member-" + "revoke" };',
  'const payload = { kind: `company-member-${"role-set"}` };',
  'const payload = { kind: `company-${"member"}-${"list"}` };',
  'const payload = { kind: "comp" + "any-mem" + "ber-list" };',
  'const kind = ["company", "member", "list"].join("-");',
  'const pieces = ["company", "member", "list"]; const payload = { kind: pieces.join("-") };',
  'const payload = { kind: ["company", "member", "list"].map(transform).join("-") };',
  'const a = "company-"; const b = "member-list"; const payload = { kind: a + b };',
  'function f() { const a = "company-"; const b = "member-list"; return { kind: a + b }; } function g() { const a = "x"; const b = "y"; return a + b; }',
  'const a = "company"; const b = "member"; const payload = { kind: `${a}-${b}-list` };',
  'const prefix = "company-member-"; const payload = { kind: prefix + external };',
  'const payload = { kind: `company-member-${external}` };',
  'const payload = { kind: "company-member-restore".replace("restore", operation) };',
  'const payload = { kind: ["company", "member", external].join("-") };',
  'import { MEMBER_REVOKE as alias } from "./developer/company-member-contract.js"; const payload = { kind: alias };',
  'import * as memberKinds from "./developer/company-member-contract.js"; const payload = { kind: memberKinds.REVOKE };',
  'export { MEMBER_LIST as other } from "./developer/company-member-contract.js";',
])("refuses member construction/building blocks in any second module: %s", (text) => {
  for (const path of ["packages/broker/src/second-forwarder.ts", "packages/broker/src/developer/company-membership.ts", "packages/broker/src/developer/company-operator.ts", "packages/broker/src/developer/company-member-contract.ts"]) {
    expect(() => memberBoundary([source(text, path)])).toThrow(refusal);
  }
});

it.each([
  'const field = externalName; const payload = { [field]: externalValue };',
  'const payload = { kind: externalValue };',
  'const payload = {}; payload[externalName] = externalValue;',
  'export function unrelated() { return { kind: "activity", extra: 1 }; }',
  '// company-member-list\nconst payload = { kind: externalValue };',
])("does not pin files with no member-kind building block: %s", (text) => {
  expect(memberBoundary([source(text)])).toEqual(memberBoundary([source("")]));
});

it.each([
  ["companyId: member.companyId", "companyId: input.data.companyId"],
  ["createdBy: member.personId", "createdBy: authenticated.data.developerId"],
  ["companyId: member.companyId", "companyId: caller.companyId"],
  ["createdBy: member.personId", "createdBy: request.actorId"],
  ["member = CompanyMember.parse(response.Item)", "member = CompanyMember.parse(request)"],
  ["ConsistentRead: true", "ConsistentRead: false"],
  ["Key: membershipKey(authenticated.data.developerId)", "Key: membershipKey(request.actorId)"],
  ["const forwarded =", "member.companyId = request.companyId; const forwarded ="],
  ["const forwarded =", "const alias = member; alias.personId = caller.actorId; const forwarded ="],
  ["const answer =", "forwarded.companyId = request.companyId; const answer ="],
  ["companyId: member.companyId,", "companyId: member.companyId, ...request,"],
  ["JSON.stringify(forwarded)", "JSON.stringify(request)"],
])("rejects alternate authority provenance %s -> %s", (before, after) => {
  expect(helper.text).toContain(before);
  const control = memberBoundary([helper]);
  expect(memberBoundary([{ ...helper, text: helper.text.replace(before, after) }])).not.toEqual(control);
});

it("ignores helper comments and unrelated declarations", () => {
  expect(memberBoundary([{ ...helper, text: `${helper.text.replace("input.data.kind", "input./* internal comment */data.kind")}\n// unrelated comment\nexport const unrelated = 42;` }])).toEqual(memberBoundary([helper]));
});

it("refuses malformed input and total file/byte/node/site limits without source echo", () => {
  expect(() => memberBoundary([source('const payload = { kind: ; // private-canary')])).toThrow(refusal);
  for (const caps of [{ files: 0 }, { bytes: 1 }, { nodes: 1 }]) {
    expect(() => memberBoundary([source('const payload = { kind: externalValue };')], caps)).toThrow(refusal);
  }
});

it("handles large unrelated input under the existing timeout", () => {
  const text = Array.from({ length: 10_000 }, (_, i) => `const payload${i} = { kind: external${i} };`).join("\n");
  expect(memberBoundary([source(text)])).toEqual(memberBoundary([source("")]));
});

it("shares file, byte, site and elapsed budgets across the entire scan", () => {
  const schema = 'const request = z.object({ kind: z.literal("company-member-list") });';
  const schemas = [source(schema, "packages/broker/src/developer/company-operator.ts"), source(schema, "packages/broker/src/developer/company-member-contract.ts")];
  expect(memberBoundary(schemas).roles).toHaveLength(2);
  expect(() => memberBoundary(schemas, { sites: 1 })).toThrow(refusal);
  const harmless = source('const payload = { kind: externalValue };');
  const two = [harmless, { ...harmless, path: "packages/broker/src/another.ts" }];
  expect(() => memberBoundary(two, { files: 1 })).toThrow(refusal);
  expect(() => memberBoundary(two, { bytes: Buffer.byteLength(harmless.text) })).toThrow(refusal);
  expect(() => memberBoundary(two, { milliseconds: 0 })).toThrow(refusal);
  expect(() => scanMemberBoundary(process.cwd(), { entries: 0 })).toThrow(refusal);
  expect(() => scanMemberBoundary(process.cwd(), { files: 0 })).toThrow(refusal);
  expect(() => scanMemberBoundary(process.cwd(), { bytes: 0 })).toThrow(refusal);
  expect(() => scanMemberBoundary(process.cwd(), { milliseconds: 0 })).toThrow(refusal);
  for (const milliseconds of [NaN, Infinity, -1, 1.5]) expect(() => memberBoundary([], { milliseconds })).toThrow(refusal);
});

it("accepts the exact total file/byte budget and unrelated non-member strings", () => {
  const text = 'const a = `activity-${id}`; const b = "company-member-" + "restore";';
  const inputs = Array.from({ length: 4_000 }, (_, i) => source(text, `packages/broker/src/activity-${i}.ts`));
  expect(memberBoundary(inputs, { files: 4_000, bytes: 4_000 * Buffer.byteLength(text) })).toEqual(memberBoundary([]));
});

it("permits ordinary contract schemas but refuses importing kind constants, including aliases", () => {
  expect(memberBoundary([source('import { MemberListInput as schema } from "./developer/company-member-contract.js";')])).toEqual(memberBoundary([]));
  for (const text of [
    'import { MEMBER_LIST } from "./developer/company-member-contract.js";',
    'const kinds = require("./developer/company-member-contract.js");',
    'const kinds = import("./developer/company-member-contract.js");',
    'const kinds = ["company-member-list"];',
    'const kinds = ["company-member-"];',
  ]) expect(() => memberBoundary([source(text)])).toThrow(refusal);
});
