// Lead 4 L4-LPPL: the hosted people port is what the broker hands the core root, and with it the company's lessons are built (and only where the lessons switch covers the company).
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { companyScoped, type OrgId } from "@agentx/contracts";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { createHostedLessonsPeople } from "../../packages/broker/src/aws/hosted-lessons-people.js";
import { createFakeWorld, FAKE_COMPANY } from "../support/core-host-fakes.js";

// Substitute only the deployment adapters; the root, registry, runtime and lessons API are real.
const adapters = vi.hoisted(() => ({ modules: [] as unknown[] }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", () => ({ codeAdapterModules: () => adapters.modules }));
vi.mock("../../packages/broker/src/core-host/hosted-modules.js", async (original) => ({ ...await original<object>(), hostedSecurityModules: () => [] }));

const A = FAKE_COMPANY as OrgId;
const B = "org_corehost00000000000b" as OrgId;
const secret = Buffer.alloc(32, 7);
const id = (n: number): string => n.toString(16).padStart(64, "0");
const [MEMBER_A, OUTSIDER_A, MEMBER_B] = [id(1), id(2), id(3)];

async function setup(options: { lessons?: string; withPeople?: boolean; signIn?: string | undefined } = {}) {
  const world = createFakeWorld();
  adapters.modules = world.modules;
  const rows = new Map<string, Record<string, unknown>>();
  const member = (personId: string, companyId: OrgId, role: string) => {
    rows.set(`signin|COMPANY_MEMBER#${personId}|COMPANY`, { pk: `COMPANY_MEMBER#${personId}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId, companyId, role, joinedAt: "2026-10-01T00:00:00.000Z" });
    rows.set(`signin|${companyScoped(companyId, "MEMBERS")}|MEMBER#${personId}`, { pk: companyScoped(companyId, "MEMBERS"), sk: `MEMBER#${personId}`, entityType: "COMPANY_MEMBER_VIEW", personId, companyId, role, joinedAt: "2026-10-01T00:00:00.000Z" });
  };
  member(MEMBER_A, A, "member"); member(OUTSIDER_A, A, "member"); member(MEMBER_B, B, "member");
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
  const signInTableName = "signIn" in options ? options.signIn : "signin";
  const root = createBrokerCoreRoot({
    env: { ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: "all", ...(options.lessons === undefined ? {} : { ROVARA_CORE_LESSONS: options.lessons }) },
    documentClient: client, stateTableName: "state", signInTableName, callbackSigningKey: secret.toString(), repositoryGrantKey: secret,
    codeModules: () => ({}) as never, repositoryCredential: async () => { throw new Error("unused"); }, origin: () => "https://api.example", log: () => undefined,
    now: () => new Date(world.clock.now), ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
    services: () => Object.fromEntries(["merge-tracking", "session-sweep", "notify-deliver", "admission-hold-sweep"].map((name) => [name, { pass: async () => ({}) }])),
    ...(options.withPeople === false ? {} : { lessonsPeople: createHostedLessonsPeople({ documentClient: client, stateTableName: "state", signInTableName, now: () => world.clock.now }) }),
  });
  return { root, rows };
}

const ask = (root: Awaited<ReturnType<typeof setup>>["root"], personId: string) =>
  root.lessons!.answer({ method: "GET", path: "/v1/dev/projects/payments/lessons", query: new URLSearchParams() }, { personId });

describe("the core root with the hosted people port", () => {
  it("builds the company's lessons when the switch is on: the lessons API answers (a missing project is a plain not-found, not 'switched off')", async () => {
    const { root } = await setup({ lessons: "on" });
    expect(root.lessons).toBeDefined();
    await root.app.runtimeFor(A);
    await expect(ask(root, MEMBER_A)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("answers from live membership: a person of another company, or none, never reads this company's lessons", async () => {
    const { root, rows } = await setup({ lessons: "on" });
    await root.app.runtimeFor(A);
    await expect(ask(root, id(99))).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    rows.delete(`signin|COMPANY_MEMBER#${MEMBER_A}|COMPANY`);
    await expect(ask(root, MEMBER_A)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("does not build lessons while the lessons switch is off, with the port given", async () => {
    for (const lessons of [undefined, "off", "", "typo"]) {
      const { root } = await setup({ ...(lessons === undefined ? {} : { lessons }) });
      expect(root.lessons).toBeUndefined();
    }
  });

  it("is not built without the people (reported, as before) and not on an install with no sign-in table", async () => {
    const { root } = await setup({ lessons: "on", withPeople: false });
    expect(root.lessons).toBeUndefined();
  });

  it("serves lessons only to companies the switch names", async () => {
    const { root } = await setup({ lessons: `on:${B}` });
    await root.app.runtimeFor(A);
    await expect(ask(root, MEMBER_A)).rejects.toMatchObject({ code: "LESSONS_SWITCHED_OFF" });
  });
});

describe("the broker hands the core root the hosted people port", () => {
  const source = readFileSync(new URL("../../packages/broker/src/aws/broker.ts", import.meta.url), "utf8");
  const call = source.slice(source.indexOf("const coreRoot = createBrokerCoreRoot({"));
  const body = call.slice(0, call.indexOf("builtCoreRoot = coreRoot;"));

  it("passes lessonsPeople built by createHostedLessonsPeople over the broker's own tables, only where the sign-in table is set", () => {
    expect(body).toMatch(/lessonsPeople:\s*createHostedLessonsPeople\(\{[^}]*documentClient[^}]*stateTableName: requiredEnvironment\("STATE_TABLE_NAME"\)[^}]*signInTableName: process\.env\.DEVELOPER_SIGNIN_TABLE_NAME/u);
    expect(body).toMatch(/DEVELOPER_SIGNIN_TABLE_NAME === undefined \|\| process\.env\.DEVELOPER_SIGNIN_TABLE_NAME === ""\s*\?\s*\{\}/u);
  });
});
