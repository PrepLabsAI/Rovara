// Lead 4 L4-HW8: the core root hands each company's lessons the deployment's Slack command and company map (`lessonsSlack`), and the dispatcher builds its lessons reader over the read-only people port.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { OrgId } from "@agentx/contracts";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { createHostedLessonsPeople } from "../../packages/broker/src/aws/hosted-lessons-people.js";
import * as lessonsModule from "../../packages/broker/src/core-host/lessons.js";
import { createFakeWorld, FAKE_COMPANY } from "../support/core-host-fakes.js";

const adapters = vi.hoisted(() => ({ modules: [] as unknown[] }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", () => ({ codeAdapterModules: () => adapters.modules }));
vi.mock("../../packages/broker/src/core-host/hosted-modules.js", async (original) => ({ ...await original<object>(), hostedSecurityModules: () => [] }));
vi.mock("../../packages/broker/src/core-host/lessons.js", async (original) => {
  const real = await original<{ createCoreLessons: typeof lessonsModule.createCoreLessons }>();
  return { ...real, createCoreLessons: vi.fn(real.createCoreLessons) };
});

const A = FAKE_COMPANY as OrgId;
const secret = Buffer.alloc(32, 7);

async function setup(lessonsSlack: Parameters<typeof createBrokerCoreRoot>[0]["lessonsSlack"]) {
  const world = createFakeWorld();
  adapters.modules = world.modules;
  const client = { async send(command: unknown) {
    if (command instanceof GetCommand) return { Item: await world.store.get((command.input as { Key: { pk: string; sk: string } }).Key) };
    throw new Error("unexpected");
  } };
  const root = createBrokerCoreRoot({
    env: { ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: "all", ROVARA_CORE_LESSONS: "on" },
    documentClient: client, stateTableName: "state", signInTableName: "signin", callbackSigningKey: secret.toString(), repositoryGrantKey: secret,
    codeModules: () => ({}) as never, repositoryCredential: async () => { throw new Error("unused"); }, origin: () => "https://api.example", log: () => undefined,
    now: () => new Date(world.clock.now), ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
    services: () => Object.fromEntries(["merge-tracking", "session-sweep", "notify-deliver", "admission-hold-sweep"].map((name) => [name, { pass: async () => ({}) }])),
    lessonsPeople: createHostedLessonsPeople({ documentClient: client, stateTableName: "state", signInTableName: "signin", now: () => world.clock.now }),
    ...(lessonsSlack === undefined ? {} : { lessonsSlack }),
  });
  return root;
}

describe("the core root's lessons get the deployment's Slack source", () => {
  it("passes each company its own company map and thread command; none given means none (no Slack source)", async () => {
    const create = vi.mocked(lessonsModule.createCoreLessons);
    create.mockClear();
    const companyOf = vi.fn(async () => A);
    const command = vi.fn(async () => ({ space: { private: false, shared: false, direct: false }, messages: [], truncated: false }));
    const asked: string[] = [];
    const root = await setup((company) => { asked.push(company); return { companyOf, command }; });
    await root.app.runtimeFor(A);
    expect(asked).toEqual([A]);
    const options = create.mock.calls.at(-1)![0];
    expect(options.channelCompanyOf).toBe(companyOf);
    expect(options.slackThreadCommand).toBe(command);

    create.mockClear();
    const plain = await setup(undefined);
    await plain.app.runtimeFor(A);
    const bare = create.mock.calls.at(-1)![0];
    expect(bare.channelCompanyOf).toBeUndefined();
    expect(bare.slackThreadCommand).toBeUndefined();
  });
});

describe("the dispatcher's flow", () => {
  const source = readFileSync(new URL("../../packages/broker/src/aws/dispatcher.ts", import.meta.url), "utf8");
  const flow = source.slice(source.indexOf("// Resolve lessons separately for each runtime."), source.indexOf("extraModules: [...hostedSecurityModules"));
  it("builds the lessons reader over the company-scoped read-only people port, not over refusing placeholders", () => {
    expect(flow).toMatch(/createDispatcherLessonsPeople\(\{ documentClient, stateTableName: requiredEnvironment\("STATE_TABLE_NAME"\), signInTableName: process\.env\.DEVELOPER_SIGNIN_TABLE_NAME, now: Date\.now \}\)\(companyId, \{ store: async \(\) => registry\.require\("storage"\) \}\)/u);
    expect(flow).toMatch(/hostedDispatcherFlow\(process\.env, \{[^}]*people,/u);
    expect(flow).not.toMatch(/unavailable/u);
    expect(flow).not.toMatch(/approvers: /u);
  });
});
