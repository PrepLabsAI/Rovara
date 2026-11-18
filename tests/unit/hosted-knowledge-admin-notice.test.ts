// Lead 4 L4-MCPA: the admin notice for an unusual amount of team knowledge read goes to the company's owners AND admins on a hosted install (the people port's company-wide `eligibleIds`), never only its
// owners, never a project's maintainers who are not company admins, and never another company's people. Delivery asks the same function, so a person removed since the notice was queued is not told.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { companyScoped, type OrgId } from "@agentx/contracts";
import { ADMIN_NOTICE_PEOPLE_MAX, adminNoticeIdsOf, createBrokerCoreRoot, membershipWithRoleFromDynamo } from "../../packages/broker/src/aws/core-engine-root.js";
import { createHostedLessonsPeople } from "../../packages/broker/src/aws/hosted-lessons-people.js";
import { createHostedIdentity, HOSTED_IDENTITY_PROVIDER } from "../../packages/broker/src/core-host/hosted-modules.js";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import type { HostedApprovers } from "../../packages/broker/src/lessons/hosted-people.js";
import { coreAdapter } from "../../packages/broker/src/core-host/registry.js";
import { createFakeWorld, FAKE_COMPANY } from "../support/core-host-fakes.js";

// Substitute only the deployment adapters; the root, registry, runtime and knowledge API are real.
const adapters = vi.hoisted(() => ({ modules: [] as unknown[] }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", () => ({ codeAdapterModules: () => adapters.modules }));
vi.mock("../../packages/broker/src/core-host/hosted-modules.js", async (original) => ({ ...await original<object>(), hostedSecurityModules: () => [] }));

const A = FAKE_COMPANY as OrgId;
const B = "org_corehost00000000000b" as OrgId;
const secret = Buffer.alloc(32, 7);
const id = (n: number): string => n.toString(16).padStart(64, "0");
const [OWNER_A, ADMIN_A, MAINTAINER_A, MEMBER_A, OWNER_B, ADMIN_B] = [id(1), id(2), id(3), id(4), id(5), id(6)];
const idOf = (personId: string): string => developerIdOf({ provider: HOSTED_IDENTITY_PROVIDER, personId });

describe("adminNoticeIdsOf: who the notice is queued for", () => {
  const identity = { getPrincipal: async (_company: string, personId: string) => ({ provider: HOSTED_IDENTITY_PROVIDER, personId }) };
  const group = (over: Partial<HostedApprovers>): HostedApprovers => ({ complete: true, membershipVersion: 1, ownerIds: [], eligibleIds: [], lastEligibleLossAtMs: null, ...over });

  it("names the owners and the non-owner admins (the company-wide eligible list), not just the owners", async () => {
    const asked: Array<string | undefined> = [];
    const people = { approvers: async (_company: OrgId, project: string | undefined) => { asked.push(project); return group({ ownerIds: ["owner"], eligibleIds: ["admin", "owner"] }); } };
    expect(await adminNoticeIdsOf(people, identity, A)).toEqual([idOf("admin"), idOf("owner")]);
    // The question is company-wide: no project, so a project's maintainers are never in it.
    expect(asked).toEqual([undefined]);
  });

  it("an owner-only list would miss the admin: the owner list is not what is read", async () => {
    const people = { approvers: async () => group({ ownerIds: ["owner"], eligibleIds: ["owner", "admin"] }) };
    expect(await adminNoticeIdsOf(people, identity, A)).toContain(idOf("admin"));
  });

  it("tells nobody when the list is not complete, when the port throws, or when the identity no longer names a person", async () => {
    expect(await adminNoticeIdsOf({ approvers: async () => group({ complete: false, eligibleIds: ["admin"] }) }, identity, A)).toEqual([]);
    await expect(adminNoticeIdsOf({ approvers: async () => { throw new Error("down"); } }, identity, A)).rejects.toThrow("down");
    const gone = { getPrincipal: async (_company: string, personId: string) => (personId === "gone" ? undefined : { provider: HOSTED_IDENTITY_PROVIDER, personId }) };
    expect(await adminNoticeIdsOf({ approvers: async () => group({ eligibleIds: ["gone", "admin"] }) }, gone, A)).toEqual([idOf("admin")]);
  });

  it("names at most the cap (a long list is cut, never read whole)", async () => {
    const many = Array.from({ length: ADMIN_NOTICE_PEOPLE_MAX + 5 }, (_, i) => `p${String(i)}`);
    expect(await adminNoticeIdsOf({ approvers: async () => group({ eligibleIds: many }) }, identity, A)).toHaveLength(ADMIN_NOTICE_PEOPLE_MAX);
  });
});

async function setup() {
  const world = createFakeWorld();
  const rows = new Map<string, Record<string, unknown>>();
  const member = (personId: string, companyId: OrgId, role: string) => {
    rows.set(`signin|COMPANY_MEMBER#${personId}|COMPANY`, { pk: `COMPANY_MEMBER#${personId}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId, companyId, role, joinedAt: "2026-10-01T00:00:00.000Z" });
    rows.set(`signin|${companyScoped(companyId, "MEMBERS")}|MEMBER#${personId}`, { pk: companyScoped(companyId, "MEMBERS"), sk: `MEMBER#${personId}`, entityType: "COMPANY_MEMBER_VIEW", personId, companyId, role, joinedAt: "2026-10-01T00:00:00.000Z" });
  };
  member(OWNER_A, A, "owner"); member(ADMIN_A, A, "admin"); member(MAINTAINER_A, A, "member"); member(MEMBER_A, A, "member");
  member(OWNER_B, B, "owner"); member(ADMIN_B, B, "admin");
  // A project maintainer who is not a company admin, and an ordinary developer on the same project.
  rows.set(`state|MEMBER#${MAINTAINER_A}|PROJECT#payments`, { pk: `MEMBER#${MAINTAINER_A}`, sk: "PROJECT#payments", projectName: "payments", role: "administrator" });
  rows.set(`state|MEMBER#${MEMBER_A}|PROJECT#payments`, { pk: `MEMBER#${MEMBER_A}`, sk: "PROJECT#payments", projectName: "payments", role: "developer" });
  const client = { async send(command: unknown) {
    if (command instanceof GetCommand) {
      const { TableName, Key } = command.input as { TableName: string; Key: { pk: string; sk: string } };
      if (TableName === "signin" || TableName === "state") return { Item: rows.get(`${TableName}|${Key.pk}|${Key.sk}`) };
      return { Item: await world.store.get(Key) };
    }
    if (command instanceof QueryCommand) {
      const input = command.input as { ExpressionAttributeValues: Record<string, string> };
      const pk = input.ExpressionAttributeValues[":pk"]!;
      const items = [...rows.entries()].filter(([k]) => k.startsWith(`signin|${pk}|`)).map(([, row]) => row);
      return { Items: items, ScannedCount: items.length };
    }
    throw new Error("unexpected write");
  } };
  // The deployed identity names a person from their live membership row, like the broker's own (a removed person is nobody).
  const identity = createHostedIdentity({
    membershipOf: membershipWithRoleFromDynamo(client, "signin"),
    displayNameOf: async (personId) => `Name ${personId.slice(-2)}`,
  });
  adapters.modules = world.modules.map((module) => (module.point === "identity" ? coreAdapter({ point: "identity", name: "deployed", owner: "fake", create: () => identity }) : module));
  const root = createBrokerCoreRoot({
    env: { ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: "all", ROVARA_CORE_LESSONS: "on" },
    documentClient: client, stateTableName: "state", signInTableName: "signin", callbackSigningKey: secret.toString(), repositoryGrantKey: secret,
    codeModules: () => ({}) as never, repositoryCredential: async () => { throw new Error("unused"); }, origin: () => "https://api.example", log: () => undefined,
    now: () => new Date(world.clock.now), ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
    services: () => Object.fromEntries(["merge-tracking", "session-sweep", "notify-deliver", "admission-hold-sweep"].map((name) => [name, { pass: async () => ({}) }])),
    lessonsPeople: createHostedLessonsPeople({ documentClient: client, stateTableName: "state", signInTableName: "signin", now: () => world.clock.now }),
  });
  return { root, rows };
}

describe("the delivery re-check on a hosted install (the real people port over the install's own records)", () => {
  it("an owner and a non-owner admin are told; a plain member, a developer and a project maintainer who is not a company admin are not", async () => {
    const { root } = await setup();
    const told = async (personId: string) => await root.adminNotice!(A, idOf(personId));
    expect(await told(OWNER_A)).toBe(true);
    expect(await told(ADMIN_A)).toBe(true);
    expect(await told(MAINTAINER_A)).toBe(false);
    expect(await told(MEMBER_A)).toBe(false);
    expect(await told("f".repeat(64))).toBe(false);
  });

  it("a removed admin, or one demoted to member, is not told at delivery (read live, on the very next call)", async () => {
    const { root, rows } = await setup();
    expect(await root.adminNotice!(A, idOf(ADMIN_A))).toBe(true);
    const row = rows.get(`signin|COMPANY_MEMBER#${ADMIN_A}|COMPANY`)!;
    rows.set(`signin|COMPANY_MEMBER#${ADMIN_A}|COMPANY`, { ...row, revokedAt: "2026-11-17T00:00:00.000Z" });
    rows.delete(`signin|${companyScoped(A, "MEMBERS")}|MEMBER#${ADMIN_A}`);
    expect(await root.adminNotice!(A, idOf(ADMIN_A))).toBe(false);
    // The owner is still told.
    expect(await root.adminNotice!(A, idOf(OWNER_A))).toBe(true);
    // A demotion is the same: the live role says member.
    rows.set(`signin|COMPANY_MEMBER#${OWNER_A}|COMPANY`, { ...rows.get(`signin|COMPANY_MEMBER#${OWNER_A}|COMPANY`)!, role: "member" });
    rows.set(`signin|${companyScoped(A, "MEMBERS")}|MEMBER#${OWNER_A}`, { ...rows.get(`signin|${companyScoped(A, "MEMBERS")}|MEMBER#${OWNER_A}`)!, role: "member" });
    expect(await root.adminNotice!(A, idOf(OWNER_A))).toBe(false);
  });

  it("two companies: a company's notice is told only to its own owners and admins, never to the other company's", async () => {
    const { root } = await setup();
    expect(await root.adminNotice!(B, idOf(ADMIN_B))).toBe(true);
    expect(await root.adminNotice!(B, idOf(OWNER_B))).toBe(true);
    expect(await root.adminNotice!(A, idOf(ADMIN_B))).toBe(false);
    expect(await root.adminNotice!(A, idOf(OWNER_B))).toBe(false);
    expect(await root.adminNotice!(B, idOf(ADMIN_A))).toBe(false);
    expect(await root.adminNotice!(B, idOf(OWNER_A))).toBe(false);
    expect(await root.adminNotice!(B, idOf(MAINTAINER_A))).toBe(false);
  });
});

describe("the broker hands the notice delivery the same re-check", () => {
  const source = readFileSync(new URL("../../packages/broker/src/aws/broker.ts", import.meta.url), "utf8");
  const call = source.slice(source.indexOf("const coreRoot = createBrokerCoreRoot({"));
  const body = call.slice(0, call.indexOf("builtCoreRoot = coreRoot;"));
  const rootSource = readFileSync(new URL("../../packages/broker/src/aws/core-engine-root.ts", import.meta.url), "utf8");

  it("passes the core root's adminNotice into the hosted job services' notification, next to the people port's other wiring", () => {
    expect(body).toMatch(/createHostedBrokerCoreServices\(\{[^\n]*\n[^\n]*\n\s*notification: \{ \.\.\.\(wiring\.notification \?\? \{\}\)[^\n]*adminNotice: async \(orgId, developerId\) => \(await builtCoreRoot\?\.adminNotice\?\.\(orgId, developerId\)\) === true/u);
  });

  it("queues and delivers through one function: the knowledge API's adminsOf and the delivery check are the same list, asked company-wide", () => {
    expect(rootSource).toMatch(/const adminsOf = async \(companyId: OrgId\): Promise<string\[\]> => await adminNoticeIdsOf\(lessonsPeople\(companyId\)/u);
    expect(rootSource).toMatch(/adminNotice = async \(orgId, developerId\) => \(await adminsOf\(orgId\)\)\.includes\(developerId\);/u);
    expect(rootSource).toMatch(/^\s+adminsOf,$/mu);
    expect(rootSource).toMatch(/people\.approvers\(companyId, undefined\)/u);
    expect(rootSource).toMatch(/listed\.eligibleIds\.slice\(0, ADMIN_NOTICE_PEOPLE_MAX\)/u);
  });
});
